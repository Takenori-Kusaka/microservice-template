import { BatchProcessor, EventType, processPartialResponse } from '@aws-lambda-powertools/batch';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import type { Context as LambdaContext, SQSEvent, SQSRecord } from 'aws-lambda';
import { eventCatalog, fromSqsRecord } from '@paas/event-contracts';
import { MetricUnit, StandardMetrics, createTelemetry } from '@paas/observability';
import { contextFromEnvelope, runWithContext } from '@paas/runtime-context';
import { applyFulfillmentOutcome } from '../../application/apply-fulfillment-outcome.js';
import { DynamoDbOrderRepository } from '../../adapters/dynamodb-order-repository.js';
import { documentClient } from '../../adapters/clients.js';

const SERVICE_ID = process.env['PAAS_SERVICE_ID'] ?? 'order-service';
const telemetry = createTelemetry({ serviceName: SERVICE_ID });
const repository = new DynamoDbOrderRepository(
  documentClient,
  process.env['ORDERS_TABLE_NAME'] ?? 'orders',
);
const processor = new BatchProcessor(EventType.SQS);

/** Consumes fulfillment outcome events and updates the order read state (idempotent). */
async function handleRecord(record: SQSRecord, lambdaContext: LambdaContext): Promise<void> {
  const envelope = fromSqsRecord(eventCatalog, record);
  const ctx = contextFromEnvelope(envelope, lambdaContext, {
    service: SERVICE_ID,
    operation: 'ApplyFulfillmentOutcome',
  });
  await runWithContext(ctx, async () => {
    telemetry.bind(ctx);
    const outcome = await applyFulfillmentOutcome(repository, ctx, envelope);
    telemetry.metrics.addMetric(StandardMetrics.MessageProcessed, MetricUnit.Count, 1);
    telemetry.logger.info('fulfillment outcome applied', {
      eventId: envelope.id,
      eventType: envelope.type,
      outcome,
    });
  });
}

const base = async (event: SQSEvent, context: LambdaContext) =>
  processPartialResponse(event, (record: SQSRecord) => handleRecord(record, context), processor, {
    context,
  });

export const handler = middy(base)
  .use(captureLambdaHandler(telemetry.tracer))
  .use(injectLambdaContext(telemetry.logger))
  .use(logMetrics(telemetry.metrics));
