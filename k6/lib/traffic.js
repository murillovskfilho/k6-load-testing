// Shared traffic model for every scenario.
// One iteration = one user action followed by think time, so VUs approximate
// concurrent users rather than a raw request rate.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PARCELS = parseInt(__ENV.PARCELS || '200000', 10);

const EVENT_STATUSES = ['picked_up', 'in_transit', 'at_hub', 'out_for_delivery'];
const CITIES = ['Lisbon', 'Porto', 'Madrid', 'Barcelona', 'Paris', 'Lyon', 'Berlin', 'Hamburg'];
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const TIMEOUT = '10s';

// Tag names group URLs with different tracking codes into one series per endpoint.
export const ENDPOINTS = {
  events: 'GET /parcels/:code/events',
  detail: 'GET /parcels/:code',
  addEvent: 'POST /parcels/:code/events',
  unknown: 'GET /parcels/:code/events (unknown)',
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const code = (n) => 'NW' + String(n).padStart(9, '0');
// Seeded codes are NW000000001..NW{PARCELS}; codes from 900000000 up never exist.
const knownCode = () => code(1 + Math.floor(Math.random() * PARCELS));
const unknownCode = () => code(900000000 + Math.floor(Math.random() * 1000000));

function trackingHistory() {
  const res = http.get(`${BASE_URL}/parcels/${knownCode()}/events`, {
    tags: { name: ENDPOINTS.events },
    timeout: TIMEOUT,
  });
  check(res, {
    'events: status 200': (r) => r.status === 200,
    'events: has 5 to 50 events': (r) => {
      if (r.status !== 200) return false;
      const n = r.json('events.#');
      return n >= 5 && n <= 50;
    },
  });
}

function parcelDetail() {
  const res = http.get(`${BASE_URL}/parcels/${knownCode()}`, {
    tags: { name: ENDPOINTS.detail },
    timeout: TIMEOUT,
  });
  check(res, {
    'detail: status 200': (r) => r.status === 200,
    'detail: has tracking_code': (r) => r.status === 200 && /^NW\d{9}$/.test(r.json('tracking_code')),
  });
}

function addScanEvent() {
  const res = http.post(
    `${BASE_URL}/parcels/${knownCode()}/events`,
    JSON.stringify({ status: pick(EVENT_STATUSES), location: pick(CITIES) }),
    { headers: JSON_HEADERS, tags: { name: ENDPOINTS.addEvent }, timeout: TIMEOUT },
  );
  check(res, { 'add event: status 201': (r) => r.status === 201 });
}

function unknownParcel() {
  // A 404 is the correct answer here, so it must not count as a failed request.
  const res = http.get(`${BASE_URL}/parcels/${unknownCode()}/events`, {
    tags: { name: ENDPOINTS.unknown },
    timeout: TIMEOUT,
    responseCallback: http.expectedStatuses(404),
  });
  check(res, { 'unknown parcel: status 404': (r) => r.status === 404 });
}

// Mix: tracking history dominates, as on any carrier's public tracking page.
export function userAction() {
  const r = Math.random();
  if (r < 0.78) trackingHistory();
  else if (r < 0.93) parcelDetail();
  else if (r < 0.98) addScanEvent();
  else unknownParcel();
  sleep(0.5 + Math.random()); // think time: 0.5 to 1.5 s
}
