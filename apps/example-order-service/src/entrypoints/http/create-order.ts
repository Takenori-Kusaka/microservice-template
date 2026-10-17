import { IdempotencyConfig, makeIdempotent } from '@aws-lambda-powertools/idempotency';
import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';
import {
  ApiError,
  CreateOrderRequestSchema,
  jsonResponse,
  type CreateOrderRequest,
} from '@paas/api-contracts';
import type { ExecutionContext } from '@paas/runtime-context';
import { createOrderUseCase } from '../../application/create-order.js';
import { DynamoDbOrderRepository } from '../../adapters/dynamodb-order-repository.js';
import { documentClient } from '../../adapters/clients.js';
import type { Order } from '../../domain/order.js';
import { apiHandler, parseJsonBody } from './shared.js';

const repository = new DynamoDbOrderRepository(
  documentClient,
  process.env['ORDERS_TABLE_NAME'] ?? 'orders',
);

/**
 * Idempotency (ADR-0014): the key is `<tenantId>:CreateOrder:<Idempotency-Key>` so clients of
 * different tenants can never collide, and the payload hash is validated so a key reused with a
 * different body is rejected (409) rather than silently replayed.
 */
interface IdempotentInput {
  idempotencyKey: string;
  payload: CreateOrderRequest;
}

const persistenceStore = new DynamoDBPersistenceLayer({
  tableName: process.env['IDEMPOTENCY_TABLE_NAME'] ?? 'idempotency',
});

const idempotencyConfig = new IdempotencyConfig({
  eventKeyJmesPath: 'idempotencyKey',
  payloadValidationJmesPath: 'payload',
  throwOnNoIdempotencyKey: true,
  expiresAfterSeconds: 24 * 3600,
  useLocalCache: true,
});

const createOrderIdempotent = makeIdempotent(
  async (input: IdempotentInput, ctx: ExecutionContext): Promise<Order> =>
    createOrderUseCase({ repository }, ctx, input.payload),
  { persistenceStore, config: idempotencyConfig, dataIndexArgument: 0 },
);

export const handler = apiHandler('CreateOrder', async (ctx, event) => {
  if (!ctx.idempotencyKey) {
    throw ApiError.validation([
      { path: 'header.idempotency-key', message: 'Idempotency-Key header is required' },
    ]);
  }
  const body = parseJsonBody(event);
  if (typeof body === 'symbol')
    throw ApiError.validation([{ path: 'body', message: 'invalid JSON' }]);
  const request = CreateOrderRequestSchema.parse(body);
  const order = await createOrderIdempotent(
    { idempotencyKey: `${ctx.tenantId}:CreateOrder:${ctx.idempotencyKey}`, payload: request },
    ctx,
  );
  const { tenantId: _tenant, ...publicOrder } = order;
  return jsonResponse(201, publicOrder, ctx, { location: `/orders/${order.orderId}` });
});
