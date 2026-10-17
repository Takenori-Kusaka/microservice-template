#!/usr/bin/env node
/**
 * pnpm create-service --name invoice-service --type api --domain billing --owner billing-team
 *
 * Generates the golden path for a new microservice (guideline §20, Spotify "paved road"):
 * apps/<name>/ (manifest, package, stack, handlers, test), docs/runbooks, docs/threat-models,
 * docs/adr stub, and prints the remaining manual steps (register in platform-cdk, CODEOWNERS).
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adrStub,
  apiHandlers,
  apiStack,
  eslintConfig,
  packageJson,
  runbook,
  serviceYaml,
  threatModel,
  tsconfigJson,
  unitTest,
  workerHandlers,
  workerStack,
  workflowHandlers,
  workflowStack,
  type ServiceType,
  type TemplateInput,
} from './templates.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function arg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  const value = idx >= 0 ? process.argv[idx + 1] : undefined;
  if (value) return value;
  if (fallback !== undefined) return fallback;
  console.error(`missing --${name}`);
  console.error(
    'usage: pnpm create-service --name <kebab-id> --type api|worker|workflow [--domain <d>] [--owner <team>] [--dry-run]',
  );
  process.exit(2);
}

function toPascal(id: string): string {
  return id
    .replace(/-service$/, '')
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

function nextAdrNumber(root: string): string {
  const dir = join(root, 'docs/adr');
  const max = readdirSync(dir)
    .map((f) => /^ADR-(\d{4})/.exec(f)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(Number)
    .reduce((a, b) => Math.max(a, b), 0);
  return String(max + 1).padStart(4, '0');
}

export function generate(
  input: TemplateInput,
  options: { dryRun: boolean; root?: string },
): string[] {
  const root = options.root ?? repoRoot;
  const appDir = join(root, 'apps', input.serviceId);
  if (existsSync(appDir)) throw new Error(`${appDir} already exists`);
  const files: Record<string, string> = {
    [`apps/${input.serviceId}/service.yaml`]: serviceYaml(input),
    [`apps/${input.serviceId}/package.json`]: packageJson(input),
    [`apps/${input.serviceId}/tsconfig.json`]: tsconfigJson,
    [`apps/${input.serviceId}/eslint.config.js`]: eslintConfig,
    [`apps/${input.serviceId}/infra/${input.serviceId}-stack.ts`]:
      input.type === 'api'
        ? apiStack(input)
        : input.type === 'worker'
          ? workerStack(input)
          : workflowStack(input),
    [`apps/${input.serviceId}/test/manifest.test.ts`]: unitTest(input),
    [`docs/runbooks/${input.serviceId}.md`]: runbook(input),
    [`docs/threat-models/${input.serviceId}.md`]: threatModel(input),
  };
  const handlers =
    input.type === 'api'
      ? apiHandlers(input)
      : input.type === 'worker'
        ? workerHandlers(input)
        : workflowHandlers(input);
  for (const [rel, content] of Object.entries(handlers))
    files[`apps/${input.serviceId}/${rel}`] = content;
  const adr = nextAdrNumber(root);
  files[`docs/adr/ADR-${adr}-${input.serviceId}-boundary.md`] = adrStub(input, adr);

  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    if (!options.dryRun) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    written.push(rel);
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const serviceId = arg('name');
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(serviceId)) {
    console.error('service id must be kebab-case (e.g. invoice-service)');
    process.exit(2);
  }
  const type = arg('type') as ServiceType;
  if (!['api', 'worker', 'workflow'].includes(type)) {
    console.error('--type must be api | worker | workflow');
    process.exit(2);
  }
  const input: TemplateInput = {
    serviceId,
    pascal: toPascal(serviceId),
    domain: arg('domain', 'REPLACE-ME'),
    ownerTeam: arg('owner', 'REPLACE-ME-team'),
    type,
    today: new Date().toISOString().slice(0, 10),
  };
  const dryRun = process.argv.includes('--dry-run');
  const files = generate(input, { dryRun });
  console.log(`${dryRun ? 'would write' : 'wrote'} ${files.length} files:`);
  for (const f of files) console.log(`  ${f}`);
  console.log(`
next steps:
  1. pnpm install
  2. register the stack in apps/platform-cdk/lib/environment-stage.ts
  3. add '/apps/${serviceId}/ @${input.ownerTeam}' to .github/CODEOWNERS
  4. fill in docs/adr/ADR-*-${serviceId}-boundary.md and the runbook
  5. pnpm verify`);
}
