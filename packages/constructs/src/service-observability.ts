import { Duration, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import type { EnvironmentConfig } from './environment.js';
import type { ObservableFunction } from './observable-function.js';
import type { PavedApiService } from './paved-api-service.js';
import type { PavedQueueConsumer } from './paved-queue-consumer.js';
import type { PavedWorkflow } from './paved-workflow.js';
import type { ServiceManifest } from './service-manifest.js';

export interface ServiceObservabilityProps {
  readonly manifest: ServiceManifest;
  readonly config: EnvironmentConfig;
  readonly apis?: PavedApiService[];
  readonly functions?: ObservableFunction[];
  readonly consumers?: PavedQueueConsumer[];
  readonly workflows?: PavedWorkflow[];
  readonly alarmTopic?: sns.ITopic;
}

/**
 * One dashboard + one composite "customer impact" alarm per service (guideline §19 運用:
 * "alarmは原因候補ではなく顧客影響に近いSLIを上位に置く"). Widgets are grouped by SLI
 * (availability, latency, backlog age, concurrency) so on-call reads impact first, causes second.
 */
export class ServiceObservability extends Construct {
  readonly dashboard: cloudwatch.Dashboard;
  readonly customerImpactAlarm?: cloudwatch.CompositeAlarm;

  constructor(scope: Construct, id: string, props: ServiceObservabilityProps) {
    super(scope, id);
    const { manifest, config } = props;
    const region = Stack.of(this).region;

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${manifest.serviceId}-${config.name}-${config.cellId}`,
      defaultInterval: Duration.hours(3),
    });

    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: [
          `# ${manifest.serviceId} (${config.name} / ${config.cellId})`,
          `owner: **${manifest.ownerTeam}** · on-call: **${manifest.onCall}** · SLO: availability ${manifest.slo.availability}% / p99 ${manifest.slo.latencyP99Ms} ms (${manifest.slo.window})`,
          `runbook: ${manifest.runbook} · threat model: ${manifest.threatModel} · ADRs: ${manifest.adrs.join(', ')}`,
        ].join('\n\n'),
        width: 24,
        height: 3,
      }),
    );

    for (const api of props.apis ?? []) {
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'API availability (requests vs 5xx / 4xx)',
          left: [api.api.metricCount({ period: Duration.minutes(1), statistic: 'sum' })],
          right: [
            api.api.metricServerError({
              period: Duration.minutes(1),
              statistic: 'sum',
              color: cloudwatch.Color.RED,
            }),
            api.api.metricClientError({
              period: Duration.minutes(1),
              statistic: 'sum',
              color: cloudwatch.Color.ORANGE,
            }),
          ],
          width: 12,
        }),
        new cloudwatch.GraphWidget({
          title: `API latency (p50 / p95 / p99, SLO ${manifest.slo.latencyP99Ms} ms)`,
          left: [
            api.api.metricLatency({ period: Duration.minutes(1), statistic: 'p50' }),
            api.api.metricLatency({ period: Duration.minutes(1), statistic: 'p95' }),
            api.api.metricLatency({ period: Duration.minutes(1), statistic: 'p99' }),
          ],
          leftAnnotations: [
            { value: manifest.slo.latencyP99Ms, label: 'p99 SLO', color: cloudwatch.Color.RED },
          ],
          width: 12,
        }),
      );
    }

    const functions = [
      ...(props.functions ?? []),
      ...(props.apis ?? []).flatMap((a) => [...a.functions.values()]),
      ...(props.consumers ?? []).map((c) => c.consumer),
    ];
    if (functions.length > 0) {
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Lambda concurrency & throttles',
          left: functions.map((f) =>
            f.fn.metric('ConcurrentExecutions', { period: Duration.minutes(1), statistic: 'max' }),
          ),
          right: functions.map((f) =>
            f.fn.metricThrottles({ period: Duration.minutes(1), statistic: 'sum' }),
          ),
          width: 12,
        }),
        new cloudwatch.GraphWidget({
          title: 'Lambda errors & p99 duration',
          left: functions.map((f) =>
            f.fn.metricErrors({ period: Duration.minutes(1), statistic: 'sum' }),
          ),
          right: functions.map((f) =>
            f.fn.metricDuration({ period: Duration.minutes(1), statistic: 'p99' }),
          ),
          width: 12,
        }),
      );
    }

    for (const consumer of props.consumers ?? []) {
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `Queue backlog & age (${consumer.node.id})`,
          left: [
            consumer.queue.metricApproximateNumberOfMessagesVisible({
              period: Duration.minutes(1),
              statistic: 'max',
            }),
          ],
          right: [
            consumer.queue.metricApproximateAgeOfOldestMessage({
              period: Duration.minutes(1),
              statistic: 'max',
            }),
          ],
          width: 12,
        }),
        new cloudwatch.SingleValueWidget({
          title: `DLQ depth (${consumer.node.id})`,
          metrics: [
            consumer.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
              period: Duration.minutes(1),
              statistic: 'max',
            }),
          ],
          width: 12,
        }),
      );
    }

    for (const workflow of props.workflows ?? []) {
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `Workflow executions (${workflow.node.id})`,
          left: [
            workflow.stateMachine.metricStarted({ period: Duration.minutes(5), statistic: 'sum' }),
            workflow.stateMachine.metricSucceeded({
              period: Duration.minutes(5),
              statistic: 'sum',
            }),
            workflow.stateMachine.metricFailed({
              period: Duration.minutes(5),
              statistic: 'sum',
              color: cloudwatch.Color.RED,
            }),
          ],
          right: [
            workflow.stateMachine.metricTime({ period: Duration.minutes(5), statistic: 'p99' }),
          ],
          width: 24,
        }),
      );
    }

    // Composite alarm: customer-impact SLIs only (API faults/latency, queue age, workflow failures).
    const impactAlarms: cloudwatch.IAlarm[] = [
      ...(props.apis ?? []).flatMap((a) => a.alarms),
      ...(props.consumers ?? []).flatMap((c) => c.alarms),
      ...(props.workflows ?? []).flatMap((w) => w.alarms),
    ];
    if (impactAlarms.length > 0) {
      this.customerImpactAlarm = new cloudwatch.CompositeAlarm(this, 'CustomerImpact', {
        compositeAlarmName: `${manifest.serviceId}-${config.name}-${config.cellId}-customer-impact`,
        alarmDescription: `${manifest.serviceId}: customer-impacting SLI breach. On-call: ${manifest.onCall}. Runbook: ${manifest.runbook}`,
        alarmRule: cloudwatch.AlarmRule.anyOf(...impactAlarms),
      });
      if (props.alarmTopic)
        this.customerImpactAlarm.addAlarmAction(new actions.SnsAction(props.alarmTopic));
    }

    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `Deployment markers: filter logs by \`deploymentVersion\`. Region: ${region}. Per-tenant drill-down: CloudWatch Logs Insights \`filter tenantId = "<id>" | stats count() by operation, outcome\`.`,
        width: 24,
        height: 2,
      }),
    );
  }
}
