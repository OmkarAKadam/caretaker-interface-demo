'use strict';

// Stage 8B integration test harness: production hardening.
//
// Covers:
//   A  REQUIRE_AUTH_FOR_READS — default OFF keeps the demo public; when ON the
//      unscoped read endpoints require an authenticated CARETAKER, and scoped
//      reads still require the right caretaker (404 for unrelated users, 401
//      when anonymous, 403 for a BLIND_USER role cookie)
//   B  HTTP security headers on every response (HSTS only in production/HTTPS;
//      CSP documented as deferred)
//   C  per-device write rate limiting — identity-keyed, independent buckets,
//      sliding-window rollover after the window elapses, generous normal case
//   D  SSE — connection cap with clean rejection, removal on disconnect
//   E  trust proxy — default OFF (XFF ignored at the rate limiter), explicit
//      hop-count config honored, arbitrary trust NOT assumed
//   F  Stage 8A regression — Wall-E session ownership, trusted-context
//      isolation, 256-char event message cap, stored-XSS guard on the render
//      path
//
// Runs in-process against the real local PostgreSQL database with the real
// Express app on an ephemeral port. MQTT is disabled so buzzer/stream MQTT
// publishes fail-close without a broker; NVIDIA_API_KEY is blanked so Wall-E
// chat returns 503 after the session check instead of dialing out.
//
// Env changes are applied BEFORE the server module is (re-)required, then the
// module cache is cleared so each phase boots fresh factories and limiters —
// exactly the in-process reload pattern the stage8a harness uses.
//
// Run with:
//   npm run test:stage8b

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

process.env.MQTT_BROKER_URL = '';
process.env.NVIDIA_API_KEY = '';
process.env.NODE_ENV = 'test';
process.env.COOKIE_SECURE = 'false';

const { query, getPool } = require('../db/pool');
const { hashPassword } = require('../auth/password');
const { shouldSendHsts } = require('../security-headers');

const PREFIX = 'stg8b-';
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'bg_session';
const ENV_KEYS = [
    'REQUIRE_AUTH_FOR_READS',
    'SSE_MAX_CLIENTS',
    'DEVICE_EVENTS_RATE_MAX',
    'DEVICE_WRITE_RATE_WINDOW_MS',
    'DEVICE_LOCATION_RATE_MAX',
    'DEVICE_BUZZER_RATE_MAX',
    'TRUST_PROXY',
    'AUTH_RATE_MAX',
    'AUTH_RATE_WINDOW_MS'
];

let currentServerModule = null;

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

function nowIso() {
    return new Date().toISOString();
}

// ── Module (re)load with env patching ──────────────────────────────────
// A fresh require with the requested env gives fresh limiter factories and a
// fresh in-memory runtime state — the in-process equivalent of restarting with
// a different configuration.
async function reloadServer(env) {
    for (const key of ENV_KEYS) {
        if (env && env[key] !== undefined) process.env[key] = String(env[key]);
        else delete process.env[key];
    }
    // Fresh factories and limiters from a clean require.
    delete require.cache[require.resolve('../auth/rate-limit')];
    delete require.cache[require.resolve('../auth/routes')];
    delete require.cache[require.resolve('../ai/conversation-store')];
    delete require.cache[require.resolve('../server')];
    currentServerModule = require('../server');
}

// ── In-process HTTP (real Express app, ephemeral port) ─────────────────
let httpServer = null;
let baseUrl = '';

async function startHttp() {
    if (httpServer) {
        await new Promise((resolve) => httpServer.close(resolve));
        httpServer = null;
    }
    httpServer = currentServerModule.app.listen(0);
    await new Promise((resolve) => httpServer.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
}

async function stopHttp() {
    abortAllStreams();
    if (httpServer) {
        await new Promise((resolve) => httpServer.close(resolve));
        httpServer = null;
    }
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

// ── SSE helpers ────────────────────────────────────────────────────────
const sseControllers = [];

function abortAllStreams() {
    while (sseControllers.length) sseControllers.pop().abort();
}

async function openStream(url, headers) {
    const controller = new AbortController();
    sseControllers.push(controller);
    const res = await fetch(`${baseUrl}${url}`, {
        headers: headers || {},
        signal: controller.signal
    });
    return res;
}

async function closeStream(controller) {
    controller.abort();
    const idx = sseControllers.indexOf(controller);
    if (idx >= 0) sseControllers.splice(idx, 1);
}

async function waitUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((r) => setTimeout(r, 75));
    }
    return predicate();
}

