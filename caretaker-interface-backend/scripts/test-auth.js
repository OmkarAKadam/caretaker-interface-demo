'use strict';

// Stage 2 integration test harness for caretaker authentication.
//
// Runs the real server (`node server.js`) against the real local PostgreSQL
// database (the same `DATABASE_URL` the app uses), then exercises registration,
// login, session, logout, CORS and security requirements end-to-end over HTTP.
//
// Run with:
//   npm run test:auth
//
// Test users are created with the `auth-test-` email prefix and are DELETED (with
// their sessions, via ON DELETE CASCADE) when the run finishes.

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { query, getPool } = require('../db/pool');
const { generateSessionToken, hashSessionToken } = require('../auth/sessions');

const BACKEND_DIR = path.resolve(__dirname, '..');
const PORT = Number.parseInt(process.env.AUTH_TEST_PORT || '3747', 10);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'bg_session';
const TEST_EMAIL_PREFIX = 'auth-test-';

const ts = Date.now();
const EMAIL = `${TEST_EMAIL_PREFIX}${ts}@test.local`;
const PASSWORD = 'CorrectHorse42!';
const NAME = 'Auth Test Caretaker';

let child = null;
let cookie = null;

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

async function runTests() {
    // ── Registration ──────────────────────────────────────────────
    let res = await postJson(`${BASE_URL}/api/auth/register`, {
        name: NAME,
        email: EMAIL,
        password: PASSWORD
    });
    assertStatus('register: valid caretaker', res.status, 201);
    check('register: returns safe user', res.body && res.body.user && res.body.user.role === 'CARETAKER',
        JSON.stringify(res.body && res.body.user));
    check('register: role is CARETAKER', res.body && res.body.user.role === 'CARETAKER');
    check('register: email preserved in response', res.body && res.body.user.email === EMAIL.toLowerCase());
    check('register: no password in body', !JSON.stringify(res.body).includes(PASSWORD));
    check('register: no password_hash in body', !JSON.stringify(res.body).includes('password_hash'));
    const registerSetCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    check('register: no session cookie issued', registerSetCookies.length === 0, String(registerSetCookies.length));

    // Duplicate emails (case-insensitive).
    res = await postJson(`${BASE_URL}/api/auth/register`, { name: NAME, email: EMAIL, password: PASSWORD });
    assertStatus('register: duplicate email rejected', res.status, 409);
    res = await postJson(`${BASE_URL}/api/auth/register`, {
        name: NAME,
        email: EMAIL.toUpperCase(),
        password: PASSWORD
    });
    assertStatus('register: duplicate email (different casing) rejected', res.status, 409);

    // Role injection.
    res = await postJson(`${BASE_URL}/api/auth/register`, {
        name: NAME, email: `${TEST_EMAIL_PREFIX}${ts}-role@test.local`,
        password: PASSWORD, role: 'BLIND_USER'
    });
    assertStatus('register: BLIND_USER role injection rejected', res.status, 400);
    res = await postJson(`${BASE_URL}/api/auth/register`, {
        name: NAME, email: `${TEST_EMAIL_PREFIX}${ts}-admin@test.local`,
        password: PASSWORD, role: 'ADMIN'
    });
    assertStatus('register: ADMIN role injection rejected', res.status, 400);

    // Basic validation.
    res = await postJson(`${BASE_URL}/api/auth/register`, { name: '', email: `${TEST_EMAIL_PREFIX}${ts}-a@test.local`, password: PASSWORD });
    assertStatus('register: empty name rejected', res.status, 400);
    res = await postJson(`${BASE_URL}/api/auth/register`, { name: NAME, email: 'not-an-email', password: PASSWORD });
    assertStatus('register: invalid email rejected', res.status, 400);
    res = await postJson(`${BASE_URL}/api/auth/register`, { name: NAME, email: `${TEST_EMAIL_PREFIX}${ts}-b@test.local`, password: 'short' });
    assertStatus('register: short password rejected', res.status, 400);
    res = await postJson(`${BASE_URL}/api/auth/register`, { name: NAME, email: `${TEST_EMAIL_PREFIX}${ts}-c@test.local`, password: '' });
    assertStatus('register: empty password rejected', res.status, 400);

    // Password stored hashed, never plaintext.
    const storedUser = await query('SELECT id, email, password_hash FROM users WHERE LOWER(email) = $1', [EMAIL]);
    check('db: user exists with lowercased email', storedUser.rows.length === 1);
    if (storedUser.rows[0]) {
        const stored = storedUser.rows[0];
        check('db: password_hash is not plaintext', stored.password_hash !== PASSWORD);
        check('db: password_hash looks like bcrypt', /^\$2[aby]\$/.test(stored.password_hash), stored.password_hash.slice(0, 7));
        check('db: password_hash is not returned in user row selection', !('password_hash' in res.body));
    }

    // ── Login / session ───────────────────────────────────────────
    res = await postJson(`${BASE_URL}/api/auth/login`, { email: EMAIL, password: PASSWORD });
    assertStatus('login: correct credentials', res.status, 200);
    check('login: returns authenticated flag', res.body && res.body.authenticated === true);
    check('login: returns caretaker user', res.body && res.body.user && res.body.user.role === 'CARETAKER');
    check('login: no raw accounts in body', !JSON.stringify(res.body).includes('token'));
    const loginCookie = readCookie(res);
    check('login: session cookie issued', Boolean(loginCookie));
    if (loginCookie) {
        cookie = loginCookie.value;
        check('login: cookie is HttpOnly', /;\s*HttpOnly/i.test(loginCookie.header), loginCookie.header);
        check('login: cookie is SameSite=Lax', /;\s*SameSite=Lax/i.test(loginCookie.header), loginCookie.header);
        check('login: cookie not Secure in non-production', !/;\s*Secure/i.test(loginCookie.header), loginCookie.header);
        check('login: raw token not returned in JSON', !JSON.stringify(res.body).includes(cookie));
    }

    res = await postJson(`${BASE_URL}/api/auth/login`, { email: EMAIL, password: 'WrongPassword99' });
    assertStatus('login: incorrect password rejected', res.status, 401);
    res = await postJson(`${BASE_URL}/api/auth/login`, { email: 'nobody@nowhere.test', password: PASSWORD });
    assertStatus('login: nonexistent account rejected', res.status, 401);

    // Session stored hashed server-side.
    if (cookie && storedUser.rows[0]) {
        const sessionRow = await query(
            'SELECT token_hash, expires_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
            [storedUser.rows[0].id]
        );
        check('db: one session row created', sessionRow.rows.length === 1, String(sessionRow.rows.length));
        if (sessionRow.rows[0]) {
            const row = sessionRow.rows[0];
            check('db: token stored hashed, not plaintext', row.token_hash !== cookie, row.token_hash);
            check('db: stored hash is a SHA-256 hex digest', /^[a-f0-9]{64}$/.test(row.token_hash), row.token_hash);
            check('db: recomputed hash matches stored hash', row.token_hash === hashSessionToken(cookie));
            check('db: session records ip', typeof row.ip === 'string' && row.ip.length > 0, String(row.ip));
            check('db: session records user agent', typeof row.user_agent === 'string' && row.user_agent.length > 0, String(row.user_agent));
        }
    }

    // ── /api/auth/me ──────────────────────────────────────────────
    res = await getJson(`${BASE_URL}/api/auth/me`);
    assertStatus('me: no cookie → 401', res.status, 401);

    if (cookie) {
        res = await getJson(`${BASE_URL}/api/auth/me`, { Cookie: `${COOKIE_NAME}=${cookie}` });
        assertStatus('me: valid cookie → 200', res.status, 200);
        check('me: authenticated flag', res.body && res.body.authenticated === true);
        check('me: returns caretaker identity', res.body && res.body.user && res.body.user.id
            && res.body.user.email === EMAIL && res.body.user.role === 'CARETAKER', JSON.stringify(res.body && res.body.user));
        check('me: no password_hash', !JSON.stringify(res.body).includes('password_hash'));
        check('me: no session token', !JSON.stringify(res.body).includes(cookie));
    } else {
        check('me: valid cookie → 200', false, 'no cookie captured, skipped');
    }

    // Forged / invalid token.
    res = await getJson(`${BASE_URL}/api/auth/me`, { Cookie: `${COOKIE_NAME}=${crypto.randomBytes(32).toString('base64url')}` });
    assertStatus('me: invalid token → 401', res.status, 401);

    // Expired session.
    if (storedUser.rows[0]) {
        const expiredToken = generateSessionToken();
        const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
        await query(
            'INSERT INTO sessions (user_id, token_hash, expires_at, last_seen_at, ip, user_agent) VALUES ($1, $2, $3, now(), $4, $5)',
            [storedUser.rows[0].id, hashSessionToken(expiredToken), oneHourAgo, '127.0.0.1', 'test']
        );
        res = await getJson(`${BASE_URL}/api/auth/me`, { Cookie: `${COOKIE_NAME}=${expiredToken}` });
        assertStatus('me: expired session → 401', res.status, 401);
        await query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(expiredToken)]);
    }

    // ── CORS ──────────────────────────────────────────────────────
    res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'OPTIONS',
        headers: {
            Origin: 'http://localhost:5500',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type'
        }
    });
    check('cors: allowed origin echoed', res.headers.get('access-control-allow-origin') === 'http://localhost:5500',
        String(res.headers.get('access-control-allow-origin')));
    check('cors: credentials allowed', res.headers.get('access-control-allow-credentials') === 'true',
        String(res.headers.get('access-control-allow-credentials')));

    res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'OPTIONS',
        headers: {
            Origin: 'https://evil.example.com',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type'
        }
    });
    check('cors: disallowed origin gets no ACAO', !res.headers.get('access-control-allow-origin'),
        String(res.headers.get('access-control-allow-origin')));

    // ── Logout ────────────────────────────────────────────────────
    if (cookie) {
        res = await postJson(`${BASE_URL}/api/auth/logout`, {}, { Cookie: `${COOKIE_NAME}=${cookie}` });
        assertStatus('logout: succeeds', res.status, 200);
        const logoutCookie = readCookie(res);
        check('logout: clears cookie', Boolean(logoutCookie) && /(Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(logoutCookie.header), logoutCookie ? logoutCookie.header : 'none');

        res = await getJson(`${BASE_URL}/api/auth/me`, { Cookie: `${COOKIE_NAME}=${cookie}` });
        assertStatus('me: after logout → 401', res.status, 401);

        const remaining = await query('SELECT id FROM sessions WHERE user_id = $1', [storedUser.rows[0].id]);
        check('db: session deleted server-side', remaining.rows.length === 0, String(remaining.rows.length));
    }

    // Logout while already logged out / no cookie is safe.
    res = await postJson(`${BASE_URL}/api/auth/logout`, {});
    assertStatus('logout: no cookie is safe (200)', res.status, 200);

    // ── Regression ────────────────────────────────────────────────
    res = await getJson(`${BASE_URL}/api/health`);
    assertStatus('regression: /api/health 200', res.status, 200);
    res = await getJson(`${BASE_URL}/api/events`);
    assertStatus('regression: /api/events 200', res.status, 200);
    res = await getJson(`${BASE_URL}/api/walle/sessions`);
    assertStatus('regression: /api/walle/sessions 200', res.status, 200);
}

async function cleanup() {
    try {
        await query(`DELETE FROM users WHERE email LIKE 'auth-test-%'`);
        console.log('[test] cleaned up auth-test users and their sessions');
    } catch (err) {
        console.warn('[test] cleanup failed (non-fatal):', err.message || err);
    }
}

async function main() {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
        console.error('[test] FATAL: DATABASE_URL is not configured. auth tests need the local blindguardian database.');
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
    console.log('[test] backend healthy — running auth tests…');

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