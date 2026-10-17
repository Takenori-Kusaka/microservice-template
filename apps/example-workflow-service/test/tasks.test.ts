import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { TenantProvisioningRequestedV1, createEvent } from '@paas/event-contracts';
import { makeExecutionContext, makeLambdaContext } from '@paas/testing';
import { handler as reserve } from '../src/tasks/reserve-slot.js';
import { handler as release } from '../src/tasks/release-slot.js';
import { handler as validate } from '../src/tasks/validate.js';

const ddb = mockClient(DynamoDBDocumentClient);

function request(cellId = 'cell-01') {
  const ctx = makeExecutionContext({ tenantId: 'platform', correlationId: 'prov-flow-0001' });
  return createEvent(TenantProvisioningRequestedV1, ctx, {
    data: { targetTenantId: 'newco', tier: 'premium', cellId, requestedBy: 'ops@example' },
  });
}

describe('provisioning tasks', () => {
  beforeEach(() => ddb.reset());

  it('validate rejects unknown cells', async () => {
    await expect(
      validate({ request: request('bad'), state: {} }, makeLambdaContext()),
    ).rejects.toThrow(/unknown cell/);
  });

  it('reserve-slot writes a conditional record keyed by the target tenant', async () => {
    ddb.on(PutCommand).resolves({});
    const state = await reserve({ request: request(), state: {} }, makeLambdaContext());
    expect(state.slotReserved).toBe(true);
    const input = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input.Item?.['pk']).toBe('TENANT#newco');
    expect(input.ConditionExpression).toContain('attribute_not_exists');
  });

  it('reserve-slot maps a conditional failure to a SlotConflict', async () => {
    ddb
      .on(PutCommand)
      .rejects(Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }));
    await expect(reserve({ request: request(), state: {} }, makeLambdaContext())).rejects.toThrow(
      /SlotConflict/,
    );
  });

  it('release-slot is idempotent when the slot is already gone', async () => {
    ddb
      .on(DeleteCommand)
      .rejects(Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }));
    const state = await release(
      { request: request(), state: { slotReserved: true } },
      makeLambdaContext(),
    );
    expect(state.slotReserved).toBe(false);
  });
});
