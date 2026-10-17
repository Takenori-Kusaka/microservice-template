import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { makeExecutionContext } from '@paas/testing';
import { DynamoDbOrderRepository } from '../src/adapters/dynamodb-order-repository.js';
import type { Order } from '../src/domain/order.js';

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new DynamoDbOrderRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-1' })),
  'orders',
);

const order: Order = {
  orderId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  tenantId: 'acme',
  status: 'CREATED',
  customerRef: 'c',
  lines: [],
  total: { amount: 0, currency: 'JPY' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('DynamoDbOrderRepository (tenant scoping)', () => {
  beforeEach(() => ddb.reset());

  it('writes order + outbox in one transaction under the tenant partition', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const ctx = makeExecutionContext({ tenantId: 'acme' });
    await repo.createWithOutbox(ctx, order, {
      specversion: '1.0',
      id: 'evt-00000001',
      type: 'order.created.v1',
      source: 'order-service',
      time: new Date().toISOString(),
      tenantId: 'acme',
      tenantTier: 'standard',
      correlationId: ctx.correlationId,
      datacontenttype: 'application/json',
      data: {},
    });
    const input = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(input.TransactItems).toHaveLength(2);
    expect(input.TransactItems?.[0]?.Put?.Item?.['pk']).toBe('TENANT#acme');
    expect(input.TransactItems?.[1]?.Put?.Item?.['sk']).toBe('OUTBOX#evt-00000001');
  });

  it('get returns undefined for a foreign tenant even when the item exists', async () => {
    ddb
      .on(GetCommand)
      .resolves({ Item: { pk: 'TENANT#acme', sk: 'ORDER#x', entityType: 'ORDER', ...order } });
    const other = makeExecutionContext({ tenantId: 'evil' });
    const res = await repo.get(other, order.orderId);
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.Key?.['pk']).toBe('TENANT#evil');
    expect(res).toBeUndefined();
  });

  it('rejects cursors that belong to another tenant', async () => {
    const foreignCursor = Buffer.from(
      JSON.stringify({ pk: 'TENANT#acme', sk: 'ORDER#1' }),
    ).toString('base64url');
    await expect(
      repo.list(makeExecutionContext({ tenantId: 'evil' }), { limit: 10, cursor: foreignCursor }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      details: [{ path: 'cursor', message: 'cursor does not belong to this tenant' }],
    });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('updateStatus is conditional on CREATED and returns undefined when the condition fails', async () => {
    ddb
      .on(UpdateCommand)
      .rejects(Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' }));
    const res = await repo.updateStatus(
      makeExecutionContext({ tenantId: 'acme' }),
      order.orderId,
      'FULFILLED',
    );
    expect(res).toBeUndefined();
  });
});
