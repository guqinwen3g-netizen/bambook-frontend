import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createBOMService, CreateBOMInput } from '../bomService';
import { businessEventBus } from '../../events/businessEventBus';

/**
 * task ERP-P2-bom-service-foundation:
 * 覆盖 bomService 的 BOM CRUD + 状态转换 + 成本计算 + 审计 + 事件发布 + fail-closed 契约。
 *
 * 设计：
 *   - 用 $transaction: (fn) => fn(tx) 透明穿透模式，验证 audit reject → 事务回滚
 *   - 所有 mutation 都在事务内写 auditLog，audit reject 必须回滚业务操作
 *   - confirmBOM 在事务提交后 publish BOMConfirmed 事件（fire-and-forget）
 *   - recalculateCost 在事务提交后 publish BOMCostCalculated 事件（fire-and-forget）
 *   - 状态转换严格校验：Draft→Confirmed→Archived，非法转换抛错
 *   - 仅 Draft 可编辑/删除/重新计算，fail-closed
 *   - 成本计算：effectiveQty = qty * (1 + wastage%)；amount = effectiveQty * unitCost
 *   - 成本汇总：totalMaterialCost = 行金额合计 + CostEstimate(Material)
 *               totalLaborCost = CostEstimate(Labor)
 *               totalOverheadCost = CostEstimate(Overhead) + CostEstimate(Other)
 *               totalCost = 物料 + 人工 + 费用
 *   - 利润：profitAmount = sellingPrice - totalCost；profitMargin = profitAmount / sellingPrice * 100
 */

// ── Mock businessEventBus.publish（fire-and-forget，但需验证调用契约） ──
const publishSpy = vi.spyOn(businessEventBus, 'publish').mockResolvedValue(undefined);

// ── 工厂：构造 mock prisma + tx ──
function makePrisma(opts: {
  existingBOM?: any;
  existingBOMDetail?: any; // 含 lines + costEstimates
  auditFail?: boolean;
  bomCreateFail?: boolean;
  bomUpdateFail?: boolean;
  bomNumberExists?: boolean;
} = {}) {
  const existingBOM = opts.existingBOM ?? null;
  const existingDetail = opts.existingBOMDetail ?? null;

  // BOM
  const bomFindUnique = vi.fn().mockImplementation(async ({ where, include }: any) => {
    if (where.id === existingBOM?.id) {
      if (include) return existingDetail ?? existingBOM;
      return existingBOM;
    }
    if (where.bomNumber && opts.bomNumberExists) return existingBOM;
    return null;
  });
  const bomFindMany = vi.fn().mockResolvedValue(existingBOM ? [existingBOM] : []);
  const bomCount = vi.fn().mockResolvedValue(existingBOM ? 1 : 0);
  const bomCreate = opts.bomCreateFail
    ? vi.fn().mockRejectedValue(new Error('BOM_CREATE_BOOM'))
    : vi.fn().mockImplementation(async ({ data, include }: any) => ({
        ...data,
        lines: [],
        costEstimates: [],
      }));
  const bomUpdate = opts.bomUpdateFail
    ? vi.fn().mockRejectedValue(new Error('BOM_UPDATE_BOOM'))
    : vi.fn().mockImplementation(async ({ where, data, include }: any) => ({
        ...existingBOM,
        ...data,
        id: where.id,
        lines: existingDetail?.lines ?? [],
        costEstimates: existingDetail?.costEstimates ?? [],
      }));

  // BOMLine
  const bomLineCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const bomLineDeleteMany = vi.fn().mockResolvedValue({ count: 0 });

  // CostEstimate
  const costEstimateCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const costEstimateDeleteMany = vi.fn().mockResolvedValue({ count: 0 });

  // Audit
  const auditCreate = opts.auditFail
    ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT'))
    : vi.fn().mockResolvedValue({ id: 'AL-1' });

  const tx: any = {
    bOM: {
      create: bomCreate,
      update: bomUpdate,
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.id === existingBOM?.id) return existingDetail ?? existingBOM;
        return null;
      }),
    },
    bOMLine: {
      createMany: bomLineCreateMany,
      deleteMany: bomLineDeleteMany,
    },
    costEstimate: {
      createMany: costEstimateCreateMany,
      deleteMany: costEstimateDeleteMany,
    },
    auditLog: { create: auditCreate },
    // EntityLink 图谱（D1.1a）：sync/deactivate 走 tx 内 upsert/findMany/update
    entityReference: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    entityLink: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };

  const prisma: any = {
    bOM: {
      findUnique: bomFindUnique,
      findMany: bomFindMany,
      count: bomCount,
    },
    $transaction: vi.fn().mockImplementation(async (fn: any) => fn(tx)),
  };

  return { prisma, tx, mocks: { bomCreate, bomUpdate, bomFindUnique, bomFindMany, bomCount, bomLineCreateMany, bomLineDeleteMany, costEstimateCreateMany, costEstimateDeleteMany, auditCreate } };
}

