import { ApiError } from '@paas/api-contracts';
import type { ExecutionContext } from '@paas/runtime-context';
import type { Order } from '../domain/order.js';
import type { OrderPage, OrderRepository } from '../ports/order-repository.js';

export async function getOrderUseCase(
  repository: OrderRepository,
  ctx: ExecutionContext,
  orderId: string,
): Promise<Order> {
  const order = await repository.get(ctx, orderId);
  // 404 for "exists in another tenant" and "does not exist" alike: never confirm existence.
  if (!order) throw ApiError.notFound('order');
  return order;
}

export async function listOrdersUseCase(
  repository: OrderRepository,
  ctx: ExecutionContext,
  options: { limit: number; cursor?: string },
): Promise<OrderPage> {
  return repository.list(ctx, options);
}
