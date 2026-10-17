import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  EventSubscription,
  IdempotencyTable,
  PavedQueueConsumer,
  ServiceObservability,
  ServiceStack,
  connection,
  loadServiceManifest,
  type ServiceStackProps,
} from '@paas/constructs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => resolve(here, '../src', p);

export const workerServiceManifest = loadServiceManifest(resolve(here, '../service.yaml'));

/**
 * Fulfillment worker: one queue + consumer per tenant tier so a burst from standard tenants can
 * never starve premium/enterprise tenants (guideline §5 noisy neighbour, §11 "ワークロード別の
 * 同時実行制限"). Both consumers run the same handler; only routing and concurrency differ.
 */
export class WorkerServiceStack extends ServiceStack {
  readonly consumers: PavedQueueConsumer[] = [];

  constructor(scope: Construct, id: string, props: Omit<ServiceStackProps, 'manifest'>) {
    super(scope, id, { ...props, manifest: workerServiceManifest });
    const { manifest, config, platform } = this;
    const defaults = this.functionDefaults();

    const idempotency = new IdempotencyTable(this, 'Idempotency', { manifest, config });
    const env = {
      IDEMPOTENCY_TABLE_NAME: idempotency.table.tableName,
      EVENT_BUS_NAME: platform.eventBus.eventBusName,
    };

    const tiers: { name: string; tenantTiers: string[]; maxConcurrency: number }[] = [
      { name: 'Standard', tenantTiers: ['standard'], maxConcurrency: config.isProduction ? 20 : 2 },
      {
        name: 'Premium',
        tenantTiers: ['premium', 'enterprise'],
        maxConcurrency: config.isProduction ? 50 : 5,
      },
    ];

    for (const tier of tiers) {
      const consumer = new PavedQueueConsumer(this, `Fulfill${tier.name}`, {
        manifest,
        config,
        operation: `FulfillOrder${tier.name}`,
        entry: src('entrypoints/queue/fulfill-order.ts'),
        maxConcurrency: tier.maxConcurrency,
        batchSize: 10,
        timeout: Duration.seconds(30),
        maxReceiveCount: 5,
        maxMessageAge: Duration.minutes(tier.name === 'Premium' ? 2 : 10),
        environment: env,
        alarmTopic: platform.alarmTopic,
        functionDefaults: defaults,
      });
      idempotency.grant(consumer.consumer.fn);
      platform.eventBus.grantPutEventsTo(consumer.consumer.fn);
      connection(
        consumer.consumer.fn,
        platform.eventBus,
        'order.fulfilled.v1 / fulfillment-failed.v1',
      );
      new EventSubscription(this, `Subscribe${tier.name}`, {
        manifest,
        eventBus: platform.eventBus,
        eventTypes: ['order.created.v1'],
        tenantTiers: tier.tenantTiers,
        target: { queue: consumer.queue },
        alarmTopic: platform.alarmTopic,
      });
      this.consumers.push(consumer);
    }

    new ServiceObservability(this, 'Observability', {
      manifest,
      config,
      consumers: this.consumers,
      alarmTopic: platform.alarmTopic,
    });
  }
}
