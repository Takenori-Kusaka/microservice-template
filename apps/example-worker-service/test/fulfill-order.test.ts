import { describe, expect, it } from 'vitest';
import type { SQSRecord } from 'aws-lambda';
import { OrderCreatedV1, createEvent, type EventEnvelope } from '@paas/event-contracts';
import { makeExecutionContext, makeLambdaContext, makeSqsEventFromEnvelopes } from '@paas/testing';
import { createRecordHandler, type HandlerDeps } from '../src/entrypoints/queue/fulfill-order.js';

function orderCreated(skus: string[], tenantId = 'acme'): EventEnvelope {
  const ctx = makeExecutionContext({ tenantId });
  return createEvent(OrderCreatedV1, ctx, {
    data: {
      orderId: `01ARZ3NDEKTSV4RRFFQ69G5F${skus[0]!.slice(0, 2).toUpperCase().padEnd(2, 'A')}`,
      customerRef: 'c',
      lines: skus.map((sku) => ({ sku, quantity: 1, unitPrice: { amount: 1, currency: 'JPY' } })),
      total: { amount: skus.length, currency: 'JPY' },
      createdAt: new Date().toISOString(),
    },
  });
}

function fakeDeps() {
  const published: EventEnvelope[] = [];
  const seen = new Map<string, unknown>();
  const deps: HandlerDeps = {
    publisher: {
      publish: async (events) => {
        published.push(...events);
        return { failed: [] };
      },
    },
    idempotent: async (key, fn) => {
      if (seen.has(key)) return seen.get(key) as never;
      const result = await fn();
      seen.set(key, result);
      return result;
    },
  };
  return { deps, published, seen };
}

describe('fulfill-order record handler', () => {
  it('publishes order.fulfilled.v1 with the same correlation id', async () => {
    const { deps, published } = fakeDeps();
    const envelope = orderCreated(['SKU-1']);
    const record = makeSqsEventFromEnvelopes([envelope]).Records[0]!;
    const outcome = await createRecordHandler(deps)(record, makeLambdaContext());
    expect(outcome.kind).toBe('fulfilled');
    expect(published[0]?.type).toBe('order.fulfilled.v1');
    expect(published[0]?.correlationId).toBe(envelope.correlationId);
    expect(published[0]?.causationId).toBe(envelope.id);
  });

  it('turns permanent failures into a failed event instead of retrying', async () => {
    const { deps, published } = fakeDeps();
    const record = makeSqsEventFromEnvelopes([orderCreated(['POISON-1'])]).Records[0]!;
    const outcome = await createRecordHandler(deps)(record, makeLambdaContext());
    expect(outcome).toEqual({ kind: 'failed-permanently', reasonCode: 'POISON_MESSAGE' });
    expect(published[0]?.type).toBe('order.fulfillment-failed.v1');
  });

  it('throws on transient failure (record retried by SQS) and succeeds on the next attempt', async () => {
    const { deps, published } = fakeDeps();
    const envelope = orderCreated(['FLAKY-ONCE']);
    const first = makeSqsEventFromEnvelopes([envelope]).Records[0]!;
    await expect(createRecordHandler(deps)(first, makeLambdaContext())).rejects.toThrow(/timeout/);
    const second: SQSRecord = {
      ...first,
      attributes: { ...first.attributes, ApproximateReceiveCount: '2' },
    };
    const outcome = await createRecordHandler(deps)(second, makeLambdaContext());
    expect(outcome.kind).toBe('fulfilled');
    expect(published).toHaveLength(1);
  });

  it('is idempotent per tenant + eventId (duplicate delivery publishes nothing new)', async () => {
    const { deps, published } = fakeDeps();
    const envelope = orderCreated(['SKU-1']);
    const record = makeSqsEventFromEnvelopes([envelope]).Records[0]!;
    await createRecordHandler(deps)(record, makeLambdaContext());
    await createRecordHandler(deps)(record, makeLambdaContext());
    expect(published).toHaveLength(1);
  });

  it('rejects envelopes with tampered tenant ids', async () => {
    const { deps } = fakeDeps();
    const envelope = { ...orderCreated(['SKU-1']), tenantId: 'not valid!' };
    const record = makeSqsEventFromEnvelopes([envelope]).Records[0]!;
    await expect(createRecordHandler(deps)(record, makeLambdaContext())).rejects.toThrow(
      /validation/,
    );
  });
});
