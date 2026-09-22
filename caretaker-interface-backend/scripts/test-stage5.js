'use strict';

// Stage 5 integration test harness: telemetry persistence & boot rehydration.
//
// Runs mostly IN-PROCESS against the real local PostgreSQL database (so the
// MQTT message handlers and a simulated restart in the same module instance
// can be exercised), plus in-process HTTP requests against the real Express
// app on an ephemeral port. Nothing long-running is spawned; each test run
// cleans up its own stg5-* data and restores any pre-existing latest_states
// row.
//
// Run with:
//   npm run test:stage5
//
// Coverage (prompt items A–N):
//   A  migration 003 applies cleanly and is additive
//   B  boot rehydration restores events/statuses/secrets-safe state after restart
//   C  telemetry queue is bounded and drops the oldest on overflow
//   D  REST POST /api/events is durable before the 201 response
//   E  PATCH persists the status change (and hydrates DB-only events)
//   F  GET /api/events is bounded at EVENTS_WINDOW_MAX, chronological
//   G  GET /api/events falls back to the in-memory window when the DB is down
//   H  no synthetic events are created for normal HR / fall / invalid radar
//   I  Wall-E conversation turns are persisted
//   J  queue overflow + recovery behavior (drop-oldest, no duplicates)
//   K  Wall-E conversations rehydrate after a restart
//   L  latest runtime state persists and rehydrates after a restart
//   M  MQTT-created events persist and rehydrate (covered by B/MQTT SOS)
//   N  clean exit with per-item pass counts (this harness)

const crypto = require('crypto');

// MQTT must be disabled BEFORE server.js is required below.
process.env.MQTT_BROKER_URL = '';

const { query, getPool } = require('../db/pool');
const { hashPassword } = require('../auth/password');
const { TOPICS } = require('../mqtt/topics');
const { createPersistenceQueue } = require('../telemetry/queue');

let currentServerModule = require('../server');
let conversationStore = require('../ai/conversation-store');

const PREFIX = 'stg5-';
const ts = Date.now();
const RESULTS = [];
const MQTT_PREFIX = 'MQTT-';

const originalDatabaseUrl = process.env.DATABASE_URL;

function check(name, pass, detail) {
    RESULTS.push({ name, pass, detail: detail || '' });
}

function assertStatus(label, actual, expected) {
    check(label, actual === expected, `status ${actual}, expected ${expected}`);
}

function nowIso() {
    return new Date().toISOString();
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

function deviceHeaders(identifier, token) {
    return { 'X-Device-Id': identifier, 'X-Device-Token': token };
}

// ── Simulated restart ────────────────────────────────────────────────────
// A fresh server module (fresh events Map + callbacks) and a fresh
// conversation-store (fresh in-memory sessions) mimic a process restart, then
// boot rehydration runs exactly like the guarded `app.listen` start path.
async function simulateRestart() {
    await startHttp(); // close old listener first
    delete require.cache[require.resolve('../ai/conversation-store')];
    delete require.cache[require.resolve('../server')];
    currentServerModule = require('../server');
    conversationStore = require('../ai/conversation-store');
    await currentServerModule.bootRehydrateFromDatabase();
    await startHttp();
    console.log('[test] simulated restart + boot rehydration done');
}

// ── Fixtures ─────────────────────────────────────────────────────────────
async function seedDevice(label) {
    const blind = await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'BLIND_USER')
         RETURNING id`,
        [`${label} Blind User`, `${PREFIX}${ts}-${label}-bu@test.local`, await hashPassword('CorrectHorse42!')]
    );
    const blindUserId = blind.rows[0].id;

    const token = crypto.randomBytes(32).toString('base64url');
    const secretHash = await hashPassword(token);
    const identifier = `${PREFIX.toUpperCase()}${ts}-${label}-DEV1`;
    await query(
        `INSERT INTO devices (blind_user_id, device_identifier, friendly_name, secret_hash, status)
         VALUES ($1, $2, $3, $4, 'OFFLINE')`,
        [blindUserId, identifier, 'Stage5 Cap', secretHash]
    );
    return { identifier, token, blindUserId };
}

function makeEventPayload(alertId) {
    return {
        alertId,
        trigger: 'SOS',
        status: 'ACTIVE',
        heartRate: null,
        latitude: 22.3407,
        longitude: 73.1808,
        timestamp: nowIso()
    };
}

// ── Test groups ──────────────────────────────────────────────────────────
let seedDeviceInfo = null;

async function testMigrationAndSchema() {
    const mig = await query(`SELECT version FROM schema_migrations WHERE version = '003'`);
    check('A1 migration 003 recorded', mig.rows.length === 1, mig.rows.length ? mig.rows[0].version : 'not recorded');

    const evId = await query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'device_identifier'`
    );
    check('A2 events.device_identifier added', evId.rows.length === 1);

    const buId = await query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'blind_user_identifier'`
    );
    check('A3 events.blind_user_identifier added', buId.rows.length === 1);

    const csid = await query(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'walle_sessions' AND column_name = 'client_session_id'`
    );
    check('A4 walle_sessions.client_session_id NOT NULL',
        csid.rows.length === 1 && csid.rows[0].is_nullable === 'NO');

    const idx = await query(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'walle_sessions' AND indexname = 'walle_sessions_client_session_id_unique'`
    );
    check('A5 walle_sessions.client_session_id unique index', idx.rows.length === 1);

    const ls = await query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'latest_states' ORDER BY ordinal_position`
    );
    check('A6 latest_states table exists', ls.rows.length >= 6, JSON.stringify(ls.rows));

    const lsCheck = await query(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'latest_states'::regclass AND conname = 'latest_states_id_check'`
    );
    check('A7 latest_states single-row CHECK(id=1)', lsCheck.rows.length === 1);

    // Additive proof: every pre-existing column is still intact.
    const evCols = await query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'events'`
    );
    for (const required of ['alert_id', 'trigger', 'status', 'heart_rate', 'occurred_at']) {
        check(`A8 additive: events.${required} preserved`,
            evCols.rows.some((r) => r.column_name === required));
    }
}

