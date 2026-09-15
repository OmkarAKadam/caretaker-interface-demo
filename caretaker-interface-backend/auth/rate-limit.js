'use strict';

// Minimal in-memory sliding-window rate limiter for the authentication routes.
// The Wall-E chat route already uses this exact pattern inline in server.js;
// reuse it here rather than introducing a new rate-limiting system.
//
// Stage 8B: an optional `key` option selects the bucket key (e.g. an
// authenticated device identifier) instead of the default req.ip, so per-client
// protection can be keyed on an identity the server already verified.

const DEFAULT_MAX = (() => {
    const raw = parseInt(process.env.AUTH_RATE_MAX, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 20;
})();

const DEFAULT_WINDOW_MS = (() => {
    const raw = parseInt(process.env.AUTH_RATE_WINDOW_MS, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000;
})();

const CLEANUP_THRESHOLD = 1000;

function createRateLimiter(options) {
    const opts = options || {};
    const max = Number.isFinite(opts.max) ? opts.max : DEFAULT_MAX;
    const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEFAULT_WINDOW_MS;
    const keyFor = typeof opts.key === 'function' ? opts.key : (req) => req.ip || 'unknown';

    const buckets = new Map();
    let callsSinceCleanup = 0;

    return function rateLimit(req, res, next) {
        const key = keyFor(req, res);
        const now = Date.now();

        let bucket = buckets.get(key);
        if (!bucket || bucket.windowStart + windowMs <= now) {
            bucket = { windowStart: now, count: 0 };
            buckets.set(key, bucket);
        }
        bucket.count += 1;

        callsSinceCleanup += 1;
        if (callsSinceCleanup >= CLEANUP_THRESHOLD) {
            callsSinceCleanup = 0;
            const cutoff = now - windowMs;
            for (const [key, entry] of buckets) {
                if (entry.windowStart + windowMs <= cutoff) {
                    buckets.delete(key);
                }
            }
        }

        if (bucket.count > max) {
            return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
        }

        next();
    };
}

module.exports = { createRateLimiter, DEFAULT_MAX, DEFAULT_WINDOW_MS };