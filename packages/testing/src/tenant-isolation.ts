/**
 * Tenant isolation probe for E2E tests (guideline §13: "tenant isolation testとして、異なる
 * tenant token、改ざんtenant ID、推測ID、非同期event改ざんをCI/E2Eへ入れる").
 *
 * Usage (tests/tenant-isolation):
 *   const probe = new TenantIsolationProbe({ baseUrl, tokenA, tokenB });
 *   const created = await probe.createAs('A', '/orders', payload);
 *   await probe.expectInvisibleTo('B', `/orders/${created.id}`);
 */
export interface TenantIsolationProbeOptions {
  baseUrl: string;
  tokenA: string;
  tokenB: string;
  fetchImpl?: typeof fetch;
}

export type Actor = 'A' | 'B';

export interface ProbeResult {
  status: number;
  body: unknown;
  headers: Headers;
}

export class TenantIsolationProbe {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TenantIsolationProbeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private token(actor: Actor): string {
    return actor === 'A' ? this.options.tokenA : this.options.tokenB;
  }

  async call(
    actor: Actor,
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<ProbeResult> {
    const res = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token(actor)}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      // keep raw text
    }
    return { status: res.status, body, headers: res.headers };
  }

  async createAs(
    actor: Actor,
    path: string,
    payload: unknown,
    idempotencyKey = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  ): Promise<ProbeResult> {
    const res = await this.call(actor, 'POST', path, {
      body: payload,
      headers: { 'idempotency-key': idempotencyKey },
    });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`createAs(${actor}) failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res;
  }

  /** The other tenant must get 404 (not 403, which would confirm existence). */
  async expectInvisibleTo(actor: Actor, path: string): Promise<void> {
    const res = await this.call(actor, 'GET', path);
    if (res.status !== 404) {
      throw new Error(`tenant isolation violated: ${actor} saw ${path} with status ${res.status}`);
    }
  }

  /** Forged tenant headers / body fields must have no effect on the tenant used for data access. */
  async expectForgeryIgnored(actor: Actor, path: string, forgedTenantId: string): Promise<void> {
    const res = await this.call(actor, 'GET', path, {
      headers: { 'x-tenant-id': forgedTenantId, 'x-paas-tenant': forgedTenantId },
    });
    if (res.status !== 404) {
      throw new Error(
        `tenant forgery accepted: ${actor} with forged tenant ${forgedTenantId} got ${res.status} on ${path}`,
      );
    }
  }
}
