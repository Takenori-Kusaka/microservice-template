import { describe, expect, it } from 'vitest';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { RemovalPolicy } from 'aws-cdk-lib';
import { applyPlatformGuardrails, RuntimeDeprecationAspect } from '../src/guardrails.js';
import { TenantAwareTable } from '../src/tenant-aware-table.js';
import { Aspects } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { productionDefaults, testManifest, testStack } from './fixtures.js';

describe('PlatformGuardrails', () => {
  it('flags wildcard IAM actions', () => {
    const { stack, config } = testStack();
    const role = new iam.Role(stack, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:*'], resources: ['*'] }));
    applyPlatformGuardrails(stack, { config, verbose: false });
    const errors = Annotations.fromStack(stack).findError('*', Match.anyValue());
    expect(errors.some((e) => JSON.stringify(e.entry.data).includes('IAM wildcard action'))).toBe(
      true,
    );
  });

  it('flags unauthenticated function URLs', () => {
    const { stack, config } = testStack();
    const fn = new lambda.Function(stack, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({})'),
    });
    fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    applyPlatformGuardrails(stack, { config, verbose: false });
    const errors = Annotations.fromStack(stack).findError('*', Match.anyValue());
    expect(errors.some((e) => JSON.stringify(e.entry.data).includes('Function URL'))).toBe(true);
  });

  it('flags destroyable stateful resources in production', () => {
    const { stack, config } = testStack(productionDefaults());
    new dynamodb.TableV2(stack, 'T', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    applyPlatformGuardrails(stack, { config, verbose: false });
    const errors = Annotations.fromStack(stack).findError('*', Match.anyValue());
    expect(errors.some((e) => JSON.stringify(e.entry.data).includes('DeletionPolicy Retain'))).toBe(
      true,
    );
  });

  it('rejects expired suppressions', () => {
    const { stack, config } = testStack();
    expect(() =>
      applyPlatformGuardrails(stack, {
        config,
        suppressions: [{ id: 'AwsSolutions-IAM5', reason: 'legacy', expires: '2020-01-01' }],
      }),
    ).toThrow(/expired/);
  });
});

describe('NoDynamoScanAspect / RuntimeDeprecationAspect', () => {
  it('flags dynamodb:Scan grants on pooled tables', () => {
    const { stack, config } = testStack();
    const role = new iam.Role(stack, 'ScanRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Scan'],
        resources: ['arn:aws:dynamodb:ap-northeast-1:123456789012:table/orders'],
      }),
    );
    applyPlatformGuardrails(stack, { config, verbose: false });
    const errors = Annotations.fromStack(stack).findError('*', Match.anyValue());
    expect(errors.some((e) => JSON.stringify(e.entry.data).includes('dynamodb:Scan'))).toBe(true);
  });

  it('TenantAwareTable grants never include Scan', () => {
    const { stack, config } = testStack();
    const table = new TenantAwareTable(stack, 'T', { manifest: testManifest, config });
    const role = new iam.Role(stack, 'R', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    table.grantReadWriteData(role);
    applyPlatformGuardrails(stack, { config, verbose: false });
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toEqual([]);
    const policy = JSON.stringify(Template.fromStack(stack).findResources('AWS::IAM::Policy'));
    expect(policy).not.toContain('dynamodb:Scan');
    expect(policy).toContain('dynamodb:Query');
  });

  it('warns when a Lambda runtime is within 180 days of deprecation', () => {
    const { stack } = testStack();
    new lambda.Function(stack, 'Old', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({})'),
    });
    // 2027-01-01 is 119 days before the nodejs22.x deprecation date (2027-04-30).
    Aspects.of(stack).add(new RuntimeDeprecationAspect(new Date('2027-01-01')));
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.anyValue());
    expect(warnings.some((w) => JSON.stringify(w.entry.data).includes('nodejs22.x'))).toBe(true);
  });
});
