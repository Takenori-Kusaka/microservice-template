import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';
import {
  ExperimentalWebFunction,
  TenantAwareTable,
  applyServiceTags,
  type EnvironmentConfig,
} from '@paas/constructs';
import { orderServiceManifest } from './order-service-stack.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface OrderWebExperimentalStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  /** Name of the order table owned by OrderServiceStack (same data, different compute). */
  readonly ordersTableName: string;
  /** Directory with the pre-bundled web server (`pnpm --filter @paas/example-order-service build:web`). */
  readonly codeDirectory?: string;
}

/**
 * EXPERIMENTAL comparison stack for ADR-0006: the Order API served by a Lambda Web Function with
 * the same business logic and the same table. Opt-in only:
 *   pnpm synth --context env=sandbox --context experimentalWeb=true
 */
export class OrderWebExperimentalStack extends Stack {
  readonly webFunction: ExperimentalWebFunction;

  constructor(scope: Construct, id: string, props: OrderWebExperimentalStackProps) {
    super(scope, id, {
      ...props,
      description: 'order-service experimental Web Function (ADR-0006 benchmark)',
    });
    const manifest = { ...orderServiceManifest, runtimeProfile: 'experimental-web' as const };
    applyServiceTags(this, manifest, props.config.name);

    const table = dynamodb.TableV2.fromTableName(this, 'OrdersTable', props.ordersTableName);
    this.webFunction = new ExperimentalWebFunction(this, 'OrderWeb', {
      manifest,
      config: props.config,
      codeDirectory: props.codeDirectory ?? resolve(here, '../dist/web'),
      maxConcurrencyPerEnvironment: 32, // pooled tenants: cap per-environment sharing (§5.6 noisy neighbour)
      timeout: Duration.seconds(30),
      environment: { ORDERS_TABLE_NAME: table.tableName, PAAS_REQUEST_TIMEOUT_MS: '30000' },
      authType: 'IamAuth',
    });
    // Key-scoped actions only (no Scan), same policy as TenantAwareTable.
    table.grant(
      this.webFunction.role,
      ...TenantAwareTable.READ_ACTIONS,
      ...TenantAwareTable.WRITE_ACTIONS,
    );
  }
}
