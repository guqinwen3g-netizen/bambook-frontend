import { describe, expect, it, vi } from 'vitest';
import {
  createMoqValidationService,
  isCapsuleEligible,
  MOQ_CAPSULE_NOT_ALLOWED,
  MOQ_LINE_OVERRIDE_SCOPE,
  MOQ_ORDER_NOT_FOUND,
} from '../moqValidationService';
import { MOQ_SCOPE_DENIED, type MoqConfigService, type MoqSnapshot } from '../moqConfigService';
import { createMoqResolutionService } from '../moqResolutionService';
import type { ApprovalCreateService } from '../../approvals/approvalCreateService';

/**
 * MOQ 校验服务验收（§15.2 缺口分级 / §15.3 权限链 / §X 变更门禁 fail-closed / DR-007 审批链）：
 *   validateCreate：Capsule 门禁 + override scope 门禁 + 逐行缺口判定（gapPct/severity/badge）+ 豁免审批单
 *   validatePatch：Confirmed+ 数量跌破 MOQ → blocked + 自动审批单；回升合规 → 自动取消挂起单
 */

const SNAP: MoqSnapshot = {
  fabricDefaultMoq: 800,
  garmentDefaultMoq: 200,
  capsuleMoq: 20,
  snapshotAt: '2026-08-16T00:00:00.000Z',
  configId: 'MOQCFG__x',
  source: 'moq_config',
};

function makeConfigSvc(): MoqConfigService {
  return {
    getActiveConfig: vi.fn(),
    buildSnapshot: vi.fn().mockResolvedValue(SNAP),
    updateConfig: vi.fn(),
    listHistory: vi.fn(),
  } as unknown as MoqConfigService;
}

function makeApprovalSvc(opts: { fail?: boolean } = {}): ApprovalCreateService {
  return {
    createBusinessApproval: opts.fail
      ? vi.fn().mockRejectedValue(new Error('NO_REVIEWER_RESOLVED'))
      : vi.fn().mockResolvedValue({ id: 'AR-MOQ-1' }),
  } as unknown as ApprovalCreateService;
}

function makeSvc(opts: {
  order?: any; orderLines?: any[]; orderLines?: any[];
  approvalFail?: boolean;
  pendingApprovals?: any[];
} = {}) {
  const configService = makeConfigSvc();
  const prisma: any = {
    orderLine: { findMany: vi.fn().mockResolvedValue(opts.orderLines ?? []) },
    quotation: { findFirst: vi.fn().mockResolvedValue(null) },
    productAsset: { findMany: vi.fn().mockResolvedValue([]) },
    userAccount: { findFirst: vi.fn().mockImplementation(async ({where}: any) => ({id: where.id, status: 'active', deletedAt: null, roles: [], primaryDepartment: null})) },
    userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
    order: {
      findUnique: vi.fn().mockResolvedValue(opts.order ?? null),
    },
    approvalRequest: {
      findMany: vi.fn().mockResolvedValue(opts.pendingApprovals ?? []),
      // 模拟真实 updateMany：count 按 where.id.in 命中数返回
      updateMany: vi.fn().mockImplementation(async ({ where }: any) => ({ count: where?.id?.in?.length ?? 0 })),
    },
    // resolution 依赖的档案查询：默认全部未命中（落系统配置档）
    fabricProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    garmentProfile: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) },
    relation: { findUnique: vi.fn().mockResolvedValue(null) },
    customerTier: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const resolutionService = createMoqResolutionService({ prisma, configService });
  const approvalCreateService = makeApprovalSvc({ fail: opts.approvalFail });
  const validationService = createMoqValidationService({
    prisma, configService, resolutionService, approvalCreateService,
  });
  return { validationService, prisma, approvalCreateService };
}

describe('isCapsuleEligible（§6 #0：仅成衣订单可勾选）', () => {
  it('businessLine=garment/capsule 或 type=Garment → true；面料 → false', () => {
    expect(isCapsuleEligible({ businessLine: 'garment' })).toBe(true);
    expect(isCapsuleEligible({ businessLine: 'capsule' })).toBe(true);
    expect(isCapsuleEligible({ type: 'Garment' })).toBe(true);
    expect(isCapsuleEligible({ type: 'Fabric', businessLine: 'fabric' })).toBe(false);
  });
});

