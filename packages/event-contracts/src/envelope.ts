import { z } from 'zod';
import {
  newId,
  SAFE_TOKEN_PATTERN,
  TENANT_ID_PATTERN,
  TENANT_TIERS,
  type ExecutionContext,
} from '@paas/runtime-context';

/**
 * Event envelope (guideline §7 イベント包絡, ADR-0013). CloudEvents 1.0 attribute names are
 * used for the core fields; `tenantId`, `tenantTier`, `correlationId`, `causationId` are
 * platform extensions and are REQUIRED on every event so traceability never depends on sampled
 * traces.
 */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+\.v[1-9][0-9]*$/;

export const EventEnvelopeSchema = z.object({
  specversion: z.literal('1.0'),
  id: z.string().regex(SAFE_TOKEN_PATTERN),
  type: z.string().regex(EVENT_TYPE_PATTERN),
  source: z.string().min(1).max(128),
  time: z.iso.datetime(),
  tenantId: z.string().regex(TENANT_ID_PATTERN),
  tenantTier: z.enum(TENANT_TIERS),
  correlationId: z.string().regex(SAFE_TOKEN_PATTERN),
  causationId: z.string().regex(SAFE_TOKEN_PATTERN).optional(),
  subject: z.string().max(256).optional(),
  datacontenttype: z.literal('application/json'),
  /** Absolute epoch-ms deadline for time-bounded flows (optional). */
  deadlineAtMs: z.number().int().positive().optional(),
  data: z.unknown(),
});

export type EventEnvelope<TData = unknown> = Omit<z.infer<typeof EventEnvelopeSchema>, 'data'> & {
  data: TData;
};

export interface EventDefinition<TType extends string, TData> {
  readonly type: TType;
  readonly dataSchema: z.ZodType<TData>;
  readonly description: string;
  /** Producer service id (the only service allowed to publish this type). */
  readonly source: string;
}

export function defineEvent<TType extends string, TData>(
  definition: EventDefinition<TType, TData>,
): EventDefinition<TType, TData> {
  if (!EVENT_TYPE_PATTERN.test(definition.type)) {
    throw new Error(`invalid event type: ${definition.type}`);
  }
  return definition;
}

export interface CreateEventInput<TData> {
  data: TData;
  subject?: string;
  /** Explicit causation; defaults to the context requestId. */
  causationId?: string;
  propagateDeadline?: boolean;
  now?: Date;
}

/**
 * Builds an envelope from the ambient ExecutionContext. Tenant and correlation come from the
 * verified context, never from the payload: a service cannot emit events for a tenant it is not
 * acting on behalf of.
 */
export function createEvent<TType extends string, TData>(
  definition: EventDefinition<TType, TData>,
  ctx: ExecutionContext,
  input: CreateEventInput<TData>,
): EventEnvelope<TData> & { type: TType } {
  const data = definition.dataSchema.parse(input.data);
  const envelope = {
    specversion: '1.0' as const,
    id: newId(),
    type: definition.type,
    source: definition.source,
    time: (input.now ?? new Date()).toISOString(),
    tenantId: ctx.tenantId,
    tenantTier: ctx.tenantTier,
    correlationId: ctx.correlationId,
    causationId: input.causationId ?? ctx.requestId,
    ...(input.subject ? { subject: input.subject } : {}),
    datacontenttype: 'application/json' as const,
    ...(input.propagateDeadline ? { deadlineAtMs: ctx.deadline.deadlineAtMs } : {}),
    data,
  };
  EventEnvelopeSchema.parse(envelope);
  return envelope;
}

export class EventValidationError extends Error {
  readonly code = 'EVENT_VALIDATION_FAILED';
  readonly retryable = false;
  constructor(
    readonly eventType: string | undefined,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(
      `event validation failed for ${eventType ?? '<unknown>'}: ${issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`,
    );
    this.name = 'EventValidationError';
  }
}
