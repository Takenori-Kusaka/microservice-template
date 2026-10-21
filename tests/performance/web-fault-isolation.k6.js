/**
 * ADR-0006 Evidence row "failure isolation" (exception part): while valid traffic flows to the
 * Web Function endpoint, FAULT_RATIO of the requests carry a malformed JSON body (throws inside
 * the request handler). Pass condition: error rate of the VALID requests stays < 1% (the faulty
 * request must not take down the shared execution environment / other in-flight requests).
 * OOM injection needs a fault route in the application and is not covered here.
 *
 *   eval "$(aws configure export-credentials --format env)"
 *   PAAS_WEB_URL=https://<domain> AWS_REGION=ap-northeast-1 k6 run tests/performance/web-fault-isolation.k6.js
 */
import http from 'k6/http';
import encoding from 'k6/encoding';
import { check } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { SignatureV4, Endpoint } from 'https://jslib.k6.io/aws/0.14.0/signature.js';

const BASE = __ENV.PAAS_WEB_URL;
const REGION = __ENV.AWS_REGION || 'ap-northeast-1';
const RPS = Number(__ENV.RPS || 30);
const DURATION = __ENV.DURATION || '2m';
const FAULT_RATIO = Number(__ENV.FAULT_RATIO || 0.1);
if (!BASE) throw new Error('set PAAS_WEB_URL');

const validErrors = new Rate('valid_request_errors');
const faultStatus = new Counter('fault_request_status');
const sameEnvironment = new Counter('responses_by_logstream');

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
    mixed: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(10, RPS),
      maxVUs: RPS * 4,
    },
  },
  thresholds: { valid_request_errors: ['rate<0.01'] },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

function claims(tenantId) {
  return encoding.b64encode(
    JSON.stringify({ tenantId, tenantTier: 'standard', sub: 'fault' }),
    'rawurl',
  );
}

export default function () {
  const faulty = Math.random() < FAULT_RATIO;
  const body = faulty
    ? '{"customerRef": "fault", "lines": [ { "sku": "SKU-1", "quantity": 1, ' // truncated JSON
    : JSON.stringify({
        customerRef: 'ok',
        lines: [{ sku: 'SKU-1', quantity: 1, unitPrice: { amount: 100, currency: 'JPY' } }],
      });
  const headers = {
    'content-type': 'application/json',
    'x-paas-sandbox-claims': claims(faulty ? 'fault-a' : 'ok-a'),
    'idempotency-key': `fault-${uuidv4()}`,
  };
  const signed = signer.sign(
    { method: 'POST', endpoint: new Endpoint(BASE), path: '/orders', query: {}, headers, body },
    { signingService: 'lambda', signingRegion: REGION },
  );
  const res = http.post(signed.url, body, { headers: signed.headers });
  const stream = res.headers['Lambda-Web-Logstream'] || 'none';
  sameEnvironment.add(1, { logstream: stream.slice(-12) });
  if (faulty) {
    faultStatus.add(1, { status: String(res.status) });
    check(res, { 'fault rejected with 4xx': (r) => r.status >= 400 && r.status < 500 });
  } else {
    validErrors.add(res.status !== 201);
    check(res, { 'valid created (201)': (r) => r.status === 201 });
  }
}
