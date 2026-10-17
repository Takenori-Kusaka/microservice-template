import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generate } from '../src/cli.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'create-service-'));
  mkdirSync(join(root, 'docs/adr'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('create-service', () => {
  for (const type of ['api', 'worker', 'workflow'] as const) {
    it(`generates a ${type} service with manifest, stack, handler, runbook, threat model and ADR`, () => {
      const files = generate(
        {
          serviceId: 'invoice-service',
          pascal: 'Invoice',
          domain: 'billing',
          ownerTeam: 'billing-team',
          type,
          today: '2026-10-17',
        },
        { dryRun: false, root },
      );
      expect(files).toContain('apps/invoice-service/service.yaml');
      expect(files.some((f) => f.startsWith('docs/adr/ADR-0001-invoice-service'))).toBe(true);
      const manifest = readFileSync(join(root, 'apps/invoice-service/service.yaml'), 'utf8');
      expect(manifest).toContain('ownerTeam: billing-team');
      expect(manifest).toContain('runbook: docs/runbooks/invoice-service.md');
    });
  }
});
