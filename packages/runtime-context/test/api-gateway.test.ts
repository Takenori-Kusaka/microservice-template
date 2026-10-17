import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { contextFromHttpApiEvent } from '../src/sources/api-gateway.js';
import { InvalidIdentifierError, TenantContextError } from '../src/errors.js';

function jwtEvent(
  claims: Record<string, unknown>,
  headers: Record<string, string> = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: '2.0',
    routeKey: 'POST /orders',
    rawPath: '/orders',
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: '123456789012',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: 'POST',
        path: '/orders',
        protocol: 'HTTP/1.1',
        sourceIp: '1.1.1.1',
        userAgent: 'test',
      },
      requestId: 'req-00000001',
      routeKey: 'POST /orders',
      stage: '$default',
      time: '',
      timeEpoch: Date.now(),
      authorizer: {
        principalId: 'p',
        integrationLatency: 1,
        jwt: { claims: claims as never, scopes: [] },
      },
    },
    isBase64Encoded: false,
  };
}

const lambdaCtx = { getRemainingTimeInMillis: () => 10_000 };
const identity = { service: 'order-service', operation: 'CreateOrder' };

describe('contextFromHttpApiEvent', () => {
  it('derives tenant from verified claims and ignores body/query', () => {
    const ctx = contextFromHttpApiEvent(
      jwtEvent({ 'custom:tenantId': 'acme', 'custom:tenantTier': 'premium', sub: 'u1' }),
      lambdaCtx,
      identity,
    );
    expect(ctx.tenantId).toBe('acme');
    expect(ctx.tenantTier).toBe('premium');
    expect(ctx.subjectId).toBe('u1');
    expect(ctx.correlationId).toBe('req-00000001');
  });

  it('rejects requests without a tenant claim', () => {
    expect(() => contextFromHttpApiEvent(jwtEvent({ sub: 'u1' }), lambdaCtx, identity)).toThrow(
      TenantContextError,
    );
  });

  it('rejects malformed tenant ids (no injection via claims)', () => {
    expect(() =>
      contextFromHttpApiEvent(jwtEvent({ 'custom:tenantId': 'ACME; drop' }), lambdaCtx, identity),
    ).toThrow(TenantContextError);
  });

  it('accepts a safe inbound correlation id and replaces an unsafe one', () => {
    const ok = contextFromHttpApiEvent(
      jwtEvent({ tenantId: 'acme' }, { 'x-correlation-id': 'flow-abc-123' }),
      lambdaCtx,
      identity,
    );
    expect(ok.correlationId).toBe('flow-abc-123');
    const bad = contextFromHttpApiEvent(
      jwtEvent({ tenantId: 'acme' }, { 'x-correlation-id': 'bad value\n' }),
      lambdaCtx,
      identity,
    );
    expect(bad.correlationId).toBe('req-00000001');
  });

  it('validates idempotency keys', () => {
    expect(() =>
      contextFromHttpApiEvent(
        jwtEvent({ tenantId: 'acme' }, { 'idempotency-key': 'x' }),
        lambdaCtx,
        identity,
      ),
    ).toThrow(InvalidIdentifierError);
    const ctx = contextFromHttpApiEvent(
      jwtEvent({ tenantId: 'acme' }, { 'idempotency-key': 'order-create-0001' }),
      lambdaCtx,
      identity,
    );
    expect(ctx.idempotencyKey).toBe('order-create-0001');
  });

  it('honours an inbound deadline when it is earlier than the lambda timeout', () => {
    const soon = String(Date.now() + 1000);
    const ctx = contextFromHttpApiEvent(
      jwtEvent({ tenantId: 'acme' }, { 'x-request-deadline': soon }),
      lambdaCtx,
      identity,
    );
    expect(ctx.deadline.remainingMs()).toBeLessThanOrEqual(1000);
  });
});
