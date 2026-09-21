'use strict';

// Integration + deterministic engine tests for the on-demand heart-rate
// monitoring feature:
//
//   • The caretaker dashboard asks THIS backend for a fresh reading
//     (POST /api/caretaker/devices/:deviceId/heart-rate-request), which issues
//     ONE GET_HEART_RATE MQTT command and correlates the device's response by
//     requestId. Users/devices are resolved from the DB by UUID, so the
//     POST never trusts a client-supplied deviceId.
//   • The backend owns the per-device automatic schedule: normal cadence
//     (default 5 min), high-frequency cadence after an abnormal reading
//     (< 60 or > 100), recovery after N consecutive normals.
//   • Readings (CONTINUOUS / MANUAL / AUTOMATIC) land in device-scoped
//     heart_rate_history — never as alert events or SSE broadcasts. Normal
//     readings never create alert events at all.
//   • Classic requirement: ONE device — ONE in-flight request (collision
//     protection), per-device timeout + reschedule, restart never leaves a
//     stale pending request, and a request for one device can never be answered
//     by another device's reading.
//
// The engine tests use a standalone, deterministic engine (injected clock +
// injected publisher). The REST tests run the real server against the real
// local PostgreSQL database with an injected publisher, like test-hr-state.
//
// Run with:
//   npm run test:hrmonitor

const crypto = require('crypto');

// MQTT must be disabled BEFORE server.js is required below.
process.env.MQTT_BROKER_URL = '';

const { query, getPool } = require('../db/pool');
const { hashPassword } = require('../auth/password');
const { TOPICS } = require('../mqtt/topics');
const { createHeartRateMonitor } = require('../heart-rate/monitor');

let currentServerModule = require('../server');

const PREFIX = 'hrm-';
const ts = Date.now();
const RESULTS = [];

function check(name, pass, detail) {
    RESULTS.push({ name, pass, detail: detail || '' });
}

function assertStatus(label, actual, expected) {
    check(label, actual === expected, `status ${actual}, expected ${expected}`);
}

function isoAt(ms) {
    return new Date(ms).toISOString();
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
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
}

async function httpJson(method, path, payload, headers) {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    let body = null;
    try { body = await res.json(); } catch (_e) { /* non-JSON */ }
    return { status: res.status, body, headers: res.headers };
}

function authHeaders(cookie) {
    return { Cookie: `bg_session=${cookie}` };
}

async function simulateRestart() {
    await startHttp();
    delete require.cache[require.resolve('../ai/conversation-store')];
    delete require.cache[require.resolve('../server')];
    currentServerModule = require('../server');
    await currentServerModule.bootRehydrateFromDatabase();
    await startHttp();
    console.log('[test] simulated restart + boot rehydration done');
}

// Polls a predicate every 25ms until it returns truthy (or times out).
async function waitFor(predicate, label, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`waitFor timed out: ${label}`);
}

// ── Fixtures (mirrors test-hr-state.js) ─────────────────────────────────
async function seedBlindWithDevice(label) {
    const blind = await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'BLIND_USER')
         RETURNING id`,
        [`${label} Blind User`, `${PREFIX}${ts}-${label}-bu@test.local`, await hashPassword('CorrectHorse42!')]
    );
    const blindUserId = blind.rows[0].id;

    const token = crypto.randomBytes(32).toString('base64url');
    const secretHash = await hashPassword(token);
    const identifier = `${PREFIX.toUpperCase()}${ts}-${label}-DEV`;
    const inserted = await query(
        `INSERT INTO devices (blind_user_id, device_identifier, friendly_name, secret_hash, status)
         VALUES ($1, $2, $3, $4, 'OFFLINE')
         RETURNING id`,
        [blindUserId, identifier, `HR Monitor ${label}`, secretHash]
    );
    return { id: inserted.rows[0].id, identifier, token, blindUserId };
}

async function seedCaretaker() {
    const caretaker = await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'CARETAKER')
         RETURNING id`,
        ['HR Monitor Caretaker', `${PREFIX}${ts}-caretaker@test.local`, await hashPassword('CorrectHorse42!')]
    );
    return caretaker.rows[0];
}

async function linkCaretaker(caretakerId, blindUserId) {
    await query(
        `INSERT INTO care_relationships (blind_user_id, caretaker_id, status)
         VALUES ($1, $2, 'ACTIVE')`,
        [blindUserId, caretakerId]
    );
}

