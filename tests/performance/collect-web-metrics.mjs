#!/usr/bin/env node
/**
 * Collects the CloudWatch evidence of a Lambda Web Functions benchmark window (ADR-0006 / M-06).
 * Metric names, namespaces, dimensions and statistics follow
 * https://docs.aws.amazon.com/lambda/latest/dg/web-functions-monitoring-metrics.html (2026-10-21):
 *   AWS/Lambda/Web        (home Region, centralized)  FunctionName [+ EndpointName]
 *     ExecutedRequests / HTTPResponseStatusClass4XX / HTTPResponseStatusClass5XX   (Sum, sparse)
 *     EnvironmentActiveTime / EnvironmentCPUTime (ms, Sum), EnvironmentMaxMemoryUsage (MB, Max),
 *     EnvironmentConcurrentRequests (Max), ResponseBytes (Sum)
 *   AWS/Lambda/Web/Usage  (per Region, not centralized) FunctionName + EndpointName + ExecutionRegion
 *     EndpointActiveEnvironments (Max), AccountRequestThrottles / EndpointRequestThrottles /
 *     AccountActiveVCPUArm64Throttles / EndpointActiveEnvironmentThrottles (Sum, sparse)
 *
 *   node tests/performance/collect-web-metrics.mjs --start <iso> --end <iso> \
 *     --function-name <WebFunctionName output> --endpoint-name <WebEndpointName output> \
 *     --out tests/performance/results/<date>.web.cloudwatch.json
 *
 * Telemetry reaches the home Region asynchronously ("typically within a few minutes"), so run
 * this a few minutes after the k6 run ends. Uses the AWS CLI; no npm dependencies.
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
const functionName = arg('function-name');
const endpointName = arg('endpoint-name');
const out = arg('out', 'tests/performance/results/web-metrics.json');
const region = process.env.AWS_REGION ?? 'ap-northeast-1';
if (!start || !end || !functionName || !endpointName) {
  console.error(
    'usage: --start <iso> --end <iso> --function-name <name> --endpoint-name <name> [--out file]',
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

const WEB = 'AWS/Lambda/Web';
const USAGE = 'AWS/Lambda/Web/Usage';
const fnDims = [{ Name: 'FunctionName', Value: functionName }];
const reqDims = [...fnDims, { Name: 'EndpointName', Value: endpointName }];
const usageDims = [...reqDims, { Name: 'ExecutionRegion', Value: region }];

q('executed', WEB, 'ExecutedRequests', reqDims, 'Sum');
q('status4xx', WEB, 'HTTPResponseStatusClass4XX', reqDims, 'Sum');
q('status5xx', WEB, 'HTTPResponseStatusClass5XX', reqDims, 'Sum');
q('active_ms', WEB, 'EnvironmentActiveTime', fnDims, 'Sum');
q('cpu_ms', WEB, 'EnvironmentCPUTime', fnDims, 'Sum');
q('max_memory_mb', WEB, 'EnvironmentMaxMemoryUsage', fnDims, 'Maximum');
q('concurrent_requests', WEB, 'EnvironmentConcurrentRequests', fnDims, 'Maximum');
q('response_bytes', WEB, 'ResponseBytes', fnDims, 'Sum');
q('active_environments', USAGE, 'EndpointActiveEnvironments', usageDims, 'Maximum');
q('throttle_account_rps', USAGE, 'AccountRequestThrottles', usageDims, 'Sum');
q('throttle_endpoint_rps', USAGE, 'EndpointRequestThrottles', usageDims, 'Sum');
q('throttle_account_vcpu', USAGE, 'AccountActiveVCPUArm64Throttles', usageDims, 'Sum');
q('throttle_endpoint_envs', USAGE, 'EndpointActiveEnvironmentThrottles', usageDims, 'Sum');

const file = join(mkdtempSync(join(tmpdir(), 'cw-web-')), 'queries.json');
writeFileSync(file, JSON.stringify(queries));
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
const results = {};
for (const r of res.MetricDataResults) results[r.Id] = r.Values;

const sum = (v) => (v && v.length ? v.reduce((a, b) => a + b, 0) : null);
const max = (v) => (v && v.length ? Math.max(...v) : null);
const activeMs = sum(results.active_ms);
const cpuMs = sum(results.cpu_ms);
const summary = {
  window: { start, end, periodSeconds, region, functionName, endpointName },
  requests: {
    executed: sum(results.executed),
    status4xx: sum(results.status4xx) ?? 0,
    status5xx: sum(results.status5xx) ?? 0,
  },
  environments: {
    activeTimeMs: activeMs,
    cpuTimeMs: cpuMs,
    // ADR-0006 "CPU active ratio": vCPU time consumed / wall-clock environment time.
    cpuActiveRatio: activeMs && cpuMs !== null ? cpuMs / activeMs : null,
    maxMemoryMb: max(results.max_memory_mb),
    maxConcurrentRequestsPerEnvironment: max(results.concurrent_requests),
    maxActiveEnvironments: max(results.active_environments),
    responseBytes: sum(results.response_bytes),
  },
  throttles: {
    accountRequestRate: sum(results.throttle_account_rps) ?? 0,
    endpointRateLimit: sum(results.throttle_endpoint_rps) ?? 0,
    accountActiveVcpuArm64: sum(results.throttle_account_vcpu) ?? 0,
    endpointMaxEnvironments: sum(results.throttle_endpoint_envs) ?? 0,
    note: 'EndpointConcurrentInitThrottle (429) increments no throttle metric; count it from the k6 "throttled" rate instead.',
  },
  note: 'Sparse metrics have no data point for quiet minutes (treated as 0 here). Request metrics are home-Region centralized values; usage metrics are per ExecutionRegion.',
};
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
