import middy from '@middy/core';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import type { APIGatewayProxyResultV2, Context as LambdaContext } from 'aws-lambda';
import { contextlessErrorResponse, errorResponse, type JsonResponse } from '@paas/api-contracts';
import { createTelemetry, recordRequest, requestSummary } from '@paas/observability';
import {
  contextFromHttpApiEvent,
  runWithContext,
  type ExecutionContext,
  type HttpApiEvent,
} from '@paas/runtime-context';

export const SERVICE_ID = process.env['PAAS_SERVICE_ID'] ?? 'order-service';

export const telemetry = createTelemetry({
  serviceName: SERVICE_ID,
  sensitiveKeys: ['customerRef'],
});

export type ApiImplementation = (
  ctx: ExecutionContext,
  event: HttpApiEvent,
) => Promise<JsonResponse>;

/**
 * Entry-point wrapper (guideline §16: handlers contain no business logic). Responsibilities:
 *  1. derive the ExecutionContext from the verified authorizer result;
 *  2. bind telemetry; 3. run the use case inside AsyncLocalStorage; 4. map errors to the public
 *  contract; 5. emit one request-summary log line + metrics per invocation.
 */
export function apiHandler(operation: string, impl: ApiImplementation) {
  const base = async (
    event: HttpApiEvent,
    lambdaContext: LambdaContext,
  ): Promise<APIGatewayProxyResultV2> => {
    const started = Date.now();
    let ctx: ExecutionContext;
    try {
      ctx = contextFromHttpApiEvent(event, lambdaContext, { service: SERVICE_ID, operation });
    } catch (error) {
      telemetry.logger.warn('request rejected before context binding', { error, operation });
      return contextlessErrorResponse(error, event.requestContext.requestId);
    }
    return runWithContext(ctx, async () => {
      telemetry.bind(ctx);
      let response: JsonResponse;
      try {
        response = await impl(ctx, event);
      } catch (error) {
        const mapped = errorResponse(error, ctx);
        if (mapped.apiError.httpStatus >= 500) {
          telemetry.logger.error('request failed', { error });
        } else {
          telemetry.logger.info('request rejected', { code: mapped.apiError.code });
        }
        response = mapped;
      }
      const durationMs = Date.now() - started;
      telemetry.logger.info(
        'request completed',
        requestSummary(ctx, { status: response.statusCode, durationMs }),
      );
      recordRequest(telemetry.metrics, { status: response.statusCode, durationMs });
      return response;
    });
  };
  return middy(base)
    .use(captureLambdaHandler(telemetry.tracer))
    .use(injectLambdaContext(telemetry.logger, { resetKeys: true }))
    .use(logMetrics(telemetry.metrics, { captureColdStartMetric: true }));
}

export function parseJsonBody(event: HttpApiEvent): unknown {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return Symbol.for('invalid-json');
  }
}
