import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createOrderChangeRequestService } from '../orderChangeRequestService';

/**
 * P0-003 回归测试：审批决策 → 变更申请状态同步 → apply 生效 全链路
 *
 * 缺陷背景：审批单 approved 后 OrderChangeRequest 永久停留 Pending（无任何代码同步），
 * apply 恒 409，所有订单变更（取消/暂停/交期/数量/价格/客户/产品）审批通过后无法生效。
 * 既有单测直接造 status:'Approved' 数据绕过同步环节，故全绿但链路断。
 *
 * 修复：syncFromApprovalDecision（approved → Approved；rejected → Rejected + 订单状态恢复），
 * 由 approvalRoute onDecided 钩子调用。本文件按真实链路（Pending 起步）验证。
 */

function makePrisma(opts: {
  order?: any;
  changeRequest?: any;
  cancelTransition?: { fromStatus: string; toStatus: string } | null;
  committedPoCount?: number;
  startedStageCount?: number;
  invoiceCount?: number;
} = {}) {
  const order = opts.order ?? {
    id: 'ORD__1', status: 'CancelRequested', deletedAt: null,
    quantity: 200, totalNet: 10000, dueDate: '2026-10-05',
    customer: 'ABC 贸易', customerRelationId: 'REL_A',
    poNumber: 'PO-2026-001',
    salesContractNumber: 'SC-1', finalContractNumber: null,
    createdAt: BigInt(0), updatedAt: BigInt(0),
  };
  // 变更申请默认 Pending（真实链路起点——不造 Approved）
  const changeRequest = opts.changeRequest ?? {
    id: 'OCR_1', orderId: order.id, requestNumber: 'OCR-20260820-001',
    status: 'Pending', deletedAt: null,
    changeTypes: ['other'],
    beforeSnapshot: { status: 'Production' }, afterDelta: { status: 'Cancelled' },
    approvalRequestId: 'ar_1', requesterId: 'u_sales', reviewerId: 'u_boss',
    attachments: null, appliedAt: null, appliedBy: null,
    createdAt: new Date(), updatedAt: new Date(),
  };

  const state = { order: { ...order }, changeRequest: { ...changeRequest } };
  const calls = {
    crUpdate: vi.fn(async ({ where, data }: any) => {
      if (state.changeRequest.id === where.id) Object.assign(state.changeRequest, data);
      return { ...state.changeRequest };
    }),
    orderUpdate: vi.fn(async ({ where, data }: any) => {
      if (state.order.id === where.id) Object.assign(state.order, data);
      return { ...state.order };
    }),
    transitionCreate: vi.fn(async () => ({})),
    auditCreate: vi.fn(async () => ({ id: 'AL-1' })),
  };

  const prisma: any = {
    order: {
      findUnique: vi.fn(async ({ where }: any) => (where.id === state.order.id ? state.order : null)),
      update: calls.orderUpdate,
      findMany: vi.fn(async () => []),
    },
    orderChangeRequest: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.approvalRequestId === state.changeRequest.approvalRequestId ? state.changeRequest : null),
      findUnique: vi.fn(async ({ where }: any) => (where.id === state.changeRequest.id ? state.changeRequest : null)),
      update: calls.crUpdate,
      create: vi.fn(async ({ data }: any) => ({ ...data })),
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    },
    orderStatusTransition: {
      create: calls.transitionCreate,
      findFirst: vi.fn(async () => opts.cancelTransition === undefined
        ? { fromStatus: 'Production', toStatus: 'CancelRequested' }
        : opts.cancelTransition),
    },
    approvalRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    auditLog: { create: calls.auditCreate },
    purchaseOrder: { count: vi.fn(async () => opts.committedPoCount ?? 0) },
    developmentCase: { findMany: vi.fn(async () => []) },
    productionStage: { count: vi.fn(async () => opts.startedStageCount ?? 0) },
    invoice: { count: vi.fn(async () => opts.invoiceCount ?? 0) },
    paymentVoucher: { count: vi.fn(async () => 0) },
    inventoryItem: { count: vi.fn(async () => 0) },
    creditLimit: { findFirst: vi.fn(async () => null), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
    creditLimitHistory: { create: vi.fn(async () => ({})) },
    preCutChecklist: { updateMany: vi.fn(async () => ({ count: 1 })) },
    entityReference: { upsert: vi.fn(async () => ({})) },
    entityLink: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, calls, state };
}

function makeService(prisma: any) {
  return createOrderChangeRequestService({
    prisma,
    approvalCreateService: {
      createBusinessApproval: vi.fn(async (input: any) => ({ id: 'ar_1', reviewerId: 'u_boss', ...input })),
    } as any,
  });
}

beforeEach(() => vi.clearAllMocks());

