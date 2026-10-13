import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentLoop, type ApprovalResolutionSnapshot } from '../agentLoop';
import { InMemoryCheckpointManager, PrismaCheckpointManager } from '../checkpoint';
import { createIdentityService } from '../identity';
import { approvalEventBus } from '../events';
import { isReceiptGuardedCommitTool, registerCommitTool } from '../toolDispatchRegistry';

const approvalId = 'approval-original';
const conversationId = 'actor-bound-conversation';
const input = { poNumber: 'PO-ORIGINAL' };
const tools = [
  { id: 'order.confirm', name: 'Confirm', scope: 'orders', risk: 'high' as const, description: 'Confirm' },
  { id: 'orders.read', name: 'Read', scope: 'orders', risk: 'low' as const, description: 'Read' },
];
const plan = JSON.stringify({ thought: 'original objective', action: 'call_tool', toolCalls: [
  { toolId: 'order.confirm', input }, { toolId: 'orders.read', input: {} },
] });
const final = JSON.stringify({ thought: 'done', action: 'final_answer', finalAnswer: 'Finished' });
afterEach(() => { vi.useRealTimers(); approvalEventBus.removeAllListeners('resolved'); });

async function setup(options: { onBlocked?: (h: any) => void; resolver?: boolean; resume?: boolean; guard?: (id: string) => boolean } = {}) {
  const checkpoint = new InMemoryCheckpointManager();
  const save = vi.spyOn(checkpoint, 'save');
  const clear = vi.spyOn(checkpoint, 'clear');
  const controller = new AbortController();
  const events: any[] = [];
  const store = { decision: { status: 'pending' } as ApprovalResolutionSnapshot | null };
  const resolver = vi.fn(async () => store.decision);
  const commit = vi.fn(async (_request: any) => ({ ok: true, committed: true, orderId: 'order-original' } as any));
  const later = vi.fn(async () => ({ ok: true, orders: [] }));
  const execute = vi.fn(async (request: any) => request.toolId === 'orders.read' ? later()
    : request.skipApprovalCheck ? commit(request) : { approvalRequired: true, approvalId, risk: 'high' });
  const llm = vi.fn().mockResolvedValueOnce(options.resume ? final : plan).mockResolvedValue(final);
  const actor = await createIdentityService().resolveActorContext({ userId: 'operator', roles: ['owner'], departmentIds: ['company'] });
  const h: any = { checkpoint, save, clear, controller, store, resolver, commit, later, execute, llm, events };
  if (options.resume) await checkpoint.save({ id: 'original-checkpoint', conversationId, step: 1,
    message: 'original objective', scratchpad: { thoughts: [], toolCalls: [] }, iterations: [],
    pendingApproval: { approvalId, toolId: 'order.confirm', toolInput: input, step: 1, suspendedAt: '2026-10-02T00:00:00.000Z' },
    createdAt: '2026-10-02T00:00:00.000Z' });
  const loop = createAgentLoop({ llm, toolExecutor: execute, availableTools: tools, checkpointManager: checkpoint,
    canResumeApprovalTool: options.guard,
    ...(options.resolver === false ? {} : { approvalResolver: resolver }) });
  h.run = () => loop.run({ actor, conversationId, message: 'original objective', history: [], attachmentContext: [],
    signal: controller.signal, config: { maxSteps: 3, maxToolsPerStep: 3, perToolTimeoutMs: 5000, totalBudgetMs: 2_000_000, llmRepairRetries: 0 },
    emit: (type, payload) => { events.push({ type, payload }); if (payload?.status === 'blocked') options.onBlocked?.(h); } });
  return h;
}

async function remainsPending(h: any) {
  expect(h.clear).not.toHaveBeenCalled();
  expect((await h.checkpoint.load(conversationId))?.pendingApproval).toMatchObject({ approvalId, toolId: 'order.confirm', toolInput: input });
  expect(h.later).not.toHaveBeenCalled();
}

