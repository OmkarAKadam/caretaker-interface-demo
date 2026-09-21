'use strict';

// Focused integration test: MQTT obstacle (radar) deduplication.
//
// The ESP32 cap publishes a radar reading for every sweep sample (~1-2/s),
// so the same obstacle appears in many consecutive readings (LEFT, LEFT,
// LEFT, ...). handleRadarMessage now turns only ONE confirmed detection per
// device into an event:
//   - distance < 0 or distance > 100 cm  → CLEAR, reset that device's state
//   - 2 consecutive same-direction reads → first event
//   - repeats while active               → suppressed (no SSE, no TTS)
//   - direction change + 2 reads         → one new event (after realert window)
//   - clear → re-detect                  → a fresh event (two separate alerts)
//   - per-device state, keyed by deviceId (mirrors the heart-rate pattern)
//
// Runs IN-PROCESS against the real server module (MQTT disabled), using ONLY
// the local PostgreSQL database for the fire-and-forget persistence mirror
// that handleMqttMessage already performs — the assertions themselves are
// against the exported runtime state / in-memory event window. The realert
// backstop is shortened via OBSTACLE_REALERT_COOLDOWN_MS so the flapping
// behavior is exercisable without production-scale sleeps; production uses the
// default 3000ms (envPositiveInt fallback).
//
// Run with:
//   npm run test:obstacle
//
// All radar rows created by this run (device_identifier 'obst-…') are purged
// from the events table at the end.

// MQTT must be disabled BEFORE server.js is required below.
process.env.MQTT_BROKER_URL = '';
process.env.OBSTACLE_REALERT_COOLDOWN_MS = '50';

const { query, getPool } = require('../db/pool');
const { TOPICS } = require('../mqtt/topics');
let currentServerModule = require('../server');

const PREFIX = 'obst-';
const ts = Date.now();
const RESULTS = [];

function check(name, pass, detail) {
    RESULTS.push({ name, pass, detail: detail || '' });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
    return new Date().toISOString();
}

function radar(deviceId, direction, distance) {
    currentServerModule.handleMqttMessage(TOPICS.SENSOR_RADAR, {
        deviceId,
        direction,
        distance,
        timestamp: nowIso()
    });
}

function eventCount() {
    return currentServerModule.getLatestRuntimeState().eventCount;
}

function obstacleState(deviceId) {
    const map = currentServerModule.getLatestRuntimeState().obstacleState;
    return map instanceof Map ? map.get(deviceId) : null;
}

async function purgeOwnArtifacts() {
    try {
        await query(`DELETE FROM events WHERE device_identifier LIKE '${PREFIX}%'`);
        console.log('[test] purged stale obst-* radar rows');
    } catch (err) {
        console.warn('[test] initial purge failed (non-fatal):', err.message || err);
    }
}

async function cleanup() {
    try {
        await query(`DELETE FROM events WHERE device_identifier LIKE '${PREFIX}%'`);
        console.log('[test] cleaned up obst-* radar rows');
    } catch (err) {
        console.warn('[test] cleanup failed (non-fatal):', err.message || err);
    }
}

