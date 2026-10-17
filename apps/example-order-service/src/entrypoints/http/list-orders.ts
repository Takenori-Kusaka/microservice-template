import { ListOrdersQuerySchema, jsonResponse } from '@paas/api-contracts';
import { listOrdersUseCase } from '../../application/queries.js';
import { DynamoDbOrderRepository } from '../../adapters/dynamodb-order-repository.js';
import { documentClient } from '../../adapters/clients.js';
import { apiHandler } from './shared.js';

const repository = new DynamoDbOrderRepository(
  documentClient,
  process.env['ORDERS_TABLE_NAME'] ?? 'orders',
);

export const handler = apiHandler('ListOrders', async (ctx, event) => {
  const query = ListOrdersQuerySchema.parse(event.queryStringParameters ?? {});
  const page = await listOrdersUseCase(repository, ctx, query);
  return jsonResponse(
    200,
    {
      items: page.items.map(({ tenantId: _tenant, ...order }) => order),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    },
    ctx,
  );
});
