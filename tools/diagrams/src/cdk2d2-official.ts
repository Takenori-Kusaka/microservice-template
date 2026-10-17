#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * pnpm diagrams:deployed --stack <cloudformation-stack-name> [--env sandbox] [--layout tala]
 *
 * Runs the OFFICIAL cdk2d2 (github.com/megaproaktiv/cdk2d2, v0.2.0, Apache-2.0) against the CDK
 * app and renders the result with the D2 CLI (`d2 --layout=tala`). cdk2d2 polls CloudFormation
 * for each annotated resource's status (yellow = creating, green = created), so it needs:
 *  - AWS credentials for the account that holds the stack (`aws login` / profile);
 *  - a deployed (or deploying) stack; use `cdk2d2 watch` semantics by re-running during deploy.
 * Without a readable stack cdk2d2 logs "Stack ... is not readable" and writes an empty file —
 * use `pnpm diagrams` (offline generator from cdk.out) in that case.
 *
 * The binary is downloaded once from the GitHub release into tools/diagrams/.bin/.
 */
import { execSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const binDir = resolve(repoRoot, 'tools/diagrams/.bin');
const outDir = resolve(repoRoot, 'docs/architecture/diagrams/deployed');
const CDK2D2_VERSION = 'v0.2.0';

function option(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function assetName(): string {
  const os =
    process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'Darwin' : 'Linux';
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'i386' : 'x86_64';
  return `cdk2d2_${os}_${arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

function ensureBinary(): string {
  const exe = join(binDir, process.platform === 'win32' ? 'cdk2d2.exe' : 'cdk2d2');
  if (existsSync(exe)) return exe;
  mkdirSync(binDir, { recursive: true });
  const asset = assetName();
  console.log(`downloading cdk2d2 ${CDK2D2_VERSION} (${asset}) ...`);
  // One command string so Windows resolves gh.cmd/gh.exe through the shell.
  execSync(
    `gh release download ${CDK2D2_VERSION} --repo megaproaktiv/cdk2d2 --pattern ${asset} --dir "${binDir}" --clobber`,
    { stdio: 'inherit' },
  );
  // Windows: GNU tar from Git may shadow bsdtar and cannot read zip, so use PowerShell's
  // Expand-Archive. Elsewhere: tar handles tar.gz.
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '${asset}' -DestinationPath '.'"`,
      { cwd: binDir, stdio: 'inherit' },
    );
  } else {
    execSync(`tar -xzf "${asset}"`, { cwd: binDir, stdio: 'inherit' });
  }
  if (!existsSync(exe) && existsSync(join(binDir, 'cdk2d2')))
    renameSync(join(binDir, 'cdk2d2'), exe);
  return exe;
}

/**
 * cdk2d2 v0.2.0 (2023) expects (a) `cdk.out/manifest.json` with the construct metadata inline,
 * (b) artifacts keyed by stack name and (c) metadata keys of the form `/<stack>/<constructId>` or
 * `/<stack>/<constructId>/Resource` (one nesting level). Current CDK writes a nested assembly
 * for Stages, keys artifacts by artifact id, moves metadata to `<artifact>.metadata.json`, and
 * nests paved constructs several levels deep. This builds a compatibility assembly that flattens
 * all of that: construct paths become `<A>_<B>_<C>` ids and `Connection` targets are resolved
 * from the `paas:connection` path form to the same flattened ids.
 */