// ── Phase 1: demo defaults (REQUIRE_AUTH_FOR_READS unset) ─────────────
async function phase1DemoDefaults() {
    check('p1cfg: trust proxy defaults OFF', currentServerModule.app.get('trust proxy') === false, `got ${currentServerModule.app.get('trust proxy')}`);

    // A1: public read endpoints keep working without any auth.
    let res = await getJson('/api/events');
    assertStatus('A1: GET /api/events public when off → 200', res.status, 200);
    res = await getJson('/api/health');
    assertStatus('A1: GET /api/health public when off → 200', res.status, 200);
    res = await getJson('/api/location');
    assertStatus('A1: GET /api/location public when off → 200', res.status, 200);

    // Scoped reads are never public (established in Stage 6) — even when the
    // gate is OFF for the unscoped form.
    res = await getJson('/api/events?blindUserId=');
    assertStatus('A1: empty blindUserId treated as unscoped when gate off → 200', res.status, 200);
    res = await getJson('/api/location?blindUserId=not-a-uuid');
    assertStatus('A1: malformed blindUserId still 404 when gate off', res.status, 404);

    // B: security headers present on a normal response; HSTS absent over http.
    res = await getJson('/api/health');
    check('B: X-Content-Type-Options nosniff',
        res.headers.get('x-content-type-options') === 'nosniff',
        String(res.headers.get('x-content-type-options')));
    check('B: X-Frame-Options DENY',
        res.headers.get('x-frame-options') === 'DENY',
        String(res.headers.get('x-frame-options')));
    check('B: Referrer-Policy no-referrer',
        res.headers.get('referrer-policy') === 'no-referrer',
        String(res.headers.get('referrer-policy')));
    check('B: no HSTS on plain http test env',
        res.headers.get('strict-transport-security') === null,
        String(res.headers.get('strict-transport-security')));
    check('B: HSTS unit — production env sends HSTS', shouldSendHsts('production', false) === true);
    check('B: HSTS unit — https request sends HSTS', shouldSendHsts('test', true) === true);
    check('B: HSTS unit — dev over http sends none', shouldSendHsts('development', false) === false);

    // D: SSE still streams to anonymous clients in demo mode.
    let stream = await openStream('/api/events/stream');
    check('D: SSE streams when gate off → 200/event-stream',
        stream.status === 200 && String(stream.headers.get('content-type')).includes('text/event-stream'),
        `status ${stream.status}, content-type ${stream.headers.get('content-type')}`);
    const opened = await waitUntil(() => currentServerModule.getSseClientCount() === 1, 2000);
    check('D: SSE client registered while connected', opened, `count ${currentServerModule.getSseClientCount()}`);
    await closeStream(sseControllers[sseControllers.length - 1]);
    check('D: SSE client removed on disconnect',
        await waitUntil(() => currentServerModule.getSseClientCount() === 0, 2000),
        `count ${currentServerModule.getSseClientCount()}`);

    // E: XFF must NOT create per-IP buckets while trust proxy is OFF — the
    // in-memory auth limiter is keyed on req.ip (127.0.0.1 here), so rotating
    // X-Forwarded-For headers all consume the same bucket and eventually 429.
    let sawSecondToLast401 = false;
    let sawLast429 = false;
    for (let i = 0; i < 21; i += 1) {
        const r = await postJson('/api/auth/login', { email: `${PREFIX}nobody@test.local`, password: 'wrong-password' }, { 'X-Forwarded-For': `10.0.0.${i}` });
        if (i === 19) sawSecondToLast401 = r.status === 401;
        if (i === 20) sawLast429 = r.status === 429;
    }
    check('E: login limiter still applies via shared req.ip bucket', sawSecondToLast401 && sawLast429,
        `second-to-last 401=${sawSecondToLast401}, last 429=${sawLast429}`);
}

// ── Phase 2: hardened mode (REQUIRE_AUTH_FOR_READS=true) ───────────────
const ts = Date.now();
const EMAIL_A = `${PREFIX}${ts}-caretaker-a@test.local`;
const EMAIL_B = `${PREFIX}${ts}-caretaker-b@test.local`;
const PASSWORD = 'CorrectHorse42!';

const SID_X = `${PREFIX}${ts}-xsess`;
const SID_Y = `${PREFIX}${ts}-ysess`;

async function fixtureLogin(email, password, label) {
    const res = await postJson('/api/auth/login', { email, password });
    const cookie = readCookie(res) && readCookie(res).value;
    check(`p2setup: login ${label}`, Boolean(cookie), `login ${res.status}`);
    return cookie;
}

