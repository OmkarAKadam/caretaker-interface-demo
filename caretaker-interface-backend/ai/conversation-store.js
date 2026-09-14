'use strict';

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

function getSessionSummaries() {
    prune();
    const summaries = [];
    for (const session of sessions.values()) {
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
    prune
};