import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { executeTool } from '../toolRuntime';
import { buildPaymentReconcileDraft } from '../reconcileFlow';

// ============================================================================
// task Agent-P1: payment.receive_and_reconcile 真实 executeTool 行为测试
// 覆盖竹衍codex 要求：approvalId commit / 无 approvalId fail / modified fail / not approved fail
// ============================================================================

function makeCommitTx() {
  const voucher = { id: 'V1', type: 'Receipt', amount: new Prisma.Decimal(1000), deletedAt: null, status: 'unreconciled', currency: 'USD' };
  const invoices = { I1: { id: 'I1', type: 'Receivable', amount: new Prisma.Decimal(600), deletedAt: null, status: 'Issued', currency: 'USD' } };
  // applyAllocation 的 select 子句包含 voucherId + invoiceId（用于幂等再申请的排除过滤器）
  const allocsForRecalc = [{ appliedAmount: new Prisma.Decimal(600), voucherId: 'V1', invoiceId: 'I1' }];
  return {
    // This original receipt voucher is not a Customer cash-refund outlet. The
    // shared allocation kernel now verifies the genuine refund FK first.
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) },
    creditNoteRefundReturn: { findUnique: vi.fn().mockResolvedValue(null) },
    creditNoteAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRawUnsafe: vi.fn(async (sql: string) => sql.includes('MaterialReturn') ? [] : [{ id: 'V1' }]), // No claim source; preserve old voucher lock stub.
    paymentVoucher: {
      findUnique: vi.fn().mockResolvedValue(voucher),
      update: vi.fn().mockResolvedValue({}),
    },
    invoice: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => invoices[where.id as keyof typeof invoices] ?? null),
      update: vi.fn().mockResolvedValue({}),
    },
    invoiceAllocation: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue(allocsForRecalc),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
  };
}

