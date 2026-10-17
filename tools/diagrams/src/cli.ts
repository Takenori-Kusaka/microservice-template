#!/usr/bin/env node
/**
 * pnpm diagrams [--synth] [--layout tala|elk] [--env sandbox]
 *
 * 1. (optional) synthesizes the CDK app;
 * 2. generates docs/architecture/diagrams/generated/<env>.d2 from the cloud assembly
 *    (cdk2d2 annotation model);
 * 3. renders every .d2 under docs/architecture/diagrams (hand-written + generated) to .svg
 *    using D2 with the TALA layout engine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiagrams, toD2 } from './cdk2d2.js';
import { renderSvg, type LayoutEngine } from './render.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const diagramsDir = join(repoRoot, 'docs/architecture/diagrams');
const generatedDir = join(diagramsDir, 'generated');
const cdkOut = join(repoRoot, 'apps/platform-cdk/cdk.out');

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function option(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

async function main(): Promise<void> {
  const env = option('env', 'sandbox');
  const layout = option('layout', 'tala') as LayoutEngine;

  if (flag('synth') || !existsSync(cdkOut)) {
    console.log(`synthesizing (${env}) ...`);
    execFileSync('pnpm', ['--filter', '@paas/platform-cdk', 'synth', '--context', `env=${env}`], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }

  mkdirSync(generatedDir, { recursive: true });
  const diagrams = buildDiagrams(cdkOut);
  const d2 = toD2(diagrams, { title: `PaaS cell topology (${env}) — generated from cdk.out` });
  const generatedFile = join(generatedDir, `${env}.d2`);
  writeFileSync(generatedFile, d2);
  console.log(`wrote ${generatedFile} (${diagrams.reduce((n, d) => n + d.nodes.length, 0)} nodes)`);

  const sources: string[] = [];
  for (const dir of [diagramsDir, generatedDir]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.d2')) sources.push(join(dir, f));
  }
  const allowFallback = flag('allow-fallback');
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    const { svg, layout: used } = await renderSvg(source, layout, { allowFallback });
    const out = file.replace(/\.d2$/, '.svg');
    writeFileSync(out, svg);
    console.log(`rendered ${out} (layout: ${used})`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
