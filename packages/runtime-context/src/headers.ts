import type { ExecutionContext } from './execution-context.js';

/** Canonical header names (lower-case; API Gateway v2 lower-cases inbound headers). */
export const HEADERS = {
  correlationId: 'x-correlation-id',
  requestId: 'x-request-id',
  idempotencyKey: 'idempotency-key',
  deadline: 'x-request-deadline',
  causationId: 'x-causation-id',
} as const;

/** Message-attribute / envelope keys used on SQS, EventBridge and Step Functions input. */
export const ATTRIBUTES = {
  tenantId: 'tenantId',
  tenantTier: 'tenantTier',
  correlationId: 'correlationId',
  causationId: 'causationId',
  deadline: 'deadlineAtMs',
} as const;

/**
 * Headers to attach to an outbound service-to-service HTTP call so the callee can join the same
 * business flow and inherit the remaining deadline. tenantId is deliberately NOT propagated as a
 * header: the callee must derive the tenant from the caller's verified identity (service token),
 * never from a header the caller could forge.
 */
export function outboundHeaders(
  ctx: ExecutionContext,
  options: { reserveMs?: number } = {},
): Record<string, string> {
  return {
    [HEADERS.correlationId]: ctx.correlationId,
    [HEADERS.causationId]: ctx.requestId,
    [HEADERS.deadline]: ctx.deadline.child({ reserveMs: options.reserveMs ?? 0 }).toHeaderValue(),
  };
}

export function getHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}
