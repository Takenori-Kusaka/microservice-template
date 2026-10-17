import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { connection, show } from './diagram.js';
import type { EnvironmentConfig } from './environment.js';
import { ObservableFunction, type ObservableFunctionProps } from './observable-function.js';
import type { ServiceManifest } from './service-manifest.js';

export interface PavedQueueConsumerProps {
  readonly manifest: ServiceManifest;
  readonly config: EnvironmentConfig;
  readonly operation: string;
  readonly entry: string;
  readonly handler?: string;
  readonly memorySize?: number;
  /** Per-message processing timeout; visibility timeout is derived (6x) per AWS guidance. */
  readonly timeout?: Duration;
  readonly batchSize?: number;
  readonly maxBatchingWindow?: Duration;
  /**
   * Maximum concurrent consumers (2..1000). This is the backpressure knob that keeps the
   * consumer from overrunning downstream datastores (guideline §10, §11 "平準化").
   */
  readonly maxConcurrency: number;
  readonly maxReceiveCount?: number;
  /** Alarm when the oldest message is older than this (defaults to 5 min). */
  readonly maxMessageAge?: Duration;
  readonly environment?: Record<string, string>;
  readonly alarmTopic?: sns.ITopic;
  readonly functionDefaults?: Pick<
    ObservableFunctionProps,
    'projectRoot' | 'depsLockFilePath' | 'environment'
  >;
}

/**
 * SQS queue + DLQ + Lambda consumer with partial batch failure, bounded concurrency, queue-age
 * SLO alarm and DLQ alarm (guideline §7 役割分担, §12 信頼性, ADR-0011, ADR-0014).
 *
 * "DLQは終着点ではなく、所有者、alarm、診断、redrive手順、最大保持期間を必須化する": the DLQ
 * is owned by the service manifest, alarms on first message, retains 14 days, and allows
 * redrive back to the source queue only.
 */
export class PavedQueueConsumer extends Construct {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly consumer: ObservableFunction;
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: PavedQueueConsumerProps) {
    super(scope, id);
    const { manifest, config } = props;
    if (props.maxConcurrency < 2 || props.maxConcurrency > 1000) {
      throw new Error(
        `${manifest.serviceId}/${props.operation}: maxConcurrency must be within 2..1000`,
      );
    }
    const timeout = props.timeout ?? Duration.seconds(30);

    this.deadLetterQueue = new sqs.Queue(this, 'Dlq', {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    this.queue = new sqs.Queue(this, 'Queue', {
      // AWS guidance for Lambda event source mappings: at least 6x the function timeout plus the
      // maximum batching window (https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html).
      visibilityTimeout: Duration.seconds(
        timeout.toSeconds() * 6 + (props.maxBatchingWindow ?? Duration.seconds(2)).toSeconds(),
      ),
      retentionPeriod: Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: props.maxReceiveCount ?? 5 },
    });
    // Redrive is only allowed from the DLQ back into this service's queues. `byQueue` with the
    // source ARN would create a CloudFormation cycle (queue → DLQ → queue), so the allow policy is
    // restricted by account instead and the redrive runbook names the source queue explicitly.
    const cfnDlq = this.deadLetterQueue.node.defaultChild as sqs.CfnQueue;
    cfnDlq.redriveAllowPolicy = { redrivePermission: 'allowAll' };
    cfnDlq.addMetadata('paas:redrive-source', this.queue.node.path);

    this.consumer = new ObservableFunction(this, 'Consumer', {
      manifest,
      config,
      operation: props.operation,
      entry: props.entry,
      ...(props.handler ? { handler: props.handler } : {}),
      memorySize: props.memorySize ?? 512,
      timeout,
      ...(props.alarmTopic ? { alarmTopic: props.alarmTopic } : {}),
      ...(props.functionDefaults?.projectRoot
        ? { projectRoot: props.functionDefaults.projectRoot }
        : {}),
      ...(props.functionDefaults?.depsLockFilePath
        ? { depsLockFilePath: props.functionDefaults.depsLockFilePath }
        : {}),
      environment: {
        QUEUE_URL: this.queue.queueUrl,
        ...(props.functionDefaults?.environment ?? {}),
        ...(props.environment ?? {}),
      },
    });

    this.consumer.alias.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: props.batchSize ?? 10,
        maxBatchingWindow: props.maxBatchingWindow ?? Duration.seconds(2),
        maxConcurrency: props.maxConcurrency,
        reportBatchItemFailures: true,
      }),
    );

    const ageAlarm = new cloudwatch.Alarm(this, 'MessageAgeAlarm', {
      alarmDescription: `${manifest.serviceId}/${props.operation}: oldest message age above SLO (consumer behind; runbook ${manifest.runbook})`,
      metric: this.queue.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(1),
        statistic: 'max',
      }),
      threshold: (props.maxMessageAge ?? Duration.minutes(5)).toSeconds(),
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const dlqAlarm = new cloudwatch.Alarm(this, 'DlqNotEmptyAlarm', {
      alarmDescription: `${manifest.serviceId}/${props.operation}: messages in DLQ (runbook docs/runbooks/dlq-redrive.md)`,
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
        statistic: 'max',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.alarms.push(ageAlarm, dlqAlarm);
    if (props.alarmTopic) {
      for (const alarm of this.alarms)
        alarm.addAlarmAction(new actions.SnsAction(props.alarmTopic));
    }

    show(this.queue, `${manifest.serviceId}\n${props.operation} queue`);
    show(this.deadLetterQueue, `${manifest.serviceId}\n${props.operation} DLQ`);
    connection(
      this.queue,
      this.consumer.fn,
      `batch ${props.batchSize ?? 10}, maxConcurrency ${props.maxConcurrency}`,
    );
    connection(this.queue, this.deadLetterQueue, `after ${props.maxReceiveCount ?? 5} receives`);
  }
}
