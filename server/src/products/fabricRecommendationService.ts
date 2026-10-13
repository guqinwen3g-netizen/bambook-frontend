/**
 * 阶段 P2 — 面料推荐引擎（PRD 6.2 P2 / 7.2，确定性打分，非 LLM）
 *
 * 职责：
 *   基于客户需求（季节 / 预算 / 成分 / 克重 / 花型）对面料档案确定性打分，
 *   输出排序推荐列表并落库 FabricRecommendation（criteria + results 快照，可审计追溯）。
 *
 * 打分口径（纯函数 scoreFabricCandidate，可解释，每项命中写入 reasons）：
 *   季节匹配        +30   ProductAsset.season 与 criteria.season 相同或互相包含
 *   预算匹配        +30   同币种/明确单位通用客户售价在预算内；近边界 +15；未知口径不计分
 *   成分关键词      +10/个 命中 MaterialCompositionTerm（中/英/缩写，大小写不敏感），至多 3 个
 *   克重范围        +20   FabricProfile.weightValue ∈ [weightMin, weightMax]
 *   花型匹配        +10   FabricProfile.pattern 包含 criteria.pattern（大小写不敏感）
 *   现货            +5    stockStatus 含 in stock / 现货
 *
 * 设计原则与 pricing 模块一致：服务工厂 / 软删除 / 中文校验错误消息。
 */

import { PrismaClient, FabricRecommendation } from '@prisma/client';
import { logger } from '../lib/logger';
import crypto from 'crypto';
import { normalizeLengthUnit } from '../lib/unitConversion';

export interface RecommendCriteria {
  season?: string | null; // 如 "2026AW"
  budgetMin?: number | null;
  budgetMax?: number | null;
  currency?: string | null; // 预算币种，默认 USD；与价格记录 currency 不一致的候选价格不参与预算打分
  budgetUnit?: string | null; // 明确计价单位；缺失/未知时不假定米，不进行预算比较
  compositionKeywords?: string[] | null; // 如 ["羊毛", "wool"]
  weightMin?: number | null;
  weightMax?: number | null;
  pattern?: string | null;
  limit?: number | null; // 默认 10，上限 50
}

export interface RecommendResultItem {
  schemaVersion: 2;
  productAssetId: string;
  sku: string;
  name: string;
  score: number;
  reasons: string[];
  season: string | null;
  latestPrice: number | null;
  priceCurrency: string | null;
  priceUnit: string | null;
  priceBasis: RecommendationPriceBasis | null;
  budgetMatchStatus: BudgetMatchStatus;
  weightValue: number | null;
  weightUnit: string | null;
  pattern: string | null;
  millName: string | null;
}

export interface RecommendationPriceBasis {
  schemaVersion: 1;
  priceType: 'customer';
  audience: 'general';
  customerOrganizationId: null;
  sourcePriceId: string;
  sourceUpdatedAt: string;
  amount: number;
  currency: string;
  unit: string | null;
}
export type BudgetMatchStatus = 'not_requested' | 'unit_required' | 'price_unknown' | 'currency_mismatch' | 'unit_mismatch' | 'matched' | 'near' | 'outside';
export type RecommendationView = Omit<FabricRecommendation, 'criteria' | 'results'> & {
  criteria: RecommendCriteria;
  results: RecommendResultItem[];
  snapshotStatus: 'verified_commercial' | 'legacy_unverified';
  snapshotMessage: string | null;
  budgetScoringStatus: 'not_requested' | 'unit_required' | 'evaluated';
  priceAvailability: { candidateCount: number; unknownCommercialPriceCount: number; unmatchedCommercialPriceCount: number; comparableCommercialPriceCount: number } | null;
};

/** Alias normalization only; no M/YD or weight/length price conversion. */
export function normalizeRecommendationPriceUnit(raw: string | null | undefined): string | null {
  return normalizeLengthUnit(raw) ?? (/^(kg|公斤|千克)$/i.test(String(raw ?? '').trim()) ? 'KG' : null);
}