function makeLineInput(overrides: any = {}) {
  return {
    materialType: 'Main',
    materialCode: 'FAB-001',
    description: '主面料 牛津布',
    category: 'Fabric',
    specification: '150D',
    quantity: 100,
    unit: 'YD',
    wastagePercent: 5,
    unitCost: 12.5,
    ...overrides,
  };
}

function makeCostInput(overrides: any = {}) {
  return {
    costType: 'Labor',
    description: '裁剪人工',
    amount: 500,
    ...overrides,
  };
}

function makeCreateInput(overrides: any = {}): CreateBOMInput {
  return {
    bomNumber: 'BOM-20260807-001',
    description: '测试 BOM',
    lines: [makeLineInput()],
    ...overrides,
  };
}

function makeExistingBOM(overrides: any = {}) {
  return {
    id: 'BOM_test1',
    bomNumber: 'BOM-20260807-001',
    status: 'Draft',
    description: '测试 BOM',
    productAssetId: null,
    orderId: null,
    quotationId: null,
    version: 1,
    parentBomId: null,
    totalMaterialCost: 1312.5,
    totalLaborCost: 0,
    totalOverheadCost: 0,
    totalCost: 1312.5,
    currency: 'CNY',
    sellingPrice: null,
    profitMargin: null,
    profitAmount: null,
    notes: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  publishSpy.mockClear();
});

// ════════════════════════════════════════════════════════════
// createBOM
// ════════════════════════════════════════════════════════════

