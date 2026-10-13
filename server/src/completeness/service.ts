/**
 * 资料完备度规则引擎 v1 — 服务层（service.ts）
 *
 * 三个只读接口的数据装配：
 *   - getCompletenessSummary：七规则全量聚合（totalGaps / bySeverity / groups）
 *   - getEntityCompleteness：单实体缺口明细（order 行级缺口；product/relation 附 0-100 完备分）
 *   - getCompletenessBatch：列表页徽标（product/relation，updatedAt 倒序，≤200）
 *
 * 评分口径：
 *   - FabricProfile：成分行有 + 价格历史有 + MOQ 有，三项各占 1/3
 *   - GarmentProfile：尺码信息 + 面辅料说明，两项各占 1/2
 *   - TrimmingProfile：被采购行引用 = 100 / 无引用 = 0
 *   - Relation：联系人≥1 + 信用额度 + 跟进记录，三项各占 1/3
 *   - 无任何 Profile 的裸产品资产：无强制维度，不虚报缺口（score=100）
 */
import { PrismaClient } from '@prisma/client';
import {
  COMPLETENESS_RULES,
  CompletenessSeverity,
  CompletenessSharedIndex,
  loadCompletenessSharedIndex,
} from './rules';

const SAMPLE_LIMIT = 5;
const BATCH_LIMIT = 200;

export interface CompletenessGroup {
  ruleId: string;
  label: string;
  severity: CompletenessSeverity;
  count: number;
  entityType: string;
  sampleIds: string[];
}

export interface CompletenessSummary {
  totalGaps: number;
  bySeverity: Record<CompletenessSeverity, number>;
  groups: CompletenessGroup[];
}

export interface CompletenessGap {
  ruleId: string;
  label: string;
  severity: CompletenessSeverity;
  hint: string;
  fix: { type: 'navigate'; target: string };
}

export type CompletenessEntityType = 'order' | 'development-case' | 'product' | 'relation';

export interface EntityCompleteness {
  entityType: CompletenessEntityType;
  id: string;
  /** 0-100 完备分，仅 product / relation 实体返回 */
  score?: number;
  gaps: CompletenessGap[];
}

export interface BatchItem {
  id: string;
  score: number;
  /** 缺失维度中文名 */
  missing: string[];
}

const notEmpty = (v: string | null | undefined): boolean => typeof v === 'string' && v.trim().length > 0;

// ────────────────────────────────────────────────────────────────
// summary
// ────────────────────────────────────────────────────────────────

export async function getCompletenessSummary(prisma: PrismaClient): Promise<CompletenessSummary> {
  const index = await loadCompletenessSharedIndex(prisma);
  const groups: CompletenessGroup[] = [];
  const bySeverity: Record<CompletenessSeverity, number> = { P0: 0, P1: 0, P2: 0 };
  let totalGaps = 0;
  for (const rule of COMPLETENESS_RULES) {
    const hitIds = await rule.collect(prisma, index);
    bySeverity[rule.severity] += hitIds.length;
    totalGaps += hitIds.length;
    groups.push({
      ruleId: rule.ruleId,
      label: rule.label,
      severity: rule.severity,
      count: hitIds.length,
      entityType: rule.entityType,
      sampleIds: hitIds.slice(0, SAMPLE_LIMIT),
    });
  }
  return { totalGaps, bySeverity, groups };
}

// ────────────────────────────────────────────────────────────────
// entity — order（行级缺口）
// ────────────────────────────────────────────────────────────────

async function getOrderCompleteness(prisma: PrismaClient, orderId: string): Promise<EntityCompleteness | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lines: { select: { id: true, materialCode: true } } },
  });
  if (!order || order.deletedAt != null) return null;
  const index = await loadCompletenessSharedIndex(prisma);
  const gaps: CompletenessGap[] = [];
  for (const line of order.lines) {
    if (line.materialCode && !index.productSkus.has(line.materialCode)) {
      gaps.push({
        ruleId: 'order_line_material_unlinked',
        label: '订单行面料未建档',
        severity: 'P0',
        hint: `订单行面料「${line.materialCode}」未建档`,
        // 直达建档表单并预填 SKU（ProductsManager 消费 create/sku 深链），而非列表搜索页
        fix: { type: 'navigate', target: `/products?create=1&sku=${encodeURIComponent(line.materialCode)}` },
      });
    }
  }
  if (!order.customerRelationId) {
    gaps.push({
      ruleId: 'order_no_customer_relation',
      label: '订单未关联客户',
      severity: 'P1',
      hint: '订单未关联客户档案，信用控制与四单对账无法落到客户',
      fix: { type: 'navigate', target: `/orders?id=${encodeURIComponent(order.id)}` },
    });
  }
  return { entityType: 'order', id: order.id, gaps };
}

