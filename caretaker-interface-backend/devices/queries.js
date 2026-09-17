'use strict';

const { query } = require('../db/pool');
const { isValidUuid } = require('../auth/password');

const DEVICE_STATUS_ONLINE = 'ONLINE';
const DEVICE_STATUS_OFFLINE = 'OFFLINE';
const DEVICE_STATUS_ERROR = 'ERROR';

// Maps a database row to its API-facing shape. secret_hash NEVER leaves this
// layer: it is only ever read inside the auth middleware and is never included
// in anything returned to clients.
function safeDevice(row) {
    if (!row) return null;
    return {
        id: row.id,
        blindUserId: row.blind_user_id,
        deviceIdentifier: row.device_identifier,
        friendlyName: row.friendly_name,
        status: row.status,
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

async function createDevice({ blindUserId, deviceIdentifier, friendlyName, secretHash }) {
    const result = await query(
        `INSERT INTO devices (blind_user_id, device_identifier, friendly_name, secret_hash, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, blind_user_id, device_identifier, friendly_name, secret_hash, status,
                   last_seen_at, created_at, updated_at`,
        [blindUserId, deviceIdentifier, friendlyName || null, secretHash, DEVICE_STATUS_OFFLINE]
    );
    return result.rows[0] || null;
}

// Full row INCLUDING secret_hash — auth middleware only.
async function getDeviceByIdentifier(deviceIdentifier) {
    const result = await query(
        `SELECT id, blind_user_id, device_identifier, friendly_name, secret_hash, status,
                last_seen_at, created_at, updated_at
         FROM devices
         WHERE device_identifier = $1`,
        [deviceIdentifier]
    );
    return result.rows[0] || null;
}

// Full row INCLUDING secret_hash — only used internally (rotate) and to check
// existence + ownership BEFORE any sensitive read.
async function getDeviceById(deviceId) {
    if (!isValidUuid(deviceId)) return null;
    const result = await query(
        `SELECT id, blind_user_id, device_identifier, friendly_name, secret_hash, status,
                last_seen_at, created_at, updated_at
         FROM devices
         WHERE id = $1`,
        [deviceId]
    );
    return result.rows[0] || null;
}

async function listDevicesForBlindUser(blindUserId) {
    const result = await query(
        `SELECT id, blind_user_id, device_identifier, friendly_name, secret_hash, status,
                last_seen_at, created_at, updated_at
         FROM devices
         WHERE blind_user_id = $1
         ORDER BY device_identifier`,
        [blindUserId]
    );
    return result.rows;
}

// Every device of every blind user the caretaker has an ACTIVE relationship
// with. The JOIN enforces Stage-3 authorization in SQL, not just in JS.
async function listAuthorizedDevicesForCaretaker(caretakerId) {
    const result = await query(
        `SELECT d.id, d.blind_user_id, d.device_identifier, d.friendly_name, d.secret_hash,
                d.status, d.last_seen_at, d.created_at, d.updated_at
         FROM devices d
         JOIN care_relationships cr ON cr.blind_user_id = d.blind_user_id
         WHERE cr.caretaker_id = $1 AND cr.status = 'ACTIVE'
         ORDER BY d.device_identifier`,
        [caretakerId]
    );
    return result.rows;
}

// Throttled by the caller. Flips the device ONLINE and refreshes last_seen_at.
async function touchDeviceSeen(deviceId) {
    await query(
        `UPDATE devices
         SET last_seen_at = now(),
             status = $1,
             updated_at = now()
         WHERE id = $2`,
        [DEVICE_STATUS_ONLINE, deviceId]
    );
}

// Replaces secret_hash (token rotation). The old hash is simply overwritten,
// which invalidates the previous token immediately.
async function rotateDeviceSecret(deviceId, newSecretHash) {
    const result = await query(
        `UPDATE devices
         SET secret_hash = $1,
             updated_at = now()
         WHERE id = $2
         RETURNING id, blind_user_id, device_identifier, friendly_name, secret_hash, status,
                   last_seen_at, created_at, updated_at`,
        [newSecretHash, deviceId]
    );
    return result.rows[0] || null;
}

// Permanently deletes a registered device row. Returns the deleted row's id or
// null. Historical telemetry rows are untouched (they keep their own FK/ids).
async function deleteDevice(deviceId) {
    if (!isValidUuid(deviceId)) return null;
    const result = await query(
        `DELETE FROM devices
         WHERE id = $1
         RETURNING id`,
        [deviceId]
    );
    return result.rows[0] || null;
}

module.exports = {
    DEVICE_STATUS_ONLINE,
    DEVICE_STATUS_OFFLINE,
    DEVICE_STATUS_ERROR,
    safeDevice,
    createDevice,
    getDeviceByIdentifier,
    getDeviceById,
    listDevicesForBlindUser,
    listAuthorizedDevicesForCaretaker,
    touchDeviceSeen,
    rotateDeviceSecret,
    deleteDevice
};