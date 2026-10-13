import { describe, expect, it, vi } from 'vitest';
import { createMoqResolutionService, isGarmentFamily, isValidSnapshot } from '../moqResolutionService';
import { MOQ_FALLBACK_CONSTANTS, type MoqConfigService, type MoqSnapshot } from '../moqConfigService';

/**
 * MOQ §15.2 取数优先级 0→6 验收（DR-003 Capsule 豁免 + §2.3 不追溯快照口径）：
 *   0. capsuleExemption（仅成衣族）→ capsuleMoq
 *   1. 行级 moqOverride
 *   2. 产品档案标准 MOQ（FabricProfile.moqValue / GarmentProfile.moqValue+moqUnit）
 *   3. 工厂合同 factoryMoqValue → 客户协议 Relation.customerAgreementMoq
 *   4. CustomerTier.moqOverrideRatio × 档位值
 *   5. MoqThresholdConfig 系统配置（优先 writeOnce 快照口径）
 *   6. 代码兜底常量 800/200/20
 */

const SNAP: MoqSnapshot = {
  fabricDefaultMoq: 800,
  garmentDefaultMoq: 200,
  capsuleMoq: 20,
  snapshotAt: '2026-08-16T00:00:00.000Z',
  configId: 'MOQCFG__x',
  source: 'moq_config',
};

function makeConfigSvc(snapshot: MoqSnapshot = SNAP): MoqConfigService {
  return {
    getActiveConfig: vi.fn(),
    buildSnapshot: vi.fn().mockResolvedValue(snapshot),
    updateConfig: vi.fn(),
    listHistory: vi.fn(),
  } as unknown as MoqConfigService;
}

function makePrisma(opts: {
  fabricProfile?: any;
  garmentProfile?: any;
  relation?: any;
  customerTier?: any;
} = {}) {
  return {
    fabricProfile: {
      findUnique: vi.fn().mockResolvedValue(opts.fabricProfile ?? null),
    },
    garmentProfile: {
      findUnique: vi.fn().mockResolvedValue(opts.garmentProfile ?? null),
      findFirst: vi.fn().mockResolvedValue(opts.garmentProfile ?? null),
    },
    relation: {
      findUnique: vi.fn().mockResolvedValue(opts.relation ?? null),
    },
    customerTier: {
      findFirst: vi.fn().mockResolvedValue(opts.customerTier ?? null),
    },
  } as any;
}

describe('isGarmentFamily / isValidSnapshot 工具', () => {
  it('garment/capsule 为成衣族；fabric/other/null 不是', () => {
    expect(isGarmentFamily('garment')).toBe(true);
    expect(isGarmentFamily('Capsule')).toBe(true);
    expect(isGarmentFamily('fabric')).toBe(false);
    expect(isGarmentFamily(null)).toBe(false);
  });

  it('快照合法性：三档值均为有限正数', () => {
    expect(isValidSnapshot(SNAP)).toBe(true);
    expect(isValidSnapshot({})).toBe(false);
    expect(isValidSnapshot(null)).toBe(false);
    expect(isValidSnapshot({ ...SNAP, capsuleMoq: 0 })).toBe(false);
    expect(isValidSnapshot({ ...SNAP, fabricDefaultMoq: Number.NaN })).toBe(false);
  });
});

