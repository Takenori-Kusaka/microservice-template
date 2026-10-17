/**
 * File templates for the golden path (guideline §20 "pnpm create-service --type api|worker|workflow
 * でservice metadata、CDK stack、handler、tests、dashboard、runbook、ADRを生成").
 * Templates are plain strings on purpose: no template engine to learn, diffs stay readable.
 */
export type ServiceType = 'api' | 'worker' | 'workflow';

export interface TemplateInput {
  serviceId: string; // kebab-case, e.g. invoice-service
  pascal: string; // Invoice
  domain: string;
  ownerTeam: string;
  type: ServiceType;
  today: string;
}

export function serviceYaml(i: TemplateInput): string {
  const published =
    i.type === 'api'
      ? `  - ${i.serviceId.replace(/-service$/, '')}.created.v1`
      : i.type === 'worker'
        ? `  - ${i.serviceId.replace(/-service$/, '')}.processed.v1`
        : `  - ${i.serviceId.replace(/-service$/, '')}.completed.v1`;
  const consumed = i.type === 'api' ? '' : '  - order.created.v1';
  return `# Service manifest (guideline §3). Every field is mandatory; synth fails otherwise.
serviceId: ${i.serviceId}
domain: ${i.domain}
ownerTeam: ${i.ownerTeam}
onCall: ${i.ownerTeam}-oncall
repository: https://github.com/REPLACE-ME/microservice-template
dataClassification: confidential
tenantIsolationModel: pool
syncContracts:${i.type === 'api' ? `\n  - schemas/openapi/${i.serviceId}.yaml` : ' []'}
publishedEvents:
${published}
consumedEvents:${consumed ? `\n${consumed}` : ' []'}
slo:
  availability: 99.9
  latencyP99Ms: ${i.type === 'api' ? 500 : 30000}
  window: 30d
rto: 1h
rpo: 5m
costCenter: CC-REPLACE-ME
runtimeProfile: lambda-zip-arm64
awsAccounts: {}
regions:
  - ap-northeast-1
runbook: docs/runbooks/${i.serviceId}.md
dashboard: auto
threatModel: docs/threat-models/${i.serviceId}.md
adrs:
  - ADR-0001
  - ADR-${i.type === 'api' ? '0005' : i.type === 'worker' ? '0011' : '0010'}
`;
}

export function packageJson(i: TemplateInput): string {
  return (
    JSON.stringify(
      {
        name: `@paas/${i.serviceId}`,
        version: '0.1.0',
        private: true,
        type: 'module',
        exports: {
          './infra': {
            types: `./infra/${i.serviceId}-stack.ts`,
            default: `./infra/${i.serviceId}-stack.ts`,
          },
        },
        scripts: {
          typecheck: 'tsc --noEmit -p tsconfig.json',
          lint: 'eslint src infra test',
          test: 'vitest run',
        },
        dependencies: {
          '@aws-lambda-powertools/batch': '^2.36.0',
          '@aws-lambda-powertools/idempotency': '^2.36.0',
          '@aws-lambda-powertools/logger': '^2.36.0',
          '@aws-lambda-powertools/metrics': '^2.36.0',
          '@aws-lambda-powertools/tracer': '^2.36.0',
          '@aws-sdk/client-dynamodb': '^3.1152.0',
          '@aws-sdk/client-eventbridge': '^3.1152.0',
          '@aws-sdk/lib-dynamodb': '^3.1152.0',
          '@middy/core': '^7.9.2',
          '@paas/api-contracts': 'workspace:*',
          '@paas/constructs': 'workspace:*',
          '@paas/event-contracts': 'workspace:*',
          '@paas/observability': 'workspace:*',
          '@paas/runtime-context': 'workspace:*',
          'aws-cdk-lib': '^2.273.0',
          constructs: '^10.8.1',
          zod: '^4.6.7',
        },
        devDependencies: {
          '@paas/eslint-config': 'workspace:*',
          '@paas/testing': 'workspace:*',
          '@types/aws-lambda': '^8.10.164',
          '@types/node': '^22.19.0',
          'aws-sdk-client-mock': '^4.1.0',
          eslint: '^9.39.5',
          typescript: '^5.9.3',
          vitest: '^4.1.12',
        },
      },
      null,
      2,
    ) + '\n'
  );
}

export const tsconfigJson = `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "rootDir": "." },
  "include": ["src/**/*.ts", "infra/**/*.ts", "test/**/*.ts"]
}
`;

