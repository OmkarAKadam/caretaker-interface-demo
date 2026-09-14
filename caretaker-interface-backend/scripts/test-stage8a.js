'use strict';

// Stage 8A integration test harness: application security fixes.
//
// Covers:
//   A  stored-XSS guard on the caretaker dashboard render path (static)
//   B  unscoped GET /api/walle/sessions now requires caretaker auth
//   C  Wall-E session ownership — a device cannot continue another user's
//      session and no foreign transcript leaks into the AI context
//   D  Wall-E trusted-context isolation — runtime state scoped to the
//      authenticated device (unit-level via scopeRuntimeStateForDevice)
//   E  event message length capped at 256 on REST and MQTT paths
//
// Runs in-process against the real local PostgreSQL database with the real
// Express app on an ephemeral port. MQTT is disabled and NVIDIA_API_KEY is
// blanked so Wall-E chat fails fast (503) after the session check, exactly the
// pattern the stage6 harness relies on.
//
// Run with:
//   npm run test:stage8a

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// MQTT must be disabled BEFORE server.js is required. NVIDIA_API_KEY is blanked
// so Wall-E chat fails fast (session check still happens) instead of making
// real network calls from a test.
process.env.MQTT_BROKER_URL = '';
process.env.NVIDIA_API_KEY = '';
process.env.NODE_ENV = 'test';
process.env.COOKIE_SECURE = 'false';

const { query, getPool } = require('../db/pool');
const { TOPICS } = require('../mqtt/topics');
const { hashPassword } = require('../auth/password');
let currentServerModule = require('../server');
let conversationStore = require('../ai/conversation-store');
const { buildTrustedContext } = require('../ai/context-builder');

const PREFIX = 'stg8a-';
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'bg_session';

const ts = Date.now();
const EMAIL_A = `${PREFIX}${ts}-caretaker-a@test.local`;
const EMAIL_B = `${PREFIX}${ts}-caretaker-b@test.local`;
const PASSWORD = 'CorrectHorse42!';

const SID_X = `stg8a-${ts}-xsess`;
const SID_Y = `stg8a-${ts}-ysess`;

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass, detail: detail || '' });
}

function assertStatus(label, actual, expected) {
    check(label, actual === expected, `status ${actual}, expected ${expected}`);
}

function bodyOf(arg) {
    return arg && arg.body !== undefined ? arg.body : null;
}

// ── In-process HTTP (real Express app, ephemeral port) ──────────────────
let httpServer = null;
let baseUrl = '';

async function startHttp() {
    if (httpServer) {
        await new Promise((resolve) => httpServer.close(resolve));
        httpServer = null;
    }
    httpServer = currentServerModule.app.listen(0);
    await new Promise((resolve) => httpServer.once('listening', resolve));
    const port = httpServer.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
}

async function getJson(url, headers) {
    const res = await fetch(`${baseUrl}${url}`, { headers: headers || {} });
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body, headers: res.headers };
}

async function postJson(url, payload, headers) {
    const res = await fetch(`${baseUrl}${url}`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(payload)
    });
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body, headers: res.headers };
}

function readCookie(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const header = raw.find((h) => h.includes('='));
    if (!header) return null;
    return { header, value: header.split(';')[0].split('=').slice(1).join('=') };
}

function cookieHeader(cookie) {
    return { Cookie: `${COOKIE_NAME}=${cookie}` };
}

function authHeaders(cookie) {
    return Object.assign({ Cookie: `${COOKIE_NAME}=${cookie}` }, { 'Content-Type': 'application/json' });
}

function deviceHeaders(identifier, token) {
    return { 'X-Device-Id': identifier, 'X-Device-Token': token };
}

function nowIso() {
    return new Date().toISOString();
}

function eventPayload(alertId, extra) {
    return Object.assign({
        alertId,
        trigger: 'SOS',
        status: 'ACTIVE',
        heartRate: null,
        latitude: 22.34,
        longitude: 73.18,
        timestamp: nowIso()
    }, extra || {});
}

