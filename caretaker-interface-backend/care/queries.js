'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');
const { hashPassword, isValidUuid } = require('../auth/password');

const BLIND_USER_ROLE = 'BLIND_USER';
const RELATIONSHIP_ACTIVE = 'ACTIVE';
const RELATIONSHIP_INACTIVE = 'INACTIVE';

// Blind users have no login flow at this stage, but users.password_hash is
// NOT NULL. Storing a bcrypt hash of a discarded random secret satisfies the
// constraint while guaranteeing no usable password ever exists for the account.
async function insertBlindUser({ name, email }) {
    const discardedSecret = crypto.randomBytes(32).toString('base64url');
    const passwordHash = await hashPassword(discardedSecret);

    const result = await query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, email, role`,
        [name, email, passwordHash, BLIND_USER_ROLE]
    );
    return result.rows[0];
}

// Blind users are only findable by caretaker id via an ACTIVE relationship.
// Any other reference must look identical to "does not exist" (404).
async function listAuthorizedBlindUsers(caretakerId) {
    const result = await query(
        `SELECT u.id, u.name, u.email, u.role, cr.status AS relationship_status
         FROM care_relationships cr
         JOIN users u ON u.id = cr.blind_user_id
         WHERE cr.caretaker_id = $1 AND cr.status = $2
         ORDER BY u.name`,
        [caretakerId, RELATIONSHIP_ACTIVE]
    );
    return result.rows;
}

// Returns the blind user only if the caretaker has an ACTIVE relationship.
async function getAuthorizedBlindUser(caretakerId, blindUserId) {
    if (!isValidUuid(blindUserId)) {
        return null;
    }
    const result = await query(
        `SELECT u.id, u.name, u.email, u.role
         FROM care_relationships cr
         JOIN users u ON u.id = cr.blind_user_id
         WHERE cr.caretaker_id = $1
           AND cr.blind_user_id = $2
           AND cr.status = $3`,
        [caretakerId, blindUserId, RELATIONSHIP_ACTIVE]
    );
    return result.rows[0] || null;
}

async function updateBlindUser(blindUserId, updates) {
    const columns = Object.keys(updates);

    if (columns.length === 0) {
        return null;
    }

    const sets = [];
    const values = [];
    let index = 1;

    for (const column of columns) {
        sets.push(`${column} = $${index}`);
        values.push(updates[column]);
        index += 1;
    }

    const idParam = `$${index}`;
    const roleParam = `$${index + 1}`;
    values.push(blindUserId, 'BLIND_USER');
    const result = await query(
        `UPDATE users
         SET ${sets.join(', ')}
         WHERE id = ${idParam}
           AND role = ${roleParam}
         RETURNING id, name, email, role`,
        values
    );
    return result.rows[0] || null;
}

// Link a caretaker to a blind user. Idempotent:
//  - no existing relation        -> insert ACTIVE (created: true)
//  - existing INACTIVE relation  -> reactivate (created: false)
//  - existing ACTIVE relation    -> unchanged  (created: false)
async function linkRelationship(caretakerId, blindUserId) {
    const existing = await query(
        `SELECT id, blind_user_id, caretaker_id, status
         FROM care_relationships
         WHERE caretaker_id = $1 AND blind_user_id = $2`,
        [caretakerId, blindUserId]
    );

    const row = existing.rows[0];
    if (row) {
        if (row.status !== RELATIONSHIP_ACTIVE) {
            const updated = await query(
                `UPDATE care_relationships
                 SET status = $1
                 WHERE id = $2
                 RETURNING id, blind_user_id, caretaker_id, status`,
                [RELATIONSHIP_ACTIVE, row.id]
            );
            return { created: false, relationship: updated.rows[0] };
        }
        return { created: false, relationship: row };
    }

    try {
        const inserted = await query(
            `INSERT INTO care_relationships (blind_user_id, caretaker_id, status)
             VALUES ($1, $2, $3)
             RETURNING id, blind_user_id, caretaker_id, status`,
            [blindUserId, caretakerId, RELATIONSHIP_ACTIVE]
        );
        return { created: true, relationship: inserted.rows[0] };
    } catch (err) {
        if (err && err.code === '23505') {
            const updated = await query(
                `UPDATE care_relationships
                 SET status = $1
                 WHERE caretaker_id = $2 AND blind_user_id = $3
                 RETURNING id, blind_user_id, caretaker_id, status`,
                [RELATIONSHIP_ACTIVE, caretakerId, blindUserId]
            );
            return { created: false, relationship: updated.rows[0] };
        }
        throw err;
    }
}

// Deactivate = set status to INACTIVE. Historical data is preserved.
// Returns null when no relationship row exists (caller returns 404).
async function deactivateRelationship(caretakerId, blindUserId) {
    const result = await query(
        `UPDATE care_relationships
         SET status = $1
         WHERE caretaker_id = $2 AND blind_user_id = $3
         RETURNING id, blind_user_id, caretaker_id, status`,
        [RELATIONSHIP_INACTIVE, caretakerId, blindUserId]
    );
    return result.rows[0] || null;
}

// A link target must be an existing user with role BLIND_USER.
async function findBlindUserById(blindUserId) {
    if (!isValidUuid(blindUserId)) {
        return null;
    }
    const result = await query(
        `SELECT id, name, email, role
         FROM users
         WHERE id = $1 AND role = $2`,
        [blindUserId, BLIND_USER_ROLE]
    );
    return result.rows[0] || null;
}

module.exports = {
    BLIND_USER_ROLE,
    RELATIONSHIP_ACTIVE,
    RELATIONSHIP_INACTIVE,
    insertBlindUser,
    listAuthorizedBlindUsers,
    getAuthorizedBlindUser,
    updateBlindUser,
    linkRelationship,
    deactivateRelationship,
    findBlindUserById
};