export const eslintConfig = `import paasConfig from '@paas/eslint-config';
export default paasConfig;
`;

export function apiStack(i: TemplateInput): string {
  return `import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  IdempotencyTable,
  PavedApiService,
  ServiceObservability,
  ServiceStack,
  TenantAwareTable,
  connection,
  loadServiceManifest,
  type ServiceStackProps,
} from '@paas/constructs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => resolve(here, '../src', p);
export const ${i.pascal}Manifest = loadServiceManifest(resolve(here, '../service.yaml'));

export class ${i.pascal}ServiceStack extends ServiceStack {
  constructor(scope: Construct, id: string, props: Omit<ServiceStackProps, 'manifest'>) {
    super(scope, id, { ...props, manifest: ${i.pascal}Manifest });
    const { manifest, config, platform } = this;
    const defaults = this.functionDefaults();

    const table = new TenantAwareTable(this, 'Table', { manifest, config, stream: true });
    const idempotency = new IdempotencyTable(this, 'Idempotency', { manifest, config });
    const env = {
      TABLE_NAME: table.table.tableName,
      IDEMPOTENCY_TABLE_NAME: idempotency.table.tableName,
      EVENT_BUS_NAME: platform.eventBus.eventBusName,
    };

    const api = new PavedApiService(this, 'Api', {
      manifest,
      config,
      alarmTopic: platform.alarmTopic,
      functionDefaults: { ...defaults, environment: env },
      routes: [
        { method: 'POST', path: '/${i.serviceId.replace(/-service$/, '')}s', operation: 'Create${i.pascal}', entry: src('entrypoints/http/create.ts'), timeout: Duration.seconds(10) },
        { method: 'GET', path: '/${i.serviceId.replace(/-service$/, '')}s/{id}', operation: 'Get${i.pascal}', entry: src('entrypoints/http/get.ts'), timeout: Duration.seconds(5) },
      ],
    });
    for (const fn of api.functions.values()) {
      table.grantReadWriteData(fn.fn);
      idempotency.grant(fn.fn);
      connection(fn.fn, table.table);
    }

    new ServiceObservability(this, 'Observability', { manifest, config, apis: [api], alarmTopic: platform.alarmTopic });
  }
}
`;
}

export function workerStack(i: TemplateInput): string {
  return `import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  EventSubscription,
  IdempotencyTable,
  PavedQueueConsumer,
  ServiceObservability,
  ServiceStack,
  loadServiceManifest,
  type ServiceStackProps,
} from '@paas/constructs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => resolve(here, '../src', p);
export const ${i.pascal}Manifest = loadServiceManifest(resolve(here, '../service.yaml'));

export class ${i.pascal}ServiceStack extends ServiceStack {
  constructor(scope: Construct, id: string, props: Omit<ServiceStackProps, 'manifest'>) {
    super(scope, id, { ...props, manifest: ${i.pascal}Manifest });
    const { manifest, config, platform } = this;
    const defaults = this.functionDefaults();

    const idempotency = new IdempotencyTable(this, 'Idempotency', { manifest, config });
    const env = { IDEMPOTENCY_TABLE_NAME: idempotency.table.tableName, EVENT_BUS_NAME: platform.eventBus.eventBusName };

    const consumer = new PavedQueueConsumer(this, 'Consumer', {
      manifest,
      config,
      operation: 'Process${i.pascal}',
      entry: src('entrypoints/queue/process.ts'),
      maxConcurrency: config.isProduction ? 20 : 2,
      timeout: Duration.seconds(30),
      environment: env,
      alarmTopic: platform.alarmTopic,
      functionDefaults: defaults,
    });
    idempotency.grant(consumer.consumer.fn);
    platform.eventBus.grantPutEventsTo(consumer.consumer.fn);

    new EventSubscription(this, 'Subscription', {
      manifest,
      eventBus: platform.eventBus,
      eventTypes: manifest.consumedEvents,
      target: { queue: consumer.queue },
      alarmTopic: platform.alarmTopic,
    });

    new ServiceObservability(this, 'Observability', { manifest, config, consumers: [consumer], alarmTopic: platform.alarmTopic });
  }
}
`;
}

