import { describe, expect, it } from 'vitest';
import { makeExecutionContext } from '@paas/testing';
import type { EventEnvelope } from '@paas/event-contracts';
import { createOrderUseCase } from '../src/application/create-order.js';
import { transition, DomainError, type Order } from '../src/domain/order.js';
import type { OrderRepository } from '../src/ports/order-repository.js';

class InMemoryRepository implements OrderRepository {
  readonly orders = new Map<string, Order>();
  readonly outbox: EventEnvelope[] = [];
  async createWithOutbox(_ctx: never, order: Order, event: EventEnvelope): Promise<void> {
    this.orders.set(`${order.tenantId}/${order.orderId}`, order);
    this.outbox.push(event);
  }
  async get(ctx: { tenantId: string }, orderId: string): Promise<Order | undefined> {
    return this.orders.get(`${ctx.tenantId}/${orderId}`);
  }
  async list(): Promise<{ items: Order[] }> {
    return { items: [...this.orders.values()] };
  }
  async updateStatus(): Promise<Order | undefined> {
    return undefined;
  }
}

describe('createOrderUseCase', () => {
  it('persists the order and its outbox event bound to the caller tenant', async () => {
    const repository = new InMemoryRepository();
    const ctx = makeExecutionContext({ tenantId: 'acme', correlationId: 'flow-0001-abc' });
    const order = await createOrderUseCase({ repository }, ctx, {
      customerRef: 'cust-1',
      lines: [
        { sku: 'A', quantity: 2, unitPrice: { amount: 100, currency: 'JPY' } },
        { sku: 'B', quantity: 1, unitPrice: { amount: 50, currency: 'JPY' } },
      ],
    });
    expect(order.tenantId).toBe('acme');
    expect(order.total).toEqual({ amount: 250, currency: 'JPY' });
    expect(repository.outbox).toHaveLength(1);
    expect(repository.outbox[0]?.type).toBe('order.created.v1');
    expect(repository.outbox[0]?.tenantId).toBe('acme');
    expect(repository.outbox[0]?.correlationId).toBe('flow-0001-abc');
  });

  it('rejects mixed currencies', async () => {
    const repository = new InMemoryRepository();
    await expect(
      createOrderUseCase({ repository }, makeExecutionContext(), {
        customerRef: 'c',
        lines: [
          { sku: 'A', quantity: 1, unitPrice: { amount: 1, currency: 'JPY' } },
          { sku: 'B', quantity: 1, unitPrice: { amount: 1, currency: 'USD' } },
        ],
      }),
    ).rejects.toThrow(DomainError);
  });
});

describe('transition', () => {
  const base: Order = {
    orderId: 'o',
    tenantId: 't',
    status: 'CREATED',
    customerRef: 'c',
    lines: [],
    total: { amount: 0, currency: 'JPY' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  it('never regresses a terminal state', () => {
    const fulfilled = transition(base, 'FULFILLED', new Date());
    expect(() => transition(fulfilled, 'FAILED', new Date())).toThrow(DomainError);
    expect(transition(fulfilled, 'FULFILLED', new Date())).toBe(fulfilled);
  });
});
