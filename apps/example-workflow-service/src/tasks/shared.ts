import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import middy from '@middy/core';
import type { Context as LambdaContext } from 'aws-lambda';
import { z } from 'zod';
import { TenantProvisioningRequestedV1, EventEnvelopeSchema } from '@paas/event-contracts';
import { createTelemetry } from '@paas/observability';
import { contextFromEnvelope, runWithContext, type ExecutionContext } from '@paas/runtime-context';

export const SERVICE_ID = process.env['PAAS_SERVICE_ID'] ?? 'provisioning-workflow-service';
export const telemetry = createTelemetry({ serviceName: SERVICE_ID });
export const documentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ maxAttempts: 3, retryMode: 'standard' }),
  {
    marshallOptions: { removeUndefinedValues: true },
  },
);
export const TABLE_NAME = process.env['PROVISIONING_TABLE_NAME'] ?? 'provisioning';

/**
 * Every task receives the original request envelope (tenant + correlation metadata travel in
 * the state, never only in the X-Ray trace) plus the accumulated saga state.
 */
export const TaskInputSchema = z.object({
  request: EventEnvelopeSchema.extend({ data: TenantProvisioningRequestedV1.dataSchema }),
  state: z
    .object({
      slotReserved: z.boolean().optional(),
      resourcesProvisioned: z.boolean().optional(),
      apiKeyRef: z.string().optional(),
    })
    .default({}),
  error: z.unknown().optional(),
});
export type TaskInput = z.infer<typeof TaskInputSchema>;
export type SagaState = TaskInput['state'];

/** Thrown for transient faults; matched by the TRANSIENT_RETRY preset ("RetryableError"). */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

export type TaskImplementation = (ctx: ExecutionContext, input: TaskInput) => Promise<SagaState>;

/** Wraps a task: validate input → bind context/telemetry → run → return the merged state. */
export function taskHandler(operation: string, impl: TaskImplementation) {
  const base = async (rawInput: unknown, lambdaContext: LambdaContext): Promise<SagaState> => {
    const input = TaskInputSchema.parse(rawInput);
    const ctx = contextFromEnvelope(input.request, lambdaContext, {
      service: SERVICE_ID,
      operation,
    });
    return runWithContext(ctx, async () => {
      telemetry.bind(ctx);
      const state = await impl(ctx, input);
      telemetry.logger.info('task completed', {
        step: operation,
        targetTenantId: input.request.data.targetTenantId,
      });
      return { ...input.state, ...state };
    });
  };
  return middy(base)
    .use(captureLambdaHandler(telemetry.tracer))
    .use(injectLambdaContext(telemetry.logger))
    .use(logMetrics(telemetry.metrics));
}
