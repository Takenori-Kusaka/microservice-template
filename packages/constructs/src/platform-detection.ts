import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as securityhub from 'aws-cdk-lib/aws-securityhub';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { show } from './diagram.js';
import type { EnvironmentConfig } from './environment.js';

export interface PlatformDetectionProps {
  readonly config: EnvironmentConfig;
  readonly alarmTopic: sns.ITopic;
  /**
   * GuardDuty and Security Hub are account/region singletons. In an account where the
   * security team already runs them (delegated administrator, organization trail), leave these
   * false and only the cell-scoped CloudTrail data events + finding routing are created.
   */
  readonly enableGuardDuty?: boolean;
  readonly enableSecurityHub?: boolean;
  /** Retention of CloudTrail objects in days (TD-31 証拠保持). */
  readonly trailRetentionDays?: number;
}

/**
 * Detection & traceability baseline for one cell (guideline ch.21 §21.4 / §21.5, ADR-0026):
 *  - CloudTrail trail with log file validation, management events (read+write) and DATA events
 *    for every DynamoDB table and Lambda function in the account/region, delivered to a
 *    dedicated versioned, encrypted, Object-Lock-enabled bucket (chain of custody);
 *  - GuardDuty detector with Lambda Protection (LAMBDA_NETWORK_LOGS) — opt-in;
 *  - Security Hub enablement — opt-in;
 *  - EventBridge routing of GuardDuty findings with severity >= 7 (High/Critical) to the alarm topic.
 *
 * Deploy only with `--context detection=true`: in a shared production account the singletons
 * may already exist and CloudTrail data events are billed per event (AWS CloudTrail pricing).
 */
export class PlatformDetection extends Construct {
  readonly trailBucket: s3.Bucket;
  readonly trail: cloudtrail.Trail;
  readonly detector?: guardduty.CfnDetector;
  readonly hub?: securityhub.CfnHub;

  constructor(scope: Construct, id: string, props: PlatformDetectionProps) {
    super(scope, id);
    const { config } = props;
    const stack = Stack.of(this);

    this.trailBucket = new s3.Bucket(this, 'TrailBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      objectLockEnabled: true, // retention rules can be applied without recreating the bucket
      removalPolicy: config.isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !config.isProduction,
      lifecycleRules: [
        {
          id: 'evidence-retention',
          expiration: Duration.days(props.trailRetentionDays ?? 365),
          noncurrentVersionExpiration: Duration.days(props.trailRetentionDays ?? 365),
        },
      ],
    });

    this.trail = new cloudtrail.Trail(this, 'Trail', {
      bucket: this.trailBucket,
      enableFileValidation: true,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: false,
      managementEvents: cloudtrail.ReadWriteType.ALL,
      sendToCloudWatchLogs: false,
      trailName: `paas-${config.name}-${config.cellId}-trail`,
    });
    // Data events: item-level DynamoDB access and Lambda invocations for forensics (§21.5).
    this.trail.addEventSelector(
      'AWS::DynamoDB::Table' as cloudtrail.DataResourceType,
      [
        `arn:${stack.partition}:dynamodb:${stack.region}:${stack.account}:table/paas-${config.name}-*`,
      ],
      { readWriteType: cloudtrail.ReadWriteType.ALL },
    );
    this.trail.addEventSelector(
      cloudtrail.DataResourceType.LAMBDA_FUNCTION,
      [
        `arn:${stack.partition}:lambda:${stack.region}:${stack.account}:function:paas-${config.name}-*`,
      ],
      { readWriteType: cloudtrail.ReadWriteType.ALL },
    );

    if (props.enableGuardDuty) {
      this.detector = new guardduty.CfnDetector(this, 'Detector', {
        enable: true,
        findingPublishingFrequency: 'FIFTEEN_MINUTES',
        features: [
          { name: 'LAMBDA_NETWORK_LOGS', status: 'ENABLED' },
          { name: 'S3_DATA_EVENTS', status: 'ENABLED' },
        ],
      });
    }

    if (props.enableSecurityHub) {
      this.hub = new securityhub.CfnHub(this, 'Hub', {
        enableDefaultStandards: true,
        controlFindingGenerator: 'SECURITY_CONTROL',
      });
    }

    // GuardDuty publishes findings to the default event bus; route High/Critical to on-call.
    new events.Rule(this, 'GuardDutyHighSeverity', {
      description: 'GuardDuty findings with severity >= 7 (High/Critical) → alarm topic',
      eventPattern: {
        source: ['aws.guardduty'],
        detailType: ['GuardDuty Finding'],
        detail: { severity: [{ numeric: ['>=', 7] }] },
      },
      targets: [new targets.SnsTopic(props.alarmTopic)],
    });

    show(this.trail, 'CloudTrail\n(management + data events)');
  }
}