async function loginCaretakerCookie() {
    const loginRes = await httpJson('POST', '/api/auth/login', {
        email: `${PREFIX}${ts}-caretaker@test.local`,
        password: 'CorrectHorse42!'
    });
    assertStatus('fixture caretaker logs in', loginRes.status, 200);
    const loginCookie = (loginRes.headers.getSetCookie() || []).find((h) => h.split(';')[0].startsWith('bg_session='));
    return loginCookie ? loginCookie.split(';')[0].split('=').slice(1).join('=') : null;
}

// ── Deterministic standalone engine ─────────────────────────────────────
// Injecting now() + publishCommand makes every schedule/collision/timeout
// decision exact — no real timers, no sleeps.
function makeEngine(overrides) {
    let fakeNow = 0;
    const published = [];
    const engine = createHeartRateMonitor(Object.assign({
        normalIntervalMs: 300000,
        highIntervalMs: 60000,
        recoveryNormalReadings: 3,
        requestTimeoutMs: 5000,
        tickMs: 1000,
        alertLow: 60,
        alertHigh: 100,
        now: () => fakeNow,
        publishCommand: (identifier, requestId) => {
            published.push({ identifier, requestId, at: fakeNow });
            return true;
        }
    }, overrides || {}));
    return {
        engine,
        published,
        setFakeNow: (ms) => { fakeNow = ms; }
    };
}

