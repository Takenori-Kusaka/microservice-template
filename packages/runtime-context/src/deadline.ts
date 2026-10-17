import type { Context as LambdaContext } from 'aws-lambda';

/**
 * Deadline / timeout budget propagated from the API entry point to every downstream call
 * (guideline §6 API契約 "deadline/timeout budgetを入口から下流へ伝播する", §12 信頼性).
 *
 * The deadline is an absolute epoch-millisecond instant so it survives serialisation across
 * HTTP headers, SQS message attributes and Step Functions input.
 */
export class Deadline {
  private constructor(readonly deadlineAtMs: number) {}

  static fromNow(ms: number): Deadline {
    return new Deadline(Date.now() + ms);
  }

  static at(epochMs: number): Deadline {
    return new Deadline(epochMs);
  }

  /**
   * Derives a deadline from the Lambda execution context, leaving a safety margin so the handler
   * can still write logs / return an error response before the sandbox is frozen.
   */
  static fromLambdaContext(
    context: Pick<LambdaContext, 'getRemainingTimeInMillis'>,
    safetyMarginMs = 500,
  ): Deadline {
    const remaining = Math.max(0, context.getRemainingTimeInMillis() - safetyMarginMs);
    return Deadline.fromNow(remaining);
  }

  /** Parses a header / attribute value produced by {@link toHeaderValue}. */
  static fromHeaderValue(value: string | undefined | null): Deadline | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return new Deadline(parsed);
  }

  /** Earliest of several deadlines (e.g. inbound header vs. Lambda remaining time). */
  static earliest(...deadlines: (Deadline | undefined)[]): Deadline {
    const present = deadlines.filter((d): d is Deadline => d !== undefined);
    if (present.length === 0) {
      throw new Error('at least one deadline is required');
    }
    return present.reduce((min, d) => (d.deadlineAtMs < min.deadlineAtMs ? d : min));
  }

  remainingMs(now: number = Date.now()): number {
    return Math.max(0, this.deadlineAtMs - now);
  }

  isExpired(now: number = Date.now()): boolean {
    return this.remainingMs(now) === 0;
  }

  /**
   * Budget for a single downstream call. Keeps `reserveMs` for work that must happen after the
   * call (persisting results, emitting events) and caps the call at `maxMs`.
   */
  child(options: { reserveMs?: number; maxMs?: number } = {}): Deadline {
    const reserve = options.reserveMs ?? 0;
    const available = Math.max(0, this.remainingMs() - reserve);
    const budget = options.maxMs === undefined ? available : Math.min(available, options.maxMs);
    return Deadline.fromNow(budget);
  }

  /** AbortSignal that fires at the deadline: pass to AWS SDK v3 calls and fetch(). */
  toAbortSignal(): AbortSignal {
    return AbortSignal.timeout(Math.max(1, this.remainingMs()));
  }

  toHeaderValue(): string {
    return String(this.deadlineAtMs);
  }

  toJSON(): number {
    return this.deadlineAtMs;
  }
}

export class DeadlineExceededError extends Error {
  readonly code = 'DEADLINE_EXCEEDED';
  readonly retryable = false;
  constructor(
    readonly operation: string,
    readonly deadline: Deadline,
  ) {
    super(`deadline exceeded before ${operation}`);
    this.name = 'DeadlineExceededError';
  }
}

/** Throws when there is not enough budget left to attempt `operation`. */
export function assertBudget(deadline: Deadline, operation: string, minimumMs = 1): void {
  if (deadline.remainingMs() < minimumMs) {
    throw new DeadlineExceededError(operation, deadline);
  }
}
