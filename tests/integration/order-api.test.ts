/**
 * Integration test against a deployed sandbox (guideline §16: "integration testは実AWS managed
 * serviceで実施する"). Skipped unless PAAS_API_URL is set.
 *
 *   PAAS_API_URL=$(aws cloudformation describe-stacks --stack-name paas-sandbox-cell-01-order-service \
 *     --query "Stacks[0].Outputs[?OutputKey=='ApiApiUrl...'].OutputValue" --output text) pnpm test:integration
 */
import { describe, expect, it } from 'vitest';
import { sandboxToken } from './sandbox-token.js';

const baseUrl = process.env['PAAS_API_URL'];
const describeIf = baseUrl ? describe : describe.skip;

describeIf('order API (deployed sandbox)', () => {
  const token = sandboxToken({ tenantId: 'integ-a', tenantTier: 'standard', sub: 'integ' });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const payload = {
    customerRef: 'integ',
    lines: [{ sku: 'SKU-1', quantity: 1, unitPrice: { amount: 100, currency: 'JPY' } }],
  };

  it('creates an order once per idempotency key, even under concurrent retries', async () => {
    const key = `integ-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${baseUrl}/orders`, {
          method: 'POST',
          headers: { ...headers, 'idempotency-key': key },
          body: JSON.stringify(payload),
        }),
      ),
    );
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as {
      orderId?: string;
      error?: { code: string };
    }[];
    const orderIds = new Set(bodies.map((b) => b.orderId).filter(Boolean));
    // Either all replay the same order or some get 409 IN_PROGRESS while the first completes.
    expect(orderIds.size).toBeLessThanOrEqual(1);
    expect(responses.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
  });

  it('rejects a reused key with a different payload', async () => {
    const key = `integ-${Date.now()}-mismatch`;
    await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': key },
      body: JSON.stringify(payload),
    });
    const second = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': key },
      body: JSON.stringify({ ...payload, customerRef: 'changed' }),
    });
    expect(second.status).toBe(409);
  });

  it('returns the correlation id it was given', async () => {
    const res = await fetch(`${baseUrl}/orders?limit=1`, {
      headers: { ...headers, 'x-correlation-id': 'integ-flow-0001' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-correlation-id')).toBe('integ-flow-0001');
  });
});