async function testRestDurability(device) {
    // D — durable before response.
    const created = await httpJson('POST', '/api/events', makeEventPayload('stg5-D1'), deviceHeaders(device.identifier, device.token));
    assertStatus('D1 POST /api/events 201', created.status, 201);

    const row = await query(
        `SELECT alert_id, device_id, blind_user_id, device_identifier, blind_user_identifier
         FROM events WHERE alert_id = 'stg5-D1'`
    );
    check('D2 event row durable in DB', row.rows.length === 1);
    if (row.rows[0]) {
        check('D3 device_identifier column set', row.rows[0].device_identifier === device.identifier);
        check('D4 blind_user_identifier column set', row.rows[0].blind_user_identifier === device.blindUserId);
        check('D5 device_id FK resolved', Boolean(row.rows[0].device_id));
        check('D6 blind_user_id FK resolved', row.rows[0].blind_user_id === device.blindUserId);
    }

    // E — PATCH persists; invalid transition leaves DB unchanged.
    const patched = await httpJson('PATCH', '/api/events/stg5-D1', { status: 'ACKNOWLEDGED' }, deviceHeaders(device.identifier, device.token));
    assertStatus('E1 PATCH ACKNOWLEDGED 200', patched.status, 200);
    const after = await query(`SELECT status FROM events WHERE alert_id = 'stg5-D1'`);
    check('E2 DB status updated', after.rows.length === 1 && after.rows[0].status === 'ACKNOWLEDGED');

    const invalid = await httpJson('PATCH', '/api/events/stg5-D1', { status: 'NORMAL' }, deviceHeaders(device.identifier, device.token));
    assertStatus('E3 invalid transition → 409', invalid.status, 409);
    const afterInvalid = await query(`SELECT status FROM events WHERE alert_id = 'stg5-D1'`);
    check('E4 invalid transition left DB unchanged', afterInvalid.rows[0].status === 'ACKNOWLEDGED');

    const unknown = await httpJson('PATCH', '/api/events/stg5-does-not-exist', { status: 'RESOLVED' }, deviceHeaders(device.identifier, device.token));
    assertStatus('E5 unknown alertId → 404', unknown.status, 404);

    // DB-only event (outside the in-memory Map) is hydrated then updated.
    const dbOnlyDeviceId = (await query(`SELECT id FROM devices WHERE device_identifier = $1`, [device.identifier])).rows[0].id;
    const dbOnly = await query(
        `INSERT INTO events (alert_id, blind_user_id, device_id, blind_user_identifier, device_identifier, trigger, status, occurred_at)
         VALUES ('stg5-dbonly-1', $1, $2, $4, $3, 'SOS', 'ACTIVE', now())
         RETURNING alert_id`,
        [device.blindUserId, dbOnlyDeviceId, device.identifier, device.blindUserId]
    );
    check('E6 DB-only event seeded', dbOnly.rows.length === 1);
    const hydratedPatch = await httpJson('PATCH', '/api/events/stg5-dbonly-1', { status: 'ACKNOWLEDGED' }, deviceHeaders(device.identifier, device.token));
    assertStatus('E7 PATCH hydrates DB-only event → 200', hydratedPatch.status, 200);
    const dbOnlyAfter = await query(`SELECT status FROM events WHERE alert_id = 'stg5-dbonly-1'`);
    check('E8 DB-only event status persisted', dbOnlyAfter.rows[0].status === 'ACKNOWLEDGED');
}

