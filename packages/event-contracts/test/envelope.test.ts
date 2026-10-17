import { describe, expect, it } from 'vitest';
import { Deadline, type ExecutionContext } from '@paas/runtime-context';
import { createEvent, EventValidationError } from '../src/envelope.js';
import { eventCatalog } from '../src/catalog.js';
import { OrderCreatedV1 } from '../src/events/order.js';
import { fromSqsRecord, toPutEventsEntry } from '../src/eventbridge.js';

const ctx: ExecutionContext = {
  tenantId: 'acme',
  tenantTier: 'premium',
  requestId: 'req-00000001',
  correlationId: 'flow-00000001',
  cellId: 'cell-01',
  service: 'order-service',
  operation: 'CreateOrder',
  deploymentVersion: '1',
  deadline: Deadline.fromNow(5000),
};

const orderData = {
  orderId: 'o-1',
  customerRef: 'c-1',
  lines: [{ sku: 'SKU-1', quantity: 2, unitPrice: { amount: 100, currency: 'JPY' } }],
  total: { amount: 200, currency: 'JPY' },
  createdAt: new Date().toISOString(),
};

describe('event envelope', () => {
  it('creates an envelope bound to the execution context', () => {
    const ev = createEvent(OrderCreatedV1, ctx, { data: orderData, subject: 'order/o-1' });
    expect(ev.type).toBe('order.created.v1');
    expect(ev.tenantId).toBe('acme');
    expect(ev.correlationId).toBe('flow-00000001');
    expect(ev.causationId).toBe('req-00000001');
    expect(ev.source).toBe('order-service');
  });

  it('rejects invalid payloads at creation', () => {
    expect(() => createEvent(OrderCreatedV1, ctx, { data: { ...orderData, lines: [] } })).toThrow();
  });

  it('round-trips through EventBridge -> SQS target body', () => {
    const ev = createEvent(OrderCreatedV1, ctx, { data: orderData });
    const entry = toPutEventsEntry(ev, 'paas-bus');
    const sqsBody = JSON.stringify({
      version: '0',
      id: 'eb-1',
      'detail-type': entry.DetailType,
      source: entry.Source,
      detail: JSON.parse(entry.Detail) as unknown,
    });
    const parsed = fromSqsRecord(eventCatalog, { body: sqsBody });
    expect(parsed.id).toBe(ev.id);
    expect((parsed.data as { orderId: string }).orderId).toBe('o-1');
  });

  it('rejects unregistered types and tampered tenant ids', () => {
    const ev = createEvent(OrderCreatedV1, ctx, { data: orderData });
    expect(() => eventCatalog.parse({ ...ev, type: 'order.hacked.v1' })).toThrow(
      EventValidationError,
    );
    expect(() => eventCatalog.parse({ ...ev, tenantId: 'ACME OR 1=1' })).toThrow(
      EventValidationError,
    );
  });
});
