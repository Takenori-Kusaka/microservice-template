/**
 * Generates JSON Schema documents for every registered event into schemas/events/.
 * `--check` fails when the committed files differ from the registry (CI contract gate).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EventEnvelopeSchema } from '../src/envelope.js';
import { eventCatalog } from '../src/catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../../schemas/events');
const check = process.argv.includes('--check');

function render(type: string): string {
  const definition = eventCatalog.get(type);
  if (!definition) throw new Error(`unknown type ${type}`);
  const envelope = z.toJSONSchema(EventEnvelopeSchema, { target: 'draft-2020-12' });
  const data = z.toJSONSchema(definition.dataSchema, { target: 'draft-2020-12' });
  const doc = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://schemas.paas.example/events/${type}.json`,
    title: type,
    description: definition.description,
    'x-paas-source': definition.source,
    ...envelope,
    properties: {
      ...(envelope as { properties: Record<string, unknown> }).properties,
      type: { const: type },
      source: { const: definition.source },
      data,
    },
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

mkdirSync(outDir, { recursive: true });
let drift = 0;
const expected = new Set<string>();
for (const type of eventCatalog.types()) {
  const file = join(outDir, `${type}.json`);
  expected.add(`${type}.json`);
  const next = render(type);
  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (current !== next) {
      console.error(`schema drift: ${file}`);
      drift++;
    }
  } else {
    writeFileSync(file, next);
    console.log(`wrote ${file}`);
  }
}
if (check) {
  for (const existing of readdirSync(outDir).filter((f) => f.endsWith('.json'))) {
    if (!expected.has(existing)) {
      console.error(`orphan schema (type no longer registered): ${existing}`);
      drift++;
    }
  }
  if (drift > 0) {
    console.error(
      `\n${drift} schema file(s) out of date. Run: pnpm --filter @paas/event-contracts generate`,
    );
    process.exit(1);
  }
  console.log('event schemas are up to date');
}
