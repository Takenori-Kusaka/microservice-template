import { describe, expect, it } from 'vitest';
import { Duration } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as events from 'aws-cdk-lib/aws-events';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { ObservableFunction } from '../src/observable-function.js';
import { TenantAwareTable } from '../src/tenant-aware-table.js';
import { PavedApiService } from '../src/paved-api-service.js';
import { PavedQueueConsumer } from '../src/paved-queue-consumer.js';
import { EventSubscription } from '../src/event-subscription.js';
import { PavedWorkflow } from '../src/paved-workflow.js';
import { parseServiceManifest, ServiceManifestError } from '../src/service-manifest.js';
import {
  productionDefaults,
  sandboxDefaults,
  tempEntry,
  testManifest,
  testStack,
} from './fixtures.js';

const entry = tempEntry();

describe('ServiceManifest', () => {
  it('blocks synth when ownership metadata is missing', () => {
    const { ownerTeam: _omit, ...withoutOwner } = testManifest;
    expect(() => parseServiceManifest(withoutOwner, 'service.yaml')).toThrow(ServiceManifestError);
  });
});

describe('ObservableFunction', () => {
  it('applies arm64, tracing, dedicated log group, least-privilege role and alarms', () => {
    const { stack, config } = testStack();
    new ObservableFunction(stack, 'Fn', {
      manifest: testManifest,
      config,
      operation: 'CreateOrder',
      entry,
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
      Environment: {
        Variables: Match.objectLike({
          POWERTOOLS_SERVICE_NAME: 'order-service',
          PAAS_OPERATION: 'CreateOrder',
        }),
      },
    });
    t.resourceCountIs('AWS::Logs::LogGroup', 1);
    t.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    t.hasResourceProperties('AWS::Lambda::Alias', { Name: 'live' });
    // No AWS managed policies (cdk-nag IAM4) — explicit inline statements only.
    t.hasResourceProperties('AWS::IAM::Role', { ManagedPolicyArns: Match.absent() });
  });

  it('adds a CodeDeploy canary deployment group in production', () => {
    const { stack, config } = testStack(productionDefaults());
    new ObservableFunction(stack, 'Fn', {
      manifest: testManifest,
      config,
      operation: 'CreateOrder',
      entry,
    });
    Template.fromStack(stack).resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 1);
  });
});

describe('TenantAwareTable', () => {
  it('fixes the key schema and enables PITR; retains in production', () => {
    const { stack, config } = testStack(productionDefaults());
    new TenantAwareTable(stack, 'Table', { manifest: testManifest, config, stream: true });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    });
    t.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
  });

  it('requires a CMK for restricted data', () => {
    const { stack, config } = testStack();
    expect(
      () =>
        new TenantAwareTable(stack, 'T', {
          manifest: { ...testManifest, dataClassification: 'restricted' },
          config,
        }),
    ).toThrow(/customer-managed KMS key/);
  });
});

describe('PavedApiService', () => {
  it('creates HTTP API with authorizer, throttled stage, access logs and SLO alarms', () => {
    const { stack, config } = testStack();
    new PavedApiService(stack, 'Api', {
      manifest: testManifest,
      config,
      routes: [{ method: 'POST', path: '/orders', operation: 'CreateOrder', entry }],
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: 100,
        ThrottlingBurstLimit: 200,
      }),
      AccessLogSettings: Match.objectLike({ Format: Match.stringLikeRegexp('tenantId') }),
    });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { AuthorizationType: 'CUSTOM' });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmDescription: Match.stringLikeRegexp('p99 latency above SLO'),
    });
  });

  it('refuses the sandbox authorizer in production', () => {
    const { stack, config } = testStack(productionDefaults({ auth: { kind: 'sandbox-lambda' } }));
    expect(
      () =>
        new PavedApiService(stack, 'Api', {
          manifest: testManifest,
          config,
          routes: [{ method: 'POST', path: '/orders', operation: 'CreateOrder', entry }],
        }),
    ).toThrow(/forbidden in production/);
  });

  it('uses a JWT authorizer when configured', () => {
    const { stack, config } = testStack(
      sandboxDefaults({
        auth: { kind: 'jwt', issuer: 'https://idp.example.com/', audience: ['paas'] },
      }),
    );
    new PavedApiService(stack, 'Api', {
      manifest: testManifest,
      config,
      routes: [{ method: 'GET', path: '/orders', operation: 'ListOrders', entry }],
    });
    Template.fromStack(stack).hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
    });
  });

  it('rejects the experimental web-function profile with guidance', () => {
    const { stack, config } = testStack();
    expect(
      () =>
        new PavedApiService(stack, 'Api', {
          manifest: { ...testManifest, runtimeProfile: 'experimental-web' },
          config,
          routes: [],
        }),
    ).toThrow(/ADR-0006/);
  });
});

describe('PavedQueueConsumer + EventSubscription', () => {
  it('wires queue, DLQ with redrive-allow, partial batch failures, bounded concurrency and alarms', () => {
    const { stack, config } = testStack();
    const consumer = new PavedQueueConsumer(stack, 'Consumer', {
      manifest: testManifest,
      config,
      operation: 'FulfillOrder',
      entry,
      maxConcurrency: 5,
      timeout: Duration.seconds(20),
    });
    const bus = new events.EventBus(stack, 'Bus');
    new EventSubscription(stack, 'Sub', {
      manifest: testManifest,
      eventBus: bus,
      eventTypes: ['order.fulfilled.v1'],
      tenantTiers: ['standard'],
      target: { queue: consumer.queue },
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 5 },
    });
    t.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 122,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    t.hasResourceProperties('AWS::SQS::Queue', {
      RedriveAllowPolicy: Match.objectLike({ redrivePermission: 'allowAll' }),
    });
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: { 'detail-type': ['order.fulfilled.v1'], detail: { tenantTier: ['standard'] } },
    });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmDescription: Match.stringLikeRegexp('oldest message age'),
    });
  });

  it('refuses subscriptions not declared in service.yaml', () => {
    const { stack, config } = testStack();
    const consumer = new PavedQueueConsumer(stack, 'C', {
      manifest: testManifest,
      config,
      operation: 'X',
      entry,
      maxConcurrency: 2,
    });
    const bus = new events.EventBus(stack, 'Bus');
    expect(
      () =>
        new EventSubscription(stack, 'Sub', {
          manifest: testManifest,
          eventBus: bus,
          eventTypes: ['order.created.v1'],
          target: { queue: consumer.queue },
        }),
    ).toThrow(/not declared in service.yaml/);
  });
});

describe('PavedWorkflow', () => {
  it('creates a logged, traced, time-boxed state machine with failure alarms', () => {
    const { stack, config } = testStack();
    const definition = new sfn.Pass(stack, 'Start').next(new sfn.Succeed(stack, 'Done'));
    new PavedWorkflow(stack, 'Wf', {
      manifest: testManifest,
      config,
      definition,
      timeout: Duration.minutes(10),
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      TracingConfiguration: { Enabled: true },
      LoggingConfiguration: Match.objectLike({ Level: 'ALL', IncludeExecutionData: false }),
      DefinitionString: Match.stringLikeRegexp('"TimeoutSeconds":600'),
    });
    t.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  });
});
