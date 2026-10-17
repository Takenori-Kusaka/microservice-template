import { newId } from '@paas/runtime-context';

/**
 * Order aggregate (guideline §16: domain layer has no AWS / HTTP knowledge).
 */
export type OrderStatus = 'CREATED' | 'FULFILLED' | 'FAILED';

export interface Money {
  amount: number;
  currency: string;
}

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPrice: Money;
}

export interface Order {
  readonly orderId: string;
  readonly tenantId: string;
  readonly status: OrderStatus;
  readonly customerRef: string;
  readonly lines: OrderLine[];
  readonly total: Money;
  readonly note?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failureReason?: string;
}

export class DomainError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable = false;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function computeTotal(lines: OrderLine[]): Money {
  const currency = lines[0]?.unitPrice.currency;
  if (!currency)
    throw new DomainError('VALIDATION_FAILED', 400, 'an order needs at least one line');
  let amount = 0;
  for (const line of lines) {
    if (line.unitPrice.currency !== currency) {
      throw new DomainError('VALIDATION_FAILED', 400, 'all lines must share one currency');
    }
    amount += line.quantity * line.unitPrice.amount;
  }
  return { amount, currency };
}

export function createOrder(input: {
  tenantId: string;
  customerRef: string;
  lines: OrderLine[];
  note?: string;
  now?: Date;
}): Order {
  const now = (input.now ?? new Date()).toISOString();
  return {
    orderId: newId(),
    tenantId: input.tenantId,
    status: 'CREATED',
    customerRef: input.customerRef,
    lines: input.lines,
    total: computeTotal(input.lines),
    ...(input.note !== undefined ? { note: input.note } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** State transitions are explicit so an out-of-order event cannot regress a terminal state. */
export function transition(
  order: Order,
  next: OrderStatus,
  now: Date,
  failureReason?: string,
): Order {
  if (order.status === next) return order;
  if (order.status !== 'CREATED') {
    throw new DomainError('CONFLICT', 409, `order ${order.orderId} is already ${order.status}`);
  }
  return {
    ...order,
    status: next,
    updatedAt: now.toISOString(),
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
}
