/**
 * REQ2-01 色差管理体系回归测试（设计文档 §9 验收场景）
 *
 * 覆盖：
 *   1. 登记校验（两态挂载互斥/缸号必填/评级 1-5/疵点枚举/供应商存在性）+ roundNo 快照
 *   2. 客户判定状态机（pending→三态 / needs_recast→approved / 终态拒绝 / asSealed 仅 approved）
 *   3. 封样基准唯一切换（新基准置位 → 同 scope 旧基准 updateMany 让位）
 *   4. 质量分联动（recordAutoEvaluation 评级→分数映射 + 幂等由 factorySvc 保证）
 *   5. 取证聚合（sealedBasis / summary 统计 / 二选一 scope 校验）
 *   6. 软删
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const recordAutoEvaluationMock = vi.fn().mockResolvedValue({ recorded: true, evaluationId: 'FAEV__1' });
vi.mock('../../suppliers/factoryService', () => ({
  createFactoryService: vi.fn(() => ({ recordAutoEvaluation: recordAutoEvaluationMock })),
}));
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createColorBatchService, RATING_TO_SCORE } from '../colorBatchService';

const ACTOR = 'user_sales';

function makeBatch(overrides: any = {}) {
  return {
    id: 'SCB__X1',
    batchCode: 'SCB-20260820-001',
    stage: 'lab_dip',
    developmentCaseId: 'DEV-1',
    roundNo: 2,
    orderId: null,
    dyeLotNo: '缸A-101',
    batchNo: null,
    rollNos: [],
    colorRating: 3,
    sideDiff: null,
    endDiff: null,
    defectCauses: ['red_cast'],
    customerStatus: 'pending',
    approvedAsSealed: false,
    customerFeedbackNote: null,
    customerFeedbackDate: null,
    supplierRelationId: 'DEMO-MILL-JINHUA',
    supplierName: '金华常青纺织厂',
    photos: null,
    notes: null,
    createdAt: BigInt(1),
    updatedAt: BigInt(1),
    deletedAt: null,
    ...overrides,
  };
}

function makePrisma(overrides: {
  batches?: any[];
  devCase?: any;
  order?: any;
  relation?: any;
} = {}) {
  const batches = overrides.batches ?? [];
  const captured: { tx?: any } = {};
  const prisma = {
    developmentCase: { findFirst: vi.fn().mockImplementation(async (args: any) => {
      if (args?.where?.id === '__NONE__') return null;
      return overrides.devCase ?? { id: 'DEV-1', code: 'DEV-2026-001', name: '演示开发案', customerName: 'Peerless', currentRound: 2, deletedAt: null };
    }) },
    order: { findFirst: vi.fn().mockImplementation(async (args: any) => {
      if (args?.where?.id === '__NONE__') return null;
      return overrides.order ?? { id: 'PO-1', poNumber: 'DEMO-PO-2601007', customer: 'Peerless', deletedAt: null };
    }) },
    relation: { findFirst: vi.fn().mockImplementation(async (args: any) => {
      if (args?.where?.id === '__NONE__') return null;
      return overrides.relation ?? { id: 'DEMO-MILL-JINHUA', name: '金华常青纺织厂', deletedAt: null };
    }) },
    sampleColorBatch: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...makeBatch(), ...data })),
      findFirst: vi.fn().mockImplementation(async (args: any) => {
        const id = args?.where?.id;
        return batches.find(b => b.id === id && b.deletedAt === null) ?? null;
      }),
      findMany: vi.fn().mockResolvedValue(batches),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...(batches.find(b => b.id === where.id) ?? makeBatch()), ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(async (fn: any) => {
      const tx = { sampleColorBatch: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...(batches.find(b => b.id === where.id) ?? makeBatch()), ...data })),
      } };
      captured.tx = tx;
      return fn(tx);
    }),
    _capturedTx: () => captured.tx,
  } as any;
  return prisma;
}

beforeEach(() => { vi.clearAllMocks(); });

// ══════════════ 1. 登记 ══════════════

describe('createColorBatch 登记', () => {
  it('lab_dip 登记成功：roundNo 快照 currentRound + 业务号 SCB- 前缀', async () => {
    const prisma = makePrisma();
    const svc = createColorBatchService(prisma);
    const r = await svc.createColorBatch({ stage: 'lab_dip', developmentCaseId: 'DEV-1', dyeLotNo: '缸A-101', colorRating: 3, defectCauses: ['red_cast'], supplierRelationId: 'DEMO-MILL-JINHUA' }, ACTOR);
    expect(r.ok).toBe(true);
    const data = prisma.sampleColorBatch.create.mock.calls[0][0].data;
    expect(data.roundNo).toBe(2);
    expect(data.batchCode).toMatch(/^SCB-\d{8}-\d{3}$/);
    expect(data.customerStatus).toBe('pending');
  });

  it('bulk 登记成功：挂 orderId，roundNo null', async () => {
    const prisma = makePrisma();
    const svc = createColorBatchService(prisma);
    const r = await svc.createColorBatch({ stage: 'bulk', orderId: 'PO-1', dyeLotNo: '缸B-01', colorRating: 4 }, ACTOR);
    expect(r.ok).toBe(true);
    const data = prisma.sampleColorBatch.create.mock.calls[0][0].data;
    expect(data.orderId).toBe('PO-1');
    expect(data.roundNo).toBeNull();
  });

  it('缸号缺失 → DYE_LOT_REQUIRED', async () => {
    const r = await createColorBatchService(makePrisma()).createColorBatch({ stage: 'lab_dip', developmentCaseId: 'DEV-1', colorRating: 3 }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DYE_LOT_REQUIRED');
  });

  it('评级越界（0/6）→ INVALID_RATING', async () => {
    const svc = createColorBatchService(makePrisma());
    for (const bad of [0, 6, 3.5]) {
      const r = await svc.createColorBatch({ stage: 'lab_dip', developmentCaseId: 'DEV-1', dyeLotNo: 'X', colorRating: bad }, ACTOR);
      expect(r.ok).toBe(false);
    }
  });

  it('疵点原因非法枚举 → INVALID_DEFECT_CAUSES', async () => {
    const r = await createColorBatchService(makePrisma()).createColorBatch({ stage: 'lab_dip', developmentCaseId: 'DEV-1', dyeLotNo: 'X', colorRating: 3, defectCauses: ['green_cast'] }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_DEFECT_CAUSES');
  });

  it('lab_dip 缺开发案 → SCOPE_REQUIRED；bulk 挂开发案 → SCOPE_CONFLICT', async () => {
    const svc = createColorBatchService(makePrisma());
    const r1 = await svc.createColorBatch({ stage: 'lab_dip', dyeLotNo: 'X', colorRating: 3 }, ACTOR);
    expect(r1.ok).toBe(false);
    const r2 = await svc.createColorBatch({ stage: 'bulk', orderId: 'PO-1', developmentCaseId: 'DEV-1', dyeLotNo: 'X', colorRating: 3 }, ACTOR);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('SCOPE_CONFLICT');
  });

  it('开发案/供应商不存在 → fail-closed', async () => {
    const svc = createColorBatchService(makePrisma());
    const r1 = await svc.createColorBatch({ stage: 'lab_dip', developmentCaseId: '__NONE__', dyeLotNo: 'X', colorRating: 3 }, ACTOR);
    expect(r1.ok).toBe(false);
    const r2 = await svc.createColorBatch({ stage: 'lab_dip', developmentCaseId: 'DEV-1', dyeLotNo: 'X', colorRating: 3, supplierRelationId: '__NONE__' }, ACTOR);
    expect(r2.ok).toBe(false);
  });
});

// ══════════════ 2. 客户判定 ══════════════

describe('recordCustomerFeedback 客户判定', () => {
  it('pending → needs_recast：质量分联动（评级 3 → 70 分，note 含疵点与缸号）', async () => {
    const prisma = makePrisma({ batches: [makeBatch()] });
    const svc = createColorBatchService(prisma);
    const r = await svc.recordCustomerFeedback('SCB__X1', { status: 'needs_recast' }, ACTOR);
    expect(r.ok).toBe(true);
    expect(recordAutoEvaluationMock).toHaveBeenCalledTimes(1);
    const call = recordAutoEvaluationMock.mock.calls[0][0];
    expect(call.score).toBe(70);
    expect(call.sourceType).toBe('color_batch');
    expect(call.sourceId).toBe('SCB__X1');
    expect(call.note).toContain('色差评级3级');
    expect(call.note).toContain('偏红');
    expect(call.note).toContain('缸A-101');
  });

  it('pending → approved + asSealed：同 scope 旧基准 updateMany 让位', async () => {
    const prisma = makePrisma({ batches: [makeBatch({ id: 'SCB__X1', customerStatus: 'pending' })] });
    const svc = createColorBatchService(prisma);
    const r = await svc.recordCustomerFeedback('SCB__X1', { status: 'approved', asSealed: true }, ACTOR);
    expect(r.ok).toBe(true);
    const tx = prisma._capturedTx();
    expect(tx.sampleColorBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ developmentCaseId: 'DEV-1', approvedAsSealed: true, id: { not: 'SCB__X1' } }),
    }));
  });

  it('asSealed 搭配 rejected → SEALED_REQUIRES_APPROVED', async () => {
    const r = await createColorBatchService(makePrisma({ batches: [makeBatch()] })).recordCustomerFeedback('SCB__X1', { status: 'rejected', asSealed: true }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SEALED_REQUIRES_APPROVED');
  });

  it('approved 终态再判定 → INVALID_TRANSITION', async () => {
    const r = await createColorBatchService(makePrisma({ batches: [makeBatch({ customerStatus: 'approved' })] })).recordCustomerFeedback('SCB__X1', { status: 'needs_recast' }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_TRANSITION');
  });

  it('needs_recast → approved（客户回心转意）合法', async () => {
    const r = await createColorBatchService(makePrisma({ batches: [makeBatch({ customerStatus: 'needs_recast' })] })).recordCustomerFeedback('SCB__X1', { status: 'approved' }, ACTOR);
    expect(r.ok).toBe(true);
  });

  it('质量分联动失败不阻断判定（best-effort）', async () => {
    recordAutoEvaluationMock.mockRejectedValueOnce(new Error('DB_DOWN'));
    const r = await createColorBatchService(makePrisma({ batches: [makeBatch()] })).recordCustomerFeedback('SCB__X1', { status: 'rejected' }, ACTOR);
    expect(r.ok).toBe(true);
    expect((r.data as any).qualityScoreLinked).toBe(false);
  });

  it('评级→分数映射表全档（5/4/3/2/1 → 95/85/70/50/30）', () => {
    expect(RATING_TO_SCORE).toEqual({ 5: 95, 4: 85, 3: 70, 2: 50, 1: 30 });
  });
});

// ══════════════ 3. 取证聚合 ══════════════

describe('getColorBatchEvidence 取证聚合', () => {
  it('聚合 sealedBasis + summary 统计', async () => {
    const batches = [
      makeBatch({ id: 'B1', customerStatus: 'approved', approvedAsSealed: true, defectCauses: [] }),
      makeBatch({ id: 'B2', customerStatus: 'needs_recast', defectCauses: ['red_cast'] }),
      makeBatch({ id: 'B3', customerStatus: 'needs_recast', defectCauses: ['red_cast', 'lighter'] }),
    ];
    const r = await createColorBatchService(makePrisma({ batches })).getColorBatchEvidence({ developmentCaseId: 'DEV-1' });
    expect(r.ok).toBe(true);
    const d = (r.data as any).evidence;
    expect(d.sealedBasis.id).toBe('B1');
    expect(d.summary).toEqual({ total: 3, approved: 1, rejected: 0, needsRecast: 2, pending: 0, defectCauseCount: { red_cast: 2, lighter: 1 } });
    expect(d.scope.caseCode).toBe('DEV-2026-001');
  });

  it('不传 scope → SCOPE_REQUIRED；双传 → SCOPE_CONFLICT', async () => {
    const svc = createColorBatchService(makePrisma());
    const r1 = await svc.getColorBatchEvidence({});
    expect(r1.ok).toBe(false);
    const r2 = await svc.getColorBatchEvidence({ developmentCaseId: 'DEV-1', orderId: 'PO-1' });
    expect(r2.ok).toBe(false);
  });
});

// ══════════════ 4. 更新与软删 ══════════════

describe('update / delete', () => {
  it('更新白名单生效（评级修正）', async () => {
    const r = await createColorBatchService(makePrisma({ batches: [makeBatch()] })).updateColorBatch('SCB__X1', { colorRating: 2, notes: '复查降级' });
    expect(r.ok).toBe(true);
  });

  it('软删已删/不存在 → NOT_FOUND', async () => {
    const r = await createColorBatchService(makePrisma()).deleteColorBatch('SCB__GONE', ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });
});
