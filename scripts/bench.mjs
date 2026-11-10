#!/usr/bin/env node
// Runs the k6 suite against the dockerised API and stores the evidence.
//
//   node scripts/bench.mjs                      # current schema (index present) -> results/latest
//   node scripts/bench.mjs --variant before     # drop the index, run, restore it -> results/before
//   node scripts/bench.mjs --variant after      # make sure the index exists, run -> results/after
//   node scripts/bench.mjs --only smoke,load    # subset of scenarios
//
// For every variant it saves: one k6 summary JSON per scenario, the query plan of the
// hot query (explain.txt), the top statements from pg_stat_statements, and run metadata.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_SCENARIOS = ['smoke', 'load', 'stress', 'spike'];
const INDEX = 'idx_tracking_events_parcel_id_occurred_at';
const FIX_SQL = readFileSync(path.join(ROOT, 'db/init/003_index_tracking_events_parcel_id.sql'), 'utf8');
const HOT_QUERY = `SELECT status, location, occurred_at FROM tracking_events
WHERE parcel_id = 123456 ORDER BY occurred_at DESC LIMIT 50`;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const variant = opt('variant', 'latest');
if (!['before', 'after', 'latest'].includes(variant)) {
  console.error(`unknown variant "${variant}" (use before, after or latest)`);
  process.exit(2);
}
const scenarios = opt('only', ALL_SCENARIOS.join(',')).split(',');
const outDir = path.join(ROOT, 'results', variant);
// Keep Git Bash on Windows from rewriting container paths such as /scripts/load.js.
const env = { ...process.env, MSYS_NO_PATHCONV: '1', VARIANT: variant };

const compose = (...a) => execFileSync('docker', ['compose', ...a], { cwd: ROOT, env, encoding: 'utf8' });
const psql = (sql) =>
  compose('exec', '-T', 'db', 'psql', '-U', 'parcel', '-d', 'parcels', '-v', 'ON_ERROR_STOP=1', '-c', sql);
const log = (msg) => console.log(`\n[bench:${variant}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForApi() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://localhost:3000/health');
      if (res.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error('API did not become healthy within 60 s');
}

function setSchema() {
  if (variant === 'before') {
    log(`dropping ${INDEX} to reproduce the original schema`);
    psql(`DROP INDEX IF EXISTS ${INDEX}; ANALYZE tracking_events;`);
  } else {
    log(`making sure ${INDEX} exists`);
    psql(FIX_SQL);
  }
}

function saveDbEvidence() {
  const plan = psql(`EXPLAIN (ANALYZE, BUFFERS) ${HOT_QUERY}`);
  const indexes = psql(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'tracking_events'`);
  writeFileSync(path.join(outDir, 'explain.txt'), `-- ${HOT_QUERY}\n\n${plan}\n-- indexes on tracking_events\n${indexes}`);
}

const STATEMENTS_SQL = `SELECT calls,
       round(total_exec_time::numeric, 0) AS total_ms,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 1) AS pct_of_db_time,
       left(regexp_replace(query, '\\s+', ' ', 'g'), 90) AS query
  FROM pg_stat_statements
 WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'parcels')
   AND query NOT ILIKE '%pg_stat_statements%'
 ORDER BY total_exec_time DESC
 LIMIT 6`;

function runScenario(name) {
  log(`k6 ${name}`);
  const started = new Date().toISOString();
  const r = spawnSync('docker', ['compose', 'run', '--rm', 'k6', 'run', '--quiet', `/scripts/${name}.js`], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  // k6 exits 99 when a threshold fails. That is a result, not a crash.
  if (r.status !== 0 && r.status !== 99) throw new Error(`k6 ${name} exited with ${r.status}`);
  return { scenario: name, started, exitCode: r.status, thresholdsPassed: r.status === 0 };
}

function hostInfo() {
  const docker = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8' }));
  const k6 = compose('run', '--rm', 'k6', 'version').trim().split('\n')[0];
  let commit = 'uncommitted';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  return {
    date: new Date().toISOString(),
    commit,
    host: { os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model.trim(), logicalCpus: os.cpus().length },
    docker: { version: docker.ServerVersion, os: docker.OperatingSystem, cpus: docker.NCPU, memoryBytes: docker.MemTotal },
    limits: { db: '2 CPUs, 2 GB', api: '1 CPU, 512 MB, pg pool max 10', k6: '2 CPUs, 1 GB' },
    k6,
  };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  log('starting the stack');
  compose('up', '-d', '--build', '--wait');

  const runs = [];
  try {
    setSchema();
    saveDbEvidence();
    psql('SELECT pg_stat_statements_reset()');

    for (const name of scenarios) {
      // A fresh API process per scenario, so a backlog from one run cannot leak into the next.
      compose('restart', 'api');
      await waitForApi();
      runs.push(runScenario(name));
      await sleep(5000);
    }

    writeFileSync(path.join(outDir, 'pg_stat_statements.txt'), psql(STATEMENTS_SQL));
  } finally {
    if (variant === 'before') {
      log(`restoring ${INDEX}`);
      psql(FIX_SQL);
    }
  }

  writeFileSync(path.join(outDir, 'run.json'), JSON.stringify({ variant, ...hostInfo(), runs }, null, 2) + '\n');
  log(`done. Evidence in results/${variant}/`);
  for (const r of runs) console.log(`  ${r.scenario.padEnd(7)} thresholds ${r.thresholdsPassed ? 'passed' : 'FAILED'}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
