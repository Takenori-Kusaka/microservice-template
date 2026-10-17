#!/usr/bin/env node
/**
 * Collects the CloudWatch evidence for a load-test window (docs/decision/template-defaults.md
 * M-items): API Gateway count / 4xx / 5xx / latency p50-p99, Lambda duration p50-p99,
 * throttles, max concurrent executions, DynamoDB throttled requests.
 *
 *   node tests/performance/collect-metrics.mjs --start 2026-10-18T00:00:00Z --end 2026-10-18T00:06:00Z \
 *     --api-id 126rmvhpxl --function-prefix paas-sandbox --out tests/performance/results/metrics.json
 *
 * Uses the AWS CLI (same credentials as `aws login`). No npm dependencies.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const start = arg('start');
const end = arg('end');
const apiId = arg('api-id');
const prefix = arg('function-prefix', 'paas-sandbox');
const out = arg('out', 'tests/performance/results/metrics.json');
const region = process.env.AWS_REGION ?? 'ap-northeast-1';
if (!start || !end || !apiId) {
  console.error(
    'usage: --start <iso> --end <iso> --api-id <id> [--function-prefix p] [--out file]',
  );
  process.exit(2);
}

function aws(args) {
  return JSON.parse(
    execFileSync('aws', [...args, '--region', region, '--output', 'json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    }),
  );
}

const functions = aws(['lambda', 'list-functions'])
  .Functions.map((f) => f.FunctionName)
  .filter((n) => n.startsWith(prefix));

const periodSeconds = 60;
const queries = [];
const q = (id, ns, metric, dims, stat) =>
  queries.push({
    Id: id,
    MetricStat: {
      Metric: { Namespace: ns, MetricName: metric, Dimensions: dims },
      Period: periodSeconds,
      Stat: stat,
    },
    ReturnData: true,
  });

const apiDims = [{ Name: 'ApiId', Value: apiId }];
q('api_count', 'AWS/ApiGateway', 'Count', apiDims, 'Sum');
q('api_4xx', 'AWS/ApiGateway', '4xx', apiDims, 'Sum');
q('api_5xx', 'AWS/ApiGateway', '5xx', apiDims, 'Sum');
for (const p of ['p50', 'p95', 'p99'])
  q(`api_latency_${p}`, 'AWS/ApiGateway', 'Latency', apiDims, p);
for (const p of ['p50', 'p95', 'p99'])
  q(`api_integration_latency_${p}`, 'AWS/ApiGateway', 'IntegrationLatency', apiDims, p);
q('lambda_account_concurrency', 'AWS/Lambda', 'ConcurrentExecutions', [], 'Maximum');
q('lambda_account_throttles', 'AWS/Lambda', 'Throttles', [], 'Sum');
functions.forEach((fn, i) => {
  const dims = [{ Name: 'FunctionName', Value: fn }];
  for (const p of ['p50', 'p95', 'p99'])
    q(`fn${i}_duration_${p}`, 'AWS/Lambda', 'Duration', dims, p);
  q(`fn${i}_invocations`, 'AWS/Lambda', 'Invocations', dims, 'Sum');
  q(`fn${i}_errors`, 'AWS/Lambda', 'Errors', dims, 'Sum');
  q(`fn${i}_throttles`, 'AWS/Lambda', 'Throttles', dims, 'Sum');
  q(`fn${i}_concurrency`, 'AWS/Lambda', 'ConcurrentExecutions', dims, 'Maximum');
});

const results = {};
for (let i = 0; i < queries.length; i += 100) {
  const batch = queries.slice(i, i + 100);
  // The query list exceeds the Windows command-line limit, so pass it as a param file.
  const file = join(mkdtempSync(join(tmpdir(), 'cw-')), 'queries.json');
  writeFileSync(file, JSON.stringify(batch));
  const res = aws([
    'cloudwatch',
    'get-metric-data',
    '--start-time',
    start,
    '--end-time',
    end,
    '--metric-data-queries',
    `file://${file.split('\\').join('/')}`,
  ]);
  for (const r of res.MetricDataResults) results[r.Id] = r.Values;
}

const agg = (vals, how) => {
  if (!vals || vals.length === 0) return null;
  if (how === 'sum') return vals.reduce((a, b) => a + b, 0);
  if (how === 'max') return Math.max(...vals);
  return null;
};
const summary = {
  window: { start, end, periodSeconds },
  api: {
    requests: agg(results.api_count, 'sum'),
    status4xx: agg(results.api_4xx, 'sum'),
    status5xx: agg(results.api_5xx, 'sum'),
    latencyMs: {
      p50_maxOfMinutes: agg(results.api_latency_p50, 'max'),
      p95_maxOfMinutes: agg(results.api_latency_p95, 'max'),
      p99_maxOfMinutes: agg(results.api_latency_p99, 'max'),
    },
    integrationLatencyMs: {
      p50_maxOfMinutes: agg(results.api_integration_latency_p50, 'max'),
      p95_maxOfMinutes: agg(results.api_integration_latency_p95, 'max'),
      p99_maxOfMinutes: agg(results.api_integration_latency_p99, 'max'),
    },
  },
  lambdaAccount: {
    maxConcurrentExecutions: agg(results.lambda_account_concurrency, 'max'),
    throttles: agg(results.lambda_account_throttles, 'sum'),
  },
  functions: functions
    .map((fn, i) => ({
      functionName: fn,
      invocations: agg(results[`fn${i}_invocations`], 'sum'),
      errors: agg(results[`fn${i}_errors`], 'sum'),
      throttles: agg(results[`fn${i}_throttles`], 'sum'),
      maxConcurrency: agg(results[`fn${i}_concurrency`], 'max'),
      durationMs: {
        p50_maxOfMinutes: agg(results[`fn${i}_duration_p50`], 'max'),
        p95_maxOfMinutes: agg(results[`fn${i}_duration_p95`], 'max'),
        p99_maxOfMinutes: agg(results[`fn${i}_duration_p99`], 'max'),
      },
    }))
    .filter((f) => f.invocations),
  note: 'Percentiles are per-1-minute CloudWatch statistics; *_maxOfMinutes is the worst minute in the window. k6 client-side percentiles are in the summary export.',
};
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
