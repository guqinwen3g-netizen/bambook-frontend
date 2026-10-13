/**
 * moqResolutionService.ts — MOQ 取数优先级链解析（§2.4 优先级 0→6，命中即返回）
 *
 * 设计真源：
 *   - docs/design/03-业务规则/MOQ最小起订量.md §2.4（取数优先级）+ §X.1（优先 Order.moqSnapshot 不重新拉配置）
 *   - DR-003：Capsule 豁免 = 从成衣档阈值降级为 Capsule 档阈值（不是完全豁免）
 *
 * 优先级（高→低）：
 *   0. capsuleExemption（仅成衣族 businessLine=garment/capsule）→ capsuleMoq
 *   1. 行级 override（OrderLine/QuotationLine.moqOverride，scope: moq:line_override 由校验层守卫）
 *   2. 产品档案标准 MOQ（FabricProfile.moqValue / GarmentProfile.moqValue+moqUnit）
 *   3. 工厂合同 factoryMoqValue → 客户协议 Relation.customerAgreementMoq
 *   4. CustomerTier.moqOverrideRatio × 系统配置档位值（例 Platinum 0.7 × 800 = 560）
 *   5. MoqThresholdConfig 系统配置（优先 snapshot 口径，兼容旧单回退实时配置）
 *   6. 代码兜底常量 800/200/20（last resort，source='fallback_constant'）
 *
 * 口径一致性：ctx.snapshot（writeOnce 快照）合法时，层级 0/4/5 的配置值一律取快照，
 * 保证同一单据生命周期内 MOQ 口径不受后台配置调整影响（不追溯原则 §2.3）。
 */