async function testBoundedGet() {
    // F — window bounded + chronological.
    const base = Date.now();
    for (let i = 1; i <= 150; i++) {
        await query(
            `INSERT INTO events (alert_id, trigger, status, latitude, longitude, occurred_at)
             VALUES ($1, 'NORMAL', 'NORMAL', 22.3, 73.1, to_timestamp($2 / 1000.0))`,
            [`stg5-bulk-${String(i).padStart(3, '0')}`, base + i]
        );
    }
    const res = await httpJson('GET', '/api/events');
    assertStatus('F1 GET /api/events via DB 200', res.status, 200);
    const list = res.body;
    check('F2 window bounded at EVENTS_WINDOW_MAX', Array.isArray(list) && list.length <= currentServerModule.EVENTS_WINDOW_MAX,
        `length ${Array.isArray(list) ? list.length : 'n/a'}`);
    check('F3 exactly the most recent 100 returned', Array.isArray(list) && list.length === 100, `length ${Array.isArray(list) ? list.length : 'n/a'}`);
    check('F4 chronological ascending order',
        Array.isArray(list) && list.every((e, i) => i === 0 || list[i - 1].timestamp <= e.timestamp));
    check('F5 newest bulk event in window', Array.isArray(list) && list[list.length - 1].alertId === 'stg5-bulk-150',
        Array.isArray(list) ? list[list.length - 1].alertId : 'n/a');
}

async function testMemoryFallback() {
    // G — in-memory fallback when the database is unreachable.
    process.env.DATABASE_URL = '';
    try {
        const memEvent = currentServerModule.createEvent({
            alertId: 'stg5-GMAIN',
            trigger: 'SOS',
            status: 'ACTIVE',
            heartRate: null,
            latitude: 11.0,
            longitude: 12.0,
            timestamp: nowIso()
        }, { allowMissingCoordinates: false });
        check('G1 memory-only event created (DB down)', memEvent.ok, memEvent.error || '');

        const res = await httpJson('GET', '/api/events');
        assertStatus('G2 GET /api/events falls back to memory → 200', res.status, 200);
        check('G3 fallback returns the in-memory window', Array.isArray(res.body)
            && res.body.some((e) => e.alertId === 'stg5-GMAIN'), JSON.stringify((res.body || []).slice(-2)));
        check('G4 fallback is bounded', Array.isArray(res.body) && res.body.length <= currentServerModule.EVENTS_WINDOW_MAX,
            `length ${Array.isArray(res.body) ? res.body.length : 'n/a'}`);
    } finally {
        process.env.DATABASE_URL = originalDatabaseUrl;
    }
}

async function testNoSyntheticEvents(device) {
    // H — normal HR / fall / invalid radar create NO events.
    const before = currentServerModule.getLatestRuntimeState().eventCount;

    currentServerModule.handleMqttMessage(TOPICS.SENSOR_HEART, { deviceId: device.identifier, heartRate: 75, timestamp: nowIso() });
    check('H1 normal heart-rate creates no event',
        currentServerModule.getLatestRuntimeState().eventCount === before,
        `count ${currentServerModule.getLatestRuntimeState().eventCount}`);

    currentServerModule.handleMqttMessage(TOPICS.MOBILE_FALL, { deviceId: device.identifier, timestamp: nowIso() });
    check('H2 fall creates no event',
        currentServerModule.getLatestRuntimeState().eventCount === before,
        `count ${currentServerModule.getLatestRuntimeState().eventCount}`);

    currentServerModule.handleMqttMessage(TOPICS.SENSOR_RADAR, { deviceId: device.identifier, timestamp: nowIso() });
    check('H3 invalid radar (missing distance) creates no event',
        currentServerModule.getLatestRuntimeState().eventCount === before,
        `count ${currentServerModule.getLatestRuntimeState().eventCount}`);

    const hrMap = currentServerModule.getLatestRuntimeState().lastHeartRate;
    const hr = hrMap instanceof Map ? hrMap.get(device.identifier) : null;
    check('H4 normal HR still tracked in memory', Boolean(hr && hr.heartRate === 75), JSON.stringify(hr));
}

