import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ExecutionContext } from '@paas/runtime-context';
import { errorBody, toApiError, type ApiError } from './errors.js';

export interface JsonResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function jsonResponse(
  status: number,
  body: unknown,
  ctx: Pick<ExecutionContext, 'requestId' | 'correlationId'>,
  extraHeaders: Record<string, string> = {},
): JsonResponse {
  return {
    statusCode: status,
    headers: {
      ...BASE_HEADERS,
      'x-request-id': ctx.requestId,
      'x-correlation-id': ctx.correlationId,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export function errorResponse(
  error: unknown,
  ctx: Pick<ExecutionContext, 'requestId' | 'correlationId'>,
): JsonResponse & { apiError: ApiError } {
  const apiError = toApiError(error);
  const headers: Record<string, string> =
    apiError.retryAfterSeconds !== undefined
      ? { 'retry-after': String(apiError.retryAfterSeconds) }
      : {};
  return { ...jsonResponse(apiError.httpStatus, errorBody(apiError, ctx), ctx, headers), apiError };
}

/** Error response for failures that happen before a context exists (e.g. authorizer gaps). */
export function contextlessErrorResponse(
  error: unknown,
  requestId: string,
): APIGatewayProxyResultV2 {
  const apiError = toApiError(error);
  return {
    statusCode: apiError.httpStatus,
    headers: { ...BASE_HEADERS, 'x-request-id': requestId },
    body: JSON.stringify(errorBody(apiError, { requestId, correlationId: requestId })),
  };
}