import type { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import {
  MOQ_FALLBACK_CONSTANTS,
  type MoqConfigService,
  type MoqSnapshot,
} from './moqConfigService';

// ───────────────────────────────────────────────────────────────────
// 类型
// ───────────────────────────────────────────────────────────────────

export type MoqSource =
  | 'capsule_exemption'   // 层级 0：Capsule 豁免降级（DR-003）
  | 'line_override'       // 层级 1：行级 override
  | 'product_profile'     // 层级 2：产品档案标准 MOQ
  | 'factory_contract'    // 层级 3：工厂合同 MOQ
  | 'customer_agreement'  // 层级 3：客户协议 MOQ（Relation.customerAgreementMoq）
  | 'customer_tier'       // 层级 4：CustomerTier.moqOverrideRatio 换算
  | 'moq_config'          // 层级 5：MoqThresholdConfig 系统配置
  | 'fallback_constant';  // 层级 6：兜底常量

export interface MoqLineContext {
  /** fabric | garment | capsule | other（capsule 视为成衣族；豁免由 capsuleExemption 表达） */
  businessLine?: string | null;
  /** 订单级 Capsule 豁免标记（DR-003） */
  capsuleExemption?: boolean;
  /** 行级 override（优先级 1） */
  moqOverride?: number | null;
  /** 产品档案定位（FabricProfile/GarmentProfile.productAssetId @unique） */
  productAssetId?: string | null;
  /** 成衣档案 styleNo 定位（garment 族备用） */
  styleNo?: string | null;
  /** 直给档案 hint（调用方已查好时跳过 DB 查询） */
  fabricProfile?: { moqValue?: number | null; factoryMoqValue?: number | null } | null;
  garmentProfile?: { moqValue?: number | null; moqUnit?: string | null } | null;
  /** 客户协议 + Tier 查询锚点 */
  customerRelationId?: string | null;
  /** writeOnce 快照（优先口径；无/非法时回退实时配置） */
  snapshot?: Partial<MoqSnapshot> | null;
}

export interface MoqResolution {
  effectiveMoq: number;
  unit: string; // fabric → 'M'；garment 族 → profile moqUnit 或 'PCS'
  source: MoqSource;
  capsuleActive: boolean;
  /** 本次解析使用的口径快照（configId 可追溯；fallback 时 configId=null） */
  snapshot: MoqSnapshot;
  /** 命中层补充信息（tier level/ratio、agreement 等），供审计留痕 */
  detail?: Record<string, unknown>;
}

export interface MoqResolutionServiceOptions {
  prisma: PrismaClient;
  configService: MoqConfigService;
}

// ───────────────────────────────────────────────────────────────────
// 工具
// ───────────────────────────────────────────────────────────────────

export function isGarmentFamily(businessLine?: string | null): boolean {
  const bl = (businessLine ?? '').toLowerCase();
  return bl === 'garment' || bl === 'capsule';
}

/** 合法快照判定：三个阈值均为有限正数（空 {} / 残缺 → 回退实时配置） */
export function isValidSnapshot(s: Partial<MoqSnapshot> | null | undefined): s is MoqSnapshot {
  if (!s || typeof s !== 'object') return false;
  return [s.fabricDefaultMoq, s.garmentDefaultMoq, s.capsuleMoq]
    .every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

function toPositiveNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(typeof v === 'object' && v !== null && 'toString' in v ? (v as any).toString() : v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function createMoqResolutionService(opts: MoqResolutionServiceOptions) {
  const { prisma, configService } = opts;
  const db = prisma as any;

  // ── 口径快照：优先 ctx.snapshot（不追溯），否则实时配置/兜底 ──
  async function snapshotFor(ctx: MoqLineContext): Promise<MoqSnapshot> {
    if (isValidSnapshot(ctx.snapshot)) {
      return {
        fabricDefaultMoq: ctx.snapshot.fabricDefaultMoq,
        garmentDefaultMoq: ctx.snapshot.garmentDefaultMoq,
        capsuleMoq: ctx.snapshot.capsuleMoq,
        snapshotAt: ctx.snapshot.snapshotAt ?? '',
        configId: ctx.snapshot.configId ?? null,
        source: ctx.snapshot.source ?? 'moq_config',
      };
    }
    return configService.buildSnapshot();
  }

  function lineDefault(snap: MoqSnapshot, businessLine?: string | null): { value: number; unit: string } {
    return isGarmentFamily(businessLine)
      ? { value: snap.garmentDefaultMoq, unit: 'PCS' }
      : { value: snap.fabricDefaultMoq, unit: 'M' };
  }

  // ── 层级 2/3：产品档案（hint 优先，其次 DB 按 businessLine 族查询） ──
  async function loadProfiles(ctx: MoqLineContext): Promise<{
    fabric?: { moqValue?: number | null; factoryMoqValue?: number | null } | null;
    garment?: { moqValue?: number | null; moqUnit?: string | null } | null;
  }> {
    if (ctx.fabricProfile !== undefined || ctx.garmentProfile !== undefined) {
      return { fabric: ctx.fabricProfile ?? null, garment: ctx.garmentProfile ?? null };
    }
    if (!ctx.productAssetId && !ctx.styleNo) return {};
    try {
      if (isGarmentFamily(ctx.businessLine)) {
        let garment = null;
        if (ctx.productAssetId) {
          garment = await db.garmentProfile.findUnique({
            where: { productAssetId: ctx.productAssetId },
            select: { moqValue: true, moqUnit: true },
          });
        }
        if (!garment && ctx.styleNo) {
          garment = await db.garmentProfile.findFirst({
            where: { styleNo: ctx.styleNo },
            select: { moqValue: true, moqUnit: true },
          });
        }
        return { garment };
      }
      if (ctx.productAssetId) {
        const fabric = await db.fabricProfile.findUnique({
          where: { productAssetId: ctx.productAssetId },
          select: { moqValue: true, factoryMoqValue: true },
        });
        return { fabric };
      }
    } catch (e: any) {
      logger.error('[MoqResolution] 产品档案查询失败（阻断核验）', { error: e?.message });
      throw Object.assign(new Error('MOQ 产品档案暂时无法核验'), { code: 'MOQ_SOURCE_UNAVAILABLE' });
    }
    return {};
  }

  // ── 层级 3：客户协议（Relation.customerAgreementMoq JSON） ──
  async function loadAgreementMoq(ctx: MoqLineContext): Promise<{ value: number; detail: Record<string, unknown> } | null> {
    if (!ctx.customerRelationId) return null;
    try {
      const relation = await db.relation.findUnique({
        where: { id: ctx.customerRelationId },
        select: { customerAgreementMoq: true },
      });
      const agreement = relation?.customerAgreementMoq;
      if (!agreement || typeof agreement !== 'object') return null;
      const key = isGarmentFamily(ctx.businessLine) ? 'garmentDefaultMoq' : 'fabricDefaultMoq';
      const value = toPositiveNumber((agreement as any)[key]);
      if (value == null) return null;
      return { value, detail: { agreementKey: key, agreementRef: (agreement as any).agreementRef ?? null } };
    } catch (e: any) {
      logger.error('[MoqResolution] 客户协议查询失败（阻断核验）', { error: e?.message });
      throw Object.assign(new Error('MOQ 客户协议暂时无法核验'), { code: 'MOQ_SOURCE_UNAVAILABLE' });
    }
  }

  // ── 层级 4：CustomerTier.moqOverrideRatio（最新有效 Tier 的折扣率） ──
  async function loadTierRatio(ctx: MoqLineContext): Promise<{ ratio: number; level: string } | null> {
    if (!ctx.customerRelationId) return null;
    try {
      const tier = await db.customerTier.findFirst({
        where: { relationId: ctx.customerRelationId, deletedAt: null, moqOverrideRatio: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { level: true, moqOverrideRatio: true },
      });
      const ratio = toPositiveNumber(tier?.moqOverrideRatio);
      if (ratio == null || !tier) return null;
      return { ratio, level: tier.level };
    } catch (e: any) {
      logger.error('[MoqResolution] CustomerTier 查询失败（阻断核验）', { error: e?.message });
      throw Object.assign(new Error('MOQ 客户等级暂时无法核验'), { code: 'MOQ_SOURCE_UNAVAILABLE' });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 主入口：resolveEffectiveMoq（优先级 0→6，命中即返回）
  // ══════════════════════════════════════════════════════════════════
  async function resolveEffectiveMoq(ctx: MoqLineContext): Promise<MoqResolution> {
    const snap = await snapshotFor(ctx);
    const garment = isGarmentFamily(ctx.businessLine);

    // ── 层级 0：Capsule 豁免（DR-003）→ capsuleMoq，仍需与 capsuleMoq 比较（非完全豁免） ──
    if (ctx.capsuleExemption && garment) {
      return {
        effectiveMoq: snap.capsuleMoq,
        unit: 'PCS',
        source: 'capsule_exemption',
        capsuleActive: true,
        snapshot: snap,
      };
    }

    // ── 层级 1：行级 override（scope 守卫在校验层完成，此处纯取数） ──
    const override = toPositiveNumber(ctx.moqOverride);
    if (override != null) {
      return {
        effectiveMoq: override,
        unit: garment ? 'PCS' : 'M',
        source: 'line_override',
        capsuleActive: false,
        snapshot: snap,
      };
    }

    // ── 层级 2：产品档案标准 MOQ ──
    const profiles = await loadProfiles(ctx);
    const profileMoq = garment
      ? toPositiveNumber(profiles.garment?.moqValue)
      : toPositiveNumber(profiles.fabric?.moqValue);
    if (profileMoq != null) {
      const unit = garment ? (profiles.garment?.moqUnit || 'PCS') : 'M';
      return {
        effectiveMoq: profileMoq,
        unit,
        source: 'product_profile',
        capsuleActive: false,
        snapshot: snap,
      };
    }

    // ── 层级 3：工厂合同 factoryMoqValue → 客户协议 customerAgreementMoq ──
    const factoryMoq = toPositiveNumber(profiles.fabric?.factoryMoqValue);
    if (factoryMoq != null) {
      return {
        effectiveMoq: factoryMoq,
        unit: 'M',
        source: 'factory_contract',
        capsuleActive: false,
        snapshot: snap,
      };
    }
    const agreement = await loadAgreementMoq(ctx);
    if (agreement) {
      return {
        effectiveMoq: agreement.value,
        unit: garment ? 'PCS' : 'M',
        source: 'customer_agreement',
        capsuleActive: false,
        snapshot: snap,
        detail: agreement.detail,
      };
    }

    // ── 层级 4：CustomerTier.moqOverrideRatio × 系统配置档位值 ──
    const tier = await loadTierRatio(ctx);
    if (tier) {
      const base = lineDefault(snap, ctx.businessLine);
      return {
        effectiveMoq: Math.round(base.value * tier.ratio * 100) / 100,
        unit: base.unit,
        source: 'customer_tier',
        capsuleActive: false,
        snapshot: snap,
        detail: { tierLevel: tier.level, moqOverrideRatio: tier.ratio, tierBase: base.value },
      };
    }

    // ── 层级 5/6：系统配置（snapshot 口径） / 兜底常量 ──
    const def = lineDefault(snap, ctx.businessLine);
    return {
      effectiveMoq: def.value,
      unit: def.unit,
      source: snap.source === 'fallback_constant' ? 'fallback_constant' : 'moq_config',
      capsuleActive: false,
      snapshot: snap,
    };
  }

  return { resolveEffectiveMoq };
}

export type MoqResolutionService = ReturnType<typeof createMoqResolutionService>;
