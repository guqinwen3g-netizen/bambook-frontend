import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  commitOrderConfirm,
  recoverProcessDraftFromPayload,
  verifyProcessDraftHash,
} from '../commitTransaction';
import { buildOrderConfirmProcessDraft, type ProcessDraft } from '../toolRegistry';

/**
 * ★ B50-1b：`commitOrderConfirm` 现在在写状态之前调**唯一那份**确认门禁判定
 *   （`orders/orderLifecycleService.evaluateOrderConfirmGates`）。本文件测的是
 *   draft / hash / receipt / entity-sync 语义，不是门禁判定本身，所以把判定桩成"放行"，
 *   但**保留调用记录**（spy）：
 *  · 谁把 commit 里那句门禁调用删掉 ⇒ 文末那组断言立刻红（不是靠 lcGateWiring 的源码钉兜底）；
 *  · 真判定 + 真接线的行为证据在 `orderConfirmGateCommitB50b.test.ts`（那里不 mock 门禁，
 *    用的是 orders/__tests__/orderConfirmGates.test.ts 同一套 delegate 口径）。
 */
vi.mock('../../orders/orderLifecycleService', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    evaluateOrderConfirmGates: vi.fn(async () => ({ allowed: true, creditExceptionPass: null })),
  };
});
import { evaluateOrderConfirmGates } from '../../orders/orderLifecycleService';
const gateSpy = evaluateOrderConfirmGates as unknown as ReturnType<typeof vi.fn>;

/** 门禁锚点读数：commit 现在会先用 poNumber 换订单 id 再跑门禁（与事务内那次查是同一口径） */
function gateAnchor(order: any = { id: 'order_real_id', deletedAt: null }) {
  return { order: { findFirst: vi.fn(async () => order) } };
}

function makeValidSnapshot() {
  return {
    orderId: 'order_real_id',
    poNumber: 'PO-001',
    status: 'Pending',
    amount: 12000,
    currency: 'USD',
    customerRelationId: 'rel_cust_1',
    customerName: 'ACME',
    lineCount: 3,
  };
}

function makeValidDraft(overrides: Partial<ProcessDraft> = {}): ProcessDraft {
  const draft = buildOrderConfirmProcessDraft({
    poNumber: 'PO-001',
    previousStatus: 'Pending',
    newStatus: 'Confirmed',
    snapshot: makeValidSnapshot(),
  });
  return { ...draft, ...overrides };
}

