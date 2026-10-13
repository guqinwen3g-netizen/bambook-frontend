/**
 * Agent ↔ Production Pipeline E2E 集成测试
 *
 * 验证 Agent 通过 toolDispatchRegistry 调用生产管线工具的完整路径：
 *   Agent 规划 → dispatchFromRegistry → advanceStage → 门禁检查 → 状态更新
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { storageReader, wholeFinalInspection } from './shippingLegacyStorageFixture';
import { registerTool, dispatchFromRegistry } from '../toolDispatchRegistry';
import { PrismaClient } from '@prisma/client';

const mockStage = (overrides: Record<string, unknown> = {}) => ({
  id: 'PST__O1__order_placed',
  orderId: 'O1',
  stageKey: 'order_placed',
  stageSeq: 1,
  label: '业务下单',
  status: 'pending',
  signedByProduction: false,
  signedByBusiness: false,
  startedAt: null,
  doneAt: null,
  note: null,
  createdAt: BigInt(Date.now()),
  updatedAt: BigInt(Date.now()),
  ...overrides,
});

const mockOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'O1',
  poNumber: 'PO-001',
  deletedAt: null,
  ...overrides,
});

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  const stages = new Map<string, any>();
  const _allStages = () => Array.from(stages.values());
  for (const s of [
    mockStage({ stageKey: 'order_placed', stageSeq: 1, status: 'pending' }),
    mockStage({ id: 'PST__O1__materials_confirmed', stageKey: 'materials_confirmed', stageSeq: 2, status: 'pending' }),
    mockStage({ id: 'PST__O1__production_planned', stageKey: 'production_planned', stageSeq: 3, status: 'pending' }),
  ]) {
    stages.set(s.stageKey, { ...s });
  }

  const _stageMap = stages;
  return {
    productionStage: {
      findMany: vi.fn(async () => _allStages().sort((a: any, b: any) => a.stageSeq - b.stageSeq)),
      findUnique: vi.fn(async ({ where }: any) => _stageMap.get(where.orderId_stageKey?.stageKey) || null),
    },
    preCutChecklist: { findUnique: vi.fn().mockResolvedValue(overrides.checklist || null) },
    inspectionReport: storageReader(() => overrides.inspection ? [wholeFinalInspection(overrides.inspection)] : []),
    productionBatch: storageReader(() => []),
    // 阶段 D / D5：getProductionPipeline 外协只读区块（直接查表 + 供应商名解析）
    outsourcingOrder: { findMany: vi.fn().mockResolvedValue([]) },
    relation: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (fn: any) => fn({
      order: { findFirst: vi.fn().mockResolvedValue(mockOrder(overrides.order as Record<string, unknown>)) },
      productionStage: {
        findUnique: vi.fn(async ({ where }: any) => {
          const key = where.orderId_stageKey?.stageKey;
          return stages.get(key) || null;
        }),
        findMany: vi.fn(async ({ where }: any) => {
          const seqs = where.stageSeq?.lt;
          const all = Array.from(stages.values());
          return seqs ? all.filter((s: any) => s.stageSeq < seqs) : all;
        }),
        // P2 in_progress 口径：advanceStage 推进后查询下一阶段（where.stageSeq 为精确值）
        findFirst: vi.fn(async ({ where }: any) => {
          if (where?.stageSeq == null) return null;
          return Array.from(stages.values()).find((s: any) => s.stageSeq === where.stageSeq) || null;
        }),
        update: vi.fn(async ({ where }: any) => {
          // advanceStage 调用 update({ where: { id: stage.id } })，按 id 匹配
          const id = where.id;
          let s: any = null;
          for (const stage of stages.values()) {
            if (stage.id === id) { s = stage; break; }
          }
          if (s) {
            s.status = 'done';
            s.doneAt = BigInt(Date.now());
            s.createdAt = s.createdAt || BigInt(Date.now());
            s.updatedAt = BigInt(Date.now());
          }
          return s;
        }),
      },
      preCutChecklist: { findUnique: vi.fn().mockResolvedValue(overrides.checklist || null) },
      inspectionReport: storageReader(() => overrides.inspection ? [wholeFinalInspection(overrides.inspection)] : []),
      productionBatch: storageReader(() => []),
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'AUDIT_1' }) },
    })),
  } as unknown as PrismaClient;
}

describe('Agent → Production Pipeline E2E', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('advance_stage: 无前置依赖的阶段直接推进成功', async () => {
    const prisma = createMockPrisma();

    registerTool('production.advance_stage', async (_prisma, input, call) => {
      const { advanceStage, parseStageKey } = await import('../../production/stageService');
      const stageKey = parseStageKey(String(input.stageKey || ''));
      if (!stageKey) {
        return { ok: false, error: { code: 'INVALID_STAGE', message: `Invalid stage: ${input.stageKey}` } };
      }
      const result = await advanceStage({
        prisma: _prisma,
        orderId: String(input.orderId || ''),
        stageKey,
        operator: input.operator as string | undefined,
        note: input.note as string | undefined,
      });
      const _pr = result as any;
      return _pr.ok
        ? { ok: true, stage: _pr.data.stage }
        : { ok: false, error: _pr.error };
    });

    const result = await dispatchFromRegistry(prisma, {
      toolId: 'production.advance_stage',
      input: { orderId: 'O1', stageKey: 'order_placed', operator: 'agent_test' },
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(true);
      expect((result.result as any).stage.stageKey).toBe('order_placed');
    }
  });

  it('advance_stage: 前置阶段未完成时拒绝推进', async () => {
    const prisma = createMockPrisma();

    const result = await dispatchFromRegistry(prisma, {
      toolId: 'production.advance_stage',
      input: { orderId: 'O1', stageKey: 'production_planned', operator: 'agent_test' },
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(false);
      expect((result.result as any).error.code).toBe('STAGE_NOT_SEQUENTIAL');
    }
  });

  it('advance_stage: 无效阶段名被拒绝', async () => {
    const prisma = createMockPrisma();

    const result = await dispatchFromRegistry(prisma, {
      toolId: 'production.advance_stage',
      input: { orderId: 'O1', stageKey: 'nonexistent_stage', operator: 'agent_test' },
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(false);
      expect((result.result as any).error.code).toBe('INVALID_STAGE');
    }
  });

  it('advance_stage: pre_cut_checked 门禁——checklist 不完整拒绝推进', async () => {
    // 直接测试门禁逻辑：mock prisma 返回 checklist 缺耗料确认
    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn({
        order: { findFirst: vi.fn().mockResolvedValue(mockOrder()) },
        productionStage: {
          findUnique: vi.fn().mockResolvedValue(mockStage({ stageKey: 'pre_cut_checked', stageSeq: 6, status: 'pending' })),
          findMany: vi.fn().mockResolvedValue([
            mockStage({ stageKey: 'order_placed', stageSeq: 1, status: 'done' }),
            mockStage({ stageKey: 'materials_confirmed', stageSeq: 2, status: 'done' }),
            mockStage({ stageKey: 'production_planned', stageSeq: 3, status: 'done' }),
            mockStage({ stageKey: 'in_production', stageSeq: 4, status: 'done' }),
            mockStage({ stageKey: 'materials_arrived', stageSeq: 5, status: 'done' }),
          ]),
          update: vi.fn(),
        },
        preCutChecklist: {
          findUnique: vi.fn().mockResolvedValue({
            gradingConfirmed: true,
            consumptionConfirmed: false,
            patternConfirmed: true,
            preProductionMeeting: true,
          }),
        },
        inspectionReport: { findUnique: vi.fn().mockResolvedValue(null) },
        auditLog: { create: vi.fn().mockResolvedValue({ id: 'AUDIT_1' }) },
      })),
    } as unknown as PrismaClient;

    const result = await dispatchFromRegistry(prisma, {
      toolId: 'production.advance_stage',
      input: { orderId: 'O1', stageKey: 'pre_cut_checked' },
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(false);
      expect((result.result as any).error.code).toBe('PRECUT_CHECKLIST_INCOMPLETE');
    }
  });

  it('get_pipeline: Agent 能查询生产管线全貌', async () => {
    const prisma = createMockPrisma();

    registerTool('production.get_pipeline', async (_prisma, input) => {
      const { getProductionPipeline } = await import('../../production/stageService');
      const result = await getProductionPipeline(_prisma, String(input.orderId || ''));
      return { ok: true, ...result };
    });

    const result = await dispatchFromRegistry(prisma, {
      toolId: 'production.get_pipeline',
      input: { orderId: 'O1' },
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(true);
    }
  });

  // ── pp_sample_approved 双签门禁 ──

  // §10.7 P-3 单签口径（2026-09-12）：放行 = 领导单签，历史双签仅兼容。
  // 原「缺生产部签字即拒绝」的双签断言已废（业务已签即可推进），此处按新口径校验无签阻断。
  it('advance_stage: pp_sample_approved 门禁——完全无签字拒绝推进（单签口径）', async () => {
    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn({
        // Legacy order-level signing has no OrderLine/ReleaseScope records.
        // Keep the original signature assertions; native PG covers source locks.
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'O1' }]),
        orderLine: { findMany: vi.fn().mockResolvedValue([]) },
        releaseScope: { findMany: vi.fn().mockResolvedValue([]) },
        order: { findFirst: vi.fn().mockResolvedValue(mockOrder()) },
        productionStage: {
          findUnique: vi.fn().mockResolvedValue(mockStage({
            id: 'PST__O1__pp_sample_approved',
            stageKey: 'pp_sample_approved', stageSeq: 7, status: 'pending',
            signedByProduction: null, signedByBusiness: null,
          })),
          findMany: vi.fn().mockResolvedValue(
            Array.from({ length: 6 }, (_, i) => mockStage({
              id: `PST__O1__s${i+1}`, stageKey: `stage_${i+1}`, stageSeq: i+1, status: 'done',
            }))
          ),
          update: vi.fn(),
        },
        preCutChecklist: { findUnique: vi.fn().mockResolvedValue(null) },
        inspectionReport: { findUnique: vi.fn().mockResolvedValue(null) },
        auditLog: { create: vi.fn().mockResolvedValue({ id: 'AUDIT_1' }) },
      })),
    } as unknown as PrismaClient;

    const result = await dispatchFromRegistry(prisma, {
      toolId: 'production.advance_stage',
      input: { orderId: 'O1', stageKey: 'pp_sample_approved' },
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(false);
      expect((result.result as any).error.code).toBe('PP_SAMPLE_NOT_SIGNED');
    }
  });

  it('advance_stage: pp_sample_approved 门禁——双签完成推进成功', async () => {
    const stageData = mockStage({
      id: 'PST__O1__pp_sample_approved',
      stageKey: 'pp_sample_approved', stageSeq: 7, status: 'pending',
      signedByProduction: 'prod_001', signedByBusiness: 'biz_001',
      createdAt: BigInt(Date.now()),
    });

    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn({
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'O1' }]),
        orderLine: { findMany: vi.fn().mockResolvedValue([]) },
        releaseScope: { findMany: vi.fn().mockResolvedValue([]) },
        order: { findFirst: vi.fn().mockResolvedValue(mockOrder()) },
        productionStage: {
          findUnique: vi.fn().mockResolvedValue(stageData),
          findMany: vi.fn().mockResolvedValue(
            Array.from({ length: 6 }, (_, i) => mockStage({
              id: `PST__O1__s${i+1}`, stageKey: `stage_${i+1}`, stageSeq: i+1, status: 'done',
            }))
          ),
          // P2 in_progress 口径：advanceStage 推进后查询下一阶段（本用例无需真实下一阶段）
          findFirst: vi.fn().mockResolvedValue(null),
          update: vi.fn().mockResolvedValue({ ...stageData, status: 'done', doneAt: BigInt(Date.now()) }),
        },
        preCutChecklist: { findUnique: vi.fn().mockResolvedValue(null) },
        inspectionReport: { findUnique: vi.fn().mockResolvedValue(null) },
        auditLog: { create: vi.fn().mockResolvedValue({ id: 'AUDIT_1' }) },
      })),
    } as unknown as PrismaClient;

    const result = await dispatchFromRegistry(prisma, {
      toolId: 'production.advance_stage',
      input: { orderId: 'O1', stageKey: 'pp_sample_approved', operator: 'agent_test' },
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(true);
      expect((result.result as any).stage.stageKey).toBe('pp_sample_approved');
    }
  });

  // ── qc_shipped 验货阈值门禁 ──

  it('advance_stage: qc_shipped 门禁——合格率低于 90% 拒绝推进', async () => {
    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn({
        order: { findFirst: vi.fn().mockResolvedValue(mockOrder()) },
        productionStage: {
          findUnique: vi.fn().mockResolvedValue(mockStage({
            id: 'PST__O1__qc_shipped',
            stageKey: 'qc_shipped', stageSeq: 10, status: 'pending',
          })),
          findMany: vi.fn().mockResolvedValue(
            Array.from({ length: 9 }, (_, i) => mockStage({
              id: `PST__O1__s${i+1}`, stageKey: `stage_${i+1}`, stageSeq: i+1, status: 'done',
            }))
          ),
          update: vi.fn(),
        },
        preCutChecklist: { findUnique: vi.fn().mockResolvedValue(null) },
        inspectionReport: storageReader(() => [wholeFinalInspection({
            totalUnits: 100, passedUnits: 80, approvedByBusiness: true,
          })]),
        productionBatch: storageReader(() => []),
        auditLog: { create: vi.fn().mockResolvedValue({ id: 'AUDIT_1' }) },
      })),
    } as unknown as PrismaClient;

    const result = await dispatchFromRegistry(prisma, {
      toolId: 'production.advance_stage',
      input: { orderId: 'O1', stageKey: 'qc_shipped' },
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(false);
      expect((result.result as any).error.code).toBe('INSPECTION_NOT_QUALIFIED');
    }
  });

  it('advance_stage: qc_shipped 门禁——未获业务部批准拒绝推进', async () => {
    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn({
        order: { findFirst: vi.fn().mockResolvedValue(mockOrder()) },
        productionStage: {
          findUnique: vi.fn().mockResolvedValue(mockStage({
            id: 'PST__O1__qc_shipped',
            stageKey: 'qc_shipped', stageSeq: 10, status: 'pending',
          })),
          findMany: vi.fn().mockResolvedValue(
            Array.from({ length: 9 }, (_, i) => mockStage({
              id: `PST__O1__s${i+1}`, stageKey: `stage_${i+1}`, stageSeq: i+1, status: 'done',
            }))
          ),
          update: vi.fn(),
        },
        preCutChecklist: { findUnique: vi.fn().mockResolvedValue(null) },
        inspectionReport: storageReader(() => [wholeFinalInspection({
            totalUnits: 100, passedUnits: 98, approvedByBusiness: false,
          })]),
        productionBatch: storageReader(() => []),
        auditLog: { create: vi.fn().mockResolvedValue({ id: 'AUDIT_1' }) },
      })),
    } as unknown as PrismaClient;

    const result = await dispatchFromRegistry(prisma, {
      toolId: 'production.advance_stage',
      input: { orderId: 'O1', stageKey: 'qc_shipped' },
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(false);
      expect((result.result as any).error.code).toBe('BUSINESS_APPROVAL_REQUIRED');
    }
  });

  it('advance_stage: qc_shipped 门禁——全部满足推进成功', async () => {
    const stageData = mockStage({
      id: 'PST__O1__qc_shipped',
      stageKey: 'qc_shipped', stageSeq: 10, status: 'pending',
      createdAt: BigInt(Date.now()),
    });

    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn({
        order: { findFirst: vi.fn().mockResolvedValue(mockOrder()) },
        productionStage: {
          findUnique: vi.fn().mockResolvedValue(stageData),
          findMany: vi.fn().mockResolvedValue(
            Array.from({ length: 9 }, (_, i) => mockStage({
              id: `PST__O1__s${i+1}`, stageKey: `stage_${i+1}`, stageSeq: i+1, status: 'done',
            }))
          ),
          // P2 in_progress 口径：advanceStage 推进后查询下一阶段（qc_shipped 为末阶段 → null）
          findFirst: vi.fn().mockResolvedValue(null),
          update: vi.fn().mockResolvedValue({ ...stageData, status: 'done', doneAt: BigInt(Date.now()) }),
        },
        preCutChecklist: { findUnique: vi.fn().mockResolvedValue(null) },
        inspectionReport: storageReader(() => [wholeFinalInspection({
            totalUnits: 100, passedUnits: 98, approvedByBusiness: true,
          })]),
        productionBatch: storageReader(() => []),
        auditLog: { create: vi.fn().mockResolvedValue({ id: 'AUDIT_1' }) },
      })),
    } as unknown as PrismaClient;

    const result = await dispatchFromRegistry(prisma, {
      toolId: 'production.advance_stage',
      input: { orderId: 'O1', stageKey: 'qc_shipped', operator: 'agent_test' },
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(true);
      expect((result.result as any).stage.stageKey).toBe('qc_shipped');
    }
  });

});
