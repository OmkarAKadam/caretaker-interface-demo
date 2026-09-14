'use strict';

const { verifyPassword } = require('../auth/password');
const { getDeviceByIdentifier, touchDeviceSeen } = require('./queries');

const DEVICE_HEADER_ID = 'x-device-id';
const DEVICE_HEADER_TOKEN = 'x-device-token';

// Same charset the ESP + caretaker UI already use for identifiers (BG001, …).
const DEVICE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

// secret_hash is a bcrypt hash, never a reversible secret.
const SECRET_HASH_PREFIX = '$2';

// last_seen_at is refreshed at most once per device per window. In-memory by
// design: a restart only delays the next write, never exposes anything.
const DEVICE_TOUCH_THROTTLE_MS = (() => {
    const raw = parseInt(process.env.DEVICE_TOUCH_THROTTLE_MS, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();

const lastSeenTouchedAt = new Map();

// Authenticates a cap device by its pairing credentials.
//
//   X-Device-Id:    the device identifier (e.g. BG001)
//   X-Device-Token: the 32-byte token issued once at pairing/rotation
//
// On success req.device = { id, blindUserId, identifier }. It never reveals
// secret_hash or the token, and it answers 401 with the SAME generic message
// for a missing, malformed, unknown, or wrong secret so an attacker cannot
// tell which part was wrong.
async function requireDeviceAuth(req, res, next) {
    try {
        const identifier = req.headers[DEVICE_HEADER_ID];
        const token = req.headers[DEVICE_HEADER_TOKEN];

        const identifiersOk = typeof identifier === 'string' && identifier.length > 0;
        const tokensOk = typeof token === 'string' && token.length > 0;

        if (!identifiersOk || !tokensOk) {
            return res.status(401).json({ error: 'Invalid device credentials' });
        }

        if (!DEVICE_IDENTIFIER_PATTERN.test(identifier)) {
            return res.status(401).json({ error: 'Invalid device credentials' });
        }

        if (Buffer.byteLength(token, 'utf8') > 256) {
            return res.status(401).json({ error: 'Invalid device credentials' });
        }

        const device = await getDeviceByIdentifier(identifier);
        if (!device) {
            return res.status(401).json({ error: 'Invalid device credentials' });
        }

        const passwordHash = device.secret_hash;
        if (typeof passwordHash !== 'string' || !passwordHash.startsWith(SECRET_HASH_PREFIX)) {
            // Un-paired device: no secret stored yet.
            return res.status(401).json({ error: 'Invalid device credentials' });
        }

        const valid = await verifyPassword(token, passwordHash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid device credentials' });
        }

        req.device = {
            id: device.id,
            blindUserId: device.blind_user_id,
            identifier: device.device_identifier
        };

        const now = Date.now();
        const lastTouch = lastSeenTouchedAt.get(device.id) || 0;
        if (now - lastTouch >= DEVICE_TOUCH_THROTTLE_MS) {
            lastSeenTouchedAt.set(device.id, now);
            await touchDeviceSeen(device.id);
        }

        next();
    } catch (err) {
        next(err);
    }
}

module.exports = { requireDeviceAuth };