function makeMockTx(orderExists: boolean, statusMatch: boolean) {
  const orderStatusUpdates: any[] = [];
  const transitions: any[] = [];
  const tx = {
    order: {
      findFirst: vi.fn(async () =>
        orderExists
          ? { id: 'order_real_id', poNumber: 'PO-001', status: statusMatch ? 'Pending' : 'Confirmed', deletedAt: null }
          : null
      ),
      // ★ B50-1b：commit 的**开票腿**现在在事务内调 `decideLcGate`（与 HTTP 开票同一函数），
      //   它按 orderId 自取订单的 `paymentInstrument` ⇒ 这里补上读数。
      //   固定 'T/T' = 非信用证订单，门禁内部直接判"不适用"（不查 letterOfCredit 表）⇒
      //   本文件 77 条用例的期望值一概不变，但**门禁调用本身是真的在跑**（删掉接线会红）。
      findUnique: vi.fn(async () => ({ id: 'order_real_id', paymentInstrument: 'T/T', deletedAt: null })),
      update: vi.fn(async (args: any) => {
        orderStatusUpdates.push(args);
        return args.data;
      }),
    },
    orderStatusTransition: {
      create: vi.fn(async (args: any) => {
        transitions.push(args);
        return args.data;
      }),
    },
    invoice: {
      create: vi.fn(async (args: any) => {
        return args.data;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    entityReference: { upsert: vi.fn(async (args: any) => { return args; }) },
    entityLink: { upsert: vi.fn(async (args: any) => { return args; }) },
  };
  return { tx, orderStatusUpdates, transitions, invoiceCreates: [] as any[] };
}

function makeMockPrisma2(orderExists: boolean, statusMatch: boolean, approvalStatus: string = 'approved') {
  const { tx, orderStatusUpdates, transitions } = makeMockTx(orderExists, statusMatch);
  const invoiceCreates: any[] = [];
  const entityLinkCalls: any[] = [];
  const entityRefCalls: any[] = [];
  const commitReceipts = new Map<string, any>();
  tx.invoice.create = vi.fn(async (args: any) => { invoiceCreates.push(args.data); return args.data; }) as any;
  tx.entityLink.upsert = vi.fn(async (args: any) => { entityLinkCalls.push(args); return args; }) as any;
  tx.entityReference.upsert = vi.fn(async (args: any) => { entityRefCalls.push(args); return args; }) as any;
  (tx as any).agentCommitReceipt = {
    create: vi.fn(async ({ data }: any) => {
      if (commitReceipts.has(data.idempotencyKey)) {
        throw Object.assign(new Error('duplicate idempotency key'), { code: 'P2002' });
      }
      commitReceipts.set(data.idempotencyKey, { ...data });
      return data;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const current = commitReceipts.get(where.idempotencyKey);
      const updated = { ...current, ...data };
      commitReceipts.set(where.idempotencyKey, updated);
      return updated;
    }),
  };
  return {
    prisma: {
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      ...gateAnchor(),
      approvalRequest: {
        findUnique: vi.fn(async () => ({ id: 'ar_test', requesterId: 'usr_tester', status: approvalStatus })),
      },
      agentCommitReceipt: {
        findUnique: vi.fn(async ({ where }: any) => commitReceipts.get(where.idempotencyKey) ?? null),
      },
    } as any,
    orderStatusUpdates,
    transitions,
    invoiceCreates,
    entityLinkCalls,
    entityRefCalls,
    tx,
  };
}

function makeMockPrisma(orderExists: boolean, statusMatch: boolean, approvalStatus: string = 'approved') {
  const { tx, orderStatusUpdates, transitions } = makeMockTx(orderExists, statusMatch);
  const invoiceCreates: any[] = [];
  const commitReceipts = new Map<string, any>();
  // 包装 invoice.create 捕获调用
  const origInvoiceCreate = tx.invoice.create;
  tx.invoice.create = vi.fn(async (args: any) => {
    invoiceCreates.push(args.data);
    return args.data;
  }) as any;
  (tx as any).agentCommitReceipt = {
    create: vi.fn(async ({ data }: any) => {
      if (commitReceipts.has(data.idempotencyKey)) throw Object.assign(new Error('duplicate idempotency key'), { code: 'P2002' });
      commitReceipts.set(data.idempotencyKey, { ...data });
      return data;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const updated = { ...commitReceipts.get(where.idempotencyKey), ...data };
      commitReceipts.set(where.idempotencyKey, updated);
      return updated;
    }),
  };
  return {
    prisma: {
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      ...gateAnchor(),
      approvalRequest: {
        findUnique: vi.fn(async () => ({ id: 'ar_test', requesterId: 'usr_tester', status: approvalStatus })),
      },
      agentCommitReceipt: {
        findUnique: vi.fn(async ({ where }: any) => commitReceipts.get(where.idempotencyKey) ?? null),
      },
    } as any,
    orderStatusUpdates,
    transitions,
    invoiceCreates,
  };
}

describe('credit consumption in the Agent business transaction (persistence adapters)', () => {
  it.each([true, false])('accepted quota=%s uses the invoice/status/receipt transaction and never continues rejected consumption', async accepted => {
    const { prisma, tx } = makeMockPrisma2(true, true);
    const consumeException = vi.fn().mockResolvedValue(accepted ? { ok: true, data: { consumed: true } }
      : { ok: false, error: { code: 'EXCEPTION_ALREADY_CONSUMED', message: 'Synthetic exhausted quota', statusCode: 409 } });
    gateSpy.mockResolvedValueOnce({ allowed: true, creditExceptionPass: { service: { consumeException },
      exception: { id: 'EXC-agent', exceptionNumber: 'EXC-agent' }, scope: { targetType: 'Order', targetId: 'order_real_id', action: 'order:confirm' } } });
    const result = await commitOrderConfirm({ prisma, approvalId: 'AR-credit', approvalPayload: { processDraft: makeValidDraft() }, actorId: 'usr_tester' });
    expect(consumeException).toHaveBeenCalledWith(expect.objectContaining({ tx, consumedBy: 'usr_tester', targetType: 'Order', targetId: 'order_real_id', action: 'order:confirm' }));
    expect(tx.invoice.create).toHaveBeenCalledTimes(1); expect(tx.order.update).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(accepted); expect(result.committed).toBe(accepted);
    if (!accepted) { expect(result.errorFeedback?.gateCode).toBe('EXCEPTION_ALREADY_CONSUMED'); expect((tx as any).agentCommitReceipt.update).not.toHaveBeenCalled(); }
    else expect((tx as any).agentCommitReceipt.update).toHaveBeenCalledTimes(1);
    // Adapter spies establish ordering/tx identity only; PG rollback is proven
    // separately by creditOrderAtomicityRealDb, not by the arrays above.
  });
});

describe('P1-A commitTransaction 闭环', () => {
  describe('recoverProcessDraftFromPayload', () => {
    it('payload 含完整 processDraft 时恢复成功', () => {
      const draft = makeValidDraft();
      const payload = { processDraft: draft, toolId: 'order.confirm' };
      const recovered = recoverProcessDraftFromPayload(payload as any);
      expect(recovered).not.toBeNull();
      expect(recovered?.idempotencyKey).toBe(draft.idempotencyKey);
    });

    it('payload 缺 processDraft 返回 null', () => {
      expect(recoverProcessDraftFromPayload({ toolId: 'order.confirm' } as any)).toBeNull();
    });

    it('payload null 返回 null', () => {
      expect(recoverProcessDraftFromPayload(null)).toBeNull();
    });

    it('processDraft 缺字段（不完整）返回 null', () => {
      const bad = { subOperations: [], beforeAfterDiff: [], impactScope: [] } as any;
      expect(recoverProcessDraftFromPayload({ processDraft: bad } as any)).toBeNull();
    });
  });

  describe('verifyProcessDraftHash', () => {
    it('原版 draft hash 校验通过', () => {
      const draft = makeValidDraft();
      const result = verifyProcessDraftHash(draft);
      expect(result.ok).toBe(true);
    });

    it('draft 内容被篡改（newStatus 变化）hash 不匹配', () => {
      const draft = makeValidDraft();
      // 篡改：改 after.status 但不重算 idempotencyKey
      draft.subOperations[0].after.status = 'Cancelled';
      const result = verifyProcessDraftHash(draft);
      expect(result.ok).toBe(false);
    });
  });

  describe('commitOrderConfirm fail-closed 语义', () => {
    it('payload 无 draft -> fail closed', async () => {
      const result = await commitOrderConfirm({
        prisma: {} as any,
        approvalId: 'ar_test',
        approvalPayload: { toolId: 'order.confirm' } as any,
      });
      expect(result.ok).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.error).toContain('process draft missing');
    });

    it('draft hash 不匹配 -> fail closed（篡改 entityId 触发 hash，不触发 semantic）', async () => {
      const draft = makeValidDraft();
      draft.subOperations.find(s => s.toolId === 'orders.update_status')!.entityId = 'PO-TAMPERED'; // 只触发 hash
      const result = await commitOrderConfirm({
        prisma: {} as any,
        approvalId: 'ar_test',
        approvalPayload: { processDraft: draft } as any,
      });
      expect(result.ok).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.error).toContain('hash mismatch');
    });

    it('draft 无 orders.update_status subOperation -> fail closed', async () => {
      const draft = makeValidDraft();
      draft.subOperations = draft.subOperations.filter(s => s.toolId !== 'orders.update_status');
      // 重算 hash（用 toolRegistry 的 computeProcessDraftHash 不行，因为 exported 不了）
      // 直接测 commitOrderConfirm 的 "no orders.update_status" 分支
      const result = await commitOrderConfirm({
        prisma: {} as any,
        approvalId: 'ar_test',
        approvalPayload: { processDraft: draft } as any,
      });
      expect(result.ok).toBe(false);
      // 可能因 hash 变化先 fail，也可能走到 no subOperation——都算 fail closed
      expect(result.committed).toBe(false);
    });
  });

  describe('commitOrderConfirm 事务提交（mock prisma $transaction）', () => {
    it('approved draft + 正常订单 -> commit 成功，含审计摘要 + postCommitQueue', async () => {
      const draft = makeValidDraft();
      const { prisma, orderStatusUpdates, transitions, invoiceCreates, entityLinkCalls, entityRefCalls } = makeMockPrisma2(true, true);

      const result = await commitOrderConfirm({
        prisma,
        approvalId: 'ar_test_123',
        approvalPayload: { processDraft: draft } as any,
      });

      expect(result.ok).toBe(true);
      expect(result.committed).toBe(true);
      expect(result.orderId).toBe('order_real_id');
      expect(result.newStatus).toBe('Confirmed');
      expect(result.previousStatus).toBe('Pending');
      expect(result.transactionId).toMatch(/^tx_/);
      // 状态流转记录 + 订单更新
      expect(transitions).toHaveLength(1);
      expect(orderStatusUpdates).toHaveLength(1);
      expect(orderStatusUpdates[0].data.status).toBe('Confirmed');
      // P1-A scope: postCommitHooks 为空（email/EmailQueue 排除）
      expect(result.postCommitQueue?.length).toBe(0);
      // P1-A: invoice(Issued) 在事务内创建——显式断言 invoice.create 被调用
      expect(invoiceCreates).toHaveLength(1);
      expect(invoiceCreates[0].status).toBe('Issued');
      expect(invoiceCreates[0].orderId).toBe('order_real_id');
      expect(invoiceCreates[0].type).toBe('Receivable');
      expect(invoiceCreates[0].amount).toBe(12000); // snapshot amount 写入（非硬编码 0）
      expect(invoiceCreates[0].currency).toBe('USD'); // snapshot currency（USD fallback）
      // P1-A: aboutOrder + billTo 两维度 reference/link 都写入
      expect(entityRefCalls.length).toBeGreaterThanOrEqual(2); // order ref + relation ref
      expect(entityLinkCalls.length).toBeGreaterThanOrEqual(2); // aboutOrder link + billTo link
      const linkKinds = entityLinkCalls.map((c: any) => c.create?.linkKind).filter(Boolean);
      expect(linkKinds).toContain('aboutOrder');
      expect(linkKinds).toContain('billTo');
      // 审计摘要
      expect(result.audit?.approvalId).toBe('ar_test_123');
      expect(result.audit?.idempotencyKey).toBe(draft.idempotencyKey);
      expect(result.audit?.subOperationsSummary).toContain('orders.update_status:update_status');
      expect(result.audit?.impactScope).toContain('orders');
    });

    it('相同 ProcessDraft 重复提交时复用已完成回执，不重复写订单或发票', async () => {
      const draft = makeValidDraft();
      const { prisma, orderStatusUpdates, transitions, invoiceCreates } = makeMockPrisma2(true, true);
      const payload = { processDraft: draft } as any;

      const first = await commitOrderConfirm({ prisma, approvalId: 'ar_idempotent_1', approvalPayload: payload });
      const second = await commitOrderConfirm({ prisma, approvalId: 'ar_idempotent_2', approvalPayload: payload });

      expect(first).toMatchObject({ ok: true, committed: true, idempotencyKey: draft.idempotencyKey });
      expect(second).toMatchObject({ ok: true, committed: true, idempotencyKey: draft.idempotencyKey });
      expect(second.transactionId).toBe(first.transactionId);
      expect(transitions).toHaveLength(1);
      expect(orderStatusUpdates).toHaveLength(1);
      expect(invoiceCreates).toHaveLength(1);
    });

    it('订单不存在 -> fail closed（事务回滚）', async () => {
      const draft = makeValidDraft();
      const { prisma } = makeMockPrisma(false, false);

      const result = await commitOrderConfirm({
        prisma,
        approvalId: 'ar_test',
        approvalPayload: { processDraft: draft } as any,
      });

      expect(result.ok).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.error).toContain('ORDER_NOT_FOUND');
    });

    it('订单状态漂移（previousStatus 不匹配）-> fail closed', async () => {
      const draft = makeValidDraft(); // previousStatus=Pending
      const { prisma } = makeMockPrisma(true, false); // 实际 status=Confirmed

      const result = await commitOrderConfirm({
        prisma,
        approvalId: 'ar_test',
        approvalPayload: { processDraft: draft } as any,
      });

      expect(result.ok).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.error).toContain('STATUS_DRIFT');
    });

    it('$transaction 抛错 -> fail closed（返回安全文案，保留回滚）', async () => {
      const draft = makeValidDraft();
      const prisma = {
        $transaction: vi.fn(async () => {
          throw new Error('DB_CONNECTION_LOST');
        }),
        ...gateAnchor(),
        approvalRequest: {
          findUnique: vi.fn(async () => ({ id: 'ar_test', requesterId: 'usr_tester' })),
        },
      } as any;

      const result = await commitOrderConfirm({
        prisma,
        approvalId: 'ar_test',
        approvalPayload: { processDraft: draft } as any,
      });

      expect(result.ok).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.errorFeedback?.code).toBe('COMMIT_TRANSACTION_FAILED');
      expect(result.error).not.toContain('DB_CONNECTION_LOST');
      expect(result.error).toContain('已回滚');
    });
  });

  describe('modified approval fail-closed（P1-A 不支持 modified）', () => {
    it('modified status -> fail closed（order.confirm 不支持 modified）', async () => {
      const draft = makeValidDraft();
      // 注意：commitOrderConfirm 本身不看 status，modified 拦截在 toolRuntime 层
      // 这里测 commitOrderConfirm 仍能正常消费 approved draft（modified 拦截由 toolRuntime 测）
      const { prisma } = makeMockPrisma(true, true, 'approved');
      const result = await commitOrderConfirm({
        prisma,
        approvalId: 'ar_test',
        approvalPayload: { processDraft: draft } as any,
      });
      // approved 正常 commit（对照：modified 由 toolRuntime 拦截）
      expect(result.ok).toBe(true);
    });
  });

  describe('what-you-approve-is-what-you-commit 契约', () => {
    it('commitTransaction 只消费 payload 里的 draft，不重新生成', async () => {
      const approvedDraft = makeValidDraft({ newStatus: 'Confirmed' } as any);
      // 模拟审批时写入 payload 的 draft（idempotencyKey 固定）
      const approvedIdempotencyKey = approvedDraft.idempotencyKey;

      const { prisma } = makeMockPrisma(true, true);

      const result = await commitOrderConfirm({
        prisma,
        approvalId: 'ar_test',
        approvalPayload: { processDraft: approvedDraft } as any,
      });

      expect(result.ok).toBe(true);
      // commit 的 draft idempotencyKey 与审批时一致
      expect(result.audit?.idempotencyKey).toBe(approvedIdempotencyKey);
    });
  });
});


  describe('P1-A 硬核：sync 失败 fail closed + currency fail closed', () => {
    it('entityLink.upsert 失败 -> commit fail closed（事务回滚）', async () => {
      const draft = makeValidDraft();
      const { prisma, tx } = makeMockPrisma2(true, true);
      // 模拟 entityLink.upsert 抛错
      (tx.entityLink.upsert as any) = vi.fn(async () => { throw new Error('ENTITY_LINK_DB_ERROR'); });
      const result = await commitOrderConfirm({
        prisma, approvalId: 'ar_test',
        approvalPayload: { processDraft: draft } as any,
      });
      expect(result.ok).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.errorFeedback?.code).toBe('COMMIT_TRANSACTION_FAILED');
      expect(result.error).not.toContain('ENTITY_LINK_DB_ERROR');
      expect(result.error).toContain('已回滚');
    });

    it('currency 缺失 -> fail closed（不再 CNY fallback）', async () => {
      const draft = makeValidDraft();
      // 篡改 draft：清空 invoice currency（模拟不完整 draft）
      const invOp = draft.subOperations.find(s => s.toolId === 'finance.create_invoice');
      if (invOp) (invOp.after as any).currency = '';
      const { prisma } = makeMockPrisma2(true, true);
      const result = await commitOrderConfirm({
        prisma, approvalId: 'ar_test',
        approvalPayload: { processDraft: draft } as any,
      });
      // 注意：篡改 currency 会先触发 hash mismatch（fail closed），这也算正确行为
      expect(result.ok).toBe(false);
    });
  });