describe('validateCreate — 门禁（fail-closed）', () => {
  it('面料订单勾选 capsuleExemption → CAPSULE_NOT_ALLOWED', async () => {
    const { validationService } = makeSvc();
    await expect(
      validationService.validateCreate(
        { type: 'Fabric', businessLine: 'fabric', capsuleExemption: true, lines: [{ quantity: 900 , unit: 'M' }] },
        { actor: { userId: 'u1', roles: ['sales'] } },
      ),
    ).rejects.toMatchObject({ code: MOQ_CAPSULE_NOT_ALLOWED });
  });

  it('行级 moqOverride 无 scope（finance 角色）→ SCOPE_DENIED（B6 越权守卫）', async () => {
    const { validationService } = makeSvc();
    await expect(
      validationService.validateCreate(
        { businessLine: 'fabric', lines: [{ quantity: 900, moqOverride: 300 , unit: 'M' }] },
        { actor: { userId: 'u_fin', roles: ['finance'] } },
      ),
    ).rejects.toMatchObject({ code: MOQ_SCOPE_DENIED });
  });

  it('行级 moqOverride 未登录 actor → SCOPE_DENIED', async () => {
    const { validationService } = makeSvc();
    await expect(
      validationService.validateCreate(
        { businessLine: 'fabric', lines: [{ quantity: 900, moqOverride: 300 , unit: 'M' }] },
        { actor: null },
      ),
    ).rejects.toMatchObject({ code: MOQ_SCOPE_DENIED });
  });

  it('行级 moqOverride 持 scope（业务员 sales 为 DR-007 申请侧）→ 放行', async () => {
    const { validationService } = makeSvc();
    const r = await validationService.validateCreate(
      { businessLine: 'fabric', lines: [{ quantity: 300, moqOverride: 300 , unit: 'M' }] },
      { actor: { userId: 'u_sales', roles: ['sales'] } },
    );
    expect(r.ok).toBe(true);
    expect(r.lines[0].source).toBe('line_override');
    expect(r.lines[0].effectiveMoq).toBe(300);
  });

  it('quantity 非正数 → MOQ_INVALID_VALUE', async () => {
    const { validationService } = makeSvc();
    await expect(
      validationService.validateCreate({ businessLine: 'fabric', lines: [{ quantity: 0 , unit: 'M' }] }),
    ).rejects.toMatchObject({ code: 'MOQ_INVALID_VALUE' });
  });
});