describe('bomService: createBOM', () => {
  it('成功创建 → 事务内 create BOM + createMany lines + audit', async () => {
    const { prisma, tx, mocks } = makePrisma();
    const service = createBOMService(prisma);

    const input = makeCreateInput({
      lines: [makeLineInput({ quantity: 100, unitCost: 12.5, wastagePercent: 5 })],
    });

    await service.createBOM(input, 'user-1');

    expect(mocks.bomCreate).toHaveBeenCalledTimes(1);
    expect(mocks.bomLineCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);

    // 验证 BOM 数据
    const bomData = mocks.bomCreate.mock.calls[0][0].data;
    expect(bomData.bomNumber).toBe('BOM-20260807-001');
    expect(bomData.status).toBe('Draft');
    expect(bomData.version).toBe(1);
    // effectiveQty = 100 * (1 + 5%) = 105; amount = 105 * 12.5 = 1312.5
    expect(Number(bomData.totalMaterialCost)).toBe(1312.5);
    expect(Number(bomData.totalCost)).toBe(1312.5);
  });

  it('含成本估算项 → createMany costEstimates 被调用', async () => {
    const { prisma, mocks } = makePrisma();
    const service = createBOMService(prisma);

    const input = makeCreateInput({
      costEstimates: [
        makeCostInput({ costType: 'Labor', amount: 500 }),
        makeCostInput({ costType: 'Overhead', amount: 200 }),
      ],
    });

    await service.createBOM(input, 'user-1');

    expect(mocks.costEstimateCreateMany).toHaveBeenCalledTimes(1);
    // totalCost = 1312.5 (material) + 500 (labor) + 200 (overhead) = 2012.5
    const bomData = mocks.bomCreate.mock.calls[0][0].data;
    expect(Number(bomData.totalMaterialCost)).toBe(1312.5);
    expect(Number(bomData.totalLaborCost)).toBe(500);
    expect(Number(bomData.totalOverheadCost)).toBe(200);
    expect(Number(bomData.totalCost)).toBe(2012.5);
  });

  it('含 sellingPrice → 计算利润和利润率', async () => {
    const { prisma, mocks } = makePrisma();
    const service = createBOMService(prisma);

    const input = makeCreateInput({
      sellingPrice: 3000,
      lines: [makeLineInput({ quantity: 100, unitCost: 10, wastagePercent: 0 })], // amount = 1000
    });

    await service.createBOM(input, 'user-1');

    const bomData = mocks.bomCreate.mock.calls[0][0].data;
    // totalCost = 1000; profitAmount = 3000 - 1000 = 2000; profitMargin = 2000/3000 * 100 = 66.67
    expect(Number(bomData.totalCost)).toBe(1000);
    expect(Number(bomData.profitAmount)).toBe(2000);
    expect(Number(bomData.profitMargin)).toBeCloseTo(66.6667, 2);
  });

  it('不含 sellingPrice → profitAmount/profitMargin 为 null', async () => {
    const { prisma, mocks } = makePrisma();
    const service = createBOMService(prisma);

    await service.createBOM(makeCreateInput(), 'user-1');

    const bomData = mocks.bomCreate.mock.calls[0][0].data;
    expect(bomData.profitAmount).toBeNull();
    expect(bomData.profitMargin).toBeNull();
  });

  it('bomNumber 已存在 → 抛错且不创建', async () => {
    const existing = makeExistingBOM();
    const { prisma, mocks } = makePrisma({ existingBOM: existing, bomNumberExists: true });
    const service = createBOMService(prisma);

    await expect(service.createBOM(makeCreateInput(), 'user-1')).rejects.toThrow(/已存在/);
    expect(mocks.bomCreate).not.toHaveBeenCalled();
  });

  it('空行明细 → 抛错', async () => {
    const { prisma, mocks } = makePrisma();
    const service = createBOMService(prisma);

    await expect(service.createBOM(makeCreateInput({ lines: [] }), 'user-1')).rejects.toThrow(/至少需要一行/);
    expect(mocks.bomCreate).not.toHaveBeenCalled();
  });

  it('非法物料类型 → 抛错', async () => {
    const { prisma, mocks } = makePrisma();
    const service = createBOMService(prisma);

    await expect(
      service.createBOM(
        makeCreateInput({ lines: [makeLineInput({ materialType: 'InvalidType' as any })] }),
        'user-1',
      ),
    ).rejects.toThrow(/非法物料类型/);
    expect(mocks.bomCreate).not.toHaveBeenCalled();
  });

  it('非法成本类型 → 抛错', async () => {
    const { prisma, mocks } = makePrisma();
    const service = createBOMService(prisma);

    await expect(
      service.createBOM(
        makeCreateInput({
          costEstimates: [makeCostInput({ costType: 'InvalidCost' as any })],
        }),
        'user-1',
      ),
    ).rejects.toThrow(/非法成本类型/);
    expect(mocks.bomCreate).not.toHaveBeenCalled();
  });

  it('audit reject → 事务回滚（BOM 不应提交）', async () => {
    const { prisma, tx, mocks } = makePrisma({ auditFail: true });
    const service = createBOMService(prisma);

    // 因为 $transaction 是透明穿透模式，audit reject 会让整个事务 Promise reject
    await expect(service.createBOM(makeCreateInput(), 'user-1')).rejects.toThrow('AUDIT_REJECT');
    // bomCreate 在事务内被调用了，但因为事务 reject，实际不会持久化（模拟层无法验证回滚，但能验证 reject 传播）
    expect(mocks.bomCreate).toHaveBeenCalledTimes(1);
  });

  it('actorId 为空时使用 system 作为 actor', async () => {
    const { prisma, mocks } = makePrisma();
    const service = createBOMService(prisma);

    await service.createBOM(makeCreateInput(), '');

    const auditData = mocks.auditCreate.mock.calls[0][0].data;
    expect(auditData.actorId).toBe('system');
  });

  it('wastagePercent=0 → effectiveQty = quantity', async () => {
    const { prisma, mocks } = makePrisma();
    const service = createBOMService(prisma);

    await service.createBOM(
      makeCreateInput({
        lines: [makeLineInput({ quantity: 50, unitCost: 20, wastagePercent: 0 })],
      }),
      'user-1',
    );

    const lineData = mocks.bomLineCreateMany.mock.calls[0][0].data[0];
    expect(Number(lineData.effectiveQty)).toBe(50);
    expect(Number(lineData.amount)).toBe(1000);
  });

  it('CostEstimate(Material) 累加到 totalMaterialCost', async () => {
    const { prisma, mocks } = makePrisma();
    const service = createBOMService(prisma);

    await service.createBOM(
      makeCreateInput({
        lines: [makeLineInput({ quantity: 100, unitCost: 10, wastagePercent: 0 })], // 1000
        costEstimates: [
          makeCostInput({ costType: 'Material', amount: 200 }),
          makeCostInput({ costType: 'Labor', amount: 300 }),
        ],
      }),
      'user-1',
    );

    const bomData = mocks.bomCreate.mock.calls[0][0].data;
    // totalMaterialCost = 1000 (line) + 200 (Material estimate) = 1200
    expect(Number(bomData.totalMaterialCost)).toBe(1200);
    expect(Number(bomData.totalLaborCost)).toBe(300);
    expect(Number(bomData.totalCost)).toBe(1500);
  });

  it('CostEstimate(Other) 累加到 totalOverheadCost', async () => {
    const { prisma, mocks } = makePrisma();
    const service = createBOMService(prisma);

    await service.createBOM(
      makeCreateInput({
        lines: [makeLineInput({ quantity: 100, unitCost: 10, wastagePercent: 0 })],
        costEstimates: [
          makeCostInput({ costType: 'Overhead', amount: 150 }),
          makeCostInput({ costType: 'Other', amount: 50 }),
        ],
      }),
      'user-1',
    );

    const bomData = mocks.bomCreate.mock.calls[0][0].data;
    expect(Number(bomData.totalOverheadCost)).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// getBOM
// ════════════════════════════════════════════════════════════

describe('bomService: getBOM', () => {
  it('成功获取含 lines + costEstimates', async () => {
    const existing = makeExistingBOM({ id: 'BOM_get1' });
    const detail = { ...existing, lines: [], costEstimates: [] };
    const { prisma } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });
    const service = createBOMService(prisma);

    const result = await service.getBOM('BOM_get1');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('BOM_get1');
  });

  it('不存在 → 返回 null', async () => {
    const { prisma } = makePrisma();
    const service = createBOMService(prisma);

    const result = await service.getBOM('nonexistent');
    expect(result).toBeNull();
  });

  it('软删除 → 返回 null', async () => {
    const existing = makeExistingBOM({ id: 'BOM_del1', deletedAt: 1700000000000 });
    const { prisma } = makePrisma({ existingBOM: existing, existingBOMDetail: existing });
    const service = createBOMService(prisma);

    const result = await service.getBOM('BOM_del1');
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
// listBOMs
// ════════════════════════════════════════════════════════════

describe('bomService: listBOMs', () => {
  it('带状态过滤 → where.status 被设置', async () => {
    const { prisma, mocks } = makePrisma({ existingBOM: makeExistingBOM() });
    const service = createBOMService(prisma);

    await service.listBOMs({ status: 'Draft' });

    const where = mocks.bomFindMany.mock.calls[0][0].where;
    expect(where.status).toBe('Draft');
    expect(where.deletedAt).toBeNull();
  });

  it('带搜索 → where.OR 包含 bomNumber + description', async () => {
    const { prisma, mocks } = makePrisma({ existingBOM: makeExistingBOM() });
    const service = createBOMService(prisma);

    await service.listBOMs({ search: '测试' });

    const where = mocks.bomFindMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { bomNumber: { contains: '测试' } },
      { description: { contains: '测试' } },
    ]);
  });

  it('limit 上限 500', async () => {
    const { prisma, mocks } = makePrisma({ existingBOM: makeExistingBOM() });
    const service = createBOMService(prisma);

    await service.listBOMs({ limit: 9999 });

    expect(mocks.bomFindMany.mock.calls[0][0].take).toBe(500);
  });

  it('默认 limit=100, offset=0', async () => {
    const { prisma, mocks } = makePrisma({ existingBOM: makeExistingBOM() });
    const service = createBOMService(prisma);

    await service.listBOMs({});

    expect(mocks.bomFindMany.mock.calls[0][0].take).toBe(100);
    expect(mocks.bomFindMany.mock.calls[0][0].skip).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════
// updateBOM
// ════════════════════════════════════════════════════════════

describe('bomService: updateBOM', () => {
  it('成功更新 → 重新计算成本 + audit', async () => {
    const existing = makeExistingBOM({ id: 'BOM_upd1', status: 'Draft' });
    const detail = { ...existing, lines: [makeLineInput()], costEstimates: [] };
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });
    const service = createBOMService(prisma);

    await service.updateBOM('BOM_upd1', { description: '更新后描述' }, 'user-1');

    expect(mocks.bomUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const bomData = mocks.bomUpdate.mock.calls[0][0].data;
    expect(bomData.description).toBe('更新后描述');
  });

  it('非 Draft 状态 → 抛错', async () => {
    const existing = makeExistingBOM({ id: 'BOM_upd2', status: 'Confirmed' });
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: existing });
    const service = createBOMService(prisma);

    await expect(service.updateBOM('BOM_upd2', { description: 'x' }, 'user-1')).rejects.toThrow(/仅 Draft/);
    expect(mocks.bomUpdate).not.toHaveBeenCalled();
  });

  it('不存在 → 抛错', async () => {
    const { prisma } = makePrisma();
    const service = createBOMService(prisma);

    await expect(service.updateBOM('nonexistent', {}, 'user-1')).rejects.toThrow(/不存在/);
  });

  it('提供新行明细 → 删除旧行 + 创建新行', async () => {
    const existing = makeExistingBOM({ id: 'BOM_upd3', status: 'Draft' });
    const detail = { ...existing, lines: [makeLineInput()], costEstimates: [] };
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });
    const service = createBOMService(prisma);

    await service.updateBOM(
      'BOM_upd3',
      { lines: [makeLineInput({ quantity: 200, unitCost: 15 })] },
      'user-1',
    );

    expect(mocks.bomLineDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.bomLineCreateMany).toHaveBeenCalledTimes(1);
  });

  it('提供新成本估算 → 删除旧 + 创建新', async () => {
    const existing = makeExistingBOM({ id: 'BOM_upd4', status: 'Draft' });
    const detail = { ...existing, lines: [], costEstimates: [] };
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });
    const service = createBOMService(prisma);

    await service.updateBOM(
      'BOM_upd4',
      { costEstimates: [makeCostInput({ costType: 'Labor', amount: 800 })] },
      'user-1',
    );

    expect(mocks.costEstimateDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.costEstimateCreateMany).toHaveBeenCalledTimes(1);
  });

  it('新行含非法物料类型 → 抛错', async () => {
    const existing = makeExistingBOM({ id: 'BOM_upd5', status: 'Draft' });
    const detail = { ...existing, lines: [], costEstimates: [] };
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });
    const service = createBOMService(prisma);

    await expect(
      service.updateBOM(
        'BOM_upd5',
        { lines: [makeLineInput({ materialType: 'Bad' as any })] },
        'user-1',
      ),
    ).rejects.toThrow(/非法物料类型/);
    expect(mocks.bomUpdate).not.toHaveBeenCalled();
  });

  it('更新 sellingPrice → 重新计算利润', async () => {
    const existing = makeExistingBOM({ id: 'BOM_upd6', status: 'Draft', totalCost: 1000 });
    const detail = {
      ...existing,
      lines: [makeLineInput({ quantity: 100, unitCost: 10, wastagePercent: 0 })],
      costEstimates: [],
    };
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });
    const service = createBOMService(prisma);

    await service.updateBOM('BOM_upd6', { sellingPrice: 2500 }, 'user-1');

    const bomData = mocks.bomUpdate.mock.calls[0][0].data;
    // totalCost = 1000; profitAmount = 2500 - 1000 = 1500; profitMargin = 60
    expect(Number(bomData.profitAmount)).toBe(1500);
    expect(Number(bomData.profitMargin)).toBe(60);
  });
});

