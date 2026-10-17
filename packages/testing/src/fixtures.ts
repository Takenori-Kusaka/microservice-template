import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  Context as LambdaContext,
  EventBridgeEvent,
  SQSEvent,
  SQSRecord,
} from 'aws-lambda';
import { Deadline, newId, type ExecutionContext } from '@paas/runtime-context';
import type { EventEnvelope } from '@paas/event-contracts';

export function makeExecutionContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    tenantId: 'tenant-a',
    tenantTier: 'standard',
    subjectId: 'user-a',
    requestId: `req-${newId()}`,
    correlationId: `corr-${newId()}`,
    cellId: 'cell-01',
    service: 'test-service',
    operation: 'TestOperation',
    deploymentVersion: 'test',
    deadline: Deadline.fromNow(10_000),
    ...overrides,
  };
}

export function makeLambdaContext(overrides: Partial<LambdaContext> = {}): LambdaContext {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test-fn',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:ap-northeast-1:123456789012:function:test-fn',
    memoryLimitInMB: '512',
    awsRequestId: `aws-${newId()}`,
    logGroupName: '/aws/lambda/test-fn',
    logStreamName: 'stream',
    getRemainingTimeInMillis: () => 10_000,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
    ...overrides,
  };
}

export interface HttpApiEventInput {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path?: string;
  routeKey?: string;
  claims?: Record<string, unknown> | null;
  headers?: Record<string, string>;
  body?: unknown;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
}

/** API Gateway HTTP API (v2) event with a JWT authorizer result. `claims: null` omits the authorizer. */
export function makeHttpApiEvent(
  input: HttpApiEventInput = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  const method = input.method ?? 'GET';
  const path = input.path ?? '/orders';
  const claims =
    input.claims === undefined
      ? { 'custom:tenantId': 'tenant-a', 'custom:tenantTier': 'standard', sub: 'user-a' }
      : input.claims;
  const event: APIGatewayProxyEventV2WithJWTAuthorizer = {
    version: '2.0',
    routeKey: input.routeKey ?? `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', ...(input.headers ?? {}) },
    ...(input.pathParameters ? { pathParameters: input.pathParameters } : {}),
    ...(input.queryStringParameters ? { queryStringParameters: input.queryStringParameters } : {}),
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-test',
      domainName: 'api.test',
      domainPrefix: 'api',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
      requestId: `req-${newId()}`,
      routeKey: input.routeKey ?? `${method} ${path}`,
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
      authorizer: claims
        ? { principalId: 'p', integrationLatency: 0, jwt: { claims: claims as never, scopes: [] } }
        : (undefined as never),
    },
    isBase64Encoded: false,
    ...(input.body !== undefined
      ? { body: typeof input.body === 'string' ? input.body : JSON.stringify(input.body) }
      : {}),
  };
  return event;
}

export function makeEventBridgeEvent(
  envelope: EventEnvelope,
): EventBridgeEvent<string, EventEnvelope> {
  return {
    version: '0',
    id: `eb-${newId()}`,
    'detail-type': envelope.type,
    source: envelope.source,
    account: '123456789012',
    time: envelope.time,
    region: 'ap-northeast-1',
    resources: [],
    detail: envelope,
  };
}

export function makeSqsRecord(body: unknown, overrides: Partial<SQSRecord> = {}): SQSRecord {
  return {
    messageId: `msg-${newId()}`,
    receiptHandle: 'rh',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: String(Date.now()),
      SenderId: 'sender',
      ApproximateFirstReceiveTimestamp: String(Date.now()),
    },
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:ap-northeast-1:123456789012:test-queue',
    awsRegion: 'ap-northeast-1',
    ...overrides,
  };
}

/** SQS event whose records carry EventBridge-targeted envelopes. */
export function makeSqsEventFromEnvelopes(envelopes: EventEnvelope[]): SQSEvent {
  return { Records: envelopes.map((e) => makeSqsRecord(makeEventBridgeEvent(e))) };
}
