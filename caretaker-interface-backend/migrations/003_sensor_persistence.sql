-- 003_sensor_persistence.sql
-- Stage 5 — Persist existing runtime telemetry in PostgreSQL.
--
-- Everything here is additive. Existing tables, columns, CHECK constraints,
-- triggers and indexes from 001/002 are left intact. The events and walle
-- tables are empty today, so no data backfills are required.
--
-- Changes:
--   A. events  — nullable identity-compatibility columns. The in-memory event
--      model keys events by the STRING alertId and carries the device/blind-user
--      identity as strings (deviceId = device identifier, blindUserId = user
--      UUID). These two columns preserve that exact contract in PostgreSQL while
--      the existing UUID FK columns remain available for joins/ownership.
--   B. walle_sessions — client_session_id. The Wall-E API and the blind client
--      address conversations by a client-generated STRING sessionId. This
--      column carries that string; the UUID primary key is unchanged.
--   C. latest_states — cardinality-one table holding the runtime snapshots that
--      currently live only in server memory (location, device status, heart
--      rate, fall, buzzer). Single logical row (id = 1) per the audit.

-- ---------------------------------------------------------------------------
-- A. events: identity compatibility columns
-- ---------------------------------------------------------------------------
ALTER TABLE events ADD COLUMN device_identifier TEXT;
ALTER TABLE events ADD COLUMN blind_user_identifier TEXT;

-- ---------------------------------------------------------------------------
-- B. walle_sessions: client-supplied session string
-- ---------------------------------------------------------------------------
-- Defensive backfill for any rows that might exist in a long-lived dev
-- database (the table was created but never written to). The result can never
-- collide because it is derived from the UUID primary key.
ALTER TABLE walle_sessions ADD COLUMN client_session_id TEXT;
UPDATE walle_sessions SET client_session_id = 'legacy-' || id::text WHERE client_session_id IS NULL;
ALTER TABLE walle_sessions ALTER COLUMN client_session_id SET NOT NULL;

CREATE UNIQUE INDEX walle_sessions_client_session_id_unique
    ON walle_sessions (client_session_id);

-- ---------------------------------------------------------------------------
-- C. latest_states: single-row runtime snapshot
-- ---------------------------------------------------------------------------
-- One logical row (id is constrained to 1). JSONB columns preserve the exact
-- payload shapes currently held in memory, so no unnecessary sample tables are
-- created. updated_at is stamped on every upsert by the migration runner's
-- shared set_updated_at trigger-free write path (the literal is written by the
-- application); the column also keeps a default so direct inserts stay sane.
CREATE TABLE latest_states (
    id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    location      JSONB,
    device_status JSONB,
    heart_rate    JSONB,
    fall          JSONB,
    buzzer        TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);