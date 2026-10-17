import { LogFormatter, LogItem, Logger } from '@aws-lambda-powertools/logger';
import type { LogAttributes, UnformattedAttributes } from '@aws-lambda-powertools/logger/types';
import { telemetryKeys, tryGetContext, type ExecutionContext } from '@paas/runtime-context';
import { createRedactor, type Redactor } from './redaction.js';

export interface LoggerPreset {
  serviceName: string;
  /** Extra attribute names to redact on top of the defaults. */
  sensitiveKeys?: readonly string[];
  /** Fraction (0..1) of invocations whose DEBUG logs are emitted; keeps cost bounded. */
  sampleRateValue?: number;
}

/**
 * Formatter that (1) redacts PII in every attribute and (2) injects the ambient
 * ExecutionContext keys so correlation never depends on the caller remembering to add them.
 *
 * Reading the context from AsyncLocalStorage (instead of logger.appendKeys at handler start)
 * is what makes the same logger instance safe in runtimes that serve concurrent requests in one
 * process (Lambda Web Functions). Mutating shared logger state per request would interleave
 * tenants.
 */
class PaasLogFormatter extends LogFormatter {
  constructor(private readonly redactor: Redactor) {
    super();
  }

  formatAttributes(
    attributes: UnformattedAttributes,
    additionalLogAttributes: LogAttributes,
  ): LogItem {
    const ctx = tryGetContext();
    const base: LogAttributes = {
      level: attributes.logLevel,
      message: attributes.message,
      timestamp: this.formatTimestamp(attributes.timestamp),
      service: attributes.serviceName,
      ...(ctx ? telemetryKeys(ctx) : {}),
      ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
      ...(attributes.xRayTraceId && !ctx?.traceId ? { traceId: attributes.xRayTraceId } : {}),
      ...(attributes.lambdaContext
        ? {
            functionName: attributes.lambdaContext.functionName,
            functionVersion: attributes.lambdaContext.functionVersion,
            coldStart: attributes.lambdaContext.coldStart,
          }
        : {}),
      ...(attributes.sampleRateValue !== undefined
        ? { sampleRate: attributes.sampleRateValue }
        : {}),
      ...(attributes.error ? { error: this.formatError(attributes.error) } : {}),
    };
    const extra = this.redactor(additionalLogAttributes) as LogAttributes;
    const item = new LogItem({ attributes: base });
    item.addAttributes(extra);
    return item;
  }

  override formatError(error: Error): LogAttributes {
    const extra: LogAttributes = {};
    if ('code' in error && typeof (error as { code?: unknown }).code === 'string') {
      extra['code'] = (error as { code: string }).code;
    }
    if ('retryable' in error && typeof (error as { retryable?: unknown }).retryable === 'boolean') {
      extra['retryable'] = (error as { retryable: boolean }).retryable;
    }
    return this.redactor({
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...extra,
    }) as LogAttributes;
  }
}

/**
 * Creates the standard structured JSON logger. Log level comes from POWERTOOLS_LOG_LEVEL /
 * LOG_LEVEL (set by the ObservableFunction construct), defaulting to INFO.
 */
export function createLogger(preset: LoggerPreset): Logger {
  const redactor = createRedactor(preset.sensitiveKeys ?? []);
  return new Logger({
    serviceName: preset.serviceName,
    logFormatter: new PaasLogFormatter(redactor),
    ...(preset.sampleRateValue !== undefined ? { sampleRateValue: preset.sampleRateValue } : {}),
  });
}

/** Attributes for a request-end log line (one per invocation; the basis of access logs). */
export function requestSummary(
  ctx: ExecutionContext,
  outcome: { status: number | string; durationMs: number; error?: unknown },
): LogAttributes {
  const fault =
    (typeof outcome.status === 'number' && outcome.status >= 500) || outcome.status === 'error';
  return {
    outcome: fault ? 'fault' : 'success',
    status: outcome.status,
    durationMs: Math.round(outcome.durationMs),
    deadlineRemainingMs: ctx.deadline.remainingMs(),
    ...(outcome.error instanceof Error ? { errorName: outcome.error.name } : {}),
  };
}
