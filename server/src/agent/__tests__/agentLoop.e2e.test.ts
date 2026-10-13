import { describe, expect, it, vi } from 'vitest';
import { createAgentLoop } from '../agentLoop';
import { createIdentityService } from '../identity';
import { approvalEventBus } from '../events';
import { ToolDescriptor } from '../agentLoopTypes';
import { InMemoryCheckpointManager } from '../checkpoint';
import { buildOrderConfirmProcessDraft } from '../toolRegistry';

const ORDER_CONFIRM_TOOL: ToolDescriptor = {
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

function scriptedLLM(scripts: string[]) {
  let i = 0;
  return vi.fn(async () => scripts[i++] || scripts[scripts.length - 1]);
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
  conversationId: 'e2e-approval-original',
  message: '确认订单 PO-001',
  history: [],
  attachmentContext: [],
  signal: new AbortController().signal,
  ...overrides,
});

function makeValidSnapshot() {
  return {
    orderId: 'order_real_id', poNumber: 'PO-001', status: 'Pending',
    amount: 12000, currency: 'USD',
    customerRelationId: 'rel_cust_1', customerName: 'ACME', lineCount: 3,
  };
}

function makeOrderConfirmDraft() {
  return buildOrderConfirmProcessDraft({
    poNumber: 'PO-001', previousStatus: 'Pending', newStatus: 'Confirmed',
    snapshot: makeValidSnapshot(),
  });
}

/**
 * 构造 toolExecutor：第一次调用返回 approvalRequired，approval resolved 后第二次调用返回实际结果。
 */
function makeApprovalAwareToolExecutor(onCommitCall: (input: any) => any) {
  let callCount = 0;
  return vi.fn(async (req: any) => {
    callCount++;
    // 审批通过后重跑（approvalId/skipApprovalCheck 在 req 顶层，非 req.input）
    if (req.approvalId || req.skipApprovalCheck) {
      return onCommitCall(req);
    }
    // 首次调用：返回 approvalRequired + processDraft
    return {
      approvalRequired: true,
      approvalId: 'ar_e2e_test',
      message: 'order.confirm 需要审批后才能执行（risk=high）。',
      risk: 'high',
      editableFields: [],
      processDraft: makeOrderConfirmDraft(),
      status: 'approval_required',
    };
  });
}