async function waitUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return predicate();
}

async function waitForMqttRow(deviceIdentifier, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) {
        const row = await query(
            `SELECT alert_id, blind_user_id
             FROM events WHERE device_identifier = $1 AND source = 'mqtt'
             ORDER BY created_at DESC LIMIT 1`,
            [deviceIdentifier]
        );
        if (row.rows.length) return row.rows[0];
        await new Promise((r) => setTimeout(r, 100));
    }
    return null;
}

// A fresh server module (fresh events Map + callbacks) and a fresh
// conversation-store (fresh in-memory sessions) mimic a process restart, then
// boot rehydration runs exactly like the guarded `app.listen` start path.
// Pending fire-and-forget DB syncs must be drained BEFORE the restart so the
// new in-memory store rehydrates from complete rows (and no write races the
// store swap).
async function simulateRestart() {
    await conversationStore.drainPendingSyncs();
    await startHttp(); // close old listener first
    delete require.cache[require.resolve('../ai/conversation-store')];
    delete require.cache[require.resolve('../server')];
    currentServerModule = require('../server');
    conversationStore = require('../ai/conversation-store');
    await currentServerModule.bootRehydrateFromDatabase();
    await startHttp();
    console.log('[test] simulated restart + boot rehydration done');
}

// ── A. Stored-XSS guard (static assertions on the frontend render path) ──
function testFrontendXssGuard() {
    const scriptPath = path.join(__dirname, '..', '..', 'caretaker-interface-frontend', 'script.js');
    const source = fs.readFileSync(scriptPath, 'utf8');
    const lines = source.split('\n');

    // The stored-XSS vectors (alertId, source label, trigger label, status
    // label) must never be interpolated into an innerHTML template. (Field
    // values that are inherently safe — numeric heart rate, whitelisted CSS
    // classes and formatting helpers — are allowed to be interpolated.)
    const vectors = /\$\{event\.alertId|sourceLabel|triggerLabel|statusLabel/;
    const htmlSinks = lines.filter((l) => l.includes('innerHTML') && vectors.test(l));
    check('xss: alertId/source/trigger/status never interpolated into innerHTML', htmlSinks.length === 0, htmlSinks.join(' | '));

    // createHistoryRow renders a fully static template and fills the cells via
    // textContent — the alert-id, source, trigger and status cells must not be
    // interpolated into it (only derived CSS classes / formatting helpers may).
    const rowBody = source.slice(source.indexOf('item.innerHTML = `'), source.indexOf('function addToHistory'));
    const rowSinks = rowBody.match(/\$\{(event\.alertId|sourceLabel|triggerLabel|statusLabel)[^}]*}/g) || [];
    check('xss: createHistoryRow interpolates no alert/source/trigger/status text', rowSinks.length === 0, rowSinks.join(', '));

    // TextContent assignments are present (exact render-path guards).
    check('xss: alertId set via textContent',
        source.includes("querySelector('.history-alert-id').textContent = event.alertId"),
        'querySelector(.history-alert-id).textContent = event.alertId not found');
    check('xss: source set via textContent',
        source.includes("querySelector('.history-source').textContent = sourceLabel"),
        'querySelector(.history-source).textContent = sourceLabel not found');
    check('xss: status set via textContent node',
        source.includes("appendChild(document.createTextNode(statusLabel))"),
        'createTextNode(statusLabel) not found');
}

