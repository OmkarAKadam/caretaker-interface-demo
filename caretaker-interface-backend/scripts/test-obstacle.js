'use strict';

// Focused integration test: MQTT obstacle (radar) deduplication.
//
// The cap has a single fixed forward-facing ultrasonic sensor (no servo) and
// publishes a radar reading per cycle (~1-2/s), so the same obstacle appears
// in many consecutive readings. handleRadarMessage now turns only ONE
// confirmed detection per severity band into an event:
//   - distance < 0 or distance > 150 cm → CLEAR, reset that device's state
//   - 2 consecutive same-band reads      → first event
//   - repeats within the same band       → suppressed (no SSE, no TTS)
//   - band change + 2 reads              → one new event (after realert window)
//   - clear → re-detect                  → a fresh event (two separate alerts)
//   - per-device state, keyed by deviceId (mirrors the heart-rate pattern)
//
// Bands (parity with firmware buzzer + Blind Client TTS):
//   VERY_CLOSE <= 50 cm, CLOSE 51..90 cm, MODERATE 91..150 cm.
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

function radar(deviceId, distance) {
    currentServerModule.handleMqttMessage(TOPICS.SENSOR_RADAR, {
        deviceId,
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
        const N = `${PREFIX}${ts}-N`;

        // ── 1. Repeated same-band readings → ONE event ─────────────
        let before = eventCount();
        radar(A, 45); radar(A, 45); radar(A, 45); radar(A, 45); radar(A, 45);
        check('repeated: 5× 45 cm (VERY_CLOSE) creates exactly 1 event', eventCount() - before === 1, `delta ${eventCount() - before}`);
        check('repeated: state active VERY_CLOSE', obstacleState(A) && obstacleState(A).active === true && obstacleState(A).band === 'VERY_CLOSE',
            JSON.stringify(obstacleState(A)));

        // ── 2. Band change → ONE new event ─────────────────────────
        before = eventCount();
        radar(B, 120); radar(B, 120); // MODERATE ×2
        check('band: MODERATE×2 confirms 1 event', eventCount() - before === 1, `delta ${eventCount() - before}`);
        await sleep(80); // pass the realert window
        radar(B, 30); radar(B, 30); // VERY_CLOSE ×2
        check('band: VERY_CLOSE×2 after window creates new event', eventCount() - before === 2, `delta ${eventCount() - before}`);
        check('band: state active VERY_CLOSE', obstacleState(B) && obstacleState(B).band === 'VERY_CLOSE', JSON.stringify(obstacleState(B)));

        // ── 3. Rapid band flapping stays quiet, recovers ────────────
        before = eventCount();
        radar(C, 80); radar(C, 80); // CLOSE ×2
        check('flapping: CLOSE×2 confirms 1 event', eventCount() - before === 1, `delta ${eventCount() - before}`);
        // Alternate confirmations inside the backstop window.
        radar(C, 40); radar(C, 40);
        radar(C, 80); radar(C, 80);
        radar(C, 40); radar(C, 40);
        check('flapping: alternation inside window adds no event', eventCount() - before === 1, `delta ${eventCount() - before}`);
        await sleep(80);
        radar(C, 40); radar(C, 40);
        check('flapping: sustained band after window fires', eventCount() - before === 2, `delta ${eventCount() - before}`);

        // ── 4. Clear then redetect → two separate alerts ────────────
        before = eventCount();
        radar(D, 100); radar(D, 100); // MODERATE ×2
        check('redetect: first MODERATE×2 creates event', eventCount() - before === 1, `delta ${eventCount() - before}`);
        radar(D, 180); // >150 → CLEAR, no event
        check('redetect: clear reading creates no event', eventCount() - before === 1, `delta ${eventCount() - before}`);
        check('redetect: state reset after clear', obstacleState(D) && obstacleState(D).band === null, JSON.stringify(obstacleState(D)));
        radar(D, 100); radar(D, 100);
        check('redetect: detection after clear creates fresh event', eventCount() - before === 2, `delta ${eventCount() - before}`);

        // ── 5. distance < 0 never creates an event, resets state ────
        before = eventCount();
        radar(E, -1); radar(E, -1); radar(E, -0.5);
        check('neg: distance -1 creates no event', eventCount() - before === 0, `delta ${eventCount() - before}`);
        radar(E, 45); radar(E, 45);
        check('neg: normal detection after -1 works', eventCount() - before === 1, `delta ${eventCount() - before}`);

        // ── 6. distance > 150 never creates an event, resets state ──
        before = eventCount();
        radar(F, 160); radar(F, 1000); radar(F, 150.1);
        check('far: distance >150 creates no event', eventCount() - before === 0, `delta ${eventCount() - before}`);
        radar(F, 45); radar(F, 45);
        check('far: normal detection after >150 works', eventCount() - before === 1, `delta ${eventCount() - before}`);

        // ── 7. Per-device isolation ─────────────────────────────────
        before = eventCount();
        radar(G, 80); radar(G, 80); // G fires (CLOSE)
        radar(H, 140); radar(H, 140); // H fires independently (MODERATE)
        check('isolation: G and H each confirm 1 event', eventCount() - before === 2, `delta ${eventCount() - before}`);
        await sleep(80);
        radar(G, 40); radar(G, 40); // G band change (CLOSE → VERY_CLOSE)
        check('isolation: G fires its own band change', eventCount() - before === 3, `delta ${eventCount() - before}`);
        check('isolation: G state VERY_CLOSE', obstacleState(G) && obstacleState(G).band === 'VERY_CLOSE', JSON.stringify(obstacleState(G)));
        check('isolation: H state MODERATE untouched', obstacleState(H) && obstacleState(H).band === 'MODERATE', JSON.stringify(obstacleState(H)));

        // ── 8. Band boundaries ─────────────────────────────────────
        before = eventCount();
        radar(I, 150); radar(I, 150); // == safe max → MODERATE obstacle
        check('boundary: 150 cm is an obstacle', eventCount() - before === 1, `delta ${eventCount() - before}`);
        radar(J, 150.1); radar(J, 150.1); // > safe max → clear
        check('boundary: 150.1 cm is clear', eventCount() - before === 1, `delta ${eventCount() - before}`);
        radar(K, 90); radar(K, 90); // == close max → CLOSE obstacle
        check('boundary: 90 cm is an obstacle', eventCount() - before === 2, `delta ${eventCount() - before}`);
        radar(L, 90.1); radar(L, 90.1); // just above → MODERATE obstacle
        check('boundary: 90.1 cm is still an obstacle (MODERATE)', eventCount() - before === 3, `delta ${eventCount() - before}`);
        radar(M, 50); radar(M, 50); // == very-close max → VERY_CLOSE obstacle
        check('boundary: 50 cm is an obstacle', eventCount() - before === 4, `delta ${eventCount() - before}`);
        radar(N, 50.1); radar(N, 50.1); // just above → CLOSE obstacle
        check('boundary: 50.1 cm is still an obstacle (CLOSE)', eventCount() - before === 5, `delta ${eventCount() - before}`);

        // ── 9. Stability: 2 consecutive readings required ───────────
        before = eventCount();
        radar(B, 70); // single reading, not yet confirmed
        check('stable: single reading creates no event', eventCount() - before === 0, `delta ${eventCount() - before}`);
        radar(B, 190); // CLEAR aborts the confirmation.
        radar(B, 20); // single VERY_CLOSE, not yet confirmed.
        check('stable: interrupted confirmation creates no event', eventCount() - before === 0, `delta ${eventCount() - before}`);
        radar(B, 70); radar(B, 70);
        check('stable: a fresh 2× run still confirms', eventCount() - before === 1, `delta ${eventCount() - before}`);

        // ── 10. Rapid single-reading alternation → no events ────────
        before = eventCount();
        radar(N, 80); radar(N, 40); radar(N, 80); radar(N, 40);
        radar(N, 80); radar(N, 40); radar(N, 80); radar(N, 40);
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