import { Duration, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { show } from './diagram.js';
import type { EnvironmentConfig } from './environment.js';
import type { ServiceManifest } from './service-manifest.js';

export interface ObservableFunctionProps {
  readonly manifest: ServiceManifest;
  readonly config: EnvironmentConfig;
  /** Business operation name (e.g. CreateOrder); becomes PAAS_OPERATION and a metric dimension. */
  readonly operation: string;
  /** Absolute path to the TypeScript entry file. */
  readonly entry: string;
  readonly handler?: string;
  readonly memorySize?: number;
  readonly timeout?: Duration;
  /**
   * Reserved concurrency: protects critical functions from account-wide exhaustion and caps
   * the blast radius on downstream datastores (guideline §10, §11). Leave undefined for
   * unreserved.
   */
  readonly reservedConcurrentExecutions?: number;
  readonly environment?: Record<string, string>;
  readonly alarmTopic?: sns.ITopic;
  /** p99 duration threshold; defaults to the manifest SLO latency budget. */
  readonly p99LatencyAlarmMs?: number;
  readonly errorAlarmThreshold?: number;
  /** Monorepo root used by esbuild bundling (defaults to process.cwd()). */
  readonly projectRoot?: string;
  readonly depsLockFilePath?: string;
}

/**
 * Lambda function with the platform paved road applied (guideline §17 "共通Constructが自動付与する
 * もの"): arm64 zip via esbuild, X-Ray tracing, dedicated log group with retention, Powertools
 * environment, least-privilege execution role (no AWS managed policies), alias + progressive
 * deployment, and standard alarms.
 */
export class ObservableFunction extends Construct {
  readonly fn: NodejsFunction;
  readonly alias: lambda.Alias;
  readonly logGroup: logs.LogGroup;
  readonly role: iam.Role;
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: ObservableFunctionProps) {
    super(scope, id);
    const { manifest, config } = props;
    const stack = Stack.of(this);

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: config.logRetention,
      removalPolicy: config.removalPolicy,
    });

    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `${manifest.serviceId}/${props.operation} execution role (least privilege)`,
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteOwnLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [this.logGroup.logGroupArn, `${this.logGroup.logGroupArn}:*`],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'XRay',
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        resources: ['*'], // X-Ray does not support resource-level permissions.
      }),
    );

    const architecture =
      manifest.runtimeProfile === 'event-zip-x86'
        ? lambda.Architecture.X86_64
        : lambda.Architecture.ARM_64;

    this.fn = new NodejsFunction(this, 'Function', {
      entry: props.entry,
      handler: props.handler ?? 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture,
      memorySize: props.memorySize ?? 512,
      timeout: props.timeout ?? Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: this.logGroup,
      role: this.role,
      ...(props.reservedConcurrentExecutions !== undefined
        ? { reservedConcurrentExecutions: props.reservedConcurrentExecutions }
        : {}),
      ...(props.projectRoot ? { projectRoot: props.projectRoot } : {}),
      ...(props.depsLockFilePath ? { depsLockFilePath: props.depsLockFilePath } : {}),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: manifest.serviceId,
        POWERTOOLS_LOG_LEVEL: config.logLevel,
        POWERTOOLS_LOGGER_SAMPLE_RATE: String(config.debugSampleRate),
        POWERTOOLS_METRICS_NAMESPACE: 'PaaS',
        POWERTOOLS_TRACE_DISABLED: 'false',
        PAAS_CELL_ID: config.cellId,
        PAAS_ENVIRONMENT: config.name,
        PAAS_OPERATION: props.operation,
        PAAS_SERVICE_ID: manifest.serviceId,
        ...(config.applicationSignalsLayerArn
          ? { AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument' }
          : {}),
        ...(props.environment ?? {}),
      },
      ...(config.applicationSignalsLayerArn
        ? {
            layers: [
              lambda.LayerVersion.fromLayerVersionArn(
                this,
                'AppSignalsLayer',
                config.applicationSignalsLayerArn,
              ),
            ],
          }
        : {}),
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        sourcesContent: false,
        mainFields: ['module', 'main'],
        // Bundle the AWS SDK so the version is pinned by pnpm-lock, not by the runtime image.
        externalModules: [],
        banner:
          "import { createRequire as __paasCreateRequire } from 'node:module'; const require = __paasCreateRequire(import.meta.url);",
        metafile: true,
      },
      description: `${manifest.serviceId} ${props.operation} (owner: ${manifest.ownerTeam})`,
    });

    this.alias = new lambda.Alias(this, 'Live', {
      aliasName: 'live',
      version: this.fn.currentVersion,
    });

    // Alarms (guideline §19: throttles, errors, latency p99 against the SLO budget).
    const period = Duration.minutes(1);
    const errorAlarm = new cloudwatch.Alarm(this, 'ErrorsAlarm', {
      alarmDescription: `${manifest.serviceId}/${props.operation}: invocation errors (runbook: ${manifest.runbook})`,
      metric: this.fn.metricErrors({ period, statistic: 'sum' }),
      threshold: props.errorAlarmThreshold ?? 5,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const throttleAlarm = new cloudwatch.Alarm(this, 'ThrottlesAlarm', {
      alarmDescription: `${manifest.serviceId}/${props.operation}: throttled invocations (concurrency budget exhausted; runbook docs/runbooks/lambda-concurrency-throttling.md)`,
      metric: this.fn.metricThrottles({ period, statistic: 'sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const p99Alarm = new cloudwatch.Alarm(this, 'DurationP99Alarm', {
      alarmDescription: `${manifest.serviceId}/${props.operation}: p99 duration above budget`,
      metric: this.fn.metricDuration({ period: Duration.minutes(5), statistic: 'p99' }),
      threshold: props.p99LatencyAlarmMs ?? manifest.slo.latencyP99Ms,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.alarms.push(errorAlarm, throttleAlarm, p99Alarm);
    if (props.alarmTopic) {
      for (const alarm of this.alarms)
        alarm.addAlarmAction(new actions.SnsAction(props.alarmTopic));
    }

    // Progressive delivery (ADR-0020): traffic shifting on the alias, rolled back by the alarms.
    if (config.deploymentStrategy !== 'all-at-once') {
      const deploymentGroup = new codedeploy.LambdaDeploymentGroup(this, 'DeploymentGroup', {
        alias: this.alias,
        deploymentConfig:
          config.deploymentStrategy === 'canary-10-percent-5-minutes'
            ? codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES
            : codedeploy.LambdaDeploymentConfig.LINEAR_10PERCENT_EVERY_1MINUTE,
        alarms: [errorAlarm, p99Alarm],
      });
      // The CodeDeploy service role is AWS-managed by design (traffic shifting on the alias only).
      NagSuppressions.addResourceSuppressions(
        deploymentGroup,
        [
          {
            id: 'AwsSolutions-IAM4',
            reason:
              'CodeDeploy Lambda traffic shifting requires AWSCodeDeployRoleForLambdaLimited; scope is limited to alias updates.',
            appliesTo: [
              'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSCodeDeployRoleForLambdaLimited',
            ],
          },
        ],
        true,
      );
    }

    this.fn.node.addMetadata('paas:operation', props.operation);
    show(this.fn, `${manifest.serviceId}\n${props.operation}`);
    void stack;
  }

  /** Dimension-safe reference for dashboards. */
  get functionName(): string {
    return this.fn.functionName;
  }
}
