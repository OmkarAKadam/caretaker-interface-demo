'use strict';

// Focused integration test: heart-rate runtime state is per-device and
// timestamp-ordered, so an out-of-order MQTT/demo reading can never overwrite
// a fresher one (the Wall-E "72 BPM overwrote 142 BPM" incident).
//
// Runs mostly in-process against the real local PostgreSQL database, like
// test-stage5. Each run purges its own hrs-* artifacts and restores any
// pre-existing latest_states row.
//
// Run with:
//   npm run test:hrstate
//
// Coverage (prompt items A–F):
//   A  a normal bg02 reading (72) is tracked for bg02
//   B  a NEWER simulated reading (142) for bg02 becomes the trusted value
//   C  a later-arriving but OLDER reading (72, timestamp before 142) cannot
//      overwrite the newer 142
//   C2 equal-timestamp readings never flip the stored value
//   C3 a genuinely newer normal reading still updates state (behavior kept)
//   D  a reading for a different device (bg01) cannot affect bg02
//   D2 the device-authored POST /api/events fold is guarded the same way
//   E  restart rehydration preserves the latest per-device value
//   F  Wall-E trusted context for bg02 shows the fresh value, bg01's never does

const crypto = require('crypto');

// MQTT must be disabled BEFORE server.js is required below.
process.env.MQTT_BROKER_URL = '';

const { query, getPool } = require('../db/pool');
const { hashPassword } = require('../auth/password');
const { TOPICS } = require('../mqtt/topics');
const { buildTrustedContext } = require('../ai/context-builder');

let currentServerModule = require('../server');

const PREFIX = 'hrs-';
const ts = Date.now();
const RESULTS = [];

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

function deviceHeaders(identifier, token) {
    return { 'X-Device-Id': identifier, 'X-Device-Token': token };
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

// ── Fixtures ─────────────────────────────────────────────────────────────
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
        [blindUserId, identifier, `HR State ${label}`, secretHash]
    );
    return { id: inserted.rows[0].id, identifier, token, blindUserId };
}