// ────────────────────────────────────────────────────────────────
// entity — development-case
// ────────────────────────────────────────────────────────────────

async function getDevelopmentCaseCompleteness(prisma: PrismaClient, caseId: string): Promise<EntityCompleteness | null> {
  const devCase = await prisma.developmentCase.findUnique({
    where: { id: caseId },
    select: { id: true, productAssetId: true, deletedAt: true },
  });
  if (!devCase || devCase.deletedAt != null) return null;
  const gaps: CompletenessGap[] = [];
  if (!devCase.productAssetId) {
    gaps.push({
      ruleId: 'dev_case_unlinked_product',
      label: '开发案未关联产品档案',
      severity: 'P0',
      hint: '开发案未关联产品档案，打样与大货链路无法对齐到 SKU',
      // 直达开发案详情并自动进入「选择产品档案」挂档案流程（DevelopmentManager 消费 focus/action 深链）
      fix: { type: 'navigate', target: `/development?focus=${encodeURIComponent(devCase.id)}&action=link-product` },
    });
  }
  return { entityType: 'development-case', id: devCase.id, gaps };
}

// ────────────────────────────────────────────────────────────────
// entity / batch — product 评分
// ────────────────────────────────────────────────────────────────

interface FabricProfileLike {
  deletedAt: unknown;
  moqValue: number | null;
  factoryMoqValue: number | null;
  sampleMoqValue: number | null;
}

interface GarmentProfileLike {
  deletedAt: unknown;
  sizeSpec: string | null;
  sizeRange: string | null;
  availableSizes: string | null;
  baseSize: string | null;
  measurementPoints: string | null;
  mainFabric: string | null;
  contrastFabric: string | null;
  liningFabric: string | null;
  ribFabric: string | null;
  pocketingFabric: string | null;
  button: string | null;
  zipper: string | null;
  snapsEyelets: string | null;
  thread: string | null;
  labelTrims: string | null;
  interlining: string | null;
  liningStructure: string | null;
  constructionNote: string | null;
  materialUsage: string | null;
}

interface ProductAssetLike {
  id: string;
  sku: string;
  fabricProfile: FabricProfileLike | null;
  garmentProfile: GarmentProfileLike | null;
  trimmingProfile: { deletedAt: unknown } | null;
  compositionLines: { deletedAt: unknown }[];
  fabricPrices: { deletedAt: unknown }[];
}

interface ScoreResult {
  score: number;
  missing: string[];
  gaps: CompletenessGap[];
}

function dimensionGap(ruleId: string, label: string, hint: string, target: string): CompletenessGap {
  return { ruleId, label, severity: 'P2', hint, fix: { type: 'navigate', target } };
}

function scoreFromDims(dims: Array<{ name: string; ok: boolean }>): { score: number; missing: string[] } {
  if (dims.length === 0) return { score: 100, missing: [] };
  const present = dims.filter(d => d.ok).length;
  return {
    score: Math.round((present / dims.length) * 100),
    missing: dims.filter(d => !d.ok).map(d => d.name),
  };
}

