import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpJwtAuthorizer,
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { connection, show } from './diagram.js';
import type { EnvironmentConfig } from './environment.js';
import { ObservableFunction, type ObservableFunctionProps } from './observable-function.js';
import type { ServiceManifest } from './service-manifest.js';

export interface ApiRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly operation: string;
  readonly entry: string;
  readonly handler?: string;
  readonly memorySize?: number;
  readonly timeout?: Duration;
  readonly reservedConcurrentExecutions?: number;
  readonly environment?: Record<string, string>;
}

export interface PavedApiServiceProps {
  readonly manifest: ServiceManifest;
  readonly config: EnvironmentConfig;
  readonly routes: ApiRoute[];
  readonly alarmTopic?: sns.ITopic;
  /** Overrides the environment default throttle for this API. */
  readonly throttle?: { rateLimit: number; burstLimit: number };
  readonly functionDefaults?: Pick<
    ObservableFunctionProps,
    'projectRoot' | 'depsLockFilePath' | 'environment'
  >;
}

/**
 * API Gateway HTTP API + Lambda Event Functions (guideline §6 API層の標準, ADR-0005,
 * ADR-0006). Authentication at the gateway (JWT), business authorization in the service.
 * Adds: access logs (JSON, with requestId/correlationId), stage throttling, 5xx and
 * p99-latency alarms against the manifest SLO.
 */
