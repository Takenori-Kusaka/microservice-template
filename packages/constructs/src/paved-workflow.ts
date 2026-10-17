import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { show } from './diagram.js';
import type { EnvironmentConfig } from './environment.js';
import type { ServiceManifest } from './service-manifest.js';

export interface PavedWorkflowProps {
  readonly manifest: ServiceManifest;
  readonly config: EnvironmentConfig;
  readonly definition: sfn.IChainable;
  readonly workflowType?: sfn.StateMachineType;
  /** Whole-execution timeout: mandatory so a stuck saga never lives forever. */
  readonly timeout: Duration;
  readonly alarmTopic?: sns.ITopic;
  /** Alarm when p99 execution time exceeds this. */
  readonly p99ExecutionTime?: Duration;
}

/**
 * Standard retry preset for Lambda tasks inside workflows (guideline §12: transient only,
 * exponential backoff, full jitter, bounded attempts). Use with `task.addRetry(...)`.
 */
export const TRANSIENT_RETRY: sfn.RetryProps = {
  errors: [
    'Lambda.ServiceException',
    'Lambda.AWSLambdaException',
    'Lambda.SdkClientException',
    'Lambda.TooManyRequestsException',
    'RetryableError',
  ],
  interval: Duration.seconds(2),
  maxAttempts: 4,
  backoffRate: 2,
  jitterStrategy: sfn.JitterType.FULL,
  maxDelay: Duration.seconds(30),
};

/**
 * Step Functions state machine with logging, tracing, mandatory timeout and alarms
 * (guideline §8 Step Functionsの許容方針, ADR-0010). Execution data is NOT included in logs
 * by default (PII policy); enable per service after a data classification review.
 */
export class PavedWorkflow extends Construct {
  readonly stateMachine: sfn.StateMachine;
  readonly logGroup: logs.LogGroup;
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: PavedWorkflowProps) {
    super(scope, id);
    const { manifest, config } = props;

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: config.logRetention,
      removalPolicy: config.removalPolicy,
    });

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(props.definition),
      stateMachineType: props.workflowType ?? sfn.StateMachineType.STANDARD,
      timeout: props.timeout,
      tracingEnabled: true,
      logs: { destination: this.logGroup, level: sfn.LogLevel.ALL, includeExecutionData: false },
      comment: `${manifest.serviceId} workflow (owner: ${manifest.ownerTeam})`,
    });

    const period = Duration.minutes(5);
    const failed = new cloudwatch.Alarm(this, 'FailedAlarm', {
      alarmDescription: `${manifest.serviceId}: workflow executions failed (runbook ${manifest.runbook})`,
      metric: this.stateMachine.metricFailed({ period, statistic: 'sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const timedOut = new cloudwatch.Alarm(this, 'TimedOutAlarm', {
      alarmDescription: `${manifest.serviceId}: workflow executions timed out`,
      metric: this.stateMachine.metricTimedOut({ period, statistic: 'sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const slow = new cloudwatch.Alarm(this, 'ExecutionTimeP99Alarm', {
      alarmDescription: `${manifest.serviceId}: workflow p99 execution time above budget`,
      metric: this.stateMachine.metricTime({ period, statistic: 'p99' }),
      threshold: (props.p99ExecutionTime ?? Duration.minutes(5)).toMilliseconds(),
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.alarms.push(failed, timedOut, slow);
    if (props.alarmTopic) {
      for (const alarm of this.alarms)
        alarm.addAlarmAction(new actions.SnsAction(props.alarmTopic));
    }

    show(this.stateMachine, `${manifest.serviceId}\nworkflow`);
  }
}
