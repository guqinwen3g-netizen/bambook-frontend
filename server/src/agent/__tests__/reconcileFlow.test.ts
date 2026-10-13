import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  buildPaymentReconcileDraft,
  validateReconcileDraftSemantics,
  verifyReconcileDraftHash,
  commitPaymentReceiveAndReconcile,
  buildPaymentReconcileError,
  type PaymentReconcileFeedback,
} from '../reconcileFlow';

// ============================================================================
// Agent-P1-payment-receive-and-reconcile-flow-contract: 纯函数 + 集成测试
// ============================================================================

describe('task reconcile-flow: buildPaymentReconcileDraft（draft payload）', () => {
  it('生成含 6 字段的 ProcessDraft', () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    expect(draft.subOperations).toHaveLength(1);
    expect(draft.subOperations[0].toolId).toBe('finance.apply_voucher_to_invoice');
    expect(draft.impactScope).toEqual(['vouchers', 'invoices', 'allocations']);
    expect(draft.irreversible).toBe(true);
    expect(draft.postCommitHooks).toEqual([]);
    expect(draft.idempotencyKey).toContain('payment.receive_and_reconcile:V1');
  });

  it('split voucher（N 笔 allocation）→ N 个 subOperations', () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [
        { invoiceId: 'I1', appliedAmount: 600 },
        { invoiceId: 'I2', appliedAmount: 400 },
      ],
    });
    expect(draft.subOperations).toHaveLength(2);
    expect(draft.subOperations.map(s => s.entityId)).toEqual(['I1', 'I2']);
  });

  it('beforeAfterDiff 记录每笔 allocation 变更', () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    expect(draft.beforeAfterDiff).toHaveLength(1);
    expect(draft.beforeAfterDiff[0]).toEqual({
      entity: 'invoices', entityId: 'I1', field: 'allocations',
      before: null, after: { voucherId: 'V1', appliedAmount: 600 },
    });
  });
});

describe('task reconcile-flow: hash 防篡改', () => {
  it('原始 draft hash 校验通过', () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    expect(verifyReconcileDraftHash(draft).ok).toBe(true);
  });

  it('篡改 appliedAmount → hash 不匹配', () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...draft.subOperations[0].after, appliedAmount: 9999 } }] };
    expect(verifyReconcileDraftHash(tampered).ok).toBe(false);
  });
});

describe('task reconcile-flow: validateReconcileDraftSemantics（fail closed）', () => {
  it('空 subOperations → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = {
      subOperations: [],
      beforeAfterDiff: [], impactScope: [], irreversible: true, postCommitHooks: [],
      idempotencyKey: 'test',
    } as any;
    const r = validateReconcileDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SEMANTIC_VALIDATION_FAILED');
  });

  it('allocation appliedAmount 非法 → ALLOCATION_INVALID', () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: -50 }],
    });
    const r = validateReconcileDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('ALLOCATION_INVALID');
  });

  it('合法 allocation → ok', () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    expect(validateReconcileDraftSemantics(draft).ok).toBe(true);
  });
});