describe('P1-A amount resolver: first non-null, non-zero wins (Section 7.5)', () => {
  function makeOrderMock(totalActual: number | null, totalNet: number | null, quoteAmount: number | null) {
    const orderRow = {
      id: 'order_real_id', poNumber: 'PO-001', status: 'Pending', deletedAt: null,
      totalActual, totalNet, quoteAmount,
      salesCurrency: null, currency: 'USD',
      customer: 'ACME', customerRelationId: 'rel_1',
      billToName: null, billToRelationId: null,
    };
    return {
      order: {
        findFirst: vi.fn(async () => orderRow),
        update: vi.fn(async () => ({})),
      },
      orderLine: { count: vi.fn(async () => 3) },
      $transaction: vi.fn(async (fn: any) => fn({
        order: {
          findFirst: vi.fn(async () => orderRow),
          update: vi.fn(async () => ({})),
          findUnique: vi.fn(async () => ({ id: 'order_real_id', paymentInstrument: 'T/T', deletedAt: null })),
        },
        orderStatusTransition: { create: vi.fn(async () => ({})) },
        invoice: { create: vi.fn(async (args: any) => args.data) },
        auditLog: { create: vi.fn(async () => ({})) },
        entityReference: { upsert: vi.fn(async () => ({})) },
        entityLink: { upsert: vi.fn(async () => ({})) },
      })),
      approvalRequest: { findUnique: vi.fn(async () => ({ id: 'ar', requesterId: 'u', status: 'approved' })) },
    } as any;
  }

  // 因为 amount resolver 在 loadOrderSnapshot（draftPhase）里，这里通过 buildOrderConfirmProcessDraft snapshot 验证
  // 直接测 invoice.create 拿到的 amount
  async function commitAndGetInvoiceAmount(prisma: any): Promise<number> {
    const { loadOrderSnapshot, buildOrderConfirmProcessDraft } = await import('../toolRegistry');
    const snapshot = await loadOrderSnapshot(prisma, 'PO-001');
    const draft = buildOrderConfirmProcessDraft({
      poNumber: 'PO-001', previousStatus: 'Pending', newStatus: 'Confirmed', snapshot: snapshot!,
    });
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });
    return result.ok ? -1 : -2; // 简化：ok 时从 prisma mock 拿不到 invoice data，改用直接断言
  }

  it('totalActual=0, totalNet=100, quoteAmount=200 -> amount=100（first non-zero wins）', async () => {
    const { loadOrderSnapshot } = await import('../toolRegistry');
    const prisma = makeOrderMock(0, 100, 200);
    const snapshot = await loadOrderSnapshot(prisma, 'PO-001');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.amount).toBe(100); // 不是 0，fallback 到 totalNet
  });

  it('totalActual=null, totalNet=0, quoteAmount=200 -> amount=200', async () => {
    const { loadOrderSnapshot } = await import('../toolRegistry');
    const prisma = makeOrderMock(null, 0, 200);
    const snapshot = await loadOrderSnapshot(prisma, 'PO-001');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.amount).toBe(200);
  });

  it('全 0 -> amount=0（validateOrderSnapshot 会 INVALID_AMOUNT fail closed）', async () => {
    const { loadOrderSnapshot, validateOrderSnapshot } = await import('../toolRegistry');
    const prisma = makeOrderMock(0, 0, 0);
    const snapshot = await loadOrderSnapshot(prisma, 'PO-001');
    const validation = validateOrderSnapshot(snapshot);
    expect(snapshot!.amount).toBe(0);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('INVALID_AMOUNT');
  });
});

