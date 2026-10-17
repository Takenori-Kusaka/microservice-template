import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDiagrams, toD2 } from '../src/cdk2d2.js';

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'cdkout-'));
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'manifest.json'),
    JSON.stringify({
      artifacts: {
        'paas-sandbox-order': {
          type: 'aws:cloudformation:stack',
          properties: { templateFile: 'order.template.json' },
          metadata: {
            '/paas-sandbox-order/Api/HttpApi': [
              { type: 'Show', data: 'true' },
              { type: 'Label', data: 'order-service\nHTTP API' },
              {
                type: 'paas:connection',
                data: '/paas-sandbox-order/Api/FnCreateOrder/Function|POST /orders',
              },
            ],
            '/paas-sandbox-order/Api/HttpApi/Resource': [
              { type: 'aws:cdk:logicalId', data: 'ApiHttpApi1' },
            ],
            '/paas-sandbox-order/Api/FnCreateOrder/Function': [
              { type: 'Show', data: 'true' },
              { type: 'paas:connection', data: '/paas-sandbox-platform/EventBus' },
            ],
            '/paas-sandbox-order/Api/FnCreateOrder/Function/Resource': [
              { type: 'aws:cdk:logicalId', data: 'Fn1' },
            ],
          },
        },
      },
    }),
  );
  writeFileSync(
    join(out, 'order.template.json'),
    JSON.stringify({
      Resources: {
        ApiHttpApi1: { Type: 'AWS::ApiGatewayV2::Api' },
        Fn1: { Type: 'AWS::Lambda::Function' },
      },
    }),
  );
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

describe('cdk2d2', () => {
  it('maps Show/Connection/Label metadata to D2 nodes and edges with resource shapes', () => {
    const diagrams = buildDiagrams(out);
    expect(diagrams[0]?.nodes.map((n) => n.resourceType)).toEqual([
      'AWS::ApiGatewayV2::Api',
      'AWS::Lambda::Function',
    ]);
    const d2 = toD2(diagrams);
    expect(d2).toContain('shape: cloud');
    expect(d2).toContain('shape: hexagon');
    expect(d2).toContain(
      '-> paas_sandbox_order.paas_sandbox_order_Api_FnCreateOrder_Function: "POST /orders"',
    );
    // Unresolved target (imported bus in another stack) is drawn as external.
    expect(d2).toContain('external.EventBus');
  });
});
