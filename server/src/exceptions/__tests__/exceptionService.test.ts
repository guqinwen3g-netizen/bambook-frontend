import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createExceptionService,
  EXCEPTION_ERRORS,
  EXCEPTION_STATUS,
  DR013_ACTION_TYPE,
  toExceptionView,
} from '../exceptionService';
import { logger } from '../../lib/logger';

/**
 * DR-013 受控例外服务测试：
 *   create  — 必填 5 字段 / reason≥30 / 类别枚举 / validUntil 未来性 / bypassed 审批链校验 / DR-007 路由 / 反链
 *   reconcile — 惰性对账（approved/rejected/boss bypass/cancelled）
 *   hasActiveException — 精确匹配 / 未批准保持门禁 / 过期失效 / 不复制其他订单
 *   consumeException — 一次性核销 / ALREADY_CONSUMED / NOT_FOR_THIS_ENTITY / EXPIRED / NOT_ACTIVE
 *   withdraw / bossFinalBypass — 权限与状态守卫 + 双模型写入
 */

const VALID_REASON = 'S/S客户10天未回复且临近ETD仅2天，客户电话承诺今日内邮件确认放行';
const VALID_RISK = '如客户最终拒绝确认，我方承担退运费用并给予下次订单5%折扣';

function makeScope(overrides: Record<string, unknown> = {}) {
  return {
    targetType: 'Shipment',
    targetId: 'SHIP_003',
    action: 'shipment:release',
    validUntil: null as string | null,
    maxUses: 1,
    usedCount: 0,
    consumptions: [] as any[],
    responsibleOwnerId: 'u_sales',
    ...overrides,
  };
}

function makeExc(overrides: Record<string, unknown> = {}) {
  const scope = (overrides.scope as any) ?? makeScope();
  const { scope: _omit, ...rest } = overrides;
  return {
    id: 'EXC__1',
    exceptionNumber: 'EXC-20260816-001',
    exceptionCategory: 'shipment_release',
    subCategory: 'without_ss_confirmed',
    bypassedApprovalIds: [] as string[],
    exceptionReason: VALID_REASON,
    customerCommitment: null,
    riskMitigationPlan: VALID_RISK,
    requesterId: 'u_sales',
    reviewerId: 'u_supervisor',
    approvalRequestId: 'ar_1',
    status: EXCEPTION_STATUS.PENDING,
    bossFinalBypassBy: null,
    bossFinalBypassAt: null,
    bossFinalBypassReason: null,
    notes: null,
    attachments: { files: [], scope },
    createdAt: new Date('2026-08-16T00:00:00Z'),
    updatedAt: new Date('2026-08-16T00:00:00Z'),
    deletedAt: null,
    ...rest,
  };
}

function makePrisma(opts: {
  exception?: any;            // findUnique 返回
  exceptions?: any[];         // findMany 返回
  approval?: any;             // approvalRequest.findUnique 返回（reconcile 数据源）
  bypassedApprovals?: any[];  // approvalRequest.findMany 返回（bypassed 校验）
} = {}) {
  const state = {
    stored: opts.exception === undefined ? (opts.exceptions?.[0] ?? makeExc()) : opts.exception,
  };
  // ★ B274：取号收进发号真源后，这份假库**必须**长出 SequenceRegister ——
  //   缺它时 sequenceService 会走"无模型 ⇒ 随机 6 位"的降级分支，号变成 EXC-YYYYMMDD-638720，
  //   而用例仍然"绿"的可能都没有（server 全量门禁 2026-09-28 实测到这一格红）。
  const seqRows: Record<string, number> = {};
  const calls = {
    excCreate: vi.fn(async ({ data }: any) => ({ ...data, createdAt: new Date(), updatedAt: new Date() })),
    excUpdate: vi.fn(async ({ where, data }: any) => {
      state.stored = { ...state.stored, ...data, id: where.id };
      return state.stored;
    }),
    approvalUpdate: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    approvalUpdateMany: vi.fn(async () => ({ count: 1 })),
    auditCreate: vi.fn(async ({ data }: any) => ({ id: 'AL_1', ...data })),
  };
  const prisma: any = {
    dr013ExceptionRequest: {
      count: vi.fn(async () => 0),
      create: calls.excCreate,
      findFirst: vi.fn(async ({ where }: any) => (
        state.stored && state.stored.exceptionNumber === where.exceptionNumber ? state.stored : null
      )),
      findUnique: vi.fn(async ({ where }: any) => (state.stored && state.stored.id === where.id ? state.stored : null)),
      findMany: vi.fn(async () => opts.exceptions ?? (state.stored ? [state.stored] : [])),
      update: calls.excUpdate,
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (!state.stored || state.stored.id !== where.id || state.stored.status !== where.status || state.stored.deletedAt) return { count: 0 };
        if (where.approvalRequestId !== undefined && state.stored.approvalRequestId !== where.approvalRequestId) return { count: 0 };
        if (where.attachments && JSON.stringify(state.stored.attachments) !== JSON.stringify(where.attachments.equals)) return { count: 0 };
        await calls.excUpdate({ where: { id: where.id }, data });
        return { count: 1 };
      }),
    },
    $queryRaw: vi.fn(async (_query: TemplateStringsArray, id: string) => state.stored?.id === id ? [{ id }] : []),
    sequenceRegister: {
      upsert: vi.fn(async ({ where }: any) => {
        if (seqRows[where.id] === undefined) seqRows[where.id] = 0;
        return { id: where.id };
      }),
      update: vi.fn(async ({ where }: any) => {
        seqRows[where.id] = (seqRows[where.id] ?? 0) + 1;
        return { currentSeq: seqRows[where.id] };
      }),
      findUnique: vi.fn(async () => null),
    },
    voidedNumber: { findUnique: vi.fn(async () => null) },
    approvalRequest: {
      findMany: vi.fn(async () => opts.bypassedApprovals ?? []),
      findUnique: vi.fn(async ({ where }: any) => (opts.approval && opts.approval.id === where.id ? opts.approval : null)),
      update: calls.approvalUpdate,
      updateMany: calls.approvalUpdateMany,
    },
    auditLog: { create: calls.auditCreate },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, calls, state };
}

