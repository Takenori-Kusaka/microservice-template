import { RetryableError, taskHandler } from './shared.js';

/**
 * Step 3: provision tenant resources (simulated external call).
 * Simulation hooks for game days:
 *  - cellId `cell-flaky`  → transient failure (retried with backoff + jitter by the state machine)
 *  - cellId `cell-full`   → permanent failure (triggers compensation)
 */
export const handler = taskHandler('ProvisionResources', async (_ctx, input) => {
  const { cellId, targetTenantId } = input.request.data;
  if (cellId === 'cell-flaky' && Math.random() < 0.7) {
    throw new RetryableError('provisioning API throttled (simulated)');
  }
  if (cellId === 'cell-full') {
    throw new Error(`CapacityExhausted: no capacity in ${cellId}`);
  }
  return { resourcesProvisioned: true, apiKeyRef: `secret://tenants/${targetTenantId}/api-key` };
});