export class PavedApiService extends Construct {
  readonly api: apigwv2.HttpApi;
  readonly stage: apigwv2.HttpStage;
  readonly functions: Map<string, ObservableFunction> = new Map();
  readonly accessLogGroup: logs.LogGroup;
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: PavedApiServiceProps) {
    super(scope, id);
    const { manifest, config } = props;

    if (manifest.runtimeProfile === 'experimental-web') {
      throw new Error(
        `${manifest.serviceId}: runtimeProfile=experimental-web is not served by PavedApiService. ` +
          'Lambda Web Functions are an experimental profile gated by ADR-0006; run the benchmark protocol in ' +
          'docs/decision/api-compute-selection.md and add a dedicated construct once CDK support is accepted.',
      );
    }

    const authorizer = this.createAuthorizer(props);

    this.api = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${manifest.serviceId}-${config.name}`,
      description: `${manifest.serviceId} (owner: ${manifest.ownerTeam})`,
      createDefaultStage: false,
      defaultAuthorizer: authorizer,
      disableExecuteApiEndpoint: false,
    });

    this.accessLogGroup = new logs.LogGroup(this, 'AccessLogs', {
      retention: config.logRetention,
      removalPolicy: config.removalPolicy,
    });

    const throttle = props.throttle ?? config.apiThrottle;
    this.stage = new apigwv2.HttpStage(this, 'Stage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: throttle.rateLimit, burstLimit: throttle.burstLimit },
      detailedMetricsEnabled: true,
    });
    const cfnStage = this.stage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: this.accessLogGroup.logGroupArn,
      // Every request is logged (not sampled) with the identifiers used for correlation (§14).
      // HTTP API has no $context.xrayTraceId (no API Gateway side X-Ray); the trace root is created by Lambda.
      format: JSON.stringify({
        requestId: '$context.requestId',
        correlationId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        routeKey: '$context.routeKey',
        status: '$context.status',
        responseLength: '$context.responseLength',
        integrationLatency: '$context.integrationLatency',
        responseLatency: '$context.responseLatency',
        integrationError: '$context.integrationErrorMessage',
        authorizerError: '$context.authorizer.error',
        tenantId: '$context.authorizer.tenantId',
        tenantTier: '$context.authorizer.tenantTier',
        userAgent: '$context.identity.userAgent',
      }),
    };

    for (const route of props.routes) {
      const fn = new ObservableFunction(this, `Fn${route.operation}`, {
        manifest,
        config,
        operation: route.operation,
        entry: route.entry,
        ...(route.handler ? { handler: route.handler } : {}),
        ...(route.memorySize !== undefined ? { memorySize: route.memorySize } : {}),
        ...(route.timeout ? { timeout: route.timeout } : {}),
        ...(route.reservedConcurrentExecutions !== undefined
          ? { reservedConcurrentExecutions: route.reservedConcurrentExecutions }
          : {}),
        ...(props.alarmTopic ? { alarmTopic: props.alarmTopic } : {}),
        ...(props.functionDefaults?.projectRoot
          ? { projectRoot: props.functionDefaults.projectRoot }
          : {}),
        ...(props.functionDefaults?.depsLockFilePath
          ? { depsLockFilePath: props.functionDefaults.depsLockFilePath }
          : {}),
        environment: {
          ...(props.functionDefaults?.environment ?? {}),
          ...(route.environment ?? {}),
        },
      });
      this.functions.set(route.operation, fn);
      this.api.addRoutes({
        path: route.path,
        methods: [apigwv2.HttpMethod[route.method]],
        integration: new HttpLambdaIntegration(`Int${route.operation}`, fn.alias, {
          timeout: route.timeout
            ? Duration.millis(Math.min(route.timeout.toMilliseconds() + 500, 30_000))
            : undefined,
        }),
      });
      connection(this.api, fn.fn, `${route.method} ${route.path}`);
    }

    // API-level alarms derived from the manifest SLO.
    const faultRate = new cloudwatch.MathExpression({
      expression: 'IF(requests > 0, 100 * errors / requests, 0)',
      usingMetrics: {
        errors: this.api.metricServerError({ period: Duration.minutes(5), statistic: 'sum' }),
        requests: this.api.metricCount({ period: Duration.minutes(5), statistic: 'sum' }),
      },
      label: '5xx %',
      period: Duration.minutes(5),
    });
    const availabilityBudgetPct = 100 - manifest.slo.availability;
    const faultAlarm = new cloudwatch.Alarm(this, 'FaultRateAlarm', {
      alarmDescription: `${manifest.serviceId} API 5xx rate above the availability budget (${availabilityBudgetPct}%)`,
      metric: faultRate,
      threshold: Math.max(availabilityBudgetPct * 10, 1), // burn-rate style: 10x the budget over 5 minutes
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const latencyAlarm = new cloudwatch.Alarm(this, 'LatencyP99Alarm', {
      alarmDescription: `${manifest.serviceId} API p99 latency above SLO (${manifest.slo.latencyP99Ms} ms)`,
      metric: this.api.metricLatency({ period: Duration.minutes(5), statistic: 'p99' }),
      threshold: manifest.slo.latencyP99Ms,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.alarms.push(faultAlarm, latencyAlarm);
    if (props.alarmTopic) {
      for (const alarm of this.alarms)
        alarm.addAlarmAction(new actions.SnsAction(props.alarmTopic));
    }

    show(this.api, `${manifest.serviceId}\nHTTP API`);
    new CfnOutput(this, 'ApiUrl', {
      value: this.stage.url,
      description: `${manifest.serviceId} base URL`,
    });
  }

  private createAuthorizer(props: PavedApiServiceProps): apigwv2.IHttpRouteAuthorizer {
    const { config, manifest } = props;
    if (config.auth.kind === 'jwt') {
      return new HttpJwtAuthorizer('JwtAuthorizer', config.auth.issuer, {
        jwtAudience: config.auth.audience,
        identitySource: ['$request.header.Authorization'],
      });
    }
    if (config.isProduction || config.name === 'staging') {
      throw new Error(
        `${manifest.serviceId}: the sandbox Lambda authorizer is forbidden in ${config.name}`,
      );
    }
    const fn = new ObservableFunction(this, 'SandboxAuthorizer', {
      manifest,
      config,
      operation: 'SandboxAuthorize',
      entry: fileURLToPath(new URL('./authorizers/sandbox-authorizer.handler.ts', import.meta.url)),
      memorySize: 256,
      timeout: Duration.seconds(3),
      ...(props.functionDefaults?.projectRoot
        ? { projectRoot: props.functionDefaults.projectRoot }
        : {}),
      ...(props.functionDefaults?.depsLockFilePath
        ? { depsLockFilePath: props.functionDefaults.depsLockFilePath }
        : {}),
    });
    fn.fn.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: Stack.of(this).formatArn({ service: 'execute-api', resource: '*' }),
    });
    return new HttpLambdaAuthorizer('SandboxLambdaAuthorizer', fn.alias, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.Authorization'],
      resultsCacheTtl: Duration.minutes(5),
    });
  }
}