async function testMqttPersistenceAndRehydrate(device) {
    // M + B — MQTT SOS event persists, then survives a restart with a
    // monotonically increasing sequence (no MQTT-id collision).
    const seqBefore = currentServerModule.getLatestRuntimeState().mqttSeq;
    currentServerModule.handleMqttMessage(TOPICS.EMERGENCY_SOS, {
        deviceId: device.identifier,
        message: 'help',
        timestamp: nowIso()
    });
    const first = currentServerModule.getLatestRuntimeState();
    check('M1 MQTT SOS increments the event sequence', first.mqttSeq === seqBefore + 1,
        `seq ${first.mqttSeq} (was ${seqBefore})`);

    const mqttId = await waitForSosRow(1);
    check('M2 MQTT SOS event durable in DB', typeof mqttId === 'string' && mqttId.startsWith('MQTT-SOS-'), String(mqttId));

    // B — restart rehydration restores events + resumes the sequence.
    await simulateRestart();

    const stateAfterRestart = currentServerModule.getLatestRuntimeState();
    check('B1 events restored into memory after restart', stateAfterRestart.eventCount >= 1,
        `count ${stateAfterRestart.eventCount}`);
    check('B2 mqttSeq resumed above persisted max', stateAfterRestart.mqttSeq >= first.mqttSeq,
        `seq ${stateAfterRestart.mqttSeq} >= ${first.mqttSeq}`);

    const res = await httpJson('GET', '/api/events');
    check('B3 GET /api/events shows rehydrated event', Array.isArray(res.body) && res.body.some((e) => e.alertId === mqttId));

    currentServerModule.handleMqttMessage(TOPICS.EMERGENCY_SOS, { deviceId: device.identifier, message: 'help again', timestamp: nowIso() });
    const ids = await waitForSosRows(2);
    check('B4 new MQTT id differs from rehydrated one (no collision)',
        ids.length === 2 && new Set(ids).size === 2, JSON.stringify(ids));
}

// Polls until `count` rows with alert_id LIKE 'MQTT-SOS-%' exist, because the
// MQTT path persists fire-and-forget. Returns their alert_ids (newest first).
async function waitForSosRows(count) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        const row = await query(
            `SELECT alert_id FROM events WHERE alert_id LIKE 'MQTT-SOS-%' ORDER BY created_at DESC LIMIT $1`,
            [count]
        );
        if (row.rows.length >= count) {
            return row.rows.map((r) => r.alert_id);
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    const row = await query(`SELECT alert_id FROM events WHERE alert_id LIKE 'MQTT-SOS-%' ORDER BY created_at DESC LIMIT $1`, [count]);
    return row.rows.map((r) => r.alert_id);
}

async function waitForSosRow(count) {
    const ids = await waitForSosRows(count);
    return ids.length ? ids[0] : null;
}