describe('task Agent-P1: executeTool payment.receive_and_reconcile commit 路径', () => {
  it('skipApprovalCheck + approvalId + approved payload → committed', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const tx = makeCommitTx();
    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      approvalRequest: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'AP1', requesterId: 'u_finance', status: 'approved', actionType: 'tool:payment.receive_and_reconcile', payload: { processDraft: draft },
        }),
      },
    } as any;

    const result = await executeTool(prisma, {
      toolId: 'payment.receive_and_reconcile',
      input: { voucherId: 'V1', voucherAmount: 1000, currency: 'USD', allocations: [{ invoiceId: 'I1', appliedAmount: 600 }] },
      approvalId: 'AP1',
    } as any);

    expect(result).toHaveProperty('ok', true);
    expect(result).toHaveProperty('status', 'committed');
    expect(result).toHaveProperty('voucherId', 'V1');
  });

  it('无 approvalId → fail closed（APPROVAL_ID_MISSING）', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, {
      toolId: 'payment.receive_and_reconcile',
      input: {},
    } as any);

    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    // 不调用 commit
    expect(prisma.approvalRequest.findUnique).not.toHaveBeenCalled();
  });

  it('approval 不存在 → fail closed（APPROVAL_NOT_FOUND）', async () => {
    const prisma = {
      approvalRequest: { findUnique: vi.fn().mockResolvedValue(null) },
    } as any;
    const result: any = await executeTool(prisma, {
      toolId: 'payment.receive_and_reconcile',
      input: {},
      approvalId: 'NOPE',
    } as any);

    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_NOT_FOUND');
  });

  it('approval status=modified → fail closed（APPROVAL_MODIFIED_UNSUPPORTED）', async () => {
    const prisma = {
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) },
    } as any;
    const result: any = await executeTool(prisma, {
      toolId: 'payment.receive_and_reconcile',
      input: {},
      approvalId: 'AP1',
    } as any);

    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
  });

  it('approval status=pending（未审批）→ fail closed（APPROVAL_PENDING）', async () => {
    const prisma = {
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) },
    } as any;
    const result: any = await executeTool(prisma, {
      toolId: 'payment.receive_and_reconcile',
      input: {},
      approvalId: 'AP1',
    } as any);

    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
  });

  it('approval payload 无 processDraft → fail closed（PROCESS_DRAFT_MISSING，不伪成功）', async () => {
    const prisma = {
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:payment.receive_and_reconcile', payload: {} }) },
      $transaction: vi.fn(),
    } as any;
    const result: any = await executeTool(prisma, {
      toolId: 'payment.receive_and_reconcile',
      input: {},
      approvalId: 'AP1',
    } as any);
    // fail-closed：返回结构化错误（不 throw），不伪成功
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('PROCESS_DRAFT_MISSING');
    // $transaction 不调用（no service bypass）
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Phase 2 · 2.2: executeTool 全链路重放幂等 E2E（经 registerCommitTool 收口层 receipt）
// 证明：同一 approvalId 重放不会重复执行 commit 核心（$transaction 仅一次），
//       第二次返回 receipt 缓存结果（replayed 标记），不产生重复核销/重复 audit。
// ============================================================================

describe('task 2.2: executeTool payment.receive_and_reconcile 全链路重放幂等', () => {
  function makeReceiptAwarePrisma(draft: any) {
    const tx = makeCommitTx();
    const receipts = new Map<string, any>();
    const txFn = vi.fn(async (fn: any, _opts?: any) => fn(tx));
    const prisma = {
      $transaction: txFn,
      approvalRequest: {
        findUnique: vi.fn().mockResolvedValue({ id: 'AP1', requesterId: 'u_finance', status: 'approved', actionType: 'tool:payment.receive_and_reconcile', payload: { processDraft: draft } }),
      },
      agentCommitReceipt: {
        create: vi.fn(async ({ data }: any) => {
          if (receipts.has(data.idempotencyKey)) {
            throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          }
          receipts.set(data.idempotencyKey, { ...data });
          return data;
        }),
        findUnique: vi.fn(async ({ where }: any) => receipts.get(where.idempotencyKey) ?? null),
        update: vi.fn(async ({ where, data }: any) => {
          const updated = { ...receipts.get(where.idempotencyKey), ...data };
          receipts.set(where.idempotencyKey, updated);
          return updated;
        }),
        delete: vi.fn(async ({ where }: any) => { receipts.delete(where.idempotencyKey); return {}; }),
      },
    } as any;
    return { prisma, txFn, receipts, tx };
  }

  it('同一 approvalId 重放 → commit 核心仅执行一次，第二次返回缓存结果（replayed）', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const { prisma, txFn, receipts } = makeReceiptAwarePrisma(draft);
    const call = {
      toolId: 'payment.receive_and_reconcile',
      input: { voucherId: 'V1', voucherAmount: 1000, currency: 'USD', allocations: [{ invoiceId: 'I1', appliedAmount: 600 }] },
      approvalId: 'AP1',
    } as any;

    const first: any = await executeTool(prisma, call);
    expect(first.ok).toBe(true);
    expect(first.status).toBe('committed');
    expect(txFn).toHaveBeenCalledTimes(1);
    // receipt 落库：收口层唯一键 commit:{toolId}:{approvalId}
    expect(receipts.get('commit:payment.receive_and_reconcile:AP1')?.status).toBe('committed');

    const second: any = await executeTool(prisma, call);
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    // 核心断言：commit 事务没有第二次执行（无重复核销/重复 audit）
    expect(txFn).toHaveBeenCalledTimes(1);
  });

  it('commit 失败 → receipt 删除允许修复后重试（不留永久阻塞）', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const { prisma, receipts, tx } = makeReceiptAwarePrisma(draft);
    // 第一次：事务内 audit 失败 → commit 失败
    tx.auditLog.create.mockRejectedValueOnce(new Error('AUDIT_FAIL'));
    const call = {
      toolId: 'payment.receive_and_reconcile',
      input: {},
      approvalId: 'AP1',
    } as any;

    const first: any = await executeTool(prisma, call);
    expect(first.ok).toBe(false);
    // 失败后 receipt 已删除（允许重试）
    expect(receipts.has('commit:payment.receive_and_reconcile:AP1')).toBe(false);

    // 第二次（修复后重试）→ 成功
    const second: any = await executeTool(prisma, call);
    expect(second.ok).toBe(true);
    expect(second.status).toBe('committed');
  });

  it('并发重放崩溃窗口（receipt=committing 未完成）→ COMMIT_REPLAY_BLOCKED fail-closed', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const { prisma, receipts } = makeReceiptAwarePrisma(draft);
    // 预置未完成 receipt（模拟上次 commit 崩溃在 committing 状态）
    receipts.set('commit:payment.receive_and_reconcile:AP1', {
      idempotencyKey: 'commit:payment.receive_and_reconcile:AP1',
      status: 'committing',
    });
    const result: any = await executeTool(prisma, {
      toolId: 'payment.receive_and_reconcile',
      input: {},
      approvalId: 'AP1',
    } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('COMMIT_REPLAY_BLOCKED');
    expect(result.errorFeedback.retryable).toBe(false);
  });
});


