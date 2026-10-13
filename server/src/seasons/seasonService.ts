/**
 * H2 季节性与趋势管理服务 — Season & Trend Management（PRD 14）
 *
 * 职责：
 *   1. 季度档案（Season）：开发日历 + 季度回顾快照（PRD 14.1）。
 *      季度标签口径：Order.season 为自由文本，Season.code 为注册真源，
 *      回顾按 code 等值（不区分大小写）聚合订单。
 *   2. 趋势标签（TrendTag）+ 趋势面料关联（TrendTagFabric）：类型封闭集
 *      fabric|color|craft|composition；关联表 (trendTagId, fabricId) 唯一。
 *   3. 展会（TradeShow）+ 线索（TradeShowLead）+ ROI：线索转化为
 *      category=Customer 的 Relation 后，其订单归入展会 ROI。
 *
 * 设计原则（与 suppliers 模块一致）：
 *   - 软删除（deletedAt BigInt），关联表 TrendTagFabric 无软删除字段、硬删除
 *   - 转化/回顾写入走事务（fail closed）
 *   - 真源实时聚合，快照仅落 reviewJson（可重生成）
 */

import { PrismaClient, Season, TrendTag, TrendTagFabric, TradeShow, TradeShowLead } from '@prisma/client';
import { logger } from '../lib/logger';
import crypto from 'crypto';
import { orderAmountOf } from '../shared/orderAmount';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface SeasonInput {
  code: string; // SS26 | AW26（归一化为大写）
  name: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  calendar?: unknown; // 数组则原样存 JSON：[{ key, label, startDate, endDate, note? }]
  status?: string; // Planning | Active | Closed（默认 Planning）
  notes?: string | null;
}

export type SeasonPatch = Partial<SeasonInput>;

export interface TrendTagInput {
  type: string; // fabric | color | craft | composition
  name: string;
  description?: string | null;
  seasonId?: string | null; // null = 跨季趋势
  tradeShowId?: string | null;
  source?: string | null; // manual | trade_show（默认 manual）
}

export type TrendTagPatch = Partial<Pick<TrendTagInput, 'name' | 'description' | 'seasonId' | 'type'>>;

export interface TradeShowInput {
  name: string;
  seasonId?: string | null;
  location?: string | null;
  startDate: string; // YYYY-MM-DD
  endDate?: string | null;
  boothNo?: string | null;
  attendees?: string[];
  cost?: number | null;
  currency?: string | null;
  status?: string; // Planned | Ongoing | Completed | Cancelled（默认 Planned）
  notes?: string | null;
}

export type TradeShowPatch = Partial<TradeShowInput>;

export interface LeadInput {
  customerName: string;
  company?: string | null;
  country?: string | null;
  email?: string | null;
  phone?: string | null;
  demand?: string | null;
  status?: string; // New | Following | Converted | Lost（默认 New）
  nextFollowUpAt?: string | null; // YYYY-MM-DD
  notes?: string | null;
}

export type LeadPatch = Partial<LeadInput>;

export interface SeasonReview {
  seasonId: string;
  code: string;
  orderCount: number; // 接单量
  shippedCount: number; // 出货量（已出运订单数）
  revenue: number;
  cost: number;
  grossProfit: number;
  topCustomers: Array<{ customer: string; orderCount: number; revenue: number }>;
  generatedAt: number;
}

export interface ShowROI {
  cost: number | null;
  currency: string | null;
  leadsTotal: number;
  leadsConverted: number;
  orderCount: number;
  orderAmount: number;
  roi: number | null; // orderAmount / cost；无成本则为 null
}

const SEASON_CODE_RE = /^(SS|AW)\d{2}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SEASON_STATUSES = ['Planning', 'Active', 'Closed'] as const;
const TREND_TYPES = ['fabric', 'color', 'craft', 'composition'] as const;
const SHOW_STATUSES = ['Planned', 'Ongoing', 'Completed', 'Cancelled'] as const;
const LEAD_STATUSES = ['New', 'Following', 'Converted', 'Lost'] as const;