async function exerciseEngine() {
    // ── E1–E3: automatic normal cadence ────────────────────────────────────
    {
        const { engine, published, setFakeNow } = makeEngine();
        engine.handleReading({
            deviceId: 'HRM-E1',
            heartRate: 78,
            timestamp: isoAt(0)
        });
        check('E1: adoption schedules first AUTO at now + normalInterval',
            engine.getState('HRM-E1') && engine.getState('HRM-E1').nextRequestAt === 300000,
            JSON.stringify(engine.getState('HRM-E1')));

        setFakeNow(299999);
        engine.tick();
        check('E1: no AUTO before the cadence is due', published.length === 0, JSON.stringify(published));

        setFakeNow(300000);
        engine.tick();
        check('E1: AUTO issued exactly when due', published.length === 1 && engine.getState('HRM-E1').pendingRequestId === published[0].requestId,
            JSON.stringify(published));
        check('E1: AUTOMATIC request uses the automatic marker',
            published[0].requestId.startsWith('hrq-a-'), published[0].requestId);

        // E2 — the cadence re-arms OFF the response timestamp (new mode already
        // applied), so the next AUTO is 5 minutes after the reply, not after the
        // (earlier) request.
        setFakeNow(300500);
        const outcome = engine.handleReading({
            deviceId: 'HRM-E1',
            heartRate: 80,
            timestamp: isoAt(300500),
            requestId: published[0].requestId
        });
        check('E2: response resolves the AUTO request', Boolean(outcome.resolvedPending && outcome.readingType === 'AUTOMATIC'),
            JSON.stringify(outcome));
        check('E2: next AUTO scheduled at response + normalInterval',
            engine.getState('HRM-E1').nextRequestAt === 600500,
            JSON.stringify(engine.getState('HRM-E1')));

        setFakeNow(600499);
        engine.tick();
        check('E2: no AUTO before the re-armed cadence', published.length === 1, JSON.stringify(published));
        setFakeNow(600500);
        engine.tick();
        check('E2: second AUTO issued at the re-armed cadence', published.length === 2, published.map((p) => p.at).join(','));
    }

    // ── E4–E6: high-frequency cadence + recovery ───────────────────────────
    {
        const { engine, published, setFakeNow } = makeEngine();
        engine.handleReading({ deviceId: 'HRM-E4', heartRate: 140, timestamp: isoAt(0) });
        check('E4: abnormal reading switches device to HIGH_FREQUENCY',
            engine.getState('HRM-E4').monitoringMode === 'HIGH_FREQUENCY',
            engine.getState('HRM-E4').monitoringMode);

        setFakeNow(300000);
        engine.tick();
        check('E4: AUTO issued while HIGH_FREQUENCY', published.length === 1, JSON.stringify(published));

        // A normal reply while in HIGH_FREQUENCY: 1-of-3 recovery progress, and
        // the cadence re-arms on the HIGH-frequency interval.
        setFakeNow(300100);
        engine.handleReading({
            deviceId: 'HRM-E4',
            heartRate: 75,
            timestamp: isoAt(300100),
            requestId: published[0].requestId
        });
        check('E4: recovery counter increments (1/3) while still HIGH_FREQUENCY',
            engine.getState('HRM-E4').consecutiveNormalReadings === 1 && engine.getState('HRM-E4').monitoringMode === 'HIGH_FREQUENCY',
            JSON.stringify(engine.getState('HRM-E4')));
        check('E4: high-frequency cadence re-arms on HIGH interval',
            engine.getState('HRM-E4').nextRequestAt === 360100,
            JSON.stringify(engine.getState('HRM-E4')));

        // An abnormal reading during recovery resets the counter.
        setFakeNow(360100);
        engine.tick();
        engine.handleReading({
            deviceId: 'HRM-E4',
            heartRate: 130,
            timestamp: isoAt(360200),
            requestId: published[1].requestId
        });
        check('E5: abnormal reading resets recovery counter to 0',
            engine.getState('HRM-E4').consecutiveNormalReadings === 0 && engine.getState('HRM-E4').monitoringMode === 'HIGH_FREQUENCY',
            JSON.stringify(engine.getState('HRM-E4')));

        // E6 — three consecutive normal replies return the device to NORMAL.
        const steps = [420300, 480400, 540500];
        for (let i = 0; i < steps.length; i++) {
            setFakeNow(steps[i] - 100);
            engine.tick();
            setFakeNow(steps[i]);
            engine.handleReading({
                deviceId: 'HRM-E4',
                heartRate: 80,
                timestamp: isoAt(steps[i]),
                requestId: published[i + 2].requestId
            });
        }
        check('E6: 3 consecutive normals recover device to NORMAL cadence',
            engine.getState('HRM-E4').monitoringMode === 'NORMAL' && engine.getState('HRM-E4').consecutiveNormalReadings === 0,
            JSON.stringify(engine.getState('HRM-E4')));
        check('E6: recovered device re-arms on normal interval',
            engine.getState('HRM-E4').nextRequestAt === 540500 + 300000,
            JSON.stringify(engine.getState('HRM-E4')));
    }

    // ── E12–E13: continuous readings never move the automatic schedule ──────
    // CONTINUOUS telemetry updates the reading / classification / recovery
    // state but must NEVER advance, defer, or reset nextRequestAt. Only a
    // matched MANUAL/AUTOMATIC response, or a request timeout, reschedules the
    // next automatic request.
    {
        const { engine, published, setFakeNow } = makeEngine();

        // Adoption via a continuous reading schedules the first AUTO at
        // now + normalInterval (5 minutes in this harness).
        engine.handleReading({ deviceId: 'HRM-E12', heartRate: 78, timestamp: isoAt(0) });
        check('E12: adoption via continuous reading schedules first AUTO at +normalInterval',
            engine.getState('HRM-E12').nextRequestAt === 300000,
            JSON.stringify(engine.getState('HRM-E12')));

        // Several spontaneous continuous readings before the cadence is due.
        for (const at of [60000, 120000, 240000]) {
            setFakeNow(at);
            engine.handleReading({ deviceId: 'HRM-E12', heartRate: 76, timestamp: isoAt(at) });
        }
        check('E12: continuous readings never defer the next automatic request',
            engine.getState('HRM-E12').nextRequestAt === 300000,
            JSON.stringify(engine.getState('HRM-E12')));

        // The AUTO still fires exactly when due.
        setFakeNow(300000);
        engine.tick();
        check('E12: automatic request still fires at the original cadence',
            published.length === 1 && published[0].identifier === 'HRM-E12' && published[0].at === 300000,
            JSON.stringify(published));
    }
    {
        const { engine, published, setFakeNow } = makeEngine();

        // Abnormal continuous reading switches the device to HIGH_FREQUENCY.
        setFakeNow(0);
        engine.handleReading({ deviceId: 'HRM-E13', heartRate: 140, timestamp: isoAt(0) });
        check('E13: abnormal continuous reading switches device to HIGH_FREQUENCY',
            engine.getState('HRM-E13').monitoringMode === 'HIGH_FREQUENCY',
            JSON.stringify(engine.getState('HRM-E13')));

        // First AUTO fires on the registration cadence; the abnormal reply
        // re-arms the schedule on the HIGH_FREQUENCY interval (+60s).
        setFakeNow(300000);
        engine.tick();
        setFakeNow(300100);
        engine.handleReading({
            deviceId: 'HRM-E13',
            heartRate: 132,
            timestamp: isoAt(300100),
            requestId: published[0].requestId
        });
        check('E13: abnormal reply re-arms the schedule on the HIGH_FREQUENCY interval',
            engine.getState('HRM-E13').nextRequestAt === 360100,
            JSON.stringify(engine.getState('HRM-E13')));

        // Continuous normal readings advance recovery but never the schedule.
        setFakeNow(320000);
        engine.handleReading({ deviceId: 'HRM-E13', heartRate: 75, timestamp: isoAt(320000) });
        setFakeNow(340000);
        engine.handleReading({ deviceId: 'HRM-E13', heartRate: 78, timestamp: isoAt(340000) });
        check('E13: continuous readings advance recovery while in HIGH_FREQUENCY',
            engine.getState('HRM-E13').monitoringMode === 'HIGH_FREQUENCY'
            && engine.getState('HRM-E13').consecutiveNormalReadings === 2,
            JSON.stringify(engine.getState('HRM-E13')));
        check('E13: continuous readings never move the HIGH_FREQUENCY schedule',
            engine.getState('HRM-E13').nextRequestAt === 360100,
            JSON.stringify(engine.getState('HRM-E13')));

        // The next AUTO still fires at the re-armed high-frequency cadence.
        setFakeNow(360100);
        engine.tick();
        check('E13: next automatic request fires at the HIGH_FREQUENCY cadence',
            published.length === 2 && published[1].identifier === 'HRM-E13' && published[1].at === 360100,
            JSON.stringify(published));
    }

    // ── E7: collision protection — one device, one in-flight request ───────
    {
        const { engine, published, setFakeNow } = makeEngine();
        const r1 = engine.requestNow('HRM-E7', { issuedBy: 'MANUAL', wait: true });
        check('E7: first manual request published', r1.published && !r1.pending, JSON.stringify(r1));
        const r2 = engine.requestNow('HRM-E7', { issuedBy: 'MANUAL', wait: true });
        check('E7: concurrent manual request joins the SAME pending request',
            r2.pending && r2.requestId === r1.requestId,
            JSON.stringify(r2));
        check('E7: no second command published for the joined request',
            published.length === 1,
            JSON.stringify(published));

        setFakeNow(1000);
        const resolution = engine.handleReading({
            deviceId: 'HRM-E7',
            heartRate: 84,
            timestamp: isoAt(1000),
            requestId: r1.requestId
        });
        check('E7: both waiters resolve with the device reading',
            resolution.readingType === 'MANUAL' && engine.getState('HRM-E7').pendingRequestId === null,
            JSON.stringify(resolution));
    }

    // ── E8: command channel unavailable (MQTT down) ────────────────────────
    {
        const { engine, setFakeNow } = makeEngine();
        engine.setPublishCommand(() => false);
        const r = engine.requestNow('HRM-E8', { issuedBy: 'MANUAL', wait: true });
        const rejection = r.promise.catch((err) => err.message);
        setFakeNow(1);
        const message = await rejection;
        check('E8: un-published request reports publish failure',
            !r.published && !r.pending, JSON.stringify(r));
        check('E8: waiting caller rejected with COMMAND_UNAVAILABLE',
            message === 'HEART_RATE_COMMAND_UNAVAILABLE', message);
        check('E8: un-published request reschedules rather than getting stuck',
            engine.getState('HRM-E8').pendingRequestId === null
            && engine.getState('HRM-E8').nextRequestAt === 300000,
            JSON.stringify(engine.getState('HRM-E8')));
    }

    // ── E9: per-device request timeout + reschedule ────────────────────────
    {
        const { engine, setFakeNow } = makeEngine();
        const r = engine.requestNow('HRM-E9', { issuedBy: 'MANUAL', wait: true });
        const rejection = r.promise.catch((err) => err.message);
        setFakeNow(6000); // past requestTimeoutMs (5000)
        engine.tick();
        const message = await rejection;
        check('E9: unanswered request times out', message === 'HEART_RATE_REQUEST_TIMEOUT', message);
        check('E9: timed-out request abandons the pending state',
            engine.getState('HRM-E9').pendingRequestId === null,
            JSON.stringify(engine.getState('HRM-E9')));
        check('E9: next automatic request rescheduled after the timeout',
            engine.getState('HRM-E9').nextRequestAt === 6000 + 300000,
            JSON.stringify(engine.getState('HRM-E9')));
    }

    // ── E10: separation of devices ─────────────────────────────────────────
    {
        const { engine } = makeEngine();
        engine.handleReading({ deviceId: 'HRM-E10-A', heartRate: 70, timestamp: isoAt(0) });
        const r = engine.requestNow('HRM-E10-A', { issuedBy: 'MANUAL', wait: true });
        const rejection = r.promise.catch(() => null);

        // A reading misattributed to ANOTHER device can never answer device A:
        // B's identifier routes it to B's state, so A's pending request is
        // untouched even though the HEART payload carries A's requestId.
        engine.handleReading({
            deviceId: 'HRM-E10-B',
            heartRate: 95,
            timestamp: isoAt(50),
            requestId: r.requestId
        });
        check('E10: spoofed other-device reading cannot resolve A',
            engine.getState('HRM-E10-A').pendingRequestId === r.requestId,
            JSON.stringify(engine.getState('HRM-E10-A')));
        check('E10: spoofed reading landed on the other device only',
            engine.getState('HRM-E10-B').lastReading.heartRate === 95,
            JSON.stringify(engine.getState('HRM-E10-B')));

        engine.handleReading({
            deviceId: 'HRM-E10-A',
            heartRate: 82,
            timestamp: isoAt(100),
            requestId: r.requestId
        });
        check('E10: real device response resolves the pending request',
            engine.getState('HRM-E10-A').pendingRequestId === null,
            JSON.stringify(engine.getState('HRM-E10-A')));
        await rejection;
        check('E10: other-device readings never touched A during the wait',
            engine.getState('HRM-E10-A').lastReading.heartRate === 82,
            JSON.stringify(engine.getState('HRM-E10-A')));
    }

    // ── E11: restart never restores a stale pending; state rehydrates ──────
    {
        const { engine } = makeEngine();
        engine.requestNow('HRM-E11', { issuedBy: 'MANUAL', wait: false });
        check('E11: pending exists before restart', engine.getState('HRM-E11').pendingRequestId !== null,
            JSON.stringify(engine.getState('HRM-E11')));

        const rows = [
            { deviceId: 'HRM-E11', heartRate: 110, classification: 'HIGH', readingType: 'AUTOMATIC', timestamp: isoAt(200000) },
            { deviceId: 'HRM-E11', heartRate: 78, classification: 'NORMAL', readingType: 'CONTINUOUS', timestamp: isoAt(100000) },
            { deviceId: 'HRM-E11', heartRate: 132, classification: 'HIGH', readingType: 'MANUAL', timestamp: isoAt(50000) }
        ];
        const adopted = engine.rehydrateRows(rows);
        check('E11: rehydration adopts the device', adopted === 1, `adopted ${adopted}`);
        const state = engine.getState('HRM-E11');
        check('E11: restart clears the stale pending request', state.pendingRequestId === null,
            JSON.stringify(state));
        check('E11: newest persisted reading restored as lastReading',
            state.lastReading && state.lastReading.heartRate === 110 && state.lastReading.readingType === 'AUTOMATIC',
            JSON.stringify(state.lastReading));
        check('E11: monitoring mode restored from the newest classification',
            state.monitoringMode === 'HIGH_FREQUENCY' && state.consecutiveNormalReadings === 0,
            JSON.stringify(state));
        check('E11: history restored newest-first',
            engine.getHistory('HRM-E11', 10).map((h) => h.heartRate).join(',') === '110,78,132',
            engine.getHistory('HRM-E11', 10).map((h) => h.heartRate).join(','));
        check('E11: schedule resumes safely (not stuck at a stale moment)',
            state.nextRequestAt > 0,
            JSON.stringify(state));
    }
}