export function scoreProductAsset(asset: ProductAssetLike, index: CompletenessSharedIndex): ScoreResult {
  const focus = `/products?focus=${encodeURIComponent(asset.id)}`;
  const gaps: CompletenessGap[] = [];

  if (asset.fabricProfile) {
    const dims = [
      { name: '成分行', ok: asset.compositionLines.some(l => l.deletedAt == null), ruleId: 'product_missing_composition' },
      { name: '价格历史', ok: asset.fabricPrices.some(p => p.deletedAt == null), ruleId: 'product_missing_price_history' },
      {
        name: 'MOQ',
        ok: asset.fabricProfile.moqValue != null
          || asset.fabricProfile.factoryMoqValue != null
          || asset.fabricProfile.sampleMoqValue != null,
        ruleId: 'product_missing_moq',
      },
    ];
    const { score, missing } = scoreFromDims(dims);
    for (const dim of dims) {
      if (!dim.ok) {
        gaps.push(dimensionGap(
          dim.ruleId,
          `产品档案缺${dim.name}`,
          `面料档案缺${dim.name}，完备度 ${score} 分，影响报价取价与 MOQ 校验`,
          focus,
        ));
      }
    }
    return { score, missing, gaps };
  }

  if (asset.garmentProfile) {
    const g = asset.garmentProfile;
    const dims = [
      {
        name: '尺码信息',
        ok: [g.sizeSpec, g.sizeRange, g.availableSizes, g.baseSize, g.measurementPoints].some(notEmpty),
        ruleId: 'product_missing_sizes',
      },
      {
        name: '面辅料说明',
        ok: [g.mainFabric, g.contrastFabric, g.liningFabric, g.ribFabric, g.pocketingFabric, g.button, g.zipper,
          g.snapsEyelets, g.thread, g.labelTrims, g.interlining, g.liningStructure, g.constructionNote, g.materialUsage]
          .some(notEmpty),
        ruleId: 'product_missing_material_notes',
      },
    ];
    const { score, missing } = scoreFromDims(dims);
    for (const dim of dims) {
      if (!dim.ok) {
        gaps.push(dimensionGap(
          dim.ruleId,
          `产品档案缺${dim.name}`,
          `成衣档案缺${dim.name}，完备度 ${score} 分，影响样衣与大货执行`,
          focus,
        ));
      }
    }
    return { score, missing, gaps };
  }

  if (asset.trimmingProfile) {
    const referenced = index.purchaseMaterialCodes.has(asset.sku);
    const score = referenced ? 100 : 0;
    if (!referenced) {
      gaps.push({
        ruleId: 'trim_no_reference',
        label: '辅料档案无采购引用',
        severity: 'P2',
        hint: '辅料档案无任何采购行引用，备料无法关联到此辅料',
        fix: { type: 'navigate', target: focus },
      });
    }
    return { score, missing: referenced ? [] : ['采购引用'], gaps };
  }

  // 裸产品资产：无任何 Profile，无强制维度，不虚报缺口
  return { score: 100, missing: [], gaps };
}

async function getProductCompleteness(prisma: PrismaClient, productId: string): Promise<EntityCompleteness | null> {
  const asset = await prisma.productAsset.findUnique({
    where: { id: productId },
    include: {
      fabricProfile: true,
      garmentProfile: true,
      trimmingProfile: { select: { deletedAt: true } },
      compositionLines: { select: { deletedAt: true } },
      fabricPrices: { select: { deletedAt: true } },
    },
  });
  if (!asset || asset.deletedAt != null) return null;
  const index = await loadCompletenessSharedIndex(prisma);
  // 软删档案视同未建档
  const fabricProfile = asset.fabricProfile && asset.fabricProfile.deletedAt == null ? asset.fabricProfile : null;
  const garmentProfile = asset.garmentProfile && asset.garmentProfile.deletedAt == null ? asset.garmentProfile : null;
  const trimmingProfile = asset.trimmingProfile && asset.trimmingProfile.deletedAt == null ? asset.trimmingProfile : null;
  const result = scoreProductAsset(
    {
      id: asset.id,
      sku: asset.sku,
      fabricProfile,
      garmentProfile,
      trimmingProfile,
      compositionLines: asset.compositionLines,
      fabricPrices: asset.fabricPrices,
    },
    index,
  );
  return { entityType: 'product', id: asset.id, score: result.score, gaps: result.gaps };
}

// ────────────────────────────────────────────────────────────────
// entity / batch — relation 评分
// ────────────────────────────────────────────────────────────────

interface RelationLike {
  id: string;
  category: string;
  contacts: { deletedAt: unknown }[];
  creditLimits: { deletedAt: unknown }[];
  followUpRecords: { deletedAt: unknown }[];
}