describe('validateCreate — 逐行缺口判定（§15.2 缺口分级）', () => {
  it('合规行：qty ≥ MOQ → compliant + severity none + badge none', async () => {
    const { validationService } = makeSvc();
    const r = await validationService.validateCreate(
      { businessLine: 'fabric', snapshot: SNAP, lines: [{ quantity: 800 , unit: 'M' }] },
    );
    expect(r.ok).toBe(true);
    expect(r.blockedLineIndexes).toEqual([]);
    expect(r.lines[0]).toMatchObject({ compliant: true, gapPct: 0, severity: 'none', badge: 'none', effectiveMoq: 800 });
  });

  it('缺口 ≤50% → severity low + badge yellow（qty 500 / MOQ 800，gap 37.5%）', async () => {
    const { validationService } = makeSvc();
    const r = await validationService.validateCreate(
      { businessLine: 'fabric', snapshot: SNAP, lines: [{ quantity: 500 , unit: 'M' }] },
    );
    expect(r.ok).toBe(false);
    expect(r.blockedLineIndexes).toEqual([0]);
    expect(r.lines[0]).toMatchObject({ compliant: false, gapPct: 37.5, severity: 'low', badge: 'yellow', requiresApproval: true });
  });

  it('缺口 50-80% → severity medium + badge red（qty 300 / MOQ 800，gap 62.5%）', async () => {
    const { validationService } = makeSvc();
    const r = await validationService.validateCreate(
      { businessLine: 'fabric', snapshot: SNAP, lines: [{ quantity: 300 , unit: 'M' }] },
    );
    expect(r.lines[0]).toMatchObject({ gapPct: 62.5, severity: 'medium', badge: 'red' });
  });

  it('缺口 >80% → severity high（qty 100 / MOQ 800，gap 87.5%）', async () => {
    const { validationService } = makeSvc();
    const r = await validationService.validateCreate(
      { businessLine: 'fabric', snapshot: SNAP, lines: [{ quantity: 100 , unit: 'M' }] },
    );
    expect(r.lines[0]).toMatchObject({ gapPct: 87.5, severity: 'high', badge: 'red' });
  });

  it('混合行：逐行独立判定，blockedLineIndexes 仅含不合规行', async () => {
    const { validationService } = makeSvc();
    const r = await validationService.validateCreate(
      {
        businessLine: 'fabric',
        snapshot: SNAP,
        lines: [{ quantity: 900 , unit: 'M' }, { quantity: 100 , unit: 'M' }, { quantity: 800 , unit: 'M' }],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.blockedLineIndexes).toEqual([1]);
  });

  it('行级 businessLine 优先于单据级（报价混合单位场景：PCS 行按成衣档 200 判定）', async () => {
    const { validationService } = makeSvc();
    const r = await validationService.validateCreate(
      {
        snapshot: SNAP,
        lines: [
          { quantity: 150, unit: 'PCS', businessLine: 'garment' }, // 150 < 200 → blocked
          { quantity: 900, unit: 'M', businessLine: 'fabric' },     // 900 ≥ 800 → ok
        ],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.blockedLineIndexes).toEqual([0]);
    expect(r.lines[0].effectiveMoq).toBe(200);
    expect(r.lines[1].effectiveMoq).toBe(800);
  });

  it('成衣 + capsuleExemption → capsuleActive + 审计字段（DR-003）；qty ≥ capsuleMoq 即合规', async () => {
    const { validationService } = makeSvc();
    const r = await validationService.validateCreate(
      { type: 'Garment', businessLine: 'garment', capsuleExemption: true, snapshot: SNAP, lines: [{ quantity: 25 , unit: 'PC' }] },
      { actor: { userId: 'u_sales', roles: ['sales'] } },
    );
    expect(r.ok).toBe(true); // 25 ≥ 20（capsule 档）
    expect(r.capsuleActive).toBe(true);
    expect(r.capsuleExemptionBy).toBe('u_sales');
    expect(typeof r.capsuleExemptionAt).toBe('string');
    expect(r.lines[0].source).toBe('capsule_exemption');
  });

  it('成衣 + capsuleExemption 但 qty < capsuleMoq → 仍需审批（DR-003 非完全豁免）', async () => {
    const { validationService } = makeSvc();
    const r = await validationService.validateCreate(
      { type: 'Garment', businessLine: 'garment', capsuleExemption: true, snapshot: SNAP, lines: [{ quantity: 15 , unit: 'PC' }] },
      { actor: { userId: 'u_sales', roles: ['sales'] } },
    );
    expect(r.ok).toBe(false);
    expect(r.lines[0].effectiveMoq).toBe(20);
    expect(r.lines[0].requiresApproval).toBe(true);
  });
});

describe('validateCreate — 豁免审批链（DR-007，autoCreateApproval）', () => {
  it('低于 MOQ + autoCreateApproval → 经 approvalCreateService 建单（policyKey=moq_exemption + hitConditions）', async () => {
    const { validationService, approvalCreateService } = makeSvc();
    const r = await validationService.validateCreate(
      { businessLine: 'fabric', snapshot: SNAP, lines: [{ quantity: 100 , unit: 'M' }] },
      { actor: { userId: 'u_sales', roles: ['sales'] }, autoCreateApproval: true, targetType: 'Order', targetId: 'O-1' },
    );
    expect(approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
    const call = (approvalCreateService.createBusinessApproval as any).mock.calls[0][0];
    expect(call).toMatchObject({
      requesterId: 'u_sales',
      actionType: 'order:moq-exemption',
      targetType: 'Order',
      targetId: 'O-1',
      risk: 'high', // gap 87.5% > 80%
    });
    expect(call.payload.policyKey).toBe('moq_exemption');
    expect(call.payload.reason).toBe('below_moq_on_save');
    expect(call.payload.hitConditions).toContain('fabric_default_moq');
    expect(call.payload.hitConditions).toContain('gap_gt80pct');
    expect(r.approvalRequestId).toBe('AR-MOQ-1');
  });

  it('报价单豁免 → actionType=quotation:moq-exemption', async () => {
    const { validationService, approvalCreateService } = makeSvc();
    await validationService.validateCreate(
      { businessLine: 'fabric', snapshot: SNAP, lines: [{ quantity: 100 , unit: 'M' }] },
      { actor: { userId: 'u1' }, autoCreateApproval: true, targetType: 'Quotation', targetId: 'Q-1' },
    );
    expect((approvalCreateService.createBusinessApproval as any).mock.calls[0][0].actionType).toBe('quotation:moq-exemption');
  });

  it('审批创建失败不静默放行：ok=false 保持 + approvalError 记录（§6 #1 异常分支）', async () => {
    const { validationService } = makeSvc({ approvalFail: true });
    const r = await validationService.validateCreate(
      { businessLine: 'fabric', snapshot: SNAP, lines: [{ quantity: 100 , unit: 'M' }] },
      { actor: { userId: 'u1' }, autoCreateApproval: true },
    );
    expect(r.ok).toBe(false);
    expect(r.approvalRequestId).toBeUndefined();
    expect(r.approvalError).toContain('NO_REVIEWER_RESOLVED');
  });

  it('合规时不建审批单', async () => {
    const { validationService, approvalCreateService } = makeSvc();
    await validationService.validateCreate(
      { businessLine: 'fabric', snapshot: SNAP, lines: [{ quantity: 900 , unit: 'M' }] },
      { actor: { userId: 'u1' }, autoCreateApproval: true },
    );
    expect(approvalCreateService.createBusinessApproval).not.toHaveBeenCalled();
  });
});

describe('validatePatch — §X 变更门禁（Confirmed+ fail-closed）', () => {
  const confirmedOrder = {
    id: 'O-1', status: 'Confirmed', type: 'Fabric', businessLine: 'fabric',
    capsuleExemption: false, moqSnapshot: SNAP, customerRelationId: null,
  };

  it('订单不存在 → MOQ_ORDER_NOT_FOUND', async () => {
    const { validationService } = makeSvc({ order: null , orderLines: [{ id: 'actual-test-line', quantity: '100', unit: 'M' }] });
    await expect(
      validationService.validatePatch({ orderId: 'O-X', beforeQty: 900, afterQty: 100, actorId: 'u1' }),
    ).rejects.toMatchObject({ code: MOQ_ORDER_NOT_FOUND });
  });

  it('Pending 订单数量变更 → not_applicable（不触发重算）', async () => {
    const { validationService } = makeSvc({ order: { ...confirmedOrder, status: 'Pending' } , orderLines: [{ id: 'actual-test-line', quantity: '100', unit: 'M' }] });
    const r = await validationService.validatePatch({ orderId: 'O-1', beforeQty: 900, afterQty: 100, actorId: 'u1' });
    expect(r).toMatchObject({ blocked: false, reason: 'not_applicable' });
  });

  it('Confirmed 订单 900→100 跌破 MOQ 800 → blocked + 自动豁免审批单（X.2）', async () => {
    const { validationService, approvalCreateService } = makeSvc({ order: confirmedOrder , orderLines: [{ id: 'actual-test-line', quantity: '100', unit: 'M' }] });
    const r = await validationService.validatePatch({ orderId: 'O-1', beforeQty: 900, afterQty: 100, actorId: 'u_sales' });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('below_threshold');
    expect(r.effectiveMoq).toBe(800);
    expect(r.approvalRequestId).toBe('AR-MOQ-1');
    const call = (approvalCreateService.createBusinessApproval as any).mock.calls[0][0];
    expect(call.payload).toMatchObject({ reason: 'qty_change_below_moq', moqBasisVersion: 1, moqBasis: { lines: [expect.objectContaining({ quantity: '100', threshold: '800', unit: 'M', thresholdUnit: 'M' })] } });
  });

  it('跌破时审批单创建失败 → blocked 仍为 true + approvalError（fail-closed 不静默放行）', async () => {
    const { validationService } = makeSvc({ order: confirmedOrder, approvalFail: true , orderLines: [{ id: 'actual-test-line', quantity: '100', unit: 'M' }] });
    const r = await validationService.validatePatch({ orderId: 'O-1', beforeQty: 900, afterQty: 100, actorId: 'u1' });
    expect(r.blocked).toBe(true);
    expect(r.approvalError).toContain('NO_REVIEWER_RESOLVED');
  });

  it('数量回升合规（100→900）→ restored_compliance + 自动取消挂起的 qty_change_below_moq 单（X.3）', async () => {
    const pending = [
      { id: 'AR-1', payload: { reason: 'qty_change_below_moq' } },
      { id: 'AR-2', payload: { reason: 'below_moq_on_save' } }, // 非变更类，不取消
    ];
    const { validationService, prisma } = makeSvc({ order: confirmedOrder, pendingApprovals: pending , orderLines: [{ id: 'actual-test-line', quantity: '900', unit: 'M' }] });
    const r = await validationService.validatePatch({ orderId: 'O-1', beforeQty: 100, afterQty: 900, actorId: 'u1' });
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe('restored_compliance');
    expect(r.cancelledCount).toBe(1);
    expect(prisma.approvalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['AR-1'] }, status: 'pending' },
      data: { status: 'cancelled' },
    });
  });

  it('变更前后均低于 MOQ（100→50）→ still_below_threshold，不能沿用其他数量的批准依据', async () => {
    const { validationService, approvalCreateService } = makeSvc({ order: confirmedOrder , orderLines: [{ id: 'actual-test-line', quantity: '50', unit: 'M' }] });
    const r = await validationService.validatePatch({ orderId: 'O-1', beforeQty: 100, afterQty: 50, actorId: 'u1' });
    expect(r).toMatchObject({ blocked: true, reason: 'still_below_threshold' });
    expect(approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
  });

  it('快照口径优先：Order.moqSnapshot=999 时按 999 判定（不追溯实时配置 800）', async () => {
    const order = { ...confirmedOrder, moqSnapshot: { ...SNAP, fabricDefaultMoq: 999 } };
    const { validationService } = makeSvc({ order , orderLines: [{ id: 'actual-test-line', quantity: '900', unit: 'M' }] });
    const r = await validationService.validatePatch({ orderId: 'O-1', beforeQty: 1000, afterQty: 900, actorId: 'u1' });
    expect(r.blocked).toBe(true); // 900 < 999（快照口径），按实时配置 800 则合规
    expect(r.effectiveMoq).toBe(999);
  });

  it('capsule 订单快照口径：Confirmed 成衣 + capsuleExemption → 按 capsuleMoq 20 判定', async () => {
    const order = { ...confirmedOrder, type: 'Garment', businessLine: 'garment', capsuleExemption: true };
    const { validationService } = makeSvc({ order , orderLines: [{ id: 'actual-test-line', quantity: '15', unit: 'M' }] });
    const r = await validationService.validatePatch({ orderId: 'O-1', beforeQty: 30, afterQty: 15, actorId: 'u1' });
    expect(r.blocked).toBe(true);
    expect(r.effectiveMoq).toBe(20);
    expect(r.capsuleActive).toBe(true);
  });
});

describe('MOQ unresolved actual unit basis', () => {
  it.each([undefined, 'SET', 'KG', 'BOX'])('cannot approve an unresolved %s unit using the fabric default', async unit => {
    const { validationService, approvalCreateService } = makeSvc();
    const result = await validationService.validateCreate({ type: 'Fabric', snapshot: SNAP, lines: [{ quantity: '900', unit }] },
      { actor: { userId: 'u1' }, autoCreateApproval: true, targetType: 'Order', targetId: 'actual-order' });
    expect(result.ok).toBe(false);
    expect(result.lines[0].unresolvedReason).toBeTruthy();
    expect(approvalCreateService.createBusinessApproval).not.toHaveBeenCalled();
  });
  it('quantity changes without actual order lines cannot infer a proportional MOQ plan', async () => {
    const { validationService, approvalCreateService } = makeSvc({ order: { id: 'legacy', status: 'Confirmed', type: 'Fabric', moqSnapshot: SNAP } });
    expect(await validationService.validatePatch({ orderId: 'legacy', beforeQty: 100, afterQty: 50, actorId: 'u1' })).toMatchObject({ blocked: true, reason: 'still_below_threshold' });
    expect(approvalCreateService.createBusinessApproval).not.toHaveBeenCalled();
  });
});
