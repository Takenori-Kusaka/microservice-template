import { PRICES } from './prices.js';

/**
 * Workload profile (docs/architecture/workload-profile.md). All rates are per tenant per month
 * unless stated; tiers scale the per-tenant activity.
 */
export interface TierProfile {
  tenants: number;
  /** API requests per tenant per month. */
  apiRequestsPerTenant: number;
  /** Fraction of API requests that are writes (produce 1 outbox event + 1 transact write). */
  writeRatio: number;
}

export interface WorkloadProfile {
  tiers: Record<'standard' | 'premium' | 'enterprise', TierProfile>;
  lambda: {
    memoryMb: number;
    avgDurationMs: number;
    architecture: 'arm64' | 'x86';
    /** Extra invocations per write (outbox relay + worker + outcome consumer). */
    asyncInvocationsPerWrite: number;
  };
  workflow: {
    /** Provisioning executions per month (platform-wide). */
    executionsPerMonth: number;
    transitionsPerExecution: number;
  };
  observability: {
    logBytesPerInvocation: number;
    traceSampleRate: number;
  };
  storage: { gbPerTenant: number };
  /** Platform-wide shared monthly cost to allocate (dashboards, KMS, archive, CI...). */
  sharedMonthlyUsd: number;
}

export interface CostLine {
  component: string;
  usd: number;
  driver: string;
}

export interface CostReport {
  total: number;
  lines: CostLine[];
  perTier: Record<string, { tenants: number; usd: number; perTenant: number; perRequest: number }>;
  perRequest: number;
}

function lambdaCost(
  invocations: number,
  memoryMb: number,
  durationMs: number,
  arch: 'arm64' | 'x86',
): number {
  const gbSeconds = invocations * (memoryMb / 1024) * (durationMs / 1000);
  const perGbSecond =
    arch === 'arm64' ? PRICES.lambdaGbSecondArm64.value : PRICES.lambdaGbSecondX86.value;
  return (invocations / 1e6) * PRICES.lambdaRequestPerMillion.value + gbSeconds * perGbSecond;
}

/**
 * Activity-based costing: every component's cost is driven by requests/writes/tenants so it can
 * be attributed to tiers (guideline §15: "shared costはtenant activity、request、storage…等の
 * 合理的driverで配賦する").
 */
