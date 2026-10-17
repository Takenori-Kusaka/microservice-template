import type { Context as LambdaContext } from 'aws-lambda';
import { Deadline } from '../deadline.js';
import { TenantContextError } from '../errors.js';
import {
  currentTraceId,
  resolveServiceIdentity,
  type ExecutionContext,
  type ServiceIdentity,
} from '../execution-context.js';
import { acceptOrGenerateToken, isValidTenantId, parseTenantTier } from '../identifiers.js';

/** Minimal shape shared by the event envelope, SQS message bodies and Step Functions input. */
export interface EnvelopeLike {
  id: string;
  tenantId: string;
  tenantTier?: string;
  correlationId: string;
  causationId?: string;
  deadlineAtMs?: number;
}

/**
 * Builds the ExecutionContext for an asynchronous unit of work (SQS record, EventBridge event,
 * Step Functions task). The envelope is trusted because it was produced inside the platform
 * boundary (publishers are authenticated via IAM); its identifiers are still validated so that
 * a corrupted or replayed message cannot poison logs or cross tenant boundaries.
 */
export function contextFromEnvelope(
  envelope: EnvelopeLike,
  lambdaContext: Pick<LambdaContext, 'getRemainingTimeInMillis' | 'awsRequestId'>,
  options: ServiceIdentity & { safetyMarginMs?: number },
): ExecutionContext {
  if (!isValidTenantId(envelope.tenantId)) {
    throw new TenantContextError(`envelope ${envelope.id} does not carry a valid tenantId`);
  }
  const identity = resolveServiceIdentity(options);
  const correlation = acceptOrGenerateToken(envelope.correlationId);
  const lambdaDeadline = Deadline.fromLambdaContext(lambdaContext, options.safetyMarginMs ?? 500);
  const deadline =
    envelope.deadlineAtMs !== undefined
      ? Deadline.earliest(Deadline.at(envelope.deadlineAtMs), lambdaDeadline)
      : lambdaDeadline;
  const traceId = currentTraceId();
  return {
    tenantId: envelope.tenantId,
    tenantTier: parseTenantTier(envelope.tenantTier),
    requestId: lambdaContext.awsRequestId,
    correlationId: correlation.value,
    causationId: envelope.id,
    ...(traceId ? { traceId } : {}),
    cellId: identity.cellId,
    service: identity.service,
    operation: identity.operation,
    deploymentVersion: identity.deploymentVersion,
    deadline,
  };
}
