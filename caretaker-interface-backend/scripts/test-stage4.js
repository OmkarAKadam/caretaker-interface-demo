'use strict';

// Stage 4 integration test harness: device identity & blind client
// authentication.
//
// Runs the real server (`node server.js`) against the real local PostgreSQL
// database, then exercises device pairing (token issued once), X-Device-Id /
// X-Device-Token authentication on the blind-client REST endpoints, event
// ownership, token rotation, careless-authorized device management and
// caretaker↔blind-user authorization end-to-end over HTTP.
//
// Run with:
//   npm run test:stage4
//
// All test users use the `stg4-` email prefix and are DELETED (with their
// relationships, devices and sessions, via ON DELETE CASCADE) when the run
// finishes.

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { query, getPool } = require('../db/pool');

const BACKEND_DIR = path.resolve(__dirname, '..');
const PORT = Number.parseInt(process.env.STAGE4_TEST_PORT || '3749', 10);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'bg_session';
const PREFIX = 'stg4-';

const ts = Date.now();
const EMAIL_A = `${PREFIX}${ts}-caretaker-a@test.local`;
const EMAIL_B = `${PREFIX}${ts}-caretaker-b@test.local`;
const PASSWORD = 'CorrectHorse42!';
const NAME_A = 'Stage4 Caretaker A';
const NAME_B = 'Stage4 Caretaker B';

const EMAIL_X = `${PREFIX}${ts}-blind-x@test.local`;

let child = null;

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass, detail: detail || '' });
}

function assertStatus(label, actual, expected) {
    check(label, actual === expected, `status ${actual}, expected ${expected}`);
}