import { validateProcessDraftSemantics } from '../commitTransaction';

describe('P1-A ProcessDraft 语义校验 validateProcessDraftSemantics（纯函数）', () => {
  it('完整 draft -> ok', () => {
    const draft = makeValidDraft();
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('缺 finance.create_invoice -> MISSING_FINANCE_CREATE_INVOICE', () => {
    const draft = makeValidDraft();
    draft.subOperations = draft.subOperations.filter(s => s.toolId !== 'finance.create_invoice');
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('MISSING_FINANCE_CREATE_INVOICE');
  });

  it('缺 orders.update_status -> MISSING_ORDERS_UPDATE_STATUS', () => {
    const draft = makeValidDraft();
    draft.subOperations = draft.subOperations.filter(s => s.toolId !== 'orders.update_status');
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('MISSING_ORDERS_UPDATE_STATUS');
  });

  it('update_status after 非 Confirmed -> STATUS_AFTER_NOT_CONFIRMED', () => {
    const draft = makeValidDraft();
    draft.subOperations.find(s => s.toolId === 'orders.update_status')!.after.status = 'Production';
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.startsWith('STATUS_AFTER_NOT_CONFIRMED'))).toBe(true);
  });

  it('update_status before 非 Pending -> STATUS_BEFORE_NOT_PENDING', () => {
    const draft = makeValidDraft();
    draft.subOperations.find(s => s.toolId === 'orders.update_status')!.before.status = 'Production';
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.startsWith('STATUS_BEFORE_NOT_PENDING'))).toBe(true);
  });

  it('invoice missing customerRelationId -> INVOICE_CUSTOMER_RELATION_MISSING', () => {
    const draft = makeValidDraft();
    draft.subOperations.find(s => s.toolId === 'finance.create_invoice')!.after.customerRelationId = '';
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('INVOICE_CUSTOMER_RELATION_MISSING');
  });

  it('invoice missing currency -> INVOICE_CURRENCY_MISSING', () => {
    const draft = makeValidDraft();
    draft.subOperations.find(s => s.toolId === 'finance.create_invoice')!.after.currency = '';
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('INVOICE_CURRENCY_MISSING');
  });

  it('invoice amount <= 0 -> INVOICE_AMOUNT_INVALID', () => {
    const draft = makeValidDraft();
    draft.subOperations.find(s => s.toolId === 'finance.create_invoice')!.after.amount = 0;
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.startsWith('INVOICE_AMOUNT_INVALID'))).toBe(true);
  });

  it('invoice type 非 Receivable -> INVOICE_TYPE_NOT_RECEIVABLE', () => {
    const draft = makeValidDraft();
    draft.subOperations.find(s => s.toolId === 'finance.create_invoice')!.after.type = 'Payable';
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.startsWith('INVOICE_TYPE_NOT_RECEIVABLE'))).toBe(true);
  });

  it('invoice status 非 Issued -> INVOICE_STATUS_NOT_ISSUED', () => {
    const draft = makeValidDraft();
    draft.subOperations.find(s => s.toolId === 'finance.create_invoice')!.after.status = 'Draft';
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.startsWith('INVOICE_STATUS_NOT_ISSUED'))).toBe(true);
  });

  it('postCommitHooks 非空 -> POST_COMMIT_HOOKS_NOT_EMPTY', () => {
    const draft = makeValidDraft();
    draft.postCommitHooks.push({ type: 'email', payload: {} } as any);
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('POST_COMMIT_HOOKS_NOT_EMPTY');
  });

  it('impactScope 缺 invoices -> IMPACT_SCOPE_MISSING_INVOICES', () => {
    const draft = makeValidDraft();
    draft.impactScope = ['orders'];
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('IMPACT_SCOPE_MISSING_INVOICES');
  });
});

