#!/usr/bin/env node
/* eslint-disable no-console */
/* global process, console, URL, Buffer, fetch */
/**
 * Signed probe for an `IamAuth` Lambda Web Function endpoint (ADR-0006 smoke test).
 * Signing follows web-functions-endpoint-access-control.html: SigV4, service "lambda", the
 * endpoint's Region, and an explicit X-Amz-Content-SHA256 header.
 *
 *   eval "$(aws configure export-credentials --format env)"
 *   node tests/integration/web-sigv4-probe.mjs https://<domain>.lambda-web.ap-northeast-1.on.aws GET /healthz
 *   node tests/integration/web-sigv4-probe.mjs https://<domain> POST /orders '{"customerRef":"x","lines":[...]}' tenant-a
 */
import { createHash } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';

const [base, method = 'GET', path = '/healthz', body = '', tenantId] = process.argv.slice(2);
if (!base) {
  console.error('usage: <base-url> [method] [path] [body] [tenantId]');
  process.exit(2);
}
const region = process.env.AWS_REGION ?? 'ap-northeast-1';
const url = new URL(path, base);
const payloadHash = createHash('sha256').update(body).digest('hex');
const headers = {
  host: url.host,
  'x-amz-content-sha256': payloadHash,
  ...(body ? { 'content-type': 'application/json' } : {}),
  ...(tenantId
    ? {
        'x-paas-sandbox-claims': Buffer.from(
          JSON.stringify({ tenantId, tenantTier: 'standard', sub: 'probe' }),
        ).toString('base64url'),
        'idempotency-key': `probe-${Date.now()}`,
      }
    : {}),
};
const signer = new SignatureV4({
  service: 'lambda',
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
  sha256: Sha256,
});
const signed = await signer.sign({
  method,
  protocol: url.protocol,
  hostname: url.hostname,
  path: url.pathname,
  query: Object.fromEntries(url.searchParams),
  headers,
  body,
});
const res = await fetch(url, { method, headers: signed.headers, body: body || undefined });
const text = await res.text();
console.log(
  res.status,
  Object.fromEntries(
    [...res.headers].filter(
      ([k]) => k.startsWith('lambda-web') || k.startsWith('x-correlation') || k === 'location',
    ),
  ),
);
console.log(text.slice(0, 400));
process.exit(res.ok ? 0 : 1);
