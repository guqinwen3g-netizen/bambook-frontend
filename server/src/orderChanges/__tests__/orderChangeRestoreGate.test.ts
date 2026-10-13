/**
 * orderChangeRestoreGate.test.ts — A10-①（拍板件 §2.3）恢复门禁
 *
 * ## 病根（拍板件原文）
 * 全仓有**三处**会把订单状态**写回**到「申请前 / 出运前」的状态，而它们**都不走**
 * `transitionOrderStatus`（该函数把 `CancelRequested/PauseRequested/Closing/Paused`
 * 当 DR-010 守卫态直接拒掉）⇒ 三处各自直写 `tx.order.update`：
 *   ① 审批**驳回**取消/暂停申请 → 恢复（本文件覆盖）
 *   ② 申请人**撤回**取消/暂停申请 → 恢复（本文件覆盖）
 *   ③ **运单取消** → 订单回退（`orderLinkService`，另一个文件覆盖）
 * ⇒ 一条 **HTTP 可达、无需审批**的免检入口：能把订单直接写回 `Confirmed` 而**不跑任何门禁**。
 *
 * ## 本文件钉的四件事
 * 1. **硬条件 4 阳性对照**：「暂停期间客户被冻结」⇒ 撤回**成功**（撤回是申请人的权利）、
 *    但**订单不写回**（停在 `PauseRequested`）、响应里有**可读原因**。
 * 2. **硬条件 3 语义**：变更单照常撤回/驳回，**只是订单状态不写回** —— 两件事必须分开。
 * 3. **硬条件 2**：`restoreStatus` 的兜底值 `'Confirmed'`（回查不到时间线时写死）被门禁罩住。
 * 4. ★ **回归钉**：恢复回 `Production` **不跑门禁**（更正件：该档「没有现成门禁」，
 *    补救在**前进侧**）⇒ 冻结客户也照样写回。★ 我第一版在这里多挂了一道冻结门禁，
 *    属未被授权的多加项，已改回 —— 本用例钉住它。
 *
 * ## 档位真源（逐字照抄 `审阅方更正件-S级复量-2026-09-25.md` §三）
 * | 档位 | 门禁 |
 * |---|---|
 * | 恢复回 `Confirmed` | 跑 `evaluateOrderConfirmGates`（存在，直接用） |
 * | 恢复回 `Production` | **没有现成门禁** ⇒ 补救在**前进侧**补 |
 * | **前进** `Confirmed → Production` | 新增一项「客户冻结」检查 |
 * | `Production → Shipping → Completed` | 仍不跑门禁（已知且接受） |
 *
 * ★ 本组用例在改前必须红：`withdrawChangeRequest` / `syncFromApprovalDecision`
 *   此前**完全不跑门禁**（`restoreBlocked` 字段也不存在）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../customerConfirmations/customerConfirmationService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, currentCustomerConfirmationActor: vi.fn(async (_tx: any, prior: any, requiredScope: string) => {
    if (!prior?.userId) throw Object.assign(new Error('missing actor'), { code: 'UNAUTHORIZED', statusCode: 401 });
    if (prior.permissionCeiling && !prior.permissionCeiling.includes('*') && !prior.permissionCeiling.includes(requiredScope))
      throw Object.assign(new Error('permission ceiling'), { code: 'FORBIDDEN', statusCode: 403 });
    return { ...prior, permissions: [...new Set([...(prior.permissions ?? []), requiredScope])], authorizationLoaded: true };
  }) };
});
vi.mock('../../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => ({})) }));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createOrderChangeRequestService } from '../orderChangeRequestService';

// ───────────────────────────────────────────────────────────────────
// fixtures
// ───────────────────────────────────────────────────────────────────

/** 有效 MOQ 快照：走 snapshot 口径（100），不查实时配置 —— 本文件不测 MOQ。 */
const MOQ_SNAPSHOT = {
  fabricDefaultMoq: 100, garmentDefaultMoq: 100, capsuleMoq: 10,
  snapshotAt: '2026-01-01T00:00:00.000Z', configId: null, source: 'moq_config',
};