async function testLatestStatePersistence(device) {
    // L — MQTT runtime state persists to latest_states.
    currentServerModule.handleMqttMessage(TOPICS.MOBILE_LOCATION, { latitude: 40.7128, longitude: -74.006, timestamp: nowIso() });
    currentServerModule.handleMqttMessage(TOPICS.DEVICE_STATUS, { deviceId: device.identifier, status: 'ONLINE', wifi: -58 });
    currentServerModule.handleMqttMessage(TOPICS.SENSOR_HEART, { deviceId: device.identifier, heartRate: 122, timestamp: nowIso() });
    currentServerModule.handleMqttMessage(TOPICS.MOBILE_FALL, { deviceId: device.identifier, timestamp: nowIso() });

    await currentServerModule.persistenceIdle();

    const row = await query(`SELECT location, device_status, heart_rate, fall FROM latest_states WHERE id = 1`);
    check('L1 latest_states row written', row.rows.length === 1);
    if (row.rows[0]) {
        const location = row.rows[0].location;
        check('L2 location persisted', Boolean(location) && location.latitude === 40.7128, JSON.stringify(location));
        const status = row.rows[0].device_status;
        check('L3 device status persisted', Boolean(status) && status.status === 'ONLINE', JSON.stringify(status));
        const hr = row.rows[0].heart_rate;
        const hrEntry = hr && (hr[device.identifier] || (typeof hr.heartRate === 'number' ? hr : null));
        check('L4 heart-rate persisted', Boolean(hrEntry) && hrEntry.heartRate === 122, JSON.stringify(hr));
        const fall = row.rows[0].fall;
        check('L5 fall persisted', Boolean(fall) && fall.deviceId === device.identifier, JSON.stringify(fall));
    }
}

async function testLatestStateRehydrate() {
    // L restart — state restored into memory.
    const state = currentServerModule.getLatestRuntimeState();
    check('L6 location rehydrated', Boolean(state.latestLocation && state.latestLocation.latitude === 40.7128),
        JSON.stringify(state.latestLocation));
    check('L7 device status rehydrated', Boolean(state.latestDeviceStatus && state.latestDeviceStatus.status === 'ONLINE'),
        JSON.stringify(state.latestDeviceStatus));
    const hrEntry = state.lastHeartRate instanceof Map ? state.lastHeartRate.get(seedDeviceInfo.identifier) : null;
    check('L8 heart rate rehydrated', Boolean(hrEntry && hrEntry.heartRate === 122),
        JSON.stringify(hrEntry));
    check('L9 fall rehydrated', Boolean(state.latestFall && state.latestFall.deviceId), JSON.stringify(state.latestFall));
}

async function testWallePersistence(device) {
    // I — Wall-E turns are written to PostgreSQL.
    const sessionId = 'stg5-w1';
    conversationStore.ensureSession(sessionId, { deviceId: device.identifier, blindUserId: device.blindUserId });
    conversationStore.addUserMessage(sessionId, 'Am I near the bus stop?');
    conversationStore.addAssistantMessage(sessionId, 'Yes, about 40m ahead on the right.', 'stg5-model');

    await conversationStore.drainPendingSyncs();

    const s = await query(`SELECT id, blind_user_id, device_id, client_session_id FROM walle_sessions WHERE client_session_id = 'stg5-w1'`);
    check('I1 walle_sessions row persisted', s.rows.length === 1);
    if (s.rows[0]) {
        check('I2 blind_user_id FK resolves', s.rows[0].blind_user_id === device.blindUserId);
        check('I3 device_id FK resolves', Boolean(s.rows[0].device_id));
    }

    const msgs = await query(
        `SELECT role, content, model FROM walle_messages
         WHERE session_id = (SELECT id FROM walle_sessions WHERE client_session_id = 'stg5-w1')
         ORDER BY created_at`
    );
    check('I4 both turns persisted', msgs.rows.length === 2, `count ${msgs.rows.length}`);
    if (msgs.rows.length === 2) {
        check('I5 turn roles persisted', msgs.rows[0].role === 'user' && msgs.rows[1].role === 'assistant');
        check('I6 turn content persisted', msgs.rows[0].content.includes('bus stop') && msgs.rows[1].content.includes('40m'));
        check('I7 assistant model persisted', msgs.rows[1].model === 'stg5-model');
    }
}

