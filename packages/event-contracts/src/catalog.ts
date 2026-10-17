import { EventRegistry } from './registry.js';
import { FulfillmentFailedV1, OrderCreatedV1, OrderFulfilledV1 } from './events/order.js';
import {
  TenantProvisionedV1,
  TenantProvisioningFailedV1,
  TenantProvisioningRequestedV1,
} from './events/tenant.js';

/** The platform-wide catalog. Every published event type must be registered here. */
export const eventCatalog = new EventRegistry()
  .register(OrderCreatedV1)
  .register(OrderFulfilledV1)
  .register(FulfillmentFailedV1)
  .register(TenantProvisioningRequestedV1)
  .register(TenantProvisionedV1)
  .register(TenantProvisioningFailedV1);
