/**
 * SANDBOX / DEVELOPMENT ONLY Lambda authorizer.
 *
 * Accepts `Authorization: Bearer <base64url-json>` where the JSON carries
 * `{ "tenantId": "...", "tenantTier": "standard|premium|enterprise", "sub": "..." }`.
 * It exists so that tenant-isolation E2E tests can run without an IdP. PlatformGuardrails
 * refuses this authorizer in staging/production (ApiAuthConfig.kind === 'jwt' is mandatory).
 */
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';

interface SandboxClaims {
  tenantId: string;
  tenantTier?: string;
  sub?: string;
}

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

function deny(): APIGatewaySimpleAuthorizerWithContextResult<Record<string, never>> {
  return { isAuthorized: false, context: {} };
}

export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerWithContextResult<Record<string, string>>> => {
  const header = event.headers?.['authorization'] ?? event.headers?.['Authorization'];
  if (!header?.startsWith('Bearer ')) return deny();
  const token = header.slice('Bearer '.length).trim();
  let claims: SandboxClaims;
  try {
    claims = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as SandboxClaims;
  } catch {
    return deny();
  }
  if (typeof claims.tenantId !== 'string' || !TENANT_ID_PATTERN.test(claims.tenantId))
    return deny();
  return {
    isAuthorized: true,
    context: {
      tenantId: claims.tenantId,
      tenantTier: typeof claims.tenantTier === 'string' ? claims.tenantTier : 'standard',
      sub: typeof claims.sub === 'string' ? claims.sub : 'sandbox-user',
    },
  };
};
