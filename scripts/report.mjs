#!/usr/bin/env node
// Builds the results tables from the k6 summary JSON files in results/before and
// results/after, writes results/REPORT.md and replaces the block between the
// report markers in README.md. Every number in that block comes from these files.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = path.join(ROOT, 'results');
const SCENARIOS = ['smoke', 'load', 'stress', 'spike'];
const VARIANTS = ['before', 'after'];
const HOT = 'GET /parcels/:code/events';
const DETAIL = 'GET /parcels/:code';
const START = '<!-- report:start -->';
const END = '<!-- report:end -->';

const load = (variant, file) => {
  const p = path.join(RESULTS, variant, file);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};
const summary = (variant, scenario) => {
  const raw = load(variant, `${scenario}.json`);
  return raw ? JSON.parse(raw) : null;
};

const ms = (v) => {
  if (v == null || Number.isNaN(v)) return 'n/a';
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (v >= 100) return `${v.toFixed(0)} ms`;
  return `${v.toFixed(1)} ms`;
};
const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(2)}%`);
const ratio = (before, after) => {
  if (!before || !after) return 'n/a';
  const r = before / after;
  return r >= 1 ? `${r.toFixed(r >= 10 ? 0 : 1)}x faster` : `${(1 / r).toFixed(1)}x slower`;
};
const table = (head, rows) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join(
    '\n',
  );

const trend = (s, key) => s?.metrics[key]?.values;
const rate = (s, key) => s?.metrics[key]?.values.rate;
const failedThresholds = (s) =>
  Object.entries(s.metrics)
    .filter(([, m]) => m.thresholds && Object.values(m.thresholds).some((t) => !t.ok))
    .map(([k]) => k);

function overview() {
  const rows = [];
  for (const scenario of SCENARIOS) {
    for (const variant of VARIANTS) {
      const s = summary(variant, scenario);
      if (!s) continue;
      const d = trend(s, 'http_req_duration');
      const failed = failedThresholds(s);
      rows.push([
        `${scenario}`,
        variant,
        s.metrics.http_reqs.values.count.toLocaleString('en-US'),
        s.metrics.http_reqs.values.rate.toFixed(1),
        ms(d.med),
        ms(d['p(95)']),
        ms(d['p(99)']),
        pct(rate(s, 'http_req_failed')),
        failed.length === 0 ? 'pass' : `**fail** (${failed.length})`,
      ]);
    }
  }
  return table(['Scenario', 'Schema', 'Requests', 'Req/s', 'p50', 'p95', 'p99', 'Errors', 'Thresholds'], rows);
}

function hotEndpoint() {
  const rows = [];
  for (const scenario of SCENARIOS) {
    const [b, a] = VARIANTS.map((v) => summary(v, scenario));
    if (!b || !a) continue;
    const p95 = (s, name) => trend(s, `http_req_duration{name:${name}}`)?.['p(95)'];
    rows.push([
      scenario,
      ms(p95(b, HOT)),
      ms(p95(a, HOT)),
      ratio(p95(b, HOT), p95(a, HOT)),
      ms(p95(b, DETAIL)),
      ms(p95(a, DETAIL)),
    ]);
  }
  return table(
    ['Scenario', `\`${HOT}\` p95 before`, 'after', 'change', `\`${DETAIL}\` p95 before`, 'after'],
    rows,
  );
}

function byTag(scenario, tag, values) {
  const rows = [];
  for (const value of values) {
    const cells = [value.replace(/^0+/, '').replace('_vus', ' VUs').replace('_', ' ')];
    for (const variant of VARIANTS) {
      const s = summary(variant, scenario);
      cells.push(
        ms(trend(s, `http_req_duration{${tag}:${value}}`)?.['p(95)']),
        pct(rate(s, `http_req_failed{${tag}:${value}}`)),
      );
    }
    rows.push(cells);
  }
  return table([tag === 'step' ? 'Load step' : 'Phase', 'p95 before', 'errors before', 'p95 after', 'errors after'], rows);
}

function dbEvidence() {
  const lines = [];
  for (const variant of VARIANTS) {
    const explain = load(variant, 'explain.txt');
    const stmts = load(variant, 'pg_stat_statements.txt');
    if (!explain || !stmts) continue;
    const exec = explain.match(/Execution Time: ([\d.]+) ms/)?.[1];
    const scan = explain.match(/(Parallel Seq Scan|Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan)[^\n]* on tracking_events/)?.[1];
    const buffers = explain.match(/Buffers: shared ([^\n]+)/)?.[1]?.trim();
    const hot = stmts.split('\n').find((l) => l.includes('FROM tracking_events WHERE parcel_id'));
    const [calls, , mean, share] = hot ? hot.split('|').map((c) => c.trim()) : [];
    lines.push(
      `| ${variant} | ${scan ?? 'n/a'} | ${buffers ?? 'n/a'} | ${exec ? `${exec} ms` : 'n/a'} | ${
        calls ? Number(calls).toLocaleString('en-US') : 'n/a'
      } | ${mean ? `${mean} ms` : 'n/a'} | ${share ? `${share}%` : 'n/a'} |`,
    );
  }
  if (lines.length === 0) return '_No database evidence yet._';
  return [
    '| Schema | Plan for the hot query | Buffers (one call) | EXPLAIN ANALYZE time | Calls (whole suite) | Mean time per call under load | Share of DB time |',
    '|---|---|---|---|---|---|---|',
    ...lines,
  ].join('\n');
}

function runInfo() {
  const raw = load('after', 'run.json') ?? load('before', 'run.json');
  if (!raw) return '';
  const r = JSON.parse(raw);
  const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;
  return `Measured on ${r.date.slice(0, 10)}, commit \`${r.commit}\`, ${r.k6}. Host: ${r.host.cpu}, ${r.host.logicalCpus} logical CPUs, ${r.host.os}. Docker ${r.docker.version} (${r.docker.os}, ${r.docker.cpus} CPUs, ${gb(r.docker.memoryBytes)}). Container limits: db ${r.limits.db}; api ${r.limits.api}; k6 ${r.limits.k6}.`;
}

const missing = VARIANTS.filter((v) => !summary(v, 'smoke'));
if (missing.length) {
  console.error(`missing results for: ${missing.join(', ')}. Run npm run bench:${missing[0]} first.`);
  process.exit(1);
}

const report = `_Generated by \`npm run report\` from \`results/before/*.json\` and \`results/after/*.json\`. Do not edit by hand._

${runInfo()}

**All scenarios.** Latency includes failed requests (timeouts count at their 10 s limit). "before" is the schema without the index, "after" is the same run with it.

${overview()}

**The hot endpoint against an endpoint that never touches \`tracking_events\`.**

${hotEndpoint()}

**Stress, per load step** (where the curve bends).

${byTag('stress', 'step', ['050_vus', '100_vus', '200_vus', '300_vus'])}

**Spike, per phase** (does it recover once the spike is over?). n/a: the baseline phase gates latency only, and k6 exports a tagged series only when it has a threshold.

${byTag('spike', 'phase', ['baseline', 'spike', 'recovery'])}

**Database evidence** (from \`results/*/explain.txt\` and \`results/*/pg_stat_statements.txt\`).

${dbEvidence()}`;

writeFileSync(path.join(RESULTS, 'REPORT.md'), `# Results\n\n${report}\n`);

const readmePath = path.join(ROOT, 'README.md');
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, 'utf8');
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a >= 0 && b > a) {
    writeFileSync(readmePath, `${readme.slice(0, a + START.length)}\n${report}\n${readme.slice(b)}`);
    console.log('README.md results block updated');
  }
}
console.log('results/REPORT.md written');
