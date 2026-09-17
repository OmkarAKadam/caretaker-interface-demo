'use strict';

const { isConfigured: dbIsConfigured } = require('../db/pool');

const WALLE_SESSION_MAX_TURNS_DEFAULT = 20;
const WALLE_SESSION_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000;
const WALLE_MAX_SESSIONS_DEFAULT = 100;

function envPositiveInt(name, fallback) {
    const raw = parseInt(process.env[name], 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const CONFIG = Object.freeze({
    maxTurnsPerSession: envPositiveInt('WALLE_SESSION_MAX_TURNS', WALLE_SESSION_MAX_TURNS_DEFAULT),
    ttlMs: envPositiveInt('WALLE_SESSION_TTL_MS', WALLE_SESSION_TTL_MS_DEFAULT),
    maxSessions: envPositiveInt('WALLE_MAX_SESSIONS', WALLE_MAX_SESSIONS_DEFAULT)
});

const sessions = new Map();

// ── PostgreSQL write-through ─────────────────────────────────────────────
// When DATABASE_URL is configured, every session and turn is mirrored to the
// database in the background (never awaited by the hot path). A DB failure is
// logged and ignored — conversations always remain fully in-memory.

let dbConfigured = false;
try { dbConfigured = dbIsConfigured(); } catch (_e) { /* DATABASE_URL not set */ }
let queries = null;
try { queries = require('../telemetry/queries'); } catch (_e) { /* telemetry not loaded yet */ }

let pendingSyncs = new Set();
const syncChains = new Map();

function track(p) {
    if (!p || typeof p.then !== 'function') return;
    pendingSyncs.add(p);
    p.finally(() => { pendingSyncs.delete(p); }).catch(() => {});
}

// Serializes DB syncs per session so a "delete stale row then insert" reset can
// never interleave with a concurrent turn sync (which would write messages to
// a row that is about to be deleted).
function enqueueSync(sessionId, task) {
    if (!dbConfigured || !queries) return;
    const prev = syncChains.get(sessionId) || Promise.resolve();
    const next = prev.then(task, task);
    syncChains.set(sessionId, next.finally(() => {
        if (syncChains.get(sessionId) === next) {
            syncChains.delete(sessionId);
        }
    }));
    track(next);
}

// Drains all pending DB sync promises. Used by integration tests after
// fire-and-forget chat calls to ensure the DB has been updated before
// simulating a restart.
async function drainPendingSyncs() {
    while (pendingSyncs.size > 0) {
        const batch = Array.from(pendingSyncs);
        await Promise.allSettled(batch);
    }
}

// Full session → DB sync: upserts the walle_sessions row and inserts any turns
// missing from walle_messages. Turn idempotency uses the created_at timestamp
// (already unique to the millisecond) as a proxy for a unique turn key.
async function persistSession(session) {
    if (!session || !queries) return;
    const dbRow = await queries.upsertWallSession(session.sessionId, {
        deviceId: session.deviceId,
        blindUserId: session.blindUserId,
        lastActiveAt: session.lastActiveAt
    });
    if (!dbRow) return;
    const existingTimestamps = await queries.listWallTurnTimestamps(dbRow.id);
    for (const turn of session.turns) {
        const ts = Date.parse(turn.timestamp);
        if (!Number.isFinite(ts)) continue;
        if (existingTimestamps.has(ts)) continue;
        await queries.insertWallMessage(dbRow.id, turn.role, turn.text, turn.model, turn.timestamp);
    }
}

// New sessions reset any stale DB row so started_at matches the current
// in-memory start time. Used only when ensureSession creates a brand-new session.
async function resetSessionRow(session) {
    if (!session || !queries) return;
    await queries.deleteWallSessionByClientId(session.sessionId);
    await persistSession(session);
}

function syncSessionToDb(session) {
    if (!dbConfigured || !session) return;
    enqueueSync(session.sessionId, () => persistSession(session));
}

function syncNewSessionToDb(session) {
    if (!dbConfigured || !session) return;
    enqueueSync(session.sessionId, () => resetSessionRow(session));
}

function nowIso() {
    return new Date().toISOString();
}

function isExpired(session, nowMs) {
    return Date.parse(session.lastActiveAt) + CONFIG.ttlMs < nowMs;
}

function pruneExpired(nowMs) {
    if (sessions.size === 0) return;
    for (const [id, session] of sessions) {
        if (isExpired(session, nowMs)) {
            sessions.delete(id);
        }
    }
}

function enforceMaxSessions() {
    if (sessions.size <= CONFIG.maxSessions) return;
    const ordered = Array.from(sessions.values())
        .sort((a, b) => Date.parse(a.lastActiveAt) - Date.parse(b.lastActiveAt));
    while (sessions.size > CONFIG.maxSessions) {
        const oldest = ordered.shift();
        if (oldest) {
            sessions.delete(oldest.sessionId);
        }
    }
}

function prune() {
    const nowMs = Date.now();
    pruneExpired(nowMs);
    enforceMaxSessions();
}

function getSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        return null;
    }
    prune();
    const session = sessions.get(sessionId);
    if (session && isExpired(session, Date.now())) {
        sessions.delete(sessionId);
        return null;
    }
    return session || null;
}

