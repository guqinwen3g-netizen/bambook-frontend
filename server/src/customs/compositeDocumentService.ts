import { businessNowDate } from '../shared/businessClock';
import { packingListFileUnavailable } from './shipmentPackingListCommand';
/**
 * 组合文档服务（2026-08-22 B3 多选叠加生成 / B8 扩展 CONTRACT / 2026-08-28 批次 H3 登记台账）—— 多对一数据层聚合。
 *
 * 架构裁决：
 *   - 叠加 = 数据聚合而非 PDF 拼页：多业务记录合并为单一数据集 → 单张文档呈现
 *   - 批次 H3 留档裁决（推翻"不登记"旧裁决）：合并装箱单/合并合同装配成功即幂等登记
 *     TradeDocument（domain=customs，sourceRef=composite:{kind}:{排序后 id 列表} 唯一定位，
 *     v1 快照携带装配数据冻结归档）——事后可在单据中心查回/重渲染；同组合重复预览/生成
 *     只刷新头字段不追加版本。MERGED_IR 按任务包口径不登记（即时汇总产物）。
 *   - 渲染复用：lifecycleService 按 sourceRef 解析回链 → 实时重装配渲染；真源记录被删
 *     时回落 v1 快照数据（归档语义）
 *   - 聚合复用既有装配器：合并 PL 逐运单调 assembleDocumentSetData（单一回退链
 *     真源不变），合并 IR 逐报告调 loadInspectionReportDocData
 *
 * 已支持组合类型：
 *   MERGED_PL — 多运单合并装箱单（合票出运场景：lines 重编行号 + 跨运单 totals 重算）→ 登记 type=PackingList
 *   MERGED_IR — 多验货报告合并汇总（跨报告合计 + 每报告一节）→ 不登记
 *   CONTRACT — 多订单合并销售合同（B8：订单一览 + 合并明细 + 通用条款；单订单确认走 OC 域单据）→ 登记 type=Contract
 *   （CI 多订单合票走财务发票 orderIds[] 真源，已有能力，不在此重复）
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { businessError } from '../shared/errorCodes';
import { documentSetHttpErrorCode } from '../shipping/documentSetService';
import { logger } from '../lib/logger';
import { orderAmountOrNull } from '../shared/orderAmount';
import { assembleDocumentSetData } from '../shipping/documentSetService';
import { loadInspectionReportDocData } from '../templates/docTemplates/inspectionReport';
import type { MergedDocumentSetData, MergedDocumentSetLine } from '../templates/docTemplates/mergedPackingList';
import type { MergedInspectionSummaryData } from '../templates/docTemplates/mergedInspectionSummary';
import type { ContractDocData, ContractDocLine, ContractOrderInfo } from '../templates/docTemplates/contract';
import type { TradeDocumentType } from './customsService';
import { todayLocalKey } from '../shared/localDate';


/** 组合文档类型（COMPOSITE 注册表 kind——前端组合生成入口按此选择） */
export const COMPOSITE_DOC_KINDS = ['MERGED_PL', 'MERGED_IR', 'CONTRACT'] as const;
export type CompositeDocKind = (typeof COMPOSITE_DOC_KINDS)[number];

export interface CompositeDocInput {
  kind: CompositeDocKind;
  /** MERGED_PL：运单 id 列表（≥2）；MERGED_IR：验货报告 id 列表（≥2）；CONTRACT：订单 id 列表（≥2） */
  sourceIds: string[];
}

export function isCompositeDocKind(kind: string): kind is CompositeDocKind {
  return (COMPOSITE_DOC_KINDS as readonly string[]).includes(kind);
}

// ────────────────────────────────────────────────────────────────
// 批次 H3：组合生成留档（登记 TradeDocument 台账）
// ────────────────────────────────────────────────────────────────

/** 组合单据 sourceRef 前缀（lifecycleService 渲染分支按此前缀识别回链） */
export const COMPOSITE_SOURCE_REF_PREFIX = 'composite:';

/** 组合 kind → 登记单据类型（MERGED_IR 无映射=不登记，按任务包口径保持即时产物） */
export const COMPOSITE_TRADE_DOC_TYPE: Partial<Record<CompositeDocKind, TradeDocumentType>> = {
  MERGED_PL: 'PackingList',
  CONTRACT: 'Contract',
};

