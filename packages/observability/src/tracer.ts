import { Tracer } from '@aws-lambda-powertools/tracer';
import type { ExecutionContext } from '@paas/runtime-context';

export function createTracer(serviceName: string): Tracer {
  // captureHTTPsRequests is on by default; keep responses out of traces (PII).
  return new Tracer({ serviceName, captureHTTPsRequests: true });
}

/**
 * Annotations (indexed, searchable) vs metadata (not indexed) for the current segment.
 * tenantId is an annotation on purpose: filtering traces by tenant is a first-class support
 * workflow. Everything else that is high-cardinality goes to metadata.
 */
export function annotateSegment(tracer: Tracer, ctx: ExecutionContext): void {
  if (!tracer.isTracingEnabled()) return;
  tracer.putAnnotation('tenantId', ctx.tenantId);
  tracer.putAnnotation('tenantTier', ctx.tenantTier);
  tracer.putAnnotation('correlationId', ctx.correlationId);
  tracer.putAnnotation('cellId', ctx.cellId);
  tracer.putAnnotation('operation', ctx.operation);
  tracer.putMetadata('execution', {
    requestId: ctx.requestId,
    causationId: ctx.causationId,
    deploymentVersion: ctx.deploymentVersion,
    deadlineAtMs: ctx.deadline.deadlineAtMs,
  });
}
