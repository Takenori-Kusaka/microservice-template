import { z } from 'zod';
import { defineEvent } from '../envelope.js';

export const ORDER_SERVICE = 'order-service';
export const FULFILLMENT_SERVICE = 'fulfillment-worker-service';

export const MoneySchema = z.object({
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
});

export const OrderLineSchema = z.object({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().positive().max(10_000),
  unitPrice: MoneySchema,
});

export const OrderCreatedV1 = defineEvent({
  type: 'order.created.v1',
  source: ORDER_SERVICE,
  description: 'An order was accepted and persisted by the order service.',
  dataSchema: z.object({
    orderId: z.string().min(1).max(64),
    customerRef: z.string().min(1).max(128),
    lines: z.array(OrderLineSchema).min(1).max(200),
    total: MoneySchema,
    createdAt: z.iso.datetime(),
  }),
});

export const OrderFulfilledV1 = defineEvent({
  type: 'order.fulfilled.v1',
  source: FULFILLMENT_SERVICE,
  description: 'Fulfillment completed for an order.',
  dataSchema: z.object({
    orderId: z.string().min(1).max(64),
    fulfilledAt: z.iso.datetime(),
    shipmentRef: z.string().min(1).max(128),
  }),
});

export const FulfillmentFailedV1 = defineEvent({
  type: 'order.fulfillment-failed.v1',
  source: FULFILLMENT_SERVICE,
  description: 'Fulfillment failed permanently; the order service should mark the order as failed.',
  dataSchema: z.object({
    orderId: z.string().min(1).max(64),
    reasonCode: z.enum(['OUT_OF_STOCK', 'INVALID_ADDRESS', 'POISON_MESSAGE', 'UNKNOWN']),
    detail: z.string().max(512).optional(),
    failedAt: z.iso.datetime(),
  }),
});
