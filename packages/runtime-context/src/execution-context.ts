import type { Deadline } from './deadline.js';
import type { TenantTier } from './identifiers.js';

/**
 * ExecutionContext is the single carrier of tenant, correlation and budget information for one
 * unit of work (guideline §5 テナント文脈, §14 識別子).
 *
 * Invariants:
 *  - `tenantId` comes only from a verified identity (JWT claims / trusted authorizer context /
 *    trusted event envelope). Never from client-controlled request bodies, query strings or paths.
 *  - `correlationId` spans sync + async + replays of one business flow.
 *  - `requestId` is unique per entry invocation; `traceId` is the sampled X-Ray trace.
 */
export interface ExecutionContext {
  readonly tenantId: string;
  readonly tenantTier: TenantTier;
  readonly subjectId?: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly traceId?: string;
  readonly idempotencyKey?: string;
  readonly cellId: string;
  readonly service: string;
  readonly operation: string;
  readonly deploymentVersion: string;
  readonly deadline: Deadline;
}

/** The subset of ExecutionContext that is safe and useful to put on every log line. */
export interface TelemetryKeys {
  tenantId: string;
  tenantTier: TenantTier;
  requestId: string;
  correlationId: string;
  causationId?: string;
  cellId: string;
  service: string;
  operation: string;
  deploymentVersion: string;
}

export function telemetryKeys(ctx: ExecutionContext): TelemetryKeys {
  return {
    tenantId: ctx.tenantId,
    tenantTier: ctx.tenantTier,
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    ...(ctx.causationId ? { causationId: ctx.causationId } : {}),
    cellId: ctx.cellId,
    service: ctx.service,
    operation: ctx.operation,
    deploymentVersion: ctx.deploymentVersion,
  };
}

export interface ServiceIdentity {
  service: string;
  operation: string;
  cellId?: string;
  deploymentVersion?: string;
}

export function resolveServiceIdentity(identity: ServiceIdentity): Required<ServiceIdentity> {
  return {
    service: identity.service,
    operation: identity.operation,
    cellId: identity.cellId ?? process.env['PAAS_CELL_ID'] ?? 'cell-local',
    deploymentVersion:
      identity.deploymentVersion ??
      process.env['PAAS_DEPLOYMENT_VERSION'] ??
      process.env['AWS_LAMBDA_FUNCTION_VERSION'] ??
      'local',
  };
}

export function currentTraceId(): string | undefined {
  const raw = process.env['_X_AMZN_TRACE_ID'];
  if (!raw) return undefined;
  const match = /Root=([^;]+)/.exec(raw);
  return match?.[1];
}