// ── Real-server REST tests ───────────────────────────────────────────────
async function exerciseREST(state) {
    const devA = state.a.device; // linked to the caretaker
    const devB = state.b.device; // linked device (used for isolation/history)
    const devC = state.c.device; // NOT linked (authorization must still pass — linked via caretaker2? no)
    const cookie = state.caretakerCookie;

    const postPath = `/api/caretaker/devices/${devId(devA)}/heart-rate-request`;
    function devId(d) { return d.id; }

    // R1 — auth guard: no session cookie.
    const noAuth = await httpJson('POST', postPath, {});
    assertStatus('R1: POST without session is 401', noAuth.status, 401);

    // R2 — invalid UUID.
    const badUuid = await httpJson('POST', '/api/caretaker/devices/not-a-uuid/heart-rate-request', {}, authHeaders(cookie));
    assertStatus('R2: non-UUID deviceId is 400', badUuid.status, 400);

    // R3 — registered unknown UUID.
    const missing = await httpJson('POST', `/api/caretaker/devices/${crypto.randomUUID()}/heart-rate-request`, {}, authHeaders(cookie));
    assertStatus('R3: unknown device UUID is 404', missing.status, 404);

    // R4 — a real device the caretaker is NOT linked to.
    const notLinked = await httpJson('POST', `/api/caretaker/devices/${devC.id}/heart-rate-request`, {}, authHeaders(cookie));
    assertStatus('R4: unlinked device is 404 (not exposed)', notLinked.status, 404);

    // Inject the fake publisher: every request "hits the device" via this seam.
    const publishedCommands = [];
    currentServerModule.setHeartRateCommandPublisher((identifier, requestId) => {
        publishedCommands.push({ identifier, requestId });
        return true;
    });

    // R5 — manual Get Heart Rate: request → device response → reading returned.
    const postPromise = httpJson('POST', postPath, {}, authHeaders(cookie));
    const requestId = await waitFor(
        () => (currentServerModule.heartRateMonitor.getState(devA.identifier) || {}).pendingRequestId || null,
        'pendingRequestId to appear after POST'
    );
    check('R5: one command published for the manual request',
        publishedCommands.length === 1 && publishedCommands[0].identifier === devA.identifier,
        JSON.stringify(publishedCommands));
    const r5 = await httpJsonSendResponse(postPromise, {
        deviceId: devA.identifier,
        heartRate: 84,
        timestamp: isoAt(Date.now()),
        requestId
    });
    assertStatus('R5: manual request completes with 200', r5.status, 200);
    check('R5: response carries the device reading (84, MANUAL)',
        r5.body && r5.body.reading && r5.body.reading.heartRate === 84 && r5.body.reading.readingType === 'MANUAL',
        JSON.stringify(r5.body));
    check('R5: joined-request semantics report pending=false for a fresh request',
        r5.body.pending === false && r5.body.requestId === requestId,
        JSON.stringify(r5.body));

    // R6 — a NORMAL reading must not create an alert event.
    await currentServerModule.persistenceIdle();
    const eventsAfterNormal = await httpJson('GET', `/api/events?blindUserId=${devA.blindUserId}`, undefined, authHeaders(cookie));
    const normalBody = Array.isArray(eventsAfterNormal.body) ? eventsAfterNormal.body : [];
    const heartRateEventsNormal = normalBody.filter((e) => e.trigger === 'HEART_RATE');
    check('R6: normal reading creates no alert event',
        eventsAfterNormal.status === 200 && heartRateEventsNormal.length === 0,
        JSON.stringify(normalBody));

    // R7 — an ABNORMAL reading (via MQTT telemetry) still creates an alert
    // event (unchanged behavior) AND drives the monitoring engine to
    // HIGH_FREQUENCY.
    await currentServerModule.handleMqttMessage(TOPICS.SENSOR_HEART, {
        deviceId: devA.identifier,
        heartRate: 108,
        timestamp: isoAt(Date.now())
    });
    await currentServerModule.persistenceIdle();
    const eventsAfterAbnormal = await httpJson('GET', `/api/events?blindUserId=${devA.blindUserId}`, undefined, authHeaders(cookie));
    const abnormalBody = Array.isArray(eventsAfterAbnormal.body) ? eventsAfterAbnormal.body
        : (eventsAfterAbnormal.body && Array.isArray(eventsAfterAbnormal.body.events)) ? eventsAfterAbnormal.body.events : [];
    const abnormalEvents = abnormalBody.filter((e) => e.trigger === 'HEART_RATE');
    check('R7: abnormal reading creates an alert event as before',
        eventsAfterAbnormal.status === 200 && abnormalEvents.length === 1,
        JSON.stringify(abnormalBody));

    const stateAfterAbnormal = currentServerModule.heartRateMonitor.getState(devA.identifier);
    check('R7: abnormal reading switches the device to HIGH_FREQUENCY',
        stateAfterAbnormal && stateAfterAbnormal.monitoringMode === 'HIGH_FREQUENCY' && stateAfterAbnormal.consecutiveNormalReadings === 0,
        JSON.stringify(stateAfterAbnormal));

    // R8 — GET state: exposes the monitored fields.
    const getState = await httpJson('GET', `/api/caretaker/devices/${devA.id}/heart-rate`, undefined, authHeaders(cookie));
    assertStatus('R8: GET heart-rate is 200', getState.status, 200);
    check('R8: GET state exposes last reading + monitoring mode',
        getState.body.heartRate === 108 && getState.body.classification === 'HIGH'
        && getState.body.monitoringMode === 'HIGH_FREQUENCY',
        JSON.stringify(getState.body));

    // R9 — device-scoped history: every reading, newest-first, own device only.
    const hisA = await httpJson('GET', `/api/caretaker/devices/${devA.id}/heart-rate/history?limit=50`, undefined, authHeaders(cookie));
    assertStatus('R9: history is 200', hisA.status, 200);
    const as = hisA.body.readings || [];
    const newest = as[0];
    const manual84 = as.find((r) => r.heartRate === 84);
    check('R9: history contains both readings, newest first',
        as.length >= 2 && newest.heartRate === 108 && newest.classification === 'HIGH' && manual84 && manual84.readingType === 'MANUAL',
        JSON.stringify(as));
    check('R9: every history row belongs to the requested device',
        as.length > 0 && as.every((r) => r.deviceId === devA.identifier),
        JSON.stringify(as));

    // Different device never appears in A's history, even with a reading on it.
    currentServerModule.handleMqttMessage(TOPICS.SENSOR_HEART, {
        deviceId: devB.identifier,
        heartRate: 90,
        timestamp: isoAt(Date.now())
    });
    await currentServerModule.persistenceIdle();
    const hisB = await httpJson('GET', `/api/caretaker/devices/${devB.id}/heart-rate/history?limit=50`, undefined, authHeaders(cookie));
    check('R9: other device history is disjoint (B has exactly its own 90)',
        (hisB.body.readings || []).length === 1 && hisB.body.readings[0].heartRate === 90,
        JSON.stringify(hisB.body));
    const hisAAgain = await httpJson('GET', `/api/caretaker/devices/${devA.id}/heart-rate/history?limit=50`, undefined, authHeaders(cookie));
    check('R9: A history never contains B readings',
        (hisAAgain.body.readings || []).every((r) => r.deviceId === devA.identifier && r.heartRate !== 90),
        JSON.stringify(hisAAgain.body));

    // R10 — restart: no stuck pending, persisted history + mode restored.
    await currentServerModule.persistenceIdle();
    await simulateRestart();
    const afterRestart = currentServerModule.heartRateMonitor.getState(devA.identifier);
    check('R10: restart clears every pending request',
        afterRestart && afterRestart.pendingRequestId === null,
        JSON.stringify(afterRestart));
    check('R10: restart restores the persisted last reading + mode',
        afterRestart.lastReading && afterRestart.lastReading.heartRate === 108
        && afterRestart.lastReading.classification === 'HIGH'
        && afterRestart.monitoringMode === 'HIGH_FREQUENCY',
        JSON.stringify(afterRestart));
    check('R10: restart adopts registered devices for auto-monitoring',
        currentServerModule.heartRateMonitor.listDevices().indexOf(devA.identifier) !== -1,
        currentServerModule.heartRateMonitor.listDevices().join(','));
    const hisAfter = await httpJson('GET', `/api/caretaker/devices/${devA.id}/heart-rate/history?limit=50`, undefined, authHeaders(cookie));
    check('R10: history survives restart (from the database)',
        hisAfter.status === 200 && (hisAfter.body.readings || []).some((r) => r.heartRate === 84),
        JSON.stringify(hisAfter.body));
}