// ════════════════════════════════════════════════════════════
// deleteBOM
// ════════════════════════════════════════════════════════════

describe('bomService: deleteBOM', () => {
  it('成功软删除（Draft）→ update deletedAt + audit', async () => {
    const existing = makeExistingBOM({ id: 'BOM_del1', status: 'Draft' });
    const { prisma, mocks } = makePrisma({ existingBOM: existing });
    const service = createBOMService(prisma);

    await service.deleteBOM('BOM_del1', 'user-1');

    expect(mocks.bomUpdate).toHaveBeenCalledTimes(1);
    const data = mocks.bomUpdate.mock.calls[0][0].data;
    expect(data.deletedAt).not.toBeNull();
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });

  it('非 Draft → 抛错', async () => {
    const existing = makeExistingBOM({ id: 'BOM_del2', status: 'Confirmed' });
    const { prisma, mocks } = makePrisma({ existingBOM: existing });
    const service = createBOMService(prisma);

    await expect(service.deleteBOM('BOM_del2', 'user-1')).rejects.toThrow(/仅 Draft/);
    expect(mocks.bomUpdate).not.toHaveBeenCalled();
  });

  it('不存在 → 抛错', async () => {
    const { prisma } = makePrisma();
    const service = createBOMService(prisma);

    await expect(service.deleteBOM('nonexistent', 'user-1')).rejects.toThrow(/不存在/);
  });
});

