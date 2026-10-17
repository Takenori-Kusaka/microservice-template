/**
 * OpenAPI compatibility gate (guideline §6 "破壊的変更は新version", §18 "OpenAPI/event schemaの
 * breaking changeを検出する"). The committed baseline is the last released contract; a change
 * that removes a path/operation/response, or adds a required request property, fails CI until
 * the major version is bumped and the baseline is re-captured.
 *
 * Re-capture after an intentional, versioned change:
 *   cp schemas/openapi/order-service.yaml tests/contract/baseline/order-service.yaml
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CreateOrderRequestSchema } from '@paas/api-contracts';

const root = resolve(__dirname, '../..');
type Doc = {
  info: { version: string };
  paths: Record<
    string,
    Record<string, { responses: Record<string, unknown>; requestBody?: unknown }>
  >;
  components: {
    schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
  };
};

const current = parse(
  readFileSync(join(root, 'schemas/openapi/order-service.yaml'), 'utf8'),
) as Doc;
const baseline = parse(
  readFileSync(join(root, 'tests/contract/baseline/order-service.yaml'), 'utf8'),
) as Doc;

function majorOf(v: string): number {
  return Number(v.split('.')[0]);
}

describe('order-service OpenAPI compatibility', () => {
  const sameMajor = majorOf(current.info.version) === majorOf(baseline.info.version);

  it('does not remove paths, operations or response codes within a major version', () => {
    if (!sameMajor) return;
    for (const [path, ops] of Object.entries(baseline.paths)) {
      expect(current.paths[path], `path ${path} removed`).toBeDefined();
      for (const [method, op] of Object.entries(ops)) {
        const now = current.paths[path]?.[method];
        expect(now, `${method.toUpperCase()} ${path} removed`).toBeDefined();
        for (const code of Object.keys(op.responses)) {
          expect(
            now?.responses[code],
            `${method.toUpperCase()} ${path} lost response ${code}`,
          ).toBeDefined();
        }
      }
    }
  });

  it('does not add required request properties or remove response properties within a major version', () => {
    if (!sameMajor) return;
    for (const [name, schema] of Object.entries(baseline.components.schemas)) {
      const now = current.components.schemas[name];
      expect(now, `schema ${name} removed`).toBeDefined();
      const addedRequired = (now?.required ?? []).filter(
        (r) => !(schema.required ?? []).includes(r),
      );
      if (name.endsWith('Request')) {
        expect(
          addedRequired,
          `${name} gained required properties ${addedRequired.join(', ')}`,
        ).toEqual([]);
      } else {
        for (const prop of Object.keys(schema.properties ?? {})) {
          expect(now?.properties?.[prop], `${name}.${prop} removed`).toBeDefined();
        }
      }
    }
  });

  it('runtime validation schema matches the OpenAPI CreateOrderRequest', () => {
    const openapi = current.components.schemas['CreateOrderRequest']!;
    const zodShape = Object.keys(CreateOrderRequestSchema.shape);
    expect(zodShape.sort()).toEqual(Object.keys(openapi.properties ?? {}).sort());
    const zodRequired = Object.entries(CreateOrderRequestSchema.shape)
      .filter(
        ([, v]) =>
          !(v as { safeParse: (x: unknown) => { success: boolean } }).safeParse(undefined).success,
      )
      .map(([k]) => k)
      .sort();
    expect(zodRequired).toEqual([...(openapi.required ?? [])].sort());
  });
});
