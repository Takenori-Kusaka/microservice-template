import type { ExecutionContext } from '@paas/runtime-context';
import { z } from 'zod';

/** Stable error codes returned in `error.code` (guideline §6 API契約). */
export const ErrorCode = {
  ValidationFailed: 'VALIDATION_FAILED',
  Unauthorized: 'UNAUTHORIZED',
  Forbidden: 'FORBIDDEN',
  TenantContextMissing: 'TENANT_CONTEXT_MISSING',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  IdempotencyPayloadMismatch: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  IdempotencyInProgress: 'IDEMPOTENCY_IN_PROGRESS',
  RateLimited: 'RATE_LIMITED',
  DeadlineExceeded: 'DEADLINE_EXCEEDED',
  DependencyUnavailable: 'DEPENDENCY_UNAVAILABLE',
  Internal: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly retryable: boolean,
    readonly details?: ErrorDetail[],
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static validation(details: ErrorDetail[]): ApiError {
    return new ApiError(
      ErrorCode.ValidationFailed,
      400,
      'request validation failed',
      false,
      details,
    );
  }
  static notFound(resource: string): ApiError {
    return new ApiError(ErrorCode.NotFound, 404, `${resource} not found`, false);
  }
  static conflict(message: string, code: ErrorCode = ErrorCode.Conflict): ApiError {
    return new ApiError(code, 409, message, false);
  }
  static forbidden(message = 'forbidden'): ApiError {
    return new ApiError(ErrorCode.Forbidden, 403, message, false);
  }
  static rateLimited(retryAfterSeconds: number): ApiError {
    return new ApiError(
      ErrorCode.RateLimited,
      429,
      'rate limit exceeded',
      true,
      undefined,
      retryAfterSeconds,
    );
  }
  static dependencyUnavailable(dependency: string): ApiError {
    return new ApiError(
      ErrorCode.DependencyUnavailable,
      503,
      `${dependency} unavailable`,
      true,
      undefined,
      1,
    );
  }
}

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    correlationId?: string;
    retryable: boolean;
    details?: ErrorDetail[];
  };
}

/**
 * Maps any thrown value to the public error contract. Unknown errors become opaque 500s
 * (message never leaks internals); known platform errors (runtime-context, zod) are mapped by
 * duck-typing so this package does not need to depend on every producer.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof z.ZodError) {
    return ApiError.validation(
      error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const e = error as {
      code: unknown;
      message?: unknown;
      httpStatus?: unknown;
      retryable?: unknown;
    };
    switch (e.code) {
      case 'TENANT_CONTEXT_MISSING':
        return new ApiError(
          ErrorCode.TenantContextMissing,
          403,
          'request is not bound to a verified tenant',
          false,
        );
      case 'INVALID_IDENTIFIER':
        return ApiError.validation([
          {
            path: 'header',
            message: typeof e.message === 'string' ? e.message : 'invalid identifier',
          },
        ]);
      case 'DEADLINE_EXCEEDED':
        return new ApiError(ErrorCode.DeadlineExceeded, 504, 'request deadline exceeded', true);
      case 'IDEMPOTENCY_PAYLOAD_MISMATCH':
        return new ApiError(
          ErrorCode.IdempotencyPayloadMismatch,
          409,
          'idempotency key reused with a different payload',
          false,
        );
      case 'IDEMPOTENCY_IN_PROGRESS':
        return new ApiError(
          ErrorCode.IdempotencyInProgress,
          409,
          'a request with this idempotency key is in progress',
          true,
          undefined,
          1,
        );
      default:
        break;
    }
    // Powertools idempotency error classes expose a name instead of a code.
  }
  if (error instanceof Error) {
    if (error.name === 'IdempotencyValidationError') {
      return new ApiError(
        ErrorCode.IdempotencyPayloadMismatch,
        409,
        'idempotency key reused with a different payload',
        false,
      );
    }
    if (error.name === 'IdempotencyAlreadyInProgressError') {
      return new ApiError(
        ErrorCode.IdempotencyInProgress,
        409,
        'a request with this idempotency key is in progress',
        true,
        undefined,
        1,
      );
    }
    if (
      error.name === 'ProvisionedThroughputExceededException' ||
      error.name === 'ThrottlingException'
    ) {
      return ApiError.dependencyUnavailable('datastore');
    }
  }
  return new ApiError(ErrorCode.Internal, 500, 'internal error', true);
}

export function errorBody(
  error: ApiError,
  ctx: Pick<ExecutionContext, 'requestId' | 'correlationId'>,
): ErrorResponseBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}
