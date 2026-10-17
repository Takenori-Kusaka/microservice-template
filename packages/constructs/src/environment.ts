import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export type EnvironmentName = 'sandbox' | 'development' | 'staging' | 'production';

export type DeploymentStrategy =
  'all-at-once' | 'canary-10-percent-5-minutes' | 'linear-10-percent-every-minute';

export type ApiAuthConfig =
  /** Production path: JWT issued by the platform IdP (Cognito or custom), verified by API Gateway. */
  | { kind: 'jwt'; issuer: string; audience: string[] }
  /**
   * Sandbox/development only: a Lambda authorizer that accepts an unsigned test token.
   * Refused by PlatformGuardrails outside sandbox/development.
   */
  | { kind: 'sandbox-lambda' };

/**
 * Environment-level knobs consumed by every paved construct (guideline §17 CDK/IaC:
 * environment stage, stateful retain policies, log retention, deployment strategy).
 */
export interface EnvironmentConfig {
  readonly name: EnvironmentName;
  readonly account?: string;
  readonly region: string;
  readonly cellId: string;
  readonly isProduction: boolean;
  readonly logRetention: RetentionDays;
  readonly removalPolicy: RemovalPolicy;
  readonly deploymentStrategy: DeploymentStrategy;
  readonly auth: ApiAuthConfig;
  readonly apiThrottle: { rateLimit: number; burstLimit: number };
  readonly logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  /** 0..1 fraction of invocations that emit DEBUG logs (Powertools sampling). */
  readonly debugSampleRate: number;
  readonly alarmEmail?: string;
  /** CloudWatch Application Signals Lambda layer ARN for this region (optional opt-in). */
  readonly applicationSignalsLayerArn?: string;
}

export function sandboxDefaults(overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
  return {
    name: 'sandbox',
    region: 'ap-northeast-1',
    cellId: 'cell-01',
    isProduction: false,
    logRetention: RetentionDays.ONE_WEEK,
    removalPolicy: RemovalPolicy.DESTROY,
    deploymentStrategy: 'all-at-once',
    auth: { kind: 'sandbox-lambda' },
    apiThrottle: { rateLimit: 100, burstLimit: 200 },
    logLevel: 'DEBUG',
    debugSampleRate: 1,
    ...overrides,
  };
}

export function productionDefaults(overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
  return {
    name: 'production',
    region: 'ap-northeast-1',
    cellId: 'cell-01',
    isProduction: true,
    logRetention: RetentionDays.THREE_MONTHS,
    removalPolicy: RemovalPolicy.RETAIN,
    deploymentStrategy: 'canary-10-percent-5-minutes',
    auth: { kind: 'jwt', issuer: 'https://REPLACE-ME.example.com/', audience: ['paas-api'] },
    apiThrottle: { rateLimit: 1000, burstLimit: 2000 },
    logLevel: 'INFO',
    debugSampleRate: 0.01,
    ...overrides,
  };
}