describe('P0-003 回归：审批 approved → 同步 Approved → apply 生效（真实链路）', () => {
  it('审批通过同步：Pending → Approved（订单保持 CancelRequested，两段式）', async () => {
    const { prisma, state } = makePrisma();
    const service = makeService(prisma);

    const r = await service.syncFromApprovalDecision({
      approvalRequestId: 'ar_1', decision: 'approved', actorId: 'u_boss',
    });
    expect(r.ok).toBe(true);
    expect(state.changeRequest.status).toBe('Approved');
    // approved 只同步状态，不动订单（apply 才生效）
    expect(state.order.status).toBe('CancelRequested');
  });

  it('同步后 apply：取消 + 有不可逆承诺（已开票）→ Closing', async () => {
    // hasIrreversibleCommitments 判定：committedPO>0 || startedStage>0 || invoice>0 || voucher>0
    const { prisma, state } = makePrisma({ invoiceCount: 1 });
    const service = makeService(prisma);

    await service.syncFromApprovalDecision({ approvalRequestId: 'ar_1', decision: 'approved', actorId: 'u_boss' });
    const applied = await service.applyChangeRequest({ changeRequestId: 'OCR_1', appliedBy: 'u_sales' });

    expect(applied.ok).toBe(true);
    expect(state.changeRequest.status).toBe('Applied');
    expect(state.order.status).toBe('Closing');
  });

  it('同步后 apply：取消 + 无不可逆承诺 → 直接 Cancelled', async () => {
    const { prisma, state } = makePrisma({
      order: {
        id: 'ORD__1', status: 'CancelRequested', deletedAt: null,
        poNumber: 'PO-1', salesContractNumber: null, finalContractNumber: null,
        createdAt: BigInt(0), updatedAt: BigInt(0),
      },
      invoiceCount: 0,
    });
    const service = makeService(prisma);

    await service.syncFromApprovalDecision({ approvalRequestId: 'ar_1', decision: 'approved', actorId: 'u_boss' });
    const applied = await service.applyChangeRequest({ changeRequestId: 'OCR_1', appliedBy: 'u_sales' });

    expect(applied.ok).toBe(true);
    expect(state.order.status).toBe('Cancelled');
  });
});

describe('P0-003 回归：审批 rejected → 同步 Rejected + 订单恢复', () => {
  it('驳回取消：CR → Rejected，订单 CancelRequested → 恢复申请前状态（时间线回查 Production）', async () => {
    const { prisma, state } = makePrisma();
    const service = makeService(prisma);

    const r = await service.syncFromApprovalDecision({
      approvalRequestId: 'ar_1', decision: 'rejected', decisionNote: '客户仅是付款延迟，不许取消', actorId: 'u_boss',
    });
    expect(r.ok).toBe(true);
    expect(state.changeRequest.status).toBe('Rejected');
    expect(state.order.status).toBe('Production');
  });

  it('驳回时订单不在 CancelRequested/PauseRequested → 仅 CR 置 Rejected，订单不动', async () => {
    const { prisma, state } = makePrisma({
      order: { id: 'ORD__1', status: 'Production', deletedAt: null, createdAt: BigInt(0), updatedAt: BigInt(0) },
    });
    const service = makeService(prisma);

    const r = await service.syncFromApprovalDecision({ approvalRequestId: 'ar_1', decision: 'rejected', actorId: 'u_boss' });
    expect(r.ok).toBe(true);
    expect(state.changeRequest.status).toBe('Rejected');
    expect(state.order.status).toBe('Production');
  });
});

describe('P0-003 回归：幂等与非关联审批', () => {
  it('CR 非 Pending（已 Approved）→ 同步跳过，不重复变更', async () => {
    const { prisma, state } = makePrisma();
    state.changeRequest.status = 'Approved';
    const service = makeService(prisma);

    const r = await service.syncFromApprovalDecision({ approvalRequestId: 'ar_1', decision: 'approved', actorId: 'u_boss' });
    expect(r.ok).toBe(true);
    expect(state.changeRequest.status).toBe('Approved'); // 未变
  });

  it('approvalRequestId 无关联 CR（非 OrderChangeRequest 类审批）→ 静默成功', async () => {
    const { prisma } = makePrisma();
    prisma.orderChangeRequest.findFirst = vi.fn(async () => null);
    const service = makeService(prisma);

    const r = await service.syncFromApprovalDecision({ approvalRequestId: 'ar_other', decision: 'approved', actorId: 'u_boss' });
    expect(r.ok).toBe(true);
  });

  it('未同步直接 apply 仍被拒（CHANGE_REQUEST_NOT_APPROVED，fail-closed 保持）', async () => {
    const { prisma } = makePrisma();
    const service = makeService(prisma);

    const r = await service.applyChangeRequest({ changeRequestId: 'OCR_1', appliedBy: 'u_sales' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CHANGE_REQUEST_NOT_APPROVED');
  });
});
