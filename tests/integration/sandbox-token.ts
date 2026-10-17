/** Builds the unsigned token accepted by the sandbox Lambda authorizer (never valid in staging/production). */
export function sandboxToken(claims: {
  tenantId: string;
  tenantTier?: string;
  sub?: string;
}): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}
