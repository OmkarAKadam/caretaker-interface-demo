'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');

const TOKEN_BYTES = 32;

// 256-bit cryptographic session token. The raw value is only ever sent to the
// browser as the HttpOnly cookie; only its SHA-256 digest is persisted in
// PostgreSQL.
function generateSessionToken() {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

// SHA-256 digest used for database lookup. One-way: the raw token cannot be
// recovered from the stored hash.
function hashSessionToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession({ userId, expiresAt, ip, userAgent }) {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);

    await query(
        `INSERT INTO sessions (user_id, token_hash, expires_at, last_seen_at, ip, user_agent)
         VALUES ($1, $2, $3, now(), $4, $5)`,
        [userId, tokenHash, expiresAt, ip || null, userAgent || null]
    );

    return { token, tokenHash };
}

// Returns the session joined with its user, or null when no unexpired session
// matches. Expiration is enforced here (not left to the middleware) so a
// single query reflects the full validity check.
async function findSessionByTokenHash(tokenHash) {
    const result = await query(
        `SELECT s.id AS session_id, s.expires_at, s.last_seen_at,
                u.id, u.name, u.email, u.role
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [tokenHash]
    );
    return result.rows[0] || null;
}

// Throttled liveness touch. Only writes when the session has not been seen
// for at least `youngerThanMs`, so idle authenticated requests do not hammer
// the database on every request.
async function touchSession(sessionId, lastSeenAt, youngerThanMs) {
    if (lastSeenAt) {
        const ageMs = Date.now() - new Date(lastSeenAt).getTime();
        if (Number.isFinite(ageMs) && ageMs < youngerThanMs) {
            return;
        }
    }
    await query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [sessionId]);
}

async function deleteSessionByTokenHash(tokenHash) {
    await query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
}

module.exports = {
    generateSessionToken,
    hashSessionToken,
    createSession,
    findSessionByTokenHash,
    touchSession,
    deleteSessionByTokenHash
};