function ensureSession(sessionId, meta) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        return null;
    }
    prune();
    let session = sessions.get(sessionId);
    if (session && isExpired(session, Date.now())) {
        sessions.delete(sessionId);
        session = null;
    }
    if (!session) {
        session = {
            sessionId,
            startedAt: nowIso(),
            lastActiveAt: nowIso(),
            turns: [],
            deviceId: (meta && meta.deviceId) || null,
            blindUserId: (meta && meta.blindUserId) || null
        };
        sessions.set(sessionId, session);
        enforceMaxSessions();
        syncNewSessionToDb(session);
    }
    return session;
}

function capTurns(session) {
    if (session.turns.length > CONFIG.maxTurnsPerSession) {
        session.turns = session.turns.slice(-CONFIG.maxTurnsPerSession);
    }
}

function appendTurn(session, turn) {
    session.turns.push(turn);
    capTurns(session);
    session.lastActiveAt = nowIso();
    syncSessionToDb(session);
    return turn;
}

function addUserMessage(sessionId, text) {
    const session = ensureSession(sessionId);
    if (!session) return null;
    return appendTurn(session, {
        role: 'user',
        text: String(text || '').trim(),
        timestamp: nowIso(),
        model: null
    });
}

function addAssistantMessage(sessionId, text, model) {
    const session = getSession(sessionId);
    if (!session) return null;
    return appendTurn(session, {
        role: 'assistant',
        text: String(text || '').trim(),
        timestamp: nowIso(),
        model: model || null
    });
}

function buildModelMessages(sessionId, limit) {
    const session = getSession(sessionId);
    if (!session) return [];
    const max = limit && limit > 0 ? limit : CONFIG.maxTurnsPerSession;
    return session.turns.slice(-max).map((turn) => ({ role: turn.role, content: turn.text }));
}

function getSessionCount() {
    return sessions.size;
}

const PREVIEW_MAX_LENGTH = 100;

function buildPreview(session) {
    for (let i = session.turns.length - 1; i >= 0; i--) {
        if (session.turns[i].role === 'user' && session.turns[i].text) {
            const text = session.turns[i].text;
            if (text.length > PREVIEW_MAX_LENGTH) {
                return text.slice(0, PREVIEW_MAX_LENGTH - 3) + '...';
            }
            return text;
        }
    }
    return '';
}

function getSessionSummaries(filter) {
    prune();
    const summaries = [];
    for (const session of sessions.values()) {
        if (filter && filter.blindUserId && session.blindUserId !== filter.blindUserId) continue;
        if (filter && filter.deviceId && session.deviceId !== filter.deviceId) continue;
        summaries.push({
            sessionId: session.sessionId,
            startedAt: session.startedAt,
            lastActiveAt: session.lastActiveAt,
            turnCount: session.turns.length,
            preview: buildPreview(session)
        });
    }
    summaries.sort((a, b) => {
        const byActivity = Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt);
        if (byActivity !== 0) return byActivity;
        return Date.parse(b.startedAt) - Date.parse(a.startedAt);
    });
    return summaries;
}

function getSessionTranscript(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        return null;
    }
    const session = getSession(sessionId);
    if (!session) return null;
    const transcript = {
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        lastActiveAt: session.lastActiveAt,
        turns: session.turns.map((turn) => {
            const output = {
                role: turn.role,
                text: turn.text,
                timestamp: turn.timestamp
            };
            if (turn.role === 'assistant' && turn.model) {
                output.model = turn.model;
            }
            return output;
        })
    };
    if (session.deviceId) transcript.deviceId = session.deviceId;
    if (session.blindUserId) transcript.blindUserId = session.blindUserId;
    return transcript;
}

// ── Boot rehydration ─────────────────────────────────────────────────────
// Restores persisted Wall-E conversations into memory from PostgreSQL so that
// the blind client sees them after a backend restart. Expired sessions are
// skipped. identity (deviceId) is reverse-resolved from the UUID FK so the
// API-facing contract is preserved.

async function rehydrateFromDb() {
    if (!dbConfigured || !queries) return false;

    try {
        const rows = await queries.listWallSessions();
        for (const row of rows) {
            const sessionId = row.client_session_id;
            if (sessions.has(sessionId)) continue;

            const lastActiveMs = Date.parse(row.last_active_at);
            if (!Number.isFinite(lastActiveMs)) continue;
            if (lastActiveMs + CONFIG.ttlMs < Date.now()) continue;

            const turns = await queries.listWallTurns(row.id, CONFIG.maxTurnsPerSession);
            const deviceId = row.device_id
                ? await queries.resolveDeviceIdentifier(row.device_id)
                : null;

            sessions.set(sessionId, {
                sessionId,
                startedAt: new Date(row.started_at).toISOString(),
                lastActiveAt: new Date(row.last_active_at).toISOString(),
                turns,
                deviceId: deviceId || null,
                blindUserId: row.blind_user_id || null
            });
        }
        enforceMaxSessions();
        return true;
    } catch (err) {
        console.warn('[Wall-E] rehydrateFromDb failed (conversations empty):', err && err.message ? err.message : err);
        return false;
    }
}

module.exports = {
    CONFIG,
    getSession,
    ensureSession,
    addUserMessage,
    addAssistantMessage,
    buildModelMessages,
    getSessionCount,
    getSessionSummaries,
    getSessionTranscript,
    prune,
    rehydrateFromDb,
    drainPendingSyncs
};