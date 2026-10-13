/**
 * D6-Q1 米样长度口径 —— sampleLengthService 单元测试
 *
 * 覆盖：
 *   - 建账：仅未建账样品可 set；重复建账 409；单位/数量校验
 *   - 变动：未建账 409；持有不足 fail-closed（不可负）；borrow_in 增方向；单位取自样品账
 *   - 分割：父样减、子样建（继承来源/归属）、父子流水互引；持有不足 409
 *   - 台账：按样品倒序
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createSampleLengthService } from '../sampleLengthService';
import { readSampleOriginContexts, sampleOriginFingerprint, sampleProjectionKey, snapshotSampleOrigin } from '../sampleOriginService';

vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function makePrisma(seed: {
  sample?: any; childCodeTaken?: boolean;
  sourceCases?: any[]; sourceOrders?: any[]; sourceAssets?: any[];
  origins?: any[]; originBatches?: any[]; originAudits?: any[];
  failOriginAudit?: boolean;
} = {}) {
  const movements: any[] = [];
  let childCreated: any = null;
  const sampleRow = seed.sample ? { ...seed.sample } : null;
  const origins = [...(seed.origins ?? [])];
  const audits = [...(seed.originAudits ?? [])];

  const tx: any = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    developmentCase: { findMany: vi.fn().mockResolvedValue(seed.sourceCases ?? [{ id: 'DEV_1', type: 'fabric', deletedAt: null }]) },
    order: { findMany: vi.fn().mockResolvedValue(seed.sourceOrders ?? []) },
    productAsset: { findMany: vi.fn().mockResolvedValue(seed.sourceAssets ?? []) },
    sampleSource: {
      findMany: vi.fn(async ({ where }: any) => origins.filter(row =>
        typeof where.sampleId === 'string' ? row.sampleId === where.sampleId : where.sampleId.in.includes(row.sampleId))),
      create: vi.fn(async ({ data }: any) => { origins.push(data); return data; }),
    },
    sampleBatch: { findMany: vi.fn().mockResolvedValue(seed.originBatches ?? []) },
    sample: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        if (sampleRow && where.id === sampleRow.id) return sampleRow;
        if (childCreated && where.id === childCreated.id) return childCreated;
        return null;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const row = sampleRow && where.id === sampleRow.id ? sampleRow : childCreated;
        Object.assign(row, data);
        return row;
      }),
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        childCreated = { ...data };
        return childCreated;
      }),
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
        if (!where.id) return null; // code 占用检查
        const row = where.id === sampleRow?.id ? sampleRow : where.id === childCreated?.id ? childCreated : null;
        return row?.deletedAt == null ? row : null;
      }),
    },
    sampleLengthMovement: {
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        const row = { ...data, id: `SLM_${movements.length + 1}` };
        movements.push(row);
        return row;
      }),
      findMany: vi.fn().mockImplementation(async ({ where }: any) =>
        [...movements].filter((m) => !where?.sampleId || m.sampleId === where.sampleId).reverse()),
    },
    auditLog: {
      findMany: vi.fn(async () => audits),
      findFirst: vi.fn(async ({ where }: any) => audits.find(row => row.id === where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        if (seed.failOriginAudit && data.action === 'inherit_sample_origins') throw new Error('origin audit failed');
        const row = { ...data, id: data.id ?? 'AL_1' }; audits.push(row); return row;
      }),
    },
  };
  const prisma: any = { $transaction: vi.fn(async (fn: any) => {
    const before = { sample: sampleRow ? { ...sampleRow } : null, child: childCreated ? { ...childCreated } : null,
      movements: movements.length, origins: origins.length, audits: audits.length };
    try { return await fn(tx); }
    catch (error) {
      if (sampleRow && before.sample) {
        for (const field of Object.keys(sampleRow)) if (!(field in before.sample)) delete sampleRow[field];
        Object.assign(sampleRow, before.sample);
      }
      childCreated = before.child;
      movements.length = before.movements; origins.length = before.origins; audits.length = before.audits;
      throw error;
    }
  }) };
  prisma.sampleLengthMovement = tx.sampleLengthMovement; // listLengthMovements 走顶层 client
  (prisma as any).__movements = movements;
  (prisma as any).__sample = sampleRow;
  (prisma as any).__child = () => childCreated;
  (prisma as any).__tx = tx;
  (prisma as any).__origins = origins;
  (prisma as any).__audits = audits;
  return prisma;
}

const yardageSample = {
  id: 'SMP_1', code: 'SMP-20260916-001', type: 'dev', subType: 'yardage',
  sourceCaseId: 'DEV_1', sourceOrderId: null, productAssetId: null,
  supplierRelationId: 'REL_MILL', supplierName: '某厂', customerRelationId: 'REL_C1',
  status: 'making', lengthQty: null, lengthUnit: null, deletedAt: null,
};

describe('sampleLengthService: 建账（set）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('未建账样品 → 建账成功并写流水', async () => {
    const prisma = makePrisma({ sample: yardageSample });
    const svc = createSampleLengthService(prisma);

    const r = await svc.setSampleLength({ sampleId: 'SMP_1', quantity: 20, unit: 'M', operator: 'u1' });

    expect(r.ok).toBe(true);
    expect((prisma as any).__sample.lengthQty?.toString()).toBe('20');
    expect((prisma as any).__sample.lengthUnit).toBe('M');
    expect((prisma as any).__movements).toHaveLength(1);
    expect((prisma as any).__movements[0].type).toBe('set');
  });

  it('已建账 → 409 ALREADY_SET（调整必须走流水，不得覆盖账面）', async () => {
    const prisma = makePrisma({ sample: { ...yardageSample, lengthQty: 20, lengthUnit: 'M' } });
    const svc = createSampleLengthService(prisma);

    const r = await svc.setSampleLength({ sampleId: 'SMP_1', quantity: 5, unit: 'M' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ALREADY_SET');
  });

  it('单位非法（米/码之外）与数量 ≤ 0 → 拒绝', async () => {
    const prisma = makePrisma({ sample: yardageSample });
    const svc = createSampleLengthService(prisma);

    const badUnit = await svc.setSampleLength({ sampleId: 'SMP_1', quantity: 5, unit: 'KG' });
    const badQty = await svc.setSampleLength({ sampleId: 'SMP_1', quantity: 0, unit: 'M' });

    expect(badUnit.ok).toBe(false);
    expect(badQty.ok).toBe(false);
  });
});

describe('sampleLengthService: 变动（give/return/loss/borrow_in/borrow_return）', () => {
  beforeEach(() => vi.clearAllMocks());
  const stocked = { ...yardageSample, lengthQty: 20, lengthUnit: 'M' };

  it('剪给客户（give）→ 持有减少 + 流水留 balanceAfter', async () => {
    const prisma = makePrisma({ sample: stocked });
    const svc = createSampleLengthService(prisma);

    const r = await svc.moveSampleLength({ sampleId: 'SMP_1', type: 'give', quantity: 3, operator: 'u1' });

    expect(r.ok).toBe(true);
    expect((prisma as any).__sample.lengthQty?.toString()).toBe('17');
    expect((prisma as any).__movements[0].balanceAfter?.toString()).toBe('17');
  });

  it('持有不足（give 25 of 20）→ 409 LENGTH_INSUFFICIENT，账面不动（fail-closed）', async () => {
    const prisma = makePrisma({ sample: stocked });
    const svc = createSampleLengthService(prisma);

    const r = await svc.moveSampleLength({ sampleId: 'SMP_1', type: 'give', quantity: 25 });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('LENGTH_INSUFFICIENT');
    expect((prisma as any).__sample.lengthQty?.toString()).toBe('20');
  });

  it('借入（borrow_in）→ 持有增加；归还工厂（borrow_return）→ 持有减少', async () => {
    const prisma = makePrisma({ sample: stocked });
    const svc = createSampleLengthService(prisma);

    await svc.moveSampleLength({ sampleId: 'SMP_1', type: 'borrow_in', quantity: 10 });
    expect((prisma as any).__sample.lengthQty?.toString()).toBe('30');

    await svc.moveSampleLength({ sampleId: 'SMP_1', type: 'borrow_return', quantity: 10 });
    expect((prisma as any).__sample.lengthQty?.toString()).toBe('20');
  });

  it('未建账样品 → 409 NO_LENGTH_ACCOUNT', async () => {
    const prisma = makePrisma({ sample: yardageSample });
    const svc = createSampleLengthService(prisma);

    const r = await svc.moveSampleLength({ sampleId: 'SMP_1', type: 'loss', quantity: 1 });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NO_LENGTH_ACCOUNT');
  });

  it('cut 类型必须走独立分割端点（需要建子样）', async () => {
    const prisma = makePrisma({ sample: stocked });
    const svc = createSampleLengthService(prisma);

    const r = await svc.moveSampleLength({ sampleId: 'SMP_1', type: 'cut', quantity: 3 });

    expect(r.ok).toBe(false);
  });
});

describe('sampleLengthService: 分割（cut）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('20M 剪 3M → 父样余 17M、子样 3M（继承来源/工厂/客户/类型）、父子流水互引', async () => {
    const prisma = makePrisma({ sample: { ...yardageSample, lengthQty: 20, lengthUnit: 'M' } });
    const svc = createSampleLengthService(prisma);

    const r = await svc.cutSampleLength({ sampleId: 'SMP_1', quantity: 3, note: '客户要样', operator: 'u1' });

    expect(r.ok).toBe(true);
    expect((prisma as any).__sample.lengthQty?.toString()).toBe('17');
    const child = (prisma as any).__child();
    expect(child).toBeTruthy();
    expect(child.lengthQty?.toString()).toBe('3');
    expect(child.lengthUnit).toBe('M');
    expect(child.subType).toBe('yardage');
    expect(child.sourceCaseId).toBe('DEV_1');
    expect(child.supplierRelationId).toBe('REL_MILL');
    expect(child.customerRelationId).toBe('REL_C1');
    expect(child.projectionKey).toBeUndefined();
    expect(prisma.__tx.sampleSource.create).not.toHaveBeenCalled(); // legacy ancestry remains unknown

    const movements = (prisma as any).__movements as any[];
    expect(movements).toHaveLength(2);
    expect(movements[0].sampleId).toBe('SMP_1');
    expect(movements[0].counterpartSampleId).toBe(child.id);
    expect(movements[1].sampleId).toBe(child.id);
    expect(movements[1].counterpartSampleId).toBe('SMP_1');
  });

  it('剪超持有 → 409 LENGTH_INSUFFICIENT，不建子样', async () => {
    const prisma = makePrisma({ sample: { ...yardageSample, lengthQty: 2, lengthUnit: 'M' } });
    const svc = createSampleLengthService(prisma);

    const r = await svc.cutSampleLength({ sampleId: 'SMP_1', quantity: 3 });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('LENGTH_INSUFFICIENT');
    expect((prisma as any).__child()).toBeNull();
  });
  it.each([
    { parentStatus: 'making', failOriginAudit: false }, { parentStatus: 'approved', failOriginAudit: false },
    { parentStatus: 'sealed', failOriginAudit: false }, { parentStatus: 'making', failOriginAudit: true },
  ])('分割保留来源但不复制父样 $parentStatus 批准/终态；来源审计失败=$failOriginAudit', async ({ parentStatus, failOriginAudit }) => {
    const development = { id: 'DEV_1', type: 'fabric', deletedAt: null };
    const batch = { id: 'B1', batchCode: 'SB1', developmentCaseId: 'DEV_1', supplierRelationId: 'REL_MILL', sampleType: 'yardage', round: 1,
      status: 'pending', updatedAt: BigInt(1), deletedAt: null };
    const sourceSnapshot = snapshotSampleOrigin(batch, development);
    const origin = { id: 'ORIGIN1', sampleId: 'SMP_1', sampleBatchId: 'B1', sourceRound: 1, sourceSealId: null, sourceSnapshot,
      sourceFingerprint: sampleOriginFingerprint(sourceSnapshot), sourceUpdatedAt: BigInt(sourceSnapshot.version.updatedAt),
      sourceHistoryRevision: sourceSnapshot.version.historyRevision, sourceEventId: sourceSnapshot.version.eventId,
      evidenceAuditId: 'SOURCE-AUDIT', boundAt: BigInt(1), boundBy: 'u1', provenance: 'native' };
    const audit = { id: 'SOURCE-AUDIT', actorId: 'u1', targetType: 'Sample', targetId: 'SMP_1', action: 'bind_sample_origins',
      detail: { source: 'route:samples:origin', after: { projectionKey: sampleProjectionKey('fabric_output', 'B1', 1), origins: [origin] } } };
    const prisma = makePrisma({ sample: { ...yardageSample, status: parentStatus, projectionKey: sampleProjectionKey('fabric_output', 'B1', 1), lengthQty: 20, lengthUnit: 'M' },
      sourceCases: [development], origins: [origin], originBatches: [batch], originAudits: [audit], failOriginAudit });
    const result = await createSampleLengthService(prisma).cutSampleLength({ sampleId: 'SMP_1', quantity: 3, operator: 'u2' });
    if (failOriginAudit) {
      expect(result.ok).toBe(false);
      expect(prisma.__child()).toBeNull();
      expect(prisma.__sample.lengthQty).toBe(20);
      expect(prisma.__movements).toEqual([]);
      expect(prisma.__origins).toEqual([origin]);
      expect(prisma.__audits).toEqual([audit]);
      expect(prisma.__tx.sampleSource.create).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({ ok: true });
    const child = prisma.__child();
    expect(child.projectionKey).toBeUndefined();
    expect(child.status).toBe('draft');
    expect(child.approvedAt).toBeUndefined();
    const [context] = await readSampleOriginContexts(prisma.__tx, [child]);
    expect(context.status).toBe('resolved');
    expect(context.currentUsable).toBe(false);
    expect(context.originKind).toBe('inherited');
    expect(context.origins).toHaveLength(1);
    expect(context.origins[0]).toMatchObject({ sampleBatchId: 'B1', sourceRound: 1, provenance: 'inherited', sourceFingerprint: origin.sourceFingerprint });
    expect(prisma.__tx.sampleSource.create).toHaveBeenCalledTimes(1);
    const locks = prisma.__tx.$queryRaw.mock.calls.map(([sql]: any) => sql.sql.match(/FROM "(\w+)"/)?.[1]);
    expect(locks.indexOf('SampleBatch')).toBeLessThan(locks.indexOf('Sample'));
  });

  it('台账查询：按样品倒序返回', async () => {
    const prisma = makePrisma({ sample: { ...yardageSample } }); // 未建账 → 先 set 建账
    const svc = createSampleLengthService(prisma);
    const setR = await svc.setSampleLength({ sampleId: 'SMP_1', quantity: 20, unit: 'M' });
    expect(setR.ok).toBe(true);

    const r = await svc.listLengthMovements({ sampleId: 'SMP_1' });

    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as any).movements.length).toBeGreaterThanOrEqual(1);
  });
});

describe('sampleLengthService: 长度写入必须有一致的面料业务来源', () => {
  beforeEach(() => vi.clearAllMocks());

  const invalidSources: { name: string; seed: { sample?: any; sourceCases?: any[]; sourceOrders?: any[] }; code: string }[] = [
    { name: '成衣开发来源（即使 subType 是 yardage）', seed: { sourceCases: [{ id: 'DEV_1', type: 'garment', deletedAt: null }] }, code: 'SAMPLE_LENGTH_BUSINESS_LINE_MISMATCH' },
    { name: '无任何业务来源（即使已有米样长度账）', seed: { sample: { ...yardageSample, sourceCaseId: null } }, code: 'SAMPLE_BUSINESS_CONTEXT_UNRESOLVED' },
    { name: '引用的开发案不存在', seed: { sourceCases: [] }, code: 'SAMPLE_BUSINESS_CONTEXT_UNRESOLVED' },
    { name: '引用的开发案已删除', seed: { sourceCases: [{ id: 'DEV_1', type: 'fabric', deletedAt: BigInt(1) }] }, code: 'SAMPLE_BUSINESS_CONTEXT_UNRESOLVED' },
    { name: '旧 pp 开发来源无法确定业务线', seed: { sourceCases: [{ id: 'DEV_1', type: 'pp', deletedAt: null }] }, code: 'SAMPLE_BUSINESS_CONTEXT_UNRESOLVED' },
    { name: '面料开发来源与成衣订单来源冲突', seed: { sample: { ...yardageSample, sourceOrderId: 'ORD_1' }, sourceOrders: [{ id: 'ORD_1', type: 'garment', businessLine: 'garment', deletedAt: null }] }, code: 'SAMPLE_BUSINESS_CONTEXT_CONFLICT' },
  ];

  const actions = [
    { name: 'set', invoke: (svc: ReturnType<typeof createSampleLengthService>) => svc.setSampleLength({ sampleId: 'SMP_1', quantity: 3, unit: 'M' }), lengthQty: null, lengthUnit: null },
    { name: 'move', invoke: (svc: ReturnType<typeof createSampleLengthService>) => svc.moveSampleLength({ sampleId: 'SMP_1', type: 'borrow_in', quantity: 3 }), lengthQty: 20, lengthUnit: 'M' },
    { name: 'cut', invoke: (svc: ReturnType<typeof createSampleLengthService>) => svc.cutSampleLength({ sampleId: 'SMP_1', quantity: 3 }), lengthQty: 20, lengthUnit: 'M' },
  ];

  for (const action of actions) {
    for (const scenario of invalidSources) {
      it(`${action.name}: ${scenario.name} → 拒绝且不写样品/流水/审计`, async () => {
        const sample = { ...yardageSample, ...scenario.seed.sample, lengthQty: action.lengthQty, lengthUnit: action.lengthUnit };
        const prisma = makePrisma({ ...scenario.seed, sample });
        const before = { ...prisma.__sample };
        const result = await action.invoke(createSampleLengthService(prisma));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(scenario.code);
          expect(result.error.status).toBe(409);
        }
        expect(prisma.__sample).toEqual(before);
        expect(prisma.__child()).toBeNull();
        expect(prisma.__movements).toEqual([]);
        expect(prisma.__tx.sample.update).not.toHaveBeenCalled();
        expect(prisma.__tx.sample.create).not.toHaveBeenCalled();
        expect(prisma.__tx.auditLog.create).not.toHaveBeenCalled();
      });
    }
  }

  it('只关联明确面料订单也可建账，不依赖样品阶段或 subType', async () => {
    const prisma = makePrisma({
      sample: { ...yardageSample, type: 'pp', subType: null, sourceCaseId: null, sourceOrderId: 'ORD_1' },
      sourceCases: [], sourceOrders: [{ id: 'ORD_1', type: 'fabric', businessLine: 'fabric', deletedAt: null }],
    });
    const result = await createSampleLengthService(prisma).setSampleLength({ sampleId: 'SMP_1', quantity: 3, unit: 'YD' });
    expect(result.ok).toBe(true);
    expect(prisma.__sample.lengthUnit).toBe('YD');
    expect(prisma.__movements).toHaveLength(1);
  });

  it('来源验证后样品锚点变化 → 拒绝且不写入', async () => {
    const prisma = makePrisma({ sample: { ...yardageSample, lengthQty: 20, lengthUnit: 'M' } });
    prisma.__tx.sample.findUnique
      .mockResolvedValueOnce({ ...prisma.__sample })
      .mockResolvedValueOnce({ ...prisma.__sample, sourceCaseId: 'DEV_CHANGED' });
    const result = await createSampleLengthService(prisma).cutSampleLength({ sampleId: 'SMP_1', quantity: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SAMPLE_BUSINESS_CONTEXT_CONFLICT');
    expect(prisma.__tx.sample.update).not.toHaveBeenCalled();
    expect(prisma.__tx.sample.create).not.toHaveBeenCalled();
    expect(prisma.__movements).toEqual([]);
    expect(prisma.__tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('只关联明确面料档案可分割；先锁来源再锁样品，继承档案到子样', async () => {
    const prisma = makePrisma({
      sample: { ...yardageSample, sourceCaseId: null, productAssetId: 'PA_1', lengthQty: 20, lengthUnit: 'M' },
      sourceCases: [], sourceAssets: [{ id: 'PA_1', mainCategory: 'fabric', deletedAt: null, fabricProfile: { id: 'FP_1', deletedAt: null }, garmentProfile: null }],
    });
    const result = await createSampleLengthService(prisma).cutSampleLength({ sampleId: 'SMP_1', quantity: 3 });
    expect(result.ok).toBe(true);
    expect(prisma.__child().productAssetId).toBe('PA_1');
    const locks = prisma.__tx.$queryRaw.mock.calls.map(([query]: any[]) => query.text);
    expect(locks).toHaveLength(2);
    expect(locks[0]).toContain('FROM "ProductAsset"');
    expect(locks[1]).toContain('FROM "Sample"');
  });

  it('锁后的实际余量已降低 → 按新余量拒绝，不用旧读取覆盖库存', async () => {
    const prisma = makePrisma({ sample: { ...yardageSample, lengthQty: 20, lengthUnit: 'M' } });
    prisma.__tx.sample.findUnique
      .mockResolvedValueOnce({ ...prisma.__sample })
      .mockResolvedValueOnce({ ...prisma.__sample, lengthQty: 2 });
    const result = await createSampleLengthService(prisma).moveSampleLength({ sampleId: 'SMP_1', type: 'give', quantity: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('LENGTH_INSUFFICIENT');
    expect(prisma.__tx.sample.update).not.toHaveBeenCalled();
    expect(prisma.__movements).toEqual([]);
    expect(prisma.__tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('锁后样品已删除 → NOT_FOUND，不写入', async () => {
    const prisma = makePrisma({ sample: { ...yardageSample, lengthQty: 20, lengthUnit: 'M' } });
    prisma.__tx.sample.findUnique
      .mockResolvedValueOnce({ ...prisma.__sample })
      .mockResolvedValueOnce({ ...prisma.__sample, deletedAt: BigInt(1) });
    const result = await createSampleLengthService(prisma).moveSampleLength({ sampleId: 'SMP_1', type: 'borrow_in', quantity: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    expect(prisma.__tx.sample.update).not.toHaveBeenCalled();
    expect(prisma.__movements).toEqual([]);
    expect(prisma.__tx.auditLog.create).not.toHaveBeenCalled();
  });

  it.each(['to_bulk', 'to_resale'] as const)('通用 move 不允许 %s 绕开专用库存/计费事务', async (type) => {
    const prisma = makePrisma({ sample: { ...yardageSample, lengthQty: 20, lengthUnit: 'M' } });
    const result = await createSampleLengthService(prisma).moveSampleLength({ sampleId: 'SMP_1', type, quantity: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.__sample.lengthQty).toBe(20);
    expect(prisma.__movements).toEqual([]);
  });
  it('精确来源父集合在锁定时变化，拒绝分割且不建立子样或流水', async () => {
    const prisma = makePrisma({ sample: { ...yardageSample, lengthQty: 20, lengthUnit: 'M' } });
    prisma.__tx.sampleSource.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { sampleId: 'SMP_1', sampleBatchId: 'new-batch', sourceSnapshot: { batch: { caseId: 'new-case' } } },
    ]);
    const result = await createSampleLengthService(prisma).cutSampleLength({ sampleId: 'SMP_1', quantity: 3 });
    expect(result).toMatchObject({ ok: false, error: { code: 'SAMPLE_SOURCE_CHANGED', status: 409 } });
    expect(prisma.__tx.sample.create).not.toHaveBeenCalled();
    expect(prisma.__tx.sampleSource.create).not.toHaveBeenCalled();
    expect(prisma.__movements).toEqual([]);
    expect(prisma.__sample.lengthQty).toBe(20);
    expect(prisma.__tx.auditLog.create).not.toHaveBeenCalled();
  });
});
