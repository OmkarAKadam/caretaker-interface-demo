'use strict';

// Backend-controlled per-device heart-rate monitoring engine.
//
// The caretaker dashboard never talks to the device directly: it asks THIS
// module (through the REST routes in server.js), which issues a GET_HEART_RATE
// MQTT command to one specific device and correlates the response by requestId.
// The engine also runs the automatic schedule — normal cadence (default 5
// minutes) and high-frequency cadence (default 1–2 minutes) after an abnormal
// reading, returning to normal after N consecutive normal readings (default 3).
//
// State is strictly per-device and keyed by the device identifier string
// (e.g. "BG001" / "BG002"). A reading for one device can never touch another
// device's state or pending request, because pending requests live INSIDE each
// device's state entry and are only reachable through that device's identifier.
//
// This module owns scheduling + classification only. Publishing is injected
// (publishCommand); persistence and boot rehydration are handled by server.js,
// so the engine stays deterministic and testable in isolation.

const crypto = require('crypto');

const MONITORING_MODE = Object.freeze({
    NORMAL: 'NORMAL',
    HIGH_FREQUENCY: 'HIGH_FREQUENCY'
});

const READING_TYPE = Object.freeze({
    CONTINUOUS: 'CONTINUOUS',
    MANUAL: 'MANUAL',
    AUTOMATIC: 'AUTOMATIC'
});

const HEART_RATE_REQUEST_TIMEOUT_ERROR = 'HEART_RATE_REQUEST_TIMEOUT';
const HEART_RATE_COMMAND_UNAVAILABLE_ERROR = 'HEART_RATE_COMMAND_UNAVAILABLE';

