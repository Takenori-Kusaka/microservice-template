import { Annotations, Aspects, type IAspect, Stack, CfnResource, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import type { IConstruct } from 'constructs';
import type { EnvironmentConfig } from './environment.js';

/**
 * Policy-as-code at synth time (guideline §17: "CDK synth時にcdk-nag、IAM wildcard、public
 * exposure、unencrypted storage、missing alarmsを検査する"). Errors fail `cdk synth`, which is the
 * CI "policy" stage.
 */

/** Actions that legitimately require Resource "*" (no resource-level permissions). */
const WILDCARD_RESOURCE_ALLOWED_ACTIONS = new Set([
  'xray:PutTraceSegments',
  'xray:PutTelemetryRecords',
  'xray:GetSamplingRules',
  'xray:GetSamplingTargets',
  'cloudwatch:PutMetricData',
  'logs:CreateLogGroup',
  'logs:DescribeLogGroups',
  'logs:CreateLogDelivery',
  'logs:GetLogDelivery',
  'logs:UpdateLogDelivery',
  'logs:DeleteLogDelivery',
  'logs:ListLogDeliveries',
  'logs:PutResourcePolicy',
  'logs:DescribeResourcePolicies',
  'lambda:GetFunction',
  'lambda:UpdateFunctionConfiguration',
]);

export class NoWildcardIamAspect implements IAspect {
  visit(node: IConstruct): void {
    if (!(
      node instanceof iam.CfnPolicy ||
      node instanceof iam.CfnRole ||
      node instanceof iam.CfnManagedPolicy
    ))
      return;
    const stack = Stack.of(node);
    const documents: unknown[] = [];
    if (node instanceof iam.CfnPolicy || node instanceof iam.CfnManagedPolicy) {
      documents.push(stack.resolve(node.policyDocument));
    } else {
      const policies = stack.resolve(node.policies) as { policyDocument?: unknown }[] | undefined;
      for (const p of policies ?? []) documents.push(p.policyDocument);
    }
    for (const doc of documents) {
      const statements = ((doc as { Statement?: unknown[] } | undefined)?.Statement ?? []) as {
        Effect?: string;
        Action?: string | string[];
        Resource?: unknown;
      }[];
      for (const st of statements) {
        if (st.Effect !== 'Allow') continue;
        const actionList = Array.isArray(st.Action) ? st.Action : st.Action ? [st.Action] : [];
        const resources = Array.isArray(st.Resource) ? st.Resource : [st.Resource];
        if (actionList.some((a) => a === '*' || a.endsWith(':*'))) {
          Annotations.of(node).addError(
            `IAM wildcard action in ${node.node.path}: ${actionList.join(', ')}`,
          );
        }
        const hasStarResource = resources.some((r) => r === '*');
        if (hasStarResource && !actionList.every((a) => WILDCARD_RESOURCE_ALLOWED_ACTIONS.has(a))) {
          Annotations.of(node).addError(
            `IAM Resource "*" in ${node.node.path} for actions ${actionList.join(', ')} (allowed only for ${[...WILDCARD_RESOURCE_ALLOWED_ACTIONS].join(', ')})`,
          );
        }
      }
    }
  }
}

/** Stateful resources must survive stack deletion in production (§17, acceptance criteria). */
export class StatefulRetainAspect implements IAspect {
  private static readonly STATEFUL_TYPES = new Set([
    'AWS::DynamoDB::Table',
    'AWS::DynamoDB::GlobalTable',
    'AWS::S3::Bucket',
    'AWS::KMS::Key',
    'AWS::RDS::DBCluster',
    'AWS::RDS::DBInstance',
    'AWS::SQS::Queue',
  ]);
  constructor(private readonly config: EnvironmentConfig) {}
  visit(node: IConstruct): void {
    if (!this.config.isProduction) return;
    if (!(node instanceof CfnResource)) return;
    if (!StatefulRetainAspect.STATEFUL_TYPES.has(node.cfnResourceType)) return;
    if (node.cfnResourceType === 'AWS::SQS::Queue') return; // queues are rebuildable; DLQ retention handled by policy
    const raw = node as unknown as { cfnOptions: { deletionPolicy?: string } };
    if (
      raw.cfnOptions.deletionPolicy !== 'Retain' &&
      raw.cfnOptions.deletionPolicy !== 'RetainExceptOnCreate'
    ) {
      Annotations.of(node).addError(
        `${node.node.path} (${node.cfnResourceType}) must have DeletionPolicy Retain in production (got ${raw.cfnOptions.deletionPolicy ?? 'none'})`,
      );
    }
  }
}

/** Function URLs and unauthenticated API routes are public exposure; forbid by default. */
export class NoPublicExposureAspect implements IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof CfnResource)) return;
    if (node.cfnResourceType === 'AWS::Lambda::Url') {
      const auth: unknown = Stack.of(node).resolve(
        (node as unknown as { authType?: unknown }).authType,
      );
      if (auth === 'NONE' || auth === undefined) {
        Annotations.of(node).addError(
          `${node.node.path}: Lambda Function URL without IAM auth is forbidden (§13)`,
        );
      }
    }
    if (node.cfnResourceType === 'AWS::ApiGatewayV2::Route') {
      const authType: unknown = Stack.of(node).resolve(
        (node as unknown as { authorizationType?: unknown }).authorizationType,
      );
      if (authType === 'NONE' && !node.node.tryGetContext('paas:allow-public-route')) {
        Annotations.of(node).addError(
          `${node.node.path}: HTTP API route without authorizer is forbidden (§13)`,
        );
      }
    }
  }
}

