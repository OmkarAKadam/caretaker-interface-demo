'use strict';

const crypto = require('crypto');
const express = require('express');

const { isValidUuid, hashPassword } = require('../auth/password');
const { requireAuth, requireRole, hasActiveRelationship } = require('../auth/middleware');
const {
    safeDevice,
    createDevice,
    getDeviceById,
    listDevicesForBlindUser,
    listAuthorizedDevicesForCaretaker,
    rotateDeviceSecret
} = require('./queries');

const router = express.Router();

const DEVICE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const MAX_FRIENDLY_NAME_LENGTH = 120;
const TOKEN_BYTES = 32;

// Whole router is caretaker-only and session-required. Everything below reads
// through an ACTIVE care relationship (Stage-3 authorization).
router.use(requireAuth);
router.use(requireRole('CARETAKER'));

function generateDeviceToken() {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function validateCreatePayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        const error = new Error('Request body must be a JSON object');
        error.status = 400;
        throw error;
    }

    const blindUserId = typeof body.blindUserId === 'string' ? body.blindUserId.trim() : '';
    if (!isValidUuid(blindUserId)) {
        const error = new Error('blindUserId is required and must be a UUID');
        error.status = 400;
        throw error;
    }

    const deviceIdentifier =
        typeof body.deviceIdentifier === 'string' ? body.deviceIdentifier.trim() : '';
    if (!DEVICE_IDENTIFIER_PATTERN.test(deviceIdentifier)) {
        const error = new Error('deviceIdentifier is required: 1-64 alphanumeric characters plus . _ : / -');
        error.status = 400;
        throw error;
    }

    let friendlyName = null;
    if (body.friendlyName !== undefined && body.friendlyName !== null) {
        friendlyName = typeof body.friendlyName === 'string' ? body.friendlyName.trim() : '';
        if (friendlyName === '') friendlyName = null;
        if (friendlyName && friendlyName.length > MAX_FRIENDLY_NAME_LENGTH) {
            const error = new Error(`friendlyName must be at most ${MAX_FRIENDLY_NAME_LENGTH} characters`);
            error.status = 400;
            throw error;
        }
    }

    return { blindUserId, deviceIdentifier, friendlyName };
}

// POST /api/devices — register a cap device for a linked blind user.
// The plaintext token is returned EXACTLY ONCE; only its bcrypt hash is stored.
router.post('/', async (req, res, next) => {
    try {
        const payload = validateCreatePayload(req.body);
        const { blindUserId, deviceIdentifier, friendlyName } = payload;

        const allowed = await hasActiveRelationship(req.auth.user.id, blindUserId);
        if (!allowed) {
            return res.status(404).json({ error: 'Blind user not found' });
        }

        const token = generateDeviceToken();
        const secretHash = await hashPassword(token);
        const row = await createDevice({
            blindUserId,
            deviceIdentifier,
            friendlyName,
            secretHash
        });
        if (!row) {
            return res.status(500).json({ error: 'Failed to register the device' });
        }

        return res.status(201).json({ device: safeDevice(row), token });
    } catch (err) {
        if (err && err.code === '23505') {
            return res.status(409).json({ error: 'deviceIdentifier is already registered' });
        }
        if (err && err.status) {
            return res.status(err.status).json({ error: err.message });
        }
        next(err);
    }
});

// GET /api/devices?blindUserId=<uuid>
// Without the filter: every device of every linked blind user.
// With the filter: only that user's devices (relationship still enforced).
router.get('/', async (req, res, next) => {
    try {
        if (typeof req.query.blindUserId === 'string' && req.query.blindUserId.trim() !== '') {
            const blindUserId = req.query.blindUserId.trim();
            if (!isValidUuid(blindUserId)) {
                return res.status(400).json({ error: 'Invalid blindUserId filter' });
            }
            const allowed = await hasActiveRelationship(req.auth.user.id, blindUserId);
            if (!allowed) {
                return res.status(404).json({ error: 'Blind user not found' });
            }
            const rows = await listDevicesForBlindUser(blindUserId);
            return res.status(200).json({ devices: rows.map(safeDevice) });
        }

        const rows = await listAuthorizedDevicesForCaretaker(req.auth.user.id);
        return res.status(200).json({ devices: rows.map(safeDevice) });
    } catch (err) {
        next(err);
    }
});

// GET /api/devices/:id — single device, authorized lookup only.
router.get('/:deviceId', async (req, res, next) => {
    try {
        const row = await getDeviceById(req.params.deviceId);
        if (!row) {
            return res.status(404).json({ error: 'Device not found' });
        }
        const allowed = await hasActiveRelationship(req.auth.user.id, row.blind_user_id);
        if (!allowed) {
            return res.status(404).json({ error: 'Device not found' });
        }
        return res.status(200).json({ device: safeDevice(row) });
    } catch (err) {
        next(err);
    }
});

// POST /api/devices/:id/rotate — replace secret_hash.
// The old token stops working immediately; the new one is returned exactly once.
router.post('/:deviceId/rotate', async (req, res, next) => {
    try {
        const row = await getDeviceById(req.params.deviceId);
        if (!row) {
            return res.status(404).json({ error: 'Device not found' });
        }
        const allowed = await hasActiveRelationship(req.auth.user.id, row.blind_user_id);
        if (!allowed) {
            return res.status(404).json({ error: 'Device not found' });
        }

        const token = generateDeviceToken();
        const secretHash = await hashPassword(token);
        const updated = await rotateDeviceSecret(row.id, secretHash);
        if (!updated) {
            return res.status(404).json({ error: 'Device not found' });
        }

        return res.status(200).json({ device: safeDevice(updated), token });
    } catch (err) {
        if (err && err.status) {
            return res.status(err.status).json({ error: err.message });
        }
        next(err);
    }
});

module.exports = router;