// ── B. Public Wall-E sessions are gated ────────────────────────────────
async function testSessionsGate(state) {
    let res = await getJson('/api/walle/sessions');
    assertStatus('sess: unscoped without cookie → 401', res.status, 401);

    res = await getJson('/api/walle/sessions?blindUserId=');
    assertStatus('sess: empty blindUserId without cookie → 401', res.status, 401);

    res = await getJson(`/api/walle/sessions?blindUserId=${state.x.id}`);
    assertStatus('sess: scoped without cookie → 401', res.status, 401);

    res = await getJson('/api/walle/sessions', cookieHeader(state.cookieA));
    assertStatus('sess: unscoped with caretaker → 200 (legacy behavior retained)', res.status, 200);
    check('sess: authorized unscoped lists sessions',
        Array.isArray(bodyOf(res)) && bodyOf(res).some((s) => s.sessionId === SID_X),
        JSON.stringify(bodyOf(res)));

    res = await getJson(`/api/walle/sessions?blindUserId=${state.x.id}`, cookieHeader(state.cookieA));
    assertStatus('sess: caretaker A scoped X → 200', res.status, 200);

    res = await getJson(`/api/walle/sessions?blindUserId=${state.z.id}`, cookieHeader(state.cookieA));
    assertStatus('sess: A scoped Z (B-linked) → 404', res.status, 404);

    // A BLIND_USER cookie must be rejected (403) on the unscoped form.
    await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'BLIND_USER') RETURNING id`,
        ['Stage8a Blind', `${PREFIX}${ts}-blind-role@test.local`, await hashPassword('KnownBlind!42')]
    );
    const loginRes = await postJson('/api/auth/login', { email: `${PREFIX}${ts}-blind-role@test.local`, password: 'KnownBlind!42' });
    const blindCookie = readCookie(loginRes) && readCookie(loginRes).value;
    check('sess: blind-role fixture can log in', Boolean(blindCookie), `login ${loginRes.status}`);
    if (blindCookie) {
        res = await getJson('/api/walle/sessions', cookieHeader(blindCookie));
        assertStatus('sess: BLIND_USER unscoped → 403', res.status, 403);
    }
}

// ── C. Wall-E session ownership ────────────────────────────────────────
async function testSessionOwnership(state) {
    // X creates its own session (hand-off fails fast with key blanked → 503).
    let res = await postJson('/api/walle/chat', { sessionId: SID_X, message: 'Where is my cane?' }, deviceHeaders(state.devX.identifier, state.devX.token));
    assertStatus('own: X creates session (hand-off 503)', res.status, 503);

    const before = conversationStore.getSessionTranscript(SID_X);
    check('own: session bound to X', Boolean(before && before.blindUserId === state.x.id), JSON.stringify(before && before.blindUserId));
    const beforeTurns = before ? before.turns.length : 0;

    // Y (another blind user) attempts to continue X's session.
    res = await postJson('/api/walle/chat', { sessionId: SID_X, message: 'Y trying to read X transcript' }, deviceHeaders(state.devY.identifier, state.devY.token));
    assertStatus('own: Y continuing X session → 404', res.status, 404);

    const after = conversationStore.getSessionTranscript(SID_X);
    check('own: X transcript turn count unchanged after Y attempt',
        Boolean(after) && after.turns.length === beforeTurns,
        `before ${beforeTurns}, after ${after && after.turns.length}`);
    check('own: X transcript does NOT contain Y message',
        !(after && after.turns.some((t) => t.text.includes('Y trying to read X transcript'))));

    // X can still continue its own session (not treated as 404).
    res = await postJson('/api/walle/chat', { sessionId: SID_X, message: 'Follow-up from X' }, deviceHeaders(state.devX.identifier, state.devX.token));
    assertStatus('own: X continues own session (hand-off 503)', res.status, 503);
    const after2 = conversationStore.getSessionTranscript(SID_X);
    check('own: X follow-up appended', Boolean(after2 && after2.turns.some((t) => t.text === 'Follow-up from X')));

    // Y can create its own brand-new session (binding to Y's identity).
    res = await postJson('/api/walle/chat', { sessionId: SID_Y, message: 'Y own question' }, deviceHeaders(state.devY.identifier, state.devY.token));
    assertStatus('own: Y creates own session → 503 hand-off', res.status, 503);
    const ySess = conversationStore.getSessionTranscript(SID_Y);
    check('own: Y session bound to Y', Boolean(ySess && ySess.blindUserId === state.y.id && ySess.deviceId === state.devY.identifier),
        JSON.stringify(ySess && { blindUserId: ySess.blindUserId, deviceId: ySess.deviceId }));

    // Rehydrated sessions must still be ownable by their original device.
    await simulateRestart();
    const rehydrated = conversationStore.getSessionTranscript(SID_X);
    check('own: rehydrated session restored for X', Boolean(rehydrated && rehydrated.blindUserId === state.x.id));
    res = await postJson('/api/walle/chat', { sessionId: SID_X, message: 'After restart' }, deviceHeaders(state.devX.identifier, state.devX.token));
    assertStatus('own: X continues rehydrated session → 503 hand-off', res.status, 503);
    res = await postJson('/api/walle/chat', { sessionId: SID_X, message: 'Y tries after restart' }, deviceHeaders(state.devY.identifier, state.devY.token));
    assertStatus('own: Y still blocked from X session after restart → 404', res.status, 404);
    await conversationStore.drainPendingSyncs();
}

// ── D. Wall-E trusted-context isolation (unit) ─────────────────────────
function testContextIsolation(state) {
    const devX = { identifier: state.devX.identifier, blindUserId: state.x.id };
    const devY = { identifier: state.devY.identifier, blindUserId: state.y.id };

    const runtime = {
        latestLocation: { deviceId: state.devX.identifier, blindUserId: state.x.id, latitude: 22.1, longitude: 73.2, timestamp: nowIso() },
        latestDeviceStatus: { deviceId: state.devX.identifier, status: 'ONLINE', receivedAt: nowIso() },
        lastHeartRate: { deviceId: state.devY.identifier, heartRate: 122, timestamp: nowIso() },
        latestFall: { deviceId: state.devZ.identifier, timestamp: nowIso() },
        latestBuzzerState: 'ON'
    };

    const scopedX = currentServerModule.scopeRuntimeStateForDevice(devX, runtime);
    check('ctx: X keeps its own location', Boolean(scopedX.latestLocation && scopedX.latestLocation.latitude === 22.1), JSON.stringify(scopedX.latestLocation));
    check('ctx: X keeps its own device status', Boolean(scopedX.latestDeviceStatus), JSON.stringify(scopedX.latestDeviceStatus));
    check('ctx: X does NOT receive Y heart-rate', !scopedX.lastHeartRate, JSON.stringify(scopedX.lastHeartRate));
    check('ctx: X does NOT receive Z fall', !scopedX.latestFall, JSON.stringify(scopedX.latestFall));
    check('ctx: unattributable buzzer omitted (no guessing)', !scopedX.latestBuzzerState);

    const xContext = buildTrustedContext(Object.assign(scopedX, { events: new Map() }));
    check('ctx: X context includes own location', typeof xContext === 'string' && xContext.includes('Location: 22.1, 73.2'), xContext);
    check('ctx: X context excludes Y heart-rate', !xContext.includes('Heart rate'), xContext);
    check('ctx: X context excludes Z fall', !xContext.includes('Recent fall'), xContext);

    const scopedY = currentServerModule.scopeRuntimeStateForDevice(devY, runtime);
    check('ctx: Y keeps its own heart-rate', Boolean(scopedY.lastHeartRate && scopedY.lastHeartRate.heartRate === 122), JSON.stringify(scopedY.lastHeartRate));
    check('ctx: Y does NOT receive X location', !scopedY.latestLocation, JSON.stringify(scopedY.latestLocation));
    check('ctx: Y does NOT receive Z fall', !scopedY.latestFall, JSON.stringify(scopedY.latestFall));

    // A piece with 'unknown' device identity must never be guessed either way.
    const unattributed = { lastHeartRate: { deviceId: 'unknown', heartRate: 90, timestamp: nowIso() } };
    const scopedX2 = currentServerModule.scopeRuntimeStateForDevice(devX, unattributed);
    check('ctx: unknown-identity heart-rate omitted', !scopedX2.lastHeartRate, JSON.stringify(scopedX2.lastHeartRate));
}

// ── E. Event message length limit ──────────────────────────────────────
async function testMessageLimit(state) {
    const max = currentServerModule.EVENT_MESSAGE_MAX;
    check('cfg: EVENT_MESSAGE_MAX = 256', max === 256, `got ${max}`);

    // REST path.
    let res = await postJson('/api/events', eventPayload(`stg8a-${ts}-msg-ok`, { message: 'x'.repeat(max) }), deviceHeaders(state.devX.identifier, state.devX.token));
    assertStatus('msg: exactly 256 chars → 201', res.status, 201);

    res = await postJson('/api/events', eventPayload(`stg8a-${ts}-msg-long`, { message: 'x'.repeat(max + 1) }), deviceHeaders(state.devX.identifier, state.devX.token));
    assertStatus('msg: 257 chars → 400', res.status, 400);

    res = await postJson('/api/events', eventPayload(`stg8a-${ts}-msg-none`), deviceHeaders(state.devX.identifier, state.devX.token));
    assertStatus('msg: no message field still accepted → 201', res.status, 201);

    // MQTT entry point (common validation path via createEvent).
    const before = currentServerModule.getLatestRuntimeState().eventCount;
    currentServerModule.handleMqttMessage(TOPICS.EMERGENCY_SOS, {
        deviceId: state.devX.identifier,
        message: 'x'.repeat(max + 1),
        timestamp: nowIso()
    });
    await new Promise((r) => setTimeout(r, 100));
    const afterBig = currentServerModule.getLatestRuntimeState().eventCount;
    check('msg: oversized MQTT SOS creates no event', afterBig === before, `before ${before}, after ${afterBig}`);

    // Positive control: a normal MQTT SOS still creates an event.
    currentServerModule.handleMqttMessage(TOPICS.EMERGENCY_SOS, {
        deviceId: state.devX.identifier,
        message: 'SOS via cap MQTT',
        timestamp: nowIso()
    });
    const mqttRow = await waitForMqttRow(state.devX.identifier);
    check('msg: normal MQTT SOS still created', Boolean(mqttRow && mqttRow.alert_id && mqttRow.alert_id.startsWith('MQTT-SOS-')), JSON.stringify(mqttRow));
    if (mqttRow) state.trashMqttAlertIds.push(mqttRow.alert_id);
}

// ── Fixtures ───────────────────────────────────────────────────────────
async function setup() {
    const state = { trashMqttAlertIds: [] };

    let res = await postJson('/api/auth/register', { name: 'Stage8a Caretaker A', email: EMAIL_A, password: PASSWORD });
    assertStatus('setup: register caretaker A', res.status, 201);
    res = await postJson('/api/auth/register', { name: 'Stage8a Caretaker B', email: EMAIL_B, password: PASSWORD });
    assertStatus('setup: register caretaker B', res.status, 201);

    res = await postJson('/api/auth/login', { email: EMAIL_A, password: PASSWORD });
    assertStatus('setup: login A', res.status, 200);
    state.cookieA = readCookie(res) && readCookie(res).value;
    res = await postJson('/api/auth/login', { email: EMAIL_B, password: PASSWORD });
    assertStatus('setup: login B', res.status, 200);
    state.cookieB = readCookie(res) && readCookie(res).value;
    check('setup: cookies captured', Boolean(state.cookieA && state.cookieB));

    const mkBlind = async (name, tag) => {
        const r = await postJson('/api/blind-users', { name, email: `${PREFIX}${ts}-${tag}@test.local` }, authHeaders(state.cookieA));
        return bodyOf(r) && bodyOf(r).user;
    };
    state.x = await mkBlind('Anika', 'x');
    state.y = await mkBlind('Bimal', 'y');
    res = await postJson('/api/blind-users', { name: 'Chandra', email: `${PREFIX}${ts}-z@test.local` }, authHeaders(state.cookieB));
    state.z = bodyOf(res) && bodyOf(res).user;
    check('setup: blind users created', Boolean(state.x && state.y && state.z));

    await postJson(`/api/caretaker/blind-users/${state.x.id}`, {}, authHeaders(state.cookieA));
    await postJson(`/api/caretaker/blind-users/${state.y.id}`, {}, authHeaders(state.cookieA));
    await postJson(`/api/caretaker/blind-users/${state.z.id}`, {}, authHeaders(state.cookieB));

    const mkDev = async (blindUserId, tag, caretakerCookie) => {
        const r = await postJson('/api/devices', {
            blindUserId,
            deviceIdentifier: `${PREFIX.toUpperCase()}${ts}-${tag}-DEV`,
            friendlyName: `${tag} Cap`
        }, authHeaders(caretakerCookie));
        return { identifier: `${PREFIX.toUpperCase()}${ts}-${tag}-DEV`, token: bodyOf(r) && bodyOf(r).token };
    };
    state.devX = await mkDev(state.x.id, 'X', state.cookieA);
    state.devY = await mkDev(state.y.id, 'Y', state.cookieA);
    state.devZ = await mkDev(state.z.id, 'Z', state.cookieB);
    check('setup: device tokens issued', Boolean(state.devX.token && state.devY.token && state.devZ.token));

    return state;
}

async function cleanup(state) {
    try {
        const users = await query(`SELECT id FROM users WHERE email LIKE '${PREFIX}%'`);
        const ids = users.rows.map((r) => r.id);
        if (ids.length > 0) {
            await query('DELETE FROM events WHERE blind_user_id = ANY($1)', [ids]);
            await query('DELETE FROM walle_sessions WHERE blind_user_id = ANY($1)', [ids]);
        }
        const trash = (state && state.trashMqttAlertIds) || [];
        for (const alertId of trash) {
            await query('DELETE FROM events WHERE alert_id = $1', [alertId]);
        }
        await query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
        const leftover = await query(`SELECT COUNT(*)::int AS n FROM users WHERE email LIKE '${PREFIX}%'`);
        console.log(`[test] leftover stg8a users: ${leftover.rows[0].n}`);
    } catch (err) {
        console.warn('[test] cleanup failed (non-fatal):', err.message || err);
    }
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
        console.error('[test] FATAL: DATABASE_URL is not configured. stage8a tests need the local blindguardian database.');
        process.exit(1);
    }

    console.log('[test] stage8a in-process harness starting (security fixes)…');

    try {
        await query(`DELETE FROM events WHERE alert_id LIKE 'MQTT-SOS-%'`);
        console.log('[test] purged stale MQTT-SOS-* rows');
    } catch (err) {
        console.warn('[test] pre-purge failed (non-fatal):', err.message || err);
    }

    await startHttp();
    console.log(`[test] backend listening on ${baseUrl}`);

    let state = null;
    try {
        testFrontendXssGuard();
        state = await setup();
        // Ownership first so the sessions created here are present when the
        // gate test asserts the authorized unscoped listing.
        await testSessionOwnership(state);
        await testSessionsGate(state);
        await testMessageLimit(state);
        testContextIsolation(state);
    } finally {
        await conversationStore.drainPendingSyncs();
        await cleanup(state);
        if (httpServer) { try { await new Promise((r) => httpServer.close(r)); } catch (_e) { /* ignore */ } }
        if (getPool().end) { try { await getPool().end(); } catch (_e) { /* ignore */ } }
    }

    const failed = results.filter((r) => !r.pass);
    console.log('');
    for (const r of results) {
        const mark = r.pass ? 'PASS' : 'FAIL';
        console.log(`  [${mark}] ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
    }
    console.log('');
    console.log(`[test] ${results.length - failed.length}/${results.length} checks passed`);

    if (failed.length > 0) {
        console.error(`[test] ${failed.length} check(s) failed.`);
        process.exit(1);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error('[test] FATAL:', err.message || err);
    const failed = results.filter((r) => !r.pass);
    for (const r of results) {
        const mark = r.pass ? 'PASS' : 'FAIL';
        console.log(`  [${mark}] ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
    }
    process.exit(1);
});