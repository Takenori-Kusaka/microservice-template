/**
 * Price list used by the cost model (guideline §15 コスト).
 *
 * EVERY value must carry its source URL and the date it was verified. Values marked
 * `verified: false` are placeholders copied from the public price pages at an earlier date and
 * MUST be re-checked (`pnpm cost-model --check-prices` prints the stale ones) before any number
 * from this tool is quoted in an ADR or a budget. Prices are USD, region ap-northeast-1 unless
 * noted; free tiers are ignored (conservative).
 *
 * Verification method (2026-10-17): the public pricing pages do not render the per-region
 * tables as static text, so every value below was confirmed against the official AWS Price List
 * Bulk API region file for ap-northeast-1 (the same data the pricing pages and the AWS Pricing
 * Calculator are generated from). The `source` field carries both the pricing page and the
 * exact Price List file URL; the usage type (e.g. `APN1-Lambda-GB-Second-ARM`) is in `note`.
 */
export interface Price {
  readonly value: number;
  readonly unit: string;
  readonly source: string;
  readonly verifiedAt: string; // ISO date
  readonly verified: boolean;
  readonly note?: string;
}

const PRICE_LIST = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws';

export const PRICES = {
  lambdaRequestPerMillion: {
    value: 0.2,
    unit: 'USD / 1M requests',
    source: `https://aws.amazon.com/lambda/pricing/ ; ${PRICE_LIST}/AWSLambda/current/ap-northeast-1/index.json`,
    verifiedAt: '2026-10-17',
    verified: true,
    note: 'Lambda Event Functions request charge; APN1-Request and APN1-Request-ARM are both $0.0000002 / request. Web Functions requests are $0.30 / 1M (APN1-Lambda-Web-Request-ARM) and are not modelled here.',
  },
  lambdaGbSecondArm64: {
    value: 0.0000133334,
    unit: 'USD / GB-second (arm64)',
    source: `https://aws.amazon.com/lambda/pricing/ ; ${PRICE_LIST}/AWSLambda/current/ap-northeast-1/index.json`,
    verifiedAt: '2026-10-17',
    verified: true,
    note: 'APN1-Lambda-GB-Second-ARM tier 1 (first 7.5B GB-s / month). Tier 2 (7.5B–18.75B) $0.0000120001, tier 3 (>18.75B) $0.0000106667 are ignored (conservative). Tokyo arm64 price equals the US East price.',
  },
  lambdaGbSecondX86: {
    value: 0.0000166667,
    unit: 'USD / GB-second (x86)',
    source: `https://aws.amazon.com/lambda/pricing/ ; ${PRICE_LIST}/AWSLambda/current/ap-northeast-1/index.json`,
    verifiedAt: '2026-10-17',
    verified: true,
    note: 'APN1-Lambda-GB-Second tier 1 (first 6B GB-s / month). Tier 2 (6B–15B) $0.0000150000, tier 3 (>15B) $0.0000133334 are ignored (conservative).',
  },
  apiGatewayHttpPerMillion: {
    value: 1.29,
    unit: 'USD / 1M requests',
    source: `https://aws.amazon.com/api-gateway/pricing/ ; ${PRICE_LIST}/AmazonApiGateway/current/ap-northeast-1/index.json`,
    verifiedAt: '2026-10-17',
    verified: true,
    note: 'APN1-ApiGatewayHttpRequest: $1.29 / 1M for the first 300M requests / month, $1.18 beyond (ignored). Previous value $1.00 was the US East price. REST API in Tokyo is $4.25 / 1M for the first 333M (APN1-ApiGatewayRequest), i.e. ~3.3x.',
  },
  dynamoDbWriteRequestPerMillion: {
    value: 0.715,
    unit: 'USD / 1M write request units (on-demand)',
    source: `https://aws.amazon.com/dynamodb/pricing/on-demand/ ; ${PRICE_LIST}/AmazonDynamoDB/current/ap-northeast-1/index.json`,
    verifiedAt: '2026-10-17',
    verified: true,
    note: 'APN1-WriteRequestUnits (PayPerRequestThroughput) $0.000000715 / WRU. Previous value $1.4269 predates the on-demand price reduction.',
  },
  dynamoDbReadRequestPerMillion: {
    value: 0.1425,
    unit: 'USD / 1M read request units (on-demand)',
    source: `https://aws.amazon.com/dynamodb/pricing/on-demand/ ; ${PRICE_LIST}/AmazonDynamoDB/current/ap-northeast-1/index.json`,
    verifiedAt: '2026-10-17',
    verified: true,
    note: 'APN1-ReadRequestUnits (PayPerRequestThroughput) $0.0000001425 / RRU. Previous value $0.285 predates the on-demand price reduction.',
  },
  dynamoDbStorageGbMonth: {
    value: 0.285,
    unit: 'USD / GB-month',
    source: `https://aws.amazon.com/dynamodb/pricing/on-demand/ ; ${PRICE_LIST}/AmazonDynamoDB/current/ap-northeast-1/index.json`,
    verifiedAt: '2026-10-17',
    verified: true,
    note: 'APN1-TimedStorage-ByteHrs $0.285 / GB-month beyond the first 25 GB-months (free tier ignored). DynamoDB Standard table class.',
  },
  eventBridgePerMillion: {
    value: 1.0,
    unit: 'USD / 1M custom events published',
    source: `https://aws.amazon.com/eventbridge/pricing/ ; ${PRICE_LIST}/AWSEvents/current/ap-northeast-1/index.json`,
    verifiedAt: '2026-10-17',
    verified: true,
    note: 'APN1-Event-64K-Chunks (PutEvents) $0.000001 / 64 KB chunk; an event ≤ 64 KB is one chunk. Custom Event Bus - Classic.',
  },
  sqsPerMillion: {
    value: 0.4,
    unit: 'USD / 1M requests (standard)',
    source: `https://aws.amazon.com/sqs/pricing/ ; ${PRICE_LIST}/AWSQueueService/current/ap-northeast-1/index.json`,
    verifiedAt: '2026-10-17',
    verified: true,
    note: 'APN1-Requests-Tier1 $0.0000004 / request for the first 100B requests / month. Each 64 KB chunk is one request; send + receive + delete ≈ 3 requests per message. FIFO is $0.50 / 1M, fair queues $0.10 / 1M.',
  },
  stepFunctionsPerThousandTransitions: {
    value: 0.025,
    unit: 'USD / 1,000 state transitions (Standard)',
    source: `https://aws.amazon.com/step-functions/pricing/ ; ${PRICE_LIST}/AmazonStates/current/ap-northeast-1/index.json`,
    verifiedAt: '2026-10-17',
    verified: true,
    note: 'APN1-StateTransition $0.000025 / state transition (= $0.025 / 1,000). First 4,000 transitions / month free (ignored).',
  },
  cloudWatchLogsIngestGb: {
    value: 0.76,
    unit: 'USD / GB ingested',
    source: `https://aws.amazon.com/cloudwatch/pricing/ ; ${PRICE_LIST}/AmazonCloudWatch/current/ap-northeast-1/index.json`,
    verifiedAt: '2026-10-17',
    verified: true,
    note: 'APN1-DataProcessing-Bytes (PutLogEvents) $0.76 / GB, Standard log class. Infrequent Access class is $0.38 / GB; storage is $0.033 / GB-month (not modelled).',
  },
  xrayTracePerMillion: {
    value: 5.0,
    unit: 'USD / 1M traces recorded',
    source: `https://aws.amazon.com/xray/pricing/ ; ${PRICE_LIST}/AWSXRay/current/ap-northeast-1/index.json`,
    verifiedAt: '2026-10-17',
    verified: true,
    note: 'APN1-XRay-TracesStored $0.000005 / trace. Traces retrieved / scanned are $0.50 / 1M (not modelled). First 100,000 traces stored / month free (ignored).',
  },
} as const satisfies Record<string, Price>;

export type PriceKey = keyof typeof PRICES;

export function stalePrices(now = new Date(), maxAgeDays = 90): PriceKey[] {
  return (Object.keys(PRICES) as PriceKey[]).filter((k) => {
    const p = PRICES[k];
    const ageDays = (now.getTime() - new Date(p.verifiedAt).getTime()) / 86_400_000;
    return !p.verified || ageDays > maxAgeDays;
  });
}