describe('P1-D e2e: agent loop order.confirm 全链路', () => {
  it('approval_required -> approved -> commit success: outputPreview 含结构化字段', async () => {
    const commitResult = {
      ok: true, committed: true,
      orderId: 'order_real_id', poNumber: 'PO-001',
      previousStatus: 'Pending', newStatus: 'Confirmed',
      transactionId: 'tx_e2e_1',
      invoiceId: 'INV_e2e_1', invoiceNumber: 'INV-20260628-123456',
      amount: 12000, currency: 'USD',
      customerRelationId: 'rel_cust_1', customerName: 'ACME',
      auditId: 'audit_commit_tx_e2e_1', idempotencyKey: makeOrderConfirmDraft().idempotencyKey,
      entityLinks: [
        { linkKind: 'aboutOrder', fromType: 'invoice', fromId: 'INV_e2e_1', toType: 'order', toId: 'order_real_id' },
        { linkKind: 'billTo', fromType: 'invoice', fromId: 'INV_e2e_1', toType: 'relation.organization', toId: 'rel_cust_1' },
      ],
      postCommitQueue: [],
    };
    const toolExecutor = makeApprovalAwareToolExecutor(() => commitResult);

    const llm = scriptedLLM([
      JSON.stringify({ thought: '确认订单', action: 'call_tool', toolCalls: [{ toolId: 'order.confirm', input: { poNumber: 'PO-001' }, why: '用户要求确认' }] }),
      JSON.stringify({ thought: '已完成', action: 'final_answer', finalAnswer: '订单已确认。' }),
    ]);

    const approvalState = { status: 'pending' };
    const loop = createAgentLoop({ llm, toolExecutor, availableTools: [ORDER_CONFIRM_TOOL],
      checkpointManager: new InMemoryCheckpointManager(), approvalResolver: async id => id === 'ar_e2e_test' ? approvalState : null });
    const collector = emitCollector();

    // 延迟触发 approval resolved（approved）
    setTimeout(() => { approvalState.status = 'approved'; approvalEventBus.emit('resolved', 'ar_e2e_test', { decision: 'approved' }); }, 10);

    await loop.run(await baseInput({ emit: collector.emit, config: { perToolTimeoutMs: 5000, totalBudgetMs: 10000, maxSteps: 5, maxToolsPerStep: 3, llmRepairRetries: 0 } }));

    // 验证：approval_required 事件
    const blockedEvent = collector.events.find(e => e.payload?.phase === 'tool_call' && e.payload?.status === 'blocked');
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent!.payload.metadata?.approvalId).toBe('ar_e2e_test');

    // 验证：commit success 事件含 outputPreview 结构化字段
    const completeEvent = collector.events.find(e => e.payload?.phase === 'tool_call_end' && e.payload?.status === 'complete' && e.payload?.toolId === 'order.confirm');
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.payload.metadata?.outputPreview).toBeDefined();
    expect(completeEvent!.payload.metadata?.outputPreview?.ok).toBe(true);
    expect(completeEvent!.payload.metadata?.outputPreview?.orderId).toBe('order_real_id');
    expect(completeEvent!.payload.metadata?.outputPreview?.invoiceId).toBe('INV_e2e_1');
    expect(completeEvent!.payload.metadata?.outputPreview?.amount).toBe(12000);
    expect(completeEvent!.payload.metadata?.outputPreview?.currency).toBe('USD');
    expect(completeEvent!.payload.metadata?.outputPreview?.entityLinks).toHaveLength(2);
  });

  it('rejected: 审批被拒绝 -> 无 commit 副作用', async () => {
    const onCommit = vi.fn(() => ({ ok: true }));
    const toolExecutor = makeApprovalAwareToolExecutor(onCommit);

    const llm = scriptedLLM([
      JSON.stringify({ thought: '确认订单', action: 'call_tool', toolCalls: [{ toolId: 'order.confirm', input: { poNumber: 'PO-001' } }] }),
      JSON.stringify({ thought: '审批被拒', action: 'final_answer', finalAnswer: '订单未确认。' }),
    ]);

    const approvalState = { status: 'pending' };
    const loop = createAgentLoop({ llm, toolExecutor, availableTools: [ORDER_CONFIRM_TOOL],
      checkpointManager: new InMemoryCheckpointManager(), approvalResolver: async id => id === 'ar_e2e_test' ? approvalState : null });
    const collector = emitCollector();

    setTimeout(() => { approvalState.status = 'rejected'; approvalEventBus.emit('resolved', 'ar_e2e_test', { decision: 'rejected' }); }, 10);

    await loop.run(await baseInput({ emit: collector.emit, config: { perToolTimeoutMs: 5000, totalBudgetMs: 10000, maxSteps: 5, maxToolsPerStep: 3, llmRepairRetries: 0 } }));

    // 验证：commit 未执行（onCommit 未被调用）
    expect(onCommit).not.toHaveBeenCalled();
    // 验证：无 commit success 事件
    const completeEvent = collector.events.find(e => e.payload?.phase === 'tool_call_end' && e.payload?.status === 'complete' && e.payload?.toolId === 'order.confirm');
    expect(completeEvent).toBeUndefined();
  });

  it('commit fail-closed: outputPreview 缺失，errorFeedback/errorPreview 出现（稳定 code）', async () => {
    const failResult = {
      ok: false, committed: false,
      error: 'COMMIT_FAILED: approval ar_e2e_test not found or not approved (status=rejected)',
      errorFeedback: {
        code: 'APPROVAL_REJECTED',
        message: '审批被拒绝',
        userAction: '审批已被拒绝，无法执行 order.confirm，请确认是否需要重新发起审批。',
        retryable: false,
      },
      poNumber: 'PO-001',
    };
    // commit 失败：toolExecutor throw（agentLoop catch 后对 order.confirm 生成 errorPreview）
    const toolExecutor = makeApprovalAwareToolExecutor(() => { throw new Error('COMMIT_FAILED: approval ar_e2e_test not found or not approved (status=rejected)'); });

    const llm = scriptedLLM([
      JSON.stringify({ thought: '确认订单', action: 'call_tool', toolCalls: [{ toolId: 'order.confirm', input: { poNumber: 'PO-001' } }] }),
      JSON.stringify({ thought: '失败', action: 'final_answer', finalAnswer: '确认失败。' }),
    ]);

    const approvalState = { status: 'pending' };
    const loop = createAgentLoop({ llm, toolExecutor, availableTools: [ORDER_CONFIRM_TOOL],
      checkpointManager: new InMemoryCheckpointManager(), approvalResolver: async id => id === 'ar_e2e_test' ? approvalState : null });
    const collector = emitCollector();

    setTimeout(() => { approvalState.status = 'approved'; approvalEventBus.emit('resolved', 'ar_e2e_test', { decision: 'approved' }); }, 10);

    await loop.run(await baseInput({ emit: collector.emit, config: { perToolTimeoutMs: 5000, totalBudgetMs: 10000, maxSteps: 5, maxToolsPerStep: 3, llmRepairRetries: 0 } }));

    // 验证：order.confirm 失败事件含 errorPreview（稳定 code）
    const failedEvent = collector.events.find(e => e.payload?.phase === 'tool_call_end' && e.payload?.status === 'failed' && e.payload?.toolId === 'order.confirm');
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.payload.metadata?.errorPreview).toBeDefined();
    expect(failedEvent!.payload.metadata?.errorPreview?.code).toBe('APPROVAL_REJECTED');
  });
});

