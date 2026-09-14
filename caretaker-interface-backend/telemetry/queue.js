'use strict';

// Stage 5 — Bounded persistence queue for best-effort database writes.
//
// Everything on the memory hot path stays synchronous and never blocks on the
// database. When the database is unavailable, write *requests* are handed to a
// queue that drains as fast as PostgreSQL allows. The caller (server.js)
// applies the queued item through the scheduled function; every item kind is
// idempotent at the SQL level (event ON CONFLICT DO NOTHING, status UPDATE,
// single-row latest-state upsert), so a retried item can never corrupt data.

const DEFAULT_MAX = 500;
const RETRY_BACKOFF_MS = 500;

function createPersistenceQueue(options = {}) {
    const max = Number.isInteger(options.max) && options.max > 0 ? options.max : DEFAULT_MAX;
    const apply = typeof options.apply === 'function' ? options.apply : null;

    const queue = [];
    let failed = 0;
    let draining = false;
    let retryTimer = null;

    function scheduleRetry() {
        if (retryTimer || failed === 0 || !draining) {
            return;
        }
        retryTimer = setTimeout(() => {
            retryTimer = null;
            flush();
        }, RETRY_BACKOFF_MS);
        if (typeof retryTimer.unref === 'function') {
            retryTimer.unref();
        }
    }

    function afterApply(error) {
        failed = error ? failed + 1 : 0;
        if (failed >= 10) {
            // Give the destination a real chance to recover before retrying.
            failed = 0;
        }
        draining = false;
        // A pending failure stops the drain; retry it first, then continue.
        if (error) {
            scheduleRetry();
        } else {
            flush();
        }
    }

    function flush() {
        if (draining || queue.length === 0) {
            return;
        }
        if (!apply) {
            queue.length = 0;
            return;
        }
        const item = queue[0];
        draining = true;
        let settled = false;
        let result;
        try {
            result = apply(item);
        } catch (error) {
            settled = true;
            afterApply(error);
            return;
        }
        if (result && typeof result.then === 'function') {
            result.then(
                () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    queue.shift();
                    afterApply(null);
                },
                (error) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    afterApply(error);
                }
            );
        } else {
            settled = true;
            queue.shift();
            afterApply(null);
        }
    }

    function enqueue(item) {
        if (queue.length >= max) {
            // Drop the oldest queued write while the database is down so the
            // queue can never grow without bound (this is what the 500-item
            // TELEMETRY_QUEUE_MAX governs).
            queue.shift();
        }
        queue.push(item);
        flush();
    }

    function size() {
        return queue.length;
    }

    function drain() {
        if (draining) {
            return;
        }
        flush();
    }

    return { enqueue, size, drain };
}

module.exports = { createPersistenceQueue, DEFAULT_MAX };