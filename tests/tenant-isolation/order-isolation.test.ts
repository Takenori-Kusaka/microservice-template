/**
 * Tenant isolation E2E (acceptance criterion: "tenant Aのidentityでtenant Bのデータを取得・更新
 * できないE2E testがある"; guideline §13). Skipped unless PAAS_API_URL is set.
 */
import { describe, expect, it } from 'vitest';
import { TenantIsolationProbe } from '@paas/testing';
import { sandboxToken } from '../integration/sandbox-token.js';

const baseUrl = process.env['PAAS_API_URL'];
const describeIf = baseUrl ? describe : describe.skip;

describeIf('tenant isolation: order service', () => {
  const probe = new TenantIsolationProbe({
    baseUrl: baseUrl ?? '',
    tokenA: sandboxToken({ tenantId: 'iso-tenant-a', sub: 'a' }),
    tokenB: sandboxToken({ tenantId: 'iso-tenant-b', sub: 'b' }),
  });
  const payload = {
    customerRef: 'iso',
    lines: [{ sku: 'SKU-1', quantity: 1, unitPrice: { amount: 1, currency: 'JPY' } }],
  };

  it('tenant B cannot read, list or forge access to tenant A orders', async () => {
    const created = await probe.createAs('A', '/orders', payload);
    const orderId = (created.body as { orderId: string }).orderId;
    await probe.expectInvisibleTo('B', `/orders/${orderId}`);
    await probe.expectForgeryIgnored('B', `/orders/${orderId}`, 'iso-tenant-a');
    const listB = await probe.call('B', 'GET', '/orders?limit=100');
    expect(
      (listB.body as { items: { orderId: string }[] }).items.some((o) => o.orderId === orderId),
    ).toBe(false);
  });

  it('a cursor from tenant A is rejected for tenant B', async () => {
    const forged = Buffer.from(
      JSON.stringify({ pk: 'TENANT#iso-tenant-a', sk: 'ORDER#x' }),
    ).toString('base64url');
    const res = await probe.call('B', 'GET', `/orders?cursor=${forged}`);
    expect(res.status).toBe(400);
  });

  it('requests without a verified tenant are rejected', async () => {
    const res = await fetch(`${baseUrl}/orders`, {
      headers: { authorization: `Bearer ${sandboxToken({ tenantId: 'INVALID TENANT' })}` },
    });
    expect([401, 403]).toContain(res.status);
  });
});
