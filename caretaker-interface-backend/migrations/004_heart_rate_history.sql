-- 004_heart_rate_history.sql
-- Stage: On-demand heart-rate monitoring — device-scoped reading history.
--
-- The caretaker dashboard needs a per-device heart-rate history that is NOT the
-- alert event feed: keeping normal readings in `events` would broadcast them
-- over SSE as emergency traffic and pollute the Wall-E context. Readings from
-- all three sources — CONTINUOUS telemetry (the ESP32 MAX30102 stream), MANUAL
-- (caretaker "Get Heart Rate" button) and AUTOMATIC (backend 5-min / high-freq
-- schedule) — therefore share this table.
--
-- Additive only: events, latest_states, walle_* and migrations 001/002/003 are
-- left intact. One new table + supporting indexes. No data backfills required.

-- ---------------------------------------------------------------------------
-- heart_rate_history
-- ---------------------------------------------------------------------------
-- Identity follows the existing event model: the STRING device identifier is
-- always preserved (device_identifier), while the UUID FKs (device_id,
-- blind_user_id) are resolved for joins/ownership when the device is a
-- registered cap record. Unknown/unregistered device ids simply stay NULL on
-- the FK columns — identity is never invented.
CREATE TABLE heart_rate_history (
    id                BIGSERIAL PRIMARY KEY,
    blind_user_id     UUID REFERENCES users (id) ON DELETE SET NULL,
    device_id         UUID REFERENCES devices (id) ON DELETE SET NULL,
    device_identifier TEXT    NOT NULL,
    heart_rate        INTEGER NOT NULL CHECK (heart_rate >= 0 AND heart_rate <= 400),
    classification    TEXT    NOT NULL CHECK (classification IN ('NORMAL', 'HIGH', 'LOW')),
    reading_type      TEXT    NOT NULL CHECK (reading_type IN ('CONTINUOUS', 'MANUAL', 'AUTOMATIC')),
    request_id        TEXT,
    occurred_at       TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-device timeline, newest-first (the history endpoint + boot rehydration).
CREATE INDEX heart_rate_history_device_occurred_idx
    ON heart_rate_history (device_identifier, occurred_at DESC);

-- De-duplication guard: a repeatedly delivered reading (queued retry, MQTT
-- redelivery, a duplicate beat publication, or a stale on-demand response that
-- re-arrives) can never insert two rows. The engine's pending-request timeout
-- makes replay harmless; this index makes it invisible in history.
CREATE UNIQUE INDEX heart_rate_history_reading_dedup_unique
    ON heart_rate_history (device_identifier, occurred_at, heart_rate, reading_type);