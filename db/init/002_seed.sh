#!/bin/sh
# Deterministic seed: the same SEED_PARCELS always produces the same rows (no random()).
# Default: 200,000 parcels and ~3,000,000 tracking events (5 to 25 per parcel, 15 on average).
set -eu

PARCELS="${SEED_PARCELS:-200000}"
echo "seed: ${PARCELS} parcels"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v parcels="$PARCELS" <<'SQL'
INSERT INTO parcels (tracking_code, status, origin, destination, created_at)
SELECT 'NW' || lpad(i::text, 9, '0'),
       (ARRAY['label_created','in_transit','out_for_delivery','delivered','exception'])[1 + i % 5],
       (ARRAY['Lisbon','Porto','Madrid','Barcelona','Paris','Lyon','Berlin','Hamburg'])[1 + i % 8],
       (ARRAY['Lisbon','Porto','Madrid','Barcelona','Paris','Lyon','Berlin','Hamburg'])[1 + (i * 7 + 3) % 8],
       timestamptz '2026-01-01 00:00:00+00' + (i % 300) * interval '1 day' + (i % 1440) * interval '1 minute'
FROM generate_series(1, :parcels) AS i;

-- Events are inserted in time order, not grouped by parcel, so one parcel's events are
-- spread across the table the way they would be in production (scans then touch many pages).
INSERT INTO tracking_events (parcel_id, status, location, occurred_at)
SELECT p.id,
       (ARRAY['label_created','picked_up','in_transit','at_hub','out_for_delivery'])[1 + k % 5],
       (ARRAY['Lisbon','Porto','Madrid','Barcelona','Paris','Lyon','Berlin','Hamburg'])[1 + (p.id + k) % 8],
       p.created_at + k * interval '7 hours'
FROM parcels p
CROSS JOIN LATERAL generate_series(1, 5 + (p.id % 21)::int) AS k
ORDER BY 4;

ANALYZE;
SQL

echo "seed: done"
