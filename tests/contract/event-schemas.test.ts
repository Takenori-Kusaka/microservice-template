/**
 * Contract gate for events (guideline §7 "schema registryと互換性テストをCIへ入れる", ADR-0013):
 *  - every registered event has a committed JSON Schema under schemas/events/;
 *  - the committed schema's `type`/`source` constants match the registry;
 *  - producers declare the events they publish in service.yaml, consumers the ones they consume;
 *  - every consumed event has exactly one producer (no orphan subscriptions).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { eventCatalog } from '@paas/event-contracts';

const root = resolve(__dirname, '../..');
const schemasDir = join(root, 'schemas/events');
const appsDir = join(root, 'apps');

interface Manifest {
  serviceId: string;
  publishedEvents?: string[];
  consumedEvents?: string[];
}

function manifests(): Manifest[] {
  return readdirSync(appsDir)
    .map((d) => join(appsDir, d, 'service.yaml'))
    .filter((f) => existsSync(f))
    .map((f) => parse(readFileSync(f, 'utf8')) as Manifest);
}

describe('event contracts', () => {
  for (const type of eventCatalog.types()) {
    it(`${type} has a committed, matching JSON Schema`, () => {
      const file = join(schemasDir, `${type}.json`);
      expect(existsSync(file), `missing ${file}; run pnpm schemas:generate`).toBe(true);
      const schema = JSON.parse(readFileSync(file, 'utf8')) as {
        properties: { type: { const: string }; source: { const: string } };
      };
      expect(schema.properties.type.const).toBe(type);
      expect(schema.properties.source.const).toBe(eventCatalog.get(type)?.source);
    });
  }

  it('every published/consumed event in service.yaml is registered, and every consumed event has one producer', () => {
    const all = manifests();
    const producers = new Map<string, string[]>();
    for (const m of all) {
      for (const t of m.publishedEvents ?? []) {
        expect(eventCatalog.get(t), `${m.serviceId} publishes unregistered ${t}`).toBeDefined();
        expect(
          eventCatalog.get(t)?.source,
          `${m.serviceId} is not the registered source of ${t}`,
        ).toBe(m.serviceId);
        producers.set(t, [...(producers.get(t) ?? []), m.serviceId]);
      }
    }
    for (const m of all) {
      for (const t of m.consumedEvents ?? []) {
        expect(eventCatalog.get(t), `${m.serviceId} consumes unregistered ${t}`).toBeDefined();
        const p = producers.get(t) ?? [];
        // The control plane (tenant.provisioning-requested.v1) is outside apps/ in Phase 1.
        if (eventCatalog.get(t)?.source !== 'tenant-control-plane') {
          expect(p.length, `${t} consumed by ${m.serviceId} has ${p.length} producers`).toBe(1);
        }
      }
    }
  });
});
