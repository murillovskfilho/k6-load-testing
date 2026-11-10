import Fastify from 'fastify';
import pg from 'pg';

const PORT = Number(process.env.PORT ?? 3000);

// A small pool is normal for a single Node process. It is also what turns one slow
// query into a site-wide slowdown: every request queues for the same 10 connections.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://parcel:parcel@localhost:5432/parcels',
  max: Number(process.env.PG_POOL_MAX ?? 10),
  connectionTimeoutMillis: Number(process.env.PG_POOL_WAIT_MS ?? 5000),
});

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

const TRACKING_CODE = '^NW[0-9]{9}$';
const EVENT_STATUSES = ['picked_up', 'in_transit', 'at_hub', 'out_for_delivery', 'delivered', 'exception'];

const codeParams = {
  type: 'object',
  required: ['code'],
  properties: { code: { type: 'string', pattern: TRACKING_CODE } },
} as const;

app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  if (err.statusCode === 400) {
    return reply.code(400).send({ error: 'bad_request', message: err.message });
  }
  // pg-pool raises this when no connection frees up within connectionTimeoutMillis.
  if (err.message.includes('timeout exceeded when trying to connect')) {
    return reply.code(503).send({ error: 'database_busy' });
  }
  req.log.error(err);
  return reply.code(500).send({ error: 'internal_error' });
});

app.get('/health', async () => {
  await pool.query('SELECT 1');
  return { status: 'ok' };
});

app.get<{ Params: { code: string } }>('/parcels/:code', { schema: { params: codeParams } }, async (req, reply) => {
  const { rows } = await pool.query(
    `SELECT tracking_code, status, origin, destination, created_at, updated_at
       FROM parcels WHERE tracking_code = $1`,
    [req.params.code],
  );
  if (rows.length === 0) return reply.code(404).send({ error: 'parcel_not_found' });
  return rows[0];
});

app.get<{ Params: { code: string } }>(
  '/parcels/:code/events',
  { schema: { params: codeParams } },
  async (req, reply) => {
    const parcel = await pool.query('SELECT id FROM parcels WHERE tracking_code = $1', [req.params.code]);
    if (parcel.rows.length === 0) return reply.code(404).send({ error: 'parcel_not_found' });

    // The hot query. Without an index on tracking_events.parcel_id this is a full table scan.
    const events = await pool.query(
      `SELECT status, location, occurred_at
         FROM tracking_events
        WHERE parcel_id = $1
        ORDER BY occurred_at DESC
        LIMIT 50`,
      [parcel.rows[0].id],
    );
    return { tracking_code: req.params.code, events: events.rows };
  },
);

app.post<{ Params: { code: string }; Body: { status: string; location: string } }>(
  '/parcels/:code/events',
  {
    schema: {
      params: codeParams,
      body: {
        type: 'object',
        required: ['status', 'location'],
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: EVENT_STATUSES },
          location: { type: 'string', minLength: 1, maxLength: 80 },
        },
      },
    },
  },
  async (req, reply) => {
    const { rows } = await pool.query(
      `WITH p AS (
         UPDATE parcels SET status = $2, updated_at = now()
          WHERE tracking_code = $1
         RETURNING id
       )
       INSERT INTO tracking_events (parcel_id, status, location, occurred_at)
       SELECT id, $2, $3, now() FROM p
       RETURNING status, location, occurred_at`,
      [req.params.code, req.body.status, req.body.location],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'parcel_not_found' });
    return reply.code(201).send(rows[0]);
  },
);

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: PORT, host: '0.0.0.0' });
