import type { Logger } from '@aws-lambda-powertools/logger';
import type { Metrics } from '@aws-lambda-powertools/metrics';
import type { Tracer } from '@aws-lambda-powertools/tracer';
import type { ExecutionContext } from '@paas/runtime-context';
import { createLogger, type LoggerPreset } from './logger.js';
import { bindMetricsDimensions, createMetrics } from './metrics.js';
import { annotateSegment, createTracer } from './tracer.js';

export interface Telemetry {
  logger: Logger;
  tracer: Tracer;
  metrics: Metrics;
  /** Binds the per-invocation context to the tracer segment and metric dimensions. */
  bind(ctx: ExecutionContext): void;
}

/**
 * One call per service module gives the three Powertools utilities with the platform presets.
 * Create it at module scope (reused across warm invocations); call `bind(ctx)` once per unit of
 * work.
 */
export function createTelemetry(preset: LoggerPreset): Telemetry {
  const logger = createLogger(preset);
  const tracer = createTracer(preset.serviceName);
  const metrics = createMetrics(preset.serviceName);
  return {
    logger,
    tracer,
    metrics,
    bind(ctx: ExecutionContext) {
      annotateSegment(tracer, ctx);
      bindMetricsDimensions(metrics, ctx);
    },
  };
}