function createHeartRateMonitor(options) {
    const opts = options || {};

    const normalIntervalMs = opts.normalIntervalMs || 2 * 60 * 1000;
    const highIntervalMs = opts.highIntervalMs || 2 * 60 * 1000;
    const recoveryNormalReadings = opts.recoveryNormalReadings || 3;
    const requestTimeoutMs = opts.requestTimeoutMs || 15000;
    const tickMs = opts.tickMs || 1000;
    const historyWindow = opts.historyWindow || 200;
    const alertLow = opts.alertLow || 60;
    const alertHigh = opts.alertHigh || 100;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;

    let publishCommand = typeof opts.publishCommand === 'function' ? opts.publishCommand : null;

    const devices = new Map();
    let timer = null;

    function classifyHeartRate(bpm) {
        if (bpm < alertLow) return 'LOW';
        if (bpm > alertHigh) return 'HIGH';
        return 'NORMAL';
    }

    function intervalFor(mode) {
        return mode === MONITORING_MODE.HIGH_FREQUENCY ? highIntervalMs : normalIntervalMs;
    }

    function modeForClassification(classification) {
        return classification === 'NORMAL'
            ? MONITORING_MODE.NORMAL
            : MONITORING_MODE.HIGH_FREQUENCY;
    }

    function timestampMs(timestamp) {
        const ms = Date.parse(timestamp);
        return Number.isNaN(ms) ? now() : ms;
    }

    function registerDevice(identifier) {
        if (!identifier || typeof identifier !== 'string' || identifier.trim() === '') {
            return null;
        }
        let state = devices.get(identifier);
        if (!state) {
            const nowMs = now();
            state = {
                identifier,
                monitoringMode: MONITORING_MODE.NORMAL,
                consecutiveNormalReadings: 0,
                nextRequestAt: nowMs + normalIntervalMs,
                lastReading: null,
                lastReadingAt: 0,
                pending: null,
                history: []
            };
            devices.set(identifier, state);
        }
        return state;
    }

    function pushHistory(state, entry) {
        state.history.unshift(entry);
        if (state.history.length > historyWindow) {
            state.history.length = historyWindow;
        }
    }

    // Resolves the device's pending request with the matching reading. Uses the
    // CURRENT (post-transition) monitoring mode so the next automatic request is
    // scheduled on the cadence the reading itself produced.
    function resolvePending(state, effectiveType, reading) {
        const pending = state.pending;
        if (!pending) return null;
        state.pending = null;
        const atMs = timestampMs(reading.timestamp);
        state.nextRequestAt = atMs + intervalFor(state.monitoringMode);
        const outcome = {
            deviceId: state.identifier,
            heartRate: reading.heartRate,
            classification: reading.classification,
            timestamp: reading.timestamp,
            readingType: effectiveType,
            requestId: pending.requestId
        };
        if (typeof pending.resolve === 'function') {
            pending.resolve(outcome);
        }
        return outcome;
    }

    // Abandons a request the device did not answer in time. The next automatic
    // request is scheduled on the current cadence so nothing gets stuck.
    function expirePending(state, atMs) {
        const pending = state.pending;
        if (!pending) return;
        state.pending = null;
        state.nextRequestAt = atMs + intervalFor(state.monitoringMode);
        if (typeof pending.reject === 'function') {
            pending.reject(new Error(HEART_RATE_REQUEST_TIMEOUT_ERROR));
        }
    }

    // Issues a GET_HEART_RATE command for ONE device. Collision rule: if a
    // request is already pending for that device, the manual caller joins it
    // (same requestId) instead of publishing a second command — the backend
    // never has two in-flight commands for the same device, automatic or manual.
    function requestNow(identifier, requestOptions) {
        const opts = requestOptions || {};
        const issuedBy = opts.issuedBy === READING_TYPE.AUTOMATIC
            ? READING_TYPE.AUTOMATIC
            : READING_TYPE.MANUAL;
        const wait = opts.wait !== false; // automatic requests have no waiter

        const state = registerDevice(identifier);
        if (!state) {
            return {
                requestId: null,
                pending: false,
                published: false,
                err: new Error('INVALID_DEVICE_IDENTIFIER')
            };
        }

        const nowMs = now();

        if (state.pending) {
            return {
                requestId: state.pending.requestId,
                pending: true,
                published: false,
                issuedBy: state.pending.issuedBy,
                promise: state.pending.promise
            };
        }

        const requestId =
            `${issuedBy === READING_TYPE.MANUAL ? 'hrq-m' : 'hrq-a'}-${identifier}-${nowMs}-` +
            crypto.randomBytes(4).toString('hex');

        const pending = {
            requestId,
            issuedBy,
            issuedAt: nowMs,
            timeoutAt: nowMs + requestTimeoutMs,
            promise: null,
            resolve: null,
            reject: null
        };

        if (wait) {
            pending.promise = new Promise((resolve, reject) => {
                pending.resolve = resolve;
                pending.reject = reject;
            });
        }

        state.pending = pending;

        let published = false;
        try {
            published = typeof publishCommand === 'function'
                ? publishCommand(identifier, requestId)
                : false;
        } catch (_err) {
            published = false;
        }

        if (!published) {
            state.pending = null;
            state.nextRequestAt = nowMs + intervalFor(state.monitoringMode);
            if (pending.reject) {
                pending.reject(new Error(HEART_RATE_COMMAND_UNAVAILABLE_ERROR));
            }
            return { requestId, pending: false, published: false, promise: pending.promise };
        }

        return { requestId, pending: false, published: true, promise: pending.promise };
    }

    // Classification applied BEFORE pending resolution / state assignment, so
    // scheduling decisions always see the mode this reading produced.
    function applyClassification(state, classification) {
        if (classification !== 'NORMAL') {
            state.monitoringMode = MONITORING_MODE.HIGH_FREQUENCY;
            state.consecutiveNormalReadings = 0;
        } else if (state.monitoringMode === MONITORING_MODE.HIGH_FREQUENCY) {
            state.consecutiveNormalReadings += 1;
            if (state.consecutiveNormalReadings >= recoveryNormalReadings) {
                state.monitoringMode = MONITORING_MODE.NORMAL;
                state.consecutiveNormalReadings = 0;
            }
        } else {
            state.consecutiveNormalReadings = 0;
        }
    }

    // Consumes ANY heart-rate reading for a device. Never throws: the caller
    // (server.js handleHeartRateMessage) already validated the rate range.
    function handleReading(reading) {
        if (!reading || typeof reading.deviceId !== 'string') {
            return null;
        }
        const state = registerDevice(reading.deviceId);
        if (!state) return null;

        const heartRate = reading.heartRate;
        if (typeof heartRate !== 'number' || !Number.isFinite(heartRate) ||
            heartRate <= 0 || heartRate > 400) {
            return null;
        }

        const timestamp = reading.timestamp || new Date(now()).toISOString();
        const receivedAt = reading.receivedAt || new Date(now()).toISOString();
        const classification = classifyHeartRate(heartRate);

        applyClassification(state, classification);

        // A reading that answers this device's pending request is correlated by
        // requestId. Because pending lives inside THIS device's state entry, a
        // response misattributed to another device can never resolve it.
        let effectiveType = READING_TYPE.CONTINUOUS;
        let resolvedPending = null;
        if (state.pending && reading.requestId && state.pending.requestId === reading.requestId) {
            effectiveType = state.pending.issuedBy === READING_TYPE.MANUAL
                ? READING_TYPE.MANUAL
                : READING_TYPE.AUTOMATIC;
            resolvedPending = resolvePending(state, effectiveType, {
                heartRate,
                classification,
                timestamp
            });
        }

        state.lastReading = {
            heartRate,
            classification,
            timestamp,
            receivedAt,
            readingType: effectiveType
        };
        state.lastReadingAt = timestampMs(timestamp);

        pushHistory(state, {
            deviceId: state.identifier,
            heartRate,
            classification,
            timestamp,
            receivedAt,
            readingType: effectiveType,
            requestId: reading.requestId || null
        });

        return {
            classification,
            monitoringMode: state.monitoringMode,
            consecutiveNormalReadings: state.consecutiveNormalReadings,
            readingType: effectiveType,
            resolvedPending: Boolean(resolvedPending)
        };
    }

    // Scheduler step. Runs every tickMs: expires stale pending requests and
    // issues automatic GET_HEART_RATE requests when the cadence is due.
    function tick() {
        const nowMs = now();
        for (const state of devices.values()) {
            if (state.pending) {
                if (nowMs >= state.pending.timeoutAt) {
                    expirePending(state, nowMs);
                }
                continue;
            }
            if (nowMs >= state.nextRequestAt) {
                requestNow(state.identifier, {
                    issuedBy: READING_TYPE.AUTOMATIC,
                    wait: false
                });
            }
        }
    }

    function start() {
        if (timer) return;
        timer = setInterval(() => {
            try {
                tick();
            } catch (err) {
                console.error('[HeartRateMonitor] tick error:', err && err.message ? err.message : err);
            }
        }, tickMs);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
    }

    function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    // Restart safety: a fresh process has no waiters, so every pending request
    // is simply abandoned. The automatic schedule resumes — never with a stale
    // in-flight command — from each device's cadence.
    function resetAll() {
        for (const state of devices.values()) {
            state.pending = null;
            state.nextRequestAt = now() + intervalFor(state.monitoringMode);
        }
    }

    // Restores persisted history (newest-first rows) into memory and adopts each
    // device, resuming its schedule safely. Returns the number of adopted
    // devices. Rows use the shared reading shape (deviceId, heartRate,
    // classification, readingType, requestId, timestamp).
    function rehydrateRows(rows) {
        resetAll();
        if (!Array.isArray(rows)) return 0;

        for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i];
            const identifier = row && row.deviceId;
            if (!identifier || typeof identifier !== 'string') continue;
            const state = registerDevice(identifier);
            if (!state) continue;
            pushHistory(state, {
                deviceId: identifier,
                heartRate: row.heartRate,
                classification: row.classification || 'NORMAL',
                timestamp: row.timestamp,
                receivedAt: row.timestamp,
                readingType: row.readingType || READING_TYPE.CONTINUOUS,
                requestId: row.requestId || null
            });
        }

        const nowMs = now();
        for (const state of devices.values()) {
            const mostRecent = state.history[0];
            if (mostRecent) {
                state.lastReading = mostRecent;
                state.lastReadingAt = timestampMs(mostRecent.timestamp);
                state.monitoringMode = modeForClassification(mostRecent.classification);
                state.consecutiveNormalReadings = 0;
            }
            state.nextRequestAt = nowMs + intervalFor(state.monitoringMode);
        }
        return devices.size;
    }

    function getState(identifier) {
        const state = devices.get(identifier);
        if (!state) return null;
        return {
            deviceId: identifier,
            monitoringMode: state.monitoringMode,
            nextRequestAt: state.nextRequestAt,
            consecutiveNormalReadings: state.consecutiveNormalReadings,
            pendingRequestId: state.pending ? state.pending.requestId : null,
            lastReading: state.lastReading ? Object.assign({}, state.lastReading) : null
        };
    }

    function getHistory(identifier, limit) {
        const state = devices.get(identifier);
        if (!state) return [];
        const parsed = parseInt(limit, 10);
        const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
        return state.history.slice(0, count);
    }

    function listDevices() {
        return Array.from(devices.keys());
    }

    function setPublishCommand(publishFn) {
        publishCommand = typeof publishFn === 'function' ? publishFn : null;
    }

    return {
        MONITORING_MODE,
        READING_TYPE,
        HEART_RATE_REQUEST_TIMEOUT_ERROR,
        HEART_RATE_COMMAND_UNAVAILABLE_ERROR,
        registerDevice,
        handleReading,
        requestNow,
        applyClassification,
        resolvePending,
        expirePending,
        tick,
        start,
        stop,
        resetAll,
        rehydrateRows,
        getState,
        getHistory,
        listDevices,
        setPublishCommand,
        classifyHeartRate
    };
}

module.exports = { createHeartRateMonitor, MONITORING_MODE, READING_TYPE };