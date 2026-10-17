import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { connection, show } from './diagram.js';
import type { ServiceManifest } from './service-manifest.js';

export interface EventSubscriptionProps {
  readonly manifest: ServiceManifest;
  readonly eventBus: events.IEventBus;
  /** Event types (detail-type) to subscribe to. Must be listed in manifest.consumedEvents. */
  readonly eventTypes: string[];
  /** Optional tenant-tier filter (detail.tenantTier). */
  readonly tenantTiers?: string[];
  readonly target: { queue: sqs.IQueue } | { stateMachine: sfn.IStateMachine };
  readonly alarmTopic?: sns.ITopic;
}

/**
 * EventBridge rule → SQS or Step Functions target with a rule-level DLQ (guideline §7:
 * EventBridge for cross-service events, SQS for buffering). The subscription validates that the
 * service declared the consumed events in its manifest so the dependency graph in service.yaml
 * is never stale.
 */
export class EventSubscription extends Construct {
  readonly rule: events.Rule;
  readonly ruleDeadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: EventSubscriptionProps) {
    super(scope, id);
    const { manifest } = props;
    const undeclared = props.eventTypes.filter((t) => !manifest.consumedEvents.includes(t));
    if (undeclared.length > 0) {
      throw new Error(
        `${manifest.serviceId}: subscribing to events not declared in service.yaml consumedEvents: ${undeclared.join(', ')}`,
      );
    }

    this.ruleDeadLetterQueue = new sqs.Queue(this, 'RuleDlq', {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    const detail: Record<string, unknown> = {};
    if (props.tenantTiers) detail['tenantTier'] = props.tenantTiers;

    const target =
      'queue' in props.target
        ? new targets.SqsQueue(props.target.queue, {
            deadLetterQueue: this.ruleDeadLetterQueue,
            retryAttempts: 185,
            maxEventAge: Duration.hours(24),
          })
        : new targets.SfnStateMachine(props.target.stateMachine, {
            deadLetterQueue: this.ruleDeadLetterQueue,
            retryAttempts: 185,
            maxEventAge: Duration.hours(24),
            input: events.RuleTargetInput.fromEventPath('$.detail'),
          });

    this.rule = new events.Rule(this, 'Rule', {
      eventBus: props.eventBus,
      description: `${manifest.serviceId} subscribes to ${props.eventTypes.join(', ')}`,
      eventPattern: {
        detailType: props.eventTypes,
        ...(Object.keys(detail).length > 0 ? { detail } : {}),
      },
      targets: [target],
    });

    const dlqAlarm = new cloudwatch.Alarm(this, 'RuleDlqAlarm', {
      alarmDescription: `${manifest.serviceId}: EventBridge could not deliver events (target throttled/unavailable)`,
      metric: this.ruleDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
        statistic: 'max',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (props.alarmTopic) dlqAlarm.addAlarmAction(new actions.SnsAction(props.alarmTopic));

    show(this.rule, props.eventTypes.join('\n'));
    const targetConstruct =
      'queue' in props.target ? props.target.queue : props.target.stateMachine;
    connection(props.eventBus, this.rule);
    connection(this.rule, targetConstruct);
  }
}
