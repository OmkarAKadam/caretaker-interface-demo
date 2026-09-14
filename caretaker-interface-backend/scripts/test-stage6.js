'use strict';

// Stage 6 integration test harness: multi-user caretaker dashboard scoping.
//
// Runs IN-PROCESS against the real local PostgreSQL database (so the actual
// MQTT message entry point — server.js's handleMqttMessage, which mqtt/ passes
// broker messages to — can be exercised directly) with the real Express app
// listening on an ephemeral port for the HTTP/cookie flows.
//
// Two caretakers each monitor their own blind users; every telemetry endpoint
// is exercised BOTH scoped (?blindUserId=<uuid>) and unscoped (legacy),
// asserting that a caretaker can only ever read events/location/Wall-E data
// that belongs to a blind user they actively monitor.
//
// Run with:
//   npm run test:stage6
//
// All test users use the `stg6-` email prefix and are DELETED (with their
// events, relationships, sessions, devices and Wall-E rows) when the run
// finishes. Wall-E chat calls run with NVIDIA_API_KEY blanked so the AI
// hand-off fails fast (503) — the conversation session is still created and
// a user turn stored, which is what the isolation checks need.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// MQTT must be disabled BEFORE server.js is required. NVIDIA_API_KEY is
// blanked so Wall-E chat fails fast (session still created) instead of making
// real network calls from a test.
process.env.MQTT_BROKER_URL = '';
process.env.NVIDIA_API_KEY = '';
process.env.NODE_ENV = 'test';
process.env.COOKIE_SECURE = 'false';

const { query, getPool } = require('../db/pool');
const { TOPICS } = require('../mqtt/topics');
let currentServerModule = require('../server');

const PREFIX = 'stg6-';

const ts = Date.now();
const EMAIL_A = `${PREFIX}${ts}-caretaker-a@test.local`;
const EMAIL_B = `${PREFIX}${ts}-caretaker-b@test.local`;
const EMAIL_BLIND_LOGIN = `${PREFIX}${ts}-blind-login@test.local`;
const BLIND_LOGIN_PASSWORD = 'KnownBlindPassword!42';
const PASSWORD = 'CorrectHorse42!';

const SID_X = `stg6-${ts}-xsess`;
const SID_Y = `stg6-${ts}-ysess`;
const SID_Z = `stg6-${ts}-zsess`;

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

async function deleteJson(url, headers) {
    const res = await fetch(`${baseUrl}${url}`, { method: 'DELETE', headers: headers || {} });
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body, headers: res.headers };
}

function readCookie(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const header = raw.find((h) => h.startsWith('bg_session=') || h.includes('='));
    if (!header) return null;
    return { header, value: header.split(';')[0].split('=').slice(1).join('=') };
}

function cookieHeader(cookie) {
    return { Cookie: `bg_session=${cookie}` };
}

function authHeaders(cookie) {
    return Object.assign({ Cookie: `bg_session=${cookie}` }, { 'Content-Type': 'application/json' });
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

function locationPayload(lat, lng) {
    return { latitude: lat, longitude: lng, timestamp: nowIso() };
}

async function waitUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return predicate();
}

// Polls for the persisted "mqtt + device_identifier" event row, because the
// MQTT entry point persists fire-and-forget. Returns the newest matching row
// or null on timeout.
async function waitForMqttRow(deviceIdentifier, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) {
        const row = await query(
            `SELECT alert_id, blind_user_id, blind_user_identifier
             FROM events WHERE device_identifier = $1 AND source = 'mqtt'
             ORDER BY created_at DESC LIMIT 1`,
            [deviceIdentifier]
        );
        if (row.rows.length) return row.rows[0];
        await new Promise((r) => setTimeout(r, 100));
    }
    return null;
}

