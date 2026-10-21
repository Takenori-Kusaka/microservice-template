import { beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

process.env['PAAS_WEB_NO_LISTEN'] = '1';
process.env['PAAS_ENVIRONMENT'] = 'sandbox';

const ddb = mockClient(DynamoDBDocumentClient);

function token(claims: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(claims)).toString('base64url');
}

describe('experimental web server (Hono) — same contract as the Event Functions API', () => {
  let app: Hono;
  beforeAll(async () => {
    ({ app } = await import('../src/entrypoints/web/server.js'));
  });

  it('rejects requests without a verified tenant', async () => {
    const res = await app.request('/orders', { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(403);
  });

  it('creates an order with the tenant from the token and returns correlation headers', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const res = await app.request('/orders', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token({ tenantId: 'acme', tenantTier: 'premium' })}`,
        'idempotency-key': 'web-create-0001',
        'x-correlation-id': 'flow-web-0001',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        customerRef: 'c',
        lines: [{ sku: 'A', quantity: 1, unitPrice: { amount: 10, currency: 'JPY' } }],
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-correlation-id')).toBe('flow-web-0001');
    const body = (await res.json()) as { orderId: string; tenantId?: string };
    expect(body.orderId).toHaveLength(26);
    expect(body.tenantId).toBeUndefined();
    const input = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(input.TransactItems?.[0]?.Put?.Item?.['pk']).toBe('TENANT#acme');
  });

  it('accepts the sandbox claims header used behind IamAuth endpoints (Authorization is stripped by Lambda)', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const res = await app.request('/orders', {
      method: 'POST',
      headers: {
        'x-paas-sandbox-claims': token({ tenantId: 'beta', tenantTier: 'standard' }),
        'idempotency-key': 'web-create-0002',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        customerRef: 'c',
        lines: [{ sku: 'A', quantity: 1, unitPrice: { amount: 10, currency: 'JPY' } }],
      }),
    });
    expect(res.status).toBe(201);
    const input = ddb.commandCalls(TransactWriteCommand).at(-1)!.args[0].input;
    expect(input.TransactItems?.[0]?.Put?.Item?.['pk']).toBe('TENANT#beta');
  });

  it('rejects a request with neither Authorization nor the sandbox claims header', async () => {
    const res = await app.request('/orders');
    expect(res.status).toBe(403);
  });

  it('keeps concurrent requests of different tenants isolated (AsyncLocalStorage)', async () => {
    ddb.on(GetCommand).callsFake((input: { Key: { pk: string } }) => ({
      Item: {
        pk: input.Key.pk,
        sk: 'ORDER#01ARZ3NDEKTSV4RRFFQ69G5FAV',
        entityType: 'ORDER',
        tenantId: input.Key.pk.replace('TENANT#', ''),
        orderId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        status: 'CREATED',
        customerRef: 'c',
        lines: [],
        total: { amount: 0, currency: 'JPY' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }));
    const results = await Promise.all(
      ['tenant-a', 'tenant-b', 'tenant-c'].map((tenantId) =>
        Promise.resolve(
          app.request('/orders/01ARZ3NDEKTSV4RRFFQ69G5FAV', {
            headers: { authorization: `Bearer ${token({ tenantId })}` },
          }),
        ),
      ),
    );
    const keys = ddb
      .commandCalls(GetCommand)
      .map((c) => (c.args[0].input.Key as { pk: string }).pk);
    expect(keys.sort()).toEqual(['TENANT#tenant-a', 'TENANT#tenant-b', 'TENANT#tenant-c']);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