// 已出运口径：shipmentDate 非空，或状态进入出运及之后阶段
const SHIPPED_STATUSES = ['Shipped', 'Invoiced', 'PartiallyPaid', 'Paid', 'Closed'];

function generateId(prefix: string): string {
  return `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createSeasonService(prisma: PrismaClient) {
  const db = prisma as any;
  const now = () => Date.now();

  // ══════════════════════════════════════════════════════════════
  // 1. 季度 Season
  // ══════════════════════════════════════════════════════════════

  async function getSeasonOrThrow(id: string): Promise<Season> {
    const season = await db.season.findUnique({ where: { id } });
    if (!season || season.deletedAt !== null) throw new Error('季度不存在');
    return season;
  }

  async function assertSeasonExists(seasonId: string): Promise<void> {
    const season = await db.season.findUnique({ where: { id: seasonId } });
    if (!season || season.deletedAt !== null) throw new Error('季度不存在');
  }

  function assertDateRange(startDate: string, endDate: string): void {
    if (!DATE_RE.test(startDate)) throw new Error('startDate 必须是 YYYY-MM-DD');
    if (!DATE_RE.test(endDate)) throw new Error('endDate 必须是 YYYY-MM-DD');
    if (startDate >= endDate) throw new Error('startDate 必须早于 endDate');
  }

  async function createSeason(input: SeasonInput, actorId: string): Promise<Season> {
    if (!input.code?.trim()) throw new Error('季度代码必填');
    const code = input.code.trim().toUpperCase();
    if (!SEASON_CODE_RE.test(code)) throw new Error(`非法季度代码：${input.code}（允许 SS26 | AW26 形式）`);
    if (!input.name?.trim()) throw new Error('季度名称必填');
    if (!input.startDate) throw new Error('startDate 必填');
    if (!input.endDate) throw new Error('endDate 必填');
    assertDateRange(input.startDate, input.endDate);
    if (input.status && !(SEASON_STATUSES as readonly string[]).includes(input.status)) {
      throw new Error(`非法季度状态：${input.status}（允许 Planning | Active | Closed）`);
    }

    // code 为 @unique 注册真源：存在（含已软删）即拒绝，避免撞唯一约束
    const dup = await db.season.findUnique({ where: { code } });
    if (dup) throw new Error('季度代码已存在');

    const ts = now();
    const season = await db.season.create({
      data: {
        id: generateId('SEAS'),
        code,
        name: input.name.trim(),
        startDate: input.startDate,
        endDate: input.endDate,
        calendar: Array.isArray(input.calendar) ? input.calendar : null,
        status: input.status ?? 'Planning',
        notes: input.notes ?? null,
        createdAt: BigInt(ts),
        updatedAt: BigInt(ts),
      },
    });
    logger.info('[SeasonService] season created', { id: season.id, code, actorId });
    return season;
  }

  async function listSeasons(query: { status?: string; search?: string; limit?: number; offset?: number }) {
    const where: any = { deletedAt: null };
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const take = Math.min(query.limit || 50, 200);
    const skip = query.offset || 0;
    const [items, total] = await Promise.all([
      db.season.findMany({ where, orderBy: { startDate: 'desc' }, take, skip }),
      db.season.count({ where }),
    ]);
    return { items, total };
  }

  async function getSeason(id: string) {
    const season = await db.season.findUnique({
      where: { id },
      include: {
        trendTags: { where: { deletedAt: null } },
        tradeShows: { where: { deletedAt: null } },
      },
    });
    if (!season || season.deletedAt !== null) return null;
    return season;
  }

  const SEASON_PATCH_FIELDS = ['name', 'startDate', 'endDate', 'calendar', 'status', 'notes'] as const;

  async function updateSeason(id: string, patch: SeasonPatch, actorId: string): Promise<Season> {
    const season = await getSeasonOrThrow(id);
    // code 是关联真源（Order.season 等值匹配），禁止修改
    if ((patch as any).code !== undefined) throw new Error('季度代码不可修改');
    if (patch.status && !(SEASON_STATUSES as readonly string[]).includes(patch.status)) {
      throw new Error(`非法季度状态：${patch.status}（允许 Planning | Active | Closed）`);
    }
    // 日期区间：与现存值合并后校验，防止单边更新造成倒置
    const startDate = patch.startDate ?? season.startDate;
    const endDate = patch.endDate ?? season.endDate;
    assertDateRange(startDate, endDate);

    const data: Record<string, unknown> = { updatedAt: BigInt(now()) };
    for (const f of SEASON_PATCH_FIELDS) {
      if (f === 'calendar') {
        if (patch.calendar !== undefined) data.calendar = Array.isArray(patch.calendar) ? patch.calendar : null;
        continue;
      }
      if ((patch as any)[f] !== undefined) data[f] = (patch as any)[f];
    }
    const updated = await db.season.update({ where: { id: season.id }, data });
    logger.info('[SeasonService] season updated', { id: season.id, actorId, fields: Object.keys(patch) });
    return updated;
  }

  async function deleteSeason(id: string, actorId: string): Promise<void> {
    const season = await getSeasonOrThrow(id);
    await db.season.update({ where: { id: season.id }, data: { deletedAt: BigInt(now()), updatedAt: BigInt(now()) } });
    logger.info('[SeasonService] season soft-deleted', { id: season.id, actorId });
  }

  // ─── 季度回顾（PRD 14.1：真源为订单实时聚合，快照落 reviewJson） ───

  async function computeSeasonReview(seasonId: string): Promise<SeasonReview> {
    const season = await getSeasonOrThrow(seasonId);
    const orders = await db.order.findMany({
      where: { deletedAt: null, season: { equals: season.code, mode: 'insensitive' } },
    });

    let revenue = 0;
    let cost = 0;
    let shippedCount = 0;
    const byCustomer = new Map<string, { orderCount: number; revenue: number }>();
    for (const o of orders) {
      const rev = orderAmountOf(o); // ★ 唯一真源（Kevin 拍板：以明细行为准）
      revenue += rev;
      cost += Number(o.supplierInvoiceAmount ?? 0);
      if (o.shipmentDate || SHIPPED_STATUSES.includes(o.status)) shippedCount += 1;
      const key = o.customer || '未知客户';
      const agg = byCustomer.get(key) || { orderCount: 0, revenue: 0 };
      agg.orderCount += 1;
      agg.revenue += rev;
      byCustomer.set(key, agg);
    }
    const topCustomers = [...byCustomer.entries()]
      .map(([customer, v]) => ({ customer, orderCount: v.orderCount, revenue: v.revenue }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    return {
      seasonId: season.id,
      code: season.code,
      orderCount: orders.length,
      shippedCount,
      revenue,
      cost,
      grossProfit: revenue - cost,
      topCustomers,
      generatedAt: now(),
    };
  }

  /** 生成季度回顾快照：事务写入 reviewJson + reviewedAt，可重生成 */
  async function generateSeasonReview(seasonId: string, actorId: string): Promise<SeasonReview> {
    const review = await computeSeasonReview(seasonId);
    const ts = now();
    await db.$transaction(async (tx: any) => {
      await tx.season.update({
        where: { id: seasonId },
        data: { reviewJson: review, reviewedAt: BigInt(ts), updatedAt: BigInt(ts) },
      });
    });
    logger.info('[SeasonService] season review generated', { seasonId, code: review.code, orderCount: review.orderCount, actorId });
    return review;
  }

  // ══════════════════════════════════════════════════════════════
  // 2. 趋势标签 TrendTag + 趋势面料关联 TrendTagFabric
  // ══════════════════════════════════════════════════════════════

  async function getTrendTagOrThrow(tagId: string): Promise<TrendTag> {
    const tag = await db.trendTag.findUnique({ where: { id: tagId } });
    if (!tag || tag.deletedAt !== null) throw new Error('趋势标签不存在');
    return tag;
  }

  async function getTradeShowOrThrow(showId: string): Promise<TradeShow> {
    const show = await db.tradeShow.findUnique({ where: { id: showId } });
    if (!show || show.deletedAt !== null) throw new Error('展会不存在');
    return show;
  }

  async function createTrendTag(input: TrendTagInput, actorId: string): Promise<TrendTag> {
    if (!(TREND_TYPES as readonly string[]).includes(input.type)) {
      throw new Error(`非法趋势类型：${input.type}（允许 fabric | color | craft | composition）`);
    }
    if (!input.name?.trim()) throw new Error('趋势名称必填');
    if (input.seasonId) await assertSeasonExists(input.seasonId);
    if (input.tradeShowId) await getTradeShowOrThrow(input.tradeShowId);

    const ts = now();
    const tag = await db.trendTag.create({
      data: {
        id: generateId('TRDT'),
        seasonId: input.seasonId ?? null,
        type: input.type,
        name: input.name.trim(),
        description: input.description ?? null,
        source: input.source ?? 'manual',
        tradeShowId: input.tradeShowId ?? null,
        createdAt: BigInt(ts),
        updatedAt: BigInt(ts),
      },
    });
    logger.info('[SeasonService] trend tag created', { id: tag.id, type: input.type, actorId });
    return tag;
  }

  async function listTrendTags(query: { seasonId?: string; type?: string }) {
    const where: any = { deletedAt: null };
    if (query.seasonId) where.seasonId = query.seasonId;
    if (query.type) where.type = query.type;
    const tags = await db.trendTag.findMany({
      where,
      include: {
        fabricLinks: { include: { fabric: { include: { productAsset: true } } } },
        tradeShow: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    // fabric 已软删的关联不展示（to-one include 无法在 SQL 层过滤，服务层兜底）
    return tags.map((t: any) => ({
      ...t,
      fabricLinks: t.fabricLinks.filter((l: any) => l.fabric && l.fabric.deletedAt === null),
    }));
  }

  const TREND_TAG_PATCH_FIELDS = ['name', 'description', 'seasonId', 'type'] as const;

  async function updateTrendTag(tagId: string, patch: TrendTagPatch, actorId: string): Promise<TrendTag> {
    const tag = await getTrendTagOrThrow(tagId);
    if (patch.type && !(TREND_TYPES as readonly string[]).includes(patch.type)) {
      throw new Error(`非法趋势类型：${patch.type}（允许 fabric | color | craft | composition）`);
    }
    if (patch.seasonId) await assertSeasonExists(patch.seasonId);
    const data: Record<string, unknown> = { updatedAt: BigInt(now()) };
    for (const f of TREND_TAG_PATCH_FIELDS) {
      if ((patch as any)[f] !== undefined) data[f] = (patch as any)[f];
    }
    const updated = await db.trendTag.update({ where: { id: tag.id }, data });
    logger.info('[SeasonService] trend tag updated', { id: tag.id, actorId, fields: Object.keys(patch) });
    return updated;
  }

  async function deleteTrendTag(tagId: string, actorId: string): Promise<void> {
    const tag = await getTrendTagOrThrow(tagId);
    await db.trendTag.update({ where: { id: tag.id }, data: { deletedAt: BigInt(now()), updatedAt: BigInt(now()) } });
    logger.info('[SeasonService] trend tag soft-deleted', { id: tag.id, actorId });
  }

  async function linkFabric(tagId: string, fabricId: string, note: string | null | undefined, actorId: string): Promise<TrendTagFabric> {
    if (!fabricId) throw new Error('fabricId 必填');
    await getTrendTagOrThrow(tagId);
    const fabric = await db.fabricProfile.findUnique({ where: { id: fabricId } });
    if (!fabric || fabric.deletedAt !== null) throw new Error('面料档案不存在');
    const dup = await db.trendTagFabric.findFirst({ where: { trendTagId: tagId, fabricId } });
    if (dup) throw new Error('该面料已关联此趋势');
    const link = await db.trendTagFabric.create({
      data: { id: generateId('TRTF'), trendTagId: tagId, fabricId, note: note ?? null, createdAt: BigInt(now()) },
    });
    logger.info('[SeasonService] fabric linked to trend', { tagId, fabricId, actorId });
    return link;
  }

  async function unlinkFabric(tagId: string, fabricId: string, actorId: string): Promise<void> {
    const existing = await db.trendTagFabric.findFirst({ where: { trendTagId: tagId, fabricId } });
    if (!existing) throw new Error('该趋势面料关联不存在');
    // 关联表无软删除字段，硬删除
    await db.trendTagFabric.delete({ where: { id: existing.id } });
    logger.info('[SeasonService] fabric unlinked from trend', { tagId, fabricId, actorId });
  }

  /** 当季趋势面料：推荐场景优先展示（按关联时间降序） */
  async function listTrendingFabrics(query: { seasonId?: string }) {
    const links = await db.trendTagFabric.findMany({
      where: {
        trendTag: { deletedAt: null, ...(query.seasonId ? { seasonId: query.seasonId } : {}) },
        fabric: { deletedAt: null },
      },
      include: { trendTag: true, fabric: { include: { productAsset: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return links.map((l: any) => {
      const { trendTag, fabric, ...link } = l;
      return { link, tag: trendTag, fabric };
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 3. 展会 TradeShow + 线索 TradeShowLead + ROI
  // ══════════════════════════════════════════════════════════════

  async function createTradeShow(input: TradeShowInput, actorId: string): Promise<TradeShow> {
    if (!input.name?.trim()) throw new Error('展会名称必填');
    if (!input.startDate) throw new Error('startDate 必填');
    if (!DATE_RE.test(input.startDate)) throw new Error('startDate 必须是 YYYY-MM-DD');
    if (input.endDate && !DATE_RE.test(input.endDate)) throw new Error('endDate 必须是 YYYY-MM-DD');
    if (input.status && !(SHOW_STATUSES as readonly string[]).includes(input.status)) {
      throw new Error(`非法展会状态：${input.status}（允许 Planned | Ongoing | Completed | Cancelled）`);
    }
    if (input.seasonId) await assertSeasonExists(input.seasonId);

    const ts = now();
    const show = await db.tradeShow.create({
      data: {
        id: generateId('TRDS'),
        seasonId: input.seasonId ?? null,
        name: input.name.trim(),
        location: input.location ?? null,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        boothNo: input.boothNo ?? null,
        attendees: input.attendees ?? [],
        cost: input.cost ?? null,
        currency: input.currency ?? 'CNY',
        status: input.status ?? 'Planned',
        notes: input.notes ?? null,
        createdAt: BigInt(ts),
        updatedAt: BigInt(ts),
      },
    });
    logger.info('[SeasonService] trade show created', { id: show.id, name: input.name, actorId });
    return show;
  }

  async function listTradeShows(query: { seasonId?: string; status?: string }) {
    const where: any = { deletedAt: null };
    if (query.seasonId) where.seasonId = query.seasonId;
    if (query.status) where.status = query.status;
    return db.tradeShow.findMany({ where, orderBy: { startDate: 'desc' }, take: 200 });
  }

  async function getTradeShow(id: string) {
    const show = await db.tradeShow.findUnique({
      where: { id },
      include: { leads: { where: { deletedAt: null } } },
    });
    if (!show || show.deletedAt !== null) return null;
    return show;
  }

  const SHOW_PATCH_FIELDS = [
    'name', 'location', 'startDate', 'endDate', 'boothNo', 'attendees',
    'cost', 'currency', 'status', 'seasonId', 'notes',
  ] as const;

  async function updateTradeShow(id: string, patch: TradeShowPatch, actorId: string): Promise<TradeShow> {
    const show = await getTradeShowOrThrow(id);
    if (patch.status && !(SHOW_STATUSES as readonly string[]).includes(patch.status)) {
      throw new Error(`非法展会状态：${patch.status}（允许 Planned | Ongoing | Completed | Cancelled）`);
    }
    if (patch.startDate && !DATE_RE.test(patch.startDate)) throw new Error('startDate 必须是 YYYY-MM-DD');
    if (patch.endDate && !DATE_RE.test(patch.endDate)) throw new Error('endDate 必须是 YYYY-MM-DD');
    if (patch.seasonId) await assertSeasonExists(patch.seasonId);
    const data: Record<string, unknown> = { updatedAt: BigInt(now()) };
    for (const f of SHOW_PATCH_FIELDS) {
      if ((patch as any)[f] !== undefined) data[f] = (patch as any)[f];
    }
    const updated = await db.tradeShow.update({ where: { id: show.id }, data });
    logger.info('[SeasonService] trade show updated', { id: show.id, actorId, fields: Object.keys(patch) });
    return updated;
  }

  async function deleteTradeShow(id: string, actorId: string): Promise<void> {
    const show = await getTradeShowOrThrow(id);
    await db.tradeShow.update({ where: { id: show.id }, data: { deletedAt: BigInt(now()), updatedAt: BigInt(now()) } });
    logger.info('[SeasonService] trade show soft-deleted', { id: show.id, actorId });
  }

  // ─── 线索 ───

  async function getLeadOrThrow(leadId: string): Promise<TradeShowLead> {
    const lead = await db.tradeShowLead.findUnique({ where: { id: leadId } });
    if (!lead || lead.deletedAt !== null) throw new Error('线索不存在');
    return lead;
  }

  async function addLead(showId: string, input: LeadInput, actorId: string): Promise<TradeShowLead> {
    await getTradeShowOrThrow(showId);
    if (!input.customerName?.trim()) throw new Error('客户姓名必填');
    if (input.status && !(LEAD_STATUSES as readonly string[]).includes(input.status)) {
      throw new Error(`非法线索状态：${input.status}（允许 New | Following | Converted | Lost）`);
    }
    const ts = now();
    const lead = await db.tradeShowLead.create({
      data: {
        id: generateId('TRDL'),
        tradeShowId: showId,
        customerName: input.customerName.trim(),
        company: input.company ?? null,
        country: input.country ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        demand: input.demand ?? null,
        status: input.status ?? 'New',
        nextFollowUpAt: input.nextFollowUpAt ?? null,
        notes: input.notes ?? null,
        createdAt: BigInt(ts),
        updatedAt: BigInt(ts),
      },
    });
    logger.info('[SeasonService] lead added', { id: lead.id, showId, actorId });
    return lead;
  }

  const LEAD_PATCH_FIELDS = [
    'customerName', 'company', 'country', 'email', 'phone', 'demand',
    'status', 'nextFollowUpAt', 'notes',
  ] as const;

  async function updateLead(leadId: string, patch: LeadPatch, actorId: string): Promise<TradeShowLead> {
    const lead = await getLeadOrThrow(leadId);
    // 转化必须走 convertLead（保证 status/convertedRelationId/convertedAt 一致写入）
    if ((patch as any).convertedRelationId !== undefined) {
      throw new Error('convertedRelationId 不允许直接修改，线索转化必须走 convert 接口');
    }
    if (patch.status && !(LEAD_STATUSES as readonly string[]).includes(patch.status)) {
      throw new Error(`非法线索状态：${patch.status}（允许 New | Following | Converted | Lost）`);
    }
    const data: Record<string, unknown> = { updatedAt: BigInt(now()) };
    for (const f of LEAD_PATCH_FIELDS) {
      if ((patch as any)[f] !== undefined) data[f] = (patch as any)[f];
    }
    const updated = await db.tradeShowLead.update({ where: { id: lead.id }, data });
    logger.info('[SeasonService] lead updated', { id: lead.id, actorId, fields: Object.keys(patch) });
    return updated;
  }

  async function deleteLead(leadId: string, actorId: string): Promise<void> {
    const lead = await getLeadOrThrow(leadId);
    await db.tradeShowLead.update({ where: { id: lead.id }, data: { deletedAt: BigInt(now()), updatedAt: BigInt(now()) } });
    logger.info('[SeasonService] lead soft-deleted', { id: lead.id, actorId });
  }

  /** 线索转化：线索 → category=Customer 的 Relation（事务内一致写入，禁止重复转化） */
  async function convertLead(leadId: string, relationId: string, actorId: string): Promise<TradeShowLead> {
    if (!relationId) throw new Error('relationId 必填');
    const ts = now();
    const updated: TradeShowLead = await db.$transaction(async (tx: any) => {
      const lead = await tx.tradeShowLead.findUnique({ where: { id: leadId } });
      if (!lead || lead.deletedAt !== null) throw new Error('线索不存在');
      if (lead.status === 'Converted') throw new Error('线索已转化，禁止重复转化');
      const relation = await tx.relation.findUnique({ where: { id: relationId } });
      if (!relation || relation.deletedAt !== null) throw new Error('转化目标 Relation 不存在');
      if (relation.category !== 'Customer') {
        throw new Error('仅 category=Customer 的 Relation 可作为线索转化对象');
      }
      return tx.tradeShowLead.update({
        where: { id: leadId },
        data: { status: 'Converted', convertedRelationId: relationId, convertedAt: BigInt(ts), updatedAt: BigInt(ts) },
      });
    });
    logger.info('[SeasonService] lead converted', { id: leadId, relationId, actorId });
    return updated;
  }

  /** 展会 ROI：线索转化客户（Relation）的订单金额 / 展会费用 */
  async function getShowROI(showId: string): Promise<ShowROI> {
    const show = await getTradeShowOrThrow(showId);
    const leads = await db.tradeShowLead.findMany({ where: { tradeShowId: showId, deletedAt: null } });
    const converted = leads.filter((l: any) => l.status === 'Converted');
    const relationIds = converted.map((l: any) => l.convertedRelationId).filter(Boolean);

    let orderCount = 0;
    let orderAmount = 0;
    if (relationIds.length) {
      const orders = await db.order.findMany({
        where: { deletedAt: null, customerRelationId: { in: relationIds } },
      });
      orderCount = orders.length;
      orderAmount = orders.reduce((s: number, o: any) => s + orderAmountOf(o), 0); // ★ 唯一真源
    }

    const cost = show.cost !== null && show.cost !== undefined ? Number(show.cost) : null;
    const roi = cost && cost > 0 ? orderAmount / cost : null;
    return {
      cost,
      currency: show.currency ?? 'CNY',
      leadsTotal: leads.length,
      leadsConverted: converted.length,
      orderCount,
      orderAmount,
      roi,
    };
  }

  return {
    createSeason,
    listSeasons,
    getSeason,
    updateSeason,
    deleteSeason,
    computeSeasonReview,
    generateSeasonReview,
    createTrendTag,
    listTrendTags,
    updateTrendTag,
    deleteTrendTag,
    linkFabric,
    unlinkFabric,
    listTrendingFabrics,
    createTradeShow,
    listTradeShows,
    getTradeShow,
    updateTradeShow,
    deleteTradeShow,
    addLead,
    updateLead,
    deleteLead,
    convertLead,
    getShowROI,
  };
}

export type SeasonService = ReturnType<typeof createSeasonService>;
