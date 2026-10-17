/** Fails when src/generated is out of date with schemas/openapi (CI contract gate). */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const spec = resolve(here, '../../../schemas/openapi/order-service.yaml');
const committed = resolve(here, '../src/generated/order-service.ts');
const tmp = mkdtempSync(join(tmpdir(), 'openapi-'));
const out = join(tmp, 'order-service.ts');
try {
  execFileSync('npx', ['openapi-typescript', spec, '-o', out, '--alphabetize'], {
    stdio: 'inherit',
    cwd: resolve(here, '..'),
    shell: process.platform === 'win32',
  });
  const a = readFileSync(committed, 'utf8').replace(/\r\n/g, '\n');
  const b = readFileSync(out, 'utf8').replace(/\r\n/g, '\n');
  if (a !== b) {
    console.error(
      'generated API types are out of date. Run: pnpm --filter @paas/api-contracts generate',
    );
    process.exit(1);
  }
  console.log('generated API types are up to date');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