/**
 * 订单：`customerRelationId` **必须给**（否则信用门禁整段被跳过，阳性对照就假了）；
 * `paymentInstrument: 'T/T'` ⇒ L/C 门禁内部直接早退（非信用证），不查信用证表。
 */
function makeOrder(overrides: any = {}) {
  return {
    id: 'ORD__1',
    status: 'PauseRequested',
    deletedAt: null,
    customerRelationId: 'REL_A',
    type: 'Garment',
    businessLine: 'garment',
    quantity: 200,
    unit: 'pcs',
    capsuleExemption: false,
    quoteAmount: 10000,
    paymentInstrument: 'T/T',
    moqSnapshot: MOQ_SNAPSHOT,
    ...overrides,
  };
}

function makeCreditLimit(status: string) {
  return {
    id: 'CL__1', relationId: 'REL_A', status,
    totalLimit: 100000, usedAmount: 0, currency: 'USD',
    frozenAt: null, frozenBy: null, thawedReason: null,
    deletedAt: null, createdAt: new Date(),
  };
}

/** 暂停申请（`attachments.pause` 为真 ⇒ isPause）。 */
function pauseCr(over: any = {}) {
  return {
    id: 'OCR_1', orderId: 'ORD__1', requestNumber: 'OCR-20260926-001',
    status: 'Pending', changeTypes: ['other'],
    requesterId: 'u_sales', deletedAt: null,
    attachments: { pause: { expectedResumeDate: '2026-12-31' } },
    approvalRequestId: 'ar_1',
    ...over,
  };
}

const trustedActor = (userId = 'u_sales', roles = ['sales']) => ({ userId, roles,
  permissions: ['order:change_request:create'], authorizationLoaded: true as const, departmentIds: [] });

function makePrisma(opts: {
  order?: any;
  changeRequest?: any;
  creditLimit?: any;
  transition?: any;
  exceptions?: any[];
} = {}) {
  const order = opts.order === undefined ? makeOrder() : opts.order;
  const cr = opts.changeRequest === undefined ? pauseCr() : opts.changeRequest;

  const calls = {
    orderUpdate: vi.fn(async ({ where, data }: any) => ({ ...order, ...data, id: where.id })),
    crUpdate: vi.fn(async ({ where, data }: any) => ({ ...(cr ?? {}), ...data, id: where.id })),
    transitionCreate: vi.fn(async () => ({})),
    auditCreate: vi.fn(async (_args: any) => ({ id: 'AL-1' })),
    approvalUpdateMany: vi.fn(async () => ({ count: 1 })),
    exceptionFindMany: vi.fn(async () => opts.exceptions ?? []),
    exceptionClaim: vi.fn(async (_args: any) => ({ count: 1 })),
  };

  const prisma: any = {
    order: {
      findUnique: vi.fn(async ({ where }: any) => (order && order.id === where.id ? order : null)),
      findFirst: vi.fn(async ({ where }: any) => order && order.id === where.id ? order : null),
      update: calls.orderUpdate,
      findMany: vi.fn(async () => (order ? [order] : [])),
    },
    orderChangeRequest: {
      findUnique: vi.fn(async ({ where }: any) => (cr && cr.id === where.id ? cr : null)),
      findFirst: vi.fn(async ({ where }: any) =>
        cr && (where?.approvalRequestId === undefined || where.approvalRequestId === cr.approvalRequestId) ? cr : null),
      update: calls.crUpdate,
      findMany: vi.fn(async () => (cr ? [cr] : [])),
      count: vi.fn(async () => 0),
    },
    orderStatusTransition: {
      findFirst: vi.fn(async () => opts.transition ?? null),
      create: calls.transitionCreate,
    },
    approvalRequest: {
      updateMany: calls.approvalUpdateMany,
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    auditLog: { create: calls.auditCreate },
    // 信用门禁取数（与 orderConfirmGates.test.ts 同口径）
    creditLimit: {
      findFirst: vi.fn(async () => opts.creditLimit ?? null),
      findMany: vi.fn(async () => []),
    },
    creditLimitHistory: { create: vi.fn(async ({ data }: any) => data) },
    invoice: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    // 信用例外（DR-013）：无生效例外
    dr013ExceptionRequest: {
      findMany: calls.exceptionFindMany,
      findUnique: vi.fn(async ({ where }: any) => opts.exceptions?.find(row => row.id === where.id) ?? null),
      updateMany: calls.exceptionClaim,
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: any) => ({ ...data })),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    // MOQ 配置：无 active 配置 ⇒ 走兜底常量（有 try/catch，不会抛）
    moqThresholdConfig: { findFirst: vi.fn(async () => null) },
    productAsset: { findMany: vi.fn(async () => []) },
    letterOfCredit: { findMany: vi.fn(async () => []) },
    relation: { findUnique: vi.fn(async () => null) },
    customerTier: { findFirst: vi.fn(async () => null) },
    quotation: { findFirst: vi.fn(async () => null) },
    orderLine: { findMany: vi.fn(async () => [{ id: 'OL_1', orderId: 'ORD__1', lineNumber: 1,
      quantity: '200', unit: 'pcs', unitPrice: null, netValue: null, moqOverride: null,
      confirmedSourceType: null, confirmedSourceId: null, specSnapshot: null }]) },
    userAccount: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, status: 'active', deletedAt: null,
      roles: [], primaryDeptId: 'dept_1' })) },
    userPermissionOverrides: { findMany: vi.fn(async () => [{ scope: 'order:change_request:create' },
      { scope: 'order:change_request:apply' }, { scope: 'order:confirm' }]) },
    entityReference: { upsert: vi.fn(async () => ({})) },
    entityLink: {
      upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    $queryRaw: vi.fn(async () => [{ id: 'EXC_restore' }]),
    $queryRawUnsafe: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, calls, order, cr };
}