function makeService(prisma: any, approvalImpl?: (input: any) => Promise<any>) {
  const createBusinessApproval = vi.fn(
    approvalImpl ??
      (async (input: any) => ({
        id: 'ar_1',
        reviewerId: 'u_supervisor',
        status: 'pending',
        ...input,
      })),
  );
  const service = createExceptionService({ prisma, approvalCreateService: { createBusinessApproval } as any });
  return { service, createBusinessApproval };
}

const baseCreateInput = {
  exceptionCategory: 'shipment_release' as const,
  subCategory: 'without_ss_confirmed',
  bypassedApprovalIds: [] as string[],
  exceptionReason: VALID_REASON,
  customerCommitment: '客户电话承诺今日内回复确认邮件',
  riskMitigationPlan: VALID_RISK,
  targetType: 'Shipment',
  targetId: 'SHIP_003',
  action: 'shipment:release',
  validUntil: null,
  responsibleOwnerId: 'u_sales',
  requesterId: 'u_sales',
};

beforeEach(() => vi.clearAllMocks());

// ══════════════════════════════════════════════════════════════════
describe('createExceptionRequest 必填校验（DR013-C3 fail-closed）', () => {
  it('缺 5 必填字段 → 400 MISSING_MANDATORY_EXCEPTION_FIELDS + 缺失清单', async () => {
    const { prisma } = makePrisma();
    const { service } = makeService(prisma);
    const r = await service.createExceptionRequest({
      ...baseCreateInput,
      exceptionReason: '',
      riskMitigationPlan: '',
      targetType: '',
      targetId: '',
      action: '',
      responsibleOwnerId: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(EXCEPTION_ERRORS.MISSING_MANDATORY_EXCEPTION_FIELDS);
      expect(r.error.statusCode).toBe(400);
      expect(r.error.message).toContain('exceptionReason');
      expect(r.error.message).toContain('riskMitigationPlan');
      expect(r.error.message).toContain('targetType');
      expect(r.error.message).toContain('targetId');
      expect(r.error.message).toContain('action');
      expect(r.error.message).toContain('responsibleOwnerId');
    }
  });

  it('reason=29 字 → 400 EXCEPTION_REASON_TOO_SHORT；30 字 → 通过', async () => {
    const { prisma } = makePrisma();
    const { service } = makeService(prisma);
    const short = await service.createExceptionRequest({ ...baseCreateInput, exceptionReason: '客'.repeat(29) });
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.error.code).toBe(EXCEPTION_ERRORS.EXCEPTION_REASON_TOO_SHORT);
      expect(short.error.statusCode).toBe(400);
    }
    const exact = await service.createExceptionRequest({ ...baseCreateInput, exceptionReason: '客'.repeat(30) });
    expect(exact.ok).toBe(true);
  });

  it('非法 exceptionCategory → 400 INVALID_EXCEPTION_CATEGORY', async () => {
    const { prisma } = makePrisma();
    const { service } = makeService(prisma);
    const r = await service.createExceptionRequest({ ...baseCreateInput, exceptionCategory: 'force_bypass' as any });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(EXCEPTION_ERRORS.INVALID_EXCEPTION_CATEGORY);
  });

  it('validUntil 为过去/非法值 → 400 INVALID_VALID_UNTIL（指定时点必须未来）', async () => {
    const { prisma } = makePrisma();
    const { service } = makeService(prisma);
    const past = await service.createExceptionRequest({ ...baseCreateInput, validUntil: '2020-01-01T00:00:00Z' });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.error.code).toBe(EXCEPTION_ERRORS.INVALID_VALID_UNTIL);
    const garbage = await service.createExceptionRequest({ ...baseCreateInput, validUntil: 'not-a-date' });
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.error.code).toBe(EXCEPTION_ERRORS.INVALID_VALID_UNTIL);
  });

  it('maxUses=0 → 400 INVALID_MAX_USES', async () => {
    const { prisma } = makePrisma();
    const { service } = makeService(prisma);
    const r = await service.createExceptionRequest({ ...baseCreateInput, maxUses: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(EXCEPTION_ERRORS.INVALID_MAX_USES);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('createExceptionRequest 审批链（DR-007 统一路由 + P0-15 反链）', () => {
  it('经 createBusinessApproval 创建：actionType=order:dr013-exception + reviewerId 服务端解析回写', async () => {
    const { prisma, calls } = makePrisma();
    const { service, createBusinessApproval } = makeService(prisma);
    const r = await service.createExceptionRequest(baseCreateInput);
    expect(r.ok).toBe(true);

    // 审批单创建入参（DEV-11-A1 第 5 类 actionType；前端不传 reviewerId）
    expect(createBusinessApproval).toHaveBeenCalledTimes(1);
    const approvalInput = createBusinessApproval.mock.calls[0][0];
    expect(approvalInput.actionType).toBe(DR013_ACTION_TYPE);
    expect(approvalInput.actionType).toBe('order:dr013-exception');
    expect(approvalInput.targetType).toBe('Dr013ExceptionRequest');
    expect(approvalInput.requesterId).toBe('u_sales');
    expect(approvalInput.risk).toBe('high');
    expect(approvalInput.clientSuppliedReviewerId).toBeNull();

    // EXC 落库：reviewerId=服务端解析值（u_supervisor），approvalRequestId 回写，status=Pending
    const excData = calls.excCreate.mock.calls[0][0].data;
    expect(excData.reviewerId).toBe('u_supervisor');
    expect(excData.approvalRequestId).toBe('ar_1');
    expect(excData.status).toBe(EXCEPTION_STATUS.PENDING);
    expect(excData.exceptionNumber).toMatch(/^EXC-\d{8}-001$/);
    expect(excData.attachments.scope).toMatchObject({
      targetType: 'Shipment', targetId: 'SHIP_003', action: 'shipment:release',
      validUntil: null, maxUses: 1, usedCount: 0, responsibleOwnerId: 'u_sales',
    });

    // 申请审计（DR013-C4：申请人/审批人/理由/被越过门禁/对象/责任人 全字段）
    const audit = calls.auditCreate.mock.calls.find((c) => c[0].data.action === 'dr013_exception_created');
    expect(audit).toBeTruthy();
    expect(audit![0].data.detail).toMatchObject({
      exceptionCategory: 'shipment_release',
      subCategory: 'without_ss_confirmed',
      responsibleOwnerId: 'u_sales',
      reviewerId: 'u_supervisor',
      approvalRequestId: 'ar_1',
    });
  });

  it('前端越权传 reviewerId → 仅作 clientSuppliedReviewerId 审计标记透传（DEV-11-B4）', async () => {
    const { prisma } = makePrisma();
    const { service, createBusinessApproval } = makeService(prisma);
    const r = await service.createExceptionRequest({ ...baseCreateInput, clientSuppliedReviewerId: 'u_hacker' });
    expect(r.ok).toBe(true);
    expect(createBusinessApproval.mock.calls[0][0].clientSuppliedReviewerId).toBe('u_hacker');
  });

  it('bypassedApprovalIds 全部 rejected → 反链写入 bypassedApprovalId=本EXC审批单（DEV-13-B1）', async () => {
    const { prisma, calls } = makePrisma({
      bypassedApprovals: [
        { id: 'ar_old_1', status: 'rejected' },
        { id: 'ar_old_2', status: 'rejected' },
      ],
    });
    const { service } = makeService(prisma);
    const r = await service.createExceptionRequest({ ...baseCreateInput, bypassedApprovalIds: ['ar_old_1', 'ar_old_2'] });
    expect(r.ok).toBe(true);
    expect(calls.approvalUpdate).toHaveBeenCalledTimes(2);
    expect(calls.approvalUpdate).toHaveBeenCalledWith({ where: { id: 'ar_old_1' }, data: { bypassedApprovalId: 'ar_1' } });
    expect(calls.approvalUpdate).toHaveBeenCalledWith({ where: { id: 'ar_old_2' }, data: { bypassedApprovalId: 'ar_1' } });
  });

  it('bypassedApprovalIds 指向不存在审批单 → 404 BYPASSED_APPROVAL_NOT_FOUND', async () => {
    const { prisma } = makePrisma({ bypassedApprovals: [] });
    const { service } = makeService(prisma);
    const r = await service.createExceptionRequest({ ...baseCreateInput, bypassedApprovalIds: ['ar_ghost'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(EXCEPTION_ERRORS.BYPASSED_APPROVAL_NOT_FOUND);
      expect(r.error.statusCode).toBe(404);
    }
  });

  it('bypassedApprovalIds 指向非 rejected 审批单 → 400 BYPASSED_APPROVAL_NOT_REJECTED', async () => {
    const { prisma } = makePrisma({ bypassedApprovals: [{ id: 'ar_pend', status: 'pending' }] });
    const { service } = makeService(prisma);
    const r = await service.createExceptionRequest({ ...baseCreateInput, bypassedApprovalIds: ['ar_pend'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(EXCEPTION_ERRORS.BYPASSED_APPROVAL_NOT_REJECTED);
      expect(r.error.statusCode).toBe(400);
    }
  });

  it('NO_REVIEWER_RESOLVED → 409 原样透传（fail-closed 不允许 reviewerId=null 落库）', async () => {
    const { prisma, calls } = makePrisma();
    const { service } = makeService(prisma, async () => {
      throw Object.assign(new Error('NO_REVIEWER_RESOLVED: 无任何候选'), { code: 'NO_REVIEWER_RESOLVED' });
    });
    const r = await service.createExceptionRequest(baseCreateInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('NO_REVIEWER_RESOLVED');
      expect(r.error.statusCode).toBe(409);
    }
    expect(calls.excCreate).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('惰性对账 reconcile（approvals decide 不回调本域）', () => {
  it('Pending + 审批 approved → ReviewerApproved + 审计 dr013_exception_approved', async () => {
    const { prisma, calls } = makePrisma({
      approval: { id: 'ar_1', status: 'approved', reviewerId: 'u_supervisor', decisionNote: '同意', bossFinalBypassBy: null },
    });
    const { service } = makeService(prisma);
    const r = await service.getExceptionById('EXC__1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.exception.status).toBe(EXCEPTION_STATUS.REVIEWER_APPROVED);
    const audit = calls.auditCreate.mock.calls.find((c) => c[0].data.action === 'dr013_exception_approved');
    expect(audit).toBeTruthy();
  });

  it('Pending + 审批 approved + bossFinalBypassBy → BossFinalBypass + 三字段镜像（双模型 DEV-13-B4）', async () => {
    const bypassAt = new Date('2026-08-16T12:00:00Z');
    const { prisma } = makePrisma({
      approval: {
        id: 'ar_1', status: 'approved', reviewerId: 'u_supervisor',
        bossFinalBypassBy: 'u_boss', bossFinalBypassAt: bypassAt,
        bossFinalBypassReason: '客户为美国Top5买家，承诺明年三倍订单量，特批放行',
        decisionNote: '[BOSS_FINAL_BYPASS] ...',
      },
    });
    const { service } = makeService(prisma);
    const r = await service.getExceptionById('EXC__1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.exception.status).toBe(EXCEPTION_STATUS.BOSS_FINAL_BYPASS);
      expect(r.data.exception.bossFinalBypassBy).toBe('u_boss');
      expect(r.data.exception.bossFinalBypassReason).toContain('Top5');
    }
  });

  it('Pending + 审批 rejected → ReviewerRejected（未获批准保持原门禁）', async () => {
    const { prisma } = makePrisma({
      approval: { id: 'ar_1', status: 'rejected', reviewerId: 'u_supervisor', decisionNote: '风险过高' },
    });
    const { service } = makeService(prisma);
    const r = await service.getExceptionById('EXC__1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.exception.status).toBe(EXCEPTION_STATUS.REVIEWER_REJECTED);
  });

  it('Pending + 审批仍 pending → 状态不变且不落审计', async () => {
    const { prisma, calls } = makePrisma({ approval: { id: 'ar_1', status: 'pending' } });
    const { service } = makeService(prisma);
    const r = await service.getExceptionById('EXC__1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.exception.status).toBe(EXCEPTION_STATUS.PENDING);
    expect(calls.excUpdate).not.toHaveBeenCalled();
    expect(calls.auditCreate).not.toHaveBeenCalled();
  });

  it('不存在 → 404 EXCEPTION_NOT_FOUND', async () => {
    const { prisma } = makePrisma({ exception: null });
    const { service } = makeService(prisma);
    const r = await service.getExceptionById('EXC__ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.statusCode).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('hasActiveException（其他域门禁消费核心查询）', () => {
  const approvedExc = () => makeExc({ status: EXCEPTION_STATUS.REVIEWER_APPROVED });

  it('生效中 + 对象/动作精确匹配 → active=true + 摘要', async () => {
    const { prisma } = makePrisma({ exceptions: [approvedExc()] });
    const { service } = makeService(prisma);
    const r = await service.hasActiveException({ targetType: 'Shipment', targetId: 'SHIP_003', action: 'shipment:release' });
    expect(r.active).toBe(true);
    expect(r.exception).toMatchObject({
      id: 'EXC__1', exceptionNumber: 'EXC-20260816-001',
      exceptionCategory: 'shipment_release', status: EXCEPTION_STATUS.REVIEWER_APPROVED,
      bossFinalBypass: false, validUntil: null,
    });
  });

  it('action 不匹配 → inactive（指定动作之外不放行）', async () => {
    const { prisma } = makePrisma({ exceptions: [approvedExc()] });
    const { service } = makeService(prisma);
    const r = await service.hasActiveException({ targetType: 'Shipment', targetId: 'SHIP_003', action: 'shipment:book' });
    expect(r.active).toBe(false);
    expect(r.reason).toBe('NO_ACTIVE_EXCEPTION');
  });

  it('targetId 不匹配（同一订单另一出运单）→ inactive（不自动复制，DR013-B2/DEV-13-B3）', async () => {
    const { prisma } = makePrisma({ exceptions: [approvedExc()] });
    const { service } = makeService(prisma);
    const r = await service.hasActiveException({ targetType: 'Shipment', targetId: 'SHIP_004', action: 'shipment:release' });
    expect(r.active).toBe(false);
    expect(r.reason).toBe('NO_ACTIVE_EXCEPTION');
  });

  it('未批准（Pending + 审批仍 pending）→ inactive EXCEPTION_NOT_APPROVED（保持原门禁）', async () => {
    const { prisma } = makePrisma({
      exceptions: [makeExc({ status: EXCEPTION_STATUS.PENDING })],
      approval: { id: 'ar_1', status: 'pending' },
    });
    const { service } = makeService(prisma);
    const r = await service.hasActiveException({ targetType: 'Shipment', targetId: 'SHIP_003', action: 'shipment:release' });
    expect(r.active).toBe(false);
    expect(r.reason).toBe('EXCEPTION_NOT_APPROVED');
  });

  it('validUntil 已过 → inactive EXCEPTION_EXPIRED + 状态惰性落库 Expired + 审计（DR013-B5）', async () => {
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { prisma, calls } = makePrisma({
      exceptions: [makeExc({ status: EXCEPTION_STATUS.REVIEWER_APPROVED, scope: makeScope({ validUntil: past }) })],
    });
    const { service } = makeService(prisma);
    const r = await service.hasActiveException({ targetType: 'Shipment', targetId: 'SHIP_003', action: 'shipment:release' });
    expect(r.active).toBe(false);
    expect(r.reason).toBe('EXCEPTION_EXPIRED');
    const expireUpdate = calls.excUpdate.mock.calls.find((c) => c[0].data?.status === EXCEPTION_STATUS.EXPIRED);
    expect(expireUpdate).toBeTruthy();
    const audit = calls.auditCreate.mock.calls.find((c) => c[0].data.action === 'dr013_exception_expired');
    expect(audit).toBeTruthy();
  });

  it('窗口期内 → active=true（指定时点前有效）', async () => {
    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const { prisma } = makePrisma({
      exceptions: [makeExc({ status: EXCEPTION_STATUS.REVIEWER_APPROVED, scope: makeScope({ validUntil: future }) })],
    });
    const { service } = makeService(prisma);
    const r = await service.hasActiveException({ targetType: 'Shipment', targetId: 'SHIP_003', action: 'shipment:release' });
    expect(r.active).toBe(true);
    expect(r.exception?.validUntil).toBe(future);
  });

  it('已核销完（usedCount>=maxUses）→ inactive EXCEPTION_ALREADY_CONSUMED', async () => {
    const { prisma } = makePrisma({
      exceptions: [makeExc({ status: EXCEPTION_STATUS.CONSUMED, scope: makeScope({ usedCount: 1 }) })],
    });
    const { service } = makeService(prisma);
    const r = await service.hasActiveException({ targetType: 'Shipment', targetId: 'SHIP_003', action: 'shipment:release' });
    expect(r.active).toBe(false);
    expect(r.reason).toBe('EXCEPTION_ALREADY_CONSUMED');
  });

  it('Pending 但审批已批准 → 惰性对账后 active=true（批准即生效链路闭环）', async () => {
    const { prisma } = makePrisma({
      exceptions: [makeExc({ status: EXCEPTION_STATUS.PENDING })],
      approval: { id: 'ar_1', status: 'approved', reviewerId: 'u_supervisor', bossFinalBypassBy: null },
    });
    const { service } = makeService(prisma);
    const r = await service.hasActiveException({ targetType: 'Shipment', targetId: 'SHIP_003', action: 'shipment:release' });
    expect(r.active).toBe(true);
    expect(r.exception?.status).toBe(EXCEPTION_STATUS.REVIEWER_APPROVED);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('consumeException（一次性核销，服务端强制）', () => {
  const consumeInput = {
    exceptionId: 'EXC__1',
    targetType: 'Shipment',
    targetId: 'SHIP_003',
    action: 'shipment:release',
    consumedBy: 'u_sales',
  };

  it('首次核销成功 → usedCount=1 + status=Consumed + 审计 dr013_exception_consumed', async () => {
    const { prisma, calls } = makePrisma({ exception: makeExc({ status: EXCEPTION_STATUS.REVIEWER_APPROVED }) });
    const { service } = makeService(prisma);
    const r = await service.consumeException(consumeInput);
    expect(r.ok).toBe(true);
    const update = calls.excUpdate.mock.calls[0][0];
    expect(update.data.status).toBe(EXCEPTION_STATUS.CONSUMED);
    expect(update.data.attachments.scope.usedCount).toBe(1);
    expect(update.data.attachments.scope.consumptions).toHaveLength(1);
    expect(update.data.attachments.scope.consumptions[0].consumedBy).toBe('u_sales');
    const audit = calls.auditCreate.mock.calls.find((c) => c[0].data.action === 'dr013_exception_consumed');
    expect(audit).toBeTruthy();
  });

  it('第二次核销同一 EXC → 409 EXCEPTION_ALREADY_CONSUMED（DEV-13-B2 一次性）', async () => {
    const { prisma } = makePrisma({
      exception: makeExc({ status: EXCEPTION_STATUS.CONSUMED, scope: makeScope({ usedCount: 1 }) }),
    });
    const { service } = makeService(prisma);
    const r = await service.consumeException(consumeInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(EXCEPTION_ERRORS.EXCEPTION_ALREADY_CONSUMED);
      expect(r.error.statusCode).toBe(409);
    }
  });

  it('其他出运单绑定同一 EXC → 400 EXCEPTION_NOT_FOR_THIS_ENTITY（DEV-13-B2 不复制）', async () => {
    const { prisma } = makePrisma({ exception: makeExc({ status: EXCEPTION_STATUS.REVIEWER_APPROVED }) });
    const { service } = makeService(prisma);
    const r = await service.consumeException({ ...consumeInput, targetId: 'SHIP_004' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(EXCEPTION_ERRORS.EXCEPTION_NOT_FOR_THIS_ENTITY);
      expect(r.error.statusCode).toBe(400);
    }
  });

  it('未批准（Pending）→ 409 EXCEPTION_NOT_ACTIVE（未获批准保持原门禁）', async () => {
    const { prisma } = makePrisma({
      exception: makeExc({ status: EXCEPTION_STATUS.PENDING }),
      approval: { id: 'ar_1', status: 'pending' },
    });
    const { service } = makeService(prisma);
    const r = await service.consumeException(consumeInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(EXCEPTION_ERRORS.EXCEPTION_NOT_ACTIVE);
  });

  it('已过 validUntil → 409 EXCEPTION_EXPIRED + 状态落库 Expired（DR013-B5 服务端校验）', async () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    const { prisma, state } = makePrisma({
      exception: makeExc({ status: EXCEPTION_STATUS.REVIEWER_APPROVED, scope: makeScope({ validUntil: past }) }),
    });
    const { service } = makeService(prisma);
    const r = await service.consumeException(consumeInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(EXCEPTION_ERRORS.EXCEPTION_EXPIRED);
      expect(r.error.statusCode).toBe(409);
    }
    expect(state.stored.status).toBe(EXCEPTION_STATUS.EXPIRED);
  });

  it('不存在 → 404 EXCEPTION_NOT_FOUND', async () => {
    const { prisma } = makePrisma({ exception: null });
    const { service } = makeService(prisma);
    const r = await service.consumeException(consumeInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.statusCode).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('withdrawException（申请人撤回）', () => {
  it('申请人撤回 Pending → Cancelled + 关联审批单级联取消 + 审计', async () => {
    const { prisma, calls } = makePrisma({ approval: { id: 'ar_1', status: 'pending' } });
    const { service } = makeService(prisma);
    const r = await service.withdrawException({ exceptionId: 'EXC__1', actorId: 'u_sales' });
    expect(r.ok).toBe(true);
    expect(calls.excUpdate.mock.calls[0][0].data.status).toBe(EXCEPTION_STATUS.CANCELLED);
    expect(calls.approvalUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ar_1', status: 'pending' },
      data: expect.objectContaining({ status: 'cancelled' }),
    });
    const audit = calls.auditCreate.mock.calls.find((c) => c[0].data.action === 'dr013_exception_withdrawn');
    expect(audit).toBeTruthy();
  });

  it('非申请人撤回 → 403 WITHDRAW_NOT_BY_REQUESTER', async () => {
    const { prisma } = makePrisma({ approval: { id: 'ar_1', status: 'pending' } });
    const { service } = makeService(prisma);
    const r = await service.withdrawException({ exceptionId: 'EXC__1', actorId: 'u_other' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(EXCEPTION_ERRORS.WITHDRAW_NOT_BY_REQUESTER);
      expect(r.error.statusCode).toBe(403);
    }
  });

  it('非 Pending（已批准）→ 409 EXCEPTION_NOT_PENDING', async () => {
    const { prisma } = makePrisma({ exception: makeExc({ status: EXCEPTION_STATUS.REVIEWER_APPROVED }) });
    const { service } = makeService(prisma);
    const r = await service.withdrawException({ exceptionId: 'EXC__1', actorId: 'u_sales' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(EXCEPTION_ERRORS.EXCEPTION_NOT_PENDING);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('bossFinalBypassException（BOSS 最终兜底，双模型写入）', () => {
  const BOSS_REASON = '客户为美国Top5买家且承诺明年三倍订单量及5%单价补偿，综合评估特批放行';

  it('reason=29 字 → 400 BOSS_REASON_TOO_SHORT（DEV-13-B4 fail-closed）', async () => {
    const { prisma } = makePrisma({ approval: { id: 'ar_1', status: 'pending' } });
    const { service } = makeService(prisma);
    const r = await service.bossFinalBypassException({ exceptionId: 'EXC__1', bossId: 'u_boss', reason: '客'.repeat(29) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(EXCEPTION_ERRORS.BOSS_REASON_TOO_SHORT);
      expect(r.error.statusCode).toBe(400);
    }
  });

  it('成功：EXC + ApprovalRequest 双模型写 bossFinalBypass* + 双审计（同事务）', async () => {
    const { prisma, calls } = makePrisma({ approval: { id: 'ar_1', status: 'pending' } });
    const { service } = makeService(prisma);
    const r = await service.bossFinalBypassException({ exceptionId: 'EXC__1', bossId: 'u_boss', reason: BOSS_REASON });
    expect(r.ok).toBe(true);

    // EXC 侧
    const excUpdate = calls.excUpdate.mock.calls[0][0];
    expect(excUpdate.data.status).toBe(EXCEPTION_STATUS.BOSS_FINAL_BYPASS);
    expect(excUpdate.data.bossFinalBypassBy).toBe('u_boss');
    expect(excUpdate.data.bossFinalBypassReason).toBe(BOSS_REASON);
    expect(excUpdate.data.bossFinalBypassAt).toBeInstanceOf(Date);

    // ApprovalRequest 侧（复用 approvalKernelRoute BOSS 兜底语义）
    expect(calls.approvalUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ar_1', status: 'pending' },
      data: expect.objectContaining({
        status: 'approved',
        bossFinalBypassBy: 'u_boss',
        bossFinalBypassReason: BOSS_REASON,
      }),
    });

    // 双审计：审批单侧 boss_final_bypass + EXC 侧 dr013_exception_boss_final_bypass
    const actions = calls.auditCreate.mock.calls.map((c) => `${c[0].data.targetType}:${c[0].data.action}`);
    expect(actions).toContain('ApprovalRequest:boss_final_bypass');
    expect(actions).toContain('Dr013ExceptionRequest:dr013_exception_boss_final_bypass');
  });

  it('非 Pending（已被主管拒绝）→ 409 EXCEPTION_NOT_PENDING（须重新申请新例外单，DEV-13-B4 流程）', async () => {
    const { prisma } = makePrisma({ exception: makeExc({ status: EXCEPTION_STATUS.REVIEWER_REJECTED }) });
    const { service } = makeService(prisma);
    const r = await service.bossFinalBypassException({ exceptionId: 'EXC__1', bossId: 'u_boss', reason: BOSS_REASON });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(EXCEPTION_ERRORS.EXCEPTION_NOT_PENDING);
      expect(r.error.statusCode).toBe(409);
    }
  });

  it('BOSS 兜底批准后 → hasActiveException 生效（下游动作可放行 + bossFinalBypass 徽标）', async () => {
    const { prisma } = makePrisma({
      exceptions: [makeExc({
        status: EXCEPTION_STATUS.BOSS_FINAL_BYPASS,
        bossFinalBypassBy: 'u_boss',
        bossFinalBypassAt: new Date(),
        bossFinalBypassReason: BOSS_REASON,
      })],
    });
    const { service } = makeService(prisma);
    const r = await service.hasActiveException({ targetType: 'Shipment', targetId: 'SHIP_003', action: 'shipment:release' });
    expect(r.active).toBe(true);
    expect(r.exception?.bossFinalBypass).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('toExceptionView（scope/files 解析）', () => {
  it('attachments JSON 展开为 scope + files', () => {
    const view = toExceptionView(makeExc());
    expect(view.scope).toMatchObject({ targetType: 'Shipment', targetId: 'SHIP_003', action: 'shipment:release' });
    expect(view.files).toEqual([]);
  });

  it('无 scope 的脏数据 → scope=null（不抛错）', () => {
    const view = toExceptionView(makeExc({ attachments: { files: [] } }));
    expect(view.scope).toBeNull();
  });
});

/**
 * §9 **B39** · 位置参数内插原文的执行覆盖（R3 / §6 S1）
 *
 * 本批把该文件 4 处 ``fail(CODE, `…事务失败: ${String(e?.message ?? e)}`, 500)`` 换成字面中文。
 * 该文件**本来就有 `logger.error`**（实测 6 处）⇒ **一条都不用补**（D51 的正确读法：按文件实测）。
 *
 * ★ **D52 覆盖面**：这 4 处的 `try` 内**唯一写都是那个 `$transaction`**，之后只有 `return`（含上面各处的
 *   `logger.info/warn`）⇒ 四处**都可以**承诺「本次未确认任何改动」。下面四条逐一钉住。
 *
 * 出口链已核：`exceptionRoute.ts:68` 的 `sendServiceError` 用
 * `res.status(error.statusCode).json({ error: error.code, message: error.message })` **原样**转发
 * ⇒ 服务层文案就是用户看到的东西。（另有 Agent 工具与 `creditExceptionGate` 两个内部消费方。）
 */
const B39_RAW = 'PrismaClientKnownRequestError: Invalid `prisma.$transaction()` invocation in '
  + '/srv/app/server/src/exceptions/exceptionService.ts:463 — '
  + 'Unique constraint failed on the fields: (`exceptionNumber`)';
const B39_FRAGMENTS = ['PrismaClient', 'prisma.$transaction', 'exceptionService.ts:463', 'Unique constraint', '/srv/app', 'P2002'];

/**
 * ⚠️ allowlist（**D52** 的判据例外，这是第二次遇到）：`零拉丁词` 只是"原文上屏"的**启发式指纹**，
 * **业务术语是例外** —— 本仓把 BOSS 最终兜底特批叫 `bossFinalBypassException` / `BOSS_REASON`，
 * 「BOSS 兜底特批」是**用户会看到的业务词**，不是内部原文。不许为了过断言把它删掉
 * （那会把"清泄漏"做成"降可用性"）。第一次同类例外是 7c 的 `.xlsx` / `.csv`。
 */
const LATIN_ALLOWLIST = ['boss'];

function expectB39Copy(msg: unknown, mustMention: string) {
  expect(typeof msg).toBe('string');
  const s = msg as string;
  expect(s.length, `文案过短（${s.length} 字）：${s}`).toBeGreaterThanOrEqual(20);
  expect(s, '必须含中文').toMatch(/[\u4e00-\u9fa5]/);
  expect(s, `必须说清对象：${s}`).toContain(mustMention);
  expect(s, `必须给下一步：${s}`).toMatch(/(稍后重试|联系管理员)/);
  const latin = (s.match(/[A-Za-z]{3,}/g) ?? []).filter((t: string) => !LATIN_ALLOWLIST.includes(t.toLowerCase()));
  expect(latin, `混入其它拉丁词（疑似原文上屏）：${JSON.stringify(latin)}`).toEqual([]);
  expect(s, '唯一写是 $transaction ⇒ 可以承诺零改动').toContain('本次未确认任何改动');
}

describe('§9 B39 · 例外域四处出口：内部原文不上屏', () => {
  const BOSS_REASON = '客户为美国Top5买家且承诺明年三倍订单量及5%单价补偿，综合评估特批放行';

  function withFailingTx(prisma: any) {
    prisma.$transaction = async () => { throw new Error(B39_RAW); };
    return prisma;
  }

  const CASES: Array<{ name: string; mention: string; code: string; seed: any; run: (svc: any) => Promise<any> }> = [
    {
      // ⚠️ 这四个码**不在 `EXCEPTION_ERRORS` 注册表里**（服务里是裸字面量）—— 与 **B29「半收敛」同型**，
      // 本批按现状用字面量断言，**不顺手登记**（改注册表属对外契约，要单独评估）。
      name: 'createExceptionRequest', mention: '例外申请创建', code: 'EXCEPTION_CREATE_FAILED',
      seed: {}, run: (svc) => svc.createExceptionRequest(baseCreateInput),
    },
    {
      name: 'consumeException', mention: '例外核销', code: 'EXCEPTION_CONSUME_FAILED',
      seed: { exception: makeExc({ status: EXCEPTION_STATUS.REVIEWER_APPROVED }) },
      run: (svc) => svc.consumeException({ exceptionId: 'EXC__1', targetType: 'Shipment', targetId: 'SHIP_003', action: 'shipment:release', consumedBy: 'u_sales' }),
    },
    {
      name: 'withdrawException', mention: '撤回', code: 'EXCEPTION_WITHDRAW_FAILED',
      seed: { approval: { id: 'ar_1', status: 'pending' } },
      run: (svc) => svc.withdrawException({ exceptionId: 'EXC__1', actorId: 'u_sales' }),
    },
    {
      name: 'bossFinalBypassException', mention: 'BOSS 兜底特批', code: 'EXCEPTION_BOSS_BYPASS_FAILED',
      seed: { approval: { id: 'ar_1', status: 'pending' } },
      run: (svc) => svc.bossFinalBypassException({ exceptionId: 'EXC__1', bossId: 'u_boss', reason: BOSS_REASON }),
    },
  ];

  for (const c of CASES) {
    it(`★ ${c.name}：500 + 码名不变 + 中文 + 零原文 + 承诺零改动`, async () => {
      const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
      const { prisma } = makePrisma(c.seed);
      const { service } = makeService(withFailingTx(prisma));
      const r = await c.run(service);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code, `${c.name} 码名不得随文案一起改`).toBe(c.code);
      const raw = JSON.stringify(r.error);
      for (const frag of B39_FRAGMENTS) expect(raw, `${c.name} 泄漏了「${frag}」`).not.toContain(frag);
      expectB39Copy(r.error.message, c.mention);
      expect(spy, `${c.name} 原文必须仍进日志`).toHaveBeenCalledWith(
        expect.stringContaining('[Exceptions]'), expect.objectContaining({ error: B39_RAW }));
      spy.mockRestore();
    });
  }
});
