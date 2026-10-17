import { z } from 'zod';
import type { components } from './generated/order-service.js';

/**
 * Runtime validation schemas for the order API. They mirror schemas/openapi/order-service.yaml;
 * the contract test in tests/contract asserts the two stay aligned.
 */
export const MoneySchema = z.object({
  amount: z.number().int().min(0),
  currency: z.string().length(3),
});

export const OrderLineSchema = z.object({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(10_000),
  unitPrice: MoneySchema,
});

export const CreateOrderRequestSchema = z
  .object({
    customerRef: z.string().min(1).max(128),
    lines: z.array(OrderLineSchema).min(1).max(200),
    note: z.string().max(1000).optional(),
  })
  .strict();

export const ListOrdersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(1024).optional(),
});

export const OrderIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;
export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;
export type Order = components['schemas']['Order'];
export type OrderPage = components['schemas']['OrderPage'];
export type OrderStatus = components['schemas']['OrderStatus'];
export type ErrorResponse = components['schemas']['ErrorResponse'];
