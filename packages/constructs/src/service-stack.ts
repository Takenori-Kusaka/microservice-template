import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from './environment.js';
import { applyServiceTags, type ServiceManifest } from './service-manifest.js';

/** Deterministic names of the cell-level platform resources (no CloudFormation exports, §17). */
export interface PlatformNames {
  readonly eventBusName: string;
  readonly alarmTopicName: string;
}

export interface PlatformRefs {
  /** Shared cell event bus (control + data plane events). */
  readonly eventBus: events.IEventBus;
  readonly alarmTopic: sns.ITopic;
}

export interface ServiceStackProps extends StackProps {
  readonly manifest: ServiceManifest;
  readonly config: EnvironmentConfig;
  readonly platformNames: PlatformNames;
  /** Monorepo root for esbuild bundling. */
  readonly projectRoot: string;
}

/**
 * Base class for one microservice's stack (guideline §17 "Service Stack: 1マイクロサービスのAPI、
 * functions、workflow、queues、datastore、alarmsを所有"). Applies ownership tags and resolves the
 * platform references by name inside its own scope. Cross-stack references between service
 * stacks are discouraged: contracts are endpoints and event schemas, not CloudFormation exports.
 */
export abstract class ServiceStack extends Stack {
  readonly manifest: ServiceManifest;
  readonly config: EnvironmentConfig;
  readonly platform: PlatformRefs;
  readonly projectRoot: string;

  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, {
      ...props,
      description: `${props.manifest.serviceId} [${props.config.name}/${props.config.cellId}] owner=${props.manifest.ownerTeam}`,
      terminationProtection: props.config.isProduction,
    });
    this.manifest = props.manifest;
    this.config = props.config;
    this.projectRoot = props.projectRoot;
    this.platform = {
      eventBus: events.EventBus.fromEventBusName(
        this,
        'PlatformEventBus',
        props.platformNames.eventBusName,
      ),
      alarmTopic: sns.Topic.fromTopicArn(
        this,
        'PlatformAlarmTopic',
        this.formatArn({ service: 'sns', resource: props.platformNames.alarmTopicName }),
      ),
    };
    applyServiceTags(this, props.manifest, props.config.name);
    new CfnOutput(this, 'ServiceOwner', {
      value: `${props.manifest.ownerTeam} (${props.manifest.onCall})`,
    });
  }

  /** Shared bundling defaults for every function in this stack. */
  protected functionDefaults(): { projectRoot: string; depsLockFilePath: string } {
    return {
      projectRoot: this.projectRoot,
      depsLockFilePath: `${this.projectRoot}/pnpm-lock.yaml`,
    };
  }
}