describe('P1-D e2e: fail-closed 矩阵（errorPreview 稳定 code）', () => {
  async function runFailClosedScenario(commitThrowMsg: string, expectedCode: string) {
    const toolExecutor = makeApprovalAwareToolExecutor(() => { throw new Error(commitThrowMsg); });
    const llm = scriptedLLM([
      JSON.stringify({ thought: '确认订单', action: 'call_tool', toolCalls: [{ toolId: 'order.confirm', input: { poNumber: 'PO-001' } }] }),
      JSON.stringify({ thought: '失败', action: 'final_answer', finalAnswer: '确认失败。' }),
    ]);
    const approvalState = { status: 'pending' };
    const loop = createAgentLoop({ llm, toolExecutor, availableTools: [ORDER_CONFIRM_TOOL],
      checkpointManager: new InMemoryCheckpointManager(), approvalResolver: async id => id === 'ar_e2e_test' ? approvalState : null });
    const collector = emitCollector();
    setTimeout(() => { approvalState.status = 'approved'; approvalEventBus.emit('resolved', 'ar_e2e_test', { decision: 'approved' }); }, 10);
    await loop.run(await baseInput({ emit: collector.emit, config: { perToolTimeoutMs: 5000, totalBudgetMs: 10000, maxSteps: 5, maxToolsPerStep: 3, llmRepairRetries: 0 } }));
    const failedEvent = collector.events.find(e => e.payload?.phase === 'tool_call_end' && e.payload?.status === 'failed' && e.payload?.toolId === 'order.confirm');
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.payload.metadata?.errorPreview).toBeDefined();
    expect(failedEvent!.payload.metadata?.errorPreview?.code).toBe(expectedCode);
    return failedEvent;
  }

  it('modified unsupported -> errorPreview.code = APPROVAL_MODIFIED_UNSUPPORTED', async () => {
    await runFailClosedScenario(
      'COMMIT_FAILED: order.confirm does not support modified approval (status=modified)',
      'APPROVAL_MODIFIED_UNSUPPORTED',
    );
  });

  it('status drift -> errorPreview.code = STATUS_DRIFT', async () => {
    await runFailClosedScenario('STATUS_DRIFT: expected Pending, actual Confirmed', 'STATUS_DRIFT');
  });

  it('invalid amount -> errorPreview.code = INVOICE_AMOUNT_INVALID', async () => {
    await runFailClosedScenario('INVOICE_AMOUNT_INVALID: draft amount=0 (must be > 0)', 'INVOICE_AMOUNT_INVALID');
  });

  it('hash mismatch -> errorPreview.code = PROCESS_DRAFT_HASH_MISMATCH', async () => {
    await runFailClosedScenario('COMMIT_FAILED: process draft hash mismatch (expected abc, got def)', 'PROCESS_DRAFT_HASH_MISMATCH');
  });

  it('semantic validation failed -> errorPreview.code = SEMANTIC_VALIDATION_FAILED', async () => {
    await runFailClosedScenario('COMMIT_FAILED: ProcessDraft semantic validation failed: MISSING_FINANCE_CREATE_INVOICE', 'SEMANTIC_VALIDATION_FAILED');
  });

  it('missing draft -> errorPreview.code = PROCESS_DRAFT_MISSING', async () => {
    await runFailClosedScenario('COMMIT_FAILED: no approved process draft found for order.confirm', 'PROCESS_DRAFT_MISSING');
  });
});
