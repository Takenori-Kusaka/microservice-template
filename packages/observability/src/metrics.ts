import { Metrics, MetricUnit, MetricResolution } from '@aws-lambda-powertools/metrics';
import type { ExecutionContext } from '@paas/runtime-context';

export const METRIC_NAMESPACE = process.env['POWERTOOLS_METRICS_NAMESPACE'] ?? 'PaaS';

/**
 * Standard business/operational metric names (guideline §19 運用, §10 性能).
 * Dimension policy (§14): service, operation, tenantTier, cellId ONLY. tenantId is NEVER a
 * CloudWatch dimension (unbounded cardinality => cost + throttling); per-tenant analysis goes
 * through logs (CloudWatch Logs Insights / Contributor Insights) or the cost/usage pipeline.
 */
export const StandardMetrics = {
  RequestCount: 'RequestCount',
  FaultCount: 'FaultCount',
  ClientErrorCount: 'ClientErrorCount',
  LatencyMs: 'LatencyMs',
  IdempotentReplayCount: 'IdempotentReplayCount',
  EventPublished: 'EventPublished',
  EventPublishFailed: 'EventPublishFailed',
  MessageProcessed: 'MessageProcessed',
  MessageFailed: 'MessageFailed',
  MessageAgeMs: 'MessageAgeMs',
  WorkflowStarted: 'WorkflowStarted',
  WorkflowCompensated: 'WorkflowCompensated',
  DeadlineExceeded: 'DeadlineExceeded',
  TenantIsolationViolationAttempt: 'TenantIsolationViolationAttempt',
} as const;

export function createMetrics(serviceName: string): Metrics {
  return new Metrics({
    namespace: METRIC_NAMESPACE,
    serviceName,
    defaultDimensions: {
      cellId: process.env['PAAS_CELL_ID'] ?? 'cell-local',
    },
  });
}

/** Adds the per-invocation dimensions allowed by the cardinality policy. */
export function bindMetricsDimensions(metrics: Metrics, ctx: ExecutionContext): void {
  metrics.addDimensions({ operation: ctx.operation, tenantTier: ctx.tenantTier });
  // tenantId goes to metadata => appears in the EMF log line, not as a dimension.
  metrics.addMetadata('tenantId', ctx.tenantId);
  metrics.addMetadata('correlationId', ctx.correlationId);
}

export function recordRequest(
  metrics: Metrics,
  outcome: { status: number; durationMs: number },
): void {
  metrics.addMetric(StandardMetrics.RequestCount, MetricUnit.Count, 1);
  metrics.addMetric(
    StandardMetrics.LatencyMs,
    MetricUnit.Milliseconds,
    outcome.durationMs,
    MetricResolution.High,
  );
  if (outcome.status >= 500) {
    metrics.addMetric(StandardMetrics.FaultCount, MetricUnit.Count, 1);
  } else if (outcome.status >= 400) {
    metrics.addMetric(StandardMetrics.ClientErrorCount, MetricUnit.Count, 1);
  }
}

export { MetricUnit, MetricResolution };

/**
 * Emits `TenantIsolationViolationAttempt` (guideline ch.21 §21.4 detection signal). Call it
 * whenever a request or message is rejected because its tenant binding is missing, invalid,
 * forged (e.g. a cursor from another tenant) or mismatched. The metric feeds the detection
 * alarm; the structured log line carries the details for forensics (no PII in the metric).
 */
export function recordIsolationViolation(
  metrics: Metrics,
  reason: 'missing-tenant' | 'invalid-tenant' | 'foreign-cursor' | 'envelope-tenant' | 'other',
): void {
  // singleMetric(): emitted immediately with only the default dimensions (service, cellId), so
  // the detection alarm in ServiceObservability can target a deterministic dimension set.
  const single = metrics.singleMetric();
  single.addMetadata('isolationViolationReason', reason);
  single.addMetric(StandardMetrics.TenantIsolationViolationAttempt, MetricUnit.Count, 1);
}

/** Classifies an error as an isolation-violation signal, or undefined when it is not one. */
export function isolationViolationReason(
  error: unknown,
): 'missing-tenant' | 'invalid-tenant' | 'foreign-cursor' | 'envelope-tenant' | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { code?: unknown; name?: unknown; details?: unknown; message?: unknown };
  if (e.code === 'TENANT_CONTEXT_MISSING') return 'missing-tenant';
  if (e.name === 'EventValidationError' && String(e.message).includes('tenantId'))
    return 'envelope-tenant';
  if (
    Array.isArray(e.details) &&
    e.details.some((d) =>
      (d as { message?: string }).message?.includes('does not belong to this tenant'),
    )
  ) {
    return 'foreign-cursor';
  }
  return undefined;
}
