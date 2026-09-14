const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const authRouter = require('./auth/routes');
const blindUsersRouter = require('./care/blind-users');
const careRouter = require('./care/caretaker');
const { createMqttClient } = require('./mqtt/client');
const { TOPICS } = require('./mqtt/topics');
const { getSystemPrompt } = require('./ai/system-prompt');
const { chatWithFallback } = require('./ai/model-router');
const { buildTrustedContext } = require('./ai/context-builder');
const conversationStore = require('./ai/conversation-store');
const { requireAuth, requireRole, hasActiveRelationship, SESSION_COOKIE_NAME } = require('./auth/middleware');
const { hashSessionToken, findSessionByTokenHash } = require('./auth/sessions');
const { isValidUuid } = require('./auth/password');
const { requireDeviceAuth } = require('./devices/middleware');
const devicesRouter = require('./devices/routes');
const queries = require('./telemetry/queries');
const { createPersistenceQueue } = require('./telemetry/queue');

const app = express();
const PORT = process.env.PORT || 3000;

const mqttClient = createMqttClient(handleMqttMessage);

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5500', 'http://127.0.0.1:5500'];

function getAllowedOrigins() {
    const fromEnv = process.env.CORS_ORIGIN;
    if (fromEnv) {
        return fromEnv.split(',').map((o) => o.trim()).filter(Boolean);
    }
    return DEFAULT_ALLOWED_ORIGINS;
}

const allowedOrigins = getAllowedOrigins();

app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
    },
    credentials: true
}));
app.use(cookieParser());
app.use(express.json());

const events = new Map();
let latestLocation = null;
let latestDeviceStatus = null;
let latestFall = null;
let latestBuzzerState = null;
let lastHeartRate = null;
let mqttSeq = 0;

// ── Stage 5 persistence (bounded, best-effort) ──────────────────────────
// The in-memory variables above remain the synchronous hot path. Writes are
// mirrored to PostgreSQL when available; the queue below absorbs database
// downtime without ever blocking the request path.