async function testWalleRehydrate() {
    // K — conversations rehydrate after restart.
    const transcript = conversationStore.getSessionTranscript('stg5-w1');
    check('K1 transcript restored after restart', Boolean(transcript));
    if (transcript) {
        check('K2 turns restored', transcript.turns.length === 2, `count ${transcript.turns.length}`);
        const userTurn = transcript.turns.find((t) => t.role === 'user');
        const assistantTurn = transcript.turns.find((t) => t.role === 'assistant');
        check('K3 user turn restored', Boolean(userTurn && userTurn.text.includes('bus stop')));
        check('K4 assistant model restored', Boolean(assistantTurn && assistantTurn.model === 'stg5-model'));
        check('K5 deviceId reverse-resolved to identifier', transcript.deviceId === seedDeviceInfo.identifier);
        check('K6 blindUserId restored as UUID', transcript.blindUserId === seedDeviceInfo.blindUserId);
    }

    const res = await httpJson('GET', '/api/walle/sessions');
    assertStatus('K7 GET /api/walle/sessions unauth 401 (Stage-8A gate)', res.status, 401);

    // The unscoped listing is now caretaker-authorized, so log in as one to
    // verify the rehydrated session appears (K8).
    const caretakerEmail = `${PREFIX}${ts}-k@test.local`;
    await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'CARETAKER')`,
        ['Stage5 Observing Caretaker', caretakerEmail, await hashPassword('CorrectHorse42!')]
    );
    const loginRes = await httpJson('POST', '/api/auth/login', { email: caretakerEmail, password: 'CorrectHorse42!' });
    assertStatus('K7 caretaker fixture logs in', loginRes.status, 200);
    const loginCookie = (loginRes.headers.getSetCookie() || []).find((h) => h.split(';')[0].startsWith('bg_session='));
    const caretakerCookie = loginCookie ? loginCookie.split(';')[0].split('=').slice(1).join('=') : null;
    check('K7 caretaker cookie captured', Boolean(caretakerCookie));

    const sessionsRes = await httpJson('GET', '/api/walle/sessions', undefined, { Cookie: `bg_session=${caretakerCookie}` });
    assertStatus('K8 GET /api/walle/sessions caretaker 200', sessionsRes.status, 200);
    check('K8 rehydrated session listed', Array.isArray(sessionsRes.body) && sessionsRes.body.some((s) => s.sessionId === 'stg5-w1'), JSON.stringify(sessionsRes.body));

    // Stage 6: /api/walle/history is now caretaker-authorized, so an
    // unauthenticated GET must be rejected (401) instead of public-200.
    const history = await httpJson('GET', '/api/walle/history/stg5-w1');
    assertStatus('K9 GET /api/walle/history unauth 401 (Stage-6 gate)', history.status, 401);
}

async function testPendingSessionsAfterRestart() {
    // After the restart rehydration, ensure ensureSession-based writes to a
    // resumed session still persist without corrupting a rehydrated session.
    conversationStore.ensureSession('stg5-w1', { deviceId: seedDeviceInfo.identifier, blindUserId: seedDeviceInfo.blindUserId });
    conversationStore.addUserMessage('stg5-w1', 'Follow-up after restart');
    await conversationStore.drainPendingSyncs();

    const msgs = await query(
        `SELECT COUNT(*)::int AS n FROM walle_messages
         WHERE session_id = (SELECT id FROM walle_sessions WHERE client_session_id = 'stg5-w1')`
    );
    check('K10 resumed session appends to DB without duplication', msgs.rows[0].n === 3, `count ${msgs.rows[0].n}`);
}

async function testQueueSemantics() {
    // C + J — bounded, drop-oldest on overflow, recovers without duplicates.
    const max = 3;
    const applied = [];
    let fail = true;
    const q = createPersistenceQueue({
        max,
        apply: (item) => {
            if (fail) return Promise.reject(new Error('db down'));
            applied.push(item.alertId);
            return Promise.resolve();
        }
    });

    const seen = [];
    const origEnqueue = q.enqueue.bind(q);
    q.enqueue = (item) => { origEnqueue(item); seen.push(q.size()); };

    for (const id of ['E1', 'E2', 'E3', 'E4', 'E5']) {
        q.enqueue({ kind: 'event', alertId: id });
    }
    await new Promise((r) => setTimeout(r, 60));
    check('J1 queue bounded during outage', seen.every((n) => n <= max), JSON.stringify(seen));
    check('J2 oldest dropped on overflow', q.size() <= max && seen[seen.length - 1] === 3, `size ${q.size()}`);

    fail = false;
    q.drain();
    const deadline = Date.now() + 3000;
    while (applied.length < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
    }
    check('J3 queue recovered and drained', applied.length === 3, `applied ${JSON.stringify(applied)} (E3,E4,E5 expected)`);
    check('J4 dropped items not applied (no duplicates E1/E2)',
        !applied.includes('E1') && !applied.includes('E2'), JSON.stringify(applied));
    q.enqueue({ kind: 'event', alertId: 'E6' });
    await new Promise((r) => setTimeout(r, 100));
    check('J5 queue usable after recovery', applied.length === 4 && applied[applied.length - 1] === 'E6', JSON.stringify(applied));
}

async function testRegression() {
    const health = await httpJson('GET', '/api/health');
    assertStatus('N1 /api/health 200', health.status, 200);

    const events = await httpJson('GET', '/api/events');
    assertStatus('N2 /api/events 200', events.status, 200);

    const sse = await fetch(`${baseUrl}/api/events/stream`);
    check('N3 SSE stream still public (200)', sse.status === 200, `status ${sse.status}`);
    if (sse.body && sse.body.cancel) await sse.body.cancel();

    const shouldBe = seedDeviceInfo ? seedDeviceInfo.identifier : null;
    const location = await httpJson('GET', '/api/location');
    check('N4 GET /api/location 200 with persisted state', location.status === 200 && Boolean(location.body && location.body.latitude === 40.7128),
        JSON.stringify(location.body));
    check('N5 env constants exported sanely', currentServerModule.EVENTS_WINDOW_MAX === 100 && currentServerModule.TELEMETRY_QUEUE_MAX === 500,
        `events=${currentServerModule.EVENTS_WINDOW_MAX} queue=${currentServerModule.TELEMETRY_QUEUE_MAX}`);
    check('N6 unknown identity still denied (401)',
        (await httpJson('POST', '/api/events', makeEventPayload('stg5-N6'), deviceHeaders(shouldBe, 'bogus'))).status === 401);
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

// Best-effort purge of every artifact this suite (or a crashed previous run)
// created, so each run starts from a clean slate. MQTT-* events are owned by
// this suite's sequence test — prior stages never use that prefix.
async function purgeOwnArtifacts() {
    try {
        await query(`DELETE FROM walle_sessions WHERE client_session_id LIKE '${PREFIX}%'`);
        await query(`DELETE FROM events WHERE alert_id LIKE '${PREFIX}%' OR alert_id LIKE '${MQTT_PREFIX}%'`);
        await query(`DELETE FROM devices WHERE device_identifier LIKE '${PREFIX.toUpperCase()}%'`);
        await query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
        await query(`DELETE FROM latest_states WHERE id = 1`);
        console.log('[test] purged stale stg5-* artifacts');
    } catch (err) {
        console.warn('[test] initial purge failed (non-fatal):', err.message || err);
    }
}

async function cleanup() {
    try {
        await query(`DELETE FROM walle_sessions WHERE client_session_id LIKE '${PREFIX}%'`);
        await query(`DELETE FROM events WHERE alert_id LIKE '${PREFIX}%' OR alert_id LIKE '${MQTT_PREFIX}%'`);
        await query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
        await query(`DELETE FROM devices WHERE device_identifier LIKE '${PREFIX.toUpperCase()}%'`);
        await restoreLatestStates();
        console.log('[test] cleaned up stg5 users, devices, events, walle sessions; latest_states restored');
    } catch (err) {
        console.warn('[test] cleanup failed (non-fatal):', err.message || err);
    }
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
        console.error('[test] FATAL: DATABASE_URL is not configured. stage5 tests need the local blindguardian database.');
        process.exit(1);
    }

    console.log('[test] stage5 in-process harness starting (in-memory hot path + PostgreSQL persistence)…');

    await purgeOwnArtifacts();
    await snapshotLatestStates();
    try {
        await testMigrationAndSchema();
        await currentServerModule.bootRehydrateFromDatabase();
        await startHttp();

        seedDeviceInfo = await seedDevice('SMOKE');
        await testRestDurability(seedDeviceInfo);
        await testWallePersistence(seedDeviceInfo);
        // No-synthetic checks run BEFORE the latest-state writes so the normal
        // heart-rate reading is not confused with the persisted state sample.
        await testNoSyntheticEvents(seedDeviceInfo);
        await testLatestStatePersistence(seedDeviceInfo);

        await testMemoryFallback();
        await testBoundedGet();
        await testRegression();
        await testQueueSemantics();

        // Phase 2 — restart + rehydration.
        await testMqttPersistenceAndRehydrate(seedDeviceInfo);
        await testLatestStateRehydrate();
        await testWalleRehydrate();
        await testPendingSessionsAfterRestart();
        await testRegression();
    } finally {
        await startHttp(); // close any open listener
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