import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import {
  EventSubscription,
  IdempotencyTable,
  ObservableFunction,
  PavedApiService,
  PavedQueueConsumer,
  ServiceObservability,
  ServiceStack,
  TenantAwareTable,
  connection,
  loadServiceManifest,
  type ServiceStackProps,
} from '@paas/constructs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => resolve(here, '../src', p);

export const orderServiceManifest = loadServiceManifest(resolve(here, '../service.yaml'));

/**
 * Order service stack: HTTP API (3 routes) + tenant-partitioned table + idempotency table +
 * outbox relay (Streams → EventBridge) + consumer of fulfillment outcome events.
 */
export class OrderServiceStack extends ServiceStack {
  readonly api: PavedApiService;
  readonly table: TenantAwareTable;

  constructor(scope: Construct, id: string, props: Omit<ServiceStackProps, 'manifest'>) {
    super(scope, id, { ...props, manifest: orderServiceManifest });
    const { manifest, config, platform } = this;
    const defaults = this.functionDefaults();

    this.table = new TenantAwareTable(this, 'Orders', {
      manifest,
      config,
      stream: true,
      timeToLiveAttribute: 'expiresAt',
    });
    const idempotency = new IdempotencyTable(this, 'Idempotency', { manifest, config });

    const env = {
      ORDERS_TABLE_NAME: this.table.table.tableName,
      IDEMPOTENCY_TABLE_NAME: idempotency.table.tableName,
      EVENT_BUS_NAME: platform.eventBus.eventBusName,
    };

    this.api = new PavedApiService(this, 'Api', {
      manifest,
      config,
      alarmTopic: platform.alarmTopic,
      functionDefaults: { ...defaults, environment: env },
      routes: [
        {
          method: 'POST',
          path: '/orders',
          operation: 'CreateOrder',
          entry: src('entrypoints/http/create-order.ts'),
          memorySize: 1024,
          timeout: Duration.seconds(10),
          // Critical write path: protected from worker bursts by a reserved budget (§10, §11).
          // Sandbox accounts start with a reduced concurrency quota (new accounts: 10), so the
          // reservation is production-only; Lambda refuses reservations that leave < 10 unreserved.
          ...(config.isProduction ? { reservedConcurrentExecutions: 100 } : {}),
        },
        {
          method: 'GET',
          path: '/orders/{orderId}',
          operation: 'GetOrder',
          entry: src('entrypoints/http/get-order.ts'),
          memorySize: 512,
          timeout: Duration.seconds(5),
        },
        {
          method: 'GET',
          path: '/orders',
          operation: 'ListOrders',
          entry: src('entrypoints/http/list-orders.ts'),
          memorySize: 512,
          timeout: Duration.seconds(5),
        },
      ],
    });
    for (const fn of this.api.functions.values()) {
      this.table.grantReadWriteData(fn.fn);
      idempotency.grant(fn.fn);
      connection(fn.fn, this.table.table);
    }

    // Outbox relay: DynamoDB Streams (filtered to OUTBOX inserts) → EventBridge.
    const relayDlq = new sqs.Queue(this, 'OutboxRelayDlq', {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    const relay = new ObservableFunction(this, 'OutboxRelay', {
      manifest,
      config,
      operation: 'OutboxRelay',
      entry: src('entrypoints/stream/outbox-relay.ts'),
      timeout: Duration.seconds(20),
      environment: env,
      alarmTopic: platform.alarmTopic,
      ...defaults,
    });
    relay.alias.addEventSource(
      new DynamoEventSource(this.table.table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        bisectBatchOnError: true,
        retryAttempts: 10,
        maxRecordAge: Duration.hours(24),
        reportBatchItemFailures: true,
        onFailure: new SqsDlq(relayDlq),
        filters: [
          // FilterRule helpers are typed as `any` by aws-cdk-lib.
          /* eslint-disable @typescript-eslint/no-unsafe-assignment */
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('INSERT'),
            dynamodb: { NewImage: { entityType: { S: lambda.FilterRule.isEqual('OUTBOX') } } },
          }),
          /* eslint-enable @typescript-eslint/no-unsafe-assignment */
        ],
      }),
    );
    this.table.grantReadWriteData(relay.fn);
    this.table.grantStreamRead(relay.fn);
    platform.eventBus.grantPutEventsTo(relay.fn);
    connection(this.table.table, relay.fn, 'Streams (OUTBOX inserts)');
    connection(relay.fn, platform.eventBus, 'order.created.v1');

    // Consume fulfillment outcomes published by the worker service.
    const outcomes = new PavedQueueConsumer(this, 'FulfillmentOutcomes', {
      manifest,
      config,
      operation: 'ApplyFulfillmentOutcome',
      entry: src('entrypoints/queue/apply-fulfillment-outcome.ts'),
      maxConcurrency: 5,
      timeout: Duration.seconds(20),
      environment: env,
      alarmTopic: platform.alarmTopic,
      functionDefaults: defaults,
    });
    this.table.grantReadWriteData(outcomes.consumer.fn);
    new EventSubscription(this, 'OutcomeSubscription', {
      manifest,
      eventBus: platform.eventBus,
      eventTypes: ['order.fulfilled.v1', 'order.fulfillment-failed.v1'],
      target: { queue: outcomes.queue },
      alarmTopic: platform.alarmTopic,
    });

    new ServiceObservability(this, 'Observability', {
      manifest,
      config,
      apis: [this.api],
      functions: [relay],
      consumers: [outcomes],
      alarmTopic: platform.alarmTopic,
    });
  }
}
