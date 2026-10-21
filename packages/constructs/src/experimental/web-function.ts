import { CfnOutput, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { show } from '../diagram.js';
import type { EnvironmentConfig } from '../environment.js';
import type { ServiceManifest } from '../service-manifest.js';

/**
 * EXPERIMENTAL — Lambda Web Function (announced 2026-10-12) built on the CloudFormation L1
 * resources shipped in aws-cdk-lib 2.273 (`AWS::Lambda::WebFunction`, `WebFunctionRevision`,
 * `WebFunctionEndpoint`). The L2 construct is still an open PR (aws/aws-cdk#39210), so this
 * construct exists only to run the ADR-0006 benchmark protocol in sandbox/staging.
 *
 * Facts this construct relies on (docs/decision/api-compute-selection.md, verified 2026-10-17):
 *  - the app must listen on the host:port given by `AWS_LAMBDA_HTTP_ENDPOINT` within 10 s;
 *  - runtime `nodejs24.x`, arm64 only, zip only, 2 vCPU / 2 GB fixed environment;
 *  - `maxConcurrencyPerEnvironment` 1..128 (default 64), request timeout 3..900 s;
 *  - endpoint `authType` IamAuth | ApplicationManaged, `endpointType` HomeRegion | MultiRegion | PerRegion;
 *  - custom domains / WAF require CloudFront in front (OAC with `IamAuth`).
 *
 * CloudFormation semantics verified 2026-10-17 against the Template Reference
 * (https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-webfunction.html,
 * …/aws-resource-lambda-webfunctionrevision.html, …/aws-resource-lambda-webfunctionendpoint.html,
 * …/aws-properties-lambda-webfunctionrevision-s3object.html,
 * …/aws-properties-lambda-webfunctionrevision-loggingconfig.html,
 * …/aws-properties-lambda-webfunctionrevision-serviceconfig.html):
 *  - `AWS::Lambda::WebFunction` accepts only `FunctionName` (1..64 chars) and `Tags`; `Ref`
 *    returns the function ARN, which `WebFunctionRevision.FunctionName` /
 *    `WebFunctionEndpoint.FunctionName` accept (name or ARN).
 *  - `WebFunctionRevision` is immutable: every property is "Update requires: Replacement".
 *    `BuildConfig` (required) = `CodeConfig.S3Object { Bucket (required), Key (required),
 *    VersionId (optional) }` + `RuntimeConfig.Runtime` (required, pattern
 *    `^[a-z][a-z0-9]*[0-9]+(\.[a-z0-9]+)*$`; `nodejs24.x` is the only runtime listed in
 *    https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html).
 *    `ServiceConfig` (required) = `ExecutionRoleArn` (required), `MaxConcurrencyPerEnvironment`
 *    1..128 default 64, `TimeoutSeconds` 3..900 default 30, `EnvironmentVariables`,
 *    `EgressNetworkConnectorArn`, `TelemetryConfig.LoggingConfig { ApplicationLogLevel
 *    TRACE|DEBUG|INFO|WARN|ERROR|FATAL (default INFO), SystemLogLevel DEBUG|INFO|WARN (default
 *    INFO), LogGroup (default `/aws/lambda/web/{functionName}`) }`.
 *  - `WebFunctionEndpoint`: `AuthType` (required) `ApplicationManaged | IamAuth`; `EndpointType`
 *    (required) `HomeRegion | MultiRegion | PerRegion`; `EndpointName` (required, 1..64 chars);
 *    `RevisionWeights` 1..2 entries of `{ RevisionId, Weight }`; `ScalingConfig.MaxEnvironments`;
 *    `ThrottleConfig.RateLimit`. `Fn::GetAtt DomainName` is the endpoint domain.
 *  - Logging (https://docs.aws.amazon.com/lambda/latest/dg/web-functions-logging.html,
 *    …/web-functions-permissions.html): Lambda writes in-Region logs to `<logGroup>.local` and
 *    centralizes them into `<logGroup>` in the home Region. The execution role needs
 *    `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` on both groups; if it
 *    cannot write to the `.local` group, Lambda does not deliver logs from that Region.
 *    Both log groups are created here so that retention applies from the first request.
 *  - The S3 object version is optional for CloudFormation; the CDK asset key is content-hashed,
 *    so a new revision is created whenever the bundle changes.
 *
 * Not yet verified against a real deployment: end-to-end behaviour of a revision created from
 * the CDK bootstrap bucket (requires a sandbox deploy; tracked in the ADR-0006 benchmark).
 * Guardrails refuse this construct outside sandbox/development/staging.
 */
export interface ExperimentalWebFunctionProps {
  readonly manifest: ServiceManifest;
  readonly config: EnvironmentConfig;
  /** Directory containing the bundled server (an `index.mjs` that starts an HTTP server). */
  readonly codeDirectory: string;
  readonly functionName?: string;
  readonly maxConcurrencyPerEnvironment?: number;
  readonly timeout?: Duration;
  readonly environment?: Record<string, string>;
  /** IamAuth (default; CloudFront OAC) or ApplicationManaged (public; the app verifies JWTs). */
  readonly authType?: 'IamAuth' | 'ApplicationManaged';
  readonly maxEnvironments?: number;
  readonly rateLimit?: number;
}

export class ExperimentalWebFunction extends Construct {
  readonly webFunction: lambda.CfnWebFunction;
  readonly revision: lambda.CfnWebFunctionRevision;
  readonly endpoint: lambda.CfnWebFunctionEndpoint;
  readonly role: iam.Role;
  /** Versioned bucket holding the deployment package that revisions pin by object version. */
  readonly codeBucket: s3.Bucket;
  /** Centralized log group in the home Region (`/aws/lambda/web/<functionName>`). */
  readonly logGroup: logs.LogGroup;
  /** In-Region companion log group (`<logGroup>.local`) that Lambda writes to first. */
  readonly localLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ExperimentalWebFunctionProps) {
    super(scope, id);
    const { manifest, config } = props;
    if (config.isProduction) {
      throw new Error(
        `${manifest.serviceId}: ExperimentalWebFunction is forbidden in production until ADR-0006 is accepted`,
      );
    }
    if (manifest.runtimeProfile !== 'experimental-web') {
      throw new Error(
        `${manifest.serviceId}: ExperimentalWebFunction requires runtimeProfile=experimental-web in service.yaml`,
      );
    }
    const stack = Stack.of(this);
    const functionName =
      props.functionName ??
      `${manifest.serviceId}-${config.name}-${config.cellId}-web`.slice(0, 64);

    const logGroupName = `/aws/lambda/web/${functionName}`;
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName,
      retention: config.logRetention,
      removalPolicy: config.removalPolicy,
    });
    // Lambda writes in-Region logs to "<logGroup>.local" before centralizing them; without this
    // group (or permission to create it) the logs of the Region are dropped.
    this.localLogGroup = new logs.LogGroup(this, 'LocalLogGroup', {
      logGroupName: `${logGroupName}.local`,
      retention: config.logRetention,
      removalPolicy: config.removalPolicy,
    });

    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `${manifest.serviceId} web function execution role (experimental)`,
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteOwnLogs',
        // Minimum logging permissions per web-functions-permissions.html. The ".local" ARN uses
        // a Region wildcard because Lambda writes it in every Region that serves the endpoint.
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          this.logGroup.logGroupArn,
          `${this.logGroup.logGroupArn}:*`,
          `arn:${stack.partition}:logs:*:${stack.account}:log-group:${logGroupName}.local:*`,
        ],
      }),
    );

    // Log-stream wildcards are the minimum documented in web-functions-permissions.html
    // ("Execution role"): "<log-group>:*" for streams and a Region wildcard for the ".local"
    // group that Lambda writes in every Region serving the endpoint.
    NagSuppressions.addResourceSuppressions(
      this.role,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Lambda Web Functions execution-role minimum (web-functions-permissions.html): log streams under the dedicated log group and the ".local" companion group in any Region.',
          appliesTo: [
            { regex: '/^Resource::<.*LogGroup.*\\.Arn>:\\*$/' },
            {
              regex:
                '/^Resource::arn:[a-z-]+:logs:\\*:[0-9]+:log-group:\\/aws\\/lambda\\/web\\/[A-Za-z0-9._-]+\\.local:\\*$/',
            },
          ],
        },
      ],
      true,
    );

    // Web Functions read the code object directly from S3 at revision creation and for the
    // lifetime of the revision (web-functions-code-s3.html): the bucket must be versioned and its
    // bucket policy must grant lambda.amazonaws.com s3:GetObject + s3:GetObjectVersion scoped by
    // aws:SourceArn to this function's revisions. The CDK bootstrap assets bucket cannot carry
    // that policy (it belongs to CDKToolkit), so the zip is copied into a dedicated bucket
    // (real-deployment finding 2026-10-21: "Lambda service principal lambda.amazonaws.com does
    // not have s3:GetObject and s3:GetObjectVersion permission on s3://cdk-paas-assets-...").
    this.codeBucket = new s3.Bucket(this, 'CodeBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: config.isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !config.isProduction,
    });
    this.codeBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowLambdaWebFunctionCodeAccess',
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [this.codeBucket.arnForObjects('*')],
        conditions: {
          ArnLike: {
            'aws:SourceArn': `arn:${stack.partition}:lambda:${stack.region}:${stack.account}:web-function/${functionName}/revision/*`,
          },
        },
      }),
    );
    const codeDeployment = new s3deploy.BucketDeployment(this, 'CodeDeployment', {
      sources: [s3deploy.Source.asset(props.codeDirectory)],
      destinationBucket: this.codeBucket,
      extract: false, // keep the zip as one object; the revision pins its object version
      prune: false, // older object versions must survive while a revision references them
      retainOnDelete: false,
    });
    const codeKey = Fn.select(0, codeDeployment.objectKeys);

    this.webFunction = new lambda.CfnWebFunction(this, 'WebFunction', {
      functionName,
      tags: [
        { key: 'paas:service', value: manifest.serviceId },
        { key: 'paas:runtime-profile', value: 'experimental-web' },
      ],
    });

    this.revision = new lambda.CfnWebFunctionRevision(this, 'Revision', {
      functionName: this.webFunction.ref,
      description: `${manifest.serviceId} ${config.name} benchmark revision`,
      buildConfig: {
        codeConfig: { s3Object: { bucket: this.codeBucket.bucketName, key: codeKey } },
        runtimeConfig: { runtime: 'nodejs24.x' },
      },
      serviceConfig: {
        executionRoleArn: this.role.roleArn,
        maxConcurrencyPerEnvironment: props.maxConcurrencyPerEnvironment ?? 64,
        timeoutSeconds: (props.timeout ?? Duration.seconds(30)).toSeconds(),
        environmentVariables: {
          POWERTOOLS_SERVICE_NAME: manifest.serviceId,
          POWERTOOLS_LOG_LEVEL: config.logLevel,
          PAAS_CELL_ID: config.cellId,
          PAAS_ENVIRONMENT: config.name,
          PAAS_SERVICE_ID: manifest.serviceId,
          PAAS_RUNTIME_PROFILE: 'experimental-web',
          // The runtime loads /var/task/index.js unless told otherwise (web-functions-code-s3.html,
          // "Entry file"); the esbuild bundle is an ES module named index.mjs.
          AWS_LAMBDA_NODEJS_ENTRYPOINT: 'index.mjs',
          ...(props.environment ?? {}),
        },
        telemetryConfig: {
          loggingConfig: {
            applicationLogLevel: config.logLevel,
            systemLogLevel: 'INFO',
            logGroup: this.logGroup.logGroupName,
          },
        },
      },
    });
    this.revision.addResourceDependency(this.webFunction);
    this.revision.node.addDependency(codeDeployment);

    this.endpoint = new lambda.CfnWebFunctionEndpoint(this, 'Endpoint', {
      endpointName: `${functionName}-endpoint`.slice(0, 64),
      functionName: this.webFunction.ref,
      authType: props.authType ?? 'IamAuth',
      endpointType: 'HomeRegion',
      revisionWeights: [{ revisionId: this.revision.attrRevisionId, weight: 100 }],
      ...(props.maxEnvironments !== undefined
        ? { scalingConfig: { maxEnvironments: props.maxEnvironments } }
        : {}),
      ...(props.rateLimit !== undefined ? { throttleConfig: { rateLimit: props.rateLimit } } : {}),
    });
    this.endpoint.addResourceDependency(this.revision);

    show(this.webFunction, `${manifest.serviceId}\nWeb Function (experimental)`);
    new CfnOutput(this, 'WebEndpointDomain', {
      value: this.endpoint.attrDomainName,
      description: `${manifest.serviceId} experimental Web Function endpoint (${stack.region})`,
    });
    // Dimension values for AWS/Lambda/Web metrics (tests/performance/collect-web-metrics.mjs).
    new CfnOutput(this, 'WebFunctionName', { value: functionName });
    new CfnOutput(this, 'WebEndpointName', { value: this.endpoint.endpointName });
  }
}
