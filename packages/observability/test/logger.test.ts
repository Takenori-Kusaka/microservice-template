import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Deadline, runWithContext, type ExecutionContext } from '@paas/runtime-context';
import { createLogger } from '../src/logger.js';

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    tenantId: 'acme',
    tenantTier: 'standard',
    requestId: 'req-1',
    correlationId: 'corr-1',
    cellId: 'cell-01',
    service: 'order-service',
    operation: 'CreateOrder',
    deploymentVersion: 'v1',
    deadline: Deadline.fromNow(1000),
    ...overrides,
  };
}

describe('createLogger', () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  beforeEach(() => stdout.mockClear());
  afterEach(() => stdout.mockClear());

  function lastLine(): Record<string, unknown> {
    const call = stdout.mock.calls.at(-1);
    if (!call) throw new Error('no output');
    return JSON.parse(String(call[0])) as Record<string, unknown>;
  }

  it('injects execution context keys from AsyncLocalStorage and redacts PII', () => {
    const logger = createLogger({ serviceName: 'order-service' });
    runWithContext(ctx(), () => {
      logger.info('created', { password: 'hunter2', email: 'x@y.z', orderId: 'o-1' });
    });
    const line = lastLine();
    expect(line['tenantId']).toBe('acme');
    expect(line['correlationId']).toBe('corr-1');
    expect(line['operation']).toBe('CreateOrder');
    expect(line['password']).toBe('[REDACTED]');
    expect(line['email']).toBe('[REDACTED]');
    expect(line['orderId']).toBe('o-1');
  });

  it('keeps concurrent contexts separate (web-function safety)', async () => {
    const logger = createLogger({ serviceName: 'order-service' });
    const seen: string[] = [];
    await Promise.all(
      ['t-a', 't-b'].map((tenantId) =>
        runWithContext(ctx({ tenantId }), async () => {
          await new Promise((r) => setTimeout(r, tenantId === 't-a' ? 5 : 1));
          logger.info('hello');
          seen.push(String(lastLine()['tenantId']));
        }),
      ),
    );
    expect(seen.sort()).toEqual(['t-a', 't-b']);
  });
});