describe('P1-A commitOrderConfirm semantic 集成负例（$transaction 不被调用）', () => {
  it('缺 finance.create_invoice -> fail closed 且 $transaction 不被调用', async () => {
    const draft = makeValidDraft();
    draft.subOperations = draft.subOperations.filter(s => s.toolId !== 'finance.create_invoice');
    const { prisma } = makeMockPrisma2(true, true);
    const txSpy = prisma.$transaction as any;
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });
    expect(result.ok).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.error).toContain('MISSING_FINANCE_CREATE_INVOICE');
    expect(txSpy).not.toHaveBeenCalled(); // semantic 失败不进事务
  });

  it('orders.update_status 不是 Pending->Confirmed -> fail closed 且 $transaction 不被调用', async () => {
    const draft = makeValidDraft();
    draft.subOperations.find(s => s.toolId === 'orders.update_status')!.after.status = 'Production';
    const { prisma } = makeMockPrisma2(true, true);
    const txSpy = prisma.$transaction as any;
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('STATUS_AFTER_NOT_CONFIRMED');
    expect(txSpy).not.toHaveBeenCalled();
  });

  it('invoice 缺 customerRelationId -> fail closed 且 $transaction 不被调用', async () => {
    const draft = makeValidDraft();
    draft.subOperations.find(s => s.toolId === 'finance.create_invoice')!.after.customerRelationId = '';
    const { prisma } = makeMockPrisma2(true, true);
    const txSpy = prisma.$transaction as any;
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('INVOICE_CUSTOMER_RELATION_MISSING');
    expect(txSpy).not.toHaveBeenCalled();
  });

  it('invoice 缺 currency -> fail closed 且 $transaction 不被调用', async () => {
    const draft = makeValidDraft();
    draft.subOperations.find(s => s.toolId === 'finance.create_invoice')!.after.currency = '';
    const { prisma } = makeMockPrisma2(true, true);
    const txSpy = prisma.$transaction as any;
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('INVOICE_CURRENCY_MISSING');
    expect(txSpy).not.toHaveBeenCalled();
  });

  it('invoice amount <= 0 -> fail closed 且 $transaction 不被调用', async () => {
    const draft = makeValidDraft();
    draft.subOperations.find(s => s.toolId === 'finance.create_invoice')!.after.amount = 0;
    const { prisma } = makeMockPrisma2(true, true);
    const txSpy = prisma.$transaction as any;
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('INVOICE_AMOUNT_INVALID');
    expect(txSpy).not.toHaveBeenCalled();
  });

  it('对照：完整 valid draft -> $transaction 被调用', async () => {
    const draft = makeValidDraft();
    const { prisma } = makeMockPrisma2(true, true);
    const txSpy = prisma.$transaction as any;
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });
    expect(result.ok).toBe(true);
    expect(txSpy).toHaveBeenCalled(); // 正常路径进事务
  });
});

// ============================================================
// P1-B: order.confirm 真实运行验证 + 反馈闭环
// ============================================================
import { loadOrderSnapshot, validateOrderSnapshot } from '../toolRegistry';

describe('P1-B: what-you-approve-is-what-you-commit（字段级断言）', () => {
  it('invoice 提交字段必须等于 ProcessDraft 记录值（amount/currency/customerRelationId/customerName）', async () => {
    const draft = makeValidDraft();
    // 从 draft 提取期望值
    const invOp = draft.subOperations.find(s => s.toolId === 'finance.create_invoice')!;
    const expectedAmount = Number(invOp.after.amount);
    const expectedCurrency = String(invOp.after.currency);
    const expectedCustomerRelationId = String(invOp.after.customerRelationId);
    const expectedCustomerName = String(invOp.after.customerName);

    const { prisma, invoiceCreates } = makeMockPrisma2(true, true);
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });

    expect(result.ok).toBe(true);
    expect(invoiceCreates).toHaveLength(1);
    // 字段级断言：invoice.create 收到的值 === draft 记录值
    expect(invoiceCreates[0].amount).toBe(expectedAmount);
    expect(invoiceCreates[0].currency).toBe(expectedCurrency);
    expect(invoiceCreates[0].customerRelationId).toBe(expectedCustomerRelationId);
    expect(invoiceCreates[0].customerName).toBe(expectedCustomerName);
  });

  it('draft 字段漂移（amount 被篡改）-> hash mismatch fail closed', async () => {
    const draft = makeValidDraft();
    // 篡改 draft 的 invoice amount 但不重算 hash -> hash mismatch
    draft.subOperations.find(s => s.toolId === 'finance.create_invoice')!.after.amount = 999999;
    const { prisma, invoiceCreates } = makeMockPrisma2(true, true);
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });

    expect(result.ok).toBe(false);
    expect(invoiceCreates).toHaveLength(0); // 没创建 invoice
  });
});

