'use strict';

const express = require('express');

const { query } = require('../db/pool');
const {
    normalizeEmail,
    isValidEmail,
    isValidName,
    validatePassword,
    hashPassword,
    verifyPassword,
    safeUser
} = require('./password');
const {
    createSession,
    hashSessionToken,
    deleteSessionByTokenHash
} = require('./sessions');
const {
    requireAuth,
    setSessionCookie,
    clearSessionCookie,
    SESSION_COOKIE_NAME,
    SESSION_TTL_MS
} = require('./middleware');
const { createRateLimiter } = require('./rate-limit');

const router = express.Router();

// Attempts are bounded per IP using the shared in-memory limiter. Register is
// stricter than login because public signup invites abuse.
const loginLimiter = createRateLimiter({ max: 20 });
const registerLimiter = createRateLimiter({ max: 10 });

const CARETAKER_ROLE = 'CARETAKER';
const INVALID_CREDENTIALS = 'Invalid email or password';

// Equalizes the response time for "user not found" against a real bcrypt
// comparison so login cannot be used to enumerate registered emails.
const DUMMY_PASSWORD_HASH =
    '$2a$10$CwTycUXWue0Thq9StjUM0uJ8H3iZ1n3mD2y6H9vW5QxPqVdT9kC3e';

async function getUserByEmail(email) {
    const result = await query(
        `SELECT id, name, email, role, password_hash
         FROM users
         WHERE LOWER(email) = $1`,
        [email]
    );
    return result.rows[0] || null;
}

router.post('/register', registerLimiter, async (req, res) => {
    const body = req.body || {};

    if (body.role !== undefined && body.role !== null && body.role !== CARETAKER_ROLE) {
        return res.status(400).json({ error: 'Role cannot be chosen during registration' });
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!isValidName(name)) {
        return res.status(400).json({ error: 'Name is required (max 120 characters)' });
    }

    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'A valid email address is required' });
    }

    const passwordCheck = validatePassword(body.password);
    if (!passwordCheck.ok) {
        return res.status(400).json({ error: passwordCheck.error });
    }

    try {
        const passwordHash = await hashPassword(body.password);

        const result = await query(
            `INSERT INTO users (name, email, password_hash, role)
             VALUES ($1, $2, $3, $4)
             RETURNING id, name, email, role`,
            [name, email, passwordHash, CARETAKER_ROLE]
        );

        const user = result.rows[0];
        return res.status(201).json({ user: safeUser(user) });
    } catch (err) {
        if (err && err.code === '23505') {
            return res.status(409).json({ error: 'An account with this email already exists' });
        }
        throw err;
    }
});

router.post('/login', loginLimiter, async (req, res) => {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!isValidEmail(email) || password === '') {
        return res.status(401).json({ error: INVALID_CREDENTIALS });
    }

    const user = await getUserByEmail(email);

    const passwordHash = user ? user.password_hash : DUMMY_PASSWORD_HASH;
    const passwordMatches = await verifyPassword(password, passwordHash);

    if (!user || !passwordMatches) {
        return res.status(401).json({ error: INVALID_CREDENTIALS });
    }

    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const ip = req.ip || null;
    const userAgent =
        typeof req.headers['user-agent'] === 'string'
            ? req.headers['user-agent'].slice(0, 500)
            : null;

    const { token } = await createSession({
        userId: user.id,
        expiresAt,
        ip,
        userAgent
    });

    setSessionCookie(res, token, SESSION_TTL_MS);

    return res.status(200).json({
        authenticated: true,
        user: safeUser({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role
        })
    });
});

router.post('/logout', async (req, res) => {
    const rawToken = req.cookies ? req.cookies[SESSION_COOKIE_NAME] : undefined;

    if (rawToken && typeof rawToken === 'string') {
        try {
            await deleteSessionByTokenHash(hashSessionToken(rawToken));
        } catch (err) {
            // The cookie will still be cleared below; an already-invalid or
            // already-logged-out session is not an error for logout.
            console.error('[auth] logout session deletion failed:', err.message || err);
        }
    }

    clearSessionCookie(res);
    return res.status(200).json({ success: true });
});

router.get('/me', requireAuth, (req, res) => {
    return res.status(200).json({
        authenticated: true,
        user: req.auth.user
    });
});

module.exports = router;