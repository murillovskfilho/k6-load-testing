import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { ENDPOINTS } from './traffic.js';

export const SUMMARY_TREND_STATS = ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'];

// Same gates on the aggregate and on each endpoint, so the summary also carries
// per-endpoint latency (k6 only reports sub-metrics that have a threshold).
export function thresholds({ p95, errorRate, checkRate }) {
  const t = {
    http_req_failed: [`rate<${errorRate}`],
    http_req_duration: [`p(95)<${p95}`],
    checks: [`rate>=${checkRate}`],
  };
  for (const name of Object.values(ENDPOINTS)) {
    t[`http_req_duration{name:${name}}`] = [`p(95)<${p95}`];
  }
  return t;
}

// Prints the usual console summary and, when VARIANT is set, saves the full
// summary as JSON. scripts/report.mjs builds the README tables from those files.
export function summaryFor(scenario) {
  return function handleSummary(data) {
    const out = { stdout: textSummary(data, { indent: ' ', enableColors: true }) };
    const variant = __ENV.VARIANT;
    if (variant) {
      const dir = __ENV.RESULTS_DIR || 'results';
      out[`${dir}/${variant}/${scenario}.json`] = JSON.stringify(data, null, 2);
    }
    return out;
  };
}
