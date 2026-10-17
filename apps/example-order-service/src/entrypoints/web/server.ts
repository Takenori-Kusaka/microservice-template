/**
 * EXPERIMENTAL — Lambda Web Functions entry point (ADR-0006 benchmark, docs/decision/
 * api-compute-selection.md §8–§10). Same application/domain/adapters as the Event Functions
 * handlers; only the execution model differs:
 *
 *  - one process serves up to `maxConcurrencyPerEnvironment` requests concurrently, so the
 *    ExecutionContext lives in AsyncLocalStorage (never in module state);
 *  - there is no API Gateway authorizer: with `IamAuth` the endpoint sits behind CloudFront OAC and
 *    tenant claims come from the JWT the app verifies itself. The sandbox accepts the same
 *    unsigned base64url token as the sandbox Lambda authorizer (never outside sandbox/dev).
 *
 * Local run (identical to Lambda's start path):
 *   AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 PAAS_ENVIRONMENT=sandbox pnpm --filter @paas/example-order-service dev:web
 */
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import {
  ApiError,
  CreateOrderRequestSchema,
  ListOrdersQuerySchema,
  OrderIdSchema,
  errorResponse,
  jsonResponse,
  type JsonResponse,
} from '@paas/api-contracts';
import { createTelemetry, recordRequest, requestSummary } from '@paas/observability';
import {
  Deadline,
  HEADERS,
  acceptOrGenerateToken,
  currentTraceId,
  isValidIdempotencyKey,
  isValidTenantId,
  newId,
  parseTenantTier,
  resolveServiceIdentity,
  runWithContext,
  TenantContextError,
  type ExecutionContext,
} from '@paas/runtime-context';
import { createOrderUseCase } from '../../application/create-order.js';
import { getOrderUseCase, listOrdersUseCase } from '../../application/queries.js';
import { DynamoDbOrderRepository } from '../../adapters/dynamodb-order-repository.js';
import { documentClient } from '../../adapters/clients.js';

const SERVICE_ID = process.env['PAAS_SERVICE_ID'] ?? 'order-service';
const telemetry = createTelemetry({ serviceName: SERVICE_ID, sensitiveKeys: ['customerRef'] });
const repository = new DynamoDbOrderRepository(
  documentClient,
  process.env['ORDERS_TABLE_NAME'] ?? 'orders',
);
const REQUEST_TIMEOUT_MS = Number(process.env['PAAS_REQUEST_TIMEOUT_MS'] ?? '30000');

interface Claims {
  tenantId: string;
  tenantTier?: string;
  sub?: string;
}

/** Sandbox-only: unsigned claims token. Production must verify a real JWT here (要検証: IdP choice). */
function claimsFromAuthorization(header: string | undefined): Claims {
  const env = process.env['PAAS_ENVIRONMENT'];
  if (env !== 'sandbox' && env !== 'development') {
    throw new TenantContextError(
      'JWT verification for Web Functions is not configured outside sandbox (ADR-0006)',
    );
  }
  if (!header?.startsWith('Bearer ')) throw new TenantContextError('missing bearer token');
  let claims: { tenantId?: unknown; tenantTier?: unknown; sub?: unknown };
  try {
    claims = JSON.parse(
      Buffer.from(header.slice(7).trim(), 'base64url').toString('utf8'),
    ) as typeof claims;
  } catch {
    throw new TenantContextError('malformed token');
  }
  if (!isValidTenantId(claims.tenantId))
    throw new TenantContextError('token has no valid tenantId');
  return {
    tenantId: claims.tenantId,
    ...(typeof claims.tenantTier === 'string' ? { tenantTier: claims.tenantTier } : {}),
    ...(typeof claims.sub === 'string' ? { sub: claims.sub } : {}),
  };
}