// ════════════════════════════════════════════════════════════
// confirmBOM
// ════════════════════════════════════════════════════════════

describe('bomService: confirmBOM', () => {
  it('Draft → Confirmed → 更新状态 + audit + 发布 BOMConfirmed 事件', async () => {
    const existing = makeExistingBOM({ id: 'BOM_conf1', status: 'Draft' });
    const detail = { ...existing, lines: [makeLineInput()], costEstimates: [] };
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });
    const service = createBOMService(prisma);

    await service.confirmBOM('BOM_conf1', 'user-1');

    expect(mocks.bomUpdate).toHaveBeenCalledTimes(1);
    const data = mocks.bomUpdate.mock.calls[0][0].data;
    expect(data.status).toBe('Confirmed');
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);

    // 验证事件发布
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0][0];
    expect(event.type).toBe('BOMConfirmed');
    expect(event.sourceEntityId).toBe('BOM_conf1');
    expect(event.payload.bomNumber).toBe('BOM-20260807-001');
  });

  it('Confirmed → Confirmed → 抛错（非法转换）', async () => {
    const existing = makeExistingBOM({ id: 'BOM_conf2', status: 'Confirmed' });
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: existing });
    const service = createBOMService(prisma);

    await expect(service.confirmBOM('BOM_conf2', 'user-1')).rejects.toThrow(/非法状态转换/);
    expect(mocks.bomUpdate).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('Archived → Confirmed → 抛错（终态不可转换）', async () => {
    const existing = makeExistingBOM({ id: 'BOM_conf3', status: 'Archived' });
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: existing });
    const service = createBOMService(prisma);

    await expect(service.confirmBOM('BOM_conf3', 'user-1')).rejects.toThrow(/非法状态转换/);
    expect(mocks.bomUpdate).not.toHaveBeenCalled();
  });

  it('不存在 → 抛错', async () => {
    const { prisma } = makePrisma();
    const service = createBOMService(prisma);

    await expect(service.confirmBOM('nonexistent', 'user-1')).rejects.toThrow(/不存在/);
  });

  it('事件发布失败不阻断业务（fire-and-forget）', async () => {
    const existing = makeExistingBOM({ id: 'BOM_conf4', status: 'Draft' });
    const detail = { ...existing, lines: [makeLineInput()], costEstimates: [] };
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });

    // 事件发布抛错
    publishSpy.mockRejectedValueOnce(new Error('EVENT_BOOM') as never);

    const service = createBOMService(prisma);

    // 不应抛错
    await service.confirmBOM('BOM_conf4', 'user-1');
    expect(mocks.bomUpdate).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════