async function runTests() {
    const state = { trashMqttAlertIds: [] };

    // ── Account setup (HTTP) ───────────────────────────────────────
    let res = await postJson('/api/auth/register', { name: 'Stage6 Caretaker A', email: EMAIL_A, password: PASSWORD });
    assertStatus('setup: register caretaker A', res.status, 201);
    state.caretakerA = bodyOf(res) && bodyOf(res).user;

    res = await postJson('/api/auth/register', { name: 'Stage6 Caretaker B', email: EMAIL_B, password: PASSWORD });
    assertStatus('setup: register caretaker B', res.status, 201);
    state.caretakerB = bodyOf(res) && bodyOf(res).user;

    res = await postJson('/api/auth/login', { email: EMAIL_A, password: PASSWORD });
    assertStatus('setup: login A', res.status, 200);
    state.cookieA = readCookie(res) && readCookie(res).value;

    res = await postJson('/api/auth/login', { email: EMAIL_B, password: PASSWORD });
    assertStatus('setup: login B', res.status, 200);
    state.cookieB = readCookie(res) && readCookie(res).value;

    check('setup: both caretaker cookies captured', Boolean(state.cookieA && state.cookieB));

    // Blind users X, Y (A's) and Z (B's).
    res = await postJson('/api/blind-users', { name: 'Anika', email: `${PREFIX}${ts}-x@test.local` }, authHeaders(state.cookieA));
    assertStatus('setup: create blind user X', res.status, 201);
    state.x = bodyOf(res) && bodyOf(res).user;

    res = await postJson('/api/blind-users', { name: 'Bimal', email: `${PREFIX}${ts}-y@test.local` }, authHeaders(state.cookieA));
    assertStatus('setup: create blind user Y', res.status, 201);
    state.y = bodyOf(res) && bodyOf(res).user;

    res = await postJson('/api/blind-users', { name: 'Chandra', email: `${PREFIX}${ts}-z@test.local` }, authHeaders(state.cookieB));
    assertStatus('setup: create blind user Z', res.status, 201);
    state.z = bodyOf(res) && bodyOf(res).user;

    // Link A→X, A→Y, B→Z.
    res = await postJson(`/api/caretaker/blind-users/${state.x.id}`, {}, authHeaders(state.cookieA));
    assertStatus('setup: A links X', res.status, 201);
    res = await postJson(`/api/caretaker/blind-users/${state.y.id}`, {}, authHeaders(state.cookieA));
    assertStatus('setup: A links Y', res.status, 201);
    res = await postJson(`/api/caretaker/blind-users/${state.z.id}`, {}, authHeaders(state.cookieB));
    assertStatus('setup: B links Z', res.status, 201);

    // Devices per user.
    res = await postJson('/api/devices', { blindUserId: state.x.id, deviceIdentifier: `${PREFIX.toUpperCase()}${ts}-X-DEV`, friendlyName: 'X Cap' }, authHeaders(state.cookieA));
    assertStatus('setup: A registers device for X', res.status, 201);
    state.devX = { identifier: `${PREFIX.toUpperCase()}${ts}-X-DEV`, token: bodyOf(res) && bodyOf(res).token };
    check('setup: device X token issued', Boolean(state.devX.token));

    res = await postJson('/api/devices', { blindUserId: state.y.id, deviceIdentifier: `${PREFIX.toUpperCase()}${ts}-Y-DEV`, friendlyName: 'Y Cap' }, authHeaders(state.cookieA));
    assertStatus('setup: A registers device for Y', res.status, 201);
    state.devY = { identifier: `${PREFIX.toUpperCase()}${ts}-Y-DEV`, token: bodyOf(res) && bodyOf(res).token };
    check('setup: device Y token issued', Boolean(state.devY.token));

    res = await postJson('/api/devices', { blindUserId: state.z.id, deviceIdentifier: `${PREFIX.toUpperCase()}${ts}-Z-DEV`, friendlyName: 'Z Cap' }, authHeaders(state.cookieB));
    assertStatus('setup: B registers device for Z', res.status, 201);
    state.devZ = { identifier: `${PREFIX.toUpperCase()}${ts}-Z-DEV`, token: bodyOf(res) && bodyOf(res).token };
    check('setup: device Z token issued', Boolean(state.devZ.token));

    // ── Seed timeline data ─────────────────────────────────────────
    res = await postJson('/api/events', eventPayload(`stg6-${ts}-x1`), deviceHeaders(state.devX.identifier, state.devX.token));
    assertStatus('data: X posts event x1', res.status, 201);
    res = await postJson('/api/events', eventPayload(`stg6-${ts}-x2`), deviceHeaders(state.devX.identifier, state.devX.token));
    assertStatus('data: X posts event x2', res.status, 201);
    res = await postJson('/api/events', eventPayload(`stg6-${ts}-y1`), deviceHeaders(state.devY.identifier, state.devY.token));
    assertStatus('data: Y posts event y1', res.status, 201);
    res = await postJson('/api/events', eventPayload(`stg6-${ts}-z1`), deviceHeaders(state.devZ.identifier, state.devZ.token));
    assertStatus('data: Z posts event z1', res.status, 201);

    // Location: X last, then Z last (Z overwrites the global latest).
    res = await postJson('/api/location', locationPayload(22.341, 73.181), deviceHeaders(state.devX.identifier, state.devX.token));
    assertStatus('data: X posts location', res.status, 200);
    res = await postJson('/api/location', locationPayload(23.0225, 72.5714), deviceHeaders(state.devZ.identifier, state.devZ.token));
    assertStatus('data: Z posts location', res.status, 200);

    // Wall-E sessions (chat fails fast with AI key blanked, session persists).
    res = await postJson('/api/walle/chat', { sessionId: SID_X, message: 'Where is my cane?' }, deviceHeaders(state.devX.identifier, state.devX.token));
    assertStatus('data: X chat hand-off 503 (session created)', res.status, 503);
    res = await postJson('/api/walle/chat', { sessionId: SID_Y, message: 'Lighting check' }, deviceHeaders(state.devY.identifier, state.devY.token));
    assertStatus('data: Y chat hand-off 503 (session created)', res.status, 503);
    res = await postJson('/api/walle/chat', { sessionId: SID_Z, message: 'Home please' }, deviceHeaders(state.devZ.identifier, state.devZ.token));
    assertStatus('data: Z chat hand-off 503 (session created)', res.status, 503);

    // ── MQTT handler path (actual entry point) ─────────────────────
    // Known registered cap device → event must be bound to its blind user.
    currentServerModule.handleMqttMessage(TOPICS.EMERGENCY_SOS, {
        deviceId: state.devX.identifier,
        message: 'SOS via cap MQTT',
        timestamp: nowIso()
    });
    const mqttXRow = await waitForMqttRow(state.devX.identifier);
    check('mqtt: registered device event persisted', Boolean(mqttXRow && mqttXRow.alert_id && mqttXRow.alert_id.startsWith('MQTT-SOS-')), String(mqttXRow && mqttXRow.alert_id));
    check('mqtt: event bound to owner blind_user_id', mqttXRow && mqttXRow.blind_user_id === state.x.id,
        JSON.stringify(mqttXRow));
    check('mqtt: event owner blind_user_identifier recorded', mqttXRow && mqttXRow.blind_user_identifier === state.x.id,
        JSON.stringify(mqttXRow));
    if (mqttXRow) state.trashMqttAlertIds.push(mqttXRow.alert_id);

    // Unknown device identifier → event persisted but NEVER bound to anyone.
    currentServerModule.handleMqttMessage(TOPICS.EMERGENCY_SOS, {
        deviceId: `${PREFIX.toUpperCase()}-UNKNOWN-${ts}`,
        message: 'SOS from unknown device',
        timestamp: nowIso()
    });
    const mqttOrphanRow = await waitForMqttRow(`${PREFIX.toUpperCase()}-UNKNOWN-${ts}`);
    check('mqtt: unknown device event persisted unbound', Boolean(mqttOrphanRow && mqttOrphanRow.alert_id),
        JSON.stringify(mqttOrphanRow));
    check('mqtt: unknown device has NO blind_user_id', mqttOrphanRow && mqttOrphanRow.blind_user_id === null,
        `blind_user_id=${mqttOrphanRow && mqttOrphanRow.blind_user_id}`);
    check('mqtt: unknown device has NO blind_user_identifier', mqttOrphanRow && mqttOrphanRow.blind_user_identifier === null,
        `blind_user_identifier=${mqttOrphanRow && mqttOrphanRow.blind_user_identifier}`);
    if (mqttOrphanRow) state.trashMqttAlertIds.push(mqttOrphanRow.alert_id);

    // ── Scoped events: A sees only her users, MQTT included ─────────
    const mqttXId = mqttXRow ? mqttXRow.alert_id : `MQTT-SOS-${ts}-missing`;
    const xSeen = await waitUntil(async () => {
        const got = await getJson(`/api/events?blindUserId=${state.x.id}`, cookieHeader(state.cookieA));
        const ids = (bodyOf(got) || []).map((e) => e.alertId);
        return got.status === 200 && ids.includes(`stg6-${ts}-x1`) && ids.includes(`stg6-${ts}-x2`) && ids.includes(mqttXId);
    }, 5000);
    check('events: A scoped view of X has x1+x2+mqtt sos', xSeen);

    res = await getJson(`/api/events?blindUserId=${state.x.id}`, cookieHeader(state.cookieA));
    assertStatus('events: A scoped X → 200', res.status, 200);
    const xIds = (bodyOf(res) || []).map((e) => e.alertId);
    check('events: A view of X excludes Y/Z + orphan events',
        xIds.includes(`stg6-${ts}-x1`) && xIds.includes(`stg6-${ts}-x2`) && xIds.includes(mqttXId) &&
        !xIds.includes(`stg6-${ts}-y1`) && !xIds.includes(`stg6-${ts}-z1`) &&
        !(mqttOrphanRow && xIds.includes(mqttOrphanRow.alert_id)),
        JSON.stringify(xIds));

    res = await getJson(`/api/events?blindUserId=${state.y.id}`, cookieHeader(state.cookieA));
    assertStatus('events: A scoped Y → 200', res.status, 200);
    const yIds = (bodyOf(res) || []).map((e) => e.alertId);
    check('events: A view of Y is exactly y1 (no mqtt)',
        yIds.includes(`stg6-${ts}-y1`) && !yIds.some((id) => id.startsWith('stg6-') && id !== `stg6-${ts}-y1`) &&
        !yIds.includes(mqttXId),
        JSON.stringify(yIds));

    // A cannot see B's user, and vice versa.
    res = await getJson(`/api/events?blindUserId=${state.z.id}`, cookieHeader(state.cookieA));
    assertStatus('events: A scoped Z (B-linked) → 404', res.status, 404);
    res = await getJson(`/api/events?blindUserId=${state.x.id}`, cookieHeader(state.cookieB));
    assertStatus('events: B scoped X (A-linked) → 404', res.status, 404);
    res = await getJson(`/api/events?blindUserId=${state.z.id}`, cookieHeader(state.cookieB));
    assertStatus('events: B scoped Z → 200', res.status, 200);
    const zIds = (bodyOf(res) || []).map((e) => e.alertId);
    check('events: B view of Z excludes X mqtt asset', zIds.includes(`stg6-${ts}-z1`) && !zIds.includes(mqttXId),
        JSON.stringify(zIds));

    // Garbage scoping input never reaches the data.
    res = await getJson(`/api/events?blindUserId=${crypto.randomUUID()}`, cookieHeader(state.cookieA));
    assertStatus('events: A scoped random uuid → 404', res.status, 404);
    res = await getJson(`/api/events?blindUserId=not-a-uuid`, cookieHeader(state.cookieA));
    assertStatus('events: invalid blindUserId → 404', res.status, 404);

    // Unauthenticated scoped requests are rejected.
    res = await getJson(`/api/events?blindUserId=${state.x.id}`);
    assertStatus('events: scoped X without cookie → 401', res.status, 401);

    // Unscoped legacy read still works and sees the mixed timeline.
    res = await getJson('/api/events');
    assertStatus('events: unscoped GET /api/events → 200 (legacy)', res.status, 200);
    const allIds = (bodyOf(res) || []).map((e) => e.alertId);
    check('events: unscoped view contains x/y/z + mqtt events',
        allIds.includes(`stg6-${ts}-x1`) && allIds.includes(`stg6-${ts}-y1`) && allIds.includes(`stg6-${ts}-z1`) &&
        allIds.includes(mqttXId) && allIds.includes(mqttOrphanRow.alert_id),
        JSON.stringify(allIds));

    // ── Scoped location ────────────────────────────────────────────
    res = await getJson(`/api/location?blindUserId=${state.x.id}`, cookieHeader(state.cookieA));
    assertStatus('location: A scoped X → 200', res.status, 200);
    check('location: X has no location (Z overwrote singleton)',
        bodyOf(res) && bodyOf(res).latitude === null && bodyOf(res).longitude === null,
        JSON.stringify(bodyOf(res)));

    res = await getJson(`/api/location?blindUserId=${state.z.id}`, cookieHeader(state.cookieB));
    assertStatus('location: B scoped Z → 200', res.status, 200);
    check('location: Z location present',
        bodyOf(res) && bodyOf(res).latitude === 23.0225 && bodyOf(res).longitude === 72.5714,
        JSON.stringify(bodyOf(res)));

    res = await getJson(`/api/location?blindUserId=${state.z.id}`, cookieHeader(state.cookieA));
    assertStatus('location: A scoped Z (B-linked) → 404', res.status, 404);
    res = await getJson(`/api/location?blindUserId=${state.y.id}`, cookieHeader(state.cookieB));
    assertStatus('location: B scoped Y (A-linked) → 404', res.status, 404);
    res = await getJson(`/api/location?blindUserId=${state.x.id}`);
    assertStatus('location: scoped X without cookie → 401', res.status, 401);
    res = await getJson(`/api/location?blindUserId=${crypto.randomUUID()}`, cookieHeader(state.cookieA));
    assertStatus('location: random uuid → 404', res.status, 404);

    res = await getJson('/api/location');
    assertStatus('location: unscoped GET /api/location → 200 (legacy)', res.status, 200);
    check('location: unscoped returns Z (latest)',
        bodyOf(res) && bodyOf(res).latitude === 23.0225,
        JSON.stringify(bodyOf(res)));

    // ── Scoped Wall-E sessions (isolation) ─────────────────────────
    res = await getJson(`/api/walle/sessions?blindUserId=${state.x.id}`, cookieHeader(state.cookieA));
    assertStatus('walle: A scoped X sessions → 200', res.status, 200);
    const aXses = (bodyOf(res) || []).map((s) => s.sessionId);
    check('walle: A sees only X session',
        aXses.includes(SID_X) && !aXses.includes(SID_Y) && !aXses.includes(SID_Z),
        JSON.stringify(aXses));

    res = await getJson(`/api/walle/sessions?blindUserId=${state.y.id}`, cookieHeader(state.cookieA));
    assertStatus('walle: A scoped Y sessions → 200', res.status, 200);
    const aYses = (bodyOf(res) || []).map((s) => s.sessionId);
    check('walle: A sees only Y session', aYses.includes(SID_Y) && !aYses.includes(SID_X), JSON.stringify(aYses));

    res = await getJson(`/api/walle/sessions?blindUserId=${state.z.id}`, cookieHeader(state.cookieB));
    assertStatus('walle: B scoped Z sessions → 200', res.status, 200);
    const bZses = (bodyOf(res) || []).map((s) => s.sessionId);
    check('walle: B sees only Z session', bZses.includes(SID_Z) && !bZses.includes(SID_X), JSON.stringify(bZses));

    res = await getJson(`/api/walle/sessions?blindUserId=${state.z.id}`, cookieHeader(state.cookieA));
    assertStatus('walle: A scoped Z (B-linked) → 404', res.status, 404);
    res = await getJson(`/api/walle/sessions?blindUserId=${state.x.id}`, cookieHeader(state.cookieB));
    assertStatus('walle: B scoped X (A-linked) → 404', res.status, 404);
    res = await getJson(`/api/walle/sessions?blindUserId=${state.x.id}`);
    assertStatus('walle: scoped X without cookie → 401', res.status, 401);

    res = await getJson('/api/walle/sessions?blindUserId=');
    assertStatus('walle: empty blindUserId param unauth → 401 (Stage-8A gate)', res.status, 401);

    res = await getJson('/api/walle/sessions');
    assertStatus('walle: unscoped GET sessions unauth → 401 (Stage-8A gate)', res.status, 401);

    res = await getJson('/api/walle/sessions', cookieHeader(state.cookieA));
    assertStatus('walle: unscoped GET sessions caretaker → 200 (legacy)', res.status, 200);
    const allSes = (bodyOf(res) || []).map((s) => s.sessionId);
    check('walle: authorized unscoped sees all three sessions',
        allSes.includes(SID_X) && allSes.includes(SID_Y) && allSes.includes(SID_Z),
        JSON.stringify(allSes));

    // ── Auth-gated Wall-E history ──────────────────────────────────
    res = await getJson(`/api/walle/history/${SID_X}`, cookieHeader(state.cookieA));
    assertStatus('history: A reads X transcript → 200', res.status, 200);
    check('history: transcript bound to X',
        bodyOf(res) && bodyOf(res).blindUserId === state.x.id,
        JSON.stringify(bodyOf(res)));

    res = await getJson(`/api/walle/history/${SID_X}`, cookieHeader(state.cookieB));
    assertStatus('history: B reads X transcript → 404', res.status, 404);
    res = await getJson(`/api/walle/history/${SID_X}`);
    assertStatus('history: X transcript without cookie → 401', res.status, 401);
    res = await getJson(`/api/walle/history/${SID_Z}`, cookieHeader(state.cookieA));
    assertStatus('history: A reads Z transcript → 404', res.status, 404);
    res = await getJson('/api/walle/history/stg6-does-not-exist', cookieHeader(state.cookieA));
    assertStatus('history: nonexistent session → 404', res.status, 404);

    // ── No-data user (deviceless, eventless) ───────────────────────
    res = await postJson('/api/blind-users', { name: 'Devki', email: `${PREFIX}${ts}-w@test.local` }, authHeaders(state.cookieA));
    assertStatus('nodata: create blind user W (no device)', res.status, 201);
    state.w = bodyOf(res) && bodyOf(res).user;
    res = await postJson(`/api/caretaker/blind-users/${state.w.id}`, {}, authHeaders(state.cookieA));
    assertStatus('nodata: A links W', res.status, 201);

    res = await getJson(`/api/events?blindUserId=${state.w.id}`, cookieHeader(state.cookieA));
    assertStatus('nodata: A scoped W events → 200', res.status, 200);
    check('nodata: W events empty array', Array.isArray(bodyOf(res)) && bodyOf(res).length === 0,
        JSON.stringify(bodyOf(res)));

    res = await getJson(`/api/location?blindUserId=${state.w.id}`, cookieHeader(state.cookieA));
    assertStatus('nodata: A scoped W location → 200', res.status, 200);
    check('nodata: W location null placeholders',
        bodyOf(res) && bodyOf(res).latitude === null && bodyOf(res).longitude === null,
        JSON.stringify(bodyOf(res)));

    res = await getJson(`/api/walle/sessions?blindUserId=${state.w.id}`, cookieHeader(state.cookieA));
    assertStatus('nodata: A scoped W sessions → 200', res.status, 200);
    check('nodata: W sessions empty array', Array.isArray(bodyOf(res)) && bodyOf(res).length === 0,
        JSON.stringify(bodyOf(res)));

    // ── Deactivation revokes data visibility ───────────────────────
    res = await deleteJson(`/api/caretaker/blind-users/${state.x.id}`, cookieHeader(state.cookieA));
    assertStatus('deact: A unlinks X → 200', res.status, 200);

    res = await getJson(`/api/events?blindUserId=${state.x.id}`, cookieHeader(state.cookieA));
    assertStatus('deact: A scoped X events → 404 after unlink', res.status, 404);
    res = await getJson(`/api/location?blindUserId=${state.x.id}`, cookieHeader(state.cookieA));
    assertStatus('deact: A scoped X location → 404 after unlink', res.status, 404);
    res = await getJson(`/api/walle/sessions?blindUserId=${state.x.id}`, cookieHeader(state.cookieA));
    assertStatus('deact: A scoped X sessions → 404 after unlink', res.status, 404);
    res = await getJson(`/api/walle/history/${SID_X}`, cookieHeader(state.cookieA));
    assertStatus('hist-or: A reads X transcript → 404 after unlink', res.status, 404);

    // X's own device can still post (device path, not caretaker scoping).
    res = await postJson('/api/events', eventPayload(`stg6-${ts}-xafter`), deviceHeaders(state.devX.identifier, state.devX.token));
    assertStatus('deact: X device still posts events → 201', res.status, 201);

    // ── Role gate: a BLIND_USER cookie cannot scope ────────────────
    const blindLoginInsert = await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'BLIND_USER')
         RETURNING id`,
        ['Blind Login User', EMAIL_BLIND_LOGIN, await bcrypt.hash(BLIND_LOGIN_PASSWORD, 10)]
    );
    res = await postJson('/api/auth/login', { email: EMAIL_BLIND_LOGIN, password: BLIND_LOGIN_PASSWORD });
    assertStatus('role: blind user can login (fixture)', res.status, 200);
    const blindCookie = readCookie(res) && readCookie(res).value;
    if (blindCookie) {
        res = await getJson(`/api/events?blindUserId=${state.y.id}`, cookieHeader(blindCookie));
        assertStatus('role: blind user scoped events → 403', res.status, 403);
        res = await getJson(`/api/walle/history/${SID_Y}`, cookieHeader(blindCookie));
        assertStatus('role: blind user history → 403', res.status, 403);
    } else {
        check('role: blind user scoped events → 403', false, 'no cookie captured, skipped');
    }

    // ── Final regression sweep ─────────────────────────────────────
    res = await getJson('/api/health');
    assertStatus('regression: /api/health 200', res.status, 200);
    res = await getJson('/api/events');
    assertStatus('regression: unscoped events 200', res.status, 200);
    res = await getJson('/api/location');
    assertStatus('regression: unscoped location 200', res.status, 200);
    res = await getJson('/api/walle/sessions');
    assertStatus('regression: unscoped sessions unauth 401 (Stage-8A gate)', res.status, 401);
    res = await getJson('/api/walle/sessions', cookieHeader(state.cookieA));
    assertStatus('regression: unscoped sessions caretaker 200', res.status, 200);

    return state;
}

async function cleanup(state) {
    try {
        const users = await query(`SELECT id FROM users WHERE email LIKE 'stg6-%'`);
        const ids = users.rows.map((r) => r.id);
        if (ids.length > 0) {
            await query('DELETE FROM events WHERE blind_user_id = ANY($1)', [ids]);
            await query('DELETE FROM walle_sessions WHERE blind_user_id = ANY($1)', [ids]);
        }
        // MQTT events carry no blind_user_id (esp. the unknown-device one).
        const trash = (state && state.trashMqttAlertIds) || [];
        for (const alertId of trash) {
            await query('DELETE FROM events WHERE alert_id = $1', [alertId]);
        }
        await query(`DELETE FROM users WHERE email LIKE 'stg6-%'`);
        console.log('[test] cleaned up stg6 users (cascades relationships, sessions, devices) + events');
        const leftover = await query(`SELECT COUNT(*)::int AS n FROM users WHERE email LIKE 'stg6-%'`);
        console.log(`[test] leftover stg6 users: ${leftover.rows[0].n}`);
    } catch (err) {
        console.warn('[test] cleanup failed (non-fatal):', err.message || err);
    }
}

async function main() {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
        console.error('[test] FATAL: DATABASE_URL is not configured. stage6 tests need the local blindguardian database.');
        process.exit(1);
    }

    // Stale MQTT-* rows from previous runs would collide with this run's
    // sequence (idempotent INSERT would silently skip). MQTT ids are only ever
    // produced by test MQTT handlers, so purging them is safe test hygiene.
    try {
        await query(`DELETE FROM events WHERE alert_id LIKE 'MQTT-SOS-%'`);
        console.log('[test] purged stale MQTT-SOS-* rows');
    } catch (err) {
        console.warn('[test] pre-purge failed (non-fatal):', err.message || err);
    }

    console.log('[test] stage6 in-process harness starting (MQTT entry point + HTTP)…');
    await startHttp();
    console.log(`[test] backend listening on ${baseUrl}`);

    let state = null;
    try {
        state = await runTests();
    } finally {
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
    console.log('');
    console.log(`[test] ${results.length - failed.length}/${results.length} checks passed`);
    process.exit(1);
});