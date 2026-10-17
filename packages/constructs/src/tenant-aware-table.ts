import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { show } from './diagram.js';
import type { EnvironmentConfig } from './environment.js';
import type { ServiceManifest } from './service-manifest.js';

export interface TenantAwareTableProps {
  readonly manifest: ServiceManifest;
  readonly config: EnvironmentConfig;
  /** Customer-managed key; required when dataClassification is `restricted`. */
  readonly encryptionKey?: kms.IKey;
  /** Enables DynamoDB Streams (NEW_AND_OLD_IMAGES) for the outbox relay / CDC. */
  readonly stream?: boolean;
  readonly timeToLiveAttribute?: string;
  readonly globalSecondaryIndexes?: dynamodb.GlobalSecondaryIndexPropsV2[];
}

/**
 * Pooled multi-tenant DynamoDB table (guideline §5 Phase 1 "DynamoDBの`tenantId`先頭キー",
 * §9, §13). Key schema is fixed: pk = `TENANT#<tenantId>`, sk = `<ENTITY>#<id>`. The
 * repository adapter in @paas/* services is the only code allowed to build keys, so the
 * tenant prefix cannot be omitted by accident.
 *
 * Stateful-resource safety (§17): RETAIN + deletion protection in production, PITR always on.
 */
export class TenantAwareTable extends Construct {
  static readonly PARTITION_KEY = 'pk';
  static readonly SORT_KEY = 'sk';

  readonly table: dynamodb.TableV2;

  constructor(scope: Construct, id: string, props: TenantAwareTableProps) {
    super(scope, id);
    const { manifest, config } = props;

    if (manifest.dataClassification === 'restricted' && !props.encryptionKey) {
      throw new Error(
        `${manifest.serviceId}: dataClassification=restricted requires a customer-managed KMS key (encryptionKey)`,
      );
    }

    this.table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: TenantAwareTable.PARTITION_KEY, type: dynamodb.AttributeType.STRING },
      sortKey: { name: TenantAwareTable.SORT_KEY, type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: props.encryptionKey
        ? dynamodb.TableEncryptionV2.customerManagedKey(props.encryptionKey)
        : dynamodb.TableEncryptionV2.awsManagedKey(),
      removalPolicy: config.removalPolicy,
      deletionProtection: config.isProduction,
      // Contributor Insights is billed per event; enable only where tenant-level hot-key analysis is needed.
      contributorInsights: config.isProduction,
      ...(props.stream ? { dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES } : {}),
      ...(props.timeToLiveAttribute ? { timeToLiveAttribute: props.timeToLiveAttribute } : {}),
      ...(props.globalSecondaryIndexes
        ? { globalSecondaryIndexes: props.globalSecondaryIndexes }
        : {}),
    });

    this.table.node.addMetadata('paas:tenant-isolation', manifest.tenantIsolationModel);
    show(this.table, `${manifest.serviceId}\ntable`);
  }

  /**
   * Key-scoped read actions only. `dynamodb:Scan` is deliberately excluded: the IAM
   * `dynamodb:LeadingKeys` condition cannot constrain Scan, so a Scan permission on a pooled
   * table is a cross-tenant read path (AWS IAM condition keys for DynamoDB; ADR-0004/ADR-0012).
   * `NoDynamoScanAspect` fails synth if any role in the stack is granted Scan.
   */
  static readonly READ_ACTIONS = [
    'dynamodb:GetItem',
    'dynamodb:BatchGetItem',
    'dynamodb:Query',
    'dynamodb:ConditionCheckItem',
    'dynamodb:DescribeTable',
  ];
  static readonly WRITE_ACTIONS = [
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'dynamodb:DeleteItem',
    'dynamodb:BatchWriteItem',
  ];

  /** Read/write for the owning service only (cross-service table access is forbidden, §4). */
  grantReadWriteData(grantee: iam.IGrantable): iam.Grant {
    return this.table.grant(
      grantee,
      ...TenantAwareTable.READ_ACTIONS,
      ...TenantAwareTable.WRITE_ACTIONS,
    );
  }

  grantReadData(grantee: iam.IGrantable): iam.Grant {
    return this.table.grant(grantee, ...TenantAwareTable.READ_ACTIONS);
  }

  grantStreamRead(grantee: iam.IGrantable): iam.Grant {
    return this.table.grantStreamRead(grantee);
  }
}
