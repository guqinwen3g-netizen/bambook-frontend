import { afterEach, describe, expect, it, vi } from 'vitest';
import { getToolOutcome } from '../toolOutcome';
import { executeAgentTool } from '../toolRuntime';
import { getToolHandler, isReceiptGuardedCommitTool, registerCommitTool, registerTool, dispatchFromRegistry } from '../toolDispatchRegistry';
import { createIdentityService } from '../identity';
import { createAgentRuntimeService } from '../runtime';

const originalCount = getToolHandler('products.count')!;
afterEach(() => registerTool('products.count', originalCount));

describe('framework outcomes do not rewrite ordinary business row status', () => {
  it.each(['failed', 'denied', 'preconditions_failed', 'blocked'])('ordinary business row status %s is observed data', status => {
    expect(getToolOutcome({ id: 'business-row', status, message: 'business observation' }, 'orders.get')).toEqual({ status: 'success' });
  });
  it('the matching native framework precondition envelope is failed', () => {
    expect(getToolOutcome({ toolId: 'order.confirm', status: 'preconditions_failed', message: 'source blocked', errors: ['SOURCE_BLOCKED'] }, 'order.confirm'))
      .toEqual({ status: 'failed', error: 'TOOL_FAILED: source blocked' });
    expect(getToolOutcome({ toolId: 'other-tool', status: 'preconditions_failed', message: 'row', errors: [] }, 'order.confirm')).toEqual({ status: 'success' });
  });
  it('registered structured negative retains its original code and never becomes success', () => {
    expect(getToolOutcome({ ok: false, committed: false, errorFeedback: { code: 'COMMIT_REPLAY_BLOCKED', message: 'manual check required' } }, 'order.confirm'))
      .toEqual({ status: 'failed', error: 'COMMIT_REPLAY_BLOCKED: manual check required' });
    expect(getToolOutcome({ ok: true, rows: [{ status: 'failed' }] }, 'orders.get')).toEqual({ status: 'success' });
  });
  it('actual executeAgentTool records structured refusal as failed while returning the original envelope', async () => {
    const output = { ok: false, committed: false, errorFeedback: { code: 'FORBIDDEN', message: 'current permission denied', retryable: false } };
    registerTool('products.count', async () => output);
    const writes: any[] = [];
    const db = { userAccount: { findFirst: vi.fn(async () => ({ id: 'operator' })) },
      agentTool: { upsert: vi.fn(async () => ({})) }, agentToolRun: { create: vi.fn(async ({ data }: any) => { writes.push(data); return data; }) },
      auditLog: { create: vi.fn(async () => ({})) } } as any;
    const actor = await createIdentityService().resolveActorContext({ userId: 'operator', roles: ['owner'], departmentIds: ['company'] });
    expect(await executeAgentTool({ prisma: db, actor, toolId: 'products.count', toolInput: {}, skipApprovalCheck: true, approvalId: 'original' })).toBe(output);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ approvalId: 'original', status: 'failed', output, error: 'FORBIDDEN: current permission denied' });
  });
});

describe('recovery capability follows the actual registered receipt wrapper', () => {
  it('actual production commits are marked while ordinary writers remain unmarked', () => {
    expect(isReceiptGuardedCommitTool('order.confirm')).toBe(true);
    expect(isReceiptGuardedCommitTool('invoice.issue')).toBe(true);
    expect(isReceiptGuardedCommitTool('quotation.create')).toBe(true);
    expect(isReceiptGuardedCommitTool('development.update_stage')).toBe(false);
    expect(isReceiptGuardedCommitTool('orders.update_status')).toBe(false);
    expect(isReceiptGuardedCommitTool('not-registered')).toBe(false);
  });
  it('an ordinary handler replacement revokes a formerly guarded capability', () => {
    const id = 'recovery-test.commit';
    registerCommitTool(id, async () => ({ ok: true }));
    expect(isReceiptGuardedCommitTool(id)).toBe(true);
    registerTool(id, async () => ({ ok: true }));
    expect(isReceiptGuardedCommitTool(id)).toBe(false);
  });
  it('a real committing receipt blocks a duplicate commit without deleting or invoking the handler', async () => {
    const id = 'recovery-test.receipt'; const handler = vi.fn(async () => ({ ok: true })); registerCommitTool(id, handler);
    const db = { approvalRequest: { findUnique: vi.fn(async () => ({ id: 'original', status: 'approved', actionType: `tool:${id}`, requesterId: 'operator' })) },
      agentCommitReceipt: { create: vi.fn(async () => { throw Object.assign(new Error('unique'), { code: 'P2002' }); }),
        findUnique: vi.fn(async () => ({ status: 'committing' })), delete: vi.fn(), update: vi.fn() } } as any;
    expect(await dispatchFromRegistry(db, { toolId: id, input: {}, approvalId: 'original' })).toMatchObject({ hit: true,
      result: { ok: false, committed: false, errorFeedback: { code: 'COMMIT_REPLAY_BLOCKED', retryable: false } } });
    expect(handler).not.toHaveBeenCalled(); expect(db.agentCommitReceipt.delete).not.toHaveBeenCalled(); expect(db.agentCommitReceipt.update).not.toHaveBeenCalled();
  });
});