function buildCompatAssembly(stackName: string): string {
  const cdkOut = resolve(repoRoot, 'apps/platform-cdk/cdk.out');
  type Entry = { type: string; data: unknown };
  type Artifact = {
    type: string;
    properties?: { stackName?: string; templateFile?: string; directoryName?: string };
    metadata?: Record<string, Entry[]>;
  };
  const top = JSON.parse(readFileSync(join(cdkOut, 'manifest.json'), 'utf8')) as {
    artifacts: Record<string, Artifact>;
  };
  const assemblies = [cdkOut];
  for (const a of Object.values(top.artifacts)) {
    if (a.type === 'cdk:cloud-assembly' && a.properties?.directoryName)
      assemblies.push(join(cdkOut, a.properties.directoryName));
  }
  for (const dir of assemblies) {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      artifacts: Record<string, Artifact>;
    };
    const match = Object.entries(manifest.artifacts).find(
      ([id, a]) =>
        a.type === 'aws:cloudformation:stack' &&
        (a.properties?.stackName === stackName || id === stackName),
    );
    if (!match) continue;
    const [artifactId, artifact] = match;
    const metaFile = join(dir, `${artifactId}.metadata.json`);
    const raw: Record<string, Entry[]> = { ...(artifact.metadata ?? {}) };
    if (existsSync(metaFile)) {
      const doc = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
      Object.assign(raw, (doc['metadata'] as Record<string, Entry[]> | undefined) ?? doc);
    }
    const keys = Object.keys(raw).map((k) => k.replace(/^\/+/, ''));
    const stackPath = keys.sort((a, b) => a.length - b.length)[0] ?? '';
    const flat = (path: string): string => {
      const local = path.replace(/^\/+/, '');
      const rel = local.startsWith(`${stackPath}/`) ? local.slice(stackPath.length + 1) : local;
      return rel
        .split('/')
        .filter((x) => x !== 'Resource' && x !== 'Default')
        .join('_');
    };
    const metadata: Record<string, Entry[]> = {};
    const push = (key: string, entry: Entry) => {
      (metadata[key] ??= []).push(entry);
    };
    for (const [key, entries] of Object.entries(raw)) {
      const local = key.replace(/^\/+/, '');
      if (local === stackPath) continue;
      const segments = local.slice(stackPath.length + 1).split('/');
      const isResource = segments.at(-1) === 'Resource' || segments.at(-1) === 'Default';
      const cid = flat(local);
      const base = `/${stackName}/${cid}`;
      for (const e of entries) {
        if (e.type === 'aws:cdk:logicalId') push(isResource ? `${base}/Resource` : base, e);
        else if (e.type === 'Show' || e.type === 'Label') push(base, e);
        else if (e.type === 'paas:connection' && typeof e.data === 'string') {
          const [target] = e.data.split('|');
          push(base, { type: 'Connection', data: flat(target ?? '') });
        } else if (e.type === 'paas:container' && typeof e.data === 'string') {
          push(base, { type: 'Container', data: flat(e.data) });
        }
      }
    }
    const compatRoot = resolve(repoRoot, 'tools/diagrams/.cdk2d2-assembly');
    const compatOut = join(compatRoot, 'cdk.out');
    rmSync(compatRoot, { recursive: true, force: true });
    mkdirSync(compatOut, { recursive: true });
    cpSync(dir, compatOut, { recursive: true });
    const compat = { ...manifest, artifacts: { [stackName]: { ...artifact, metadata } } };
    writeFileSync(join(compatOut, 'manifest.json'), JSON.stringify(compat, null, 2));
    return compatRoot;
  }
  throw new Error(`stack ${stackName} not found in ${cdkOut}; run \`pnpm synth\` first`);
}

function main(): void {
  const stack = option('stack');
  if (!stack) {
    console.error('usage: pnpm diagrams:deployed --stack <stack-name> [--layout tala]');
    console.error(
      '  stack names: see `pnpm synth` output, e.g. paas-sandbox-paas-sandbox-cell-01-order-service',
    );
    process.exit(2);
  }
  const layout = option('layout', 'tala')!;
  const exe = ensureBinary();
  mkdirSync(outDir, { recursive: true });

  // cdk2d2 writes <stack>.d2 into the current working directory.
  console.log(`cdk2d2 generate ${stack} (polls CloudFormation; needs AWS credentials) ...`);
  const appDir = buildCompatAssembly(stack);
  const run = spawnSync(exe, ['generate', stack, appDir], {
    cwd: outDir,
    stdio: 'inherit',
    timeout: Number(option('timeout-ms', '120000')),
  });
  const d2File = join(outDir, `${stack}.d2`);
  if (run.status !== 0 || !existsSync(d2File) || statSync(d2File).size === 0) {
    console.error(
      `cdk2d2 produced no diagram for ${stack}. The stack must exist in the account your AWS credentials point to. ` +
        'Deploy first (`pnpm deploy:sandbox`) or use the offline generator (`pnpm diagrams`).',
    );
    process.exit(1);
  }
  // cdk2d2 v0.2.0 references a few icons on cdn.megaproaktiv.de, which no longer resolves; map
  // them to equivalent icons on icons.terrastruct.com so `d2` can bundle them.
  const ICON_FALLBACKS: Record<string, string> = {
    'https://cdn.megaproaktiv.de/img/icons/Arch_Amazon-DynamoDB_48.svg':
      'https://icons.terrastruct.com/aws%2FDatabase%2FAmazon-DynamoDB.svg',
    'https://cdn.megaproaktiv.de/img/icons/Res_Amazon-EventBridge_Rule_48_Light.svg':
      'https://icons.terrastruct.com/aws%2FApplication%20Integration%2FAmazon-EventBridge.svg',
  };
  let d2Source = readFileSync(d2File, 'utf8');
  for (const [from, to] of Object.entries(ICON_FALLBACKS)) d2Source = d2Source.split(from).join(to);
  d2Source = d2Source.replace(
    /https:\/\/cdn\.megaproaktiv\.de\/\S+/g,
    'https://icons.terrastruct.com/aws%2FApplication%20Integration%2FAmazon-EventBridge.svg',
  );
  writeFileSync(d2File, d2Source);
  console.log(`wrote ${d2File} (${d2Source.split('\n').length} lines)`);

  const svg = d2File.replace(/\.d2$/, '.svg');
  const render = spawnSync('d2', [`--layout=${layout}`, d2File, svg], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (render.status !== 0) {
    console.error(
      `d2 --layout=${layout} failed. Install D2 >= 0.9.0 (TALA bundled): https://d2lang.com/tour/install`,
    );
    process.exit(1);
  }
  console.log(`rendered ${svg} (layout: ${layout})`);
}

main();
