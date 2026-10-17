import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * SDK clients are created once per execution environment and reused (guideline §16).
 * Retry policy: the SDK's standard mode (max 3 attempts, exponential backoff + jitter) owns retries
 * for AWS calls. Adaptive mode is NOT used: AWS advises against it for clients that serve many
 * tenants/resources because one throttled resource slows the whole client
 * (https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html). Application code must not
 * wrap them in another retry loop (§12 "retryを複数layerで重ねない").
 */
const dynamo = new DynamoDBClient({ maxAttempts: 3, retryMode: 'standard' });

export const documentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(dynamo, {
  marshallOptions: { removeUndefinedValues: true },
});

export const eventBridgeClient: EventBridgeClient = new EventBridgeClient({
  maxAttempts: 3,
  retryMode: 'standard',
});
