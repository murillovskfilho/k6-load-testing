-- The fix. Covers the hot query in GET /parcels/:code/events:
--   WHERE parcel_id = $1 ORDER BY occurred_at DESC LIMIT 50
-- The composite key serves both the filter and the sort, so Postgres reads at most
-- 50 index entries instead of scanning the whole table and sorting.
--
-- On a live production table this would be CREATE INDEX CONCURRENTLY (no write lock),
-- which cannot run inside a transaction block. Init scripts run on an empty, offline
-- database, so the plain form is used here.
CREATE INDEX IF NOT EXISTS idx_tracking_events_parcel_id_occurred_at
    ON tracking_events (parcel_id, occurred_at DESC);

ANALYZE tracking_events;
