/**
 * 批次 2b「审批挂起入库」测试
 *
 * 覆盖：
 *   A. 挂起点持久化：approvalRequired 时 checkpoint.save 含 pendingApproval；
 *      决议后步末 save 覆盖清除
 *   B. resume 已决议：approved/modified → 补执行工具（skipApprovalCheck+approvalId）；
 *      rejected → 记失败不执行
 *   C. resume 未决议（pending）→ 重新挂起等待 eventBus，唤醒后补执行
 */
import { describe, expect, it, vi } from 'vitest';
import { createAgentLoop } from '../agentLoop';
import { createIdentityService } from '../identity';
import { approvalEventBus } from '../events';
import { InMemoryCheckpointManager } from '../checkpoint';
import { ToolDescriptor } from '../agentLoopTypes';
import '../toolRuntime';
import { isReceiptGuardedCommitTool } from '../toolDispatchRegistry';

const HIGH_RISK_TOOL: ToolDescriptor = {
  id: 'order.confirm',
  name: 'Confirm Order',
  scope: 'orders',
  risk: 'high',
  description: '确认订单（高风险，需审批）',
  inputHint: '{ poNumber: string }',
};

async function ownerActor() {
  return createIdentityService().resolveActorContext({
    userId: 'test-owner',
    displayName: 'Tester',
    roles: ['owner'],
    departmentIds: ['company'],
  });
}

function emitCollector() {
  const events: Array<{ type: string; payload: any }> = [];
  return {
    events,
    emit: (type: string, payload: any) => events.push({ type, payload }),
  };
}

const baseInput = async (overrides: any = {}) => ({
  actor: await ownerActor(),
  conversationId: 'ckpt_test_conv',
  message: '确认订单 PO-001',
  history: [],
  attachmentContext: [],
  signal: new AbortController().signal,
  ...overrides,
});

const CONFIG = { perToolTimeoutMs: 5000, totalBudgetMs: 10000, maxSteps: 5, maxToolsPerStep: 3, llmRepairRetries: 0 };

function finalAnswerLLM(llmCalls: any[] = []) {
  return vi.fn(async (input: any) => {
    llmCalls.push(input);
    return JSON.stringify({ thought: '已处理', action: 'final_answer', finalAnswer: '处理完成。' });
  });
}

/** 首次调用返回 approvalRequired；带 skipApprovalCheck/approvalId 时执行实际提交 */
function approvalAwareExecutor(approvalId: string, commitResult: any = { ok: true, committed: true }) {
  return vi.fn(async (req: any) => {
    if (req.approvalId || req.skipApprovalCheck) return commitResult;
    return {
      approvalRequired: true,
      approvalId,
      message: 'order.confirm 需要审批后才能执行（risk=high）。',
      risk: 'high',
      editableFields: [],
      status: 'approval_required',
    };
  });
}

describe('A. 挂起点持久化', () => {
  it('approvalRequired → checkpoint.save 含 pendingApproval（approvalId/toolId/toolInput/step）', async () => {
    const ckpt = new InMemoryCheckpointManager();
    const saveSpy = vi.spyOn(ckpt, 'save');
    const toolExecutor = approvalAwareExecutor('ar_persist_1');

    const llm = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ thought: '确认订单', action: 'call_tool', toolCalls: [{ toolId: 'order.confirm', input: { poNumber: 'PO-001' }, why: '用户要求' }] }))
      .mockResolvedValueOnce(JSON.stringify({ thought: '完成', action: 'final_answer', finalAnswer: '订单已确认。' }));

    const approvalState = { status: 'pending' };
    const loop = createAgentLoop({ llm, toolExecutor, availableTools: [HIGH_RISK_TOOL], checkpointManager: ckpt,
      approvalResolver: async () => approvalState });
    const collector = emitCollector();
    setTimeout(() => { approvalState.status = 'approved'; approvalEventBus.emit('resolved', 'ar_persist_1', { decision: 'approved' }); }, 10);

    await loop.run(await baseInput({ emit: collector.emit, config: CONFIG }));

    // 挂起时的 save：pendingApproval 已落库
    const suspendedSave = saveSpy.mock.calls.find(([c]) => c.pendingApproval);
    expect(suspendedSave).toBeDefined();
    const pa = suspendedSave![0].pendingApproval;
    expect(pa.approvalId).toBe('ar_persist_1');
    expect(pa.toolId).toBe('order.confirm');
    expect(pa.toolInput).toEqual({ poNumber: 'PO-001' });
    expect(pa.step).toBeGreaterThanOrEqual(1);

    // 决议执行完成后的最后一次 save：pendingApproval 已清除
    const lastSave = saveSpy.mock.calls[saveSpy.mock.calls.length - 1][0];
    expect(lastSave.pendingApproval ?? null).toBeNull();
  });
});

