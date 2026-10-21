/**
 * ADR-0006 Evidence row "failure isolation / memory pressure" (OOM part). Valid traffic flows at
 * RPS for DURATION; at OOM_AT seconds one request hits the sandbox-only `/__fault/oom` route,
 * which exhausts the V8 heap and kills that execution environment. Pass condition: the error rate
 * of the valid requests over the whole run stays < 1% (Lambda must route around the dead
 * environment and start a new one; only in-flight requests on the dead environment may fail).
 *
 *   eval "$(aws configure export-credentials --format env)"
 *   PAAS_WEB_URL=https://<domain> AWS_REGION=ap-northeast-1 k6 run tests/performance/web-oom-isolation.k6.js
 */
import http from 'k6/http';
import encoding from 'k6/encoding';
import { check } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { SignatureV4, Endpoint } from 'https://jslib.k6.io/aws/0.14.0/signature.js';

const BASE = __ENV.PAAS_WEB_URL;
const REGION = __ENV.AWS_REGION || 'ap-northeast-1';
const RPS = Number(__ENV.RPS || 30);
const DURATION = __ENV.DURATION || '2m';
const OOM_AT = __ENV.OOM_AT || '60s';
if (!BASE) throw new Error('set PAAS_WEB_URL');

const validErrors = new Rate('valid_request_errors');
const validErrorStatus = new Counter('valid_request_error_status');
const oomStatus = new Counter('oom_request_status');
const oomDuration = new Trend('oom_request_duration', true);

const signer = new SignatureV4({
  service: 'lambda',
  region: REGION,
  credentials: {
    accessKeyId: __ENV.AWS_ACCESS_KEY_ID,
    secretAccessKey: __ENV.AWS_SECRET_ACCESS_KEY,
    sessionToken: __ENV.AWS_SESSION_TOKEN,
  },
  uriEscapePath: true,
  applyChecksum: true,
});

export const options = {
  scenarios: {
    valid: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(10, RPS),
      maxVUs: RPS * 4,
      exec: 'valid',
    },
    oom: {
      executor: 'shared-iterations',
      iterations: 1,
      vus: 1,
      startTime: OOM_AT,
      maxDuration: '60s',
      exec: 'oom',
    },
  },
  thresholds: { valid_request_errors: ['rate<0.01'] },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

function claims(tenantId) {
  return encoding.b64encode(
    JSON.stringify({ tenantId, tenantTier: 'standard', sub: 'oom' }),
    'rawurl',
  );
}

function signed(method, path, body, extra) {
  const headers = Object.assign({ 'content-type': 'application/json' }, extra);
  return signer.sign(
    { method, endpoint: new Endpoint(BASE), path, query: {}, headers, body: body || '' },
    { signingService: 'lambda', signingRegion: REGION },
  );
}

export function valid() {
  const body = JSON.stringify({
    customerRef: 'ok',
    lines: [{ sku: 'SKU-1', quantity: 1, unitPrice: { amount: 100, currency: 'JPY' } }],
  });
  const req = signed('POST', '/orders', body, {
    'x-paas-sandbox-claims': claims('oom-ok'),
    'idempotency-key': `oom-${uuidv4()}`,
  });
  const res = http.post(req.url, body, { headers: req.headers, timeout: '35s' });
  const failed = res.status !== 201;
  validErrors.add(failed);
  if (failed) validErrorStatus.add(1, { status: String(res.status) });
  check(res, { 'valid created (201)': (r) => r.status === 201 });
}

export function oom() {
  const req = signed('GET', '/__fault/oom', '', { 'x-paas-sandbox-claims': claims('oom-fault') });
  const res = http.get(req.url, { headers: req.headers, timeout: '60s' });
  oomStatus.add(1, {
    status: String(res.status),
    errorType: res.headers['Lambda-Web-Error-Type'] || '',
  });
  oomDuration.add(res.timings.duration);
  console.log(
    `oom request -> ${res.status} ${res.headers['Lambda-Web-Error-Type'] || ''} in ${res.timings.duration} ms`,
  );
}
