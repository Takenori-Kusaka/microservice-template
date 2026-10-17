import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { show } from './diagram.js';
import type { EnvironmentConfig } from './environment.js';
import type { ServiceManifest } from './service-manifest.js';

export interface IdempotencyTableProps {
  readonly manifest: ServiceManifest;
  readonly config: EnvironmentConfig;
}

/**
 * Persistence table for Powertools Idempotency (ADR-0014). Keys are built by the service as
 * `<tenantId>:<operation>:<idempotency-key>` (or `<tenantId>:<eventId>` for consumers), so a
 * key can never collide across tenants. Records expire via TTL (`expiration`).
 */
export class IdempotencyTable extends Construct {
  readonly table: dynamodb.TableV2;

  constructor(scope: Construct, id: string, props: IdempotencyTableProps) {
    super(scope, id);
    this.table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiration',
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.config.isProduction },
      encryption: dynamodb.TableEncryptionV2.awsManagedKey(),
      removalPolicy: props.config.removalPolicy,
      deletionProtection: props.config.isProduction,
    });
    show(this.table, `${props.manifest.serviceId}\nidempotency`);
  }

  /** Exactly the actions the Powertools DynamoDB persistence layer uses (no Scan/Query). */
  grant(grantee: iam.IGrantable): iam.Grant {
    return this.table.grant(
      grantee,
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
    );
  }
}