describe('actual session persistence distinguishes suspended outcomes from complete work', () => {
  it.each(['approval_blocked', 'form_blocked', 'aborted', 'recovery_required', 'outcome_unknown'])('%s never persists a completed run', async stopReason => {
    let row: any = { id: 'session', userId: 'operator', title: 'original', metadata: { agentRuntime: { currentRun: { id: 'original-run', status: 'running' } } } };
    const db = { agentSession: { findFirst: vi.fn(async ({ where }: any) => where.id === row.id && where.userId === row.userId ? row : null),
      update: vi.fn(async ({ data }: any) => { row = { ...row, ...data }; return row; }) },
      agentMessage: { findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: any) => data) } } as any;
    await createAgentRuntimeService({ prisma: db }).saveAssistantMessage({ sessionId: 'session', userId: 'operator', runtimeRunId: 'original-run',
      result: { text: '结果待核对', stopReason } as any });
    expect(row.metadata.agentRuntime.currentRun).toMatchObject({ id: 'original-run', status: 'failed', stopReason, completedAt: null });
    expect(db.agentMessage.create).toHaveBeenCalledOnce();
  });
  it('a normal actual final answer still persists complete', async () => {
    let row: any = { id: 'session', userId: 'operator', title: 'original', metadata: {} };
    const db = { agentSession: { findFirst: vi.fn(async () => row), update: vi.fn(async ({ data }: any) => { row = { ...row, ...data }; return row; }) },
      agentMessage: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) } } as any;
    await createAgentRuntimeService({ prisma: db }).saveAssistantMessage({ sessionId: 'session', userId: 'operator', runtimeRunId: 'original-run', result: { text: 'Finished', stopReason: 'final_answer' } as any });
    expect(row.metadata.agentRuntime.currentRun.status).toBe('complete');
    expect(row.metadata.agentRuntime.currentRun.completedAt).toEqual(expect.any(String));
  });
});

// Root independently reproduced completion truth for the remaining finite stop reasons.
describe('root stop budget qualification', () => {
  it.each(['max_steps', 'budget_exhausted', 'llm_failure'])('%s cannot be persisted as complete', async stopReason => {
    let row: any = { id: 'session', userId: 'operator', title: 'original', metadata: { agentRuntime: { currentRun: { id: 'original-run', status: 'running' } } } };
    const db = { agentSession: { findFirst: vi.fn(async () => row), update: vi.fn(async ({ data }: any) => { row = { ...row, ...data }; return row; }) },
      agentMessage: { findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: any) => data) } } as any;
    await createAgentRuntimeService({ prisma: db }).saveAssistantMessage({ sessionId: 'session', userId: 'operator', runtimeRunId: 'original-run',
      result: { text: 'Original task remains incomplete', stopReason } as any });
    expect(row.metadata.agentRuntime.currentRun).toMatchObject({ id: 'original-run', status: 'failed', stopReason, completedAt: null });
  });
  it('legacy runner without a stop reason retains its existing completed response contract', async () => {
    let row: any = { id: 'session', userId: 'operator', title: 'original', metadata: {} };
    const db = { agentSession: { findFirst: vi.fn(async () => row), update: vi.fn(async ({ data }: any) => { row = { ...row, ...data }; return row; }) },
      agentMessage: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) } } as any;
    await createAgentRuntimeService({ prisma: db }).saveAssistantMessage({ sessionId: 'session', userId: 'operator', runtimeRunId: 'original-run', result: { text: 'Legacy response' } });
    expect(row.metadata.agentRuntime.currentRun.status).toBe('complete');
  });
});
