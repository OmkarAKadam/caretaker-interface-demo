-- 002_device_auth.sql
-- Stage 4 — Device identity & Blind Client authentication.
--
-- Hardens the existing `devices` table for the device-auth flow. No new
-- columns are required: secret_hash was already reserved for device
-- authentication and the rest of the shape (blind_user_id, device_identifier,
-- friendly_name, status, last_seen_at, timestamps, FKs, indexes) is unchanged.
--
-- Changes:
--   - devices.status is constrained to ONLINE / OFFLINE / ERROR
--   - new devices default to OFFLINE until authenticated activity arrives
--   - any legacy NULL status is normalised to OFFLINE first (defensive)

UPDATE devices SET status = 'OFFLINE' WHERE status IS NULL;

ALTER TABLE devices
    ADD CONSTRAINT devices_status_valid
    CHECK (status IN ('ONLINE', 'OFFLINE', 'ERROR'));

ALTER TABLE devices
    ALTER COLUMN status SET DEFAULT 'OFFLINE';