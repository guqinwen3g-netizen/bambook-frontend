import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { normalizeWorkflowOriginal, workflowRequestAuditId, writeWorkflowRetirement, validateWorkflowRetirement, assertWorkflowRequestNotRetired } from '../workflowRequestRecovery';

// Storage-seam tests only. Actual locking, race and PostgreSQL mandatory-audit
// rollback evidence lives in workflowAuthorityRealDb, not these mocks.
const parent = { entityType: 'Order' as const, entityId: 'real-order', instanceId: 'real-instance' };
const actor = { userId: 'reviewer', roles: [], roleIds: ['role-sales-manager'], permissions: ['orders:write'], departmentIds: [], authorizationLoaded: true as const };
const original = () => normalizeWorkflowOriginal({ action: 'approve', originalClientRequestId: 'original-key', originalPayload: {
  instanceId: parent.instanceId, expectedStepId: 'step-1', expectedStepIndex: 0, sourceFingerprint: 'original-source', note: ' Approved note ' } });
async function marker() {
  let row: any; const tx = { auditLog: { create: vi.fn(async ({ data }) => { row = data; return data; }) } };
  const ack = await writeWorkflowRetirement(tx, actor, parent, original(), 'retire-key', 'Correct original request');
  return { row, ack, tx };
}
describe('exact workflow original command and permanent retirement fact', () => {
  it('matches independently specified canonical writer hash; no HTTP actor or extra field participates', () => {
    const canonical = '{"decision":"approved","expectedStepId":"step-1","expectedStepIndex":0,"instanceId":"real-instance","note":"Approved note","sourceFingerprint":"original-source"}';
    expect(original().parameterHash).toBe(createHash('sha256').update(canonical).digest('hex'));
    const changed = normalizeWorkflowOriginal({ action: 'approve', originalClientRequestId: 'original-key', originalPayload: { ...original().command, actorId: 'spoof', permissions: ['*'] } });
    expect(changed.parameterHash).toBe(original().parameterHash);
  });
  it('retirement key is shared across actions on the same actor and parent; create has a separate real source parent', () => {
    expect(workflowRequestAuditId(actor.userId, parent, 'key')).toBe(workflowRequestAuditId(actor.userId, { ...parent }, 'key'));
    expect(workflowRequestAuditId(actor.userId, { ...parent, instanceId: null }, 'key')).not.toBe(workflowRequestAuditId(actor.userId, parent, 'key'));
  });
  it('stores exact original command, server authority and independently valid immutable acknowledgement', async () => {
    const { row, ack } = await marker(); expect(validateWorkflowRetirement(row, actor.userId, parent, 'original-key')).toEqual(ack);
    expect(row.detail.originalCommand).toEqual(original().command);
    expect(row.detail.decisionActorAuthority).toEqual({ userId: actor.userId, roleIds: actor.roleIds, authorizationLoaded: true });
    expect(row.createdAt.toISOString()).toBe(ack.retiredAt);
  });
  it.each(['originalCommand', 'acknowledgementHash', 'decisionActorAuthority'])('damaged %s is a conflict, never a non-application proof', async field => {
    const { row } = await marker(); row.detail[field] = null;
    expect(() => validateWorkflowRetirement(row, actor.userId, parent, 'original-key')).toThrow(expect.objectContaining({ code: 'CONFLICT', statusCode: 409 }));
  });
  it('blocks a retired writer while an absent fact does not pretend to fence it', async () => {
    const { row } = await marker(); const findUnique = vi.fn(async () => row);
    await expect(assertWorkflowRequestNotRetired({ auditLog: { findUnique } }, actor.userId, parent, 'original-key')).rejects.toMatchObject({ code: 'CONFLICT' });
    findUnique.mockResolvedValue(null);
    await expect(assertWorkflowRequestNotRetired({ auditLog: { findUnique } }, actor.userId, parent, 'original-key')).resolves.toBeUndefined();
  });
  it('normalizes rejected long text without inventing successful writer validation', () => {
    const text = 'x'.repeat(2100), input = { action: 'cancel' as const, originalClientRequestId: 'key', originalPayload: { instanceId: parent.instanceId, reason: text } };
    expect(normalizeWorkflowOriginal(input).command.reason).toBe(text);
  });
});