describe('task reconcile-flow: buildPaymentReconcileError（稳定 error code + userAction）', () => {
  it('每个 error code 有 userAction', () => {
    const codes = ['PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'VOUCHER_NOT_FOUND', 'INVOICE_NOT_FOUND', 'ALLOCATION_INVALID', 'OVER_APPLY', 'COMMIT_TRANSACTION_FAILED', 'UNKNOWN_ERROR'] as const;
    for (const code of codes) {
      const e = buildPaymentReconcileError(code, 'test');
      expect(e.code).toBe(code);
      expect(e.userAction.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// commit 集成测试（mock prisma tx）
// ============================================================================

function makeCommitTx(opts: {
  voucher?: any;
  invoices?: Record<string, any>;
  allocs?: any[]; // recalc findMany 返回
  txFail?: boolean;
} = {}) {
  const originalVoucher = opts.voucher === undefined ? { id: 'V1', amount: new Prisma.Decimal(1000), deletedAt: null, status: 'active', currency: 'USD' } : opts.voucher;
  const originalInvoices = opts.invoices ?? { I1: { id: 'I1', amount: new Prisma.Decimal(600), deletedAt: null, status: 'Issued', currency: 'USD' } };
  // This suite's original receive-and-reconcile command uses real Receipt /
  // Receivable directions; keep all amounts/rollback assertions unchanged.
  const voucher = originalVoucher == null ? originalVoucher : { type: 'Receipt', ...originalVoucher };
  const invoices = Object.fromEntries(Object.entries(originalInvoices).map(([id, invoice]) => [id, { type: 'Receivable', ...invoice }]));
  // applyAllocation 的 select 子句包含 voucherId + invoiceId，用于排除当前 voucher/invoice 的已存在 allocation（幂等再申请）
  // mock 数据必须匹配该 DB 契约，否则排除过滤器会将 undefined !== voucherId 误判为「其他 voucher 的 allocation」导致金额超限
  const allocsForRecalc = opts.allocs ?? [{ appliedAmount: new Prisma.Decimal(600), voucherId: 'V1', invoiceId: 'I1' }];

  const invoiceAllocationUpsert = vi.fn().mockResolvedValue({});
  const invoiceUpdate = vi.fn().mockResolvedValue({});
  const voucherUpdate = vi.fn().mockResolvedValue({});
  const auditCreate = vi.fn().mockResolvedValue({});
  const entityRefUpsert = vi.fn().mockResolvedValue({});
  const entityLinkUpsert = vi.fn().mockResolvedValue({});
  const entityLinkFindMany = vi.fn().mockResolvedValue([]);
  const entityLinkUpdate = vi.fn().mockResolvedValue({});

  const tx = {
    // Ordinary receipts have no customer-refund anchor; the shared allocator
    // must still inspect that real relation before permitting reconciliation.
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) },
    creditNoteRefundReturn: { findUnique: vi.fn().mockResolvedValue(null) },
    creditNoteAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRawUnsafe: vi.fn(async () => []), // Ordinary invoice, no supplier-claim back-reference.
    paymentVoucher: {
      findUnique: vi.fn().mockResolvedValue(voucher),
      update: voucherUpdate,
    },
    invoice: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => invoices[where.id] ?? null),
      update: invoiceUpdate,
    },
    invoiceAllocation: {
      upsert: invoiceAllocationUpsert,
      findMany: vi.fn().mockResolvedValue(allocsForRecalc),
    },
    auditLog: { create: auditCreate },
    entityReference: { upsert: entityRefUpsert },
    entityLink: { upsert: entityLinkUpsert, findMany: entityLinkFindMany, update: entityLinkUpdate },
  };
  return { tx, invoiceAllocationUpsert, invoiceUpdate, voucherUpdate, auditCreate, entityRefUpsert, entityLinkFindMany: tx.entityLink.findMany };
}

describe('task reconcile-flow: commitPaymentReceiveAndReconcile', () => {
  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const prisma = { $transaction: vi.fn() } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.feedback.status).toBe('failed');
      expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
    }
  });

  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，\$transaction 不调用（no service bypass）', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const tampered = { ...draft, idempotencyKey: 'payment.receive_and_reconcile:V1:pd:bogus' };
    const txFn = vi.fn();
    const prisma = { $transaction: txFn } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    }
    expect(txFn).not.toHaveBeenCalled();
  });

  it('PROCESS_DRAFT_MISSING → \$transaction 不调用（no service bypass）', async () => {
    const txFn = vi.fn();
    const prisma = { $transaction: txFn } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    expect(txFn).not.toHaveBeenCalled();
  });

  it('voucher 不存在 → VOUCHER_NOT_FOUND', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'VX', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const { tx } = makeCommitTx({ voucher: null });
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('VOUCHER_NOT_FOUND');
  });

  it('invoice 不存在 → INVOICE_NOT_FOUND', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'IX', appliedAmount: 600 }],
    });
    const { tx } = makeCommitTx({ invoices: {} });
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVOICE_NOT_FOUND');
  });

  it('成功 commit → committed feedback（复用 allocationService recalc）', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const { tx, invoiceAllocationUpsert, auditCreate } = makeCommitTx();
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    if (!r.ok) console.log('DEBUG reconcileFlow error:', JSON.stringify(r.feedback));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.voucherId).toBe('V1');
      expect(r.feedback.allocations).toHaveLength(1);
      expect(r.feedback.allocations[0].invoiceStatus).toBe('Paid'); // 600 >= 600
      expect(r.feedback.transactionId).toMatch(/^prc_/);
      // 写了 allocation + audit（同事务）
      expect(invoiceAllocationUpsert).toHaveBeenCalledTimes(1);
      // applyAllocation 内 allocation 级 audit + flow 级 audit
      expect(auditCreate.mock.calls.length).toBeGreaterThanOrEqual(1);
      // task review-fix: syncAllocationVoucherLinks 被调用（EntityLink 不漂移）
      // syncAllocationVoucherLinks 内部调 entityLink.findMany（查现有 settlesInvoice link）
      expect(tx.entityLink.findMany).toHaveBeenCalled();
    }
  });

  it('Decimal-safe：高精度 appliedAmount 以字符串透传到 applyAllocation', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: '123456789.1234' }],
    });
    const { tx, invoiceAllocationUpsert } = makeCommitTx({
      voucher: { id: 'V1', amount: new Prisma.Decimal('999999999'), deletedAt: null, status: 'active', currency: 'USD' },
      invoices: { I1: { id: 'I1', amount: new Prisma.Decimal('999999999'), deletedAt: null, status: 'Issued', currency: 'USD' } },
      allocs: [{ appliedAmount: new Prisma.Decimal('123456789.1234'), voucherId: 'V1', invoiceId: 'I1' }],
    });
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.allocations[0].appliedAmount).toBe('123456789.1234');
    }
  });

  it('split voucher（2 笔 allocation）→ 2 个 allocation + syncAllocationVoucherLinks', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [
        { invoiceId: 'I1', appliedAmount: 600 },
        { invoiceId: 'I2', appliedAmount: 400 },
      ],
    });
    const { tx, invoiceAllocationUpsert } = makeCommitTx({
      invoices: {
        I1: { id: 'I1', amount: new Prisma.Decimal(600), deletedAt: null, status: 'Issued', currency: 'USD' },
        I2: { id: 'I2', amount: new Prisma.Decimal(400), deletedAt: null, status: 'Issued', currency: 'USD' },
      },
    });
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.allocations).toHaveLength(2);
      expect(invoiceAllocationUpsert).toHaveBeenCalledTimes(2);
      // syncAllocationVoucherLinks 被调用（维护 split voucher 的 settlesInvoice）
      expect(tx.entityLink.findMany).toHaveBeenCalled();
    }
  });

  it('事务失败（audit reject）→ COMMIT_TRANSACTION_FAILED，不伪成功', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const { tx, auditCreate } = makeCommitTx();
    auditCreate.mockRejectedValue(new Error('AUDIT_FAIL'));
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('COMMIT_TRANSACTION_FAILED');
  });
});