// archiveBOM
// ════════════════════════════════════════════════════════════

describe('bomService: archiveBOM', () => {
  it('Draft → Archived → 成功', async () => {
    const existing = makeExistingBOM({ id: 'BOM_arch1', status: 'Draft' });
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: existing });
    const service = createBOMService(prisma);

    await service.archiveBOM('BOM_arch1', 'user-1');

    expect(mocks.bomUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.bomUpdate.mock.calls[0][0].data.status).toBe('Archived');
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });

  it('Confirmed → Archived → 成功', async () => {
    const existing = makeExistingBOM({ id: 'BOM_arch2', status: 'Confirmed' });
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: existing });
    const service = createBOMService(prisma);

    await service.archiveBOM('BOM_arch2', 'user-1');

    expect(mocks.bomUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.bomUpdate.mock.calls[0][0].data.status).toBe('Archived');
  });

  it('Archived → Archived → 抛错（终态）', async () => {
    const existing = makeExistingBOM({ id: 'BOM_arch3', status: 'Archived' });
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: existing });
    const service = createBOMService(prisma);

    await expect(service.archiveBOM('BOM_arch3', 'user-1')).rejects.toThrow(/非法状态转换/);
    expect(mocks.bomUpdate).not.toHaveBeenCalled();
  });

  it('不存在 → 抛错', async () => {
    const { prisma } = makePrisma();
    const service = createBOMService(prisma);

    await expect(service.archiveBOM('nonexistent', 'user-1')).rejects.toThrow(/不存在/);
  });
});

