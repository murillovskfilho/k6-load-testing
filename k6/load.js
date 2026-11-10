// Load: expected peak traffic, held long enough to see a steady state.
// 50 concurrent users with 0.5-1.5 s think time is roughly 50 requests per second.
import { userAction } from './lib/traffic.js';
import { thresholds, summaryFor, SUMMARY_TREND_STATS } from './lib/common.js';

export const options = {
  scenarios: {
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 50 },
        { duration: '3m', target: 50 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: thresholds({ p95: 500, errorRate: 0.01, checkRate: 0.99 }),
  summaryTrendStats: SUMMARY_TREND_STATS,
};

export default userAction;
export const handleSummary = summaryFor('load');
