/**
 * k6 load / overload test for the order API (guideline §10 性能・容量, §11).
 *
 *   PAAS_API_URL=https://xxx.execute-api.ap-northeast-1.amazonaws.com \
 *   k6 run --out json=tests/performance/results/order-api.json tests/performance/order-api.k6.js
 *
 * Measures (acceptance criteria): p50/p95/p99 latency, error rate, throttles (429/503) and the
 * tipping point. Compare the numbers with the SLO in apps/example-order-service/service.yaml.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const latencyCreate = new Trend('create_order_latency', true);
const throttled = new Rate('throttled');

const BASE = __ENV.PAAS_API_URL;
const TENANTS = ['perf-a', 'perf-b', 'perf-c', 'perf-premium'];

function token(tenantId, tenantTier) {
  return encoding.b64encode(JSON.stringify({ tenantId, tenantTier, sub: 'perf' }), 'rawurl');
}
import encoding from 'k6/encoding';

// Load profile is parameterised so the same script serves the smoke run in CI and the full
// measurement (docs/decision/template-defaults.md M-items). Defaults = the full profile.
const STEADY_RPS = Number(__ENV.STEADY_RPS || 50);
const STEADY_DURATION = __ENV.STEADY_DURATION || '5m';
const OVERLOAD_TARGET_RPS = Number(__ENV.OVERLOAD_TARGET_RPS || 400);
const OVERLOAD_RAMP = __ENV.OVERLOAD_RAMP || '3m';
const OVERLOAD_HOLD = __ENV.OVERLOAD_HOLD || '2m';

export const options = {
  scenarios: {
    // Steady state at the planned RPS: validates the p99 SLO.
    steady: {
      executor: 'constant-arrival-rate',
      rate: STEADY_RPS,
      timeUnit: '1s',
      duration: STEADY_DURATION,
      preAllocatedVUs: Math.max(10, STEADY_RPS),
      maxVUs: Math.max(50, STEADY_RPS * 4),
    },
    // Overload: push past the stage throttle and the account/function concurrency to find the
    // tipping point and confirm goodput stays flat (Amazon Builders' Library: load shedding +
    // rate limiting).
    overload: {
      executor: 'ramping-arrival-rate',
      startTime: STEADY_DURATION,
      startRate: STEADY_RPS,
      timeUnit: '1s',
      stages: [
        { target: OVERLOAD_TARGET_RPS, duration: OVERLOAD_RAMP },
        { target: OVERLOAD_TARGET_RPS, duration: OVERLOAD_HOLD },
      ],
      preAllocatedVUs: Math.max(50, OVERLOAD_TARGET_RPS / 2),
      maxVUs: Math.max(200, OVERLOAD_TARGET_RPS * 2),
    },
  },
  thresholds: {
    create_order_latency: ['p(99)<500'],
    'http_req_failed{scenario:steady}': ['rate<0.001'],
  },
};

export default function () {
  const tenant = TENANTS[Math.floor(Math.random() * TENANTS.length)];
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token(tenant, tenant === 'perf-premium' ? 'premium' : 'standard')}`,
    'idempotency-key': `perf-${uuidv4()}`,
    'x-correlation-id': `perf-${__VU}-${__ITER}`,
  };
  const res = http.post(
    `${BASE}/orders`,
    JSON.stringify({
      customerRef: 'perf',
      lines: [{ sku: 'SKU-1', quantity: 1, unitPrice: { amount: 100, currency: 'JPY' } }],
    }),
    { headers },
  );
  latencyCreate.add(res.timings.duration);
  throttled.add(res.status === 429 || res.status === 503);
  check(res, {
    'created or throttled': (r) => r.status === 201 || r.status === 429 || r.status === 503,
  });
  sleep(0.1);
}
