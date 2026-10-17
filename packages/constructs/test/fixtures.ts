import { fileURLToPath } from 'node:url';
import { App, Stack } from 'aws-cdk-lib';
import { productionDefaults, sandboxDefaults, type EnvironmentConfig } from '../src/environment.js';
import type { ServiceManifest } from '../src/service-manifest.js';

export const testManifest: ServiceManifest = {
  serviceId: 'order-service',
  domain: 'commerce',
  ownerTeam: 'order-team',
  onCall: 'order-team-oncall',
  repository: 'https://github.com/example/microservice-template',
  dataClassification: 'confidential',
  tenantIsolationModel: 'pool',
  syncContracts: ['schemas/openapi/order-service.yaml'],
  publishedEvents: ['order.created.v1'],
  consumedEvents: ['order.fulfilled.v1'],
  slo: { availability: 99.9, latencyP99Ms: 500, window: '30d' },
  rto: '1h',
  rpo: '5m',
  costCenter: 'CC-1001',
  runtimeProfile: 'event-zip-arm64',
  awsAccounts: {},
  regions: ['ap-northeast-1'],
  runbook: 'docs/runbooks/order-service.md',
  dashboard: 'auto',
  threatModel: 'docs/threat-models/order-service.md',
  adrs: ['ADR-0001'],
};

/** A real entry path inside the repo (NodejsFunction requires entry under projectRoot; bundling is disabled). */
export function tempEntry(): string {
  return fileURLToPath(
    new URL('../src/authorizers/sandbox-authorizer.handler.ts', import.meta.url),
  );
}

export function testApp(): App {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  return app;
}

export function testStack(config: EnvironmentConfig = sandboxDefaults()): {
  app: App;
  stack: Stack;
  config: EnvironmentConfig;
} {
  const app = testApp();
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: config.region },
  });
  return { app, stack, config };
}

export { sandboxDefaults, productionDefaults };
