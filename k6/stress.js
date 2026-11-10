// Stress: step past expected peak (50 users) to find where the system breaks
// and how it fails: slower, erroring, or both. Thresholds are looser on purpose;
// the goal is to locate the limit, not to pass at any cost.
import exec from 'k6/execution';
import { userAction } from './lib/traffic.js';
import { thresholds, summaryFor, SUMMARY_TREND_STATS } from './lib/common.js';

const STEPS = [
  { until: 60, tag: '050_vus' },
  { until: 120, tag: '100_vus' },
  { until: 180, tag: '200_vus' },
  { until: Infinity, tag: '300_vus' },
];

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '30s', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '30s', target: 100 },
        { duration: '30s', target: 200 },
        { duration: '30s', target: 200 },
        { duration: '30s', target: 300 },
        { duration: '1m', target: 300 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    ...thresholds({ p95: 1500, errorRate: 0.05, checkRate: 0.95 }),
    // One series per load step, so the summary shows where latency bends.
    ...Object.fromEntries(STEPS.map((s) => [`http_req_duration{step:${s.tag}}`, ['p(95)<1500']])),
    ...Object.fromEntries(STEPS.map((s) => [`http_req_failed{step:${s.tag}}`, ['rate<0.05']])),
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
};

export default function () {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  exec.vu.metrics.tags.step = STEPS.find((s) => elapsed < s.until).tag;
  userAction();
}

export const handleSummary = summaryFor('stress');
