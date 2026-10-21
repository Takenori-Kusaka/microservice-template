import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import { PlatformDetection, show, type EnvironmentConfig } from '@paas/constructs';

export interface PlatformStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  /** Opt-in detection baseline (CloudTrail data events, GuardDuty, Security Hub) — ADR-0026. */
  readonly detection?: { enabled: boolean; guardDuty?: boolean; securityHub?: boolean };
}

/** Deterministic names let service stacks discover platform resources without CFN exports (§17). */
export function platformNames(config: EnvironmentConfig): {
  eventBusName: string;
  alarmTopicName: string;
} {
  return {
    eventBusName: `paas-${config.name}-${config.cellId}-bus`,
    alarmTopicName: `paas-${config.name}-${config.cellId}-alarms`,
  };
}

/**
 * Cell-level platform resources shared by every service in the cell: the event bus (with a
 * replayable archive), the alarm topic and a KMS key for restricted data. Control-plane
 * services (tenant registry, cell router) would also live here in later phases (§5 Phase 2).
 */
export class PlatformStack extends Stack {
  readonly eventBus: events.EventBus;
  readonly alarmTopic: sns.Topic;
  /** Customer-managed key for restricted data. Only created in staging/production: a CMK has a fixed monthly charge, and no sandbox service declares dataClassification=restricted. */
  readonly dataKey?: kms.Key;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, {
      ...props,
      description: `PaaS platform resources [${props.config.name}/${props.config.cellId}] owner=platform-team`,
      terminationProtection: props.config.isProduction,
    });
    const names = platformNames(props.config);

    if (props.config.isProduction || props.config.name === 'staging') {
      this.dataKey = new kms.Key(this, 'DataKey', {
        description: `paas ${props.config.name} ${props.config.cellId} restricted-data key`,
        enableKeyRotation: true,
        removalPolicy: props.config.removalPolicy,
      });
    }

    this.eventBus = new events.EventBus(this, 'EventBus', { eventBusName: names.eventBusName });
    // Archive enables replay for recovery; consumers must be idempotent (ADR-0013/0014).
    this.eventBus.archive('Archive', {
      archiveName: `${names.eventBusName}-archive`,
      retention: Duration.days(props.config.isProduction ? 90 : 7),
      eventPattern: { account: [this.account] },
    });

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: names.alarmTopicName,
      displayName: `PaaS alarms ${props.config.name}/${props.config.cellId}`,
      enforceSSL: true,
    });
    if (props.config.alarmEmail) {
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.config.alarmEmail));
    }

    show(this.eventBus, 'cell event bus');
    show(this.alarmTopic, 'alarm topic');
    new CfnOutput(this, 'EventBusName', { value: this.eventBus.eventBusName });
    if (props.detection?.enabled) {
      new PlatformDetection(this, 'Detection', {
        config: props.config,
        alarmTopic: this.alarmTopic,
        enableGuardDuty: props.detection.guardDuty ?? false,
        enableSecurityHub: props.detection.securityHub ?? false,
      });
    }
    new CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn });
  }
}