// Copy known caller inputs only. A client cannot sign a server provenance/version
// marker through the old spread-body criteria persistence path.
function normalizeCriteria(input: RecommendCriteria): RecommendCriteria {
  return { season: typeof input.season === 'string' ? input.season.trim() || null : null,
    budgetMin: input.budgetMin ?? null, budgetMax: input.budgetMax ?? null,
    currency: typeof input.currency === 'string' ? input.currency.trim().toUpperCase() || 'USD' : 'USD',
    budgetUnit: normalizeRecommendationPriceUnit(input.budgetUnit),
    compositionKeywords: Array.isArray(input.compositionKeywords) ? input.compositionKeywords.filter(k => typeof k === 'string').map(k => k.trim()).filter(Boolean) : [],
    weightMin: input.weightMin ?? null, weightMax: input.weightMax ?? null,
    pattern: typeof input.pattern === 'string' ? input.pattern.trim() || null : null,
    limit: Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT) };
}

function validPriceBasis(value: any): value is RecommendationPriceBasis {
  return value?.schemaVersion === 1 && value.priceType === 'customer' && value.audience === 'general' && value.customerOrganizationId === null
    && typeof value.sourcePriceId === 'string' && value.sourcePriceId.length > 0 && typeof value.sourceUpdatedAt === 'string'
    && typeof value.amount === 'number' && Number.isFinite(value.amount) && value.amount >= 0 && typeof value.currency === 'string'
    && (value.unit === null || normalizeRecommendationPriceUnit(value.unit) === value.unit);
}

/** Legacy ranking, membership and reasons can all reveal a cost comparison.
 * Keep the original immutable JSON in PG; expose an explicit unverified DTO.
 */
