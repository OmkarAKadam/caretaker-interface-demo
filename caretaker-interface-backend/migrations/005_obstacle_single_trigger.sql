-- 005_obstacle_single_trigger.sql
-- Servo removal: single forward obstacle trigger.
--
-- The cap no longer pans a servo left/right. Radar readings are a single
-- fixed forward-looking obstacle, so the three directional triggers
-- (OBSTACLE_LEFT / OBSTACLE_CENTER / OBSTACLE_RIGHT) are collapsed into one
-- OBSTACLE trigger. Historic rows are rewritten to OBSTACLE, then the events
-- CHECK constraint is relaxed to accept only the new trigger set.
--
-- Changes:
--   A. events.trigger — replace the three directional obstacle triggers with
--      a single OBSTACLE value, both for existing rows and the CHECK.
--
-- Everything else is additive and untouched.

-- ---------------------------------------------------------------------------
-- A. events: single OBSTACLE trigger
-- ---------------------------------------------------------------------------
-- Drop the directional CHECK first (changing a row to 'OBSTACLE' would violate
-- the old constraint), then normalize historical directional obstacle rows and
-- re-add the constraint with the new trigger set. Identity of a detection is
-- preserved; only the category changes.
ALTER TABLE events DROP CONSTRAINT events_trigger_check;

UPDATE events SET trigger = 'OBSTACLE' WHERE trigger IN ('OBSTACLE_LEFT', 'OBSTACLE_CENTER', 'OBSTACLE_RIGHT');

ALTER TABLE events ADD CONSTRAINT events_trigger_check CHECK (trigger IN (
    'SOS',
    'HEART_RATE',
    'SOS_AND_HEART_RATE',
    'NORMAL',
    'OBSTACLE'
));