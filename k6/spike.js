// Spike: a sudden jump from 5 to 150 users (a marketing push, a carrier outage
// clearing at once), then back down. Two questions:
//   1. how many requests fail during the spike?
//   2. does latency recover once the spike is over, or does a backlog linger?
import exec from 'k6/execution';
import { userAction } from './lib/traffic.js';
import { thresholds, summaryFor, SUMMARY_TREND_STATS } from './lib/common.js';

// Phase boundaries in seconds from the start of the scenario. Recovery starts
// 10 s after the ramp-down ends, so it measures the system, not the ramp.
const PHASES = [
  { until: 30, tag: 'baseline' },
  { until: 110, tag: 'spike' },
  { until: 120, tag: 'ramp_down' },
  { until: Infinity, tag: 'recovery' },
];

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '30s', target: 5 },
        { duration: '10s', target: 150 },
        { duration: '1m', target: 150 },
        { duration: '10s', target: 5 },
        { duration: '1m10s', target: 5 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    ...thresholds({ p95: 1500, errorRate: 0.05, checkRate: 0.95 }),
    'http_req_duration{phase:baseline}': ['p(95)<300'],
    'http_req_duration{phase:spike}': ['p(95)<1500'],
    'http_req_failed{phase:spike}': ['rate<0.05'],
    // Back to the smoke-test bar once the spike is over.
    'http_req_duration{phase:recovery}': ['p(95)<300'],
    'http_req_failed{phase:recovery}': ['rate<0.01'],
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
};

export default function () {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  exec.vu.metrics.tags.phase = PHASES.find((p) => elapsed < p.until).tag;
  userAction();
}

export const handleSummary = summaryFor('spike');