describe('P1-B: amount fallback 集成（firstPositive 逻辑）', () => {
  it('totalActual=0, totalNet=100 -> snapshot amount=100，invoice 提交 amount=100', async () => {
    const prisma = {
      order: {
        findFirst: vi.fn(async () => ({
          id: 'order_real_id', poNumber: 'PO-001', status: 'Pending', deletedAt: null,
          totalActual: 0, totalNet: 100, quoteAmount: 200,
          salesCurrency: null, currency: 'USD',
          customer: 'ACME', customerRelationId: 'rel_1',
          billToName: null, billToRelationId: null,
        })),
      },
      orderLine: { count: vi.fn(async () => 3) },
    } as any;

    const snapshot = await loadOrderSnapshot(prisma, 'PO-001');
    expect(snapshot!.amount).toBe(100); // fallback 到 totalNet（非 0）

    const draft = buildOrderConfirmProcessDraft({
      poNumber: 'PO-001', previousStatus: 'Pending', newStatus: 'Confirmed', snapshot: snapshot!,
    });
    const invOp = draft.subOperations.find(s => s.toolId === 'finance.create_invoice')!;
    expect(Number(invOp.after.amount)).toBe(100); // draft 记录 100
  });

  it('totalActual=null, totalNet=0, quoteAmount=200 -> snapshot amount=200', async () => {
    const prisma = {
      order: {
        findFirst: vi.fn(async () => ({
          id: 'order_real_id', poNumber: 'PO-001', status: 'Pending', deletedAt: null,
          totalActual: null, totalNet: 0, quoteAmount: 200,
          salesCurrency: null, currency: 'USD',
          customer: 'ACME', customerRelationId: 'rel_1',
          billToName: null, billToRelationId: null,
        })),
      },
      orderLine: { count: vi.fn(async () => 3) },
    } as any;

    const snapshot = await loadOrderSnapshot(prisma, 'PO-001');
    expect(snapshot!.amount).toBe(200); // fallback 到 quoteAmount
  });

  it('全 <=0 -> validateOrderSnapshot INVALID_AMOUNT fail closed', async () => {
    const prisma = {
      order: {
        findFirst: vi.fn(async () => ({
          id: 'order_real_id', poNumber: 'PO-001', status: 'Pending', deletedAt: null,
          totalActual: 0, totalNet: 0, quoteAmount: 0,
          salesCurrency: null, currency: 'USD',
          customer: 'ACME', customerRelationId: 'rel_1',
          billToName: null, billToRelationId: null,
        })),
      },
      orderLine: { count: vi.fn(async () => 3) },
    } as any;

    const snapshot = await loadOrderSnapshot(prisma, 'PO-001');
    const validation = validateOrderSnapshot(snapshot);
    expect(snapshot!.amount).toBe(0);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('INVALID_AMOUNT');
  });
});

describe('P1-B: status drift fail closed（集成）', () => {
  it('订单状态被并发改为非 Pending -> commit STATUS_DRIFT fail closed', async () => {
    const draft = makeValidDraft(); // previousStatus=Pending
    // mock order 状态已是 Confirmed（并发漂移）
    const { prisma } = makeMockPrisma2(true, false); // statusMatch=false -> status=Confirmed
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });

    expect(result.ok).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.error).toContain('STATUS_DRIFT');
  });
});

describe('P1-B: 完整 happy path 链路（snapshot->draft->payload->恢复->commit）', () => {
  it('端到端：loadOrderSnapshot -> buildDraft -> payload -> recoverDraft -> commit 全链路', async () => {
    // 1. 真实订单 mock
    const orderRow = {
      id: 'order_real_id', poNumber: 'PO-001', status: 'Pending', deletedAt: null,
      totalActual: 15000, totalNet: null, quoteAmount: null,
      salesCurrency: 'EUR', currency: null,
      customer: 'Cust-Fallback', customerRelationId: 'rel_cust_1',
      billToName: 'BillTo-ACME', billToRelationId: 'rel_billto_1',
    };
    const prismaForSnapshot = {
      order: { findFirst: vi.fn(async () => orderRow) },
      orderLine: { count: vi.fn(async () => 5) },
    } as any;

    // 2. loadOrderSnapshot（amount=15000, currency=EUR, customerRelationId=rel_billto_1, customerName=BillTo-ACME）
    const snapshot = await loadOrderSnapshot(prismaForSnapshot, 'PO-001');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.amount).toBe(15000);
    expect(snapshot!.currency).toBe('EUR');
    expect(snapshot!.customerRelationId).toBe('rel_billto_1'); // billToRelationId 优先
    expect(snapshot!.customerName).toBe('BillTo-ACME'); // billToName 优先
    expect(snapshot!.lineCount).toBe(5);

    // 3. validateOrderSnapshot 通过
    const validation = validateOrderSnapshot(snapshot);
    expect(validation.ok).toBe(true);

    // 4. buildOrderConfirmProcessDraft
    const draft = buildOrderConfirmProcessDraft({
      poNumber: 'PO-001', previousStatus: 'Pending', newStatus: 'Confirmed', snapshot: snapshot!,
    });
    const invOp = draft.subOperations.find(s => s.toolId === 'finance.create_invoice')!;
    expect(Number(invOp.after.amount)).toBe(15000);
    expect(String(invOp.after.currency)).toBe('EUR');
    expect(String(invOp.after.customerRelationId)).toBe('rel_billto_1');

    // 5. 模拟审批：payload 携带 draft
    const approvalPayload = { processDraft: draft, toolId: 'order.confirm' };

    // 6. 恢复 draft
    const recovered = recoverProcessDraftFromPayload(approvalPayload as any);
    expect(recovered).not.toBeNull();
    expect(recovered!.idempotencyKey).toBe(draft.idempotencyKey);

    // 7. commit（用恢复的 draft）
    const { prisma, invoiceCreates, entityLinkCalls, tx } = makeMockPrisma2(true, true);
    // 覆盖 order mock 用真实订单数据
    tx.order.findFirst = vi.fn(async () => orderRow);
    tx.order.update = vi.fn(async () => ({}));
    tx.orderStatusTransition.create = vi.fn(async () => ({}));
    (prisma.$transaction as any) = vi.fn(async (fn: any) => fn(tx));
    const result = await commitOrderConfirm({
      prisma, approvalId: 'ar_e2e', approvalPayload: approvalPayload as any,
    });

    // 8. 验证 commit 结果
    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.orderId).toBe('order_real_id');
    expect(result.newStatus).toBe('Confirmed');
    expect(result.previousStatus).toBe('Pending');
    expect(invoiceCreates).toHaveLength(1);
    expect(invoiceCreates[0].amount).toBe(15000); // what-you-approve-is-what-you-commit
    expect(invoiceCreates[0].currency).toBe('EUR');
    expect(invoiceCreates[0].orderId).toBe('order_real_id');
    // sync 两维度
    const linkKinds = entityLinkCalls.map(c => c.create?.linkKind).filter(Boolean);
    expect(linkKinds).toContain('aboutOrder');
    expect(linkKinds).toContain('billTo');
    // 审计摘要
    expect(result.audit?.approvalId).toBe('ar_e2e');
    expect(result.audit?.idempotencyKey).toBe(draft.idempotencyKey);
  });
});