export function scoreRelationRow(rel: RelationLike): ScoreResult {
  const target = `/relations?id=${encodeURIComponent(rel.id)}`;
  const dims = [
    { name: '联系人', ok: rel.contacts.some(c => c.deletedAt == null), ruleId: 'relation_missing_contacts' },
    { name: '信用额度', ok: rel.creditLimits.some(c => c.deletedAt == null), ruleId: 'relation_missing_credit_limit' },
    { name: '跟进记录', ok: rel.followUpRecords.some(f => f.deletedAt == null), ruleId: 'relation_missing_follow_up' },
  ];
  const { score, missing } = scoreFromDims(dims);
  const gaps: CompletenessGap[] = [];
  for (const dim of dims) {
    if (dim.ok) continue;
    if (dim.ruleId === 'relation_missing_credit_limit') {
      if (rel.category === 'Customer') {
        // 规则④：客户无 CreditLimit 行 → P1 主规则
        gaps.push({
          ruleId: 'customer_no_credit_limit',
          label: '客户未设信用额度',
          severity: 'P1',
          hint: '客户未设置信用额度行，信用占用与冻结门禁无法生效',
          fix: { type: 'navigate', target },
        });
      } else {
        gaps.push(dimensionGap(dim.ruleId, '信用额度未配置', '未配置信用额度', target));
      }
    } else if (dim.ruleId === 'relation_missing_contacts') {
      gaps.push(dimensionGap(dim.ruleId, '联系人缺失', '未登记任何联系人，沟通无抓手', target));
    } else {
      gaps.push(dimensionGap(dim.ruleId, '无跟进记录', '没有任何跟进记录，近期动态空白', target));
    }
  }
  return { score, missing, gaps };
}

async function getRelationCompleteness(prisma: PrismaClient, relationId: string): Promise<EntityCompleteness | null> {
  const rel = await prisma.relation.findUnique({
    where: { id: relationId },
    include: {
      contacts: { select: { deletedAt: true } },
      creditLimits: { select: { deletedAt: true } },
      followUpRecords: { select: { deletedAt: true } },
    },
  });
  if (!rel || rel.deletedAt != null) return null;
  const result = scoreRelationRow(rel);
  return { entityType: 'relation', id: rel.id, score: result.score, gaps: result.gaps };
}

// ────────────────────────────────────────────────────────────────
// entity / batch — 对外入口
// ────────────────────────────────────────────────────────────────

export async function getEntityCompleteness(
  prisma: PrismaClient,
  type: CompletenessEntityType,
  id: string,
): Promise<EntityCompleteness | null> {
  switch (type) {
    case 'order':
      return getOrderCompleteness(prisma, id);
    case 'development-case':
      return getDevelopmentCaseCompleteness(prisma, id);
    case 'product':
      return getProductCompleteness(prisma, id);
    case 'relation':
      return getRelationCompleteness(prisma, id);
  }
}

export async function getCompletenessBatch(
  prisma: PrismaClient,
  type: 'product' | 'relation',
): Promise<{ items: BatchItem[] }> {
  if (type === 'product') {
    const index = await loadCompletenessSharedIndex(prisma);
    const assets = await prisma.productAsset.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: BATCH_LIMIT,
      include: {
        fabricProfile: true,
        garmentProfile: true,
        trimmingProfile: { select: { deletedAt: true } },
        compositionLines: { select: { deletedAt: true } },
        fabricPrices: { select: { deletedAt: true } },
      },
    });
    const items = assets.map(asset => {
      // 软删档案视同未建档
      const fabricProfile = asset.fabricProfile && asset.fabricProfile.deletedAt == null ? asset.fabricProfile : null;
      const garmentProfile = asset.garmentProfile && asset.garmentProfile.deletedAt == null ? asset.garmentProfile : null;
      const trimmingProfile = asset.trimmingProfile && asset.trimmingProfile.deletedAt == null ? asset.trimmingProfile : null;
      const result = scoreProductAsset(
        {
          id: asset.id,
          sku: asset.sku,
          fabricProfile,
          garmentProfile,
          trimmingProfile,
          compositionLines: asset.compositionLines,
          fabricPrices: asset.fabricPrices,
        },
        index,
      );
      return { id: asset.id, score: result.score, missing: result.missing };
    });
    return { items };
  }

  // 注意：Relation 模型无 updatedAt 字段，列表近因排序用其唯一时间字段 lastInteraction
  const relations = await prisma.relation.findMany({
    where: { deletedAt: null },
    orderBy: { lastInteraction: 'desc' },
    take: BATCH_LIMIT,
    include: {
      contacts: { select: { deletedAt: true } },
      creditLimits: { select: { deletedAt: true } },
      followUpRecords: { select: { deletedAt: true } },
    },
  });
  return {
    items: relations.map(rel => {
      const result = scoreRelationRow(rel);
      return { id: rel.id, score: result.score, missing: result.missing };
    }),
  };
}