// ════════════════════════════════════════════════════════════
// reviseBOM（修订出新版：版本链）
// ════════════════════════════════════════════════════════════

describe('bomService: reviseBOM', () => {
  it('Confirmed → 原 BOM 归档 + 新 Draft v+1（parentBomId 指回原 BOM）+ 行/成本项复制 + audit', async () => {
    const existing = makeExistingBOM({ id: 'BOM_rev1', status: 'Confirmed', version: 1, sellingPrice: 3000, profitAmount: 1687.5 });
    const detail = {
      ...existing,
      lines: [makeLineInput({ quantity: 100, unitCost: 12.5, wastagePercent: 5 })],
      costEstimates: [makeCostInput({ costType: 'Labor', amount: 500 })],
    };
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });
    const service = createBOMService(prisma);

    await service.reviseBOM('BOM_rev1', 'user-1');

    // 1. 原 BOM 归档
    expect(mocks.bomUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.bomUpdate.mock.calls[0][0].where.id).toBe('BOM_rev1');
    expect(mocks.bomUpdate.mock.calls[0][0].data.status).toBe('Archived');

    // 2. 新版本：Draft、version+1、parentBomId 版本链、成本四项复制
    expect(mocks.bomCreate).toHaveBeenCalledTimes(1);
    const bomData = mocks.bomCreate.mock.calls[0][0].data;
    expect(bomData.status).toBe('Draft');
    expect(bomData.version).toBe(2);
    expect(bomData.parentBomId).toBe('BOM_rev1');
    expect(Number(bomData.totalMaterialCost)).toBe(1312.5);
    expect(Number(bomData.sellingPrice)).toBe(3000);

    // 3. 行 + 成本项复制到新 BOM
    expect(mocks.bomLineCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.bomLineCreateMany.mock.calls[0][0].data).toHaveLength(1);
    expect(mocks.costEstimateCreateMany).toHaveBeenCalledTimes(1);

    // 4. 审计：revise_bom 动作留痕版本链
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const auditData = mocks.auditCreate.mock.calls[0][0].data;
    expect(auditData.action).toBe('revise_bom');
    expect(auditData.detail.after.parentBomId).toBe('BOM_rev1');
    expect(auditData.detail.after.version).toBe(2);
  });

  it('Draft → 抛错（Draft 直接编辑即可，无需修订）', async () => {
    const existing = makeExistingBOM({ id: 'BOM_rev2', status: 'Draft' });
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: existing });
    const service = createBOMService(prisma);

    await expect(service.reviseBOM('BOM_rev2', 'user-1')).rejects.toThrow(/仅 Confirmed/);
    expect(mocks.bomUpdate).not.toHaveBeenCalled();
    expect(mocks.bomCreate).not.toHaveBeenCalled();
  });

  it('Archived → 抛错（终态）', async () => {
    const existing = makeExistingBOM({ id: 'BOM_rev3', status: 'Archived' });
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: existing });
    const service = createBOMService(prisma);

    await expect(service.reviseBOM('BOM_rev3', 'user-1')).rejects.toThrow(/仅 Confirmed/);
    expect(mocks.bomCreate).not.toHaveBeenCalled();
  });

  it('不存在 → 抛错', async () => {
    const { prisma } = makePrisma();
    const service = createBOMService(prisma);

    await expect(service.reviseBOM('nonexistent', 'user-1')).rejects.toThrow(/不存在/);
  });

  it('audit reject → 事务回滚（reject 传播）', async () => {
    const existing = makeExistingBOM({ id: 'BOM_rev4', status: 'Confirmed' });
    const detail = { ...existing, lines: [makeLineInput()], costEstimates: [] };
    const { prisma } = makePrisma({ existingBOM: existing, existingBOMDetail: detail, auditFail: true });
    const service = createBOMService(prisma);

    await expect(service.reviseBOM('BOM_rev4', 'user-1')).rejects.toThrow('AUDIT_REJECT');
  });
});