describe('B. resume 已决议补执行', () => {
  function seedCheckpoint(ckpt: InMemoryCheckpointManager, approvalId: string) {
    // 直接写入 InMemory store：模拟"挂起期间进程崩溃"后磁盘上的状态
    (ckpt as any).store.set('ckpt_test_conv', {
      id: 'ckp_seed',
      conversationId: 'ckpt_test_conv',
      step: 1,
      message: '确认订单 PO-001',
      scratchpad: { thoughts: [{ step: 1, content: '确认订单' }], toolCalls: [] },
      iterations: [],
      pendingApproval: {
        approvalId,
        step: 1,
        toolId: 'order.confirm',
        toolInput: { poNumber: 'PO-001' },
        why: '用户要求',
        suspendedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    });
  }

  it('approved → 补执行工具（skipApprovalCheck + approvalId + 原 input），结果进 scratchpad', async () => {
    const ckpt = new InMemoryCheckpointManager();
    seedCheckpoint(ckpt, 'ar_resume_ok');
    const toolExecutor = approvalAwareExecutor('ar_resume_ok', { ok: true, committed: true, orderId: 'order_1' });

    const llmCalls: any[] = [];
    const llm = finalAnswerLLM(llmCalls);
    const loop = createAgentLoop({
      llm, toolExecutor, availableTools: [HIGH_RISK_TOOL], checkpointManager: ckpt,
      canResumeApprovalTool: isReceiptGuardedCommitTool,
      approvalResolver: async () => ({ status: 'approved', decisionNote: null }),
    });
    const collector = emitCollector();

    const result = await loop.run(await baseInput({ emit: collector.emit, config: CONFIG }));

    // 补执行：toolExecutor 收到 skipApprovalCheck + approvalId + 原 toolInput
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    const execReq = toolExecutor.mock.calls[0][0];
    expect(execReq.skipApprovalCheck).toBe(true);
    expect(execReq.approvalId).toBe('ar_resume_ok');
    expect(execReq.input).toEqual({ poNumber: 'PO-001' });

    // 补执行结果注入 LLM 上下文（user messages 含工具输出）
    const llmContext = JSON.stringify(llmCalls[0]?.messages || []);
    expect(llmContext).toContain('committed');

    // 事件：approval_resume complete
    const resumeEvent = collector.events.find(e => e.payload?.phase === 'approval_resume' && e.payload?.status === 'complete');
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent!.payload.metadata?.decision).toBe('approved');

    // 正常完成 → checkpoint 清理
    expect(result.text).toContain('处理完成');
  });

  it('rejected → 不执行工具，APPROVAL_REJECTED 记录进 scratchpad', async () => {
    const ckpt = new InMemoryCheckpointManager();
    seedCheckpoint(ckpt, 'ar_resume_rej');
    const toolExecutor = approvalAwareExecutor('ar_resume_rej');

    const llmCalls: any[] = [];
    const llm = finalAnswerLLM(llmCalls);
    const loop = createAgentLoop({
      llm, toolExecutor, availableTools: [HIGH_RISK_TOOL], checkpointManager: ckpt,
      canResumeApprovalTool: isReceiptGuardedCommitTool,
      approvalResolver: async () => ({ status: 'rejected', decisionNote: '数量有误' }),
    });

    await loop.run(await baseInput({ config: CONFIG }));

    expect(toolExecutor).not.toHaveBeenCalled();
    const llmContext = JSON.stringify(llmCalls[0]?.messages || []);
    expect(llmContext).toContain('APPROVAL_REJECTED');
    expect(llmContext).toContain('数量有误');
  });

  it('modified → 用 modifiedInput 补执行', async () => {
    const ckpt = new InMemoryCheckpointManager();
    seedCheckpoint(ckpt, 'ar_resume_mod');
    const toolExecutor = approvalAwareExecutor('ar_resume_mod');

    const llm = finalAnswerLLM();
    const loop = createAgentLoop({
      llm, toolExecutor, availableTools: [HIGH_RISK_TOOL], checkpointManager: ckpt,
      canResumeApprovalTool: isReceiptGuardedCommitTool,
      approvalResolver: async () => ({
        status: 'modified',
        decisionNote: '改了数量',
        modifiedInput: { poNumber: 'PO-001', quantity: 500 },
      }),
    });

    await loop.run(await baseInput({ config: CONFIG }));

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor.mock.calls[0][0].input).toEqual({ poNumber: 'PO-001', quantity: 500 });
  });
});

describe('C. resume 未决议重新挂起', () => {
  it('resolver 返回 pending → 重新等待 eventBus，approved 唤醒后补执行', async () => {
    const ckpt = new InMemoryCheckpointManager();
    (ckpt as any).store.set('ckpt_test_conv', {
      id: 'ckp_seed',
      conversationId: 'ckpt_test_conv',
      step: 1,
      message: '确认订单 PO-001',
      scratchpad: { thoughts: [{ step: 1, content: '确认订单' }], toolCalls: [] },
      iterations: [],
      pendingApproval: {
        approvalId: 'ar_rewait',
        step: 1,
        toolId: 'order.confirm',
        toolInput: { poNumber: 'PO-001' },
        why: '用户要求',
        suspendedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    });
    const toolExecutor = approvalAwareExecutor('ar_rewait', { ok: true, committed: true });

    const llm = finalAnswerLLM();
    const approvalState = { status: 'pending' };
    const loop = createAgentLoop({
      llm, toolExecutor, availableTools: [HIGH_RISK_TOOL], checkpointManager: ckpt,
      canResumeApprovalTool: isReceiptGuardedCommitTool,
      approvalResolver: async () => approvalState,
    });
    const collector = emitCollector();

    // resume 重新挂起后，审批中心（eventBus）决议唤醒
    setTimeout(() => { approvalState.status = 'approved'; approvalEventBus.emit('resolved', 'ar_rewait', { decision: 'approved' }); }, 20);

    const result = await loop.run(await baseInput({ emit: collector.emit, config: CONFIG }));

    // 唤醒后补执行
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor.mock.calls[0][0].approvalId).toBe('ar_rewait');
    const resumeEvent = collector.events.find(e => e.payload?.phase === 'approval_resume' && e.payload?.status === 'complete');
    expect(resumeEvent!.payload.metadata?.decision).toBe('approved');
    expect(result.text).toContain('处理完成');
  });
});