export function workflowStack(i: TemplateInput): string {
  return `import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration } from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import {
  EventSubscription,
  ObservableFunction,
  PavedWorkflow,
  ServiceObservability,
  ServiceStack,
  TRANSIENT_RETRY,
  loadServiceManifest,
  type ServiceStackProps,
} from '@paas/constructs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => resolve(here, '../src', p);
export const ${i.pascal}Manifest = loadServiceManifest(resolve(here, '../service.yaml'));

export class ${i.pascal}ServiceStack extends ServiceStack {
  constructor(scope: Construct, id: string, props: Omit<ServiceStackProps, 'manifest'>) {
    super(scope, id, { ...props, manifest: ${i.pascal}Manifest });
    const { manifest, config, platform } = this;
    const defaults = this.functionDefaults();

    const step = new ObservableFunction(this, 'TaskStep', {
      manifest, config, operation: 'Step', entry: src('tasks/step.ts'), timeout: Duration.seconds(15), alarmTopic: platform.alarmTopic, ...defaults,
    });
    const compensate = new ObservableFunction(this, 'TaskCompensate', {
      manifest, config, operation: 'Compensate', entry: src('tasks/compensate.ts'), timeout: Duration.seconds(15), alarmTopic: platform.alarmTopic, ...defaults,
    });

    const invoke = (id: string, fn: ObservableFunction) =>
      new tasks.LambdaInvoke(this, id, { lambdaFunction: fn.alias, payloadResponseOnly: true, resultPath: '$.state', taskTimeout: sfn.Timeout.duration(Duration.seconds(20)), retryOnServiceExceptions: false }).addRetry(TRANSIENT_RETRY);

    const compensation = invoke('Compensate', compensate).next(new sfn.Fail(this, 'Failed', { error: 'WorkflowFailed', cause: 'compensated' }));
    const definition = new sfn.Pass(this, 'Init', { parameters: { 'request.$': '$', state: {} } })
      .next(invoke('Step', step).addCatch(compensation, { errors: ['States.ALL'], resultPath: '$.error' }))
      .next(new sfn.Succeed(this, 'Done'));

    const workflow = new PavedWorkflow(this, 'Workflow', { manifest, config, definition, timeout: Duration.minutes(15), alarmTopic: platform.alarmTopic });
    new EventSubscription(this, 'Trigger', { manifest, eventBus: platform.eventBus, eventTypes: manifest.consumedEvents, target: { stateMachine: workflow.stateMachine }, alarmTopic: platform.alarmTopic });

    new ServiceObservability(this, 'Observability', { manifest, config, functions: [step, compensate], workflows: [workflow], alarmTopic: platform.alarmTopic });
  }
}
`;
}

export function apiHandlers(i: TemplateInput): Record<string, string> {
  const shared = `import middy from '@middy/core';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import type { APIGatewayProxyResultV2, Context as LambdaContext } from 'aws-lambda';
import { contextlessErrorResponse, errorResponse, type JsonResponse } from '@paas/api-contracts';
import { createTelemetry, recordRequest, requestSummary } from '@paas/observability';
import { contextFromHttpApiEvent, runWithContext, type ExecutionContext, type HttpApiEvent } from '@paas/runtime-context';

export const SERVICE_ID = process.env['PAAS_SERVICE_ID'] ?? '${i.serviceId}';
export const telemetry = createTelemetry({ serviceName: SERVICE_ID });

export function apiHandler(operation: string, impl: (ctx: ExecutionContext, event: HttpApiEvent) => Promise<JsonResponse>) {
  const base = async (event: HttpApiEvent, lambdaContext: LambdaContext): Promise<APIGatewayProxyResultV2> => {
    const started = Date.now();
    let ctx: ExecutionContext;
    try {
      ctx = contextFromHttpApiEvent(event, lambdaContext, { service: SERVICE_ID, operation });
    } catch (error) {
      return contextlessErrorResponse(error, event.requestContext.requestId);
    }
    return runWithContext(ctx, async () => {
      telemetry.bind(ctx);
      let response: JsonResponse;
      try {
        response = await impl(ctx, event);
      } catch (error) {
        const mapped = errorResponse(error, ctx);
        if (mapped.apiError.httpStatus >= 500) telemetry.logger.error('request failed', { error });
        response = mapped;
      }
      const durationMs = Date.now() - started;
      telemetry.logger.info('request completed', requestSummary(ctx, { status: response.statusCode, durationMs }));
      recordRequest(telemetry.metrics, { status: response.statusCode, durationMs });
      return response;
    });
  };
  return middy(base).use(captureLambdaHandler(telemetry.tracer)).use(injectLambdaContext(telemetry.logger, { resetKeys: true })).use(logMetrics(telemetry.metrics, { captureColdStartMetric: true }));
}
`;
  const create = `import { ApiError, jsonResponse } from '@paas/api-contracts';
import { z } from 'zod';
import { apiHandler } from './shared.js';

const RequestSchema = z.object({ name: z.string().min(1).max(128) }).strict();

export const handler = apiHandler('Create${i.pascal}', async (ctx, event) => {
  if (!ctx.idempotencyKey) throw ApiError.validation([{ path: 'header.idempotency-key', message: 'Idempotency-Key header is required' }]);
  const request = RequestSchema.parse(JSON.parse(event.body ?? '{}'));
  // TODO: call the use case in src/application and persist through src/adapters (never from here).
  return jsonResponse(201, { id: ctx.requestId, ...request }, ctx);
});
`;
  const get = `import { ApiError, jsonResponse } from '@paas/api-contracts';
import { apiHandler } from './shared.js';

export const handler = apiHandler('Get${i.pascal}', async (ctx, event) => {
  const id = event.pathParameters?.['id'];
  if (!id) throw ApiError.notFound('${i.serviceId.replace(/-service$/, '')}');
  // TODO: load through the repository scoped to ctx.tenantId; return 404 for foreign tenants.
  return jsonResponse(200, { id }, ctx);
});
`;
  return {
    'src/entrypoints/http/shared.ts': shared,
    'src/entrypoints/http/create.ts': create,
    'src/entrypoints/http/get.ts': get,
  };
}

