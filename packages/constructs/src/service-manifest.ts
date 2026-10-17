import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { Tags } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/**
 * service.yaml schema (guideline §3 必須所有メタデータ). Synth fails when a required field is
 * missing: "所有者不明のサービスはデプロイ不可とする".
 */
export const ServiceManifestSchema = z.object({
  serviceId: z.string().regex(/^[a-z][a-z0-9-]{2,40}$/),
  domain: z.string().min(1),
  ownerTeam: z.string().min(1),
  onCall: z.string().min(1),
  repository: z.string().url(),
  dataClassification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  tenantIsolationModel: z.enum(['pool', 'bridge', 'silo', 'account-per-tenant']),
  syncContracts: z.array(z.string()).default([]),
  publishedEvents: z.array(z.string()).default([]),
  consumedEvents: z.array(z.string()).default([]),
  slo: z.object({
    availability: z.number().min(90).max(100),
    latencyP99Ms: z.number().int().positive(),
    window: z.string().default('30d'),
  }),
  rto: z.string().min(1),
  rpo: z.string().min(1),
  costCenter: z.string().min(1),
  runtimeProfile: z.enum([
    'event-zip-arm64',
    'event-zip-x86',
    'event-container',
    'experimental-web',
    'microvm-sandbox',
    'container-fargate',
  ]),
  awsAccounts: z.record(z.string(), z.string()).default({}),
  regions: z.array(z.string()).min(1),
  runbook: z.string().min(1),
  dashboard: z.string().min(1),
  threatModel: z.string().min(1),
  adrs: z.array(z.string().regex(/^ADR-\d{4}$/)).min(1),
});

export type ServiceManifest = z.infer<typeof ServiceManifestSchema>;

export class ServiceManifestError extends Error {
  constructor(path: string, issues: string[]) {
    super(`service manifest ${path} is invalid (deploy blocked):\n  - ${issues.join('\n  - ')}`);
    this.name = 'ServiceManifestError';
  }
}

export function parseServiceManifest(raw: unknown, sourcePath = '<inline>'): ServiceManifest {
  const result = ServiceManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new ServiceManifestError(
      sourcePath,
      result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    );
  }
  return result.data;
}

export function loadServiceManifest(path: string): ServiceManifest {
  const raw: unknown = parse(readFileSync(path, 'utf8'));
  return parseServiceManifest(raw, path);
}

/** Standard tags (guideline §17 "standard tags", §15 cost attribution by service/cost center). */
export function applyServiceTags(
  scope: IConstruct,
  manifest: ServiceManifest,
  environment: string,
): void {
  const tags = Tags.of(scope);
  tags.add('paas:service', manifest.serviceId);
  tags.add('paas:domain', manifest.domain);
  tags.add('paas:owner', manifest.ownerTeam);
  tags.add('paas:on-call', manifest.onCall);
  tags.add('paas:cost-center', manifest.costCenter);
  tags.add('paas:data-classification', manifest.dataClassification);
  tags.add('paas:tenant-isolation', manifest.tenantIsolationModel);
  tags.add('paas:environment', environment);
}
