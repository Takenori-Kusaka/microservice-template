import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { toPutEventsEntry, type EventEnvelope } from '@paas/event-contracts';
import type { EventPublisher } from '../ports/event-publisher.js';

/** Publishes envelopes to the cell event bus, propagating the X-Ray trace header when present. */
export class EventBridgePublisher implements EventPublisher {
  constructor(
    private readonly client: EventBridgeClient,
    private readonly busName: string,
  ) {}

  async publish(events: EventEnvelope[]): Promise<{ failed: { id: string; reason: string }[] }> {
    const failed: { id: string; reason: string }[] = [];
    const traceHeader = process.env['_X_AMZN_TRACE_ID'];
    // PutEvents accepts at most 10 entries per call.
    for (let i = 0; i < events.length; i += 10) {
      const chunk = events.slice(i, i + 10);
      const res = await this.client.send(
        new PutEventsCommand({
          Entries: chunk.map((e) =>
            toPutEventsEntry(e, this.busName, traceHeader ? { traceHeader } : {}),
          ),
        }),
      );
      res.Entries?.forEach((entry, idx) => {
        if (entry.ErrorCode) {
          failed.push({
            id: chunk[idx]!.id,
            reason: `${entry.ErrorCode}: ${entry.ErrorMessage ?? ''}`,
          });
        }
      });
    }
    return { failed };
  }
}