const EVENTS_WINDOW_MAX = (() => {
    const raw = parseInt(process.env.EVENTS_WINDOW_MAX, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 100;
})();

const TELEMETRY_QUEUE_MAX = (() => {
    const raw = parseInt(process.env.TELEMETRY_QUEUE_MAX, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 500;
})();

function snapshotRuntimeState() {
    return {
        location: latestLocation,
        deviceStatus: latestDeviceStatus,
        heartRate: lastHeartRate,
        fall: latestFall,
        buzzer: latestBuzzerState
    };
}

// Runs one queued item. All three kinds are idempotent at the SQL level
// (ON CONFLICT DO NOTHING, status UPDATE, single-row upsert), so a retried
// item can never corrupt or duplicate telemetry.
function applyPersistence(item) {
    switch (item && item.kind) {
        case 'event':
            return queries.insertEvent(item);
        case 'eventUpdate':
            return queries.updateEventStatus(item.alertId, item.status);
        case 'latestState':
            return queries.upsertLatestState({
                location: item.location,
                deviceStatus: item.deviceStatus,
                heartRate: item.heartRate,
                fall: item.fall,
                buzzer: item.buzzer
            });
        default:
            return false;
    }
}

const persistenceQueue = createPersistenceQueue({
    max: TELEMETRY_QUEUE_MAX,
    apply: applyPersistence
});

// Fire-and-forget event persistence (MQTT path). Durability is a bonus here:
// the event is already live in memory and broadcast over SSE. When the
// database is down the write is queued and retried.
async function persistEventBestEffort(event) {
    try {
        const mapped = await queries.mapEventForInsert(event);
        // MQTT events arrive with no blind-user identity; persistence resolves
        // one from their registered device. Back-fill the same (in-memory)
        // object — it is also the live `events` Map entry — so scoped memory
        // fallback and Wall-E context agree with the persisted row.
        if (mapped && mapped.blindUserIdentifier && !event.blindUserId) {
            event.blindUserId = mapped.blindUserIdentifier;
        }
        try {
            await queries.insertEvent(mapped);
        } catch (dbErr) {
            persistenceQueue.enqueue(Object.assign({ kind: 'event' }, mapped));
            console.warn('[Persistence] DB unavailable — event queued for retry:', dbErr && dbErr.message ? dbErr.message : dbErr);
        }
        return true;
    } catch (err) {
        console.error('[Persistence] Event persistence failed:', err && err.message ? err.message : err);
        return false;
    }
}

// Awaited by PATCH so a status change is durable (or queued) before the
// client gets its 200.
async function persistEventStatusBestEffort(alertId, status) {
    try {
        await queries.updateEventStatus(alertId, status);
    } catch (dbErr) {
        persistenceQueue.enqueue({ kind: 'eventUpdate', alertId, status });
        console.warn('[Persistence] DB unavailable — status update queued:', dbErr && dbErr.message ? dbErr.message : dbErr);
    }
}

// Latest-state snapshots are frequent, idempotent, single-row upserts. They
// always flow through the queue: serialized, bounded, drop-oldest on overflow.
function persistLatestStateBestEffort() {
    persistenceQueue.enqueue(Object.assign({ kind: 'latestState' }, snapshotRuntimeState()));
}

const HEART_RATE_COOLDOWN_MS = 30000;
const HEART_RATE_ALERT_LOW = 60;
const HEART_RATE_ALERT_HIGH = 100;
const lastHeartRateAlertAt = {};
const sseClients = new Set();

const VALID_TRIGGERS = ['SOS', 'HEART_RATE', 'SOS_AND_HEART_RATE', 'NORMAL', 'OBSTACLE_LEFT', 'OBSTACLE_CENTER', 'OBSTACLE_RIGHT'];
const VALID_STATUSES = ['NORMAL', 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'];

const ALLOWED_TRANSITIONS = {
    ACTIVE: ['ACKNOWLEDGED', 'RESOLVED'],
    ACKNOWLEDGED: ['RESOLVED'],
    RESOLVED: [],
    NORMAL: []
};

function isValidFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function isValidLatitude(value) {
    return isValidFiniteNumber(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value) {
    return isValidFiniteNumber(value) && value >= -180 && value <= 180;
}

function isValidTimestamp(value) {
    return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

const WALLE_SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const WALLE_SESSION_ID_MAX_LENGTH = 128;

function isValidWalleSessionId(value) {
    return typeof value === 'string' &&
        value.length > 0 &&
        value.length <= WALLE_SESSION_ID_MAX_LENGTH &&
        WALLE_SESSION_ID_PATTERN.test(value);
}

function broadcastEvent(event) {
    const data = `event: event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
        client.write(data);
    }
}

function validateLocation(location) {
    if (!location || typeof location !== 'object' || Array.isArray(location)) {
        return 'Invalid location payload';
    }
    if (!isValidLatitude(location.latitude)) {
        return 'Invalid latitude';
    }
    if (!isValidLongitude(location.longitude)) {
        return 'Invalid longitude';
    }
    if (location.timestamp !== undefined && location.timestamp !== null && !isValidTimestamp(location.timestamp)) {
        return 'Invalid timestamp';
    }
    return null;
}

function validateEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return 'Invalid event payload';
    }

    if (typeof event.alertId !== 'string' || event.alertId.trim() === '') {
        return 'alertId must be a non-empty string';
    }

    if (!VALID_TRIGGERS.includes(event.trigger)) {
        return 'Invalid trigger';
    }

    if (!VALID_STATUSES.includes(event.status)) {
        return 'Invalid status';
    }

    if (event.heartRate !== null && event.heartRate !== undefined) {
        if (!isValidFiniteNumber(event.heartRate)) {
            return 'heartRate must be null or a finite number';
        }
    }

    if (event.latitude !== undefined && event.latitude !== null &&
        (!isValidFiniteNumber(event.latitude) || event.latitude < -90 || event.latitude > 90)) {
        return 'Invalid latitude';
    }

    if (event.longitude !== undefined && event.longitude !== null &&
        (!isValidFiniteNumber(event.longitude) || event.longitude < -180 || event.longitude > 180)) {
        return 'Invalid longitude';
    }

    if (!isValidTimestamp(event.timestamp)) {
        return 'Invalid timestamp';
    }

    return null;
}

function storeLocation(location, device) {
    const error = validateLocation(location);
    if (error) {
        return { ok: false, status: 400, error };
    }

    const stored = {
        latitude: location.latitude,
        longitude: location.longitude,
        timestamp: location.timestamp || new Date().toISOString()
    };

    if (device && device.identifier) {
        stored.deviceId = device.identifier;
        stored.blindUserId = device.blindUserId;
    }

    latestLocation = stored;
    persistLatestStateBestEffort();
    return { ok: true, location: stored };
}

function nextMqttAlertId(trigger) {
    mqttSeq += 1;
    return `MQTT-${trigger}-${String(mqttSeq).padStart(4, '0')}`;
}

function createEvent(event, options) {
    const opts = options || {};

    const error = validateEvent(event);
    if (error) {
        return { ok: false, status: 400, error };
    }

    if (events.has(event.alertId)) {
        return { ok: false, status: 409, error: 'Event with this alertId already exists' };
    }

    if (event.latitude === undefined || event.latitude === null ||
        event.longitude === undefined || event.longitude === null) {
        if (latestLocation && isValidLatitude(latestLocation.latitude) && isValidLongitude(latestLocation.longitude)) {
            event.latitude = latestLocation.latitude;
            event.longitude = latestLocation.longitude;
        } else if (!opts.allowMissingCoordinates) {
            return { ok: false, status: 400, error: 'Location unavailable — provide coordinates or post phone GPS first' };
        }
    }

    events.set(event.alertId, event);
    broadcastEvent(event);
    return { ok: true, status: 201, event };
}

const RADAR_DIRECTION_MAP = {
    LEFT: 'OBSTACLE_LEFT',
    CENTER: 'OBSTACLE_CENTER',
    RIGHT: 'OBSTACLE_RIGHT'
};

function handleRadarMessage(payload) {
    const direction = payload && payload.direction;
    const trigger = RADAR_DIRECTION_MAP[direction];
    const hasDistance =
        payload && typeof payload.distance === 'number' && Number.isFinite(payload.distance) && payload.distance >= 0;

    if (!trigger || !hasDistance) {
        console.warn(`[MQTT] Invalid radar payload — direction="${String(direction)}", distance=${payload ? payload.distance : 'missing'}`);
        return;
    }

    const event = {
        alertId: nextMqttAlertId(trigger),
        trigger,
        status: 'ACTIVE',
        heartRate: null,
        latitude: null,
        longitude: null,
        timestamp: isValidTimestamp(payload.timestamp) ? payload.timestamp : new Date().toISOString(),
        source: 'mqtt',
        deviceId: payload.deviceId,
        distance: payload.distance,
        angle: Number.isFinite(payload.angle) ? payload.angle : null,
        danger: payload.danger
    };

    const result = createEvent(event, { allowMissingCoordinates: true });
    if (result.ok) {
        console.log(`[MQTT] Radar event → ${trigger} (alertId ${result.event.alertId})`);
        persistEventBestEffort(result.event);
    } else {
        console.warn(`[MQTT] Radar event skipped: ${result.error}`);
    }
}

function handleSosMessage(payload) {
    const hasDeviceId = payload && typeof payload.deviceId === 'string' && payload.deviceId.trim() !== '';
    const hasMessage = payload && typeof payload.message === 'string' && payload.message.trim() !== '';

    if (!payload || !(hasDeviceId || hasMessage)) {
        console.warn('[MQTT] Invalid SOS payload');
        return;
    }

    const event = {
        alertId: nextMqttAlertId('SOS'),
        trigger: 'SOS',
        status: 'ACTIVE',
        heartRate: null,
        latitude: null,
        longitude: null,
        timestamp: isValidTimestamp(payload.timestamp) ? payload.timestamp : new Date().toISOString(),
        source: 'mqtt',
        deviceId: payload.deviceId,
        message: payload.message
    };

    const result = createEvent(event, { allowMissingCoordinates: true });
    if (result.ok) {
        console.log(`[MQTT] SOS event received (alertId ${result.event.alertId})`);
        persistEventBestEffort(result.event);
    } else {
        console.warn(`[MQTT] SOS event skipped: ${result.error}`);
    }
}

function handleLocationMessage(payload) {
    const result = storeLocation(payload);
    if (result.ok) {
        console.log('[MQTT] Location update received');
    } else {
        console.warn(`[MQTT] Invalid location payload: ${result.error}`);
    }
}

function handleDeviceStatusMessage(payload) {
    const hasDeviceId = payload && typeof payload.deviceId === 'string' && payload.deviceId.trim() !== '';
    const hasStatus = payload && typeof payload.status === 'string' && payload.status.trim() !== '';

    if (!payload || !(hasDeviceId || hasStatus)) {
        console.warn('[MQTT] Invalid device status payload');
        return;
    }

    latestDeviceStatus = {
        deviceId: payload.deviceId,
        status: payload.status,
        wifi: payload.wifi,
        receivedAt: new Date().toISOString()
    };
    persistLatestStateBestEffort();
    console.log('[MQTT] Device status update received');
}

function handleFallMessage(payload) {
    const hasDeviceId = payload && typeof payload.deviceId === 'string' && payload.deviceId.trim() !== '';

    if (!payload || !hasDeviceId) {
        console.warn('[MQTT] Invalid fall payload');
        return;
    }

    latestFall = {
        deviceId: payload.deviceId,
        timestamp: isValidTimestamp(payload.timestamp) ? payload.timestamp : new Date().toISOString(),
        latitude: latestLocation ? latestLocation.latitude : null,
        longitude: latestLocation ? latestLocation.longitude : null,
        receivedAt: new Date().toISOString()
    };
    persistLatestStateBestEffort();
    console.warn('[MQTT] Fall event received — no dedicated trigger in the event model; stored in memory (not broadcast)');
}

function handleAlertsMessage(payload) {
    if (!payload || typeof payload.trigger !== 'string') {
        console.warn('[MQTT] Invalid alerts payload (no trigger) — logged only');
        return;
    }

    if (!VALID_TRIGGERS.includes(payload.trigger)) {
        console.warn(`[MQTT] Alert received with unsupported trigger "${payload.trigger}" — logged only`);
        return;
    }

    const event = {
        alertId: nextMqttAlertId(payload.trigger),
        trigger: payload.trigger,
        status: VALID_STATUSES.includes(payload.status) ? payload.status : 'ACTIVE',
        heartRate: typeof payload.heartRate === 'number' && Number.isFinite(payload.heartRate) ? payload.heartRate : null,
        latitude: typeof payload.latitude === 'number' && Number.isFinite(payload.latitude) ? payload.latitude : null,
        longitude: typeof payload.longitude === 'number' && Number.isFinite(payload.longitude) ? payload.longitude : null,
        timestamp: isValidTimestamp(payload.timestamp) ? payload.timestamp : new Date().toISOString(),
        source: 'mqtt',
        deviceId: payload.deviceId,
        message: payload.message
    };

    const result = createEvent(event, { allowMissingCoordinates: true });
    if (result.ok) {
        console.log(`[MQTT] Alert routed → ${payload.trigger} (alertId ${result.event.alertId})`);
        persistEventBestEffort(result.event);
    } else {
        console.warn(`[MQTT] Alert skipped: ${result.error}`);
    }
}

function handleHeartRateMessage(payload) {
    const raw = payload && payload.heartRate;
    const hasValidHeartRate =
        typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 400;

    if (!payload || !hasValidHeartRate) {
        console.warn(`[MQTT] Invalid heart-rate payload — heartRate="${String(raw)}".`);
        return;
    }

    const deviceId =
        payload && typeof payload.deviceId === 'string' && payload.deviceId.trim() !== ''
            ? payload.deviceId
            : 'unknown';

    lastHeartRate = {
        deviceId,
        heartRate: raw,
        timestamp: isValidTimestamp(payload.timestamp) ? payload.timestamp : new Date().toISOString(),
        receivedAt: new Date().toISOString()
    };
    persistLatestStateBestEffort();

    const abnormal = raw < HEART_RATE_ALERT_LOW || raw > HEART_RATE_ALERT_HIGH;

    if (!abnormal) {
        console.log(`[MQTT] Heart-rate update received (normal): ${raw} BPM. No alert.`);
        return;
    }

    const now = Date.now();
    const lastAlertAt = lastHeartRateAlertAt[deviceId] || 0;

    if (now - lastAlertAt < HEART_RATE_COOLDOWN_MS) {
        console.log(`[MQTT] Abnormal heart-rate (${raw} BPM) within cooldown — no new event for ${deviceId}.`);
        return;
    }

    const event = {
        alertId: nextMqttAlertId('HEART_RATE'),
        trigger: 'HEART_RATE',
        status: 'ACTIVE',
        heartRate: raw,
        latitude: null,
        longitude: null,
        timestamp: lastHeartRate.timestamp,
        source: 'mqtt',
        deviceId
    };

    const result = createEvent(event, { allowMissingCoordinates: true });

    if (result.ok) {
        lastHeartRateAlertAt[deviceId] = now;
        console.log(`[MQTT] HEART_RATE event created (${raw} BPM, alertId ${result.event.alertId}).`);
        persistEventBestEffort(result.event);
    } else {
        console.warn(`[MQTT] HEART_RATE event skipped: ${result.error}`);
    }
}

function handleMqttMessage(topic, payload) {
    switch (topic) {
        case TOPICS.SENSOR_RADAR:
            handleRadarMessage(payload);
            break;
        case TOPICS.EMERGENCY_SOS:
            handleSosMessage(payload);
            break;
        case TOPICS.MOBILE_LOCATION:
            handleLocationMessage(payload);
            break;
        case TOPICS.DEVICE_STATUS:
            handleDeviceStatusMessage(payload);
            break;
        case TOPICS.MOBILE_FALL:
            handleFallMessage(payload);
            break;
        case TOPICS.ALERTS:
            handleAlertsMessage(payload);
            break;
        case TOPICS.SENSOR_HEART:
            handleHeartRateMessage(payload);
            break;
        default:
            console.log(`[MQTT] Message received (unhandled topic: ${topic})`);
    }
}

const BUZZER_COMMANDS = Object.freeze({
    BUZZER_ON: 'BUZZER_ON',
    BUZZER_OFF: 'BUZZER_OFF'
});

function publishBuzzerCommand(command) {
    const published = mqttClient.publish(TOPICS.DEVICE_COMMAND, {
        command,
        issuedAt: new Date().toISOString()
    });
    if (published) {
        latestBuzzerState = command === BUZZER_COMMANDS.BUZZER_ON ? 'ON' : 'OFF';
        persistLatestStateBestEffort();
    }
    return published;
}

// ── Stage 6 multi-user scoping helper ───────────────────────────────────
// When a `blindUserId` query parameter is supplied, validates the caller is
// an authenticated CARETAKER with an ACTIVE relationship to that blind user.
// Returns the validated blindUserId string on success; on failure, sends the
// appropriate error response and returns null.  When the parameter is absent
// the helper returns undefined — the caller should fall back to unscoped
// (backward-compatible) behavior.
async function requireScopedBlindUser(req, res) {
    const blindUserId = req.query.blindUserId;
    if (blindUserId === undefined || blindUserId === null || blindUserId === '') {
        return undefined; // no scoping requested — backward-compatible
    }
    if (!isValidUuid(blindUserId)) {
        res.status(404).json({ error: 'Blind user not found' });
        return null;
    }
    // Authenticate via session cookie (replicates requireAuth logic inline
    // to avoid the next()-after-response issue with Express middleware).
    const rawToken = req.cookies ? req.cookies[SESSION_COOKIE_NAME] : undefined;
    if (!rawToken || typeof rawToken !== 'string') {
        res.status(401).json({ error: 'Not authenticated' });
        return null;
    }
    let session;
    try {
        session = await findSessionByTokenHash(hashSessionToken(rawToken));
    } catch (_err) {
        res.status(401).json({ error: 'Not authenticated' });
        return null;
    }
    if (!session) {
        res.status(401).json({ error: 'Not authenticated' });
        return null;
    }
    if (session.role !== 'CARETAKER') {
        res.status(403).json({ error: 'Forbidden' });
        return null;
    }
    const allowed = await hasActiveRelationship(session.id, blindUserId);
    if (!allowed) {
        res.status(404).json({ error: 'Blind user not found' });
        return null;
    }
    return blindUserId;
}

app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        mqtt: mqttClient.getState(),
        deviceStatus: latestDeviceStatus
    });
});

app.get('/api/events', async (req, res, next) => {
    let blindUserId;
    try {
        blindUserId = await requireScopedBlindUser(req, res);
        if (blindUserId === null) return; // error already sent
    } catch (err) {
        // Auth itself depends on the database; when it is unreachable there is
        // no way to authorize scoping, so fail closed rather than fall back.
        return next(err);
    }

    let rows;
    try {
        if (blindUserId !== undefined) {
            // Scoped: only events belonging to the authorized blind user.
            rows = await queries.listRecentEventsForBlindUser(blindUserId, EVENTS_WINDOW_MAX);
        } else {
            // Unscoped (backward-compatible).
            rows = await queries.listRecentEvents(EVENTS_WINDOW_MAX);
        }
    } catch (err) {
        console.warn('[Persistence] GET /api/events fell back to memory:', err && err.message ? err.message : err);
        if (blindUserId !== undefined) {
            // DB down + already authorized: in-memory fallback stays scoped.
            const mem = Array.from(events.values()).filter((e) => e.blindUserId === blindUserId);
            return res.status(200).json(mem.slice(-EVENTS_WINDOW_MAX));
        }
        return res.status(200).json(Array.from(events.values()).slice(-EVENTS_WINDOW_MAX));
    }

    if (rows.length === 0 && events.size > 0) {
        const mem = blindUserId !== undefined
            ? Array.from(events.values()).filter((e) => e.blindUserId === blindUserId)
            : Array.from(events.values());
        if (mem.length > 0) {
            return res.status(200).json(mem.slice(-EVENTS_WINDOW_MAX));
        }
    }
    return res.status(200).json(rows);
});

app.get('/api/location', async (req, res, next) => {
    try {
        const blindUserId = await requireScopedBlindUser(req, res);
        if (blindUserId === null) return;
        if (blindUserId !== undefined) {
            if (latestLocation && latestLocation.blindUserId === blindUserId) {
                return res.status(200).json(latestLocation);
            }
            return res.status(200).json({ latitude: null, longitude: null, timestamp: null });
        }
        // Unscoped (backward-compatible).
        if (latestLocation) {
            return res.status(200).json(latestLocation);
        }
        return res.status(200).json({ latitude: null, longitude: null, timestamp: null });
    } catch (err) {
        return next(err);
    }
});

app.post('/api/location', requireDeviceAuth, (req, res) => {
    const result = storeLocation(req.body, req.device);

    if (!result.ok) {
        return res.status(400).json({ error: result.error });
    }

    return res.status(200).json(result.location);
});

app.post('/api/events', requireDeviceAuth, async (req, res, next) => {
    // Identity comes from the authenticated device, never from the request
    // body. Any client-supplied deviceId/blindUserId is overwritten.
    req.body.deviceId = req.device.identifier;
    req.body.blindUserId = req.device.blindUserId;

    const result = createEvent(req.body);

    if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
    }

    // 201 ⇒ durable-in-DB or queued-for-retry; never throws.
    await persistEventBestEffort(result.event);

    return res.status(result.status).json(result.event);
});

// Composite actor for PATCH: a cap device (headers) OR a caretaker session
// cookie may resolve an alert. The device path enforces event ownership; the
// caretaker path enforces the Stage-3 relationship when the event is bound to
// a blind user, and keeps legacy events (no blindUserId) resolvable.
function requireEventActor(req, res, next) {
    const hasAnyDeviceHeader = req.headers['x-device-id'] || req.headers['x-device-token'];
    if (hasAnyDeviceHeader) {
        return requireDeviceAuth(req, res, next);
    }
    requireAuth(req, res, (err) => {
        if (err) return next(err);
        return requireRole('CARETAKER')(req, res, next);
    });
}

app.patch('/api/events/:alertId', requireEventActor, async (req, res, next) => {
    const alertId = req.params.alertId;
    let event = events.get(alertId);

    if (!event) {
        // Graceful degradation: the event may be persisted in the database but
        // outside the bounded in-memory window. Hydrate it so the authorization
        // and transition logic below still works; a genuine miss stays 404.
        try {
            event = await queries.findEventByAlertId(alertId);
            if (event) {
                events.set(alertId, event);
            }
        } catch (err) {
            return next(err);
        }
    }

    if (!event) {
        return res.status(404).json({ error: 'Event not found' });
    }

    if (req.device) {
        if (event.deviceId !== req.device.identifier) {
            return res.status(403).json({ error: 'Event belongs to another device' });
        }
    } else if (req.auth) {
        if (event.blindUserId) {
            try {
                const allowed = await hasActiveRelationship(req.auth.user.id, event.blindUserId);
                if (!allowed) {
                    return res.status(403).json({ error: 'Not authorized to update this event' });
                }
            } catch (err) {
                return next(err);
            }
        }
    }

    const newStatus = req.body && req.body.status;

    if (newStatus === undefined || newStatus === null) {
        return res.status(400).json({ error: 'Status is required' });
    }

    if (!VALID_STATUSES.includes(newStatus)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    const allowed = ALLOWED_TRANSITIONS[event.status] || [];
    if (!allowed.includes(newStatus)) {
        return res.status(409).json({ error: 'Invalid status transition' });
    }

    event.status = newStatus;
    await persistEventStatusBestEffort(alertId, newStatus);
    return res.status(200).json(event);
});

app.post('/api/buzzer', requireDeviceAuth, (req, res) => {
    const command = req.body && req.body.command;
    const state = req.body && req.body.state;

    if (!BUZZER_COMMANDS[command]) {
        return res.status(400).json({ error: 'Invalid command — use "BUZZER_ON" or "BUZZER_OFF"' });
    }

    if (!mqttClient.client || mqttClient.getState() !== 'connected') {
        return res.status(503).json({
            error: 'MQTT command channel unavailable — buzzer command not sent to the device.',
            mqtt: mqttClient.getState()
        });
    }

    const published = publishBuzzerCommand(command);
    if (!published) {
        return res.status(503).json({ error: 'Buzzer command not sent — MQTT publish failed.' });
    }

    return res.status(200).json({
        command,
        state: state || (command === BUZZER_COMMANDS.BUZZER_ON ? 'ON' : 'OFF'),
        published: true
    });
});

app.get('/api/buzzer', (req, res) => {
    return res.status(200).json({
        state: latestBuzzerState,
        commandTopic: TOPICS.DEVICE_COMMAND,
        mqtt: mqttClient.getState()
    });
});

app.get('/api/events/stream', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    sseClients.add(res);
    req.on('close', () => {
        sseClients.delete(res);
    });
});

const WALLE_CHAT_RATE_MAX = 30;
const WALLE_CHAT_RATE_WINDOW_MS = 60 * 1000;
const WALLE_CHAT_RATE_CLEANUP_THRESHOLD = 500;
const walleChatRateBuckets = new Map();
let walleChatRateCallsSinceCleanup = 0;

function isWalleChatRateLimited(req) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let bucket = walleChatRateBuckets.get(ip);
    if (!bucket || bucket.windowStart + WALLE_CHAT_RATE_WINDOW_MS <= now) {
        bucket = { windowStart: now, count: 0 };
        walleChatRateBuckets.set(ip, bucket);
    }
    bucket.count += 1;

    walleChatRateCallsSinceCleanup += 1;
    if (walleChatRateCallsSinceCleanup >= WALLE_CHAT_RATE_CLEANUP_THRESHOLD) {
        walleChatRateCallsSinceCleanup = 0;
        const cutoff = now - WALLE_CHAT_RATE_WINDOW_MS;
        for (const [key, entry] of walleChatRateBuckets) {
            if (entry.windowStart + WALLE_CHAT_RATE_WINDOW_MS <= cutoff) {
                walleChatRateBuckets.delete(key);
            }
        }
    }

    return bucket.count > WALLE_CHAT_RATE_MAX;
}

const WALLE_MAX_MESSAGE_LENGTH = (() => {
    const raw = parseInt(process.env.WALLE_MAX_MESSAGE_LENGTH, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 1000;
})();

app.post('/api/walle/chat', requireDeviceAuth, async (req, res) => {
    if (isWalleChatRateLimited(req)) {
        return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }

    const { sessionId, message } = req.body || {};

    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        return res.status(400).json({ error: 'sessionId is required' });
    }

    if (!isValidWalleSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid sessionId' });
    }

    if (typeof message !== 'string' || message.trim() === '') {
        return res.status(400).json({ error: 'message is required' });
    }

    if (message.length > WALLE_MAX_MESSAGE_LENGTH) {
        return res.status(400).json({
            error: `message exceeds maximum length of ${WALLE_MAX_MESSAGE_LENGTH} characters`
        });
    }

    // Only context that belongs to the authenticated device reaches Wall-E:
    // its own events plus location/status/heart-rate from the shared device bus.
    const deviceEvents = new Map();
    for (const [alertId, event] of events.entries()) {
        if (event.deviceId === req.device.identifier || event.blindUserId === req.device.blindUserId) {
            deviceEvents.set(alertId, event);
        }
    }

    const contextSnapshot = buildTrustedContext({
        latestLocation,
        latestDeviceStatus,
        lastHeartRate,
        latestFall,
        latestBuzzerState,
        events: deviceEvents
    });

    conversationStore.ensureSession(sessionId, {
        deviceId: req.device.identifier,
        blindUserId: req.device.blindUserId
    });
    conversationStore.addUserMessage(sessionId, message.trim());

    const history = conversationStore.buildModelMessages(sessionId);

    const messages = [
        { role: 'system', content: getSystemPrompt() },
        { role: 'system', content: contextSnapshot },
        ...history
    ];

    try {
        const result = await chatWithFallback({
            messages,
            temperature: 0.2,
            maxTokens: 200
        });
        conversationStore.addAssistantMessage(sessionId, result.reply, result.model);
        return res.status(200).json({
            sessionId,
            reply: result.reply,
            timestamp: new Date().toISOString(),
            model: result.model
        });
    } catch (err) {
        if (err.message === 'AI_PROVIDER_UNAVAILABLE') {
            return res.status(503).json({
                error: 'AI_PROVIDER_UNAVAILABLE',
                message: 'AI service temporarily unavailable'
            });
        }
        console.error('[Wall-E] unexpected chat error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/walle/sessions', async (req, res, next) => {
    try {
        const blindUserId = await requireScopedBlindUser(req, res);
        if (blindUserId === null) return;
        if (blindUserId !== undefined) {
            return res.status(200).json(conversationStore.getSessionSummaries({ blindUserId }));
        }
        return res.status(200).json(conversationStore.getSessionSummaries());
    } catch (err) {
        return next(err);
    }
});

app.get('/api/walle/history/:sessionId', async (req, res, next) => {
    try {
        const sessionId = req.params.sessionId;
        if (!isValidWalleSessionId(sessionId)) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Require an authenticated CARETAKER via the session cookie.
        const rawToken = req.cookies ? req.cookies[SESSION_COOKIE_NAME] : undefined;
        if (!rawToken || typeof rawToken !== 'string') {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        const session = await findSessionByTokenHash(hashSessionToken(rawToken));
        if (!session) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        if (session.role !== 'CARETAKER') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const transcript = conversationStore.getSessionTranscript(sessionId);
        // A session exists but is unbound to a blind user, or does not exist at
        // all: both are indistinguishable (404) so nothing leaks.
        if (!transcript || !transcript.blindUserId) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const allowed = await hasActiveRelationship(session.id, transcript.blindUserId);
        if (!allowed) {
            return res.status(404).json({ error: 'Session not found' });
        }
        return res.status(200).json(transcript);
    } catch (err) {
        return next(err);
    }
});

app.use('/api/auth', authRouter);
app.use('/api/blind-users', blindUsersRouter);
app.use('/api/caretaker', careRouter);
app.use('/api/devices', devicesRouter);

app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }

    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Malformed JSON request' });
    }

    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request entity too large' });
    }

    console.error('[Server] Unhandled error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Internal server error' });
});

// ── Stage 5 boot rehydration ────────────────────────────────────────────
// Restores what PostgreSQL has (the most recent EVENTS_WINDOW_MAX events, the
// latest-state snapshot, the highest persisted MQTT sequence number, and the
// Wall-E conversation history) into the in-memory hot path before serving.
// Never throws: without a database the server starts empty, exactly as it did
// before persistence existed.
async function bootRehydrateFromDatabase() {
    try {
        const [recentEvents, latestState, maxSeq] = await Promise.all([
            queries.listRecentEvents(EVENTS_WINDOW_MAX),
            queries.loadLatestState(),
            queries.loadMaxMqttSeq()
        ]);

        events.clear();
        for (const event of recentEvents) {
            events.set(event.alertId, event);
        }

        if (latestState) {
            if (latestState.location) latestLocation = latestState.location;
            if (latestState.deviceStatus) latestDeviceStatus = latestState.deviceStatus;
            if (latestState.heartRate) lastHeartRate = latestState.heartRate;
            if (latestState.fall) latestFall = latestState.fall;
            if (latestState.buzzer) latestBuzzerState = latestState.buzzer;
        }

        // Never reuse a sequence number the database already holds (a reused
        // MQTT-* alertId would 409-collide forever).
        mqttSeq = maxSeq;

        await conversationStore.rehydrateFromDb();

        console.log(`[Persistence] Rehydrated from database: ${recentEvents.length} event(s), latest state, MQTT seq ${maxSeq}.`);
        return true;
    } catch (err) {
        console.warn('[Persistence] Boot rehydration unavailable — starting from empty state:', err && err.message ? err.message : err);
        return false;
    }
}

function getLatestRuntimeState() {
    return {
        latestLocation,
        latestDeviceStatus,
        lastHeartRate,
        latestFall,
        latestBuzzerState,
        mqttSeq,
        eventCount: events.size,
        queueSize: persistenceQueue.size()
    };
}

// Resolves when the bounded persistence queue has drained (all queued writes
// applied). Used by tests after fire-and-forget writes. Bounded wait is the
// caller's responsibility.
async function persistenceIdle() {
    while (persistenceQueue.size() > 0) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

if (require.main === module) {
    bootRehydrateFromDatabase().then(() => {
        const server = app.listen(PORT, () => {
            console.log(`Caretaker backend listening on http://localhost:${PORT}`);
        });

        function shutdown(signal) {
            console.log(`[Server] Received ${signal}, shutting down…`);
            if (mqttClient.close) {
                mqttClient.close();
            }
            server.close(() => {
                process.exit(0);
            });
            setTimeout(() => process.exit(0), 3000).unref();
        }

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    });
}

// Exported for in-process integration tests (restart simulation modules call
// handleMqttMessage / createEvent / bootRehydrateFromDatabase directly).
module.exports = {
    app,
    handleMqttMessage,
    createEvent,
    bootRehydrateFromDatabase,
    getLatestRuntimeState,
    persistenceIdle,
    persistEventBestEffort,
    EVENTS_WINDOW_MAX,
    TELEMETRY_QUEUE_MAX
};
