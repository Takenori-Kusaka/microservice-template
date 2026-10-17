import { createEvent, OrderCreatedV1 } from '@paas/event-contracts';
import type { ExecutionContext } from '@paas/runtime-context';
import type { CreateOrderRequest } from '@paas/api-contracts';
import { createOrder, type Order } from '../domain/order.js';
import type { OrderRepository } from '../ports/order-repository.js';

export interface CreateOrderDeps {
  repository: OrderRepository;
  now?: () => Date;
}

/**
 * Use case: accept an order, persist it together with its outbox event in one transaction.
 * Idempotency is applied by the entrypoint around this function (key = tenant + Idempotency-Key),
 * so a retried request returns the stored result instead of re-executing.
 */
export async function createOrderUseCase(
  deps: CreateOrderDeps,
  ctx: ExecutionContext,
  request: CreateOrderRequest,
): Promise<Order> {
  const now = deps.now?.() ?? new Date();
  const order = createOrder({
    tenantId: ctx.tenantId,
    customerRef: request.customerRef,
    lines: request.lines,
    ...(request.note !== undefined ? { note: request.note } : {}),
    now,
  });
  const event = createEvent(OrderCreatedV1, ctx, {
    subject: `order/${order.orderId}`,
    data: {
      orderId: order.orderId,
      customerRef: order.customerRef,
      lines: order.lines,
      total: order.total,
      createdAt: order.createdAt,
    },
    now,
  });
  await deps.repository.createWithOutbox(ctx, order, event);
  return order;
}
