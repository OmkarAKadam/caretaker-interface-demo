'use strict';

// Stage 8B: minimal, dependency-free HTTP security response headers.
//
// CSP is intentionally NOT added here. The static frontend relies on inline
// scripts and CDN resources (Leaflet from unpkg with SRI, Google Fonts), and a
// strict content-security-policy would break the dashboard and Blind Client
// without frontend restructuring (no build tooling is in scope). A safe CSP is
// documented as deferred in README.md / .env.example.
//
// Strict-Transport-Security is only emitted when the server is running for
// production (NODE_ENV=production) or when the request arrived over HTTPS, so
// local development on plain http is never told to upgrade.

const HSTS_MAX_AGE = 15552000; // 180 days

function shouldSendHsts(env, secure) {
    return env === 'production' || secure === true;
}

function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (shouldSendHsts(process.env.NODE_ENV, req.secure)) {
        res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE}; includeSubDomains`);
    }

    next();
}

module.exports = { securityHeaders, shouldSendHsts, HSTS_MAX_AGE };