// ════════════════════════════════════════════════════════════
// recalculateCost
// ════════════════════════════════════════════════════════════

describe('bomService: recalculateCost', () => {
  it('Draft 状态 → 重新汇总成本 + 发布 BOMCostCalculated 事件', async () => {
    const existing = makeExistingBOM({ id: 'BOM_rec1', status: 'Draft' });
    const detail = {
      ...existing,
      lines: [makeLineInput({ quantity: 100, unitCost: 10, wastagePercent: 0 })], // 1000
      costEstimates: [makeCostInput({ costType: 'Labor', amount: 300 })],
    };
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });
    const service = createBOMService(prisma);

    await service.recalculateCost('BOM_rec1', 'user-1');

    expect(mocks.bomUpdate).toHaveBeenCalledTimes(1);
    const data = mocks.bomUpdate.mock.calls[0][0].data;
    expect(Number(data.totalMaterialCost)).toBe(1000);
    expect(Number(data.totalLaborCost)).toBe(300);
    expect(Number(data.totalCost)).toBe(1300);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0][0];
    expect(event.type).toBe('BOMCostCalculated');
    expect(event.payload.totalCost).toBe(1300);
  });

  it('非 Draft 状态 → 抛错', async () => {
    const existing = makeExistingBOM({ id: 'BOM_rec2', status: 'Confirmed' });
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: existing });
    const service = createBOMService(prisma);

    await expect(service.recalculateCost('BOM_rec2', 'user-1')).rejects.toThrow(/仅 Draft/);
    expect(mocks.bomUpdate).not.toHaveBeenCalled();
  });

  it('不存在 → 抛错', async () => {
    const { prisma } = makePrisma();
    const service = createBOMService(prisma);

    await expect(service.recalculateCost('nonexistent', 'user-1')).rejects.toThrow(/不存在/);
  });

  it('含 sellingPrice → 重新计算利润', async () => {
    const existing = makeExistingBOM({ id: 'BOM_rec3', status: 'Draft', sellingPrice: 2000 });
    const detail = {
      ...existing,
      lines: [makeLineInput({ quantity: 100, unitCost: 10, wastagePercent: 0 })], // 1000
      costEstimates: [],
    };
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });
    const service = createBOMService(prisma);

    await service.recalculateCost('BOM_rec3', 'user-1');

    const data = mocks.bomUpdate.mock.calls[0][0].data;
    // totalCost = 1000; profitAmount = 2000 - 1000 = 1000; profitMargin = 50
    expect(Number(data.profitAmount)).toBe(1000);
    expect(Number(data.profitMargin)).toBe(50);
  });

  it('事件发布失败不阻断业务（fire-and-forget）', async () => {
    const existing = makeExistingBOM({ id: 'BOM_rec4', status: 'Draft' });
    const detail = { ...existing, lines: [makeLineInput()], costEstimates: [] };
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });

    publishSpy.mockRejectedValueOnce(new Error('EVENT_BOOM') as never);

    const service = createBOMService(prisma);

    await service.recalculateCost('BOM_rec4', 'user-1');
    expect(mocks.bomUpdate).toHaveBeenCalledTimes(1);
  });

  it('actorId 为空时使用 system', async () => {
    const existing = makeExistingBOM({ id: 'BOM_rec5', status: 'Draft' });
    const detail = { ...existing, lines: [makeLineInput()], costEstimates: [] };
    const { prisma, mocks } = makePrisma({ existingBOM: existing, existingBOMDetail: detail });
    const service = createBOMService(prisma);

    await service.recalculateCost('BOM_rec5', '');

    const auditData = mocks.auditCreate.mock.calls[0][0].data;
    expect(auditData.actorId).toBe('system');

    const event = publishSpy.mock.calls[0][0];
    expect(event.actorId).toBe('system');
  });
});