/**
 * `dynamodb:Scan` cannot be constrained by the `dynamodb:LeadingKeys` condition key, so on a
 * pooled multi-tenant table it is a cross-tenant read path (ADR-0004, ADR-0012). Forbidden unless
 * the construct opts in with context `paas:allow-scan` (e.g. an admin/reconciliation job).
 */
export class NoDynamoScanAspect implements IAspect {
  visit(node: IConstruct): void {
    if (!(
      node instanceof iam.CfnPolicy ||
      node instanceof iam.CfnRole ||
      node instanceof iam.CfnManagedPolicy
    ))
      return;
    if (node.node.tryGetContext('paas:allow-scan') === true) return;
    const stack = Stack.of(node);
    const documents: unknown[] = [];
    if (node instanceof iam.CfnPolicy || node instanceof iam.CfnManagedPolicy) {
      documents.push(stack.resolve(node.policyDocument));
    } else {
      const policies = stack.resolve(node.policies) as { policyDocument?: unknown }[] | undefined;
      for (const p of policies ?? []) documents.push(p.policyDocument);
    }
    for (const doc of documents) {
      const statements = ((doc as { Statement?: unknown[] } | undefined)?.Statement ?? []) as {
        Effect?: string;
        Action?: string | string[];
      }[];
      for (const st of statements) {
        if (st.Effect !== 'Allow') continue;
        const actionList = Array.isArray(st.Action) ? st.Action : st.Action ? [st.Action] : [];
        if (actionList.some((a) => a === 'dynamodb:Scan' || a === 'dynamodb:*')) {
          Annotations.of(node).addError(
            `${node.node.path}: dynamodb:Scan on a pooled tenant table is forbidden (LeadingKeys cannot scope Scan; ADR-0004). Set context paas:allow-scan=true for an audited exception.`,
          );
        }
      }
    }
  }
}

/**
 * Lambda runtime deprecation dates from the AWS Lambda runtimes page
 * (https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html, checked 2026-10-17).
 * Warns 180 days ahead so the Node.js upgrade is scheduled through ADR-0008 review.
 */
export const LAMBDA_RUNTIME_DEPRECATION: Record<string, string> = {
  'nodejs20.x': '2026-04-30',
  'nodejs22.x': '2027-04-30',
};

export class RuntimeDeprecationAspect implements IAspect {
  constructor(private readonly now: Date = new Date()) {}
  visit(node: IConstruct): void {
    if (!(node instanceof CfnResource) || node.cfnResourceType !== 'AWS::Lambda::Function') return;
    const runtime: unknown = Stack.of(node).resolve(
      (node as unknown as { runtime?: unknown }).runtime,
    );
    if (typeof runtime !== 'string') return;
    const deprecation = LAMBDA_RUNTIME_DEPRECATION[runtime];
    if (!deprecation) return;
    const daysLeft = Math.floor(
      (new Date(deprecation).getTime() - this.now.getTime()) / 86_400_000,
    );
    if (daysLeft < 0) {
      Annotations.of(node).addError(
        `${node.node.path}: runtime ${runtime} was deprecated on ${deprecation}`,
      );
    } else if (daysLeft <= 180) {
      Annotations.of(node).addWarning(
        `${node.node.path}: runtime ${runtime} is deprecated on ${deprecation} (${daysLeft} days); plan the upgrade (ADR-0008)`,
      );
    }
  }
}

export interface PlatformGuardrailsOptions {
  readonly config: EnvironmentConfig;
  /** cdk-nag rule ids to suppress stack-wide with a mandatory reason (expiring exceptions, §20). */
  readonly suppressions?: { id: string; reason: string; expires: string }[];
  readonly verbose?: boolean;
}

/** Applies cdk-nag AwsSolutions + the platform aspects to a scope (stage or stack). */
export function applyPlatformGuardrails(
  scope: IConstruct,
  options: PlatformGuardrailsOptions,
): void {
  Aspects.of(scope).add(new AwsSolutionsChecks({ verbose: options.verbose ?? true }));
  Aspects.of(scope).add(new NoWildcardIamAspect());
  Aspects.of(scope).add(new StatefulRetainAspect(options.config));
  Aspects.of(scope).add(new NoPublicExposureAspect());
  Aspects.of(scope).add(new NoDynamoScanAspect());
  Aspects.of(scope).add(new RuntimeDeprecationAspect());
  for (const s of options.suppressions ?? []) {
    if (new Date(s.expires).getTime() < Date.now()) {
      throw new Error(
        `guardrail suppression ${s.id} expired on ${s.expires}; renew via ADR or fix the finding`,
      );
    }
  }
}

/** Suppress a cdk-nag finding for one construct subtree with a reason (recorded in the template metadata). */
export function suppressNag(
  construct: IConstruct,
  rules: { id: string; reason: string; appliesTo?: string[] }[],
): void {
  NagSuppressions.addResourceSuppressions(construct, rules, true);
}

export { RemovalPolicy };