export function presentFabricRecommendation(row: FabricRecommendation): RecommendationView {
  const storedCriteria: any = row.criteria;
  const criteria = normalizeCriteria(storedCriteria && typeof storedCriteria === 'object' ? storedCriteria : {});
  const raw: any[] | null = Array.isArray(row.results) ? row.results : null;
  const availability = storedCriteria?.commercialPriceAvailability;
  const validAvailability = availability && ['candidateCount', 'unknownCommercialPriceCount', 'unmatchedCommercialPriceCount', 'comparableCommercialPriceCount']
    .every(key => Number.isSafeInteger(availability[key]) && availability[key] >= 0)
    && availability.candidateCount === availability.unknownCommercialPriceCount + availability.unmatchedCommercialPriceCount + availability.comparableCommercialPriceCount;
  const verified = storedCriteria?.recommendationSchemaVersion === 2 && raw !== null && raw.every(r =>
    r?.schemaVersion === 2 && typeof r.productAssetId === 'string' && typeof r.sku === 'string' && typeof r.name === 'string'
    && Number.isFinite(r.score) && Array.isArray(r.reasons) && r.reasons.every((v: unknown) => typeof v === 'string')
    && (r.priceBasis === null ? r.latestPrice === null && r.priceCurrency === null && r.priceUnit === null
      : validPriceBasis(r.priceBasis) && r.latestPrice === r.priceBasis.amount && r.priceCurrency === r.priceBasis.currency && r.priceUnit === r.priceBasis.unit));
  return { ...row, criteria, results: verified ? raw as RecommendResultItem[] : [],
    snapshotStatus: verified ? 'verified_commercial' : 'legacy_unverified',
    snapshotMessage: verified ? null : '历史推荐未记录商业价格来源，金额、评分和命中结果尚未核验；原始记录保留，请按现行口径重新推荐。',
    budgetScoringStatus: criteria.budgetMin == null && criteria.budgetMax == null ? 'not_requested' : criteria.budgetUnit ? 'evaluated' : 'unit_required',
    priceAvailability: verified && validAvailability ? { candidateCount: availability.candidateCount, unknownCommercialPriceCount: availability.unknownCommercialPriceCount,
      unmatchedCommercialPriceCount: availability.unmatchedCommercialPriceCount, comparableCommercialPriceCount: availability.comparableCommercialPriceCount } : null };
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;
const MAX_KEYWORDS = 3;
const BUDGET_NEAR_TOLERANCE = 0.2; // 边界外 20% 内给半分

function generateId(prefix: string): string {
  return `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

// ────────────────────────────────────────────────────────────────
// 候选打分纯函数（导出供测试）
// ────────────────────────────────────────────────────────────────

export interface FabricCandidate {
  productAssetId: string;
  sku: string;
  name: string;
  season: string | null;
  latestPrice: number | null;
  priceCurrency: string | null;
  priceBasis?: RecommendationPriceBasis | null;
  weightValue: number | null;
  weightUnit: string | null;
  /** 克重归一化 g/m²（统一换算口径，优先消费；缺失时回退 weightValue） */
  weightValueGsm?: number | null;
  pattern: string | null;
  stockStatus: string | null;
  millName: string | null;
  compositions: Array<{ term: string; percentage: number }>; // term 已归一化（中/英/缩写拼接）
}

export function scoreFabricCandidate(candidate: FabricCandidate, criteria: RecommendCriteria): RecommendResultItem {
  let score = 0;
  const reasons: string[] = [];

  // 季节
  const wantSeason = criteria.season?.trim().toLowerCase();
  const haveSeason = candidate.season?.trim().toLowerCase();
  if (wantSeason && haveSeason && (haveSeason === wantSeason || haveSeason.includes(wantSeason) || wantSeason.includes(haveSeason))) {
    score += 30;
    reasons.push(`季节匹配 ${candidate.season}`);
  }

  // 预算（仅当候选有同币种价格记录时打分）
  const currency = (criteria.currency?.trim() || 'USD').toUpperCase();
  const hasBudget = criteria.budgetMin != null || criteria.budgetMax != null;
  const budgetUnit = normalizeRecommendationPriceUnit(criteria.budgetUnit);
  const basis = validPriceBasis(candidate.priceBasis) ? candidate.priceBasis : null;
  let budgetMatchStatus: BudgetMatchStatus = !hasBudget ? 'not_requested' : !budgetUnit ? 'unit_required' : !basis ? 'price_unknown'
    : basis.currency !== currency ? 'currency_mismatch' : !basis.unit || basis.unit !== budgetUnit ? 'unit_mismatch' : 'outside';
  if (hasBudget && budgetUnit && basis && basis.currency === currency && basis.unit === budgetUnit) {
    const min = criteria.budgetMin ?? 0;
    const max = criteria.budgetMax ?? Number.POSITIVE_INFINITY;
    const price = basis.amount;
    if (price >= min && price <= max) {
      score += 30;
      budgetMatchStatus = 'matched';
      reasons.push(`预算内 ${price} ${currency} / ${basis.unit}`);
    } else {
      const near =
        (criteria.budgetMin != null && price < min && price >= min * (1 - BUDGET_NEAR_TOLERANCE)) ||
        (criteria.budgetMax != null && price > max && price <= max * (1 + BUDGET_NEAR_TOLERANCE));
      if (near) {
        score += 15;
        budgetMatchStatus = 'near';
        reasons.push(`接近预算 ${price} ${currency} / ${basis.unit}`);
      }
    }
  }

  // 成分关键词（大小写不敏感，至多计 MAX_KEYWORDS 个）
  const keywords = (criteria.compositionKeywords ?? []).map(k => k.trim().toLowerCase()).filter(Boolean).slice(0, 10);
  if (keywords.length > 0) {
    let hits = 0;
    const hitTerms: string[] = [];
    for (const kw of keywords) {
      if (hits >= MAX_KEYWORDS) break;
      const hit = candidate.compositions.find(c => c.term.toLowerCase().includes(kw));
      if (hit) {
        hits += 1;
        hitTerms.push(hit.term);
        score += 10;
      }
    }
    if (hitTerms.length > 0) reasons.push(`成分命中 ${hitTerms.join(' / ')}`);
  }

  // 克重（统一按归一化 g/m² 口径比较；兼容旧数据回退原始值）
  const weightGsm = candidate.weightValueGsm ?? candidate.weightValue;
  if ((criteria.weightMin != null || criteria.weightMax != null) && weightGsm != null) {
    const min = criteria.weightMin ?? 0;
    const max = criteria.weightMax ?? Number.POSITIVE_INFINITY;
    if (weightGsm >= min && weightGsm <= max) {
      score += 20;
      reasons.push(`克重 ${weightGsm} g/m² 符合`);
    }
  }

  // 花型
  const wantPattern = criteria.pattern?.trim().toLowerCase();
  if (wantPattern && candidate.pattern?.toLowerCase().includes(wantPattern)) {
    score += 10;
    reasons.push(`花型匹配 ${candidate.pattern}`);
  }

  // 现货
  const stock = candidate.stockStatus?.toLowerCase() ?? '';
  if (stock && (stock.includes('stock') || stock.includes('现货'))) {
    score += 5;
    reasons.push('有现货');
  }

  return {
    schemaVersion: 2,
    productAssetId: candidate.productAssetId,
    sku: candidate.sku,
    name: candidate.name,
    score,
    reasons,
    season: candidate.season,
    latestPrice: basis?.amount ?? null,
    priceCurrency: basis?.currency ?? null,
    priceUnit: basis?.unit ?? null,
    priceBasis: basis,
    budgetMatchStatus,
    weightValue: candidate.weightValue,
    weightUnit: candidate.weightUnit,
    pattern: candidate.pattern,
    millName: candidate.millName,
  };
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createFabricRecommendationService(prisma: PrismaClient) {
  const db = prisma as any;
  const now = () => Date.now();

  function assertCriteria(criteria: RecommendCriteria): void {
    const hasAny =
      criteria.season?.trim() ||
      criteria.budgetMin != null || criteria.budgetMax != null ||
      (criteria.compositionKeywords ?? []).some(k => k?.trim()) ||
      criteria.weightMin != null || criteria.weightMax != null ||
      criteria.pattern?.trim();
    if (!hasAny) throw new Error('推荐条件至少提供一项');
    for (const [k, v] of Object.entries({ budgetMin: criteria.budgetMin, budgetMax: criteria.budgetMax, weightMin: criteria.weightMin, weightMax: criteria.weightMax })) {
      if (v != null && (!Number.isFinite(v) || v < 0)) throw new Error(`${k} 非法`);
    }
    if (!Number.isSafeInteger(criteria.limit)) throw new Error('limit 非法');
    if (criteria.budgetMin != null && criteria.budgetMax != null && criteria.budgetMin > criteria.budgetMax) {
      throw new Error('预算下限不可大于上限');
    }
    if (criteria.weightMin != null && criteria.weightMax != null && criteria.weightMin > criteria.weightMax) {
      throw new Error('克重下限不可大于上限');
    }
  }

  /** No target customer is selected by this API: use general customer price
   * only, never another customer's negotiated price or purchase/sample tracks. */
  async function loadCandidates(currency: string, budgetUnit: string | null): Promise<FabricCandidate[]> {
    const profiles = await db.fabricProfile.findMany({
      where: { deletedAt: null, productAsset: { deletedAt: null } },
      include: {
        productAsset: {
          include: {
            fabricPrices: { where: { deletedAt: null, priceType: 'customer', customerOrganizationId: null }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] },
            compositionLines: { where: { deletedAt: null }, include: { term: true } },
          },
        },
      },
    });

    return profiles.map((p: any) => {
      const asset = p.productAsset;
      const prices = ((asset.fabricPrices ?? []) as any[]).filter(pr => pr.deletedAt == null && pr.priceType === 'customer' && pr.customerOrganizationId == null
        && pr.amount != null && Number.isFinite(Number(pr.amount)) && Number(pr.amount) >= 0);
      const sameCcy = prices.filter(pr => pr.currency?.toUpperCase() === currency);
      const sameBasis = budgetUnit ? sameCcy.filter(pr => normalizeRecommendationPriceUnit(pr.unit) === budgetUnit) : [];
      const latest = (sameBasis.length > 0 ? sameBasis : sameCcy.length > 0 ? sameCcy : prices)[0] ?? null;
      const priceBasis: RecommendationPriceBasis | null = latest ? { schemaVersion: 1, priceType: 'customer', audience: 'general', customerOrganizationId: null,
        sourcePriceId: latest.id, sourceUpdatedAt: String(latest.updatedAt), amount: Number(latest.amount), currency: String(latest.currency).toUpperCase(),
        unit: normalizeRecommendationPriceUnit(latest.unit) } : null;
      return {
        productAssetId: asset.id,
        sku: asset.sku,
        name: asset.name,
        season: asset.season ?? null,
        latestPrice: latest ? Number(latest.amount) : null,
        priceCurrency: latest?.currency ?? null,
        priceBasis,
        weightValue: p.weightValue ?? null,
        weightUnit: p.weightUnit ?? null,
        weightValueGsm: p.weightValueGsm ?? null,
        pattern: p.pattern ?? null,
        stockStatus: p.stockStatus ?? null,
        millName: p.millName ?? null,
        compositions: ((asset.compositionLines ?? []) as any[])
          .filter(l => l.term && l.term.deletedAt == null)
          .map(l => ({
            term: [l.term.chineseName, l.term.englishName, l.term.abbreviation].filter(Boolean).join(' '),
            percentage: Number(l.percentage),
          })),
      } satisfies FabricCandidate;
    });
  }

  async function recommend(input: RecommendCriteria, actorId: string): Promise<RecommendationView> {
    const criteria = normalizeCriteria(input);
    assertCriteria(criteria);
    const currency = criteria.currency!;
    const limit = criteria.limit!;

    const candidates = await loadCandidates(currency, criteria.budgetUnit ?? null);
    const hasBudget = criteria.budgetMin != null || criteria.budgetMax != null;
    const known = candidates.filter(c => validPriceBasis(c.priceBasis));
    const comparable = known.filter(c => criteria.budgetUnit && c.priceBasis!.currency === currency && c.priceBasis!.unit === criteria.budgetUnit);
    const priceAvailability = hasBudget ? { candidateCount: candidates.length, unknownCommercialPriceCount: candidates.length - known.length,
      unmatchedCommercialPriceCount: known.length - comparable.length, comparableCommercialPriceCount: comparable.length } : null;
    const scored = candidates
      .map(c => scoreFabricCandidate(c, { ...criteria, currency }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku))
      .slice(0, limit);

    const ts = now();
    const row = await db.fabricRecommendation.create({
      data: {
        id: generateId('FR'),
        criteria: { ...criteria, recommendationSchemaVersion: 2, commercialPriceAvailability: priceAvailability },
        results: scored,
        createdBy: actorId,
        createdAt: BigInt(ts),
        deletedAt: null,
      },
    });
    logger.info('[FabricRecommendation] recommend executed', {
      id: row.id, candidateCount: candidates.length, hitCount: scored.length, actorId,
    });
    return presentFabricRecommendation(row);
  }

  async function listRecommendations(query: { limit?: number; offset?: number }) {
    const where: any = { deletedAt: null };
    const take = Math.min(query.limit || 50, 200);
    const skip = query.offset || 0;
    const [items, total] = await Promise.all([
      db.fabricRecommendation.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
      db.fabricRecommendation.count({ where }),
    ]);
    return { items: items.map(presentFabricRecommendation), total };
  }

  async function getRecommendation(id: string): Promise<RecommendationView> {
    const row = await db.fabricRecommendation.findUnique({ where: { id } });
    if (!row || row.deletedAt !== null) throw new Error('推荐记录不存在');
    return presentFabricRecommendation(row);
  }

  async function deleteRecommendation(id: string, actorId: string): Promise<void> {
    const row = await getRecommendation(id);
    await db.fabricRecommendation.update({
      where: { id: row.id },
      data: { deletedAt: BigInt(now()) },
    });
    logger.info('[FabricRecommendation] soft-deleted', { id: row.id, actorId });
  }

  return { recommend, listRecommendations, getRecommendation, deleteRecommendation };
}

export type FabricRecommendationService = ReturnType<typeof createFabricRecommendationService>;