function makeService(prisma: any) {
  return createOrderChangeRequestService({
    prisma,
    approvalCreateService: { createBusinessApproval: vi.fn(async (i: any) => ({ id: 'ar_1', ...i })) } as any,
  });
}

/** 暂停申请的时间线：申请前是 `Confirmed` ⇒ 恢复目标 = `Confirmed`。 */
const TRANSITION_FROM_CONFIRMED = { fromStatus: 'Confirmed', toStatus: 'PauseRequested' };

beforeEach(() => vi.clearAllMocks());

// ═══════════════════════════════════════════════════════════════════
// ① 撤回路径
// ═══════════════════════════════════════════════════════════════════
describe('★ A10-① 撤回：恢复写回前必须先过门禁', () => {
  it('★ 硬条件 4 阳性对照：暂停期间客户被冻结 ⇒ 撤回成功、订单**不写回**（停在 PauseRequested）、有可读原因', async () => {
    const { prisma, calls } = makePrisma({
      order: makeOrder({ status: 'PauseRequested', customerRelationId: 'REL_F' }),
      changeRequest: pauseCr(),
      creditLimit: makeCreditLimit('Frozen'),
      transition: TRANSITION_FROM_CONFIRMED,
    });
    const service = makeService(prisma);

    const res = await service.withdrawChangeRequest({ changeRequestId: 'OCR_1', actorId: 'u_sales', trustedActor: trustedActor() });

    // ★ 硬条件 3：撤回**照常生效**（撤回是申请人的权利，不该被客户冻结卡住）
    expect(res.ok, '撤回本身必须成功').toBe(true);
    if (res.ok) {
      expect(res.data.changeRequest.status).toBe('Cancelled');
      expect(res.data.orderRestoredTo, '被拦 ⇒ 没有恢复目标').toBeNull();
      expect(res.data.restoreBlocked, '必须给出可读原因，不许静默').toBeTruthy();
      expect(res.data.restoreBlocked!.code).toBe('CREDIT_FROZEN_60_DAYS');
      // 文案要说清「不是不让你撤回，是订单当前不具备恢复条件」+ 给下一步
      expect(res.data.restoreBlocked!.message).toContain('未恢复');
      expect(res.data.restoreBlocked!.message).toContain('撤回已生效');
      // ★ 对外文案**只带原因码**，不得内插门禁原文（本仓 B22/B30 棘轮：只许减不许增）
      expect(res.data.restoreBlocked!.message).toContain('CREDIT_FROZEN_60_DAYS');
      expect(res.data.restoreBlocked!.message, '内部原文/英文异常不得上屏')
        .not.toMatch(/PrismaClient|Error:|at .*\.ts:\d+/);
    }
    // ★ 硬条件 4：订单**停在** PauseRequested
    expect(calls.orderUpdate, '被拦时订单状态一次都不许写').not.toHaveBeenCalled();
  });

  it('反面对照：同一场景客户 Active ⇒ 订单写回 Confirmed、restoreBlocked 为空（防"一律拦下"的假门禁）', async () => {
    const { prisma, calls } = makePrisma({
      order: makeOrder({ status: 'PauseRequested', customerRelationId: 'REL_A' }),
      changeRequest: pauseCr(),
      creditLimit: makeCreditLimit('Active'),
      transition: TRANSITION_FROM_CONFIRMED,
    });
    const service = makeService(prisma);

    const res = await service.withdrawChangeRequest({ changeRequestId: 'OCR_1', actorId: 'u_sales', trustedActor: trustedActor() });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.orderRestoredTo).toBe('Confirmed');
      expect(res.data.restoreBlocked).toBeNull();
    }
    expect(calls.orderUpdate).toHaveBeenCalledTimes(1);
    expect(calls.orderUpdate.mock.calls[0][0].data.status).toBe('Confirmed');
  });

  it('★ 硬条件 2：时间线回查不到 ⇒ 兜底 `Confirmed` 也必须过门禁（不许"读不出来就白送"）', async () => {
    const { prisma, calls } = makePrisma({
      order: makeOrder({ status: 'PauseRequested', customerRelationId: 'REL_F' }),
      changeRequest: pauseCr(),
      creditLimit: makeCreditLimit('Frozen'),
      transition: null, // ← 回查不到 ⇒ restoreStatus 落到硬编码兜底 'Confirmed'
    });
    const service = makeService(prisma);

    const res = await service.withdrawChangeRequest({ changeRequestId: 'OCR_1', actorId: 'u_sales', trustedActor: trustedActor() });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.restoreBlocked, '兜底值也必须被门禁罩住').toBeTruthy();
    expect(calls.orderUpdate, '兜底路径同样不许绕过门禁写回').not.toHaveBeenCalled();
  });

  it('★ 回归钉：恢复目标 = `Production` ⇒ **不跑门禁**（更正件：该档没有现成门禁，补救在前进侧）', async () => {
    const { prisma, calls } = makePrisma({
      order: makeOrder({ status: 'PauseRequested', customerRelationId: 'REL_F' }),
      changeRequest: pauseCr(),
      creditLimit: makeCreditLimit('Frozen'), // 冻结也照样写回 —— 因为这一档本就不该跑门禁
      transition: { fromStatus: 'Production', toStatus: 'PauseRequested' },
    });
    const service = makeService(prisma);

    const res = await service.withdrawChangeRequest({ changeRequestId: 'OCR_1', actorId: 'u_sales', trustedActor: trustedActor() });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.orderRestoredTo).toBe('Production');
      expect(res.data.restoreBlocked).toBeNull();
    }
    expect(calls.orderUpdate).toHaveBeenCalledTimes(1);
    expect(calls.orderUpdate.mock.calls[0][0].data.status).toBe('Production');
  });

  it('★ 取消申请（非暂停）+ 冻结 ⇒ 同样被拦，订单停在 CancelRequested', async () => {
    const { prisma, calls } = makePrisma({
      order: makeOrder({ status: 'CancelRequested', customerRelationId: 'REL_F' }),
      // 取消申请：changeTypes ['other'] 且 attachments.pause 为空
      changeRequest: pauseCr({ attachments: null }),
      creditLimit: makeCreditLimit('Frozen'),
      transition: { fromStatus: 'Confirmed', toStatus: 'CancelRequested' },
    });
    const service = makeService(prisma);

    const res = await service.withdrawChangeRequest({ changeRequestId: 'OCR_1', actorId: 'u_sales', trustedActor: trustedActor() });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.restoreBlocked!.code).toBe('CREDIT_FROZEN_60_DAYS');
    expect(calls.orderUpdate).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// ② 审批驳回路径（同源，别各写一份）
// ═══════════════════════════════════════════════════════════════════
describe('★ A10-① 审批驳回：与撤回同源，恢复写回前同样先过门禁', () => {
  it('★ 冻结 ⇒ 变更单照常 Rejected、订单**不写回**、响应带可读原因', async () => {
    const { prisma, calls } = makePrisma({
      order: makeOrder({ status: 'PauseRequested', customerRelationId: 'REL_F' }),
      changeRequest: pauseCr(),
      creditLimit: makeCreditLimit('Frozen'),
      transition: TRANSITION_FROM_CONFIRMED,
    });
    const service = makeService(prisma);

    const res = await service.syncFromApprovalDecision({
      approvalRequestId: 'ar_1', decision: 'rejected', actorId: 'u_supervisor',
    });

    expect(res.ok, '驳回本身必须成功').toBe(true);
    if (res.ok) {
      expect(res.data.changeRequest.status, '驳回照常生效').toBe('Rejected');
      expect(res.data.orderRestoredTo).toBeNull();
      expect(res.data.restoreBlocked!.code).toBe('CREDIT_FROZEN_60_DAYS');
    }
    expect(calls.orderUpdate, '被拦时订单状态一次都不许写').not.toHaveBeenCalled();
    expect(calls.transitionCreate, '不许留下一条"恢复过"的时间线').not.toHaveBeenCalled();
  });

  it('反面对照：Active ⇒ 变更单 Rejected + 订单写回 Confirmed + 留一条时间线', async () => {
    const { prisma, calls } = makePrisma({
      order: makeOrder({ status: 'PauseRequested', customerRelationId: 'REL_A' }),
      changeRequest: pauseCr(),
      creditLimit: makeCreditLimit('Active'),
      transition: TRANSITION_FROM_CONFIRMED,
    });
    const service = makeService(prisma);

    const res = await service.syncFromApprovalDecision({
      approvalRequestId: 'ar_1', decision: 'rejected', actorId: 'u_supervisor',
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.orderRestoredTo).toBe('Confirmed');
    expect(calls.orderUpdate).toHaveBeenCalledTimes(1);
    expect(calls.transitionCreate).toHaveBeenCalledTimes(1);
  });

  it('★ approved 决策**不**触发恢复（只有驳回/撤回才恢复）⇒ 冻结也不该影响它', async () => {
    const { prisma, calls } = makePrisma({
      order: makeOrder({ status: 'PauseRequested', customerRelationId: 'REL_F' }),
      changeRequest: pauseCr(),
      creditLimit: makeCreditLimit('Frozen'),
      transition: TRANSITION_FROM_CONFIRMED,
    });
    const service = makeService(prisma);

    const res = await service.syncFromApprovalDecision({
      approvalRequestId: 'ar_1', decision: 'approved', actorId: 'u_supervisor',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.changeRequest.status).toBe('Approved');
      expect(res.data.restoreBlocked ?? null).toBeNull();
    }
    expect(calls.orderUpdate, '批准不写订单状态').not.toHaveBeenCalled();
  });
});

/** Adapter behavior only: real locks/SQL rollback are covered by the opt-in PG file. */
describe('restore Confirmed consumes the actual scoped credit pass in the business transaction', () => {
  function effectiveException() {
    return { id: 'EXC_restore', exceptionNumber: 'EXC_restore', exceptionCategory: 'credit_exemption',
      status: 'ReviewerApproved', deletedAt: null, approvalRequestId: 'EXC_approval', attachments: { files: [], scope: {
        targetType: 'Order', targetId: 'ORD__1', action: 'order:confirm', responsibleOwnerId: 'u_sales',
        validUntil: new Date(Date.now() + 60_000).toISOString(), maxUses: 1, usedCount: 0, consumptions: [],
      } } };
  }
  for (const path of ['rejection', 'withdrawal'] as const) {
    it(`${path}: approved exact Order/order:confirm pass is locked, claimed and audited by the real actor`, async () => {
      const { prisma, calls } = makePrisma({ creditLimit: makeCreditLimit('Frozen'),
        transition: TRANSITION_FROM_CONFIRMED, exceptions: [effectiveException()] });
      const service = makeService(prisma), actorId = path === 'rejection' ? 'u_supervisor' : 'u_sales';
      const result = path === 'rejection'
        ? await service.syncFromApprovalDecision({ approvalRequestId: 'ar_1', decision: 'rejected', actorId })
        : await service.withdrawChangeRequest({ changeRequestId: 'OCR_1', actorId, trustedActor: trustedActor(actorId) });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.orderRestoredTo).toBe('Confirmed');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1); // no nested consume transaction
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2); // customer MOQ source row + one-use exception source row
      expect(prisma.$queryRaw.mock.calls.some(([query]: any[]) =>
        String(Array.isArray(query) ? query.join('') : query.strings?.join(''))
          .includes('FROM "Dr013ExceptionRequest"'))).toBe(true);
      expect(calls.exceptionClaim).toHaveBeenCalledTimes(1);
      expect(calls.exceptionClaim.mock.calls[0][0]).toMatchObject({ where: { id: 'EXC_restore', status: 'ReviewerApproved' },
        data: { status: 'Consumed', attachments: { scope: { usedCount: 1, consumptions: [{ consumedBy: actorId }] } } } });
      expect(calls.auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        actorId, action: 'dr013_exception_consumed', targetType: 'Dr013ExceptionRequest', targetId: 'EXC_restore',
        detail: expect.objectContaining({ action: 'order:confirm', targetType: 'Order', targetId: 'ORD__1' }),
      }) }));
    });
    it(`${path}: mandatory consumption audit failure rejects the current mutation with the actual finite error`, async () => {
      const { prisma, calls } = makePrisma({ creditLimit: makeCreditLimit('Frozen'),
        transition: TRANSITION_FROM_CONFIRMED, exceptions: [effectiveException()] });
      calls.auditCreate.mockImplementation(async ({ data }: any) => {
        if (data.action === 'dr013_exception_consumed') throw Error('adapter mandatory audit failure');
        return { id: 'AL-1' };
      });
      const service = makeService(prisma);
      const result = path === 'rejection'
        ? await service.syncFromApprovalDecision({ approvalRequestId: 'ar_1', decision: 'rejected', actorId: 'u_supervisor' })
        : await service.withdrawChangeRequest({ changeRequestId: 'OCR_1', actorId: 'u_sales', trustedActor: trustedActor() });
      expect(result).toMatchObject({ ok: false, error: { code: 'EXCEPTION_CONSUME_FAILED', statusCode: 500 } });
      expect(calls.exceptionClaim).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // No state-rollback claim is made by this nontransactional adapter.
    });
  }
  it('Production restoration keeps the approved forward-side contract and does not consume a Confirmed pass', async () => {
    const { prisma, calls } = makePrisma({ creditLimit: makeCreditLimit('Frozen'),
      transition: { fromStatus: 'Production', toStatus: 'PauseRequested' }, exceptions: [effectiveException()] });
    const result = await makeService(prisma).withdrawChangeRequest({ changeRequestId: 'OCR_1', actorId: 'u_sales', trustedActor: trustedActor() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.orderRestoredTo).toBe('Production');
    expect(calls.exceptionFindMany).not.toHaveBeenCalled();
    expect(calls.exceptionClaim).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