function runChecks() {
    const failed = RESULTS.filter((r) => !r.pass);
    console.log('');
    for (const r of RESULTS) {
        const mark = r.pass ? 'PASS' : 'FAIL';
        console.log(`  [${mark}] ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
    }
    console.log('');
    console.log(`[test] ${RESULTS.length - failed.length}/${RESULTS.length} checks passed`);
    return failed.length === 0;
}

async function main() {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
        console.error('[test] FATAL: DATABASE_URL is not configured. obstacle tests need the local blindguardian database.');
        process.exit(1);
    }

    console.log(`[test] obstacle dedup harness starting (radar backstop cooldown = ${currentServerModule.OBSTACLE_REALERT_COOLDOWN_MS} ms)…`);

    await purgeOwnArtifacts();
    try {
        await currentServerModule.bootRehydrateFromDatabase();

        const A = `${PREFIX}${ts}-A`;
        const B = `${PREFIX}${ts}-B`;
        const C = `${PREFIX}${ts}-C`;
        const D = `${PREFIX}${ts}-D`;
        const E = `${PREFIX}${ts}-E`;
        const F = `${PREFIX}${ts}-F`;
        const G = `${PREFIX}${ts}-G`;
        const H = `${PREFIX}${ts}-H`;
        const I = `${PREFIX}${ts}-I`;
        const J = `${PREFIX}${ts}-J`;
        const K = `${PREFIX}${ts}-K`;
        const L = `${PREFIX}${ts}-L`;
        const M = `${PREFIX}${ts}-M`;

        // ── 1. Repeated same-direction readings → ONE event ────────
        let before = eventCount();
        radar(A, 'LEFT', 45); radar(A, 'LEFT', 45); radar(A, 'LEFT', 45); radar(A, 'LEFT', 45); radar(A, 'LEFT', 45);
        check('repeated: 5× LEFT creates exactly 1 event', eventCount() - before === 1, `delta ${eventCount() - before}`);
        check('repeated: state active LEFT', obstacleState(A) && obstacleState(A).active === true && obstacleState(A).direction === 'LEFT',
            JSON.stringify(obstacleState(A)));

        // ── 2. Direction change → ONE new event ────────────────────
        before = eventCount();
        radar(B, 'LEFT', 45); radar(B, 'LEFT', 45);
        check('direction: LEFT×2 confirms 1 event', eventCount() - before === 1, `delta ${eventCount() - before}`);
        await sleep(80); // pass the realert window
        radar(B, 'CENTER', 40); radar(B, 'CENTER', 40);
        check('direction: CENTER×2 after window creates new event', eventCount() - before === 2, `delta ${eventCount() - before}`);
        check('direction: state active CENTER', obstacleState(B) && obstacleState(B).direction === 'CENTER', JSON.stringify(obstacleState(B)));

        // ── 3. Rapid sector flapping stays quiet, recovers ─────────
        before = eventCount();
        radar(C, 'LEFT', 45); radar(C, 'LEFT', 45);
        check('flapping: LEFT×2 confirms 1 event', eventCount() - before === 1, `delta ${eventCount() - before}`);
        // Alternate confirmations inside the backstop window.
        radar(C, 'CENTER', 42); radar(C, 'CENTER', 42);
        radar(C, 'LEFT', 45); radar(C, 'LEFT', 45);
        radar(C, 'CENTER', 42); radar(C, 'CENTER', 42);
        check('flapping: alternation inside window adds no event', eventCount() - before === 1, `delta ${eventCount() - before}`);
        await sleep(80);
        radar(C, 'CENTER', 42); radar(C, 'CENTER', 42);
        check('flapping: sustained direction after window fires', eventCount() - before === 2, `delta ${eventCount() - before}`);

        // ── 4. Clear then redetect → two separate alerts ───────────
        before = eventCount();
        radar(D, 'LEFT', 50); radar(D, 'LEFT', 50);
        check('redetect: first LEFT×2 creates event', eventCount() - before === 1, `delta ${eventCount() - before}`);
        radar(D, 'LEFT', 180); // >100 → CLEAR, no event
        check('redetect: clear reading creates no event', eventCount() - before === 1, `delta ${eventCount() - before}`);
        check('redetect: state reset after clear', obstacleState(D) && obstacleState(D).direction === null, JSON.stringify(obstacleState(D)));
        radar(D, 'LEFT', 50); radar(D, 'LEFT', 50);
        check('redetect: LEFT after clear creates fresh event', eventCount() - before === 2, `delta ${eventCount() - before}`);

        // ── 5. distance < 0 never creates an event, resets state ───
        before = eventCount();
        radar(E, 'LEFT', -1); radar(E, 'LEFT', -1); radar(E, 'CENTER', -1);
        check('neg: distance -1 creates no event', eventCount() - before === 0, `delta ${eventCount() - before}`);
        radar(E, 'LEFT', 45); radar(E, 'LEFT', 45);
        check('neg: normal detection after -1 works', eventCount() - before === 1, `delta ${eventCount() - before}`);

        // ── 6. distance > 100 never creates an event, resets state ─
        before = eventCount();
        radar(F, 'LEFT', 120); radar(F, 'LEFT', 155); radar(F, 'RIGHT', 100.5);
        check('far: distance >100 creates no event', eventCount() - before === 0, `delta ${eventCount() - before}`);
        radar(F, 'LEFT', 45); radar(F, 'LEFT', 45);
        check('far: normal detection after >100 works', eventCount() - before === 1, `delta ${eventCount() - before}`);

        // ── 7. Per-device isolation ────────────────────────────────
        before = eventCount();
        radar(G, 'LEFT', 45); radar(G, 'LEFT', 45); // G fires
        radar(H, 'CENTER', 40); radar(H, 'CENTER', 40); // H fires independently
        check('isolation: G and H each confirm 1 event', eventCount() - before === 2, `delta ${eventCount() - before}`);
        await sleep(80);
        radar(G, 'CENTER', 40); radar(G, 'CENTER', 40); // G direction change
        check('isolation: G fires its own direction change', eventCount() - before === 3, `delta ${eventCount() - before}`);
        check('isolation: G state CENTER', obstacleState(G) && obstacleState(G).direction === 'CENTER', JSON.stringify(obstacleState(G)));
        check('isolation: H state CENTER untouched', obstacleState(H) && obstacleState(H).direction === 'CENTER', JSON.stringify(obstacleState(H)));

        // ── 8. 100 cm boundary ─────────────────────────────────────
        before = eventCount();
        radar(I, 'LEFT', 100); radar(I, 'LEFT', 100); // == threshold → obstacle
        check('boundary: 100 cm is an obstacle', eventCount() - before === 1, `delta ${eventCount() - before}`);
        radar(J, 'LEFT', 100.1); radar(J, 'LEFT', 100.1); // > threshold → clear
        check('boundary: 100.1 cm is clear', eventCount() - before === 1, `delta ${eventCount() - before}`);
        radar(K, 'CENTER', 99.9); radar(K, 'CENTER', 99.9); // < threshold → obstacle
        check('boundary: 99.9 cm is an obstacle', eventCount() - before === 2, `delta ${eventCount() - before}`);

        // ── 9. Stability: 2 consecutive readings required ──────────
        before = eventCount();
        radar(L, 'LEFT', 45); // single reading, not yet confirmed
        check('stable: single LEFT creates no event', eventCount() - before === 0, `delta ${eventCount() - before}`);
        radar(L, 'LEFT', 180); // CLEAR aborts the confirmation.
        radar(L, 'CENTER', 40); // single CENTER, not yet confirmed.
        check('stable: interrupted confirmation creates no event', eventCount() - before === 0, `delta ${eventCount() - before}`);
        radar(L, 'LEFT', 45); radar(L, 'LEFT', 45);
        check('stable: a fresh 2× run still confirms', eventCount() - before === 1, `delta ${eventCount() - before}`);

        // ── 10. Rapid single-reading alternation → no events ───────
        before = eventCount();
        radar(M, 'LEFT', 45); radar(M, 'CENTER', 40); radar(M, 'LEFT', 45); radar(M, 'CENTER', 40);
        radar(M, 'LEFT', 45); radar(M, 'CENTER', 40); radar(M, 'LEFT', 45); radar(M, 'CENTER', 40);
        check('alternate: single-reading flapping creates no event', eventCount() - before === 0, `delta ${eventCount() - before}`);

        // ── Persistence mirror sanity (fire-and-forget rows landed) ─
        await currentServerModule.persistenceIdle();
        const rows = await query(
            `SELECT COUNT(*)::int AS n FROM events WHERE device_identifier LIKE '${PREFIX}%' AND source = 'mqtt'`
        );
        check('persist: radar events mirrored to the events table', rows.rows[0].n >= 2, `rows ${rows.rows[0].n}`);
    } finally {
        await cleanup();
        if (getPool().end) { try { await getPool().end(); } catch (_e) { /* ignore */ } }
    }

    const ok = runChecks();
    if (!ok) process.exit(1);
    process.exit(0);
}

main().catch((err) => {
    console.error('[test] FATAL:', err.stack || err.message || err);
    process.exit(1);
});