export function contextFromRequest(headers: Headers, operation: string): ExecutionContext {
  const claims = claimsFromAuthorization(headers.get('authorization') ?? undefined);
  const identity = resolveServiceIdentity({ service: SERVICE_ID, operation });
  const requestId = headers.get('lambda-web-request-id') ?? newId();
  const correlation = acceptOrGenerateToken(headers.get(HEADERS.correlationId));
  const idempotencyKey = headers.get(HEADERS.idempotencyKey) ?? undefined;
  if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
    throw ApiError.validation([
      { path: 'header.idempotency-key', message: 'invalid idempotency key' },
    ]);
  }
  const deadline = Deadline.earliest(
    Deadline.fromHeaderValue(headers.get(HEADERS.deadline)),
    Deadline.fromNow(REQUEST_TIMEOUT_MS - 500),
  );
  const traceId = currentTraceId();
  return {
    tenantId: claims.tenantId,
    tenantTier: parseTenantTier(claims.tenantTier),
    ...(claims.sub ? { subjectId: claims.sub } : {}),
    requestId,
    correlationId: correlation.generated ? requestId : correlation.value,
    ...(traceId ? { traceId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    cellId: identity.cellId,
    service: identity.service,
    operation: identity.operation,
    deploymentVersion: process.env['PAAS_REVISION_ID'] ?? identity.deploymentVersion,
    deadline,
  };
}

type Impl = (ctx: ExecutionContext, c: Context) => Promise<JsonResponse>;

function toResponse(res: JsonResponse): Response {
  return new Response(res.body, { status: res.statusCode, headers: res.headers });
}

/**
 * Request wrapper: derive the context from headers, bind it in AsyncLocalStorage, run the
 * use case, emit one summary log line + EMF metrics. Mirrors `apiHandler` for Event Functions.
 */
function route(operation: string, impl: Impl): (c: Context) => Promise<Response> {
  return async (c) => {
    const started = Date.now();
    let ctx: ExecutionContext;
    try {
      ctx = contextFromRequest(c.req.raw.headers, operation);
    } catch (error) {
      return toResponse(errorResponse(error, { requestId: 'n/a', correlationId: 'n/a' }));
    }
    return runWithContext(ctx, async () => {
      telemetry.bind(ctx);
      let response: JsonResponse;
      try {
        response = await impl(ctx, c);
      } catch (error) {
        const mapped = errorResponse(error, ctx);
        if (mapped.apiError.httpStatus >= 500) telemetry.logger.error('request failed', { error });
        response = mapped;
      }
      const durationMs = Date.now() - started;
      telemetry.logger.info(
        'request completed',
        requestSummary(ctx, { status: response.statusCode, durationMs }),
      );
      recordRequest(telemetry.metrics, { status: response.statusCode, durationMs });
      telemetry.metrics.publishStoredMetrics();
      return toResponse(response);
    });
  };
}

export const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true, runtimeProfile: 'experimental-web' }));

app.post(
  '/orders',
  route('CreateOrder', async (ctx, c) => {
    if (!ctx.idempotencyKey) {
      throw ApiError.validation([
        { path: 'header.idempotency-key', message: 'Idempotency-Key header is required' },
      ]);
    }
    // NOTE: Powertools Idempotency is wired in the Event Functions handler; for the Web Functions
    // benchmark the same DynamoDB-backed wrapper must be applied around the use case (要検証:
    // Powertools support for non-handler runtimes, docs/decision/api-compute-selection.md §10.3).
    const request = CreateOrderRequestSchema.parse(await c.req.json());
    const order = await createOrderUseCase({ repository }, ctx, request);
    const { tenantId: _tenant, ...publicOrder } = order;
    return jsonResponse(201, publicOrder, ctx, { location: `/orders/${order.orderId}` });
  }),
);

app.get(
  '/orders/:orderId',
  route('GetOrder', async (ctx, c) => {
    const parsed = OrderIdSchema.safeParse(c.req.param('orderId'));
    if (!parsed.success) throw ApiError.notFound('order');
    const { tenantId: _tenant, ...publicOrder } = await getOrderUseCase(
      repository,
      ctx,
      parsed.data,
    );
    return jsonResponse(200, publicOrder, ctx);
  }),
);

app.get(
  '/orders',
  route('ListOrders', async (ctx, c) => {
    const query = ListOrdersQuerySchema.parse(c.req.query());
    const page = await listOrdersUseCase(repository, ctx, query);
    return jsonResponse(
      200,
      {
        items: page.items.map(({ tenantId: _t, ...o }) => o),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      },
      ctx,
    );
  }),
);

/** Lambda Web Functions provide host:port in AWS_LAMBDA_HTTP_ENDPOINT; locally default to 127.0.0.1:3000. */
export function listenAddress(): { hostname: string; port: number } {
  const raw = process.env['AWS_LAMBDA_HTTP_ENDPOINT'] ?? '127.0.0.1:3000';
  const [hostname, port] = raw.split(':');
  return { hostname: hostname || '127.0.0.1', port: Number(port ?? '3000') };
}

if (process.env['PAAS_WEB_NO_LISTEN'] !== '1') {
  const address = listenAddress();
  serve({ fetch: app.fetch, hostname: address.hostname, port: address.port }, () => {
    telemetry.logger.info('web function listening', {
      ...address,
      runtimeProfile: 'experimental-web',
    });
  });
  process.on('SIGTERM', () => {
    // Web Functions allow ~1 s after SIGTERM: flush and exit.
    telemetry.metrics.publishStoredMetrics();
    process.exit(0);
  });
}
