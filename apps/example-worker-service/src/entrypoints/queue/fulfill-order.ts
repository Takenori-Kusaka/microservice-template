import { BatchProcessor, EventType, processPartialResponse } from '@aws-lambda-powertools/batch';
import { IdempotencyConfig, makeIdempotent } from '@aws-lambda-powertools/idempotency';
import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import type { Context as LambdaContext, SQSEvent, SQSRecord } from 'aws-lambda';
import { eventCatalog, fromSqsRecord, type EventEnvelope } from '@paas/event-contracts';
import {
  MetricUnit,
  StandardMetrics,
  createTelemetry,
  isolationViolationReason,
  recordIsolationViolation,
} from '@paas/observability';
import { contextFromEnvelope, runWithContext, type ExecutionContext } from '@paas/runtime-context';
import {
  processOrderCreated,
  type ProcessOutcome,
  type Publisher,
} from '../../application/process-order-created.js';
import { EventBridgePublisher, eventBridgeClient } from '../../adapters/eventbridge-publisher.js';

const SERVICE_ID = process.env['PAAS_SERVICE_ID'] ?? 'fulfillment-worker-service';
const telemetry = createTelemetry({ serviceName: SERVICE_ID });
const processor = new BatchProcessor(EventType.SQS);

export interface HandlerDeps {
  publisher: Publisher;
  /** Wraps the per-event unit of work with idempotency (keyed by tenant + eventId). */
  idempotent: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
}

/** Production wiring: EventBridge publisher + DynamoDB-backed Powertools idempotency. */
function productionDeps(): HandlerDeps {
  const persistenceStore = new DynamoDBPersistenceLayer({
    tableName: process.env['IDEMPOTENCY_TABLE_NAME'] ?? 'idempotency',
  });
  const config = new IdempotencyConfig({
    eventKeyJmesPath: 'key',
    expiresAfterSeconds: 7 * 24 * 3600,
    useLocalCache: true,
  });
  const run = makeIdempotent(async (input: { key: string }, fn: () => Promise<unknown>) => fn(), {
    persistenceStore,
    config,
    dataIndexArgument: 0,
  });
  return {
    publisher: new EventBridgePublisher(
      eventBridgeClient,
      process.env['EVENT_BUS_NAME'] ?? 'paas-bus',
    ),
    idempotent: async <T>(key: string, fn: () => Promise<T>) => (await run({ key }, fn)) as T,
  };
}

/**
 * Per-record processing. Returning normally marks the record as done; throwing marks it as
 * failed so SQS redelivers it (visibility timeout) and, after maxReceiveCount, moves it to the
 * DLQ (guideline §12 "async consumerはpartial batch failure、DLQ、redrive、poison message隔離").
 */
export function createRecordHandler(deps: HandlerDeps) {
  return async (record: SQSRecord, lambdaContext: LambdaContext): Promise<ProcessOutcome> => {
    let envelope: EventEnvelope;
    try {
      envelope = fromSqsRecord(eventCatalog, record);
    } catch (error) {
      const reason = isolationViolationReason(error);
      if (reason) recordIsolationViolation(telemetry.metrics, reason);
      throw error;
    }
    const attempt = Number(record.attributes.ApproximateReceiveCount ?? '1');
    const ctx: ExecutionContext = contextFromEnvelope(envelope, lambdaContext, {
      service: SERVICE_ID,
      operation: 'FulfillOrder',
    });
    return runWithContext(ctx, async () => {
      telemetry.bind(ctx);
      const ageMs = Date.now() - Number(record.attributes.SentTimestamp ?? Date.now());
      telemetry.metrics.addMetric(
        StandardMetrics.MessageAgeMs,
        MetricUnit.Milliseconds,
        Math.max(0, ageMs),
      );
      try {
        const outcome = await deps.idempotent(`${ctx.tenantId}:${envelope.id}`, () =>
          processOrderCreated({ publisher: deps.publisher }, ctx, envelope, attempt),
        );
        telemetry.metrics.addMetric(StandardMetrics.MessageProcessed, MetricUnit.Count, 1);
        telemetry.logger.info('order processed', { eventId: envelope.id, attempt, outcome });
        return outcome;
      } catch (error) {
        telemetry.metrics.addMetric(StandardMetrics.MessageFailed, MetricUnit.Count, 1);
        telemetry.logger.warn('order processing failed; record will be retried', {
          eventId: envelope.id,
          attempt,
          error,
        });
        throw error;
      }
    });
  };
}

let deps: HandlerDeps | undefined;

const base = async (event: SQSEvent, context: LambdaContext) => {
  deps ??= productionDeps();
  const recordHandler = createRecordHandler(deps);
  return processPartialResponse(
    event,
    (record: SQSRecord) => recordHandler(record, context),
    processor,
    { context },
  );
};

export const handler = middy(base)
  .use(captureLambdaHandler(telemetry.tracer))
  .use(injectLambdaContext(telemetry.logger))
  .use(logMetrics(telemetry.metrics));