// ============================================================================
// task Agent-P1 review-fix: Agent path 与 route path sync 契约对齐
// 证明 applyAllocation 共用 service 让 Agent commit 同步 invoice/voucher references + settlesInvoice links
// ============================================================================

describe('task review-fix: Agent commit 复用 applyAllocation 同步 EntityReference/links（与 route 一致）', () => {
  it('Agent commit 触发 syncInvoiceReferences（via applyAllocation）', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const { tx, entityRefUpsert } = makeCommitTx();
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    // applyAllocation 调 syncInvoiceReferences/syncPaymentVoucherReferences → entityReference.upsert
    expect(entityRefUpsert.mock.calls.length).toBeGreaterThan(0);
  });

  it('Agent commit 触发 syncAllocationVoucherLinks（settlesInvoice EntityLink）', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const { tx } = makeCommitTx();
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    // applyAllocation 调 syncAllocationVoucherLinks → entityLink.findMany（查现有 settlesInvoice）
    expect(tx.entityLink.findMany).toHaveBeenCalled();
  });

  it('split voucher Agent commit → 每笔 allocation 走 applyAllocation（N 次 sync）', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [
        { invoiceId: 'I1', appliedAmount: 600 },
        { invoiceId: 'I2', appliedAmount: 400 },
      ],
    });
    const { tx, invoiceAllocationUpsert, entityRefUpsert } = makeCommitTx({
      invoices: {
        I1: { id: 'I1', amount: new Prisma.Decimal(600), deletedAt: null, status: 'Issued', currency: 'USD' },
        I2: { id: 'I2', amount: new Prisma.Decimal(400), deletedAt: null, status: 'Issued', currency: 'USD' },
      },
    });
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.allocations).toHaveLength(2);
      // 2 笔 allocation 各走一次 applyAllocation（含各自 sync）
      expect(invoiceAllocationUpsert).toHaveBeenCalledTimes(2);
      expect(entityRefUpsert.mock.calls.length).toBeGreaterThan(0);
    }
  });

  it('applyAllocation 失败（sync reject）→ 整体回滚，不伪成功', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const { tx, entityRefUpsert } = makeCommitTx();
    entityRefUpsert.mockRejectedValue(new Error('SYNC_FAIL'));
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('COMMIT_TRANSACTION_FAILED');
  });
});

