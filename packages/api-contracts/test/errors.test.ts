import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, ErrorCode, toApiError } from '../src/errors.js';
import { errorResponse } from '../src/responses.js';

const ctx = { requestId: 'req-1', correlationId: 'corr-1' };

describe('error contract', () => {
  it('maps zod errors to 400 with details', () => {
    const err = z.object({ a: z.string() }).safeParse({}).error!;
    const res = errorResponse(err, ctx);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string; details: unknown[] } };
    expect(body.error.code).toBe(ErrorCode.ValidationFailed);
    expect(body.error.details.length).toBe(1);
  });

  it('never leaks internal messages for unknown errors', () => {
    const res = errorResponse(new Error('ECONNREFUSED 10.0.0.1:5432 password=hunter2'), ctx);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(JSON.parse(res.body).error.retryable).toBe(true);
  });

  it('maps duck-typed platform errors by code', () => {
    expect(toApiError({ code: 'TENANT_CONTEXT_MISSING' }).httpStatus).toBe(403);
    expect(toApiError({ code: 'DEADLINE_EXCEEDED' }).httpStatus).toBe(504);
  });

  it('adds retry-after for rate limiting', () => {
    const res = errorResponse(ApiError.rateLimited(3), ctx);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3');
  });
});