// Sends the device response for an in-flight manual request, then awaits it.
async function httpJsonSendResponse(postPromise, mqttPayload) {
    currentServerModule.handleMqttMessage(TOPICS.SENSOR_HEART, mqttPayload);
    return postPromise;
}

// ── Cleanup ──────────────────────────────────────────────────────────────
let latestStatesSnapshot = null;

async function snapshotLatestStates() {
    const res = await query(`SELECT location, device_status, heart_rate, fall, buzzer FROM latest_states WHERE id = 1`);
    latestStatesSnapshot = res.rows.length ? res.rows[0] : null;
}

async function restoreLatestStates() {
    if (latestStatesSnapshot) {
        await query(
            `UPDATE latest_states SET location = $1, device_status = $2, heart_rate = $3, fall = $4, buzzer = $5, updated_at = now()
             WHERE id = 1`,
            [latestStatesSnapshot.location, latestStatesSnapshot.device_status, latestStatesSnapshot.heart_rate, latestStatesSnapshot.fall, latestStatesSnapshot.buzzer]
        );
    } else {
        await query(`DELETE FROM latest_states WHERE id = 1`);
    }
}

async function purgeOwnArtifacts() {
    try {
        await query(`DELETE FROM heart_rate_history WHERE device_identifier LIKE '${PREFIX.toUpperCase()}%'`);
        await query(`DELETE FROM walle_sessions WHERE client_session_id LIKE '${PREFIX}%'`);
        await query(`DELETE FROM events WHERE alert_id LIKE 'HRM-%'`);
        await query(`DELETE FROM events WHERE device_identifier LIKE '${PREFIX.toUpperCase()}%'`);
        await query(`DELETE FROM devices WHERE device_identifier LIKE '${PREFIX.toUpperCase()}%'`);
        await query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
        await query(`DELETE FROM latest_states WHERE id = 1`);
        console.log('[test] purged stale hrm-* artifacts');
    } catch (err) {
        console.warn('[test] initial purge failed (non-fatal):', err.message || err);
    }
}

