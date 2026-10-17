import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { toPutEventsEntry, type EventEnvelope } from '@paas/event-contracts';
import type { Publisher } from '../application/process-order-created.js';

export const eventBridgeClient: EventBridgeClient = new EventBridgeClient({
  maxAttempts: 3,
  retryMode: 'standard',
});

export class EventBridgePublisher implements Publisher {
  constructor(
    private readonly client: EventBridgeClient,
    private readonly busName: string,
  ) {}

  async publish(events: EventEnvelope[]): Promise<{ failed: { id: string; reason: string }[] }> {
    const traceHeader = process.env['_X_AMZN_TRACE_ID'];
    const res = await this.client.send(
      new PutEventsCommand({
        Entries: events.map((e) =>
          toPutEventsEntry(e, this.busName, traceHeader ? { traceHeader } : {}),
        ),
      }),
    );
    const failed: { id: string; reason: string }[] = [];
    res.Entries?.forEach((entry, idx) => {
      if (entry.ErrorCode)
        failed.push({
          id: events[idx]!.id,
          reason: `${entry.ErrorCode}: ${entry.ErrorMessage ?? ''}`,
        });
    });
    return { failed };
  }
}
