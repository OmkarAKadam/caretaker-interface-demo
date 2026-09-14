'use strict';

// Stage 5 — PostgreSQL persistence for the runtime telemetry that currently
// lives only in server memory (events, latest-state snapshots, Wall-E
// conversations). These queries are used by server.js (event / latest-state
// persistence, boot rehydration) and by ai/conversation-store.js (Wall-E).
//
// All queries are parameterized. Nothing here ever reads or exposes
// secret_hash or device tokens.

const { query } = require('../db/pool');
const { isValidUuid } = require('../auth/password');

// ---------------------------------------------------------------------------
// Identifier → UUID resolution
// ---------------------------------------------------------------------------
// In-memory events carry device identity as the *identifier string* (e.g.
// "BG001") and blind-user identity as the *user-UUID string*. These resolvers
// map those strings to their UUID FK targets so the existing UUID columns can
// be populated for joins. Unknown identities resolve to NULL — they never
// grant anything (an unknown MQTT deviceId is never attached to a user).

const DEVICE_UUID_CACHE_MAX = 256;
const deviceUuidCache = new Map();

async function resolveDeviceUuid(identifier) {
    if (!identifier || typeof identifier !== 'string') {
        return null;
    }
    if (deviceUuidCache.has(identifier)) {
        return deviceUuidCache.get(identifier);
    }
    const result = await query(
        `SELECT id FROM devices WHERE device_identifier = $1`,
        [identifier]
    );
    const uuid = result.rows.length ? result.rows[0].id : null;
    // Cache only positive resolutions so newly-registered devices are picked up.
    if (uuid) {
        if (deviceUuidCache.size >= DEVICE_UUID_CACHE_MAX) {
            deviceUuidCache.clear();
        }
        deviceUuidCache.set(identifier, uuid);
    }
    return uuid;
}

async function resolveBlindUserUuid(identifier) {
    if (!identifier || typeof identifier !== 'string' || !isValidUuid(identifier)) {
        return null;
    }
    const result = await query(
        `SELECT id FROM users WHERE id = $1 AND role = 'BLIND_USER'`,
        [identifier]
    );
    return result.rows.length ? result.rows[0].id : null;
}