async function seedCaretaker() {
    const caretaker = await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'CARETAKER')
         RETURNING id`,
        ['HR State Caretaker', `${PREFIX}${ts}-caretaker@test.local`, await hashPassword('CorrectHorse42!')]
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

// ── Runtime-state helpers ────────────────────────────────────────────────
function scopedHeartRate(device) {
    const scoped = currentServerModule.scopeRuntimeStateForDevice(
        { identifier: device.identifier, blindUserId: device.blindUserId },
        currentServerModule.getLatestRuntimeState()
    );
    return scoped.lastHeartRate || null;
}

function trustedContextFor(device) {
    const scoped = currentServerModule.scopeRuntimeStateForDevice(
        { identifier: device.identifier, blindUserId: device.blindUserId },
        currentServerModule.getLatestRuntimeState()
    );
    return buildTrustedContext(Object.assign(scoped, { events: new Map() }));
}

// ── The test cases (prompt items A–F) ───────────────────────────────────
async function exercise(state) {
    const devA = state.a.device; // bg02 — the subject of the incident
    const devB = state.b.device; // bg01 — a different device
    const tBase = Date.now();

    // A — a normal bg02 reading (72).
    const t72 = isoAt(tBase + 1000);
    currentServerModule.handleMqttMessage(TOPICS.SENSOR_HEART, { deviceId: devA.identifier, heartRate: 72, timestamp: t72 });
    const a72 = scopedHeartRate(devA);
    check('A: bg02 normal 72 tracked', Boolean(a72 && a72.heartRate === 72), JSON.stringify(a72));

    // B — a NEWER simulated 142 via the caretaker console.
    const t142 = isoAt(tBase + 2000);
    const sim = await httpJson('POST', '/api/caretaker/simulate-event',
        {
            alertId: `HRS-${ts}-simA`,
            deviceId: devA.id,
            trigger: 'HEART_RATE',
            status: 'ACTIVE',
            heartRate: 142,
            latitude: 22.3407,
            longitude: 73.1808,
            timestamp: t142
        },
        { Cookie: `bg_session=${state.caretakerCookie}` });
    assertStatus('B: SIM HEART_RATE 142 accepted', sim.status, 201);
    await currentServerModule.persistenceIdle();
    const a142 = scopedHeartRate(devA);
    check('B: bg02 now reports 142', Boolean(a142 && a142.heartRate === 142), JSON.stringify(a142));

    // C — the OLDER 72 (timestamp before 142) arriving LATE cannot clobber it.
    currentServerModule.handleMqttMessage(TOPICS.SENSOR_HEART, { deviceId: devA.identifier, heartRate: 72, timestamp: t72 });
    const afterLate72 = scopedHeartRate(devA);
    check('C: older 72 arriving late cannot overwrite 142',
        Boolean(afterLate72 && afterLate72.heartRate === 142), JSON.stringify(afterLate72));

    // C2 — an equal-timestamp reading never flips the stored value.
    const tEqual = isoAt(tBase + 2000);
    currentServerModule.handleMqttMessage(TOPICS.SENSOR_HEART, { deviceId: devA.identifier, heartRate: 88, timestamp: tEqual });
    const afterEqual = scopedHeartRate(devA);
    check('C2: equal-timestamp reading keeps 142', Boolean(afterEqual && afterEqual.heartRate === 142), JSON.stringify(afterEqual));

    // C3 — a genuinely NEWER normal reading still updates state.
    const tNewer = isoAt(tBase + 3000);
    currentServerModule.handleMqttMessage(TOPICS.SENSOR_HEART, { deviceId: devA.identifier, heartRate: 80, timestamp: tNewer });
    const afterNewer = scopedHeartRate(devA);
    check('C3: newer normal reading still updates state to 80',
        Boolean(afterNewer && afterNewer.heartRate === 80), JSON.stringify(afterNewer));

    // D — a different device's reading cannot affect bg02.
    const tD = isoAt(tBase + 4000);
    currentServerModule.handleMqttMessage(TOPICS.SENSOR_HEART, { deviceId: devB.identifier, heartRate: 96, timestamp: tD });
    const bD = scopedHeartRate(devB);
    const aAfterD = scopedHeartRate(devA);
    check('D: bg01 reading tracked for bg01 (96)', Boolean(bD && bD.heartRate === 96), JSON.stringify(bD));
    check('D: bg02 untouched by bg01 reading (still 80)',
        Boolean(aAfterD && aAfterD.heartRate === 80), JSON.stringify(aAfterD));

    // D2 — the device-authored POST /api/events fold is guarded the same way.
    const tE = isoAt(tBase + 5000);
    const posted = await httpJson('POST', '/api/events',
        {
            alertId: `HRS-${ts}-devA`,
            trigger: 'SOS',
            status: 'ACTIVE',
            heartRate: 118,
            latitude: 22.3407,
            longitude: 73.1808,
            timestamp: tE
        },
        deviceHeaders(devA.identifier, devA.token));
    assertStatus('D2: POST /api/events with heartRate 201', posted.status, 201);
    await currentServerModule.persistenceIdle();
    const afterPost = scopedHeartRate(devA);
    check('D2: device POST fold updates bg02 to 118',
        Boolean(afterPost && afterPost.heartRate === 118), JSON.stringify(afterPost));

    // Older device-POST fold must be a no-op too.
    const postedOld = await httpJson('POST', '/api/events',
        {
            alertId: `HRS-${ts}-devB`,
            trigger: 'SOS',
            status: 'ACTIVE',
            heartRate: 90,
            latitude: 22.3407,
            longitude: 73.1808,
            timestamp: t72
        },
        deviceHeaders(devA.identifier, devA.token));
    assertStatus('D2b: older POST /api/events accepted (event still created)', postedOld.status, 201);
    const afterOldPost = scopedHeartRate(devA);
    check('D2b: older POST fold cannot revert bg02 below 118',
        Boolean(afterOldPost && afterOldPost.heartRate === 118), JSON.stringify(afterOldPost));

    // E — restart rehydration preserves the latest per-device value.
    await currentServerModule.persistenceIdle();
    await simulateRestart();
    const afterRestart = scopedHeartRate(devA);
    check('E: restart preserves latest per-device value (bg02 = 118)',
        Boolean(afterRestart && afterRestart.heartRate === 118), JSON.stringify(afterRestart));
    const bAfterRestart = scopedHeartRate(devB);
    check('E: restart preserves bg01 value too (96)',
        Boolean(bAfterRestart && bAfterRestart.heartRate === 96), JSON.stringify(bAfterRestart));
    const bg02Late = scopedHeartRate(devA);
    check('E: bg02 does not resurrect the old 72 after restart',
        Boolean(bg02Late && bg02Late.heartRate === 118), JSON.stringify(bg02Late));

    // F — Wall-E trusted context for bg02 shows the fresh value; bg01 never
    // sees bg02's reading (cross-device isolation).
    const ctxA = trustedContextFor(devA);
    check('F: Wall-E context for bg02 shows the heart rate',
        typeof ctxA === 'string' && ctxA.includes('Heart rate: 118 BPM'), ctxA);
    const ctxB = trustedContextFor(devB);
    check('F: Wall-E context for bg01 shows its own heart rate (not bg02 118)',
        typeof ctxB === 'string' && ctxB.includes('Heart rate: 96 BPM') && !ctxB.includes('Heart rate: 118 BPM'), ctxB);
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
        await query(`DELETE FROM walle_sessions WHERE client_session_id LIKE '${PREFIX}%'`);
        await query(`DELETE FROM events WHERE alert_id LIKE 'HRS-%'`);
        await query(`DELETE FROM devices WHERE device_identifier LIKE '${PREFIX.toUpperCase()}%'`);
        await query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
        await query(`DELETE FROM latest_states WHERE id = 1`);
        console.log('[test] purged stale hrs-* artifacts');
    } catch (err) {
        console.warn('[test] initial purge failed (non-fatal):', err.message || err);
    }
}

async function cleanup() {
    try {
        await query(`DELETE FROM walle_sessions WHERE client_session_id LIKE '${PREFIX}%'`);
        await query(`DELETE FROM events WHERE alert_id LIKE 'HRS-%'`);
        await query(`DELETE FROM users WHERE email LIKE '${PREFIX}%'`);
        await query(`DELETE FROM devices WHERE device_identifier LIKE '${PREFIX.toUpperCase()}%'`);
        await restoreLatestStates();
        console.log('[test] cleaned up hrs users, devices, events; latest_states restored');
    } catch (err) {
        console.warn('[test] cleanup failed (non-fatal):', err.message || err);
    }
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
        console.error('[test] FATAL: DATABASE_URL is not configured. hr-state tests need the local blindguardian database.');
        process.exit(1);
    }

    console.log('[test] heart-rate state harness starting (in-memory hot path + PostgreSQL persistence)…');

    await purgeOwnArtifacts();
    await snapshotLatestStates();
    try {
        await currentServerModule.bootRehydrateFromDatabase();
        await startHttp();

        const a = await seedBlindWithDevice('BG02');
        const b = await seedBlindWithDevice('BG01');
        const caretaker = await seedCaretaker();
        await linkCaretaker(caretaker.id, a.blindUserId);
        await linkCaretaker(caretaker.id, b.blindUserId);
        const caretakerCookie = await loginCaretakerCookie();
        check('fixture caretaker cookie captured', Boolean(caretakerCookie));

        await exercise({ a: { device: a }, b: { device: b }, caretakerCookie });
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