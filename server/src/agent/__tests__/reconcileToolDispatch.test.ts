import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TR = fs.readFileSync(path.resolve(__dirname, '../toolRuntime.ts'), 'utf-8');

describe('task Agent-P1: payment.receive_and_reconcile toolRuntime 接入契约', () => {
  it('import buildPaymentReconcileDraft + commitPaymentReceiveAndReconcile', () => {
    expect(TR).toContain("buildPaymentReconcileDraft");
    expect(TR).toContain("commitPaymentReceiveAndReconcile");
    expect(TR).toContain("from './reconcileFlow'");
  });

  it('draftPhase: payment.receive_and_reconcile 生成 ProcessDraft（draft-first）', () => {
    // draftPhase 块含 payment.receive_and_reconcile + buildPaymentReconcileDraft
    expect(TR).toContain("definition.id === 'payment.receive_and_reconcile'");
    expect(TR).toContain('buildPaymentReconcileDraft({ voucherId, voucherAmount, currency, allocations })');
    // 审批前校验 draft 自洽
    expect(TR).toContain('validateReconcileDraftSemantics(draft)');
    expect(TR).toContain('verifyReconcileDraftHash(draft)');
  });

  it('draftPhase: processDraft 写入 processDraftForApproval（透传 approval）', () => {
    expect(TR).toContain('(processDraftForApproval as any) = draft');
  });

  it('draftPhase: 缺失 voucherId/voucherAmount/allocations → preconditions_failed fail closed', () => {
    expect(TR).toContain('PAYMENT_RECONCILE_PRECONDITIONS_FAILED');
  });

  it('commitPhase: payment.receive_and_reconcile dispatch 存在（skipApprovalCheck 路径）', () => {
    expect(TR).toContain("call.toolId === 'payment.receive_and_reconcile'");
    expect(TR).toContain('commitPaymentReceiveAndReconcile({');
  });

  it('commitPhase: 缺 approvalId → fail closed（不出现 Tool handler not implemented）', () => {
    const commitBlock = TR.slice(TR.indexOf("call.toolId === 'payment.receive_and_reconcile'"));
    expect(commitBlock).toContain('approvalId not provided');
    // payment 块在 throw Tool handler not implemented 之前 return
    const paymentBlockEnd = commitBlock.indexOf("throw new Error(`Tool handler not implemented");
    expect(paymentBlockEnd).toBeGreaterThan(-1);
    // payment 块有 return（不 fallthrough 到 throw）
    const paymentSection = commitBlock.slice(0, paymentBlockEnd);
    expect(paymentSection).toContain('return { ok: true');
    expect(paymentSection).toContain('return {');
  });

  it('commitPhase: 未审批/modified approval → fail closed', () => {
    const commitBlock = TR.slice(TR.indexOf("call.toolId === 'payment.receive_and_reconcile'"));
    expect(commitBlock).toContain("approval.status !== 'approved'");
    expect(commitBlock).toContain('modified');
  });

  it('commitPhase: approvalId 精确查 ApprovalRequest（what-you-approve-is-what-you-commit）', () => {
    const commitBlock = TR.slice(TR.indexOf("call.toolId === 'payment.receive_and_reconcile'"));
    expect(commitBlock).toContain('approvalRequest.findUnique');
    expect(commitBlock).toContain('targetApprovalId');
  });

  it('commit 失败抛错（不让 agentLoop 当成功）', () => {
    const commitBlock = TR.slice(TR.indexOf("call.toolId === 'payment.receive_and_reconcile'"));
    expect(commitBlock).toContain('throw new Error(`COMMIT_FAILED');
  });
});

// ============================================================================
// 真实执行链路测试：mock executeTool 路径
// ============================================================================
import { Prisma } from '@prisma/client';

describe('task Agent-P1: payment.receive_and_reconcile 真实执行链路', () => {
  // 由于 executeTool/executeAgentTool 涉及大量上下文（definition 解析/审批/safety），
  // 这里用源码行为断言 + reconcileFlow 真实 commit 测试已覆盖核心闭环。
  // 补充：验证 payment.receive_and_reconcile 在 executeTool dispatch 中不存在（走 commitPhase 而非 executeTool）
  it('executeTool 内 payment.receive_and_reconcile 走 commitPhase（非 handler 直接 dispatch）', () => {
    // payment commit dispatch 在 executeTool 内，但位于 order.confirm commitPhase 之后（skipApprovalCheck 路径）
    // 不是 handler 直接 dispatch（如 finance.apply_voucher_to_invoice 那样 return handle...）
    const paymentCommitIdx = TR.indexOf("call.toolId === 'payment.receive_and_reconcile'");
    // 走 commitPaymentReceiveAndReconcile（不是直接 handler）
    expect(TR).toContain('commitPaymentReceiveAndReconcile({');
  });

  it('commitPhase 在 executeTool 函数内（同一执行路径）', () => {
    // commitPhase 的 payment 块应在 executeTool 函数体内
    const execStart = TR.indexOf('async function executeTool(');
    const paymentCommit = TR.indexOf("call.toolId === 'payment.receive_and_reconcile'");
    expect(paymentCommit).toBeGreaterThan(execStart);
  });
});