// ============================================================================
// Phase 2 · 2.2: 并发核销根因修复——Serializable 隔离 + P2034 → ALLOCATION_CONFLICT
// ============================================================================

describe('task 2.2: commit 并发一致性（Serializable 隔离 + P2034 稳定码）', () => {
  it('$transaction 以 Serializable 隔离级执行（check-then-act 防并发超核销）', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const { tx } = makeCommitTx();
    const txFn = vi.fn(async (fn: any, _opts?: any) => fn(tx));
    const prisma = { $transaction: txFn } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    expect(txFn).toHaveBeenCalledTimes(1);
    // 第二参必须声明 Serializable——否则并发核销同一发票可双双通过剩余校验
    expect(txFn.mock.calls[0][1]).toMatchObject({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });

  it('P2034 序列化冲突 → ALLOCATION_CONFLICT + retryable（不伪成功、不泛化 500）', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const prisma = {
      $transaction: vi.fn(async () => {
        throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' });
      }),
    } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = (r.feedback as any).error;
      expect(err.code).toBe('ALLOCATION_CONFLICT');
      expect(err.retryable).toBe(true);
      expect(err.userAction).toContain('重试');
    }
  });

  it('非 P2034 事务失败仍归 COMMIT_TRANSACTION_FAILED 且不可重试（不错误鼓励重试）', async () => {
    const draft = buildPaymentReconcileDraft({
      voucherId: 'V1', voucherAmount: 1000, currency: 'USD',
      allocations: [{ invoiceId: 'I1', appliedAmount: 600 }],
    });
    const prisma = {
      $transaction: vi.fn(async () => { throw new Error('DB_CONNECTION_LOST'); }),
    } as any;
    const r = await commitPaymentReceiveAndReconcile({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = (r.feedback as any).error;
      expect(err.code).toBe('COMMIT_TRANSACTION_FAILED');
      expect(err.retryable).toBe(false);
    }
  });
});

describe('task review-fix: route POST 与 Agent commit 共用 applyAllocation（单一事实源）', () => {
  it('route POST 通过 allocationMutationService 复用 applyAllocation', () => {
    const fs = require('fs');
    const route = fs.readFileSync(require('path').resolve(__dirname, '../../finance/route.ts'), 'utf-8');
    const service = fs.readFileSync(require('path').resolve(__dirname, '../../finance/allocationMutationService.ts'), 'utf-8');
    expect(route).toContain('createAllocation({');
    expect(service).toContain('applyAllocation(prisma, tx,');
  });

  it('reconcileFlow commit 源码调 applyAllocation（不手写 invoiceAllocation.upsert + recalc）', () => {
    const fs = require('fs');
    const flow = fs.readFileSync(require('path').resolve(__dirname, '../reconcileFlow.ts'), 'utf-8');
    expect(flow).toContain('applyAllocation(prisma, tx,');
    // commit 事务体内不再手写核心 DB 写入（由 applyAllocation 封装）
    const commitStart = flow.indexOf('prisma.$transaction(async (tx: any)');
    const commitEnd = flow.indexOf('return { voucherId };', commitStart);
    const commitBody = flow.slice(commitStart, commitEnd);
    expect(commitBody).not.toContain('tx.invoiceAllocation.upsert');
    expect(commitBody).not.toContain('await recalcInvoiceStatus(tx');
    expect(commitBody).not.toContain('await syncAllocationVoucherLinks(tx');
  });
});
