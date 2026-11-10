// Smoke: does every endpoint answer correctly under trivial load?
// Runs on every push in CI. Any failed check or slow response fails the job.
import { userAction } from './lib/traffic.js';
import { thresholds, summaryFor, SUMMARY_TREND_STATS } from './lib/common.js';

export const options = {
  vus: 2,
  duration: '30s',
  thresholds: thresholds({ p95: 300, errorRate: 0.01, checkRate: 1 }),
  summaryTrendStats: SUMMARY_TREND_STATS,
};

export default userAction;
export const handleSummary = summaryFor('smoke');