describe('resolveEffectiveMoq — 优先级链（§15.2）', () => {
  it('层级 0：成衣族 + capsuleExemption → capsuleMoq（DR-003 降级，非完全豁免）', async () => {
    const svc = createMoqResolutionService({ prisma: makePrisma(), configService: makeConfigSvc() });
    const r = await svc.resolveEffectiveMoq({ businessLine: 'garment', capsuleExemption: true, snapshot: SNAP });
    expect(r.effectiveMoq).toBe(20);
    expect(r.unit).toBe('PCS');
    expect(r.source).toBe('capsule_exemption');
    expect(r.capsuleActive).toBe(true);
  });

  it('层级 0 守卫：面料族 + capsuleExemption → 不命中 capsule 档（回退系统配置面料档）', async () => {
    const svc = createMoqResolutionService({ prisma: makePrisma(), configService: makeConfigSvc() });
    const r = await svc.resolveEffectiveMoq({ businessLine: 'fabric', capsuleExemption: true, snapshot: SNAP });
    expect(r.effectiveMoq).toBe(800);
    expect(r.unit).toBe('M');
    expect(r.source).toBe('moq_config');
    expect(r.capsuleActive).toBe(false);
  });

  it('层级 1：行级 moqOverride 优先于产品档案/协议/tier/配置', async () => {
    const prisma = makePrisma({ fabricProfile: { moqValue: 600, factoryMoqValue: 500 } });
    const svc = createMoqResolutionService({ prisma, configService: makeConfigSvc() });
    const r = await svc.resolveEffectiveMoq({
      businessLine: 'fabric', moqOverride: 300, productAssetId: 'PA-1', snapshot: SNAP,
    });
    expect(r.effectiveMoq).toBe(300);
    expect(r.source).toBe('line_override');
    expect(r.unit).toBe('M');
  });

  it('层级 2：面料产品档案 moqValue（hint 直给，不查 DB）', async () => {
    const svc = createMoqResolutionService({ prisma: makePrisma(), configService: makeConfigSvc() });
    const r = await svc.resolveEffectiveMoq({
      businessLine: 'fabric', fabricProfile: { moqValue: 600, factoryMoqValue: 500 }, snapshot: SNAP,
    });
    expect(r.effectiveMoq).toBe(600);
    expect(r.source).toBe('product_profile');
    expect(r.unit).toBe('M');
  });

  it('层级 2：成衣产品档案 moqValue + moqUnit（DB productAssetId 查询）', async () => {
    const prisma = makePrisma({ garmentProfile: { moqValue: 150, moqUnit: 'SET' } });
    const svc = createMoqResolutionService({ prisma, configService: makeConfigSvc() });
    const r = await svc.resolveEffectiveMoq({ businessLine: 'garment', productAssetId: 'PA-G1', snapshot: SNAP });
    expect(prisma.garmentProfile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productAssetId: 'PA-G1' } }),
    );
    expect(r.effectiveMoq).toBe(150);
    expect(r.unit).toBe('SET');
    expect(r.source).toBe('product_profile');
  });

  it('层级 3：面料档案 moqValue 缺失 → 工厂合同 factoryMoqValue', async () => {
    const svc = createMoqResolutionService({ prisma: makePrisma(), configService: makeConfigSvc() });
    const r = await svc.resolveEffectiveMoq({
      businessLine: 'fabric', fabricProfile: { moqValue: null, factoryMoqValue: 500 }, snapshot: SNAP,
    });
    expect(r.effectiveMoq).toBe(500);
    expect(r.source).toBe('factory_contract');
    expect(r.unit).toBe('M');
  });

  it('层级 3：客户协议 customerAgreementMoq（按族取键）', async () => {
    const prisma = makePrisma({
      relation: { customerAgreementMoq: { fabricDefaultMoq: 650, agreementRef: 'AGR-2026-001' } },
    });
    const svc = createMoqResolutionService({ prisma, configService: makeConfigSvc() });
    const r = await svc.resolveEffectiveMoq({ businessLine: 'fabric', customerRelationId: 'REL-1', snapshot: SNAP });
    expect(r.effectiveMoq).toBe(650);
    expect(r.source).toBe('customer_agreement');
    expect(r.detail?.agreementRef).toBe('AGR-2026-001');
  });

  it('层级 4：CustomerTier.moqOverrideRatio × 档位值（Platinum 0.7 × 800 = 560）', async () => {
    const prisma = makePrisma({ customerTier: { level: 'Platinum', moqOverrideRatio: 0.7 } });
    const svc = createMoqResolutionService({ prisma, configService: makeConfigSvc() });
    const r = await svc.resolveEffectiveMoq({ businessLine: 'fabric', customerRelationId: 'REL-1', snapshot: SNAP });
    expect(r.effectiveMoq).toBe(560);
    expect(r.source).toBe('customer_tier');
    expect(r.detail).toMatchObject({ tierLevel: 'Platinum', moqOverrideRatio: 0.7, tierBase: 800 });
  });

  it('层级 5：无任何命中 → 系统配置快照口径（成衣 200 / 面料 800）', async () => {
    const svc = createMoqResolutionService({ prisma: makePrisma(), configService: makeConfigSvc() });
    const garment = await svc.resolveEffectiveMoq({ businessLine: 'garment', snapshot: SNAP });
    expect(garment.effectiveMoq).toBe(200);
    expect(garment.source).toBe('moq_config');
    const fabric = await svc.resolveEffectiveMoq({ businessLine: 'fabric', snapshot: SNAP });
    expect(fabric.effectiveMoq).toBe(800);
  });

  it('§2.3 不追溯：ctx.snapshot 优先于实时配置（后台调阈值不影响存量单据）', async () => {
    const staleSnap: MoqSnapshot = { ...SNAP, fabricDefaultMoq: 999, configId: 'MOQCFG__old' };
    const liveConfigSvc = makeConfigSvc({ ...SNAP, fabricDefaultMoq: 800 });
    const svc = createMoqResolutionService({ prisma: makePrisma(), configService: liveConfigSvc });
    const r = await svc.resolveEffectiveMoq({ businessLine: 'fabric', snapshot: staleSnap });
    expect(r.effectiveMoq).toBe(999);
    expect(r.snapshot.configId).toBe('MOQCFG__old');
    expect(liveConfigSvc.buildSnapshot).not.toHaveBeenCalled();
  });

  it('非法快照（空 {}）→ 回退实时配置 buildSnapshot', async () => {
    const configSvc = makeConfigSvc();
    const svc = createMoqResolutionService({ prisma: makePrisma(), configService: configSvc });
    const r = await svc.resolveEffectiveMoq({ businessLine: 'fabric', snapshot: {} });
    expect(configSvc.buildSnapshot).toHaveBeenCalledTimes(1);
    expect(r.effectiveMoq).toBe(800);
  });

  it('层级 6：兜底常量（configService 返回 fallback_constant 快照）', async () => {
    const fallbackSnap: MoqSnapshot = {
      ...MOQ_FALLBACK_CONSTANTS,
      snapshotAt: '2026-08-16T00:00:00.000Z',
      configId: null,
      source: 'fallback_constant',
    };
    const svc = createMoqResolutionService({ prisma: makePrisma(), configService: makeConfigSvc(fallbackSnap) });
    const r = await svc.resolveEffectiveMoq({ businessLine: 'fabric', snapshot: null });
    expect(r.effectiveMoq).toBe(800);
    expect(r.source).toBe('fallback_constant');
    expect(r.snapshot.configId).toBeNull();
  });

  it('优先级顺序综合：override > 档案 > 工厂合同 > 协议 > tier > 配置（逐级缺失逐级降级）', async () => {
    // 有协议 + tier，但工厂合同命中 → 工厂合同优先
    const prisma = makePrisma({
      relation: { customerAgreementMoq: { fabricDefaultMoq: 650 } },
      customerTier: { level: 'Gold', moqOverrideRatio: 0.85 },
    });
    const svc = createMoqResolutionService({ prisma, configService: makeConfigSvc() });
    const r = await svc.resolveEffectiveMoq({
      businessLine: 'fabric',
      fabricProfile: { moqValue: null, factoryMoqValue: 500 },
      customerRelationId: 'REL-1',
      snapshot: SNAP,
    });
    expect(r.source).toBe('factory_contract');
    expect(r.effectiveMoq).toBe(500);

    // 无工厂合同、有协议 + tier → 协议优先
    const r2 = await svc.resolveEffectiveMoq({
      businessLine: 'fabric', customerRelationId: 'REL-1', snapshot: SNAP,
    });
    expect(r2.source).toBe('customer_agreement');
    expect(r2.effectiveMoq).toBe(650);

    // 无协议、tier 命中 → tier
    const prisma2 = makePrisma({ customerTier: { level: 'Gold', moqOverrideRatio: 0.85 } });
    const svc2 = createMoqResolutionService({ prisma: prisma2, configService: makeConfigSvc() });
    const r3 = await svc2.resolveEffectiveMoq({ businessLine: 'fabric', customerRelationId: 'REL-1', snapshot: SNAP });
    expect(r3.source).toBe('customer_tier');
    expect(r3.effectiveMoq).toBe(680); // 0.85 × 800
  });
});

describe('MOQ authoritative profile dependency failures', () => {
  it('does not replace a failed profile read with a lower default threshold', async () => {
    const prisma: any = { fabricProfile: { findUnique: vi.fn().mockRejectedValue(new Error('PRIVATE_SQL_BYTES')) } };
    const configService: any = { buildSnapshot: vi.fn().mockResolvedValue({ fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20, snapshotAt: '', configId: null, source: 'fallback_constant' }) };
    const service = createMoqResolutionService({ prisma, configService });
    await expect(service.resolveEffectiveMoq({ businessLine: 'fabric', productAssetId: 'actual-product' })).rejects.toMatchObject({ code: 'MOQ_SOURCE_UNAVAILABLE', message: 'MOQ 产品档案暂时无法核验' });
  });
});