async function cleanup() {
    try {
        await query(`DELETE FROM heart_rate_history WHERE device_identifier LIKE '${PREFIX.toUpperCase()}%'`);
        await query(`DELETE FROM walle_sessions WHERE client_session_id LIKE '${PREFIX}%'`);
        await query(`DELETE FROM events WHERE alert_id LIKE 'HRM-%'`);
        await query(`DELETE FROM events WHERE device_identifier LIKE '${PREFIX.toUpperCase()}%'`);
        await query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
        await query(`DELETE FROM devices WHERE device_identifier LIKE '${PREFIX.toUpperCase()}%'`);
        await restoreLatestStates();
        console.log('[test] cleaned up hrm users, devices, events, history; latest_states restored');
    } catch (err) {
        console.warn('[test] cleanup failed (non-fatal):', err.message || err);
    }
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
        console.error('[test] FATAL: DATABASE_URL is not configured. heart-rate monitor tests need the local blindguardian database.');
        process.exit(1);
    }

    console.log('[test] heart-rate monitor harness starting (deterministic engine + real server)…');

    await purgeOwnArtifacts();
    await snapshotLatestStates();
    try {
        await currentServerModule.bootRehydrateFromDatabase();
        await startHttp();

        const a = await seedBlindWithDevice('ALPHA');
        const b = await seedBlindWithDevice('BRAVO');
        const c = await seedBlindWithDevice('GAMMA');
        const caretaker = await seedCaretaker();
        await linkCaretaker(caretaker.id, a.blindUserId);
        await linkCaretaker(caretaker.id, b.blindUserId);
        // c is deliberately NOT linked — R4 verifies it stays invisible.
        const caretakerCookie = await loginCaretakerCookie();
        check('fixture caretaker cookie captured', Boolean(caretakerCookie));

        await exerciseEngine();
        await exerciseREST({ a: { device: a }, b: { device: b }, c: { device: c }, caretakerCookie });
    } finally {
        await startHttp();
        await cleanup();
        if (getPool().end) { try { await getPool().end(); } catch (_e) { /* ignore */ } }
    }

    const failed = RESULTS.filter((r) => !r.pass);
    console.log('');
    for (const r of RESULTS) {
        const mark = r.pass ? 'PASS' : 'FAIL';
        console.log(`  [${mark}] ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
    }
    console.log('');
    console.log(`[test] ${RESULTS.length - failed.length}/${RESULTS.length} checks passed`);

    if (failed.length > 0) {
        console.error(`[test] ${failed.length} check(s) failed.`);
        process.exit(1);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error('[test] FATAL:', err.stack || err.message || err);
    process.exit(1);
});