-- Schema for the parcel tracking API.
-- Runs once, on the first start of an empty database volume.

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE parcels (
    id            bigserial PRIMARY KEY,
    tracking_code text        NOT NULL UNIQUE,
    status        text        NOT NULL,
    origin        text        NOT NULL,
    destination   text        NOT NULL,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The foreign key below does NOT create an index on parcel_id.
-- PostgreSQL indexes the referenced side (parcels.id, the primary key) but never
-- the referencing column. That gap is the bottleneck this repository finds;
-- the fix is 003_index_tracking_events_parcel_id.sql.
CREATE TABLE tracking_events (
    id          bigserial PRIMARY KEY,
    parcel_id   bigint      NOT NULL REFERENCES parcels (id),
    status      text        NOT NULL,
    location    text        NOT NULL,
    occurred_at timestamptz NOT NULL
);