// Reverse lookup used by Wall-E boot rehydration to restore the string
// device identifier on resumed sessions.
async function resolveDeviceIdentifier(uuid) {
    if (!uuid || !isValidUuid(uuid)) {
        return null;
    }
    const result = await query(
        `SELECT device_identifier FROM devices WHERE id = $1`,
        [uuid]
    );
    return result.rows.length ? result.rows[0].device_identifier : null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// Maps the in-memory event object to its database row. UUID FKs are resolved
// for safe joins; the string identifiers are always preserved too. heart_rate
// is clamped to the events table's INTEGER CHECK range (0..400).
//
// MQTT-created events carry only the *device identifier* and no blind-user
// identity. When that device belongs to a registered earbud/cap record, the
// event is bound to the device's owner (blind_user_id) so scoped caretaker
// views (GET /api/events?blindUserId=...) include it. An unknown device
// identifier resolves to NULL and the event stays unbound — identity is never
// invented from an unregistered deviceId.
async function mapEventForInsert(event) {
    const deviceId = await resolveDeviceUuid(event.deviceId || null);
    let blindUserId = await resolveBlindUserUuid(event.blindUserId || null);

    if (!blindUserId && deviceId) {
        const owner = await query(
            `SELECT blind_user_id FROM devices WHERE id = $1`,
            [deviceId]
        );
        if (owner.rows.length && owner.rows[0].blind_user_id) {
            blindUserId = owner.rows[0].blind_user_id;
        }
    }

    const heartRate = (() => {
        const hr = event.heartRate;
        if (hr === null || hr === undefined || !Number.isFinite(hr)) {
            return null;
        }
        return Math.max(0, Math.min(400, Math.round(hr)));
    })();

    return {
        alertId: event.alertId,
        blindUserId,
        deviceId,
        blindUserIdentifier: event.blindUserId || blindUserId || null,
        deviceIdentifier: event.deviceId || null,
        trigger: event.trigger,
        status: event.status,
        heartRate,
        latitude: Number.isFinite(event.latitude) ? event.latitude : null,
        longitude: Number.isFinite(event.longitude) ? event.longitude : null,
        source: event.source || null,
        message: event.message || null,
        distance: Number.isFinite(event.distance) && event.distance >= 0 ? event.distance : null,
        angle: Number.isFinite(event.angle) ? event.angle : null,
        danger: event.danger || null,
        occurredAt: event.timestamp || new Date().toISOString()
    };
}

// Idempotent insert: a duplicate alertId is ignored (returns false). This is
// what makes queued retries safe — a retried event can never be inserted twice.
async function insertEvent(event) {
    const result = await query(
        `INSERT INTO events (
            alert_id, blind_user_id, device_id,
            blind_user_identifier, device_identifier,
            trigger, status, heart_rate, latitude, longitude,
            source, message, distance, angle, danger, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (alert_id) DO NOTHING
         RETURNING id`,
        [
            event.alertId, event.blindUserId, event.deviceId,
            event.blindUserIdentifier, event.deviceIdentifier,
            event.trigger, event.status, event.heartRate, event.latitude, event.longitude,
            event.source, event.message, event.distance, event.angle, event.danger,
            event.occurredAt
        ]
    );
    return result.rows.length > 0;
}

const EVENT_SELECT_COLUMNS = `
    alert_id,
    blind_user_identifier,
    device_identifier,
    trigger,
    status,
    heart_rate,
    latitude,
    longitude,
    source,
    message,
    distance,
    angle,
    danger,
    occurred_at
`;

function rowToEvent(row) {
    return {
        alertId: row.alert_id,
        trigger: row.trigger,
        status: row.status,
        heartRate: row.heart_rate,
        latitude: row.latitude,
        longitude: row.longitude,
        source: row.source,
        message: row.message,
        distance: row.distance,
        angle: row.angle,
        danger: row.danger,
        timestamp: row.occurred_at ? new Date(row.occurred_at).toISOString() : row.occurred_at,
        deviceId: row.device_identifier,
        blindUserId: row.blind_user_identifier
    };
}

// The `limit` most recent events, in chronological order (matching the order
// the frontend expects from the in-memory Map).
async function listRecentEvents(limit) {
    const result = await query(
        `SELECT ${EVENT_SELECT_COLUMNS}
         FROM events
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT $1`,
        [limit]
    );
    return result.rows.slice().reverse().map(rowToEvent);
}

// Stage 6: scoped variant — only events belonging to a specific blind user.
async function listRecentEventsForBlindUser(blindUserId, limit) {
    const result = await query(
        `SELECT ${EVENT_SELECT_COLUMNS}
         FROM events
         WHERE blind_user_identifier = $1
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT $2`,
        [blindUserId, limit]
    );
    return result.rows.slice().reverse().map(rowToEvent);
}

async function findEventByAlertId(alertId) {
    const result = await query(
        `SELECT ${EVENT_SELECT_COLUMNS} FROM events WHERE alert_id = $1`,
        [alertId]
    );
    return result.rows.length ? rowToEvent(result.rows[0]) : null;
}

async function updateEventStatus(alertId, status) {
    const result = await query(
        `UPDATE events SET status = $2 WHERE alert_id = $1 RETURNING id`,
        [alertId, status]
    );
    return result.rows.length > 0;
}

// Highest sequence number among persisted MQTT-* alert ids, so a restart cannot
// reuse an id the database already holds (collisions would 409-loop forever).
async function loadMaxMqttSeq() {
    const result = await query(
        `SELECT MAX(parsed.seq)::bigint AS seq
         FROM (
             SELECT (regexp_match(alert_id, '^MQTT-[A-Z_]+-([0-9]+)$'))[1]::bigint AS seq
             FROM events
             WHERE alert_id LIKE 'MQTT-%'
         ) parsed`
    );
    const seq = result.rows[0] && result.rows[0].seq;
    return seq === null || seq === undefined ? 0 : Number(seq);
}

// ---------------------------------------------------------------------------
// Latest runtime state (single-row latest_states)
// ---------------------------------------------------------------------------

function toJson(value) {
    if (value === null || value === undefined) {
        return null;
    }
    return JSON.stringify(value);
}

// Full-row upsert. The caller supplies the whole snapshot (all five streams),
// which mirrors the in-memory state exactly and avoids read-modify-write.
async function upsertLatestState(snapshot) {
    const snap = snapshot || {};
    await query(
        `INSERT INTO latest_states (id, location, device_status, heart_rate, fall, buzzer, updated_at)
         VALUES (1, $1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, $5::text, now())
         ON CONFLICT (id) DO UPDATE SET
            location = EXCLUDED.location,
            device_status = EXCLUDED.device_status,
            heart_rate = EXCLUDED.heart_rate,
            fall = EXCLUDED.fall,
            buzzer = EXCLUDED.buzzer,
            updated_at = now()`,
        [
            toJson(snap.location),
            toJson(snap.deviceStatus),
            toJson(snap.heartRate),
            toJson(snap.fall),
            typeof snap.buzzer === 'string' ? snap.buzzer : null
        ]
    );
}

async function loadLatestState() {
    const result = await query(
        `SELECT location, device_status, heart_rate, fall, buzzer FROM latest_states WHERE id = 1`
    );
    if (!result.rows.length) {
        return null;
    }
    const row = result.rows[0];
    return {
        location: row.location || null,
        deviceStatus: row.device_status || null,
        heartRate: row.heart_rate || null,
        fall: row.fall || null,
        buzzer: row.buzzer || null
    };
}

// ---------------------------------------------------------------------------
// Wall-E conversations (walle_sessions / walle_messages)
// ---------------------------------------------------------------------------

async function upsertWallSession(clientSessionId, { deviceId, blindUserId, lastActiveAt } = {}) {
    // deviceId is the device *identifier* string (BG001), blindUserId is the
    // *user UUID*. Both are resolved so the UUID FK columns get real targets.
    const [resolvedDevice, resolvedBlind] = await Promise.all([
        resolveDeviceUuid(deviceId || null),
        resolveBlindUserUuid(blindUserId || null)
    ]);
    const result = await query(
        `INSERT INTO walle_sessions (client_session_id, blind_user_id, device_id, last_active_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (client_session_id) DO UPDATE SET
            last_active_at = EXCLUDED.last_active_at,
            blind_user_id   = COALESCE(EXCLUDED.blind_user_id, walle_sessions.blind_user_id),
            device_id       = COALESCE(EXCLUDED.device_id, walle_sessions.device_id)
         RETURNING id, blind_user_id, device_id, started_at, last_active_at`,
        [clientSessionId, resolvedBlind, resolvedDevice, lastActiveAt || new Date().toISOString()]
    );
    return result.rows[0] || null;
}

// Drops a previous (expired) row so a genuinely new session restarts fresh.
async function deleteWallSessionByClientId(clientSessionId) {
    await query(
        `DELETE FROM walle_sessions WHERE client_session_id = $1`,
        [clientSessionId]
    );
}

async function listWallTurnTimestamps(sessionDbId) {
    const result = await query(
        `SELECT created_at FROM walle_messages WHERE session_id = $1`,
        [sessionDbId]
    );
    return new Set(result.rows.map((row) => {
        const value = row.created_at;
        if (!value) return NaN;
        // pg returns timestamptz as a JS Date; Date.parse() on a Date object
        // drops the milliseconds, so compare by epoch ms directly.
        return typeof value.getTime === 'function' ? value.getTime() : Date.parse(value);
    }));
}

async function insertWallMessage(sessionDbId, role, content, model, createdAt) {
    await query(
        `INSERT INTO walle_messages (session_id, role, content, model, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionDbId, role, content, model || null, createdAt]
    );
}

async function listWallTurns(sessionDbId, limit) {
    const result = await query(
        `SELECT role, content, model, created_at
         FROM walle_messages
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [sessionDbId, limit]
    );
    return result.rows.slice().reverse().map((row) => ({
        role: row.role,
        text: row.content,
        timestamp: new Date(row.created_at).toISOString(),
        model: row.model || null
    }));
}

async function listWallSessions() {
    const result = await query(
        `SELECT id, client_session_id, blind_user_id, device_id, started_at, last_active_at
         FROM walle_sessions
         ORDER BY last_active_at DESC`,
        []
    );
    return result.rows;
}

module.exports = {
    resolveDeviceUuid,
    resolveBlindUserUuid,
    resolveDeviceIdentifier,
    mapEventForInsert,
    insertEvent,
    listRecentEvents,
    findEventByAlertId,
    updateEventStatus,
    loadMaxMqttSeq,
    upsertLatestState,
    loadLatestState,
    upsertWallSession,
    deleteWallSessionByClientId,
    listWallTurnTimestamps,
    insertWallMessage,
    listWallTurns,
    listWallSessions,
    listRecentEventsForBlindUser
};