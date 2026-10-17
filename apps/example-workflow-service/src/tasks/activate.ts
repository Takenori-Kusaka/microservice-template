import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAME, documentClient, taskHandler } from './shared.js';

/** Step 4: mark the slot ACTIVE (conditional on RESERVED → idempotent). */
export const handler = taskHandler('ActivateTenant', async (ctx, input) => {
  const { targetTenantId } = input.request.data;
  await documentClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${targetTenantId}`, sk: 'SLOT' },
      ConditionExpression: 'correlationId = :corr AND #status IN (:reserved, :active)',
      UpdateExpression: 'SET #status = :active, activatedAt = :now, apiKeyRef = :ref',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':corr': ctx.correlationId,
        ':reserved': 'RESERVED',
        ':active': 'ACTIVE',
        ':now': new Date().toISOString(),
        ':ref': input.state.apiKeyRef ?? 'n/a',
      },
    }),
    { abortSignal: ctx.deadline.toAbortSignal() },
  );
  return {};
});
