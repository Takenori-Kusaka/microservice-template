import {
  FulfillmentFailedV1,
  OrderCreatedV1,
  OrderFulfilledV1,
  createEvent,
  type EventEnvelope,
} from '@paas/event-contracts';
import type { ExecutionContext } from '@paas/runtime-context';
import { PermanentFulfillmentError, fulfill } from '../domain/fulfillment.js';

export interface Publisher {
  publish(events: EventEnvelope[]): Promise<{ failed: { id: string; reason: string }[] }>;
}

export type ProcessOutcome =
  { kind: 'fulfilled' } | { kind: 'failed-permanently'; reasonCode: string };

/**
 * Use case: fulfil one order.created event and publish the outcome event.
 * Transient errors propagate (the entrypoint reports the record as failed so SQS retries it);
 * permanent errors become a `order.fulfillment-failed.v1` event and the record is marked done.
 */
export async function processOrderCreated(
  deps: { publisher: Publisher; now?: () => Date },
  ctx: ExecutionContext,
  envelope: EventEnvelope,
  attempt: number,
): Promise<ProcessOutcome> {
  const data = OrderCreatedV1.dataSchema.parse(envelope.data);
  const now = deps.now?.() ?? new Date();
  try {
    const result = fulfill({ orderId: data.orderId, lines: data.lines, attempt }, now);
    const fulfilled = createEvent(OrderFulfilledV1, ctx, {
      subject: `order/${data.orderId}`,
      causationId: envelope.id,
      data: {
        orderId: result.orderId,
        shipmentRef: result.shipmentRef,
        fulfilledAt: result.fulfilledAt,
      },
      now,
    });
    await publishOrThrow(deps.publisher, fulfilled);
    return { kind: 'fulfilled' };
  } catch (error) {
    if (error instanceof PermanentFulfillmentError) {
      const failed = createEvent(FulfillmentFailedV1, ctx, {
        subject: `order/${data.orderId}`,
        causationId: envelope.id,
        data: {
          orderId: data.orderId,
          reasonCode: error.reasonCode,
          detail: error.message,
          failedAt: now.toISOString(),
        },
        now,
      });
      await publishOrThrow(deps.publisher, failed);
      return { kind: 'failed-permanently', reasonCode: error.reasonCode };
    }
    throw error;
  }
}

async function publishOrThrow(publisher: Publisher, event: EventEnvelope): Promise<void> {
  const { failed } = await publisher.publish([event]);
  if (failed.length > 0) {
    throw new Error(`event publish failed: ${failed[0]!.reason}`);
  }
}