describe('actual approval loop uses durable decision and protects interruption', () => {
  it('a committed decision before subscription is reread without depending on a lost event', async () => {
    const h = await setup({ onBlocked: h => { h.store.decision = { status: 'approved' }; approvalEventBus.emit('resolved', approvalId, { decision: 'approved' }); } });
    const run = h.run();
    const fallback = setTimeout(() => h.controller.abort(), 30);
    await run; clearTimeout(fallback);
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.commit.mock.calls[0][0]).toMatchObject({ approvalId, input, skipApprovalCheck: true });
    expect(h.resolver).toHaveBeenCalled();
  });
  it('an approved event cannot override an authoritative pending row', async () => {
    const h = await setup({ onBlocked: h => setTimeout(() => {
      approvalEventBus.emit('resolved', approvalId, { decision: 'approved' });
      setTimeout(() => h.controller.abort(), 10);
    }, 0) });
    await h.run();
    expect(h.commit).not.toHaveBeenCalled();
    await remainsPending(h);
  });
  it('disconnect abort retains the original pending record and starts no following tool', async () => {
    const h = await setup({ onBlocked: h => setTimeout(() => h.controller.abort(), 0) });
    const result = await h.run();
    expect(result.stopReason).not.toBe('final_answer');
    expect(h.commit).not.toHaveBeenCalled();
    await remainsPending(h);
    expect(h.llm).toHaveBeenCalledOnce();
  });
  it('approval wait timeout retains pending instead of step-save, clear, or a new tool', async () => {
    vi.useFakeTimers();
    const h = await setup();
    const run = h.run();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
    await run;
    expect(h.commit).not.toHaveBeenCalled();
    await remainsPending(h);
    expect(h.llm).toHaveBeenCalledOnce();
  });
  it('missing authoritative resolver stops rather than treating event payload as permission', async () => {
    const h = await setup({ resolver: false, onBlocked: h => setTimeout(() => {
      approvalEventBus.emit('resolved', approvalId, { decision: 'approved' });
      h.controller.abort();
    }, 0) });
    await h.run();
    expect(h.commit).not.toHaveBeenCalled();
    await remainsPending(h);
  });
  it.each(['deleted', 'expired', 'surprise', ''])('unknown stored decision %j never executes a tool', async status => {
    const h = await setup({ resume: true });
    h.store.decision = { status };
    await h.run();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.llm).not.toHaveBeenCalled();
    await remainsPending(h);
  });
  it('a failed authority reread stops and retains the durable suspended checkpoint', async () => {
    const h = await setup({ resume: true });
    h.resolver.mockRejectedValue(new Error('query unavailable'));
    const run = h.run(); const fallback = setTimeout(() => h.controller.abort(), 30);
    const result = await run; clearTimeout(fallback);
    expect(result.text).toContain('待核对');
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.llm).not.toHaveBeenCalled();
    await remainsPending(h);
  });
  it('a missing stored approval is unknown and never becomes approved by a forged event', async () => {
    const h = await setup({ resume: true }); h.store.decision = null;
    const run = h.run(); const fallback = setTimeout(() => { approvalEventBus.emit('resolved', approvalId, { decision: 'approved' }); h.controller.abort(); }, 20);
    await run; clearTimeout(fallback);
    expect(h.commit).not.toHaveBeenCalled();
    await remainsPending(h);
  });
  it('initial checkpoint save failure reports unconfirmed persistence and performs no commit or subsequent planning', async () => {
    const h = await setup({ onBlocked: h => setTimeout(() => { h.store.decision = { status: 'approved' }; approvalEventBus.emit('resolved', approvalId, { decision: 'approved' }); }, 0) });
    h.save.mockRejectedValueOnce(new Error('storage unavailable'));
    const result = await h.run();
    expect(result.text).toContain('待核对');
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.later).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.events.filter((e: any) => e.payload?.status === 'blocked')).toHaveLength(0);
    expect(h.llm).toHaveBeenCalledOnce();
  });
  it('checkpoint load failure starts no tool and does not delete an unread recovery point', async () => {
    const h = await setup(); vi.spyOn(h.checkpoint, 'load').mockRejectedValueOnce(new Error('unavailable'));
    const result = await h.run();
    expect(result.text).toContain('待核对');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
  });
  it.each(['FORBIDDEN', 'COMMIT_REPLAY_BLOCKED', 'APPROVAL_MODIFIED_UNSUPPORTED'])('structured %s remains failure and cannot unlock the following tool', async code => {
    const h = await setup({ onBlocked: h => setTimeout(() => { h.store.decision = { status: 'approved' }; approvalEventBus.emit('resolved', approvalId, { decision: 'approved' }); }, 0) });
    h.commit.mockResolvedValue({ ok: false, committed: false, error: code, errorFeedback: { code, message: code, retryable: false } });
    const result = await h.run();
    expect(h.commit).toHaveBeenCalledOnce();
    expect(result.text).toContain('待核对');
    expect(h.events.some((e: any) => e.payload?.phase === 'tool_call_end' && e.payload?.metadata?.approvalId === approvalId && e.payload?.status === 'complete')).toBe(false);
    expect(result.thoughtProcess).toContain(code);
    const failure = h.events.find((e: any) => e.payload?.phase === 'tool_call_end' && e.payload?.status === 'failed');
    expect(failure?.payload?.metadata).toMatchObject({ ok: false, error: { code }, errorPreview: { code } });
    await remainsPending(h);
  });
  it('post-tool checkpoint failure leaves the original pending point, not a false completed run', async () => {
    const h = await setup({ onBlocked: h => setTimeout(() => { h.store.decision = { status: 'approved' }; approvalEventBus.emit('resolved', approvalId, { decision: 'approved' }); }, 0) });
    h.save.mockImplementationOnce(InMemoryCheckpointManager.prototype.save.bind(h.checkpoint)).mockRejectedValue(new Error('result persistence failed'));
    const result = await h.run();
    expect(h.commit).toHaveBeenCalledOnce();
    expect(result.text).toContain('待核对');
    await remainsPending(h);
    expect(h.llm).toHaveBeenCalledOnce();
  });
  it('production missing checkpoint delegate is a storage failure rather than durable success', async () => {
    const manager = new PrismaCheckpointManager({} as any);
    await expect(manager.load(conversationId)).rejects.toThrow();
    await expect(manager.save({ id: 'checkpoint', conversationId, step: 1, message: 'original',
      scratchpad: { thoughts: [], toolCalls: [] }, iterations: [], createdAt: '2026-10-02T00:00:00.000Z' })).rejects.toThrow();
    await expect(manager.clear(conversationId)).rejects.toThrow();
  });
  it('an approved older checkpoint without a current receipt capability cannot blindly rerun', async () => {
    const h = await setup({ resume: true }); h.store.decision = { status: 'approved' };
    await h.run(); expect(h.commit).not.toHaveBeenCalled(); expect(h.llm).not.toHaveBeenCalled(); await remainsPending(h);
  });
  it('a receipt guarded injected executor preserves original identity on lawful resume', async () => {
    registerCommitTool('order.confirm', async () => ({ ok: true }));
    const h = await setup({ resume: true, guard: isReceiptGuardedCommitTool }); h.store.decision = { status: 'approved' };
    const result = await h.run();
    expect(h.commit).toHaveBeenCalledOnce(); expect(h.commit.mock.calls[0][0]).toMatchObject({ approvalId, input, skipApprovalCheck: true });
    expect(result.stopReason).toBe('final_answer'); expect(h.clear).toHaveBeenCalledOnce();
  });
  it('receipt gated restart retains COMMIT_REPLAY_BLOCKED without planning or deleting its checkpoint', async () => {
    registerCommitTool('order.confirm', async () => ({ ok: true }));
    const h = await setup({ resume: true, guard: isReceiptGuardedCommitTool }); h.store.decision = { status: 'approved' };
    h.commit.mockResolvedValue({ ok: false, committed: false, errorFeedback: { code: 'COMMIT_REPLAY_BLOCKED', message: 'manual check required' } });
    const result = await h.run(); expect(result.thoughtProcess).toContain('COMMIT_REPLAY_BLOCKED'); expect(h.llm).not.toHaveBeenCalled(); await remainsPending(h);
  });
  it('a notification during an in-flight pending read forces another authoritative read', async () => {
    const h = await setup({ onBlocked: h => setTimeout(() => { h.store.decision = { status: 'approved' }; approvalEventBus.emit('resolved', approvalId); }, 0) });
    h.resolver.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { status: 'pending' }; });
    await h.run(); expect(h.resolver.mock.calls.length).toBeGreaterThanOrEqual(2); expect(h.commit).toHaveBeenCalledOnce();
  });
  it('late read completion after disconnect never invokes the approved tool', async () => {
    const h = await setup({ onBlocked: h => setTimeout(() => h.controller.abort(), 0) });
    let finish!: (snapshot: ApprovalResolutionSnapshot) => void;
    h.resolver.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await h.run(); finish({ status: 'approved' }); await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.commit).not.toHaveBeenCalled(); await remainsPending(h); expect(approvalEventBus.listenerCount('resolved')).toBe(0);
  });
});

describe('root ordinary framework failure barrier', () => {
  it.each(['FORBIDDEN', 'COMMIT_REPLAY_BLOCKED', 'SOURCE_UNAVAILABLE'])('ordinary %s cannot start another tool or report the plan complete', async code => {
    const h = await setup();
    h.execute.mockImplementation(async (request: any) => request.toolId === 'orders.read' ? h.later()
      : { ok: false, committed: false, errorFeedback: { code, message: 'Original outcome requires reconciliation', retryable: false } });
    const result = await h.run();
    expect(result.stopReason).toBe('recovery_required');
    expect(h.later).not.toHaveBeenCalled();
    expect(h.llm).toHaveBeenCalledOnce();
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(result.thoughtProcess).toContain(code);
    expect(h.events.some((e: any) => e.payload?.phase === 'tool_call_end' && e.payload?.status === 'failed' && e.payload?.metadata?.ok === false)).toBe(true);
  });
});
