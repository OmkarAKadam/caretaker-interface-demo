'use strict';

const {
    hashSessionToken,
    findSessionByTokenHash,
    touchSession
} = require('./sessions');

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'bg_session';

// How often an active session's last_seen_at may be refreshed (15 minutes).
const LAST_SEEN_THROTTLE_MS = 15 * 60 * 1000;

const SESSION_TTL_MS = (() => {
    const raw = parseInt(process.env.SESSION_TTL_MS, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 7 * 24 * 60 * 60 * 1000;
})();

function isSecureCookieRequested() {
    return (
        process.env.NODE_ENV === 'production' ||
        process.env.COOKIE_SECURE === 'true'
    );
}

// SameSite varies by environment. `vercel.app` is a public suffix, so the Vercel
// frontend (caretaker-interface-demo-frontend.vercel.app) and backend
// (caretaker-interface-backend.vercel.app) deployments are CROSS-SITE — the
// session cookie must be SameSite=None there (which requires Secure, provided in
// production). Non-secure local development (localhost:5500 → localhost:3000) is
// same-site and uses SameSite=Lax.
const sameSite = isSecureCookieRequested() ? 'none' : 'lax';

function setSessionCookie(res, token, maxAgeMs) {
    res.cookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        secure: isSecureCookieRequested(),
        sameSite,
        path: '/',
        maxAge: maxAgeMs
    });
}

function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        secure: isSecureCookieRequested(),
        sameSite,
        path: '/'
    });
}

async function requireAuth(req, res, next) {
    try {
        const rawToken = req.cookies ? req.cookies[SESSION_COOKIE_NAME] : undefined;
        if (!rawToken || typeof rawToken !== 'string') {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const session = await findSessionByTokenHash(hashSessionToken(rawToken));
        if (!session) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        req.auth = {
            sessionId: session.session_id,
            user: {
                id: session.id,
                name: session.name,
                email: session.email,
                role: session.role
            }
        };

        await touchSession(session.session_id, session.last_seen_at, LAST_SEEN_THROTTLE_MS);
        next();
    } catch (err) {
        next(err);
    }
}

module.exports = {
    requireAuth,
    setSessionCookie,
    clearSessionCookie,
    SESSION_COOKIE_NAME,
    SESSION_TTL_MS
};