export function workerHandlers(i: TemplateInput): Record<string, string> {
  return {
    'src/entrypoints/queue/process.ts': `import { BatchProcessor, EventType, processPartialResponse } from '@aws-lambda-powertools/batch';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import type { Context as LambdaContext, SQSEvent, SQSRecord } from 'aws-lambda';
import { eventCatalog, fromSqsRecord } from '@paas/event-contracts';
import { createTelemetry } from '@paas/observability';
import { contextFromEnvelope, runWithContext } from '@paas/runtime-context';

const SERVICE_ID = process.env['PAAS_SERVICE_ID'] ?? '${i.serviceId}';
const telemetry = createTelemetry({ serviceName: SERVICE_ID });
const processor = new BatchProcessor(EventType.SQS);

async function handleRecord(record: SQSRecord, lambdaContext: LambdaContext): Promise<void> {
  const envelope = fromSqsRecord(eventCatalog, record);
  const ctx = contextFromEnvelope(envelope, lambdaContext, { service: SERVICE_ID, operation: 'Process${i.pascal}' });
  await runWithContext(ctx, async () => {
    telemetry.bind(ctx);
    // TODO: idempotent use case keyed by \`\${ctx.tenantId}:\${envelope.id}\`; throw only for transient errors.
    telemetry.logger.info('processed', { eventId: envelope.id, eventType: envelope.type });
  });
}

const base = async (event: SQSEvent, context: LambdaContext) =>
  processPartialResponse(event, (record) => handleRecord(record, context), processor, { context });

export const handler = middy(base).use(captureLambdaHandler(telemetry.tracer)).use(injectLambdaContext(telemetry.logger)).use(logMetrics(telemetry.metrics));
`,
  };
}

export function workflowHandlers(i: TemplateInput): Record<string, string> {
  const task = (
    operation: string,
  ) => `import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import type { Context as LambdaContext } from 'aws-lambda';
import { EventEnvelopeSchema } from '@paas/event-contracts';
import { createTelemetry } from '@paas/observability';
import { contextFromEnvelope, runWithContext } from '@paas/runtime-context';
import { z } from 'zod';

const SERVICE_ID = process.env['PAAS_SERVICE_ID'] ?? '${i.serviceId}';
const telemetry = createTelemetry({ serviceName: SERVICE_ID });
const InputSchema = z.object({ request: EventEnvelopeSchema, state: z.record(z.string(), z.unknown()).default({}), error: z.unknown().optional() });

const base = async (rawInput: unknown, lambdaContext: LambdaContext) => {
  const input = InputSchema.parse(rawInput);
  const ctx = contextFromEnvelope(input.request, lambdaContext, { service: SERVICE_ID, operation: '${operation}' });
  return runWithContext(ctx, async () => {
    telemetry.bind(ctx);
    // TODO: implement '${operation}'; throw new Error('RetryableError') subclasses for transient faults.
    telemetry.logger.info('task completed', { step: '${operation}' });
    return { ...input.state, ${operation.toLowerCase()}: true };
  });
};

export const handler = middy(base).use(captureLambdaHandler(telemetry.tracer)).use(injectLambdaContext(telemetry.logger)).use(logMetrics(telemetry.metrics));
`;
  return { 'src/tasks/step.ts': task('Step'), 'src/tasks/compensate.ts': task('Compensate') };
}

