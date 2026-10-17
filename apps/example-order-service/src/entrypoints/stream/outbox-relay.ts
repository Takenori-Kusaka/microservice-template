import { BatchProcessor, EventType, processPartialResponse } from '@aws-lambda-powertools/batch';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import type { DynamoDBRecord, DynamoDBStreamEvent, Context as LambdaContext } from 'aws-lambda';
import { eventCatalog } from '@paas/event-contracts';
import { MetricUnit, StandardMetrics, createTelemetry } from '@paas/observability';
import { contextFromEnvelope, runWithContext } from '@paas/runtime-context';
import { documentClient, eventBridgeClient } from '../../adapters/clients.js';
import type { OutboxItem } from '../../adapters/dynamodb-order-repository.js';
import { EventBridgePublisher } from '../../adapters/eventbridge-publisher.js';

const SERVICE_ID = process.env['PAAS_SERVICE_ID'] ?? 'order-service';
const telemetry = createTelemetry({ serviceName: SERVICE_ID });
const publisher = new EventBridgePublisher(
  eventBridgeClient,
  process.env['EVENT_BUS_NAME'] ?? 'paas-bus',
);
const tableName = process.env['ORDERS_TABLE_NAME'] ?? 'orders';
const processor = new BatchProcessor(EventType.DynamoDBStreams);

/**
 * Transactional outbox relay (ADR-0012/ADR-0013): INSERTs of OUTBOX items (filtered at the
 * event source) are published to EventBridge and then deleted. At-least-once: if PutEvents
 * succeeds but the delete fails, the record is retried and consumers de-duplicate on `id`.
 */
async function relayRecord(record: DynamoDBRecord, lambdaContext: LambdaContext): Promise<void> {
  const image = record.dynamodb?.NewImage;
  if (!image) return;
  const item = unmarshall(
    image as unknown as Parameters<typeof unmarshall>[0],
  ) as unknown as OutboxItem;
  if (item.entityType !== 'OUTBOX') return;
  const envelope = eventCatalog.parse(item.envelope);
  const ctx = contextFromEnvelope(envelope, lambdaContext, {
    service: SERVICE_ID,
    operation: 'OutboxRelay',
  });
  await runWithContext(ctx, async () => {
    telemetry.bind(ctx);
    const { failed } = await publisher.publish([envelope]);
    if (failed.length > 0) {
      telemetry.metrics.addMetric(StandardMetrics.EventPublishFailed, MetricUnit.Count, 1);
      throw new Error(`publish failed: ${failed[0]!.reason}`);
    }
    telemetry.metrics.addMetric(StandardMetrics.EventPublished, MetricUnit.Count, 1);
    await documentClient.send(
      new DeleteCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk } }),
    );
    telemetry.logger.info('outbox event relayed', {
      eventId: envelope.id,
      eventType: envelope.type,
    });
  });
}

const base = async (event: DynamoDBStreamEvent, context: LambdaContext) =>
  processPartialResponse(
    event,
    (record: DynamoDBRecord) => relayRecord(record, context),
    processor,
    { context },
  );

export const handler = middy(base)
  .use(captureLambdaHandler(telemetry.tracer))
  .use(injectLambdaContext(telemetry.logger))
  .use(logMetrics(telemetry.metrics));
