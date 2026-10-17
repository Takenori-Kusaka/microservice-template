import { taskHandler } from './shared.js';

/** Step 1: business validation (the envelope itself was already schema-validated). */
export const handler = taskHandler('ValidateRequest', async (ctx, input) => {
  const { targetTenantId, cellId } = input.request.data;
  if (targetTenantId === ctx.tenantId && ctx.tenantId !== 'platform') {
    // A tenant may not provision itself; requests originate from the control plane.
    throw new Error(`ValidationFailed: tenant ${targetTenantId} cannot self-provision`);
  }
  if (!/^cell-[a-z0-9-]+$/.test(cellId)) {
    throw new Error(`ValidationFailed: unknown cell ${cellId}`);
  }
  return {};
});
