#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * pnpm diagrams:awsdac [--env sandbox]
 *
 * Third diagram path: AWS's own diagram-as-code (https://github.com/awslabs/diagram-as-code,
 * `awsdac`, Apache-2.0). Its `--cfn-template` (beta) input draws every resource of a
 * CloudFormation template with official AWS icons, so it works on `cdk synth` output without any
 * annotation and without AWS credentials. Output: docs/architecture/diagrams/awsdac/<stack>.png.
 *
 * Install once: `go install github.com/awslabs/diagram-as-code/cmd/awsdac@latest`
 * (or `brew install awsdac`). Observed 2026-10-18 with the main branch: the `--dac-file` YAML
 * export rejects CDK templates that contain a `Rules` section (bootstrap version check), while
 * `--cfn-template` PNG rendering works.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = resolve(repoRoot, 'docs/architecture/diagrams/awsdac');

function option(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

function findAwsdac(): string {
  const candidates = ['awsdac'];
  try {
    const gopath = execFileSync('go', ['env', 'GOPATH'], { encoding: 'utf8' }).trim();
    candidates.push(join(gopath, 'bin', process.platform === 'win32' ? 'awsdac.exe' : 'awsdac'));
  } catch {
    // go not installed; rely on PATH
  }
  for (const c of candidates) {
    const probe = spawnSync(c, ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32' && c === 'awsdac',
    });
    if (probe.status === 0) return c;
  }
  console.error(
    'awsdac not found. Install: go install github.com/awslabs/diagram-as-code/cmd/awsdac@latest',
  );
  process.exit(2);
}

function main(): void {
  const env = option('env', 'sandbox');
  const assembly = resolve(repoRoot, `apps/platform-cdk/cdk.out/assembly-paas-${env}`);
  if (!existsSync(assembly)) {
    console.error(`${assembly} not found; run \`pnpm synth --context env=${env}\` first`);
    process.exit(2);
  }
  const awsdac = findAwsdac();
  mkdirSync(outDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(assembly, 'manifest.json'), 'utf8')) as {
    artifacts: Record<
      string,
      { type: string; properties?: { stackName?: string; templateFile?: string } }
    >;
  };
  for (const [id, a] of Object.entries(manifest.artifacts)) {
    if (a.type !== 'aws:cloudformation:stack' || !a.properties?.templateFile) continue;
    const stackName = a.properties.stackName ?? id;
    const out = join(outDir, `${stackName}.png`);
    const run = spawnSync(
      awsdac,
      ['--cfn-template', '-f', '-o', out, join(assembly, a.properties.templateFile)],
      {
        stdio: 'inherit',
      },
    );
    if (run.status !== 0) {
      console.error(`awsdac failed for ${stackName}`);
      process.exit(1);
    }
  }
  console.log(
    `rendered ${readdirSync(outDir).filter((f) => f.endsWith('.png')).length} PNG(s) into ${outDir}`,
  );
}

main();
