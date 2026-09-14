'use strict';

// Stage 3 integration test harness: blind-user management, caretaker
// relationships and backend authorization.
//
// Runs the real server (`node server.js`) against the real local PostgreSQL
// database, exercising blind-user CRUD, relationship (link/list/deactivate)
// flows, role gates, IDOR protection and multi-user isolation end-to-end over
// HTTP.
//
// Run with:
//   npm run test:stage3
//
// All test users use the `stg3-` email prefix and are DELETED (with their
// relationships and sessions, via ON DELETE CASCADE) when the run finishes.

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, getPool } = require('../db/pool');

const BACKEND_DIR = path.resolve(__dirname, '..');
const PORT = Number.parseInt(process.env.STAGE3_TEST_PORT || '3748', 10);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'bg_session';
const PREFIX = 'stg3-';

const ts = Date.now();
const EMAIL_A = `${PREFIX}${ts}-caretaker-a@test.local`;
const EMAIL_B = `${PREFIX}${ts}-caretaker-b@test.local`;
const PASSWORD = 'CorrectHorse42!';
const NAME_A = 'Stage3 Caretaker A';
const NAME_B = 'Stage3 Caretaker B';

const EMAIL_X = `${PREFIX}${ts}-blind-x@test.local`; // Rahul — linked to A
const EMAIL_Y = `${PREFIX}${ts}-blind-y@test.local`; // Amit — linked to A (caretakerId injection target)
const EMAIL_Z = `${PREFIX}${ts}-blind-z@test.local`; // Zara — linked to B
const EMAIL_BLIND_LOGIN = `${PREFIX}${ts}-blind-login@test.local`;
const BLIND_LOGIN_PASSWORD = 'KnownBlindPassword!42';

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

async function deleteJson(url, headers) {
    const res = await fetch(url, { method: 'DELETE', headers: headers || {} });
    return { status: res.status, body: await json(res), headers: res.headers };
}

function cookieHeader(cookie) {
    return { Cookie: `${COOKIE_NAME}=${cookie}` };
}

function authHeaders(cookie) {
    return Object.assign({ Cookie: `${COOKIE_NAME}=${cookie}` }, { 'Content-Type': 'application/json' });
}

async function listIds(body) {
    return (body && Array.isArray(body.blindUsers) ? body.blindUsers : []).map((u) => u.id);
}