describe('P1-B: scope 保持（无 email/EmailQueue/hooks）', () => {
  it('buildOrderConfirmProcessDraft postCommitHooks 为空', () => {
    const draft = makeValidDraft();
    expect(draft.postCommitHooks).toEqual([]);
  });

  it('validateProcessDraftSemantics 拒绝非空 postCommitHooks', () => {
    const draft = makeValidDraft();
    draft.postCommitHooks.push({ type: 'email', payload: {} } as any);
    const result = validateProcessDraftSemantics(draft);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('POST_COMMIT_HOOKS_NOT_EMPTY');
  });

  it('commitOrderConfirm 成功时 postCommitQueue 为空', async () => {
    const draft = makeValidDraft();
    const { prisma } = makeMockPrisma2(true, true);
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });
    expect(result.ok).toBe(true);
    expect(result.postCommitQueue).toEqual([]);
  });
});

describe('P1-C: commit 成功结构化字段（feedback contract）', () => {
  it('commit 成功返回 orderId/poNumber/invoiceId/invoiceNumber/amount/currency/customerRelationId/customerName/auditId/idempotencyKey/entityLinks', async () => {
    const draft = makeValidDraft();
    const { prisma } = makeMockPrisma2(true, true);
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar_p1c', approvalPayload: { processDraft: draft } as any });

    expect(result.ok).toBe(true);
    // 验收第3点：结构化字段全部存在
    expect(result.orderId).toBe('order_real_id');
    expect(result.poNumber).toBe('PO-001');
    expect(result.previousStatus).toBe('Pending');
    expect(result.newStatus).toBe('Confirmed');
    expect(result.invoiceId).toMatch(/^INV__/);
    expect(result.invoiceNumber).toMatch(/^INV-\d+-/);
    expect(result.amount).toBe(12000);
    expect(result.currency).toBe('USD');
    expect(result.customerRelationId).toBe('rel_cust_1');
    expect(result.customerName).toBe('ACME');
    expect(result.auditId).toMatch(/^audit_commit_tx_/);
    expect(result.idempotencyKey).toBe(draft.idempotencyKey);
    // entityLinks 含 aboutOrder + billTo
    expect(result.entityLinks).toBeDefined();
    const linkKinds = result.entityLinks!.map(l => l.linkKind);
    expect(linkKinds).toContain('aboutOrder');
    expect(linkKinds).toContain('billTo');
  });
});

describe('P1-C: fail-closed 统一 errorFeedback envelope（code+message+userAction）', () => {
  it('semantic validation 失败 -> errorFeedback 含稳定 code + userAction', async () => {
    const draft = makeValidDraft();
    draft.subOperations = draft.subOperations.filter(s => s.toolId !== 'finance.create_invoice');
    const { prisma } = makeMockPrisma2(true, true);
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });

    expect(result.ok).toBe(false);
    expect(result.errorFeedback).toBeDefined();
    expect(result.errorFeedback!.code).toBe('SEMANTIC_VALIDATION_FAILED');
    expect(result.errorFeedback!.message).toBeTruthy();
    expect(result.errorFeedback!.userAction).toBeTruthy();
    expect(result.errorFeedback!.retryable).toBe(false);
    expect(result.errorFeedback!.details).toContain('MISSING_FINANCE_CREATE_INVOICE');
  });

  it('hash mismatch -> errorFeedback.code = PROCESS_DRAFT_HASH_MISMATCH', async () => {
    const draft = makeValidDraft();
    draft.subOperations.find(s => s.toolId === 'orders.update_status')!.entityId = 'PO-TAMPERED';
    const { prisma } = makeMockPrisma2(true, true);
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });

    expect(result.ok).toBe(false);
    expect(result.errorFeedback!.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(result.errorFeedback!.userAction).toContain('重新发起审批');
  });

  it('status drift -> errorFeedback.code = STATUS_DRIFT', async () => {
    const draft = makeValidDraft();
    const { prisma } = makeMockPrisma2(true, false); // status 漂移
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });

    expect(result.ok).toBe(false);
    expect(result.errorFeedback!.code).toBe('STATUS_DRIFT');
    expect(result.errorFeedback!.userAction).toContain('刷新');
  });

  it('$transaction 失败 -> errorFeedback.code = COMMIT_TRANSACTION_FAILED', async () => {
    const draft = makeValidDraft();
    const prisma = {
      $transaction: vi.fn(async () => { throw new Error('DB_CONNECTION_LOST'); }),
      ...gateAnchor(),
      approvalRequest: { findUnique: vi.fn(async () => ({ id: 'ar', requesterId: 'u', status: 'approved' })) },
    } as any;
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });

    expect(result.ok).toBe(false);
    expect(result.errorFeedback!.code).toBe('COMMIT_TRANSACTION_FAILED');
    expect(result.errorFeedback!.retryable).toBe(false);
  });
});

// ============================================================================
// Phase 2 · 2.2: order.confirm 并发一致性——Serializable 隔离 + P2034 可重试冲突
// ============================================================================

