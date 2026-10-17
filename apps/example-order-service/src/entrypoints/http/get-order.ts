import { ApiError, OrderIdSchema, jsonResponse } from '@paas/api-contracts';
import { getOrderUseCase } from '../../application/queries.js';
import { DynamoDbOrderRepository } from '../../adapters/dynamodb-order-repository.js';
import { documentClient } from '../../adapters/clients.js';
import { apiHandler } from './shared.js';

const repository = new DynamoDbOrderRepository(
  documentClient,
  process.env['ORDERS_TABLE_NAME'] ?? 'orders',
);

export const handler = apiHandler('GetOrder', async (ctx, event) => {
  const parsed = OrderIdSchema.safeParse(event.pathParameters?.['orderId']);
  if (!parsed.success) throw ApiError.notFound('order');
  const order = await getOrderUseCase(repository, ctx, parsed.data);
  const { tenantId: _tenant, ...publicOrder } = order;
  return jsonResponse(200, publicOrder, ctx);
});
