import type { ExecutionContext } from '@paas/runtime-context';
import type { EventEnvelope } from '@paas/event-contracts';
import type { Order, OrderStatus } from '../domain/order.js';

export interface OrderPage {
  items: Order[];
  nextCursor?: string;
}

/**
 * Repository port. Every method takes the ExecutionContext so the adapter can scope all keys to
 * `ctx.tenantId`; there is no API to read "all tenants".
 */
export interface OrderRepository {
  /** Atomically stores the order and the outbox record of its domain event (ADR-0012/0013). */
  createWithOutbox(ctx: ExecutionContext, order: Order, event: EventEnvelope): Promise<void>;
  get(ctx: ExecutionContext, orderId: string): Promise<Order | undefined>;
  list(ctx: ExecutionContext, options: { limit: number; cursor?: string }): Promise<OrderPage>;
  updateStatus(
    ctx: ExecutionContext,
    orderId: string,
    status: OrderStatus,
    failureReason?: string,
  ): Promise<Order | undefined>;
}