async function waitForHealth(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE_URL}/api/health`);
            if (res.status === 200) return true;
        } catch (_err) {
            // server still starting
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    return false;
}

function readCookie(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const header = raw.find((h) => h.startsWith(`${COOKIE_NAME}=`));
    if (!header) return null;
    return { header, value: header.split(';')[0].split('=').slice(1).join('=') };
}

function json(res) {
    return res.status === 204 ? null : res.json();
}

async function getJson(url, headers) {
    const res = await fetch(url, { headers: headers || {} });
    return { status: res.status, body: await json(res), headers: res.headers };
}

async function postJson(url, payload, headers) {
    const res = await fetch(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(payload)
    });
    return { status: res.status, body: await json(res), headers: res.headers };
}

async function patchJson(url, payload, headers) {
    const res = await fetch(url, {
        method: 'PATCH',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(payload)
    });
    return { status: res.status, body: await json(res), headers: res.headers };
}

function cookieHeader(cookie) {
    return { Cookie: `${COOKIE_NAME}=${cookie}` };
}

function authHeaders(cookie) {
    return Object.assign({ Cookie: `${COOKIE_NAME}=${cookie}` }, { 'Content-Type': 'application/json' });
}

function deviceHeaders(identifier, token) {
    return {
        'X-Device-Id': identifier,
        'X-Device-Token': token,
        'Content-Type': 'application/json'
    };
}

function makeEventPayload(alertId) {
    return {
        alertId,
        trigger: 'SOS',
        status: 'ACTIVE',
        heartRate: null,
        latitude: 22.3407,
        longitude: 73.1808,
        timestamp: new Date().toISOString()
    };
}

async function checkMigrationApplied() {
    try {
        const mig = await query(`SELECT version FROM schema_migrations WHERE version = '002'`);
        check('migration: 002_device_auth recorded', mig.rows.length === 1,
            mig.rows.length ? mig.rows[0].version : 'not recorded');

        const col = await query(
            `SELECT column_default
             FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'devices' AND column_name = 'status'`
        );
        check('migration: devices.status defaults to OFFLINE',
            col.rows.length === 1 && String(col.rows[0].column_default).toLowerCase().includes('offline'),
            JSON.stringify(col.rows[0] || null));

        const con = await query(
            `SELECT conname FROM pg_constraint
             WHERE conrelid = 'devices'::regclass AND contype = 'c' AND conname = 'devices_status_valid'`
        );
        check('migration: devices_status_valid CHECK constraint exists', con.rows.length === 1);
    } catch (err) {
        check('migration: schema queries ran', false, `migration check failed: ${err.message || err}`);
    }
}

async function runTests() {
    const state = {};

    await checkMigrationApplied();

    // ── Account setup ─────────────────────────────────────────────
    let res = await postJson(`${BASE_URL}/api/auth/register`, { name: NAME_A, email: EMAIL_A, password: PASSWORD });
    assertStatus('setup: register caretaker A', res.status, 201);
    state.caretakerA = res.body && res.body.user;

    res = await postJson(`${BASE_URL}/api/auth/register`, { name: NAME_B, email: EMAIL_B, password: PASSWORD });
    assertStatus('setup: register caretaker B', res.status, 201);
    state.caretakerB = res.body && res.body.user;

    res = await postJson(`${BASE_URL}/api/auth/login`, { email: EMAIL_A, password: PASSWORD });
    assertStatus('setup: login A', res.status, 200);
    state.cookieA = readCookie(res) && readCookie(res).value;

    res = await postJson(`${BASE_URL}/api/auth/login`, { email: EMAIL_B, password: PASSWORD });
    assertStatus('setup: login B', res.status, 200);
    state.cookieB = readCookie(res) && readCookie(res).value;

    check('setup: both caretaker cookies captured', Boolean(state.cookieA && state.cookieB));

    // ── Blind user + link ─────────────────────────────────────────
    if (state.cookieA) {
        res = await postJson(`${BASE_URL}/api/blind-users`, { name: 'Rahul', email: EMAIL_X }, authHeaders(state.cookieA));
        assertStatus('setup: create blind user X → 201', res.status, 201);
        state.blindX = res.body && res.body.user;

        res = await postJson(`${BASE_URL}/api/caretaker/blind-users/${state.blindX.id}`, {}, authHeaders(state.cookieA));
        assertStatus('setup: link A → X → 201', res.status, 201);
    }

    // ── Device management (caretaker-only) ────────────────────────
    // Unauthenticated is rejected.
    res = await getJson(`${BASE_URL}/api/devices`);
    assertStatus('device mgmt: no session GET /api/devices → 401', res.status, 401);
    res = await postJson(`${BASE_URL}/api/devices`, { blindUserId: crypto.randomUUID(), deviceIdentifier: 'BG001' });
    assertStatus('device mgmt: no session POST /api/devices → 401', res.status, 401);
    res = await postJson(`${BASE_URL}/api/devices/${crypto.randomUUID()}/rotate`, {});
    assertStatus('device mgmt: no session rotate → 401', res.status, 401);

    // Create device BG001 for X (authorized caretaker A).
    res = await postJson(`${BASE_URL}/api/devices`, {
        blindUserId: state.blindX.id,
        deviceIdentifier: 'BG001',
        friendlyName: 'Assistive Cap'
    }, authHeaders(state.cookieA));
    assertStatus('device: create BG001 for X → 201', res.status, 201);
    const created = res.body;
    check('device: create returns device object', Boolean(created && created.device && created.device.id), JSON.stringify(created));
    state.device = created && created.device;
    state.tokenA = created && created.token;
    check('device: plaintext token returned at creation', typeof state.tokenA === 'string' && state.tokenA.length > 20,
        typeof state.tokenA);
    if (state.device) {
        check('device: identifier preserved', state.device.deviceIdentifier === 'BG001');
        check('device: status defaults OFFLINE', state.device.status === 'OFFLINE', String(state.device.status));
        check('device: blindUserId is X', state.device.blindUserId === state.blindX.id);
        check('device: create body has NO secret_hash', !JSON.stringify(created).includes('secret_hash'));
        check('device: create body has NO duplicate token', JSON.stringify(created).split(state.tokenA).length == 2,
            'token must appear exactly once in the response');
    }

    // Uniqueness of device identifier.
    res = await postJson(`${BASE_URL}/api/devices`, {
        blindUserId: state.blindX.id,
        deviceIdentifier: 'BG001'
    }, authHeaders(state.cookieA));
    assertStatus('device: duplicate identifier → 409', res.status, 409);

    // Unauthorized caretaker B cannot create a device for X.
    res = await postJson(`${BASE_URL}/api/devices`, {
        blindUserId: state.blindX.id,
        deviceIdentifier: 'BG002'
    }, authHeaders(state.cookieB));
    assertStatus('device: B cannot register device for X (no relationship) → 404', res.status, 404);

    // Nonexistent / unlinked target user.
    res = await postJson(`${BASE_URL}/api/devices`, {
        blindUserId: crypto.randomUUID(),
        deviceIdentifier: 'BG999'
    }, authHeaders(state.cookieA));
    assertStatus('device: unlinked blind user → 404', res.status, 404);

    // ── Device GET endpoints never expose the secret ──────────────
    res = await getJson(`${BASE_URL}/api/devices`, cookieHeader(state.cookieA));
    assertStatus('device: A GET /api/devices → 200', res.status, 200);
    check('device: A list contains BG001', Array.isArray(res.body && res.body.devices)
        && res.body.devices.some((d) => d.deviceIdentifier === 'BG001'), JSON.stringify(res.body && res.body.devices));
    check('device: GET list has no token', !JSON.stringify(res.body).includes(state.tokenA));
    check('device: GET list has no secret_hash', !JSON.stringify(res.body).includes('secret_hash'));

    res = await getJson(`${BASE_URL}/api/devices/${state.device.id}`, cookieHeader(state.cookieA));
    assertStatus('device: A GET /api/devices/:id → 200', res.status, 200);
    check('device: GET single has no token', !JSON.stringify(res.body).includes(state.tokenA));
    check('device: GET single has no secret_hash', !JSON.stringify(res.body).includes('secret_hash'));
    check('device: GET single returns friendly name', res.body.device.friendlyName === 'Assistive Cap');

    // Filter by blindUserId (authorization still enforced).
    res = await getJson(`${BASE_URL}/api/devices?blindUserId=${state.blindX.id}`, cookieHeader(state.cookieA));
    assertStatus('device: A filter by X → 200', res.status, 200);
    check('device: filter returns BG001', Array.isArray(res.body.devices) && res.body.devices.length === 1);

    res = await getJson(`${BASE_URL}/api/devices?blindUserId=${crypto.randomUUID()}`, cookieHeader(state.cookieA));
    assertStatus('device: filter by unlinked user → 404', res.status, 404);

    // Caretaker B has no access.
    res = await getJson(`${BASE_URL}/api/devices/${state.device.id}`, cookieHeader(state.cookieB));
    assertStatus('device: B GET A device → 404', res.status, 404);
    res = await getJson(`${BASE_URL}/api/devices?blindUserId=${state.blindX.id}`, cookieHeader(state.cookieB));
    assertStatus('device: B filter by X → 404', res.status, 404);
    res = await getJson(`${BASE_URL}/api/devices`, cookieHeader(state.cookieB));
    check('device: B unfiltered list is empty', Array.isArray(res.body.devices) && res.body.devices.length === 0,
        JSON.stringify(res.body.devices));

    // ── Blind-client device authentication ────────────────────────
    // Correct token succeeds on /api/location and binds the device.
    res = await postJson(`${BASE_URL}/api/location`, { latitude: 22.3407, longitude: 73.1808 }, deviceHeaders('BG001', state.tokenA));
    assertStatus('auth: correct token POST /api/location → 200', res.status, 200);
    check('auth: location bound to authenticated deviceId', res.body.deviceId === 'BG001', JSON.stringify(res.body));
    check('auth: location bound to authenticated blindUserId', res.body.blindUserId === state.blindX.id, JSON.stringify(res.body));

    // Correct token creates an event with server-derived identity.
    res = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-001'), deviceHeaders('BG001', state.tokenA));
    assertStatus('auth: correct token POST /api/events → 201', res.status, 201);
    check('auth: event deviceId is authenticated device', res.body.deviceId === 'BG001', JSON.stringify(res.body));
    check('auth: event blindUserId is authenticated blind user', res.body.blindUserId === state.blindX.id, JSON.stringify(res.body));

    // Client-supplied deviceId / blindUserId cannot override.
    res = await postJson(`${BASE_URL}/api/events`, Object.assign(makeEventPayload('S4-EVT-002'), {
        deviceId: 'EVIL-999',
        blindUserId: crypto.randomUUID()
    }), deviceHeaders('BG001', state.tokenA));
    assertStatus('auth: event with forged identity → 201', res.status, 201);
    check('auth: forged deviceId overwritten', res.body.deviceId === 'BG001', JSON.stringify(res.body));
    check('auth: forged blindUserId overwritten', res.body.blindUserId === state.blindX.id, JSON.stringify(res.body));

    // Missing credentials → 401.
    res = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-003'));
    assertStatus('auth: no headers POST /api/events → 401', res.status, 401);
    res = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-004'), { 'Content-Type': 'application/json', 'X-Device-Id': 'BG001' });
    assertStatus('auth: missing token → 401', res.status, 401);
    res = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-005'), { 'Content-Type': 'application/json', 'X-Device-Token': state.tokenA });
    assertStatus('auth: missing device id → 401', res.status, 401);

    // Wrong token → 401.
    res = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-006'), deviceHeaders('BG001', 'not-the-right-token'));
    assertStatus('auth: wrong token → 401', res.status, 401);

    // Unknown device → 401.
    res = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-007'), deviceHeaders('NO-SUCH-DEVICE', state.tokenA));
    assertStatus('auth: unknown device → 401', res.status, 401);

    // Unpaired device (no secret stored) → 401.
    await query(
        `INSERT INTO devices (blind_user_id, device_identifier, friendly_name, secret_hash, status)
         VALUES ($1, $2, $3, NULL, 'OFFLINE')`,
        [state.blindX.id, 'BG-UNPAIRED', 'Unpaired device']
    );
    res = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-UNPAIRED'), deviceHeaders('BG-UNPAIRED', 'whatever-token'));
    assertStatus('auth: unpaired device (null secret) → 401', res.status, 401);

    // Same generic 401 body for unknown vs wrong token (no oracle).
    const wrong = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-008'), deviceHeaders('BG001', 'wrong-token-value'));
    const unknown = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-009'), deviceHeaders('NO-SUCH-DEVICE', state.tokenA));
    const missing = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-010'));
    check('auth: identical 401 errors (no oracle)', JSON.stringify(wrong.body) === JSON.stringify(unknown.body)
        && JSON.stringify(wrong.body) === JSON.stringify(missing.body),
        `wrong=${JSON.stringify(wrong.body)} unknown=${JSON.stringify(unknown.body)} missing=${JSON.stringify(missing.body)}`);

    // ── Event ownership on PATCH ───────────────────────────────────
    // Register a second device for X so device A cannot touch device B's event.
    res = await postJson(`${BASE_URL}/api/devices`, {
        blindUserId: state.blindX.id,
        deviceIdentifier: 'BG002',
        friendlyName: 'Second Cap'
    }, authHeaders(state.cookieA));
    assertStatus('setup: create BG002 → 201', res.status, 201);
    state.deviceB = res.body && res.body.device;
    state.tokenB = res.body && res.body.token;

    res = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-B'), deviceHeaders('BG002', state.tokenB));
    assertStatus('setup: BG002 creates an event → 201', res.status, 201);
    check('setup: BG002 event is device B', res.body.deviceId === 'BG002');

    res = await patchJson(`${BASE_URL}/api/events/S4-EVT-B`, { status: 'ACKNOWLEDGED' }, deviceHeaders('BG001', state.tokenA));
    assertStatus('ownership: device A cannot resolve device B event → 403', res.status, 403);

    res = await patchJson(`${BASE_URL}/api/events/S4-EVT-B`, { status: 'ACKNOWLEDGED' }, deviceHeaders('BG002', state.tokenB));
    assertStatus('ownership: device B resolves its own event → 200', res.status, 200);
    check('ownership: event status updated by owner', res.body.status === 'ACKNOWLEDGED', JSON.stringify(res.body));

    // Caretaker can still resolve the same event (Stage-3 relationship path).
    res = await patchJson(`${BASE_URL}/api/events/S4-EVT-B`, { status: 'RESOLVED' }, authHeaders(state.cookieA));
    assertStatus('ownership: caretaker resolves event → 200', res.status, 200);

    // ── Token rotation ─────────────────────────────────────────────
    res = await postJson(`${BASE_URL}/api/devices/${state.deviceB.id}/rotate`, {}, authHeaders(state.cookieA));
    assertStatus('rotate: caretaker A rotates BG002 → 200', res.status, 200);
    const rotated = res.body;
    state.tokenB2 = rotated && rotated.token;
    check('rotate: new token returned once', typeof state.tokenB2 === 'string' && state.tokenB2.length > 20, typeof state.tokenB2);
    check('rotate: device identity unchanged', rotated.device && rotated.device.id === state.deviceB.id);
    check('rotate: new token differs from old', state.tokenB2 !== state.tokenB);
    check('rotate: old token not exposed', !JSON.stringify(rotated).includes(state.tokenB));

    res = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-ROT-OLD'), deviceHeaders('BG002', state.tokenB));
    assertStatus('rotate: old token now fails → 401', res.status, 401);
    res = await postJson(`${BASE_URL}/api/events`, makeEventPayload('S4-EVT-ROT-NEW'), deviceHeaders('BG002', state.tokenB2));
    assertStatus('rotate: new token succeeds → 201', res.status, 201);

    // Rotate cannot be done by an unauthorized caretaker.
    res = await postJson(`${BASE_URL}/api/devices/${state.device.id}/rotate`, {}, authHeaders(state.cookieB));
    assertStatus('rotate: unauthorized caretaker → 404', res.status, 404);

    // Rotate does not leak the new token through GET.
    res = await getJson(`${BASE_URL}/api/devices/${state.deviceB.id}`, cookieHeader(state.cookieA));
    check('rotate: GET after rotation has no token', !JSON.stringify(res.body).includes(state.tokenB2));

    // Device 401 on the blind client clears pairing on reload only in the
    // forward; a rotated-token device cannot keep talking.
    res = await postJson(`${BASE_URL}/api/location`, { latitude: 22.34, longitude: 73.18 }, deviceHeaders('BG002', state.tokenB));
    assertStatus('rotate: old token rejected on location too → 401', res.status, 401);

    // ── Regression ────────────────────────────────────────────────
    res = await getJson(`${BASE_URL}/api/health`);
    assertStatus('regression: /api/health 200', res.status, 200);
    res = await getJson(`${BASE_URL}/api/events`);
    assertStatus('regression: /api/events still public (200)', res.status, 200);
    res = await getJson(`${BASE_URL}/api/walle/sessions`);
    assertStatus('regression: /api/walle/sessions 200', res.status, 200);
    res = await fetch(`${BASE_URL}/api/events/stream`);
    check('regression: SSE stream still public (200)', res.status === 200, `status ${res.status}`);
    if (res.body && res.body.cancel) await res.body.cancel();
}

async function cleanup() {
    try {
        await query(`DELETE FROM users WHERE email LIKE 'stg4-%'`);
        console.log('[test] cleaned up stg4 users, devices, relationships and sessions');
        const leftover = await query(`SELECT COUNT(*)::int AS n FROM users WHERE email LIKE 'stg4-%' OR email LIKE 'stg3-%' OR email LIKE 'auth-test-%'`);
        console.log(`[test] leftover test users: ${leftover.rows[0].n}`);
    } catch (err) {
        console.warn('[test] cleanup failed (non-fatal):', err.message || err);
    }
}

async function main() {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
        console.error('[test] FATAL: DATABASE_URL is not configured. stage4 tests need the local blindguardian database.');
        process.exit(1);
    }

    child = spawn(process.execPath, ['server.js'], {
        cwd: BACKEND_DIR,
        env: Object.assign({}, process.env, {
            PORT: String(PORT),
            NODE_ENV: 'test',
            COOKIE_SECURE: 'false',
            MQTT_BROKER_URL: ''
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    console.log(`[test] starting backend on ${BASE_URL}`);
    const up = await waitForHealth(20000);
    if (!up) {
        console.error('[test] FATAL: backend did not become healthy in time.');
        child.kill('SIGTERM');
        process.exit(1);
    }
    console.log('[test] backend healthy — running stage4 tests…');

    try {
        await runTests();
    } finally {
        await cleanup();
        if (getPool().end) { try { await getPool().end(); } catch (_e) { /* ignore */ } }
    }

    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));

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
    console.error('[test] FATAL:', err.stack || err.message || err);
    if (child) child.kill('SIGTERM');
    process.exit(1);
});