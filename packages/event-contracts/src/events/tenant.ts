import { z } from 'zod';
import { TENANT_ID_PATTERN, TENANT_TIERS } from '@paas/runtime-context';
import { defineEvent } from '../envelope.js';

export const CONTROL_PLANE = 'tenant-control-plane';
export const PROVISIONING_SERVICE = 'provisioning-workflow-service';

/** Emitted by the control plane when a new tenant (or a tier change) must be provisioned. */
export const TenantProvisioningRequestedV1 = defineEvent({
  type: 'tenant.provisioning-requested.v1',
  source: CONTROL_PLANE,
  description: 'A tenant onboarding / tier change was requested and must be provisioned.',
  dataSchema: z.object({
    targetTenantId: z.string().regex(TENANT_ID_PATTERN),
    tier: z.enum(TENANT_TIERS),
    cellId: z.string().min(1).max(64),
    requestedBy: z.string().min(1).max(128),
  }),
});

export const TenantProvisionedV1 = defineEvent({
  type: 'tenant.provisioned.v1',
  source: PROVISIONING_SERVICE,
  description: 'Provisioning workflow completed; the tenant is active.',
  dataSchema: z.object({
    targetTenantId: z.string().regex(TENANT_ID_PATTERN),
    tier: z.enum(TENANT_TIERS),
    cellId: z.string().min(1).max(64),
    activatedAt: z.iso.datetime(),
  }),
});

export const TenantProvisioningFailedV1 = defineEvent({
  type: 'tenant.provisioning-failed.v1',
  source: PROVISIONING_SERVICE,
  description: 'Provisioning workflow failed and compensation ran.',
  dataSchema: z.object({
    targetTenantId: z.string().regex(TENANT_ID_PATTERN),
    failedStep: z.string().min(1).max(64),
    compensated: z.boolean(),
    reason: z.string().max(512),
  }),
});
