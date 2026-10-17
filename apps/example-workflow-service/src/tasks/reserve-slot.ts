import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAME, documentClient, taskHandler } from './shared.js';

/**
 * Step 2: reserve a tenant slot in the target cell (conditional put = idempotent on re-run).
 * The record key is the *target* tenant; the acting tenant (control plane) stays in the context.
 */
export const handler = taskHandler('ReserveTenantSlot', async (ctx, input) => {
  const { targetTenantId, cellId, tier } = input.request.data;
  try {
    await documentClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `TENANT#${targetTenantId}`,
          sk: 'SLOT',
          entityType: 'SLOT',
          cellId,
          tier,
          status: 'RESERVED',
          correlationId: ctx.correlationId,
          reservedAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(pk) OR correlationId = :corr',
        ExpressionAttributeValues: { ':corr': ctx.correlationId },
      }),
      { abortSignal: ctx.deadline.toAbortSignal() },
    );
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new Error(
        `SlotConflict: tenant ${targetTenantId} already has a slot owned by another flow`,
      );
    }
    throw error;
  }
  return { slotReserved: true };
});
