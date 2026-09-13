-- 001_initial_schema.sql
-- Stage 1 — PostgreSQL database foundation for the Smart Assistive Cap.
--
-- Creates the initial schema (tables, constraints, indexes) for:
--   users, sessions, care_relationships, devices,
--   walle_sessions, walle_messages, events
--
-- No data is inserted. The migration runner wraps this file in a transaction.
--
-- NOTE: gen_random_uuid() is built into PostgreSQL 13+ (core, no extension).
-- Target environment is PostgreSQL 18.

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
-- Shared trigger function that stamps updated_at on UPDATE for tables that
-- keep an updated_at column.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('BLIND_USER', 'CARETAKER')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive unique email (functional index on lower(email)).
CREATE UNIQUE INDEX users_email_ci_unique ON users (LOWER(email));

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
-- Authenticated caretaker/user sessions (auth itself is a later stage).
-- Sessions are transient: they are removed when the user is deleted.
CREATE TABLE sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip           TEXT,
    user_agent   TEXT
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- ---------------------------------------------------------------------------
-- care_relationships
-- ---------------------------------------------------------------------------
-- Links a caretaker to the blind users they care for. Supports one caretaker
-- with many blind users AND one blind user with many caretakers.
-- A user must never be related to themselves.
CREATE TABLE care_relationships (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blind_user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    caretaker_id  UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE', 'INACTIVE')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT care_relationships_distinct_users CHECK (blind_user_id <> caretaker_id),
    CONSTRAINT care_relationships_pair_unique UNIQUE (blind_user_id, caretaker_id)
);

-- caretaker_id is not the leading column of the unique constraint, so it needs
-- its own index. Queries by blind_user_id use the unique constraint prefix.
CREATE INDEX care_relationships_caretaker_idx ON care_relationships (caretaker_id);

CREATE TRIGGER care_relationships_set_updated_at
BEFORE UPDATE ON care_relationships
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------
-- A physical Guardian device (ESP32, e.g. "BG001"). A device belongs to one
-- blind user; secret_hash is nullable because device authentication is a later
-- stage. This table is for future ownership lookup — MQTT is not modified here.
CREATE TABLE devices (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blind_user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_identifier TEXT NOT NULL UNIQUE,
    friendly_name     TEXT,
    secret_hash       TEXT,
    status            TEXT,
    last_seen_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX devices_blind_user_idx ON devices (blind_user_id);

CREATE TRIGGER devices_set_updated_at
BEFORE UPDATE ON devices
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- walle_sessions
-- ---------------------------------------------------------------------------
-- A Wall-E conversation session for a blind user (optionally tied to a device).
-- Will replace the in-memory conversation-store ownership model later.
CREATE TABLE walle_sessions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blind_user_id  UUID REFERENCES users (id) ON DELETE SET NULL,
    device_id      UUID REFERENCES devices (id) ON DELETE SET NULL,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recent sessions of a blind user.
CREATE INDEX walle_sessions_user_active_idx
    ON walle_sessions (blind_user_id, last_active_at);

-- Look up sessions by device.
CREATE INDEX walle_sessions_device_idx ON walle_sessions (device_id);

-- ---------------------------------------------------------------------------
-- walle_messages
-- ---------------------------------------------------------------------------
-- A single turn in a Wall-E conversation. The model name is stored when known.
-- No API keys or trusted sensor context are ever stored here.
CREATE TABLE walle_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES walle_sessions (id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    model      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transcript reads for one session, in chronological order.
CREATE INDEX walle_messages_session_created_idx
    ON walle_messages (session_id, created_at);

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
-- Alert / sensor events matching the existing in-memory event model:
--   triggers  : SOS, HEART_RATE, SOS_AND_HEART_RATE, NORMAL,
--               OBSTACLE_LEFT, OBSTACLE_CENTER, OBSTACLE_RIGHT
--   statuses  : NORMAL, ACTIVE, ACKNOWLEDGED, RESOLVED
-- The lifecycle ACTIVE -> ACKNOWLEDGED -> RESOLVED is preserved; status is a
-- free-standing CHECK constraint. Existing API field `timestamp` maps to the
-- `occurred_at` column below.
CREATE TABLE events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id      TEXT NOT NULL UNIQUE,
    blind_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    device_id     UUID REFERENCES devices (id) ON DELETE SET NULL,
    trigger       TEXT NOT NULL CHECK (trigger IN (
                      'SOS',
                      'HEART_RATE',
                      'SOS_AND_HEART_RATE',
                      'NORMAL',
                      'OBSTACLE_LEFT',
                      'OBSTACLE_CENTER',
                      'OBSTACLE_RIGHT'
                  )),
    status        TEXT NOT NULL CHECK (status IN (
                      'NORMAL',
                      'ACTIVE',
                      'ACKNOWLEDGED',
                      'RESOLVED'
                  )),
    heart_rate    INTEGER CHECK (heart_rate >= 0 AND heart_rate <= 400),
    latitude      DOUBLE PRECISION CHECK (latitude  >= -90  AND latitude  <= 90),
    longitude     DOUBLE PRECISION CHECK (longitude >= -180 AND longitude <= 180),
    source        TEXT,
    message       TEXT,
    distance      DOUBLE PRECISION CHECK (distance >= 0),
    angle         DOUBLE PRECISION,
    danger        TEXT,
    occurred_at   TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Timeline of one blind user's events.
CREATE INDEX events_blind_user_occurred_idx
    ON events (blind_user_id, occurred_at);

-- Filtering a blind user's events by lifecycle status.
CREATE INDEX events_blind_user_status_idx
    ON events (blind_user_id, status);

-- Timeline of one device's events.
CREATE INDEX events_device_occurred_idx
    ON events (device_id, occurred_at);

-- Quick lookup of currently-active alerts.
CREATE INDEX events_active_occurred_idx
    ON events (occurred_at DESC)
    WHERE status = 'ACTIVE';

-- alert_id uniqueness is enforced by the UNIQUE constraint above; a separate
-- index is not required for it.

CREATE TRIGGER events_set_updated_at
BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();