async function runTests() {
    const state = {};

    // ── Account setup ─────────────────────────────────────────────
    let res = await postJson(`${BASE_URL}/api/auth/register`, { name: NAME_A, email: EMAIL_A, password: PASSWORD });
    assertStatus('setup: register caretaker A', res.status, 201);
    const caretakerA = res.body && res.body.user;
    state.caretakerA = caretakerA;
    check('setup: A has caretaker id', Boolean(caretakerA && caretakerA.id));

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

    // ── Unauthenticated ───────────────────────────────────────────
    res = await getJson(`${BASE_URL}/api/blind-users`);
    assertStatus('unauth: GET /api/blind-users → 401', res.status, 401);
    res = await getJson(`${BASE_URL}/api/caretaker/blind-users`);
    assertStatus('unauth: GET /api/caretaker/blind-users → 401', res.status, 401);
    res = await postJson(`${BASE_URL}/api/caretaker/blind-users/${crypto.randomUUID()}`, {});
    assertStatus('unauth: POST link → 401', res.status, 401);
    res = await deleteJson(`${BASE_URL}/api/caretaker/blind-users/${crypto.randomUUID()}`);
    assertStatus('unauth: DELETE link → 401', res.status, 401);
    res = await getJson(`${BASE_URL}/api/blind-users/${crypto.randomUUID()}`);
    assertStatus('unauth: GET blind user → 401', res.status, 401);
    res = await patchJson(`${BASE_URL}/api/blind-users/${crypto.randomUUID()}`, { name: 'x' });
    assertStatus('unauth: PATCH blind user → 401', res.status, 401);

    // ── Blind-user creation ───────────────────────────────────────
    if (state.cookieA) {
        res = await postJson(`${BASE_URL}/api/blind-users`, { name: 'Rahul', email: EMAIL_X }, authHeaders(state.cookieA));
        assertStatus('create: blind user X → 201', res.status, 201);
        check('create: role forced BLIND_USER', res.body && res.body.user && res.body.user.role === 'BLIND_USER',
            JSON.stringify(res.body && res.body.user));
        check('create: email preserved (lowercase)', res.body && res.body.user && res.body.user.email === EMAIL_X.toLowerCase());
        check('create: no password_hash in body', !JSON.stringify(res.body).includes('password_hash'));
        check('create: no raw credentials in body', !JSON.stringify(res.body).toLowerCase().includes('password'));
        state.blindX = res.body && res.body.user;

        res = await postJson(`${BASE_URL}/api/blind-users`, { name: 'Amit', email: EMAIL_Y }, authHeaders(state.cookieA));
        assertStatus('create: blind user Y → 201', res.status, 201);
        state.blindY = res.body && res.body.user;

        res = await postJson(`${BASE_URL}/api/blind-users`, { name: 'Zara', email: EMAIL_Z }, authHeaders(state.cookieA));
        assertStatus('create: blind user Z → 201', res.status, 201);
        state.blindZ = res.body && res.body.user;

        // Role injection cannot escalate.
        res = await postJson(`${BASE_URL}/api/blind-users`, { name: 'Sneaky', email: `${PREFIX}${ts}-role-caretaker@test.local`, role: 'CARETAKER' }, authHeaders(state.cookieA));
        assertStatus('create: role=CARETAKER injection rejected', res.status, 400);
        res = await postJson(`${BASE_URL}/api/blind-users`, { name: 'Sneaky', email: `${PREFIX}${ts}-role-admin@test.local`, role: 'ADMIN' }, authHeaders(state.cookieA));
        assertStatus('create: role=ADMIN injection rejected', res.status, 400);
        res = await postJson(`${BASE_URL}/api/blind-users`, { name: 'Sneaky', email: `${PREFIX}${ts}-role-blind@test.local`, role: 'BLIND_USER' }, authHeaders(state.cookieA));
        assertStatus('create: explicit BLIND_USER accepted', res.status, 201);
        check('create: explicit BLIND_USER still role BLIND_USER', res.body && res.body.user && res.body.user.role === 'BLIND_USER');

        // Validation + duplicates.
        res = await postJson(`${BASE_URL}/api/blind-users`, { name: '', email: `${PREFIX}${ts}-empty@test.local` }, authHeaders(state.cookieA));
        assertStatus('create: empty name rejected', res.status, 400);
        res = await postJson(`${BASE_URL}/api/blind-users`, { name: 'X', email: 'not-an-email' }, authHeaders(state.cookieA));
        assertStatus('create: invalid email rejected', res.status, 400);
        res = await postJson(`${BASE_URL}/api/blind-users`, { name: 'Dup', email: EMAIL_X }, authHeaders(state.cookieA));
        assertStatus('create: duplicate email rejected', res.status, 409);
        res = await postJson(`${BASE_URL}/api/blind-users`, { name: 'Dup', email: EMAIL_X.toUpperCase() }, authHeaders(state.cookieA));
        assertStatus('create: duplicate email (casing) rejected', res.status, 409);

        // Not authorized until a relationship exists.
        res = await getJson(`${BASE_URL}/api/blind-users`, cookieHeader(state.cookieA));
        assertStatus('list: empty before linking', res.status, 200);
        check('list: no blind users before linking', (res.body && res.body.blindUsers && res.body.blindUsers.length) === 0,
            JSON.stringify(res.body && res.body.blindUsers));
        res = await getJson(`${BASE_URL}/api/blind-users/${state.blindX.id}`, cookieHeader(state.cookieA));
        assertStatus('get: X not authorized before linking → 404', res.status, 404);
    } else {
        check('create: blind user X → 201', false, 'no cookie captured, skipped');
    }

    // ── Non-caretaker cannot manage ───────────────────────────────
    const blindLoginInsert = await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'BLIND_USER')
         RETURNING id`,
        ['Blind Login User', EMAIL_BLIND_LOGIN, await bcrypt.hash(BLIND_LOGIN_PASSWORD, 10)]
    );
    res = await postJson(`${BASE_URL}/api/auth/login`, { email: EMAIL_BLIND_LOGIN, password: BLIND_LOGIN_PASSWORD });
    assertStatus('role: blind user can login (test fixture)', res.status, 200);
    const blindCookie = readCookie(res) && readCookie(res).value;
    if (blindCookie) {
        res = await getJson(`${BASE_URL}/api/blind-users`, cookieHeader(blindCookie));
        assertStatus('role: blind user GET /api/blind-users → 403', res.status, 403);
        res = await getJson(`${BASE_URL}/api/caretaker/blind-users`, cookieHeader(blindCookie));
        assertStatus('role: blind user GET /api/caretaker/blind-users → 403', res.status, 403);
        res = await postJson(`${BASE_URL}/api/caretaker/blind-users/${state.blindX ? state.blindX.id : crypto.randomUUID()}`, {}, authHeaders(blindCookie));
        assertStatus('role: blind user POST link → 403', res.status, 403);
        res = await postJson(`${BASE_URL}/api/blind-users`, { name: 'Hax', email: `${PREFIX}${ts}-blind-create@test.local` }, authHeaders(blindCookie));
        assertStatus('role: blind user POST /api/blind-users → 403', res.status, 403);
    } else {
        check('role: blind user GET /api/blind-users → 403', false, 'no cookie captured, skipped');
    }

    // Sanity: the fixture blind user cannot be seen via management endpoints.
    if (state.cookieA) {
        res = await getJson(`${BASE_URL}/api/blind-users/${blindLoginInsert.rows[0].id}`, cookieHeader(state.cookieA));
        assertStatus('role: fixture blind user invisible to A → 404', res.status, 404);
    }

    // ── Relationship linking (A → X) ──────────────────────────────
    if (state.cookieA && state.blindX) {
        res = await postJson(`${BASE_URL}/api/caretaker/blind-users/${state.blindX.id}`, {}, authHeaders(state.cookieA));
        assertStatus('link: A links X → 201', res.status, 201);
        check('link: relationship ACTIVE', res.body && res.body.relationship && res.body.relationship.status === 'ACTIVE');
        check('link: caretaker_id is A (from session)', res.body && res.body.relationship && res.body.relationship.caretaker_id === state.caretakerA.id,
            JSON.stringify(res.body && res.body.relationship));

        // Idempotent duplicate link.
        res = await postJson(`${BASE_URL}/api/caretaker/blind-users/${state.blindX.id}`, {}, authHeaders(state.cookieA));
        assertStatus('link: duplicate link is idempotent (200)', res.status, 200);

        const axCount = await query(
            'SELECT COUNT(*)::int AS n FROM care_relationships WHERE caretaker_id = $1 AND blind_user_id = $2',
            [state.caretakerA.id, state.blindX.id]
        );
        check('link: only one relationship row (AX)', axCount.rows[0].n === 1, `count ${axCount.rows[0].n}`);

        res = await getJson(`${BASE_URL}/api/caretaker/blind-users`, cookieHeader(state.cookieA));
        assertStatus('link: A list includes X', res.status, 200);
        check('link: A list contains exactly X', JSON.stringify(await listIds(res.body)) === JSON.stringify([state.blindX.id]),
            JSON.stringify(await listIds(res.body)));

        res = await getJson(`${BASE_URL}/api/blind-users/${state.blindX.id}`, cookieHeader(state.cookieA));
        assertStatus('link: A GET X → 200', res.status, 200);
        check('link: X profile correct via A', res.body && res.body.user && res.body.user.id === state.blindX.id
            && res.body.user.role === 'BLIND_USER', JSON.stringify(res.body && res.body.user));
        check('link: no password_hash via A', !JSON.stringify(res.body).includes('password_hash'));
    }

    // ── caretakerId injection is ignored (A → Y with body caretakerId=B) ──
    if (state.cookieA && state.blindY && state.caretakerB) {
        res = await postJson(
            `${BASE_URL}/api/caretaker/blind-users/${state.blindY.id}`,
            { caretakerId: state.caretakerB.id },
            authHeaders(state.cookieA)
        );
        assertStatus('inject: A links Y (body caretakerId=B) → 201', res.status, 201);
        check('inject: relationship caretaker_id is A, not B',
            res.body && res.body.relationship && res.body.relationship.caretaker_id === state.caretakerA.id,
            JSON.stringify(res.body && res.body.relationship));

        res = await getJson(`${BASE_URL}/api/caretaker/blind-users`, cookieHeader(state.cookieB));
        check('inject: B list does not contain Y', !(await listIds(res.body)).includes(state.blindY.id),
            JSON.stringify(res.body && res.body.blindUsers));

        // And a fake query caretakerId cannot matter either.
        res = await postJson(`${BASE_URL}/api/caretaker/blind-users/${state.blindY.id}?caretakerId=${state.caretakerB.id}`, {}, authHeaders(state.cookieA));
        assertStatus('inject: duplicate via query caretakerId still idempotent (200)', res.status, 200);
    }

    // ── B's independent access (B → Z) ────────────────────────────
    if (state.cookieB && state.blindZ) {
        res = await postJson(`${BASE_URL}/api/caretaker/blind-users/${state.blindZ.id}`, {}, authHeaders(state.cookieB));
        assertStatus('isolation: B links Z → 201', res.status, 201);
        res = await getJson(`${BASE_URL}/api/caretaker/blind-users`, cookieHeader(state.cookieB));
        check('isolation: B list contains Z', (await listIds(res.body)).includes(state.blindZ.id));
        res = await getJson(`${BASE_URL}/api/blind-users/${state.blindZ.id}`, cookieHeader(state.cookieB));
        assertStatus('isolation: B GET Z → 200', res.status, 200);
    }

    // ── Invalid / self link targets ───────────────────────────────
    if (state.cookieA) {
        res = await postJson(`${BASE_URL}/api/caretaker/blind-users/${state.caretakerA.id}`, {}, authHeaders(state.cookieA));
        assertStatus('link: self-link rejected', res.status, 400);
        res = await postJson(`${BASE_URL}/api/caretaker/blind-users/${crypto.randomUUID()}`, {}, authHeaders(state.cookieA));
        assertStatus('link: nonexistent blind user → 404', res.status, 404);
        res = await postJson(`${BASE_URL}/api/caretaker/blind-users/not-a-uuid`, {}, authHeaders(state.cookieA));
        assertStatus('link: invalid uuid → 404', res.status, 404);
    }

    // ── Multi-user isolation + IDOR ───────────────────────────────
    if (state.cookieA && state.cookieB && state.blindX && state.blindY && state.blindZ) {
        res = await getJson(`${BASE_URL}/api/caretaker/blind-users`, cookieHeader(state.cookieA));
        const aIds = await listIds(res.body);
        check('isolation: A has X and Y', aIds.includes(state.blindX.id) && aIds.includes(state.blindY.id),
            JSON.stringify(aIds));
        check('isolation: A does not have Z', !aIds.includes(state.blindZ.id), JSON.stringify(aIds));

        res = await getJson(`${BASE_URL}/api/caretaker/blind-users`, cookieHeader(state.cookieB));
        const bIds = await listIds(res.body);
        check('isolation: B has only Z', JSON.stringify(bIds) === JSON.stringify([state.blindZ.id]), JSON.stringify(bIds));

        res = await getJson(`${BASE_URL}/api/blind-users/${state.blindZ.id}`, cookieHeader(state.cookieA));
        assertStatus('idor: A GET Z (B-linked) → 404', res.status, 404);
        res = await getJson(`${BASE_URL}/api/blind-users/${state.blindX.id}`, cookieHeader(state.cookieB));
        assertStatus('idor: B GET X (A-linked) → 404', res.status, 404);
        res = await getJson(`${BASE_URL}/api/blind-users/${state.blindY.id}`, cookieHeader(state.cookieB));
        assertStatus('idor: B GET Y (A-linked) → 404', res.status, 404);
        res = await patchJson(`${BASE_URL}/api/blind-users/${state.blindZ.id}`, { name: 'Hacked' }, authHeaders(state.cookieA));
        assertStatus('idor: A PATCH Z (B-linked) → 404', res.status, 404);
        res = await deleteJson(`${BASE_URL}/api/caretaker/blind-users/${state.blindX.id}`, cookieHeader(state.cookieB));
        assertStatus('idor: B deletes A→X relationship → 404', res.status, 404);
    }

    // ── Deactivate / reactivate ───────────────────────────────────
    if (state.cookieA && state.blindX) {
        res = await deleteJson(`${BASE_URL}/api/caretaker/blind-users/${state.blindX.id}`, cookieHeader(state.cookieA));
        assertStatus('deactivate: A DELETE X → 200', res.status, 200);
        check('deactivate: relationship becomes INACTIVE',
            res.body && res.body.relationship && res.body.relationship.status === 'INACTIVE');

        res = await getJson(`${BASE_URL}/api/caretaker/blind-users`, cookieHeader(state.cookieA));
        check('deactivate: X removed from A list', !(await listIds(res.body)).includes(state.blindX.id),
            JSON.stringify(await listIds(res.body)));
        res = await getJson(`${BASE_URL}/api/blind-users/${state.blindX.id}`, cookieHeader(state.cookieA));
        assertStatus('deactivate: A GET X → 404 after deactivation', res.status, 404);

        res = await postJson(`${BASE_URL}/api/caretaker/blind-users/${state.blindX.id}`, {}, authHeaders(state.cookieA));
        assertStatus('reactivate: A re-links X → 200', res.status, 200);
        check('reactivate: relationship ACTIVE again', res.body && res.body.relationship && res.body.relationship.status === 'ACTIVE');
        const axCount2 = await query(
            'SELECT COUNT(*)::int AS n FROM care_relationships WHERE caretaker_id = $1 AND blind_user_id = $2',
            [state.caretakerA.id, state.blindX.id]
        );
        check('reactivate: still a single relationship row', axCount2.rows[0].n === 1, `count ${axCount2.rows[0].n}`);
        res = await getJson(`${BASE_URL}/api/blind-users/${state.blindX.id}`, cookieHeader(state.cookieA));
        assertStatus('reactivate: A GET X → 200 again', res.status, 200);

        res = await deleteJson(`${BASE_URL}/api/caretaker/blind-users/not-a-uuid`, cookieHeader(state.cookieA));
        assertStatus('deactivate: invalid uuid → 404', res.status, 404);
    }

    // ── PATCH blind user (authorized only) ────────────────────────
    if (state.cookieA && state.blindX) {
        res = await patchJson(`${BASE_URL}/api/blind-users/${state.blindX.id}`, { name: 'Rahul Kumar' }, authHeaders(state.cookieA));
        assertStatus('patch: A updates X name → 200', res.status, 200);
        check('patch: name updated', res.body && res.body.user && res.body.user.name === 'Rahul Kumar',
            JSON.stringify(res.body && res.body.user));
        check('patch: role unchanged BLIND_USER', res.body && res.body.user && res.body.user.role === 'BLIND_USER');
        check('patch: no password_hash in body', !JSON.stringify(res.body).includes('password_hash'));

        res = await patchJson(`${BASE_URL}/api/blind-users/${state.blindX.id}`, { email: `${PREFIX}${ts}-blind-x-new@test.local` }, authHeaders(state.cookieA));
        assertStatus('patch: A updates X email → 200', res.status, 200);
        check('patch: email updated', res.body && res.body.user && res.body.user.email === `${PREFIX}${ts}-blind-x-new@test.local`.toLowerCase());

        res = await patchJson(`${BASE_URL}/api/blind-users/${state.blindX.id}`, { role: 'ADMIN' }, authHeaders(state.cookieA));
        assertStatus('patch: role injection rejected', res.status, 400);
        res = await patchJson(`${BASE_URL}/api/blind-users/${state.blindX.id}`, {}, authHeaders(state.cookieA));
        assertStatus('patch: no fields → 400', res.status, 400);
        res = await patchJson(`${BASE_URL}/api/blind-users/${state.blindX.id}`, { name: '' }, authHeaders(state.cookieA));
        assertStatus('patch: empty name → 400', res.status, 400);
        res = await patchJson(`${BASE_URL}/api/blind-users/${state.blindX.id}`, { email: 'not-an-email' }, authHeaders(state.cookieA));
        assertStatus('patch: invalid email → 400', res.status, 400);
        res = await patchJson(`${BASE_URL}/api/blind-users/${state.blindZ.id}`, { name: 'Nope' }, authHeaders(state.cookieA));
        assertStatus('patch: unauthorized blind user → 404', res.status, 404);
    }

    // ── DB integrity ──────────────────────────────────────────────
    if (state.caretakerA && state.caretakerB) {
        const relCount = await query(
            'SELECT COUNT(*)::int AS n FROM care_relationships cr JOIN users u ON u.id = cr.caretaker_id WHERE u.email IN ($1, $2)',
            [EMAIL_A, EMAIL_B]
        );
        check('db: 3 relationships across A and B', relCount.rows[0].n === 3, `count ${relCount.rows[0].n}`);
    }

    // ── Regression ────────────────────────────────────────────────
    res = await getJson(`${BASE_URL}/api/health`);
    assertStatus('regression: /api/health 200', res.status, 200);
    res = await getJson(`${BASE_URL}/api/events`);
    assertStatus('regression: /api/events 200', res.status, 200);
    res = await getJson(`${BASE_URL}/api/walle/sessions`);
    assertStatus('regression: /api/walle/sessions unauth 401 (Stage-8A gate)', res.status, 401);
}

async function cleanup() {
    try {
        await query(`DELETE FROM users WHERE email LIKE 'stg3-%'`);
        console.log('[test] cleaned up stg3 users, their relationships and sessions');
        const leftover = await query(`SELECT COUNT(*)::int AS n FROM users WHERE email LIKE 'stg3-%' OR email LIKE 'auth-test-%'`);
        console.log(`[test] leftover test users: ${leftover.rows[0].n}`);
    } catch (err) {
        console.warn('[test] cleanup failed (non-fatal):', err.message || err);
    }
}

async function main() {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
        console.error('[test] FATAL: DATABASE_URL is not configured. stage3 tests need the local blindguardian database.');
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
    console.log('[test] backend healthy — running stage3 tests…');

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
    console.error('[test] FATAL:', err.message || err);
    if (child) child.kill('SIGTERM');
    process.exit(1);
});