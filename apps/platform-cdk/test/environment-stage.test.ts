import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { EnvironmentStage } from '../lib/environment-stage.js';
import { environmentConfig } from '../lib/environments.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function synth(env: 'sandbox' | 'production') {
  // Bundling is skipped in unit tests; `pnpm synth` exercises esbuild for real.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  process.env['CDK_DEFAULT_ACCOUNT'] = '123456789012';
  const stage = new EnvironmentStage(app, `paas-${env}`, {
    config: environmentConfig(env, 'cell-01'),
    projectRoot,
  });
  app.synth();
  return stage;
}

describe('EnvironmentStage', () => {
  it('synthesizes the sandbox cell with zero guardrail errors', () => {
    const stage = synth('sandbox');
    const stacks = [
      stage.platform,
      stage.services.order,
      stage.services.worker,
      stage.services.workflow,
    ];
    for (const stack of stacks) {
      const errors = Annotations.fromStack(stack).findError('*', Match.anyValue());
      expect(errors.map((e) => `${e.id}: ${JSON.stringify(e.entry.data)}`)).toEqual([]);
    }
  });

  it('wires the order API, outbox relay, consumers and workflow', () => {
    const stage = synth('sandbox');
    const order = Template.fromStack(stage.services.order);
    order.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    order.resourceCountIs('AWS::ApiGatewayV2::Route', 3);
    order.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FilterCriteria: {
        Filters: [
          {
            Pattern:
              '{"eventName":["INSERT"],"dynamodb":{"NewImage":{"entityType":{"S":["OUTBOX"]}}}}',
          },
        ],
      },
    });
    const worker = Template.fromStack(stage.services.worker);
    worker.resourceCountIs('AWS::Events::Rule', 2);
    worker.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        'detail-type': ['order.created.v1'],
        detail: { tenantTier: ['premium', 'enterprise'] },
      },
    });
    const workflow = Template.fromStack(stage.services.workflow);
    workflow.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    workflow.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: { 'detail-type': ['tenant.provisioning-requested.v1'] },
    });
  });

  it('production retains stateful resources and uses canary deployments', () => {
    const stage = synth('production');
    const order = Template.fromStack(stage.services.order);
    order.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
    order.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: 'CodeDeployDefault.LambdaCanary10Percent5Minutes',
    });
    expect(Annotations.fromStack(stage.services.order).findError('*', Match.anyValue())).toEqual(
      [],
    );
  });
});
