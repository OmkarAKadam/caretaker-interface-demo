'use strict';

const express = require('express');
const { isValidUuid } = require('../auth/password');
const {
    requireAuth,
    requireRole
} = require('../auth/middleware');
const {
    findBlindUserById,
    listAuthorizedBlindUsers,
    linkRelationship,
    deactivateRelationship
} = require('./queries');

const router = express.Router();

router.use(requireAuth);
router.use(requireRole('CARETAKER'));

// GET /api/caretaker/blind-users — the caretaker's authorized blind users.
router.get('/blind-users', async (req, res, next) => {
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

// POST /api/caretaker/blind-users/:blindUserId — link (idempotent).
// The caretaker gets a relationship to this blind user. Only the session's
// caretaker id is ever used — any caretakerId in the body/query is ignored so
// a caretaker can never create a relationship on behalf of another user.
router.post('/blind-users/:blindUserId', async (req, res, next) => {
    try {
        const caretakerId = req.auth.user.id;
        const blindUserId = req.params.blindUserId;

        if (!isValidUuid(blindUserId)) {
            return res.status(404).json({ error: 'Blind user not found' });
        }

        if (blindUserId === caretakerId) {
            return res.status(400).json({ error: 'A caretaker cannot link themselves as a blind user' });
        }

        const blindUser = await findBlindUserById(blindUserId);
        if (!blindUser) {
            return res.status(404).json({ error: 'Blind user not found' });
        }

        const { created, relationship } = await linkRelationship(caretakerId, blindUserId);
        return res.status(created ? 201 : 200).json({ relationship });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/caretaker/blind-users/:blindUserId — deactivate the relationship.
// Historical data is preserved; the blind user simply disappears from the
// caretaker's authorized list.
router.delete('/blind-users/:blindUserId', async (req, res, next) => {
    try {
        const caretakerId = req.auth.user.id;
        const blindUserId = req.params.blindUserId;

        if (!isValidUuid(blindUserId)) {
            return res.status(404).json({ error: 'Blind user not found' });
        }

        const relationship = await deactivateRelationship(caretakerId, blindUserId);
        if (!relationship) {
            return res.status(404).json({ error: 'Blind user not found' });
        }

        return res.status(200).json({ success: true, relationship });
    } catch (err) {
        next(err);
    }
});

module.exports = router;