// ============================================================================
// task Agent-P1: executeAgentTool 首次调用 → approval_required + processDraft
// ============================================================================
import { executeAgentTool } from '../toolRuntime';

describe('task Agent-P1: executeAgentTool payment.receive_and_reconcile draft→approval', () => {
  it('首次调用 → approval_required + payload 含 processDraft', async () => {
    // mock prisma: createPendingApprovalRequest 写 approvalRequest
    let createdApproval: any = null;
    const prisma = {
      approvalRequest: {
        create: vi.fn().mockImplementation(async ({ data }: any) => {
          createdApproval = data;
          return data;
        }),
      },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;

    const actor = { userId: 'user1', role: 'admin', id: 'user1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({
      prisma,
      actor,
      toolId: 'payment.receive_and_reconcile',
      toolInput: {
        voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
        allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
      },
      sessionId: 's1',
    });

    // 首次调用被 approval 拦截
    expect(result.status).toBe('approval_required');
    expect(result.approvalRequired).toBe(true);
    // processDraft 存在（payment 的 6 字段）
    expect(result.processDraft).toBeTruthy();
    expect(result.processDraft.subOperations).toHaveLength(1);
    expect(result.processDraft.impactScope).toEqual(['vouchers', 'invoices', 'allocations']);
    // approvalRequest.create 写入 payload 含 processDraft
    expect(createdApproval).toBeTruthy();
    expect(createdApproval.payload.processDraft).toBeTruthy();
    expect(createdApproval.payload.processDraft.subOperations).toHaveLength(1);
  });

  it('首次调用缺失 allocations → preconditions_failed fail closed', async () => {
    const prisma = {
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
    } as any;
    const actor = { userId: 'user1', role: 'admin', id: 'user1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({
      prisma,
      actor,
      toolId: 'payment.receive_and_reconcile',
      toolInput: { voucherId: 'V1', voucherAmount: 1000, currency: 'USD' }, // 无 allocations
      sessionId: 's1',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('PAYMENT_RECONCILE_PRECONDITIONS_FAILED');
  });
});

// ============================================================================
// task Agent-P1-payment-receive-and-reconcile-service-reuse: Decimal-safe 公开契约
// ============================================================================
describe('task reconcile-service-reuse: Decimal string draft preservation + manifest/toolRegistry contract', () => {
  it('executeAgentTool 输入高精度 Decimal string → approval processDraft 保持原字符串', async () => {
    const prisma = {
      approvalRequest: { create: vi.fn().mockImplementation(async ({ data }: any) => data) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'user1', role: 'admin', id: 'user1', roles: ['admin'], toolScopes: ['finance'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({
      prisma,
      actor,
      toolId: 'payment.receive_and_reconcile',
      toolInput: {
        voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
        allocations: [{ invoiceId: 'I1', appliedAmount: '123456789012345.1234' }],
      },
      sessionId: 's1',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft.subOperations[0].after.appliedAmount).toBe('123456789012345.1234');
    const createdData = prisma.approvalRequest.create.mock.calls[0][0].data;
    expect(createdData.payload.processDraft.subOperations[0].after.appliedAmount).toBe('123456789012345.1234');
  });

  it('manifest inputHint 推荐 Decimal string', () => {
    const manifest = fs.readFileSync(path.resolve(__dirname, '../mcp/manifest.ts'), 'utf-8');
    const entry = manifest.slice(manifest.indexOf("id: 'payment.receive_and_reconcile'"), manifest.indexOf("id: 'order.ship'"));
    expect(entry).toContain('appliedAmount: string');
    expect(entry).toContain("'600.0000'");
  });

  it('toolRegistry schema appliedAmount 描述 Decimal string', () => {
    const registry = fs.readFileSync(path.resolve(__dirname, '../toolRegistry.ts'), 'utf-8');
    const entry = registry.slice(registry.indexOf("id: 'payment.receive_and_reconcile'"), registry.indexOf("id: 'order.ship'"));
    expect(entry).toContain("appliedAmount");
    expect(entry).toContain("Decimal string");
    expect(entry).toContain("type: ['string', 'number']");
  });
});
