import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  productionDefaults,
  sandboxDefaults,
  type EnvironmentConfig,
  type EnvironmentName,
} from '@paas/constructs';

/**
 * Environment catalogue (guideline §1: sandbox / development / staging / production; production
 * MUST be a separate AWS account — ADR-0003). Account ids come from CDK_DEFAULT_ACCOUNT or the
 * PAAS_ACCOUNT_<ENV> variables so no account id is committed.
 */
export function environmentConfig(name: EnvironmentName, cellId: string): EnvironmentConfig {
  const region = process.env['CDK_DEFAULT_REGION'] ?? 'ap-northeast-1';
  const account =
    process.env[`PAAS_ACCOUNT_${name.toUpperCase()}`] ?? process.env['CDK_DEFAULT_ACCOUNT'];
  const base = { region, cellId, ...(account ? { account } : {}) };
  const alarmEmail = process.env['PAAS_ALARM_EMAIL'];
  const jwt = process.env['PAAS_JWT_ISSUER']
    ? {
        kind: 'jwt' as const,
        issuer: process.env['PAAS_JWT_ISSUER'],
        audience: (process.env['PAAS_JWT_AUDIENCE'] ?? 'paas-api').split(','),
      }
    : undefined;

  switch (name) {
    case 'sandbox':
      return sandboxDefaults({ ...base, ...(alarmEmail ? { alarmEmail } : {}) });
    case 'development':
      return sandboxDefaults({
        ...base,
        name: 'development',
        logRetention: RetentionDays.TWO_WEEKS,
        logLevel: 'DEBUG',
        debugSampleRate: 0.5,
        ...(alarmEmail ? { alarmEmail } : {}),
      });
    case 'staging':
      return productionDefaults({
        ...base,
        name: 'staging',
        isProduction: false,
        removalPolicy: RemovalPolicy.SNAPSHOT,
        logRetention: RetentionDays.ONE_MONTH,
        deploymentStrategy: 'linear-10-percent-every-minute',
        auth: jwt ?? {
          kind: 'jwt',
          issuer: 'https://REPLACE-ME.staging.example.com/',
          audience: ['paas-api'],
        },
        ...(alarmEmail ? { alarmEmail } : {}),
      });
    case 'production':
      return productionDefaults({
        ...base,
        auth: jwt ?? {
          kind: 'jwt',
          issuer: 'https://REPLACE-ME.example.com/',
          audience: ['paas-api'],
        },
        ...(alarmEmail ? { alarmEmail } : {}),
        ...(process.env['PAAS_APP_SIGNALS_LAYER_ARN']
          ? { applicationSignalsLayerArn: process.env['PAAS_APP_SIGNALS_LAYER_ARN'] }
          : {}),
      });
  }
}

export function isEnvironmentName(value: unknown): value is EnvironmentName {
  return (
    value === 'sandbox' || value === 'development' || value === 'staging' || value === 'production'
  );
}
