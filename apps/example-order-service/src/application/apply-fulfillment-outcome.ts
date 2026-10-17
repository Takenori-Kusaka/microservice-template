import { FulfillmentFailedV1, OrderFulfilledV1, type EventEnvelope } from '@paas/event-contracts';
import type { ExecutionContext } from '@paas/runtime-context';
import type { OrderRepository } from '../ports/order-repository.js';

/**
 * Consumer use case for downstream outcome events. Idempotent by construction: status
 * transitions are conditional and terminal states are never regressed.
 */
export async function applyFulfillmentOutcome(
  repository: OrderRepository,
  ctx: ExecutionContext,
  event: EventEnvelope,
): Promise<'applied' | 'ignored'> {
  if (event.type === OrderFulfilledV1.type) {
    const data = OrderFulfilledV1.dataSchema.parse(event.data);
    const updated = await repository.updateStatus(ctx, data.orderId, 'FULFILLED');
    return updated ? 'applied' : 'ignored';
  }
  if (event.type === FulfillmentFailedV1.type) {
    const data = FulfillmentFailedV1.dataSchema.parse(event.data);
    const updated = await repository.updateStatus(ctx, data.orderId, 'FAILED', data.reasonCode);
    return updated ? 'applied' : 'ignored';
  }
  return 'ignored';
}