export function unitTest(i: TemplateInput): string {
  return `import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

describe('${i.serviceId} manifest', () => {
  it('declares an owner and SLO', () => {
    const manifest = parse(readFileSync(new URL('../service.yaml', import.meta.url), 'utf8')) as Record<string, unknown>;
    expect(manifest['ownerTeam']).toBeTruthy();
    expect(manifest['slo']).toBeTruthy();
  });
});
`;
}

export function runbook(i: TemplateInput): string {
  return `# Runbook: ${i.serviceId}

- Owner: ${i.ownerTeam} / On-call: ${i.ownerTeam}-oncall
- Dashboard: CloudWatch dashboard \`${i.serviceId}-<env>-<cell>\`
- SLO: see service.yaml
- Generated: ${i.today}

## 1. 症状とアラーム

| アラーム | 顧客影響 | 最初に見るもの |
|---|---|---|
| \`...-customer-impact\` (composite) | あり | ダッシュボード上段の SLI |
| ErrorsAlarm / ThrottlesAlarm / DurationP99Alarm | 条件付き | Logs Insights: \`filter outcome = "fault"\` |
${i.type === 'worker' ? '| MessageAgeAlarm / DlqNotEmptyAlarm | 遅延 / 取りこぼし | docs/runbooks/dlq-redrive.md |' : ''}

## 2. 診断手順

1. \`correlationId\` でログを横断検索する（API → Lambda → DynamoDB → EventBridge → SQS → Lambda）。
2. X-Ray trace を \`tenantId\` annotation で絞り込む。
3. 依存先（DynamoDB throttles、EventBridge FailedInvocations）を確認する。

## 3. 復旧

- 設定変更やロールバックは CodeDeploy alias の前バージョンへ戻す。
- データ不整合は reconciliation 手順（TODO: サービス固有）に従う。

## 4. 事後対応

- インシデント記録、再発防止、アラーム閾値・ランブックの更新。
`;
}

export function threatModel(i: TemplateInput): string {
  return `# Threat model: ${i.serviceId}

Generated ${i.today}. Review with docs/threat-models/order-service.md as the reference.

| ID | 脅威 (STRIDE) | 資産 | 対策 | 検証 |
|---|---|---|---|---|
| T1 | Spoofing: 他テナントの JWT / 改ざん tenantId | テナントデータ | 認証は API Gateway、tenantId は authorizer claims のみ (@paas/runtime-context) | tests/tenant-isolation |
| T2 | Tampering: イベント改ざん | イベント | EventBridge IAM、envelope 検証 (@paas/event-contracts) | unit tests |
| T3 | Information disclosure: ログ中の PII | ログ | 共通 logger の redaction | @paas/observability tests |
| T4 | DoS: tenant burst | 同時実行 | stage throttling、reserved concurrency、tier 別 queue | load test |
| T5 | Elevation: wildcard IAM | AWS resources | NoWildcardIamAspect + cdk-nag | pnpm synth |
`;
}

export function adrStub(i: TemplateInput, number: string): string {
  return `# ADR-${number}: ${i.pascal} service boundary

- Status: proposed
- Date: ${i.today}
- Owner: ${i.ownerTeam}
- Review date: TODO
- Related: ADR-0001, ADR-0012

## Context

TODO: なぜ ${i.serviceId} を独立したサービスにするのか（所有チーム、データライフサイクル、スケール特性、セキュリティ区分、SLO、リリース頻度、障害波及範囲のうち 2 つ以上に明確な差があること — 指針 §4）。

## Decision

TODO

## Alternatives

1. 既存サービスへ統合する
2. TODO

## Consequences

TODO: 費用、性能、運用、lock-in、移行

## Evidence

TODO: 負荷試験、見積り、PoC

## Compliance

- service.yaml の必須項目 → ServiceManifest で synth 時に検証
- 他サービスの DB への直接アクセス禁止 → IAM grant はこのスタック内のみ
`;
}
