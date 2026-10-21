import { Stage, type StageProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { applyPlatformGuardrails, suppressNag, type EnvironmentConfig } from '@paas/constructs';
import { OrderServiceStack } from '@paas/example-order-service/infra';
import { OrderWebExperimentalStack } from '@paas/example-order-service/infra/web';
import { WorkerServiceStack } from '@paas/example-worker-service/infra';
import { WorkflowServiceStack } from '@paas/example-workflow-service/infra';
import { PlatformStack, platformNames } from './platform-stack.js';

export interface EnvironmentStageProps extends StageProps {
  readonly config: EnvironmentConfig;
  readonly projectRoot: string;
  /**
   * Opt-in ADR-0006 benchmark stack (Lambda Web Function serving the order API). Never enabled
   * in production; requires `pnpm --filter @paas/example-order-service build:web` first.
   */
  readonly experimentalWeb?: boolean;
  /** ADR-0026 detection baseline; opt-in because GuardDuty/Security Hub are account singletons. */
  readonly detection?: { enabled: boolean; guardDuty?: boolean; securityHub?: boolean };
}

/**
 * Environment stage (guideline §17): one AWS account/region, one cell (Phase 1), platform stack
 * first, then one stack per microservice. Adding a cell = instantiating this composition again
 * with another cellId (Phase 2). Service stacks discover platform resources by deterministic
 * name, so there are no CloudFormation exports between stacks.
 */
export class EnvironmentStage extends Stage {
  readonly platform: PlatformStack;
  /** Present only with `experimentalWeb=true` outside production (ADR-0006 benchmark). */
  readonly web?: OrderWebExperimentalStack;
  readonly services: {
    order: OrderServiceStack;
    worker: WorkerServiceStack;
    workflow: WorkflowServiceStack;
  };

  constructor(scope: Construct, id: string, props: EnvironmentStageProps) {
    super(scope, id, {
      ...props,
      env: {
        region: props.config.region,
        ...(props.config.account ? { account: props.config.account } : {}),
      },
    });
    const { config, projectRoot } = props;
    const prefix = `paas-${config.name}-${config.cellId}`;
    const names = platformNames(config);

    this.platform = new PlatformStack(this, `${prefix}-platform`, {
      config,
      ...(props.detection ? { detection: props.detection } : {}),
    });
    const order = new OrderServiceStack(this, `${prefix}-order-service`, {
      config,
      projectRoot,
      platformNames: names,
    });
    const worker = new WorkerServiceStack(this, `${prefix}-fulfillment-worker-service`, {
      config,
      projectRoot,
      platformNames: names,
    });
    const workflow = new WorkflowServiceStack(this, `${prefix}-provisioning-workflow-service`, {
      config,
      projectRoot,
      platformNames: names,
    });
    for (const stack of [order, worker, workflow]) stack.addStackDependency(this.platform);
    this.services = { order, worker, workflow };

    if (props.experimentalWeb && !config.isProduction) {
      const web = new OrderWebExperimentalStack(this, `${prefix}-order-web-experimental`, {
        config,
        ordersTableName: order.table.table.tableName,
      });
      web.addStackDependency(order);
      this.web = web;
    }

    applyPlatformGuardrails(this, { config, verbose: true });
    this.applyKnownSuppressions();
  }

  /**
   * Suppressions are deliberate, documented exceptions (§20). Each one names the reason; the
   * list is reviewed at the quarterly architecture review.
   */
  private applyKnownSuppressions(): void {
    const stacks = [
      this.platform,
      this.services.order,
      this.services.worker,
      this.services.workflow,
    ];
    for (const stack of stacks) {
      suppressNag(stack, [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Wildcards are limited to resource sub-paths (log streams, table indexes, alias versions) and are validated by NoWildcardIamAspect.',
        },
        {
          id: 'AwsSolutions-SQS3',
          reason: 'Dead-letter queues are terminal by design and alarmed (PavedQueueConsumer).',
        },
        {
          id: 'AwsSolutions-APIG4',
          reason:
            'All routes use the default JWT/Lambda authorizer; cdk-nag inspects routes individually.',
        },
        {
          id: 'AwsSolutions-APIG1',
          reason: 'Access logging is configured on the stage via CfnStage escape hatch.',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Runtime pinned to Node.js 22 LTS by policy; upgraded through ADR-0008 review.',
        },
        {
          id: 'AwsSolutions-SF1',
          reason:
            'Execution data is excluded from logs by the PII policy; events are logged at ALL level.',
        },
        {
          id: 'AwsSolutions-SNS2',
          reason:
            'Alarm topic carries no customer data; SSE enabled in Phase 2 with the platform CMK.',
        },
        {
          id: 'AwsSolutions-SNS3',
          reason: 'enforceSSL is set; rule false positive on imported topics.',
        },
      ]);
    }
    if (this.web) {
      suppressNag(this.web, [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'BucketDeployment singleton function (CDK-managed) uses AWSLambdaBasicExecutionRole; it only copies the Web Function zip into the versioned code bucket.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'BucketDeployment needs object wildcards on the asset bucket and the code bucket; the Web Function execution role is suppressed per path in ExperimentalWebFunction.',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'BucketDeployment singleton runtime is chosen by aws-cdk-lib.',
        },
        {
          id: 'AwsSolutions-S1',
          reason:
            'Code bucket holds only the deployment package; access is audited through CloudTrail data events (ADR-0026), not server access logs.',
        },
      ]);
    }
  }
}
