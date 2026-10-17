/**
 * Fulfillment domain (simulated). Error classification is the domain's responsibility: the
 * entrypoint maps it to retry (transient) vs. DLQ/compensating event (permanent) — guideline §12
 * "retryはtransient errorだけ".
 */
export class PermanentFulfillmentError extends Error {
  readonly retryable = false;
  constructor(
    readonly reasonCode: 'OUT_OF_STOCK' | 'INVALID_ADDRESS' | 'POISON_MESSAGE' | 'UNKNOWN',
    message: string,
  ) {
    super(message);
    this.name = 'PermanentFulfillmentError';
  }
}

export class TransientFulfillmentError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'TransientFulfillmentError';
  }
}

export interface FulfillmentRequest {
  orderId: string;
  lines: { sku: string; quantity: number }[];
  /** SQS ApproximateReceiveCount, used by the simulation of transient faults. */
  attempt: number;
}

export interface FulfillmentResult {
  orderId: string;
  shipmentRef: string;
  fulfilledAt: string;
}

/**
 * Deterministic simulation used by the mock and by resiliency tests:
 *  - sku `POISON-*`      → permanent failure (goes to the failed-event path, never retried)
 *  - sku `FLAKY-ONCE`    → transient failure on the first attempt, success afterwards
 *  - sku `OUT-OF-STOCK-*`→ permanent OUT_OF_STOCK
 */
export function fulfill(request: FulfillmentRequest, now: Date = new Date()): FulfillmentResult {
  for (const line of request.lines) {
    if (line.sku.startsWith('POISON')) {
      throw new PermanentFulfillmentError('POISON_MESSAGE', `unprocessable line ${line.sku}`);
    }
    if (line.sku.startsWith('OUT-OF-STOCK')) {
      throw new PermanentFulfillmentError('OUT_OF_STOCK', `${line.sku} is out of stock`);
    }
    if (line.sku === 'FLAKY-ONCE' && request.attempt <= 1) {
      throw new TransientFulfillmentError('warehouse API timeout (simulated)');
    }
  }
  return {
    orderId: request.orderId,
    shipmentRef: `SHP-${request.orderId.slice(-8)}`,
    fulfilledAt: now.toISOString(),
  };
}