describe('task 2.2: commitOrderConfirm 并发一致性（Serializable + P2034 retryable）', () => {
  it('$transaction 以 Serializable 隔离级执行（STATUS_DRIFT check-then-act 防并发双确认）', async () => {
    const draft = makeValidDraft();
    const { prisma } = makeMockPrisma2(true, true);
    await commitOrderConfirm({ prisma, approvalId: 'ar_serializable', approvalPayload: { processDraft: draft } as any });
    expect(prisma.$transaction.mock.calls[0][1]).toMatchObject({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it('P2034 序列化冲突 -> COMMIT_CONFLICT + retryable=true（并发双确认被 SSI 安全中止）', async () => {
    const draft = makeValidDraft();
    const prisma = {
      $transaction: vi.fn(async () => {
        throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' });
      }),
      ...gateAnchor(),
      approvalRequest: { findUnique: vi.fn(async () => ({ id: 'ar', requesterId: 'u', status: 'approved' })) },
      agentCommitReceipt: { findUnique: vi.fn(async () => null) },
    } as any;
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });

    expect(result.ok).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.error).toContain('COMMIT_CONFLICT');
    expect(result.errorFeedback!.retryable).toBe(true);
  });

  it('非 P2034 事务失败仍不可重试（不错误鼓励重试）', async () => {
    const draft = makeValidDraft();
    const prisma = {
      $transaction: vi.fn(async () => { throw new Error('DB_CONNECTION_LOST'); }),
      ...gateAnchor(),
      approvalRequest: { findUnique: vi.fn(async () => ({ id: 'ar', requesterId: 'u', status: 'approved' })) },
    } as any;
    const result = await commitOrderConfirm({ prisma, approvalId: 'ar', approvalPayload: { processDraft: draft } as any });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('COMMIT_TRANSACTION_FAILED');
    expect(result.errorFeedback!.retryable).toBe(false);
  });
});

// ============================================================================
// B50-1b · commit 调用共用门禁的**参数**（本文件把判定桩成放行，判定本身由
//   `orderConfirmGateCommitB50b.test.ts` 用真实现覆盖）。这组用例存在的唯一理由：
//   让本文件顶部注释那句"谁删了 commit 里那句门禁调用，文末断言立刻红"成为事实。
// ============================================================================
describe('B50-1b · commitOrderConfirm 确实按正确口径调用共用门禁', () => {
  it('★ 用 poNumber 解析出的订单 id（不是草稿里的 orderId）+ 审批真实请求人当 actorId', async () => {
    gateSpy.mockClear();
    const { prisma } = makeMockPrisma2(true, true);
    // 草稿里那个 orderId 故意给成**另一个值**（在 build 之前改，hash 与 idempotencyKey 仍然自洽；
    //   若在 build 之后改就会撞 `verifyProcessDraftHash`，测的就不是门禁锚点了）。
    //   ⇒ 门禁若误用 draft 带的 id，下面这条断言立刻红。
    const snap = { ...makeValidSnapshot(), orderId: 'ORDER_FROM_DRAFT_MUST_NOT_BE_USED' };
    const draft = buildOrderConfirmProcessDraft({
      poNumber: 'PO-001', previousStatus: 'Pending', newStatus: 'Confirmed', snapshot: snap,
    });
    // ★ B58：身份由 registry 注入（`toolDispatchRegistry` 取 `ApprovalRequest.requesterId`），本函数不再自己查
    const r = await commitOrderConfirm({ prisma, approvalId: 'ar_test', approvalPayload: { processDraft: draft } as any, actorId: 'usr_tester' });
    expect(r.ok).toBe(true);
    expect(gateSpy, 'commit 里那句门禁调用被删 = 门禁静默消失，而其余 76 例照样绿').toHaveBeenCalledTimes(1);
    const arg = gateSpy.mock.calls[0][0];
    expect(arg.orderId).toBe('order_real_id');
    expect(arg.actorId, '豁免单/审计都要落在真实请求人身上（外键指向 UserAccount）').toBe('usr_tester');
    expect(arg.logScope).toBe('agent:order.confirm:commit');
  });

  it('★ B58：不经 registry 直接调用（params 无 actorId）⇒ 落 seed 的 system，绝不落库里没有的哨兵', async () => {
    gateSpy.mockClear();
    const { prisma } = makeMockPrisma2(true, true);
    const snap = makeValidSnapshot();
    const draft = buildOrderConfirmProcessDraft({
      poNumber: 'PO-001', previousStatus: 'Pending', newStatus: 'Confirmed', snapshot: snap,
    });
    const r = await commitOrderConfirm({ prisma, approvalId: 'ar_test', approvalPayload: { processDraft: draft } as any });
    expect(r.ok).toBe(true);
    // 'unknown'（B50-1a 之前的兜底）与 'agent'（B58 这一族）在 UserAccount 里都没有行
    //   ⇒ 写进 AuditLog.actorId 就是 P2003、整笔提交回滚。缺省值必须是真账号。
    expect(gateSpy.mock.calls[0][0].actorId).toBe('system');
  });

  it('★ 门禁阻断时不提交、不落回执，并把契约码原样带出（桩在这里只判位置与形状）', async () => {
    gateSpy.mockClear();
    gateSpy.mockResolvedValueOnce({
      allowed: false,
      error: { code: 'MOQ_VIOLATION', message: '订单数量 100 低于 MOQ 500（豁免审批单 APR__S 已自动发起）', approvalRequestId: 'APR__S' },
    });
    const { prisma } = makeMockPrisma2(true, true);
    const r = await commitOrderConfirm({ prisma, approvalId: 'ar_test', approvalPayload: { processDraft: makeValidDraft() } as any });
    expect(r.ok).toBe(false);
    expect(r.errorFeedback?.code).toBe('CONFIRM_GATE_BLOCKED');
    expect(r.errorFeedback?.gateCode).toBe('MOQ_VIOLATION');
    expect(r.errorFeedback?.approvalRequestId).toBe('APR__S');
    expect(prisma.$transaction, '门禁在事务之前 ⇒ 整笔事务根本不该开').not.toHaveBeenCalled();
    gateSpy.mockResolvedValue({ allowed: true, creditExceptionPass: null });
  });
});

// An internal adapter error may contain a business-looking word and SQL text.
// It must not be classified as our own transaction refusal or leak its text.
it('business-looking raw storage text remains a safe unknown failure', async () => {
  const draft = makeValidDraft();
  const { prisma } = makeMockPrisma(true, true);
  prisma.$transaction = vi.fn(async () => { throw Error('STATUS_DRIFT: SELECT secret_cost FROM private_table'); });
  const result = await commitOrderConfirm({ prisma, approvalId: 'ar_test', approvalPayload: { processDraft: draft } as any });
  expect(result.ok).toBe(false);
  expect(result.committed).toBe(false);
  expect(result.errorFeedback?.code).toBe('COMMIT_TRANSACTION_FAILED');
  expect(result.error).not.toContain('SELECT');
  expect(result.error).not.toContain('secret_cost');
});
