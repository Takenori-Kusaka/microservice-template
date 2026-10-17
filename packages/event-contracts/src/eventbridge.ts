import type { EventBridgeEvent, SQSRecord } from 'aws-lambda';
import type { EventEnvelope } from './envelope.js';
import type { EventRegistry } from './registry.js';

/** EventBridge PutEvents entry shape (subset of @aws-sdk/client-eventbridge PutEventsRequestEntry). */
export interface PutEventsEntry {
  EventBusName: string;
  Source: string;
  DetailType: string;
  Detail: string;
  Time?: Date;
  TraceHeader?: string;
  Resources?: string[];
}

/**
 * Maps the envelope to EventBridge: `detail-type` = event type, `source` = producer service,
 * `detail` = the full envelope (so consumers always get tenant + correlation metadata even when
 * EventBridge archive/replay drops the X-Ray trace header).
 */
export function toPutEventsEntry(
  envelope: EventEnvelope,
  busName: string,
  options: { traceHeader?: string } = {},
): PutEventsEntry {
  return {
    EventBusName: busName,
    Source: envelope.source,
    DetailType: envelope.type,
    Detail: JSON.stringify(envelope),
    Time: new Date(envelope.time),
    ...(options.traceHeader ? { TraceHeader: options.traceHeader } : {}),
  };
}

/** EventBridge event pattern for a rule that subscribes to the given event types. */
export function eventPattern(
  types: string[],
  options: { tenantTier?: string[] } = {},
): Record<string, unknown> {
  return {
    'detail-type': types,
    ...(options.tenantTier ? { detail: { tenantTier: options.tenantTier } } : {}),
  };
}

export function fromEventBridgeEvent(
  registry: EventRegistry,
  event: EventBridgeEvent<string, unknown>,
): EventEnvelope {
  return registry.parse(event.detail);
}

/**
 * SQS record produced by an EventBridge → SQS target. The body is the EventBridge event JSON;
 * the envelope is in `detail`. Direct SQS producers (same service) put the envelope in the body.
 */
export function fromSqsRecord(
  registry: EventRegistry,
  record: Pick<SQSRecord, 'body'>,
): EventEnvelope {
  const body: unknown = JSON.parse(record.body);
  if (typeof body === 'object' && body !== null && 'detail' in body && 'detail-type' in body) {
    return registry.parse((body as { detail: unknown }).detail);
  }
  return registry.parse(body);
}
