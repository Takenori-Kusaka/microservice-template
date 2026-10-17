/**
 * Resiliency tests runnable without AWS (guideline §12, acceptance: "dependency timeout、throttle、
 * poison message、DLQ、workflow compensationを試験できる"). They exercise the real handler code
 * with simulated faults; the deployed-environment game day is documented in
 * docs/runbooks/worker-service.md.
 */
import { describe, expect, it } from 'vitest';
import { OrderCreatedV1, createEvent, type EventEnvelope } from '@paas/event-contracts';
import { Deadline, DeadlineExceededError, assertBudget } from '@paas/runtime-context';
import { makeExecutionContext, makeLambdaContext, makeSqsEventFromEnvelopes } from '@paas/testing';
import { createRecordHandler, type HandlerDeps } from '@paas/example-worker-service/handler';

function orderCreated(sku: string): EventEnvelope {
  return createEvent(OrderCreatedV1, makeExecutionContext(), {
    data: {
      orderId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      customerRef: 'c',
      lines: [{ sku, quantity: 1, unitPrice: { amount: 1, currency: 'JPY' } }],
      total: { amount: 1, currency: 'JPY' },
      createdAt: new Date().toISOString(),
    },
  });
}

const passthrough: HandlerDeps['idempotent'] = (_key, fn) => fn();

describe('fault injection: worker', () => {
  it('poison message → permanent failure event, no retry storm', async () => {
    const published: EventEnvelope[] = [];
    const deps: HandlerDeps = {
      publisher: {
        publish: async (e) => {
          published.push(...e);
          return { failed: [] };
        },
      },
      idempotent: passthrough,
    };
    const record = makeSqsEventFromEnvelopes([orderCreated('POISON-1')]).Records[0]!;
    let attempts = 0;
    for (let i = 0; i < 3; i++) {
      attempts++;
      const outcome = await createRecordHandler(deps)(record, makeLambdaContext());
      expect(outcome.kind).toBe('failed-permanently');
    }
    // Each delivery produces at most one failed-event; nothing is retried by the handler itself.
    expect(published.every((e) => e.type === 'order.fulfillment-failed.v1')).toBe(true);
    expect(published.length).toBe(attempts);
  });

  it('downstream publish failure → record reported as failed (SQS redelivers, then DLQ)', async () => {
    const deps: HandlerDeps = {
      publisher: {
        publish: async (e) => ({
          failed: e.map((x) => ({ id: x.id, reason: 'ThrottlingException' })),
        }),
      },
      idempotent: passthrough,
    };
    const record = makeSqsEventFromEnvelopes([orderCreated('SKU-1')]).Records[0]!;
    await expect(createRecordHandler(deps)(record, makeLambdaContext())).rejects.toThrow(
      /ThrottlingException/,
    );
  });
});

describe('fault injection: deadline budget', () => {
  it('a call that would start after the deadline is refused instead of timing out downstream', () => {
    const ctx = makeExecutionContext({ deadline: Deadline.fromNow(0) });
    expect(() => assertBudget(ctx.deadline, 'dynamodb.query', 20)).toThrow(DeadlineExceededError);
  });

  it('child budgets never exceed the parent', () => {
    const parent = Deadline.fromNow(300);
    const child = parent.child({ reserveMs: 100 });
    expect(child.remainingMs()).toBeLessThanOrEqual(200);
    expect(child.deadlineAtMs).toBeLessThanOrEqual(parent.deadlineAtMs);
  });
});
