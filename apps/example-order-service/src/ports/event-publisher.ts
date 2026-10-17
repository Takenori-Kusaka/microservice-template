import type { EventEnvelope } from '@paas/event-contracts';

export interface EventPublisher {
  publish(events: EventEnvelope[]): Promise<{ failed: { id: string; reason: string }[] }>;
}