/** 组合 sourceRef 构建：sourceIds 排序后拼接——同组合任意顺序命中同一台账记录（幂等定位） */
export function buildCompositeSourceRef(kind: CompositeDocKind, sourceIds: string[]): string {
  return `${COMPOSITE_SOURCE_REF_PREFIX}${kind}:${[...sourceIds].sort().join(',')}`;
}

/** 组合 sourceRef 解析（非法/非组合回链返回 null） */
export function parseCompositeSourceRef(ref: string | null | undefined): { kind: CompositeDocKind; sourceIds: string[] } | null {
  if (!ref || !ref.startsWith(COMPOSITE_SOURCE_REF_PREFIX)) return null;
  const rest = ref.slice(COMPOSITE_SOURCE_REF_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const kind = rest.slice(0, sep);
  if (!isCompositeDocKind(kind)) return null;
  const sourceIds = rest.slice(sep + 1).split(',').map(s => s.trim()).filter(Boolean);
  if (sourceIds.length < 2) return null;
  return { kind, sourceIds };
}

const nowTs = (): bigint => BigInt(Date.now());

function generateCompositeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function localDateToday(): string {
  const d = businessNowDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface RegisterCompositeResult {
  documentId: string | null;
  documentNumber: string | null;
  /** created=首次登记（含 v1 快照）；updated=同组合已存在刷新头字段；skipped=该 kind 不登记或无 tradeDocument 模型 */
  outcome: 'created' | 'updated' | 'skipped';
}

/**
 * 组合单据登记（幂等）：domain=customs + type + sourceRef 唯一定位。
 *   - 首次：创建 TradeDocument（Draft，自动取号 PL-/CT-）+ v1 快照
 *     （content={ source:'composite', kind, sourceIds, data }——装配数据冻结归档，
 *      真源记录被删后仍可回落快照渲染；日常渲染走 sourceRef 实时重装配）
 *   - 已存在：刷新头字段（金额/币种/签发日随最新装配），不追加版本
 * 登记失败由调用方决定是否阻断（assembleCompositeDocument 默认 warn 不阻断输出）。
 */
export async function registerCompositeTradeDocument(
  prisma: PrismaClient,
  params: { kind: CompositeDocKind; sourceIds: string[]; data: unknown; actorId?: string },
): Promise<RegisterCompositeResult> {
  if (params.kind === 'MERGED_PL') packingListFileUnavailable();
  const type = COMPOSITE_TRADE_DOC_TYPE[params.kind];
  if (!type) return { documentId: null, documentNumber: null, outcome: 'skipped' };
  const db = prisma as any;
  if (!db?.tradeDocument) return { documentId: null, documentNumber: null, outcome: 'skipped' };

  const actorId = params.actorId?.trim() || 'system';
  const sourceRef = buildCompositeSourceRef(params.kind, params.sourceIds);
  const totals = (params.data as Record<string, any> | null)?.totals ?? {};
  const totalAmount = totals.amount != null && Number.isFinite(Number(totals.amount)) ? Number(totals.amount) : null;
  const currency = typeof totals.currency === 'string' && totals.currency ? totals.currency : null;

  const { appendTradeDocumentVersion, generateTradeDocumentNumber } = await import('./tradeDocumentLifecycleService');

  const existing = await db.tradeDocument.findFirst({
    where: { domain: 'customs', type, sourceRef, deletedAt: null },
    select: { id: true, documentNumber: true },
  });

  if (existing) {
    await db.$transaction(async (tx: any) => {
      await tx.tradeDocument.update({
        where: { id: existing.id },
        data: {
          totalAmount: totalAmount != null ? new Prisma.Decimal(totalAmount) : undefined,
          currency: currency ?? undefined,
          issueDate: localDateToday(),
          updatedAt: nowTs(),
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateCompositeId('AUD'),
          action: 'TRADE_DOCUMENT_DOMAIN_REFRESH',
          actorId,
          targetType: 'TradeDocument',
          targetId: existing.id,
          detail: { domain: 'customs', type, sourceRef, source: 'composite' },
        },
      });
    });
    logger.info('[CompositeDocument] 台账刷新（同组合已登记）', { id: existing.id, documentNumber: existing.documentNumber, kind: params.kind });
    return { documentId: existing.id, documentNumber: existing.documentNumber, outcome: 'updated' };
  }

  const documentId = generateCompositeId('TD');
  let documentNumber = '';
  await db.$transaction(async (tx: any) => {
    documentNumber = await generateTradeDocumentNumber(tx, type);
    const ts = nowTs();
    await tx.tradeDocument.create({
      data: {
        id: documentId,
        documentNumber,
        domain: 'customs',
        type,
        status: 'Draft',
        shipmentId: null,
        declarationId: null,
        orderId: null,
        relationId: null,
        sourceRef,
        issueDate: localDateToday(),
        totalAmount: totalAmount != null ? new Prisma.Decimal(totalAmount) : null,
        currency,
        createdAt: ts,
        updatedAt: ts,
      },
    });
    await appendTradeDocumentVersion(tx, {
      documentId,
      content: { source: 'composite', kind: params.kind, sourceIds: [...params.sourceIds], data: params.data as Record<string, unknown> },
      actorId,
      changeReason: '组合生成登记',
    });
    await tx.auditLog.create({
      data: {
        id: generateCompositeId('AUD'),
        action: 'TRADE_DOCUMENT_CREATE',
        actorId,
        targetType: 'TradeDocument',
        targetId: documentId,
        detail: { documentNumber, type, source: 'composite', kind: params.kind, sourceRef },
      },
    });
  });
  logger.info('[CompositeDocument] 台账登记', { id: documentId, documentNumber, kind: params.kind, sourceCount: params.sourceIds.length });
  return { documentId, documentNumber, outcome: 'created' };
}

// ────────────────────────────────────────────────────────────────
// 1. MERGED_PL：多运单合并装配
// ────────────────────────────────────────────────────────────────

/**
 * 多运单合并装配（合票出运场景）：
 *   - 逐运单调 assembleDocumentSetData（字段回退链真源不变）→ 拼装
 *   - lines 重编行号 1..n，每行标注来源运单（shipmentIndex）
 *   - totals 对合并 lines 重算（与单运单 sumField 同语义），无行数据时运单级兜底相加
 *   - parties 取首个非空（合票通常同客户）；missing 汇总去重
 * 任一运单装配失败（不存在/软删）抛错整体失败（fail-closed，不生成半份合并单）。
 */
export async function assembleMergedDocumentSet(
  prisma: PrismaClient,
  shipmentIds: string[],
): Promise<MergedDocumentSetData> {
  if (!Array.isArray(shipmentIds) || shipmentIds.length < 2) {
    throw businessError('VALIDATION_FAILED', '合并装箱单至少需要 2 个运单');
  }

  const results = await Promise.all(
    shipmentIds.map(async (id) => {
      const result = await assembleDocumentSetData(prisma, id);
      if (!result.ok || !result.data) {
        // ★ B68-1（v2.46）：域内已经把"是哪种失败"说清楚了（记录没了 / 装配抛了异常），
        //   这里按**声明**换档，不把内层文本再猜一遍 —— 旧写法抛无码 Error，档位只能由
        //   路由看一句中文决定，于是 `装配失败：HS 编码不存在` 会被说成 400、真数据层故障也被说成 400。
        const code = result.error ? documentSetHttpErrorCode(result.error.code) : 'ASSEMBLE_FAILED';
        throw businessError(code, `运单 ${id} 装配失败：${result.error?.message ?? '数据缺失'}`);
      }
      return result.data;
    }),
  );

  const lines: MergedDocumentSetLine[] = [];
  results.forEach((ds, shipmentIndex) => {
    for (const l of ds.lines) {
      lines.push({ ...l, shipmentIndex: shipmentIndex + 1 });
    }
  });

  // totals：合并行求和（round 4），行级缺失时运单级兜底相加
  const sum = (vals: Array<number | null | undefined>, fallbacks: Array<number | null | undefined>): number | null => {
    const lineSum = vals.reduce<number | null>((acc, v) => (v == null ? acc : (acc ?? 0) + v), null);
    if (lineSum != null) return Math.round(lineSum * 10000) / 10000;
    const fallbackSum = fallbacks.reduce<number | null>((acc, v) => (v == null ? acc : (acc ?? 0) + v), null);
    return fallbackSum;
  };

  const currencies = results.map(ds => ds.totals.currency).filter(Boolean);
  const missing = [...new Set(results.flatMap(ds => ds.missing ?? []))];

  const firstParty = <T>(pick: (ds: (typeof results)[number]) => T | null | undefined): T | null => {
    for (const ds of results) {
      const v = pick(ds);
      if (v) return v;
    }
    return null;
  };

  return {
    shipments: results.map(ds => ds.shipment),
    orders: results.map(ds => ds.order),
    parties: {
      customer: firstParty(ds => ds.parties.customer),
      consignee: firstParty(ds => ds.parties.consignee),
      carrier: firstParty(ds => ds.parties.carrier),
    },
    lines,
    totals: {
      quantity: sum(lines.map(l => l.quantity), results.map(ds => ds.shipment.totalPackages)),
      amount: sum(lines.map(l => l.amount), results.map(ds => ds.totals.amount)),
      cartons: sum(lines.map(l => l.cartons), results.map(ds => ds.shipment.totalPackages)),
      grossWeight: sum(lines.map(l => l.grossWeight), results.map(ds => ds.shipment.grossWeight)),
      netWeight: sum(lines.map(l => l.netWeight), results.map(ds => ds.shipment.netWeight)),
      volume: sum(lines.map(l => l.volume), results.map(ds => ds.shipment.volume)),
      currency: currencies[0] ?? null,
    },
    missing,
  };
}

// ────────────────────────────────────────────────────────────────
// 2. MERGED_IR：多验货报告合并汇总
// ────────────────────────────────────────────────────────────────

/**
 * 多验货报告合并汇总装配：逐报告复用 loadInspectionReportDocData（真源实时装配），
 * 汇总缺陷/合格/结论分布。任一报告不存在抛错整体失败（fail-closed）。
 */
export async function loadMergedInspectionSummary(
  prisma: PrismaClient,
  reportIds: string[],
): Promise<MergedInspectionSummaryData> {
  if (!Array.isArray(reportIds) || reportIds.length < 2) {
    throw businessError('VALIDATION_FAILED', '合并验货汇总至少需要 2 份报告');
  }

  const reports = await Promise.all(
    reportIds.map(async (id) => {
      const data = await loadInspectionReportDocData(prisma, id);
      if (!data) throw businessError('NOT_FOUND', `验货报告 ${id} 不存在`);
      return data;
    }),
  );

  const totalUnits = reports.reduce((acc, r) => acc + r.report.totalUnits, 0);
  const passedUnits = reports.reduce((acc, r) => acc + r.report.passedUnits, 0);

  return {
    reports,
    summary: {
      count: reports.length,
      totalUnits,
      passedUnits,
      failedUnits: Math.max(0, totalUnits - passedUnits),
      criticalDefects: reports.reduce((acc, r) => acc + r.report.criticalDefects, 0),
      majorDefects: reports.reduce((acc, r) => acc + r.report.majorDefects, 0),
      minorDefects: reports.reduce((acc, r) => acc + r.report.minorDefects, 0),
      passCount: reports.filter(r => r.report.result === 'pass').length,
      conditionalCount: reports.filter(r => r.report.result === 'conditional').length,
      failCount: reports.filter(r => r.report.result === 'fail').length,
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 3. CONTRACT：多订单合并销售合同装配（B8）
// ────────────────────────────────────────────────────────────────

/**
 * 多订单合并合同装配：
 *   - 逐订单读取 Order + lines（真源实时装配），订单一览 + 合并明细（行标订单序号）
 *   - 合同号：首个非空 finalContractNumber / salesContractNumber（跨订单同号场景），
 *     否则 SC-YYYYMMDD-N 临时编号（仅展示用）
 *   - totals：行级 netValue 求和，缺失时订单级 quoteAmount 兜底相加；币种取首个非空
 *   - 客户档案：首个非空 customerRelationId 的 Relation；缺档案回落冗余 customer 名
 * 任一订单不存在/软删抛错整体失败（fail-closed，不生成半份合同）。
 */
export async function assembleContractData(
  prisma: PrismaClient,
  orderIds: string[],
): Promise<ContractDocData> {
  if (!Array.isArray(orderIds) || orderIds.length < 2) {
    throw businessError('VALIDATION_FAILED', '合并合同至少需要 2 个订单（单订单确认请用订单确认书）');
  }

  const orders = await Promise.all(
    orderIds.map(async (id) => {
      const o = await prisma.order.findUnique({
        where: { id },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });
      if (!o || o.deletedAt) throw businessError('NOT_FOUND', `订单 ${id} 不存在`);
      return o;
    }),
  );

  const contractDate = todayLocalKey();
  const contractNumber =
    orders.map(o => o.finalContractNumber).find(Boolean) ||
    orders.map(o => o.salesContractNumber).find(Boolean) ||
    `SC-${contractDate.replace(/-/g, '')}-${orders.length}`;

  // 客户档案：首个非空 customerRelationId
  const firstRelationId = orders.map(o => o.customerRelationId).find(Boolean) ?? null;
  const relation = firstRelationId
    ? await prisma.relation.findUnique({ where: { id: firstRelationId } })
    : null;

  /**
   * ★ 2026-09-29：合同条款要用的口岸在**运单**上（Order 上没有）⇒ 按 orderId 查一次。
   *   取不到就是 null，模板会印「未载明」（**不编**）。
   */
  const shipments = await prisma.shipment.findMany({
    where: { orderId: { in: orders.map((o) => o.id) }, deletedAt: null },
    select: { orderId: true, portOfLoading: true, portOfDischarge: true },
  });
  const portByOrder = new Map<string, { from: string | null; to: string | null }>();
  for (const sh of shipments) {
    if (!sh.orderId) continue;
    const cur = portByOrder.get(sh.orderId) ?? { from: null, to: null };
    portByOrder.set(sh.orderId, {
      from: cur.from ?? (sh as { portOfLoading?: string | null }).portOfLoading ?? null,
      to: cur.to ?? (sh as { portOfDischarge?: string | null }).portOfDischarge ?? null,
    });
  }

  const orderInfos: ContractOrderInfo[] = orders.map((o, i) => ({
    index: i + 1,
    orderId: o.id,
    poNumber: o.poNumber,
    customer: o.customer,
    currency: String(o.currency || o.salesCurrency || 'USD'),
    // 真源（① 明细行 → ② totalNet → ③ 报价额）。上面 findUnique 带 include lines ⇒ ① 可达。
    // ★ E 批 2026-09-26：原先直抄主档 quoteAmount，喂给合同模板「Amount 金额」那一格
    //   ⇒ 合并合同（客户签署的那张）上「订单一览的金额」与「合并明细行」可以是两个数。
    orderAmount: orderAmountOrNull(o),
    dueDate: o.dueDate,
    /**
     * ★ 2026-09-29：把**装运期**带进合同数据 —— 真实合同第 1 条就是"装运期"，
     *   而它**不是** `dueDate`（交期）。不接这一条，模板就只能印「未载明」。
     */
    shipmentDate: (o as { shipmentDate?: string | null }).shipmentDate ?? null,
    // ★ 2026-09-29：合同条款三项（迁移补的列）+ 口岸（从运单查）
    insuranceMode: (o as { insuranceMode?: string | null }).insuranceMode ?? null,
    claimPeriodDays: (o as { claimPeriodDays?: number | null }).claimPeriodDays ?? null,
    disputeResolution: (o as { disputeResolution?: string | null }).disputeResolution ?? null,
    portOfLoading: portByOrder.get(o.id)?.from ?? null,
    portOfDischarge: portByOrder.get(o.id)?.to ?? null,
    deliveryTerms: o.deliveryTerms,
    paymentTerms: o.paymentTerms,
    salesContractNumber: o.salesContractNumber,
    finalContractNumber: o.finalContractNumber,
    lineCount: o.lines.length,
  }));

  const lines: ContractDocLine[] = [];
  orders.forEach((o, orderIdx) => {
    for (const l of o.lines) {
      lines.push({
        lineNumber: lines.length + 1,
        orderIndex: orderIdx + 1,
        itemNo: l.itemNo,
        description: l.description,
        quantity: l.quantity != null ? Number(l.quantity) : null,
        unit: l.unit,
        unitPrice: l.unitPrice != null ? Number(l.unitPrice) : null,
        netValue: l.netValue != null ? Number(l.netValue) : null,
        /**
         * ★ 2026-09-29：把**行级真实容差**带进合同数据 —— 让条款区能印真实值，
         *   而不是自造一句「默认 ±5%，行业惯例」。
         *   取不到就是 `null`（模板渲染「见各行（本合同未载明统一容差）」），
         *   **绝不回落成 5** —— 回落＝又替客户编一个数。
         */
        tolerancePercent: (l as { tolerancePercent?: unknown }).tolerancePercent != null
          ? Number((l as { tolerancePercent?: unknown }).tolerancePercent)
          : null,
      });
    }
  });

  const sumNullable = (vals: Array<number | null>): number | null =>
    vals.reduce<number | null>((acc, v) => (v == null ? acc : (acc ?? 0) + v), null);

  const currencies = orderInfos.map(o => o.currency).filter(Boolean);
  // 兜底那一档也跟着换成真源：`orderInfos[].orderAmount` 现在就是真源值，
  // 比原来 Σ 报价额更接近「这张合同的总额」；主档仍是 Σ 明细行。
  const amount = sumNullable(lines.map(l => l.netValue)) ?? sumNullable(orderInfos.map(o => o.orderAmount));

  return {
    contractNumber,
    contractDate,
    customer: relation
      ? { name: relation.name, englishName: relation.englishName, chineseName: relation.chineseName, contactInfo: relation.contactInfo }
      : null,
    orders: orderInfos,
    lines,
    totals: {
      currency: currencies[0] ?? 'USD',
      amount: amount != null ? Math.round(amount * 10000) / 10000 : null,
      quantity: sumNullable(lines.map(l => l.quantity)),
    },
  };
}

/** 组合装配选项（批次 H3） */
export interface AssembleCompositeOptions {
  /**
   * 登记 TradeDocument 台账（默认 true；MERGED_PL/CONTRACT 有效，MERGED_IR 不登记）。
   * 渲染复用路径（lifecycleService 按 sourceRef 重装配）必须传 false 防回环。
   */
  register?: boolean;
  /** 操作人（审计/版本 changedBy；route 层透传真实登录人，非登录上下文缺省 system） */
  actorId?: string;
}

/**
 * 组合文档装配统一入口（route 层用）：
 * 按 kind 分发到对应聚合器，输出直接可喂 renderServerDocument 的数据。
 * 批次 H3：装配成功后默认幂等登记台账（登记失败 warn 不阻断预览/生成输出）。
 */
export async function assembleCompositeDocument(
  prisma: PrismaClient,
  input: CompositeDocInput,
  opts: AssembleCompositeOptions = {},
): Promise<{ kind: CompositeDocKind; data: unknown }> {
  if (input.kind === 'MERGED_PL') packingListFileUnavailable();
  if (!isCompositeDocKind(input.kind)) throw businessError('VALIDATION_FAILED', `未知组合文档类型: ${input.kind}`);
  let result: { kind: CompositeDocKind; data: unknown };
  if (input.kind === 'MERGED_PL') {
    result = { kind: input.kind, data: await assembleMergedDocumentSet(prisma, input.sourceIds) };
  } else if (input.kind === 'CONTRACT') {
    result = { kind: input.kind, data: await assembleContractData(prisma, input.sourceIds) };
  } else {
    result = { kind: input.kind, data: await loadMergedInspectionSummary(prisma, input.sourceIds) };
  }
  if (opts.register !== false) {
    try {
      await registerCompositeTradeDocument(prisma, {
        kind: result.kind,
        sourceIds: input.sourceIds,
        data: result.data,
        actorId: opts.actorId,
      });
    } catch (e: any) {
      logger.warn('[CompositeDocument] 台账登记失败（不阻断装配输出）', { kind: result.kind, error: e?.message });
    }
  }
  return result;
}
