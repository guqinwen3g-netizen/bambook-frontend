import { describe, expect, it, vi } from 'vitest';
import {
  createMoqValidationService,
  MOQ_ORDER_NOT_FOUND,
} from '../moqValidationService';
import { type MoqConfigService, type MoqSnapshot } from '../moqConfigService';
import { createMoqResolutionService } from '../moqResolutionService';
import type { ApprovalCreateService } from '../../approvals/approvalCreateService';

/**
 * W1 MOQ 双触发回归测试（新增独立文件，禁止修改既有文件）
 *
 * 覆盖点（增量于既有 moqValidationService.test.ts）：
 *   1. validateCreate — businessLine 四值全覆盖（fabric/garment/capsule/other）+ 阈值正确性
 *   2. validatePatch — 从 Order 字段读取 businessLine 的分层重判矩阵
 *   3. 变更时 hitConditions 正确性（fabric_default_moq / garment_default_moq / capsule_moq + gap 分级）
 *   4. 非适用状态（Draft/Cancelled）与边界（前后均低于、回升合规、快照口径优先）
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

function makeApprovalSvc(): ApprovalCreateService {
  return {
    createBusinessApproval: vi.fn().mockResolvedValue({ id: 'AR-MOQ-1' }),
  } as unknown as ApprovalCreateService;
}

function makeSvc(opts: { order?: any; orderLines?: any[]; orderLines?: any[]; pendingApprovals?: any[] } = {}) {
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
      updateMany: vi.fn().mockImplementation(async ({ where }: any) => ({
        count: where?.id?.in?.length ?? 0,
      })),
    },
    fabricProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    garmentProfile: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    relation: { findUnique: vi.fn().mockResolvedValue(null) },
    customerTier: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const resolutionService = createMoqResolutionService({ prisma, configService });
  const approvalCreateService = makeApprovalSvc();
  const validationService = createMoqValidationService({
    prisma, configService, resolutionService, approvalCreateService,
  });
  return { validationService, prisma, approvalCreateService };
}

describe('MOQ 双触发回归：businessLine 分层矩阵（validateCreate + validatePatch）', () => {
  // ═══════════════════════════════════════════════════════════════
  // validateCreate 路径
  // ═══════════════════════════════════════════════════════════════
  describe('validateCreate — businessLine 四值全覆盖 + 阈值正确性', () => {
    it('fabric 档：qty=900 ≥ 800 → ok；qty=700 < 800 → blocked', async () => {
      const { validationService } = makeSvc();
      const ok = await validationService.validateCreate({
        businessLine: 'fabric', snapshot: SNAP, lines: [{ quantity: 900 , unit: 'M' }],
      });
      expect(ok.ok).toBe(true);
      expect(ok.lines[0].effectiveMoq).toBe(800);

      const blocked = await validationService.validateCreate({
        businessLine: 'fabric', snapshot: SNAP, lines: [{ quantity: 700 , unit: 'M' }],
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.lines[0].effectiveMoq).toBe(800);
    });

    it('garment 档：qty=250 ≥ 200 → ok；qty=150 < 200 → blocked', async () => {
      const { validationService } = makeSvc();
      const ok = await validationService.validateCreate({
        businessLine: 'garment', snapshot: SNAP, lines: [{ quantity: 250 , unit: 'PC' }],
      });
      expect(ok.ok).toBe(true);
      expect(ok.lines[0].effectiveMoq).toBe(200);

      const blocked = await validationService.validateCreate({
        businessLine: 'garment', snapshot: SNAP, lines: [{ quantity: 150 , unit: 'PC' }],
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.lines[0].effectiveMoq).toBe(200);
    });

    it('capsule 档（garment族+capsuleExemption）：qty=25 ≥ 20 → ok；qty=15 < 20 → blocked', async () => {
      const { validationService } = makeSvc();
      const ok = await validationService.validateCreate({
        type: 'Garment', businessLine: 'garment', capsuleExemption: true,
        snapshot: SNAP, lines: [{ quantity: 25 , unit: 'PC' }],
      });
      expect(ok.ok).toBe(true);
      expect(ok.capsuleActive).toBe(true);
      expect(ok.lines[0].effectiveMoq).toBe(20);

      const blocked = await validationService.validateCreate({
        type: 'Garment', businessLine: 'garment', capsuleExemption: true,
        snapshot: SNAP, lines: [{ quantity: 15 , unit: 'PC' }],
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.lines[0].effectiveMoq).toBe(20);
    });

    it('capsule businessLine 本身 + capsuleExemption → 按 capsuleMoq 判定', async () => {
      const { validationService } = makeSvc();
      const ok = await validationService.validateCreate({
        type: 'Garment', businessLine: 'capsule', capsuleExemption: true,
        snapshot: SNAP, lines: [{ quantity: 25 , unit: 'PC' }],
      });
      expect(ok.ok).toBe(true);
      expect(ok.lines[0].effectiveMoq).toBe(20);
    });

    it('businessLine=null + type=Garment → derive 为 garment → 按 garmentDefaultMoq 200', async () => {
      const { validationService } = makeSvc();
      const r = await validationService.validateCreate({
        type: 'Garment', businessLine: null, snapshot: SNAP, lines: [{ quantity: 250 , unit: 'PC' }],
      });
      expect(r.ok).toBe(true);
      expect(r.lines[0].effectiveMoq).toBe(200);
    });

    it('businessLine=other → 按 fabricDefaultMoq 800（other 非成衣族）', async () => {
      const { validationService } = makeSvc();
      const r = await validationService.validateCreate({
        type: 'Garment', businessLine: 'other', snapshot: SNAP, lines: [{ quantity: 900 , unit: 'M' }],
      });
      expect(r.ok).toBe(true);
      expect(r.lines[0].effectiveMoq).toBe(800);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // validatePatch 路径 — 从 Order 字段读取 businessLine 分层重判
  // ═══════════════════════════════════════════════════════════════
  describe('validatePatch — businessLine 分层重判（从 Order 字段读取）', () => {
    it('order businessLine=fabric → 按 fabricDefaultMoq 800 判定（before≥after< → blocked）', async () => {
      const { validationService, approvalCreateService } = makeSvc({
        order: {
          id: 'O-1', status: 'Confirmed', type: 'Fabric', businessLine: 'fabric',
          capsuleExemption: false, moqSnapshot: SNAP, customerRelationId: null,
        },
       orderLines: [{ id: 'actual-test-line', quantity: '100', unit: 'M' }] });
      const r = await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 900, afterQty: 100, actorId: 'u1',
      });
      expect(r.blocked).toBe(true);
      expect(r.effectiveMoq).toBe(800);
      expect(r.capsuleActive).toBe(false);
      expect(approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
    });

    it('order businessLine=garment → 按 garmentDefaultMoq 200 判定', async () => {
      const { validationService, approvalCreateService } = makeSvc({
        order: {
          id: 'O-1', status: 'Confirmed', type: 'Garment', businessLine: 'garment',
          capsuleExemption: false, moqSnapshot: SNAP, customerRelationId: null,
        },
       orderLines: [{ id: 'actual-test-line', quantity: '80', unit: 'PC' }] });
      const r = await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 300, afterQty: 80, actorId: 'u1',
      });
      expect(r.blocked).toBe(true);
      expect(r.effectiveMoq).toBe(200);
      expect(r.capsuleActive).toBe(false);
      expect(approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
    });

    it('order businessLine=capsule + capsuleExemption → 按 capsuleMoq 20 判定', async () => {
      const { validationService, approvalCreateService } = makeSvc({
        order: {
          id: 'O-1', status: 'Confirmed', type: 'Garment', businessLine: 'capsule',
          capsuleExemption: true, moqSnapshot: SNAP, customerRelationId: null,
        },
       orderLines: [{ id: 'actual-test-line', quantity: '15', unit: 'PC' }] });
      const r = await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 30, afterQty: 15, actorId: 'u1',
      });
      expect(r.blocked).toBe(true);
      expect(r.effectiveMoq).toBe(20);
      expect(r.capsuleActive).toBe(true);
      expect(approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
    });

    it('order businessLine=null + type=Garment → derive 为 garment → 按 200 判定', async () => {
      const { validationService, approvalCreateService } = makeSvc({
        order: {
          id: 'O-1', status: 'Confirmed', type: 'Garment', businessLine: null,
          capsuleExemption: false, moqSnapshot: SNAP, customerRelationId: null,
        },
       orderLines: [{ id: 'actual-test-line', quantity: '80', unit: 'PC' }] });
      const r = await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 300, afterQty: 80, actorId: 'u1',
      });
      expect(r.blocked).toBe(true);
      expect(r.effectiveMoq).toBe(200);
      expect(r.capsuleActive).toBe(false);
      expect(approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
    });

    it('order businessLine=null + type=Fabric → derive 为 fabric → 按 800 判定', async () => {
      const { validationService, approvalCreateService } = makeSvc({
        order: {
          id: 'O-1', status: 'Confirmed', type: 'Fabric', businessLine: null,
          capsuleExemption: false, moqSnapshot: SNAP, customerRelationId: null,
        },
       orderLines: [{ id: 'actual-test-line', quantity: '700', unit: 'M' }] });
      const r = await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 900, afterQty: 700, actorId: 'u1',
      });
      expect(r.blocked).toBe(true);
      expect(r.effectiveMoq).toBe(800);
      expect(r.capsuleActive).toBe(false);
      expect(approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
    });

    it('快照口径优先：fabricDefaultMoq 999（覆盖实时 800）', async () => {
      const order = {
        id: 'O-1', status: 'Confirmed', type: 'Fabric', businessLine: 'fabric',
        capsuleExemption: false,
        moqSnapshot: { ...SNAP, fabricDefaultMoq: 999 },
        customerRelationId: null,
      };
      const { validationService, approvalCreateService } = makeSvc({ order , orderLines: [{ id: 'actual-test-line', quantity: '900', unit: 'M' }] });
      const r = await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 1000, afterQty: 900, actorId: 'u1',
      });
      expect(r.blocked).toBe(true);
      expect(r.effectiveMoq).toBe(999);
      expect(approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
    });

    it('garment 快照口径：garmentDefaultMoq 250（覆盖实时 200）', async () => {
      const order = {
        id: 'O-1', status: 'Confirmed', type: 'Garment', businessLine: 'garment',
        capsuleExemption: false,
        moqSnapshot: { ...SNAP, garmentDefaultMoq: 250 },
        customerRelationId: null,
      };
      const { validationService, approvalCreateService } = makeSvc({ order , orderLines: [{ id: 'actual-test-line', quantity: '240', unit: 'PC' }] });
      const r = await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 300, afterQty: 240, actorId: 'u1',
      });
      expect(r.blocked).toBe(true);
      expect(r.effectiveMoq).toBe(250);
      expect(approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 变更时 hitConditions 正确性
  // ═══════════════════════════════════════════════════════════════
  describe('validatePatch — 变更时分层判定与 hitConditions 正确性', () => {
    it('fabric 档跌破 → hitConditions 含 fabric_default_moq + gap_gt80pct', async () => {
      const { validationService, approvalCreateService } = makeSvc({
        order: {
          id: 'O-1', status: 'Confirmed', type: 'Fabric', businessLine: 'fabric',
          capsuleExemption: false, moqSnapshot: SNAP, customerRelationId: null,
        },
       orderLines: [{ id: 'actual-test-line', quantity: '100', unit: 'M' }] });
      // gap = (800-100)/800 = 87.5% → high
      await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 900, afterQty: 100, actorId: 'u1',
      });
      const payload = (approvalCreateService.createBusinessApproval as any).mock.calls[0][0].payload;
      expect(payload.hitConditions).toContain('fabric_default_moq');
      expect(payload.hitConditions).toContain('gap_gt80pct');
    });

    it('garment 档跌破 → hitConditions 含 garment_default_moq + gap_50_80pct', async () => {
      const { validationService, approvalCreateService } = makeSvc({
        order: {
          id: 'O-1', status: 'Confirmed', type: 'Garment', businessLine: 'garment',
          capsuleExemption: false, moqSnapshot: SNAP, customerRelationId: null,
        },
       orderLines: [{ id: 'actual-test-line', quantity: '80', unit: 'PC' }] });
      // gap = (200-80)/200 = 60% → medium
      await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 300, afterQty: 80, actorId: 'u1',
      });
      const payload = (approvalCreateService.createBusinessApproval as any).mock.calls[0][0].payload;
      expect(payload.hitConditions).toContain('garment_default_moq');
      expect(payload.hitConditions).toContain('gap_50_80pct');
    });

    it('capsule 档跌破 → hitConditions 含 capsule_moq + gap_lt50pct', async () => {
      const { validationService, approvalCreateService } = makeSvc({
        order: {
          id: 'O-1', status: 'Confirmed', type: 'Garment', businessLine: 'capsule',
          capsuleExemption: true, moqSnapshot: SNAP, customerRelationId: null,
        },
       orderLines: [{ id: 'actual-test-line', quantity: '15', unit: 'PC' }] });
      // gap = (20-15)/20 = 25% → low
      await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 30, afterQty: 15, actorId: 'u1',
      });
      const payload = (approvalCreateService.createBusinessApproval as any).mock.calls[0][0].payload;
      expect(payload.hitConditions).toContain('capsule_moq');
      expect(payload.hitConditions).toContain('gap_lt50pct');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 边界与非适用状态
  // ═══════════════════════════════════════════════════════════════
  describe('validatePatch — 非适用状态与边界', () => {
    it('订单不存在 → MOQ_ORDER_NOT_FOUND（rejects）', async () => {
      const { validationService } = makeSvc({ order: null , orderLines: [{ id: 'actual-test-line', quantity: '100', unit: 'M' }] });
      await expect(
        validationService.validatePatch({
          orderId: 'O-X', beforeQty: 900, afterQty: 100, actorId: 'u1',
        }),
      ).rejects.toMatchObject({ code: MOQ_ORDER_NOT_FOUND });
    });

    it('Draft 订单 → not_applicable（不触发）', async () => {
      const { validationService, approvalCreateService } = makeSvc({
        order: {
          id: 'O-1', status: 'Draft', type: 'Fabric', businessLine: 'fabric',
          capsuleExemption: false, moqSnapshot: SNAP, customerRelationId: null,
        },
       orderLines: [{ id: 'actual-test-line', quantity: '100', unit: 'M' }] });
      const r = await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 900, afterQty: 100, actorId: 'u1',
      });
      expect(r.blocked).toBe(false);
      expect(r.reason).toBe('not_applicable');
      expect(approvalCreateService.createBusinessApproval).not.toHaveBeenCalled();
    });

    it('Cancelled 订单 → not_applicable', async () => {
      const { validationService, approvalCreateService } = makeSvc({
        order: {
          id: 'O-1', status: 'Cancelled', type: 'Fabric', businessLine: 'fabric',
          capsuleExemption: false, moqSnapshot: SNAP, customerRelationId: null,
        },
       orderLines: [{ id: 'actual-test-line', quantity: '100', unit: 'M' }] });
      const r = await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 900, afterQty: 100, actorId: 'u1',
      });
      expect(r.blocked).toBe(false);
      expect(r.reason).toBe('not_applicable');
      expect(approvalCreateService.createBusinessApproval).not.toHaveBeenCalled();
    });

    it('数量回升合规（100→900）→ restored_compliance + 取消挂起单', async () => {
      const { validationService, prisma } = makeSvc({
        order: {
          id: 'O-1', status: 'Confirmed', type: 'Fabric', businessLine: 'fabric',
          capsuleExemption: false, moqSnapshot: SNAP, customerRelationId: null,
        },
        pendingApprovals: [
          { id: 'AR-1', payload: { reason: 'qty_change_below_moq' } },
        ],
       orderLines: [{ id: 'actual-test-line', quantity: '900', unit: 'M' }] });
      const r = await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 100, afterQty: 900, actorId: 'u1',
      });
      expect(r.blocked).toBe(false);
      expect(r.reason).toBe('restored_compliance');
      expect(r.cancelledCount).toBe(1);
      expect(prisma.approvalRequest.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['AR-1'] }, status: 'pending' },
        data: { status: 'cancelled' },
      });
    });

    it('前后均低于 MOQ（100→50）→ still_below_threshold，当前数量需匹配新的批准依据', async () => {
      const { validationService, approvalCreateService } = makeSvc({
        order: {
          id: 'O-1', status: 'Confirmed', type: 'Fabric', businessLine: 'fabric',
          capsuleExemption: false, moqSnapshot: SNAP, customerRelationId: null,
        },
       orderLines: [{ id: 'actual-test-line', quantity: '50', unit: 'M' }] });
      const r = await validationService.validatePatch({
        orderId: 'O-1', beforeQty: 100, afterQty: 50, actorId: 'u1',
      });
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe('still_below_threshold');
      expect(approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
    });
  });
});
