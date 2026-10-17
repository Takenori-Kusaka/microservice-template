import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ApiError } from '@paas/api-contracts';
import type { EventEnvelope } from '@paas/event-contracts';
import { assertBudget, tenantPartitionKey, type ExecutionContext } from '@paas/runtime-context';
import type { Order, OrderStatus } from '../domain/order.js';
import type { OrderPage, OrderRepository } from '../ports/order-repository.js';

const ORDER_PREFIX = 'ORDER#';
const OUTBOX_PREFIX = 'OUTBOX#';
const OUTBOX_TTL_SECONDS = 7 * 24 * 3600;

interface OrderItem extends Omit<Order, 'tenantId'> {
  pk: string;
  sk: string;
  entityType: 'ORDER';
  tenantId: string;
}

export interface OutboxItem {
  pk: string;
  sk: string;
  entityType: 'OUTBOX';
  tenantId: string;
  eventId: string;
  eventType: string;
  envelope: EventEnvelope;
  createdAt: string;
  expiresAt: number;
}

function orderKey(ctx: ExecutionContext, orderId: string): { pk: string; sk: string } {
  return { pk: tenantPartitionKey(ctx.tenantId), sk: `${ORDER_PREFIX}${orderId}` };
}

function toOrder(item: OrderItem): Order {
  const { pk: _pk, sk: _sk, entityType: _t, ...order } = item;
  return order;
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeCursor(ctx: ExecutionContext, cursor: string): Record<string, unknown> {
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw ApiError.validation([{ path: 'cursor', message: 'malformed cursor' }]);
  }
  // A cursor is only valid inside the caller's partition: a forged cursor cannot page another tenant.
  if (
    typeof key !== 'object' ||
    key === null ||
    (key as { pk?: unknown }).pk !== tenantPartitionKey(ctx.tenantId)
  ) {
    throw ApiError.validation([
      { path: 'cursor', message: 'cursor does not belong to this tenant' },
    ]);
  }
  return key as Record<string, unknown>;
}

/**
 * DynamoDB adapter for the pooled order table. Every key is derived from `ctx.tenantId` through
 * {@link tenantPartitionKey}; condition expressions make cross-tenant overwrite impossible even
 * if a caller passes a foreign orderId.
 */
export class DynamoDbOrderRepository implements OrderRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async createWithOutbox(ctx: ExecutionContext, order: Order, event: EventEnvelope): Promise<void> {
    assertBudget(ctx.deadline, 'dynamodb.transactWrite', 50);
    const key = orderKey(ctx, order.orderId);
    const now = new Date();
    const outbox: OutboxItem = {
      pk: key.pk,
      sk: `${OUTBOX_PREFIX}${event.id}`,
      entityType: 'OUTBOX',
      tenantId: ctx.tenantId,
      eventId: event.id,
      eventType: event.type,
      envelope: event,
      createdAt: now.toISOString(),
      expiresAt: Math.floor(now.getTime() / 1000) + OUTBOX_TTL_SECONDS,
    };
    const item: OrderItem = { ...key, entityType: 'ORDER', ...order, tenantId: ctx.tenantId };
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: item,
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          },
          { Put: { TableName: this.tableName, Item: outbox } },
        ],
      }),
      { abortSignal: ctx.deadline.toAbortSignal() },
    );
  }

  async get(ctx: ExecutionContext, orderId: string): Promise<Order | undefined> {
    assertBudget(ctx.deadline, 'dynamodb.get', 20);
    const res = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: orderKey(ctx, orderId),
        ConsistentRead: true,
      }),
      { abortSignal: ctx.deadline.toAbortSignal() },
    );
    const item = res.Item as OrderItem | undefined;
    if (!item || item.entityType !== 'ORDER' || item.tenantId !== ctx.tenantId) return undefined;
    return toOrder(item);
  }

  async list(
    ctx: ExecutionContext,
    options: { limit: number; cursor?: string },
  ): Promise<OrderPage> {
    assertBudget(ctx.deadline, 'dynamodb.query', 20);
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': tenantPartitionKey(ctx.tenantId),
          ':prefix': ORDER_PREFIX,
        },
        Limit: options.limit,
        ScanIndexForward: false, // ULIDs sort by time: newest first
        ...(options.cursor ? { ExclusiveStartKey: decodeCursor(ctx, options.cursor) } : {}),
      }),
      { abortSignal: ctx.deadline.toAbortSignal() },
    );
    const items = ((res.Items ?? []) as OrderItem[])
      .filter((i) => i.entityType === 'ORDER')
      .map(toOrder);
    return {
      items,
      ...(res.LastEvaluatedKey ? { nextCursor: encodeCursor(res.LastEvaluatedKey) } : {}),
    };
  }

  async updateStatus(
    ctx: ExecutionContext,
    orderId: string,
    status: OrderStatus,
    failureReason?: string,
  ): Promise<Order | undefined> {
    assertBudget(ctx.deadline, 'dynamodb.update', 20);
    try {
      const res = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: orderKey(ctx, orderId),
          // Only CREATED orders transition; terminal states are never regressed (idempotent consumer).
          ConditionExpression: 'attribute_exists(pk) AND tenantId = :tenant AND #status = :created',
          UpdateExpression:
            'SET #status = :status, updatedAt = :now' +
            (failureReason ? ', failureReason = :reason' : ''),
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':tenant': ctx.tenantId,
            ':created': 'CREATED',
            ':status': status,
            ':now': new Date().toISOString(),
            ...(failureReason ? { ':reason': failureReason } : {}),
          },
          ReturnValues: 'ALL_NEW',
        }),
        { abortSignal: ctx.deadline.toAbortSignal() },
      );
      return res.Attributes ? toOrder(res.Attributes as OrderItem) : undefined;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return undefined;
      throw error;
    }
  }
}
