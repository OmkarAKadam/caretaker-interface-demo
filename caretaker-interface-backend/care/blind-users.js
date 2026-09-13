'use strict';

const express = require('express');
const {
    normalizeEmail,
    isValidEmail,
    isValidName,
    safeUser
} = require('../auth/password');
const {
    requireAuth,
    requireRole,
    requireBlindUserAccess
} = require('../auth/middleware');
const {
    BLIND_USER_ROLE,
    insertBlindUser,
    listAuthorizedBlindUsers,
    getAuthorizedBlindUser,
    updateBlindUser
} = require('./queries');

const router = express.Router();

router.use(requireAuth);
router.use(requireRole('CARETAKER'));

// Only BLIND_USER may be assigned through this endpoint. Any other submitted
// role is rejected so role injection can never escalate to CARETAKER/ADMIN.
function assertRoleNotInjected(body) {
    if (body && body.role !== undefined && body.role !== null && body.role !== BLIND_USER_ROLE) {
        const error = new Error(`Invalid role — expected "${BLIND_USER_ROLE}"`);
        error.status = 400;
        throw error;
    }
}

function validateBlindUserPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        const error = new Error('Request body must be a JSON object');
        error.status = 400;
        throw error;
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!isValidName(name)) {
        const error = new Error('Name is required (maximum 120 characters)');
        error.status = 400;
        throw error;
    }

    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) {
        const error = new Error('A valid email is required');
        error.status = 400;
        throw error;
    }

    return { name, email };
}

// POST /api/blind-users — create a blind-user identity.
// The creator is NOT automatically linked; the blind user only appears in
// authorized lists once a caretaker establishes a relationship.
router.post('/', async (req, res, next) => {
    try {
        assertRoleNotInjected(req.body);
        const { name, email } = validateBlindUserPayload(req.body);

        const user = await insertBlindUser({ name, email });
        return res.status(201).json({ user: safeUser(user) });
    } catch (err) {
        if (err && err.code === '23505') {
            return res.status(409).json({ error: 'Email already in use' });
        }
        if (err && err.status) {
            return res.status(err.status).json({ error: err.message });
        }
        next(err);
    }
});

// GET /api/blind-users — list the caretaker's authorized blind users.
router.get('/', async (req, res, next) => {
    try {
        const rows = await listAuthorizedBlindUsers(req.auth.user.id);
        const blindUsers = rows.map((row) => ({
            id: row.id,
            name: row.name,
            email: row.email,
            role: row.role,
            relationshipStatus: row.relationship_status
        }));
        return res.status(200).json({ blindUsers });
    } catch (err) {
        next(err);
    }
});

// GET /api/blind-users/:blindUserId — authorized lookup only (IDOR-protected).
router.get('/:blindUserId', requireBlindUserAccess('blindUserId'), async (req, res, next) => {
    try {
        const user = await getAuthorizedBlindUser(req.auth.user.id, req.params.blindUserId);
        if (!user) {
            return res.status(404).json({ error: 'Blind user not found' });
        }
        return res.status(200).json({ user: safeUser(user) });
    } catch (err) {
        next(err);
    }
});

// PATCH /api/blind-users/:blindUserId — update identity (IDOR-protected).
router.patch('/:blindUserId', requireBlindUserAccess('blindUserId'), async (req, res, next) => {
    try {
        assertRoleNotInjected(req.body);
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
            return res.status(400).json({ error: 'Request body must be a JSON object' });
        }

        const updates = {};

        if (req.body.name !== undefined) {
            const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
            if (!isValidName(name)) {
                return res.status(400).json({ error: 'Name must be a non-empty string (maximum 120 characters)' });
            }
            updates.name = name;
        }

        if (req.body.email !== undefined) {
            const email = normalizeEmail(req.body.email);
            if (!isValidEmail(email)) {
                return res.status(400).json({ error: 'A valid email is required' });
            }
            updates.email = email;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'Nothing to update — provide name or email' });
        }

        const user = await updateBlindUser(req.params.blindUserId, updates);
        if (!user) {
            return res.status(404).json({ error: 'Blind user not found' });
        }
        return res.status(200).json({ user: safeUser(user) });
    } catch (err) {
        if (err && err.code === '23505') {
            return res.status(409).json({ error: 'Email already in use' });
        }
        if (err && err.status) {
            return res.status(err.status).json({ error: err.message });
        }
        next(err);
    }
});

module.exports = router;