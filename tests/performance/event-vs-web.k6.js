/**
 * ADR-0006 / M-06: Event Functions (API Gateway HTTP API + Lambda) vs Lambda Web Functions,
 * same business logic, same DynamoDB table, same workload. Run the script once per TARGET and
 * compare the two summary exports plus the CloudWatch evidence
 * (collect-metrics.mjs for the Event side, collect-web-metrics.mjs for the Web side).
 *
 *   # Event Functions (bearer token, API Gateway)
 *   TARGET=event PAAS_API_URL=https://<api-id>.execute-api.ap-northeast-1.amazonaws.com \
 *     k6 run --summary-export tests/performance/results/<date>.event.summary.json tests/performance/event-vs-web.k6.js
 *
 *   # Web Functions (IamAuth endpoint: SigV4, service "lambda", X-Amz-Content-SHA256 required)
 *   eval "$(aws configure export-credentials --format env)"   # AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN
 *   TARGET=web PAAS_WEB_URL=https://<domain>.lambda-web.ap-northeast-1.on.aws AWS_REGION=ap-northeast-1 \
 *     k6 run --summary-export tests/performance/results/<date>.web.summary.json tests/performance/event-vs-web.k6.js
 *
 * Lambda strips the `Authorization` header after validating the SigV4 signature on IamAuth
 * endpoints, so the sandbox claims travel in `x-paas-sandbox-claims` (signed, see
 * apps/example-order-service/src/entrypoints/web/server.ts). The Event side keeps the bearer
 * token so that the API Gateway authorizer path is measured as deployed.
 *
 * Profile (ADR-0006 Evidence table, defaults = template values; override with env):
 *   steady STEADY_RPS for STEADY_DURATION, then burst 0 -> BURST_TARGET_RPS over BURST_RAMP,
 *   hold BURST_HOLD. Mix: WRITE_RATIO of requests are POST /orders, the rest GET /orders?limit=20.
 */
import http from 'k6/http';
import encoding from 'k6/encoding';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { SignatureV4, Endpoint } from 'https://jslib.k6.io/aws/0.14.0/signature.js';

const TARGET = __ENV.TARGET || 'event';
const REGION = __ENV.AWS_REGION || 'ap-northeast-1';
const BASE = TARGET === 'web' ? __ENV.PAAS_WEB_URL : __ENV.PAAS_API_URL;
if (!BASE) throw new Error(`set ${TARGET === 'web' ? 'PAAS_WEB_URL' : 'PAAS_API_URL'}`);

const STEADY_RPS = Number(__ENV.STEADY_RPS || 50);
const STEADY_DURATION = __ENV.STEADY_DURATION || '10m';
const BURST_TARGET_RPS = Number(__ENV.BURST_TARGET_RPS || 200);
const BURST_RAMP = __ENV.BURST_RAMP || '2m';
const BURST_HOLD = __ENV.BURST_HOLD || '1m';
const WRITE_RATIO = Number(__ENV.WRITE_RATIO || 0.5);

const latencyCreate = new Trend('create_order_latency', true);
const latencyList = new Trend('list_orders_latency', true);
const throttled = new Rate('throttled');
const serverErrors = new Rate('server_errors');
const coldHint = new Counter('responses_with_lambda_web_logstream_header');

const TENANTS = ['perf-a', 'perf-b', 'perf-c', 'perf-premium'];
function claims(tenantId, tenantTier) {
  return encoding.b64encode(JSON.stringify({ tenantId, tenantTier, sub: 'perf' }), 'rawurl');
}

const signer =
  TARGET === 'web'
    ? new SignatureV4({
        service: 'lambda', // web-functions-endpoint-access-control.html "Signing requests"
        region: REGION,
        credentials: {
          accessKeyId: __ENV.AWS_ACCESS_KEY_ID,
          secretAccessKey: __ENV.AWS_SECRET_ACCESS_KEY,
          sessionToken: __ENV.AWS_SESSION_TOKEN,
        },
        uriEscapePath: true,
        applyChecksum: true, // adds X-Amz-Content-SHA256, which IamAuth endpoints require
      })
    : null;

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: STEADY_RPS,
      timeUnit: '1s',
      duration: STEADY_DURATION,
      preAllocatedVUs: Math.max(10, STEADY_RPS),
      maxVUs: Math.max(50, STEADY_RPS * 4),
    },
    burst: {
      executor: 'ramping-arrival-rate',
      startTime: STEADY_DURATION,
      startRate: 0,
      timeUnit: '1s',
      stages: [
        { target: BURST_TARGET_RPS, duration: BURST_RAMP },
        { target: BURST_TARGET_RPS, duration: BURST_HOLD },
      ],
      preAllocatedVUs: Math.max(50, BURST_TARGET_RPS / 2),
      maxVUs: Math.max(200, BURST_TARGET_RPS * 2),
    },
  },
  thresholds: {
    'create_order_latency{scenario:steady}': ['p(99)<500'],
    'server_errors{scenario:steady}': ['rate<0.001'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  tags: { target: TARGET },
};

function send(method, path, query, body, extraHeaders) {
  const headers = Object.assign({ 'content-type': 'application/json' }, extraHeaders);
  if (TARGET === 'web') {
    const signed = signer.sign(
      {
        method,
        endpoint: new Endpoint(BASE),
        path,
        query,
        headers,
        body: body || '',
      },
      { signingService: 'lambda', signingRegion: REGION },
    );
    return http.request(method, signed.url, body || null, { headers: signed.headers });
  }
  const qs = Object.keys(query)
    .map((k) => `${k}=${encodeURIComponent(query[k])}`)
    .join('&');
  return http.request(method, `${BASE}${path}${qs ? `?${qs}` : ''}`, body || null, { headers });
}

export default function () {
  const tenant = TENANTS[Math.floor(Math.random() * TENANTS.length)];
  const tier = tenant === 'perf-premium' ? 'premium' : 'standard';
  const identity =
    TARGET === 'web'
      ? { 'x-paas-sandbox-claims': claims(tenant, tier) }
      : { authorization: `Bearer ${claims(tenant, tier)}` };
  const correlation = { 'x-correlation-id': `m06-${TARGET}-${__VU}-${__ITER}` };

  let res;
  if (Math.random() < WRITE_RATIO) {
    res = send(
      'POST',
      '/orders',
      {},
      JSON.stringify({
        customerRef: 'perf',
        lines: [{ sku: 'SKU-1', quantity: 1, unitPrice: { amount: 100, currency: 'JPY' } }],
      }),
      Object.assign({ 'idempotency-key': `m06-${uuidv4()}` }, identity, correlation),
    );
    latencyCreate.add(res.timings.duration);
    check(res, {
      'created or throttled': (r) => r.status === 201 || r.status === 429 || r.status === 503,
    });
  } else {
    res = send('GET', '/orders', { limit: '20' }, null, Object.assign({}, identity, correlation));
    latencyList.add(res.timings.duration);
    check(res, {
      'listed or throttled': (r) => r.status === 200 || r.status === 429 || r.status === 503,
    });
  }
  throttled.add(res.status === 429 || res.status === 503);
  serverErrors.add(res.status >= 500 && res.status !== 503);
  if (res.headers['Lambda-Web-Logstream']) coldHint.add(1);
}
