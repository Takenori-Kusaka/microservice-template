import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  Context as LambdaContext,
} from 'aws-lambda';
import { Deadline } from '../deadline.js';
import { InvalidIdentifierError, TenantContextError } from '../errors.js';
import {
  currentTraceId,
  resolveServiceIdentity,
  type ExecutionContext,
  type ServiceIdentity,
} from '../execution-context.js';
import { HEADERS, getHeader } from '../headers.js';
import {
  acceptOrGenerateToken,
  isSafeToken,
  isValidIdempotencyKey,
  isValidTenantId,
  parseTenantTier,
} from '../identifiers.js';

/** Claims produced by the tenant identity provider (Cognito custom attributes or a custom IdP). */
export interface TenantClaims {
  tenantId: string;
  tenantTier?: string;
  sub?: string;
}

export type HttpApiEvent =
  | APIGatewayProxyEventV2WithJWTAuthorizer
  | APIGatewayProxyEventV2WithLambdaAuthorizer<TenantClaims>;

export interface ApiContextOptions extends ServiceIdentity {
  /** Claim name carrying the tenant id. Defaults to `custom:tenantId`, then `tenantId`. */
  tenantClaim?: string;
  tierClaim?: string;
  /** Safety margin kept back from the Lambda timeout. */
  safetyMarginMs?: number;
}

function extractClaims(event: HttpApiEvent, options: ApiContextOptions): TenantClaims {
  const authorizer = (event.requestContext as { authorizer?: unknown }).authorizer;
  if (!authorizer || typeof authorizer !== 'object') {
    throw new TenantContextError('authorizer context is missing');
  }
  const jwt = (authorizer as { jwt?: { claims?: Record<string, unknown> } }).jwt;
  const lambda = (authorizer as { lambda?: Record<string, unknown> }).lambda;
  const source: Record<string, unknown> | undefined = jwt?.claims ?? lambda;
  if (!source) {
    throw new TenantContextError('authorizer context has neither jwt claims nor lambda context');
  }
  const tenantClaim = options.tenantClaim ?? 'custom:tenantId';
  const tenantId = source[tenantClaim] ?? source['tenantId'];
  const tierClaim = options.tierClaim ?? 'custom:tenantTier';
  const tenantTier = source[tierClaim] ?? source['tenantTier'];
  const sub = source['sub'];
  if (!isValidTenantId(tenantId)) {
    throw new TenantContextError('verified identity does not carry a valid tenantId claim');
  }
  return {
    tenantId,
    ...(typeof tenantTier === 'string' ? { tenantTier } : {}),
    ...(typeof sub === 'string' ? { sub } : {}),
  };
}

/**
 * Builds the ExecutionContext for an API Gateway HTTP API (v2) invocation.
 *
 * Trust model: tenant identity is read ONLY from the authorizer result. Correlation / deadline /
 * idempotency headers are accepted from the caller after validation.
 */
export function contextFromHttpApiEvent(
  event: HttpApiEvent,
  lambdaContext: Pick<LambdaContext, 'getRemainingTimeInMillis'>,
  options: ApiContextOptions,
): ExecutionContext {
  const claims = extractClaims(event, options);
  const identity = resolveServiceIdentity(options);
  const headers = event.headers as Record<string, string | undefined>;

  const requestId = event.requestContext.requestId;
  const correlation = acceptOrGenerateToken(getHeader(headers, HEADERS.correlationId));
  const correlationId = correlation.generated ? requestId : correlation.value;

  const rawIdempotencyKey = getHeader(headers, HEADERS.idempotencyKey);
  if (rawIdempotencyKey !== undefined && !isValidIdempotencyKey(rawIdempotencyKey)) {
    throw new InvalidIdentifierError(HEADERS.idempotencyKey);
  }

  const inboundDeadline = Deadline.fromHeaderValue(getHeader(headers, HEADERS.deadline));
  const deadline = Deadline.earliest(
    inboundDeadline,
    Deadline.fromLambdaContext(lambdaContext, options.safetyMarginMs ?? 500),
  );

  const causationId = getHeader(headers, HEADERS.causationId);
  const traceId = currentTraceId();

  return {
    tenantId: claims.tenantId,
    tenantTier: parseTenantTier(claims.tenantTier),
    ...(claims.sub ? { subjectId: claims.sub } : {}),
    requestId,
    correlationId,
    ...(isSafeToken(causationId) ? { causationId } : {}),
    ...(traceId ? { traceId } : {}),
    ...(rawIdempotencyKey ? { idempotencyKey: rawIdempotencyKey } : {}),
    cellId: identity.cellId,
    service: identity.service,
    operation: identity.operation,
    deploymentVersion: identity.deploymentVersion,
    deadline,
  };
}
