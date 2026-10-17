import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAME, documentClient, taskHandler } from './shared.js';

/**
 * Compensation: release the slot reserved by THIS flow (never another flow's). Deleting an
 * already-released slot is a no-op, so compensation itself is idempotent (guideline §9 Saga).
 */
export const handler = taskHandler('ReleaseTenantSlot', async (ctx, input) => {
  const { targetTenantId } = input.request.data;
  try {
    await documentClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${targetTenantId}`, sk: 'SLOT' },
        ConditionExpression: 'correlationId = :corr',
        ExpressionAttributeValues: { ':corr': ctx.correlationId },
      }),
      { abortSignal: ctx.deadline.toAbortSignal() },
    );
  } catch (error) {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
  }
  return { slotReserved: false, resourcesProvisioned: false };
});