async function makeBlindUser(name, email, caretakerCookie) {
    const res = await postJson('/api/blind-users', { name, email }, authHeaders(caretakerCookie));
    return bodyOf(res) && bodyOf(res).user;
}

async function linkBlindUser(blindUser, caretakerCookie) {
    await postJson(`/api/caretaker/blind-users/${blindUser.id}`, {}, authHeaders(caretakerCookie));
}

async function makeDevice(blindUserId, tag, caretakerCookie) {
    const r = await postJson('/api/devices', {
        blindUserId,
        deviceIdentifier: `${PREFIX.toUpperCase()}${ts}-${tag}-DEV`,
        friendlyName: `${tag} Cap`
    }, authHeaders(caretakerCookie));
    return { identifier: `${PREFIX.toUpperCase()}${ts}-${tag}-DEV`, token: bodyOf(r) && bodyOf(r).token };
}

async function phase2Hardened() {
    // Fixtures.
    let res = await postJson('/api/auth/register', { name: 'Stage8b Caretaker A', email: EMAIL_A, password: PASSWORD });
    assertStatus('p2setup: register caretaker A', res.status, 201);
    res = await postJson('/api/auth/register', { name: 'Stage8b Caretaker B', email: EMAIL_B, password: PASSWORD });
    assertStatus('p2setup: register caretaker B', res.status, 201);
    const cookieA = await fixtureLogin(EMAIL_A, PASSWORD, 'caretaker A');
    const cookieB = await fixtureLogin(EMAIL_B, PASSWORD, 'caretaker B');

    const x = await makeBlindUser('Stage8b Blind X', `${PREFIX}${ts}-x@test.local`, cookieA);
    const y = await makeBlindUser('Stage8b Blind Y', `${PREFIX}${ts}-y@test.local`, cookieB);
    check('p2setup: blind users created', Boolean(x && y));
    await linkBlindUser(x, cookieA);
    await linkBlindUser(y, cookieB);
    const devX = await makeDevice(x.id, 'X', cookieA);
    const devY = await makeDevice(y.id, 'Y', cookieB);
    check('p2setup: device tokens issued', Boolean(devX.token && devY.token));

    // A2: the unscoped reads are now caretaker-gated.
    res = await getJson('/api/events');
    assertStatus('A2: unscoped GET /api/events no auth → 401', res.status, 401);
    res = await getJson('/api/location');
    assertStatus('A2: unscoped GET /api/location no auth → 401', res.status, 401);
    res = await getJson('/api/health');
    assertStatus('A2: GET /api/health no auth → 401', res.status, 401);
    res = await getJson('/api/buzzer');
    assertStatus('A2: GET /api/buzzer no auth → 401', res.status, 401);

    // Authenticated caretaker sessions still read fine.
    res = await getJson('/api/events', cookieHeader(cookieA));
    assertStatus('A2: unscoped GET /api/events with caretaker → 200', res.status, 200);
    res = await getJson('/api/health', cookieHeader(cookieB));
    assertStatus('A2: GET /api/health with caretaker → 200', res.status, 200);

    // A BLIND_USER cookie must not elevate into the unscoped reads.
    const blindEmail = `${PREFIX}${ts}-blind-role@test.local`;
    await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'BLIND_USER') RETURNING id`,
        ['Stage8b Blind Role', blindEmail, await hashPassword('KnownBlind!42')]
    );
    const blindLogin = await postJson('/api/auth/login', { email: blindEmail, password: 'KnownBlind!42' });
    const blindCookie = readCookie(blindLogin) && readCookie(blindLogin).value;
    check('A2: blind-role fixture can log in', Boolean(blindCookie), `login ${blindLogin.status}`);
    if (blindCookie) {
        res = await getJson('/api/events', cookieHeader(blindCookie));
        assertStatus('A2: BLIND_USER cookie unscoped read → 403', res.status, 403);
    }

    // A3: scoped reads still enforce caretaker→blind-user relationship.
    res = await getJson(`/api/events?blindUserId=${x.id}`, cookieHeader(cookieA));
    assertStatus('A3: caretaker A scoped X → 200', res.status, 200);
    res = await getJson(`/api/events?blindUserId=${y.id}`, cookieHeader(cookieA));
    assertStatus('A3: caretaker A scoped Y (B-linked) → 404', res.status, 404);
    res = await getJson(`/api/events?blindUserId=${y.id}`, cookieHeader(cookieB));
    assertStatus('A3: caretaker B scoped Y → 200', res.status, 200);
    res = await getJson(`/api/events?blindUserId=${x.id}`);
    assertStatus('A3: scoped read anonymous → 401', res.status, 401);
    res = await getJson(`/api/location?blindUserId=${x.id}`, cookieHeader(cookieA));
    assertStatus('A3: caretaker A scoped location X → 200', res.status, 200);
    res = await getJson(`/api/location?blindUserId=${y.id}`, cookieHeader(cookieA));
    assertStatus('A3: caretaker A scoped location Y → 404', res.status, 404);

    // C: per-device write rate limits (identity-keyed, not IP).
    res = await getJson('/api/health', cookieHeader(cookieA)); // headers sanity on authed path
    check('B: headers kept on authed responses',
        res.headers.get('x-content-type-options') === 'nosniff' && res.headers.get('x-frame-options') === 'DENY',
        `cto ${res.headers.get('x-content-type-options')}, xfo ${res.headers.get('x-frame-options')}`);

    // Normal telemetry flows under the cap.
    let okEvents = 0;
    for (let i = 0; i < 6; i += 1) {
        res = await postJson('/api/events', eventPayload(`${PREFIX}${ts}-ev-${i}`), deviceHeaders(devX.identifier, devX.token));
        if (res.status === 201) okEvents += 1;
    }
    check('C: devX normal event telemetry accepted (<= max)', okEvents === 6, `accepted ${okEvents}/6`);

    res = await postJson('/api/events', eventPayload(`${PREFIX}${ts}-ev-cap`), deviceHeaders(devX.identifier, devX.token));
    assertStatus('C: devX events over max → 429', res.status, 429);

    // devY is an independent bucket — unaffected by devX hitting the cap.
    res = await postJson('/api/events', eventPayload(`${PREFIX}${ts}-ev-y`), deviceHeaders(devY.identifier, devY.token));
    assertStatus('C: devY events unaffected by devX cap → 201', res.status, 201);

    // devY location limiter is a separate instance with its own history.
    let okLocs = 0;
    for (let i = 0; i < 8; i += 1) {
        res = await postJson('/api/location', { latitude: 22.31 + i / 100, longitude: 73.17, timestamp: nowIso() }, deviceHeaders(devY.identifier, devY.token));
        if (res.status === 200) okLocs += 1;
    }
    check('C: devY location telemetry accepted (<= max)', okLocs === 8, `accepted ${okLocs}/8`);
    res = await postJson('/api/location', { latitude: 22.4, longitude: 73.2, timestamp: nowIso() }, deviceHeaders(devY.identifier, devY.token));
    assertStatus('C: devY location over max → 429', res.status, 429);

    // devX location (unused bucket) still works.
    res = await postJson('/api/location', { latitude: 22.99, longitude: 73.99, timestamp: nowIso() }, deviceHeaders(devX.identifier, devX.token));
    assertStatus('C: devX location in own bucket → 200', res.status, 200);

    // Buzzer (low cap). MQTT is disabled in the harness, so the publish fails
    // with 503 here — but the limiter still counts the attempt (it runs before
    // the handler), so the 4th call trips 429. 200/503 both mean "passed the
    // limiter".
    const buzzerStatuses = [];
    for (let i = 0; i < 3; i += 1) {
        res = await postJson('/api/buzzer', { command: 'BUZZER_ON' }, deviceHeaders(devY.identifier, devY.token));
        buzzerStatuses.push(res.status);
    }
    check('C: devY buzzer attempts accepted by limiter (200/503, not 429)', buzzerStatuses.every((s) => s === 200 || s === 503), buzzerStatuses.join(','));
    res = await postJson('/api/buzzer', { command: 'BUZZER_OFF' }, deviceHeaders(devY.identifier, devY.token));
    assertStatus('C: devY buzzer over max → 429', res.status, 429);

    // devX events bucket rolls over once the window elapses.
    await new Promise((r) => setTimeout(r, 1700));
    res = await postJson('/api/events', eventPayload(`${PREFIX}${ts}-ev-after`), deviceHeaders(devX.identifier, devX.token));
    assertStatus('C: devX events window rolled over → 201', res.status, 201);

    // D: SSE cap only accepts the configured concurrent connections.
    res = await getJson('/api/events/stream');
    assertStatus('D: SSE gated when AUTH on → 401 (no auth)', res.status, 401);
    res = await getJson('/api/events/stream', cookieHeader(blindCookie));
    assertStatus('D: SSE gated when AUTH on → 403 (BLIND cookie)', res.status, 403);

    for (let i = 0; i < 3; i += 1) {
        await openStream('/api/events/stream', cookieHeader(cookieA));
    }
    check('D: three concurrent SSE connections accepted (cap 3)',
        await waitUntil(() => currentServerModule.getSseClientCount() === 3, 3000),
        `count ${currentServerModule.getSseClientCount()}`);
    const fourth = await openStream('/api/events/stream', cookieHeader(cookieA));
    assertStatus('D: 4th SSE connection rejected cleanly → 503', fourth.status, 503);
    await abortAllStreams();
    check('D: SSE disconnects drain the connection count',
        await waitUntil(() => currentServerModule.getSseClientCount() === 0, 3000),
        `count ${currentServerModule.getSseClientCount()}`);

    // F: Wall-E session ownership still enforced (Stage 8A C).
    res = await postJson('/api/walle/chat', { sessionId: SID_X, message: 'X owns this session' }, deviceHeaders(devX.identifier, devX.token));
    assertStatus('F: X creates session (hand-off 503)', res.status, 503);
    const certStore = require('../ai/conversation-store');
    const transcriptBefore = certStore.getSessionTranscript(SID_X);
    check('F: X session bound to X', Boolean(transcriptBefore && transcriptBefore.blindUserId === x.id), JSON.stringify(transcriptBefore));
    const turnsBefore = transcriptBefore ? transcriptBefore.turns.length : -1;
    res = await postJson('/api/walle/chat', { sessionId: SID_X, message: 'Y pokes at X transcript' }, deviceHeaders(devY.identifier, devY.token));
    assertStatus('F: Y continuing X session → 404', res.status, 404);
    const transcriptAfter = certStore.getSessionTranscript(SID_X);
    check('F: X transcript unchanged after Y attempt',
        Boolean(transcriptAfter) && transcriptAfter.turns.length === turnsBefore,
        `before ${turnsBefore}, after ${transcriptAfter && transcriptAfter.turns.length}`);
    res = await postJson('/api/walle/chat', { sessionId: SID_X, message: 'X follow-up' }, deviceHeaders(devX.identifier, devX.token));
    assertStatus('F: X continues own session (hand-off 503)', res.status, 503);

    // F: trusted-context isolation (Stage 8A D) — unit-level.
    const runtime = {
        latestLocation: { deviceId: devX.identifier, blindUserId: x.id, latitude: 22.1, longitude: 73.2, timestamp: nowIso() },
        latestDeviceStatus: { deviceId: devX.identifier, status: 'ONLINE', receivedAt: nowIso() },
        lastHeartRate: { deviceId: devY.identifier, heartRate: 122, timestamp: nowIso() },
        latestFall: { deviceId: 'unknown', timestamp: nowIso() },
        latestBuzzerState: 'ON'
    };
    const scopedX = currentServerModule.scopeRuntimeStateForDevice({ identifier: devX.identifier, blindUserId: x.id }, runtime);
    check('F: ctx keeps own location', Boolean(scopedX.latestLocation && scopedX.latestLocation.latitude === 22.1));
    check('F: ctx excludes other-user heart-rate', !scopedX.lastHeartRate);
    check('F: ctx excludes unknown-identity fall', !scopedX.latestFall);

    // F: event message cap (Stage 8A E) re-verified on the REST path.
    const max = currentServerModule.EVENT_MESSAGE_MAX;
    check('F: EVENT_MESSAGE_MAX = 256', max === 256, `got ${max}`);
    res = await postJson('/api/events', eventPayload(`${PREFIX}${ts}-msglong`, { message: 'x'.repeat(257) }), deviceHeaders(devX.identifier, devX.token));
    assertStatus('F: 257-char message → 400', res.status, 400);
    res = await postJson('/api/events', eventPayload(`${PREFIX}${ts}-msgok`, { message: 'x'.repeat(max) }), deviceHeaders(devX.identifier, devX.token));
    assertStatus('F: 256-char message → 201', res.status, 201);

    return { cookieA, cookieB, x, y, devX, devY };
}

// Static Stage 8A F guard: alertId/source/trigger/status never interpolated
// into innerHTML on the caretaker render path.
function testFrontendXssGuard() {
    const scriptPath = path.join(__dirname, '..', '..', 'caretaker-interface-frontend', 'script.js');
    const source = fs.readFileSync(scriptPath, 'utf8');
    const vectors = /\$\{event\.alertId|sourceLabel|triggerLabel|statusLabel/;
    const htmlSinks = source.split('\n').filter((l) => l.includes('innerHTML') && vectors.test(l));
    check('F: alertId/source/trigger/status never interpolated into innerHTML', htmlSinks.length === 0, htmlSinks.join(' | '));
    check('F: alertId set via textContent',
        source.includes("querySelector('.history-alert-id').textContent = event.alertId"));
}

// ── Phase 3: trust proxy explicitly enabled ────────────────────────────
async function phase3TrustProxy() {
    check('Ecfg: trust proxy honored as hop count', currentServerModule.app.get('trust proxy') === 1, `got ${currentServerModule.app.get('trust proxy')}`);

    // The login route's in-memory limiter is keyed on req.ip, which now derives
    // from X-Forwarded-For (max 20 per window — the route's fixed login budget).
    // The same XFF 1.2.3.4 must exhaust its own bucket → 429 on the 21st try,
    // while a fresh 9.9.9.9 gets an untouched bucket → 401.
    const statuses = [];
    for (let i = 0; i < 21; i += 1) {
        const r = await postJson('/api/auth/login', { email: `${PREFIX}tp@test.local`, password: 'wrong-password' }, { 'X-Forwarded-For': '1.2.3.4' });
        statuses.push(r.status);
    }
    check('E: XFF client 1.2.3.4 rate-limited itself (JSON came from XFF, not socket IP)',
        statuses.slice(0, 20).every((s) => s === 401) && statuses[20] === 429,
        statuses.join(','));
    const fresh = await postJson('/api/auth/login', { email: `${PREFIX}tp@test.local`, password: 'wrong-password' }, { 'X-Forwarded-For': '9.9.9.9' });
    assertStatus('E: distinct XFF client 9.9.9.9 gets own bucket → 401', fresh.status, 401);
}

// ── Cleanup ────────────────────────────────────────────────────────────
async function cleanup() {
    try {
        const users = await query(`SELECT id FROM users WHERE email LIKE '${PREFIX}%'`);
        const ids = users.rows.map((r) => r.id);
        if (ids.length > 0) {
            await query('DELETE FROM events WHERE blind_user_id = ANY($1)', [ids]);
            await query('DELETE FROM walle_sessions WHERE blind_user_id = ANY($1)', [ids]);
        }
        await query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
        const leftover = await query(`SELECT COUNT(*)::int AS n FROM users WHERE email LIKE '${PREFIX}%'`);
        console.log(`[test] leftover stg8b users: ${leftover.rows[0].n}`);
    } catch (err) {
        console.warn('[test] cleanup failed (non-fatal):', err.message || err);
    }
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
        console.error('[test] FATAL: DATABASE_URL is not configured. stage8b tests need the local blindguardian database.');
        process.exit(1);
    }

    console.log('[test] stage8b in-process harness starting (production hardening)…');

    try {
        await reloadServer({});
        await startHttp();
        console.log('[test] phase 1 — demo defaults (AUTH reads OFF)');
        console.log(`        backend listening on ${baseUrl}`);
        await phase1DemoDefaults();

        console.log('[test] phase 2 — hardened mode (REQUIRE_AUTH_FOR_READS=true)');
        await stopHttp();
        await reloadServer({ REQUIRE_AUTH_FOR_READS: 'true', SSE_MAX_CLIENTS: '3', DEVICE_WRITE_RATE_WINDOW_MS: '1500', DEVICE_EVENTS_RATE_MAX: '6', DEVICE_LOCATION_RATE_MAX: '8', DEVICE_BUZZER_RATE_MAX: '3' });
        await startHttp();
        testFrontendXssGuard();
        const state = await phase2Hardened();

        console.log('[test] phase 3 — explicit trust proxy (TRUST_PROXY=1)');
        await stopHttp();
        await reloadServer({ TRUST_PROXY: '1' });
        await startHttp();
        await phase3TrustProxy();
    } finally {
        try {
            await query(`DELETE FROM events WHERE alert_id LIKE '${PREFIX}%'`);
        } catch (_err) { /* ignore */ }
        // Let fire-and-forget event persistence settle before user rows go away.
        await new Promise((r) => setTimeout(r, 1500));
        await stopHttp();
        await cleanup();
        if (getPool().end) { try { await getPool().end(); } catch (_err) { /* ignore */ } }
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