export function computeCost(profile: WorkloadProfile): CostReport {
  const lines: CostLine[] = [];
  const tierRequests: Record<string, number> = {};
  let totalRequests = 0;
  let totalWrites = 0;
  let totalTenants = 0;
  for (const [tier, t] of Object.entries(profile.tiers)) {
    const requests = t.tenants * t.apiRequestsPerTenant;
    tierRequests[tier] = requests;
    totalRequests += requests;
    totalWrites += requests * t.writeRatio;
    totalTenants += t.tenants;
  }
  const asyncInvocations = totalWrites * profile.lambda.asyncInvocationsPerWrite;
  const invocations = totalRequests + asyncInvocations;

  lines.push({
    component: 'API Gateway (HTTP API)',
    usd: (totalRequests / 1e6) * PRICES.apiGatewayHttpPerMillion.value,
    driver: 'requests',
  });
  lines.push({
    component: 'Lambda (API + async)',
    usd: lambdaCost(
      invocations,
      profile.lambda.memoryMb,
      profile.lambda.avgDurationMs,
      profile.lambda.architecture,
    ),
    driver: 'requests',
  });
  lines.push({
    component: 'DynamoDB requests',
    usd:
      ((totalWrites * 2 /* order + outbox, transactional = 2x */ * 2) /* transact doubles WRU */ /
        1e6) *
        PRICES.dynamoDbWriteRequestPerMillion.value +
      ((totalRequests - totalWrites) / 1e6) * PRICES.dynamoDbReadRequestPerMillion.value +
      ((totalWrites * 2) /* idempotency put + update */ / 1e6) *
        PRICES.dynamoDbWriteRequestPerMillion.value,
    driver: 'requests',
  });
  lines.push({
    component: 'DynamoDB storage',
    usd: totalTenants * profile.storage.gbPerTenant * PRICES.dynamoDbStorageGbMonth.value,
    driver: 'tenants',
  });
  lines.push({
    component: 'EventBridge',
    usd: ((totalWrites * 2) /* created + outcome */ / 1e6) * PRICES.eventBridgePerMillion.value,
    driver: 'requests',
  });
  lines.push({
    component: 'SQS',
    usd: ((totalWrites * 2 * 3) /* send/receive/delete */ / 1e6) * PRICES.sqsPerMillion.value,
    driver: 'requests',
  });
  lines.push({
    component: 'Step Functions (provisioning)',
    usd:
      ((profile.workflow.executionsPerMonth * profile.workflow.transitionsPerExecution) / 1000) *
      PRICES.stepFunctionsPerThousandTransitions.value,
    driver: 'tenants',
  });
  lines.push({
    component: 'CloudWatch Logs',
    usd:
      ((invocations * profile.observability.logBytesPerInvocation) / 1e9) *
      PRICES.cloudWatchLogsIngestGb.value,
    driver: 'requests',
  });
  lines.push({
    component: 'X-Ray',
    usd:
      ((invocations * profile.observability.traceSampleRate) / 1e6) *
      PRICES.xrayTracePerMillion.value,
    driver: 'requests',
  });
  lines.push({ component: 'Shared platform', usd: profile.sharedMonthlyUsd, driver: 'tenants' });

  const total = lines.reduce((s, l) => s + l.usd, 0);
  const requestDriven = lines.filter((l) => l.driver === 'requests').reduce((s, l) => s + l.usd, 0);
  const tenantDriven = lines.filter((l) => l.driver === 'tenants').reduce((s, l) => s + l.usd, 0);

  const perTier: CostReport['perTier'] = {};
  for (const [tier, t] of Object.entries(profile.tiers)) {
    const requests = tierRequests[tier] ?? 0;
    const usd =
      requestDriven * (totalRequests ? requests / totalRequests : 0) +
      tenantDriven * (totalTenants ? t.tenants / totalTenants : 0);
    perTier[tier] = {
      tenants: t.tenants,
      usd,
      perTenant: t.tenants ? usd / t.tenants : 0,
      perRequest: requests ? usd / requests : 0,
    };
  }
  return { total, lines, perTier, perRequest: totalRequests ? total / totalRequests : 0 };
}

export const exampleProfile: WorkloadProfile = {
  tiers: {
    standard: { tenants: 300, apiRequestsPerTenant: 200_000, writeRatio: 0.3 },
    premium: { tenants: 50, apiRequestsPerTenant: 1_500_000, writeRatio: 0.3 },
    enterprise: { tenants: 5, apiRequestsPerTenant: 10_000_000, writeRatio: 0.3 },
  },
  lambda: {
    memoryMb: 1024,
    avgDurationMs: 120,
    architecture: 'arm64',
    asyncInvocationsPerWrite: 3,
  },
  workflow: { executionsPerMonth: 100, transitionsPerExecution: 12 },
  observability: { logBytesPerInvocation: 2_000, traceSampleRate: 0.05 },
  storage: { gbPerTenant: 0.5 },
  sharedMonthlyUsd: 400,
};

/**
 * ADR-0005 / M-03: monthly request volume at which an Application Load Balancer (hourly + LCU
 * charges) costs the same as API Gateway HTTP API (per-request charge). Below the break-even the
 * HTTP API is cheaper; above it the ALB's fixed cost is amortised. The LCU term is a floor
 * (`lcuHours` LCU-hours per month; 1 LCU covers 25 new connections/s, 3,000 active
 * connections/min, 1 GB/h or 1,000 rule evaluations/s, whichever dimension is highest).
 * Lambda-side auth / rate limiting that the ALB path needs is NOT included (ADR-0005 短所).
 */
export function albVsHttpApiBreakEven(
  hoursPerMonth = 730,
  lcuHours = hoursPerMonth,
): {
  albFixedUsdPerMonth: number;
  breakEvenRequestsPerMonth: number;
  breakEvenAverageRps: number;
} {
  const albFixedUsdPerMonth =
    PRICES.albHour.value * hoursPerMonth + PRICES.albLcuHour.value * lcuHours;
  const breakEvenRequestsPerMonth =
    albFixedUsdPerMonth / (PRICES.apiGatewayHttpPerMillion.value / 1e6);
  return {
    albFixedUsdPerMonth,
    breakEvenRequestsPerMonth,
    breakEvenAverageRps: breakEvenRequestsPerMonth / (hoursPerMonth * 3600),
  };
}
