import { todayLocalKey } from '../shared/localDate';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { completeDevelopmentFinanceTaskInTx, cancelDevelopmentFinanceTaskInTx } from '../development/developmentFinanceTask';
import { assertDevelopmentBillingCoverageCurrentInTx } from '../development/developmentBillingCoverageService';
import { lockDevelopmentCostSource, resolveOrderCostSource } from '../development/developmentCostSourceLock';
import { authorizeOrderCostReview } from '../pricing/orderCostReviewService';
import type { TokenPayload } from '../auth/service';
import { businessError, httpStatusOfCode } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { currentProformaActor } from './proformaInvoiceAccess';
import { assertDevelopmentBillingRouteAccess } from '../development/developmentBillingRouteAccess';
import { assertDevelopmentBillingNotClaimedInTx, lockDevelopmentCiDocumentsInTx } from '../development/developmentCommercialBillingService';
import { assertDevelopmentBillingInvoiceFacts } from './developmentCiArMembers';
/**
 * billingItemService.ts — DR-053 阶段 3：收费事项（BillingItem）+ 成本记录（CostRecord）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品管理域设计.md §15
 * 费用四层表达（§12.8 结论修正第 4 点）：
 *   ① 费用发生 = CostRecord（成本记录，实际打样/邮寄/测试/开发花费，归集口径）
 *   ② 收费决定 = BillingItem（收费事项：应承担金额、免收/抵货款/内部归集决定）
 *   ③ 应收草稿 = Invoice(status=Draft, sourceType='BillingItem')——收费决定确认后才生成
 *   ④ 正式签发 = Invoice(status=Issued)——对客户生效；PI(Proforma) 仅外贸可选前置，非必经
 *
 * 幂等（对齐阶段 0 来源唯一约束）：
 *   - BillingItem → 应收草稿：Invoice.sourceType='BillingItem' + @@unique([sourceType,sourceId])
 *     数据库层兜底并发；重试先查已有票回填恢复（recovered=true），不重复建票；
 *   - 建票成功但回填失败 → 明确 BACKFILL_FAILED（可重试）。
 *
 * 净应收 = amount − waivedAmount − offsetAmount（派生值，不落库，服务端计算返回防漂移）。
 * 净应收 ≤ 0 时不开票（语义=免收/抵货款全额冲抵，无应收闭环），confirm 后可直接 invoiced。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { createInvoice } from '../finance/invoiceMutationService';
// ★ v3.15（B137）：入口读法只此一份（把"没填"与"非法"分开，见 shared/moneyInput 的档位说明）
import { parseNonNegativeDecimal } from '../shared/moneyInput';
import { logger } from '../lib/logger';

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, error: { code, message, status } });
const ok = <T>(data: T): Result<T> => ({ ok: true, data });

const D = (v: unknown): Prisma.Decimal => new Prisma.Decimal(String(v ?? 0));

/** CostRecord uses Decimal(18,4): reject rounding/overflow before any write. */
function readCostAmount(raw: unknown, field: string) {
  const parsed = parseNonNegativeDecimal(raw, field);
  if (!parsed.ok) return parsed;
  const value = D(parsed.value);
  if (value.decimalPlaces() > 4 || value.gte('100000000000000')) {
    return { ok: false as const, message: `${field}最多4位小数，且必须小于100000000000000` };
  }
  return { ok: true as const, value };
}

/** 来源类型白名单（BillingItem.sourceType / CostRecord.sourceType 共用主集合）
 *  T2/CIF-FOB：加 'Shipment'（运费应收通路）——拍板口径「CIF 运费不计成本、开运费应收」，
 *  BillingItem(chargeType=shipping_fee, bearer=customer) 挂运单，替代在毛利表里硬拆运费。 */
export const BILLING_SOURCE_TYPES = ['Sample', 'SealSample', 'SampleBatch', 'DevelopmentCase', 'OrderLine', 'CostRecord', 'Shipment'] as const;
// DR-054 阶段 E：CostRecord.sourceType 加 'Order'（大货样品费用归属订单）；BillingItem 支持 'CostRecord' 直连（费用行为收费决定单位）
export const COST_SOURCE_TYPES = [...BILLING_SOURCE_TYPES, 'Order', 'Quotation'] as const;
export const CHARGE_TYPES = ['sample_fee', 'shipping_fee', 'testing_fee', 'development_fee', 'other'] as const;
export const COST_TYPES = ['sample_making', 'shipping', 'testing', 'development', 'other'] as const;
export const BEARER_TYPES = ['customer', 'internal', 'supplier'] as const;
export const BILLING_STATUSES = ['draft', 'confirmed', 'invoiced', 'cancelled'] as const;

function genId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}__${Date.now().toString(36).toUpperCase()}${rand}`;
}
function str(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s || null;
}

/** 来源行 → 收费默认上下文（客户、默认金额、描述）。未挂档案时仅返回来源行信息。 */
async function resolveSource(prisma: PrismaClient, sourceType: string, sourceId: string, strict = false): Promise<{
  customerRelationId?: string | null;
  customerName?: string | null;
  defaultAmount?: number | string | null;
  costType?: string | null;
  description: string;
}> {
  if (sourceType === 'Sample') {
    const row = await (prisma as any).sample.findFirst({ where: { id: sourceId, deletedAt: null } }).catch(() => null);
    if (!row) return { description: `样品 ${sourceId}` };
    let customerName: string | null = null;
    if (row.customerRelationId) {
      const rel = await (prisma as any).relation?.findFirst?.({ where: { id: row.customerRelationId } }).catch(() => null) ?? null;
      customerName = rel?.name ?? null;
    }
    return {
      customerRelationId: row.customerRelationId ?? null,
      customerName,
      defaultAmount: row.shippingFee != null ? Number(row.shippingFee) : null,
      description: `样品 ${row.code}`,
    };
  }
  if (sourceType === 'SealSample') {
    const row = await (prisma as any).sealSample.findFirst({ where: { id: sourceId, deletedAt: null } }).catch(() => null);
    if (!row) return { description: `封样 ${sourceId}` };
    let customerRelationId: string | null = row.customerRelationId ?? null;
    let customerName: string | null = row.customerName ?? null;
    if (!customerRelationId && row.developmentCaseId) {
      const devCase = await (prisma as any).developmentCase.findFirst({ where: { id: row.developmentCaseId, deletedAt: null } }).catch(() => null);
      customerRelationId = devCase?.customerRelationId ?? null;
      customerName = devCase?.customerName ?? null;
    }
    return { customerRelationId, customerName, description: `封样 ${row.sealCode}` };
  }
  if (sourceType === 'SampleBatch') {
    const row = await (prisma as any).sampleBatch.findFirst({ where: { id: sourceId, deletedAt: null } }).catch(() => null);
    if (!row) return { description: `批次 ${sourceId}` };
    let customerRelationId: string | null = null;
    let customerName: string | null = null;
    if (row.developmentCaseId) {
      const devCase = await (prisma as any).developmentCase.findFirst({ where: { id: row.developmentCaseId, deletedAt: null } }).catch(() => null);
      customerRelationId = devCase?.customerRelationId ?? null;
      customerName = devCase?.customerName ?? null;
    }
    return {
      customerRelationId,
      customerName,
      defaultAmount: row.shippingFee != null ? Number(row.shippingFee) : null,
      description: `批次 ${row.batchCode}`,
    };
  }
  if (sourceType === 'DevelopmentCase') {
    const row = await (prisma as any).developmentCase.findFirst({ where: { id: sourceId, deletedAt: null } }).catch(() => null);
    if (!row) return { description: `开发案 ${sourceId}` };
    return {
      customerRelationId: row.customerRelationId ?? null,
      customerName: row.customerName ?? null,
      defaultAmount: row.sampleShippingFee != null ? Number(row.sampleShippingFee) : null,
      description: `开发案 ${row.code}${row.name ? `（${row.name}）` : ''}`,
    };
  }
  if (sourceType === 'OrderLine') {
    const row = await (prisma as any).orderLine.findUnique({ where: { id: sourceId } }).catch(() => null);
    if (!row) return { description: `订单行 ${sourceId}` };
    let customerRelationId: string | null = null;
    let customerName: string | null = null;
    if (row.orderId) {
      const order = await (prisma as any).order.findFirst({ where: { id: row.orderId, deletedAt: null } }).catch(() => null);
      customerRelationId = order?.customerRelationId ?? null;
      customerName = order?.customerName ?? null;
    }
    return { customerRelationId, customerName, description: `订单行 ${row.id.slice(0, 8)}` };
  }
  if (sourceType === 'Order') {
    // DR-054 阶段 E：大货样品费用归属订单（sourceId = Order.id）
    const row = await (prisma as any).order.findFirst({ where: { id: sourceId, deletedAt: null } }).catch(() => null);
    if (!row) return { description: `订单 ${sourceId}` };
    return {
      customerRelationId: row.customerRelationId ?? null,
      customerName: row.customerName ?? null,
      description: `订单 ${row.code || row.poNumber || sourceId}`,
    };
  }
  if (sourceType === 'Shipment') {
    // T2/CIF-FOB 运费应收：来源运单（sourceId = Shipment.id）。承担方默认运单开票对象
    //（customerRelationId），默认金额取运费 freightAmount（CIF 运费向客户开应收）。
    const row = await (prisma as any).shipment.findFirst({ where: { id: sourceId, deletedAt: null } }).catch(() => null);
    if (!row) return { description: `运单 ${sourceId}` };
    return {
      customerRelationId: row.customerRelationId ?? null,
      customerName: row.customerName ?? null,
      defaultAmount: row.freightAmount != null ? Number(row.freightAmount) : null,
      description: `运单 ${row.shipmentNumber}（运费）`,
    };
  }
  if (sourceType === 'CostRecord') {
    // DR-054 阶段 E：费用行直连收费决定（费用行为收费决定单位）
    const row = await (prisma as any).costRecord.findFirst({ where: { id: sourceId, deletedAt: null } }).catch(() => null);
    if (!row) return { description: `费用行 ${sourceId}` };
    let customerRelationId: string | null = null;
    let customerName: string | null = null;
    if (row.bearerRelationId) {
      const rel = await (prisma as any).relation?.findFirst?.({ where: { id: row.bearerRelationId } }).catch(() => null) ?? null;
      customerName = rel?.name ?? null;
    }
    return {
      customerRelationId: row.bearerType === 'customer' ? (row.bearerRelationId ?? null) : null,
      customerName,
      defaultAmount: row.amount.toString(),
      costType: row.costType ?? null,
      description: `费用 ${row.recordNo}（${row.costType}）`,
    };
  }
  return { description: sourceId };
}

// ───────────────────────────────────────────────────────────────────
// CostRecord：费用发生（成本记录）
// ───────────────────────────────────────────────────────────────────

export interface CreateCostRecordInput {
  sourceType: string; sourceId: string; costType: string;
  amount: number | string; currency?: string; incurredAt?: string;
  bearerType?: string; bearerRelationId?: string; notes?: string;
}

function validateCostRecordInput(input: CreateCostRecordInput) {
  const throwFail = (code: string, message: string, status = 400): never => {
    throw Object.assign(new Error(message), { __billingFail: true, code, status, httpStatus: status, statusCode: status });
  };
  if (!COST_SOURCE_TYPES.includes(input.sourceType as any)) throwFail('INVALID_SOURCE_TYPE', `sourceType 必须是 ${COST_SOURCE_TYPES.join('|')}`, 400);
  if (!COST_TYPES.includes(input.costType as any)) throwFail('INVALID_COST_TYPE', `costType 必须是 ${COST_TYPES.join('|')}`, 400);
  // ★ B143（v3.15 复核 I-2）：这里以前走 `assertNumber`，它先做 `Number(v)` ⇒
  //   `''` / `'  '` / `false` / `[]` 全被折成 **0 收进库**，而"根本没传"却是 400。
  //   同一个端点对"没填"和"填了个不是数的东西"给出**相反**的答案。接同一个读数口后两者各归各：
  //   没传 ⇒ 400（未变）；空白/布尔/数组/垃圾串 ⇒ 400（新）；0 ⇒ 合法（未变）。
  const costAmountRead = readCostAmount(input.amount, '成本金额');
  if (!costAmountRead.ok) return throwFail('INVALID_AMOUNT', costAmountRead.message, 400);
  return costAmountRead.value;
}

/** Caller owns the transaction so cost creation and pending-expense resolution commit together. */
export async function createCostRecordInTx(tx: any, params: {
  input: CreateCostRecordInput; actorId: string; ip?: string | null; trustedActor?: TokenPayload;
}): Promise<any> {
  const { input, actorId, ip } = params;
  const amount = validateCostRecordInput(input);
  await lockDevelopmentCostSource(tx,input.sourceType,input.sourceId);
  const orderId=await resolveOrderCostSource(tx,input.sourceType,input.sourceId);
  if(orderId){
    if(!params.trustedActor||params.trustedActor.userId!==actorId){const error=businessError('FORBIDDEN','订单费用需要可信的当前操作者');throw Object.assign(error,{__billingFail:true,status:error.statusCode,httpStatus:error.statusCode});}
    try{await authorizeOrderCostReview(tx,params.trustedActor,'write',orderId);}
    catch(error:any){if(typeof error?.statusCode==='number')throw Object.assign(error,{__billingFail:true,status:error.statusCode,httpStatus:error.statusCode});throw error;}
  }
  const bearerType = BEARER_TYPES.includes(input.bearerType as any) ? input.bearerType : 'customer';
  const currency = str(input.currency) || 'CNY';
  const incurredAt = str(input.incurredAt) || todayLocalKey();
  const now = BigInt(Date.now());
  const created = await tx.costRecord.create({
    data: {
      id: genId('CR'),
      recordNo: await nextBusinessNumber(tx, 'CR', undefined, {
        occupied: async recordNo => !!(await tx.costRecord.findFirst({ where: { recordNo }, select: { id: true } })),
      }),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      costType: input.costType,
      amount: D(amount),
      currency,
      incurredAt,
      bearerType,
      bearerRelationId: str(input.bearerRelationId) ?? undefined,
      notes: str(input.notes) ?? undefined,
      createdAt: now,
      updatedAt: now,
    },
  });
  await writeRouteAuditLog({
    prisma: tx, actorId, source: 'route:billing', operation: 'create_cost_record',
    targetType: 'CostRecord', targetId: created.id,
    after: { recordNo: created.recordNo, sourceType: created.sourceType, sourceId: created.sourceId, costType: created.costType, amount: created.amount.toString(), currency: created.currency },
    ip: ip ?? null,
  });
  return created;

}

export async function createCostRecord(params: {
  prisma: PrismaClient; input: CreateCostRecordInput; actorId: string; ip?: string | null; trustedActor?: TokenPayload;
}): Promise<Result<{ costRecord: any }>> {
  const { prisma, ...options } = params;
  try {
    validateCostRecordInput(options.input);
    const costRecord = await (prisma as any).$transaction((tx: any) => createCostRecordInTx(tx, options));
    return ok({ costRecord });
  } catch (e: any) {
    if (e?.__billingFail) return fail(e.code, e.message, e.httpStatus);
    return fail('CREATE_FAILED', `登记成本失败：${String(e?.message ?? e)}`, 500);
  }
}

export async function listCostRecords(params: {
  prisma: PrismaClient;
  accessWhere?: Record<string,unknown>;
  query: { sourceType?: string; sourceId?: string; limit?: number; offset?: number };
}): Promise<Result<{ costRecords: any[]; total: number }>> {
  const { prisma, query } = params;
  const where: any = { deletedAt: null, ...(params.accessWhere?{AND:[params.accessWhere]}:{}) };
  if (query.sourceType) where.sourceType = query.sourceType;
  if (query.sourceId) where.sourceId = query.sourceId;
  const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
  const offset = Number(query.offset ?? 0) || 0;
  const [rows, total] = await Promise.all([
    (prisma as any).costRecord.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit }),
    (prisma as any).costRecord.count({ where }),
  ]);
  return ok({ costRecords: rows, total });
}

/**
 * DR-054 阶段 E：候选费用行汇总（开票勾选源）。
 * 按业务来源聚合其下全部 CostRecord：开发案（直接 + 其下批次/样品/封样）、批次、样品、订单。
 * 每行附 occupied 占用状态：已被未取消收费事项引用（costRecordId）或已被发票行占用（InvoiceLine
 * @@unique 同键）→ 不可重复开票。
 */
export async function listCostCandidateRows(params: {
  prisma: PrismaClient;
  accessWhere?: Record<string,unknown>;
  query: { caseId?: string; batchId?: string; sampleId?: string; orderId?: string; limit?: number; offset?: number };
}): Promise<Result<{ rows: any[]; total: number }>> {
  const { prisma, query } = params;
  try {
  const ors: any[] = [];
  if (query.caseId) {
    ors.push({ sourceType: 'DevelopmentCase', sourceId: query.caseId });
    const [batchRows, sampleRows, sealRows] = await Promise.all([
      (prisma as any).sampleBatch.findMany({ where: { developmentCaseId: query.caseId, deletedAt: null }, select: { id: true } }),
      (prisma as any).sample.findMany({ where: { sourceCaseId: query.caseId, deletedAt: null }, select: { id: true } }),
      (prisma as any).sealSample.findMany({ where: { developmentCaseId: query.caseId, deletedAt: null }, select: { id: true } }),
    ]);
    const batchIds = (batchRows as any[]).map(b => b.id);
    const sampleIds = (sampleRows as any[]).map(s => s.id);
    const sealIds = (sealRows as any[]).map(s => s.id);
    if (batchIds.length) ors.push({ sourceType: 'SampleBatch', sourceId: { in: batchIds } });
    if (sampleIds.length) ors.push({ sourceType: 'Sample', sourceId: { in: sampleIds } });
    if (sealIds.length) ors.push({ sourceType: 'SealSample', sourceId: { in: sealIds } });
  }
  if (query.batchId) ors.push({ sourceType: 'SampleBatch', sourceId: query.batchId });
  if (query.sampleId) ors.push({ sourceType: 'Sample', sourceId: query.sampleId });
  if (query.orderId) ors.push({ sourceType: 'Order', sourceId: query.orderId });
  if (ors.length === 0) return ok({ rows: [], total: 0 });

  const where: any = { deletedAt: null, OR: ors, ...(params.accessWhere?{AND:[params.accessWhere]}:{}) };
  const limit = Math.min(Number(query.limit ?? 100) || 100, 300);
  const offset = Number(query.offset ?? 0) || 0;
  const [rows, total] = await Promise.all([
    (prisma as any).costRecord.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit }),
    (prisma as any).costRecord.count({ where }),
  ]);

  // 占用状态：有效发票行（一费用行一张票，数据库唯一约束；**已作废票不占用**——作废即释放，可重开）
  //   ∪ 未取消 BillingItem.costRecordId。occupiedByLabel 供开票前标注与硬拦截提示（§10.7 开票互斥口径）。
  const occupied = new Set<string>();
  const occupiedBy = new Map<string, string>();
  const recordIds = (rows as any[]).map(r => r.id);
  if (recordIds.length) {
    const [lineRows, biRows, coverageRows] = await Promise.all([
      (prisma as any).invoiceLine.findMany({ where: { sourceType: 'CostRecord', sourceId: { in: recordIds } }, select: { sourceId: true, invoiceId: true } }),
      (prisma as any).billingItem.findMany({ where: { costRecordId: { in: recordIds }, deletedAt: null, status: { not: 'cancelled' } }, select: { costRecordId: true, itemNo: true, status: true } }),
      prisma.billingItemCostCoverage.findMany({ where: { costRecordId: { in: recordIds }, releasedAt: null }, select: { costRecordId: true, billingItemId: true } }),
    ]);
    const lineInvoiceIds = [...new Set((lineRows as any[]).map(l => l.invoiceId))];
    const liveInvoices = lineInvoiceIds.length
      ? await (prisma as any).invoice.findMany({ where: { id: { in: lineInvoiceIds }, status: { not: 'Cancelled' }, deletedAt: null }, select: { id: true, invoiceNumber: true } })
      : [];
    const liveNoById = new Map((liveInvoices as any[]).map(i => [i.id, i.invoiceNumber]));
    for (const l of lineRows as any[]) {
      const no = liveNoById.get(l.invoiceId);
      if (no) { occupied.add(l.sourceId); occupiedBy.set(l.sourceId, `发票 ${no}`); }
    }
    for (const coverage of coverageRows) {
      occupied.add(coverage.costRecordId);
      occupiedBy.set(coverage.costRecordId, `整案收费 ${coverage.billingItemId}`);
    }
    for (const b of biRows as any[]) {
      occupied.add(b.costRecordId);
      occupiedBy.set(b.costRecordId, `收费事项 ${b.itemNo}`);
    }
  }
  const sourceLabels = await resolveCostSourceLabels(prisma, rows as any[]);
  return ok({
    rows: (rows as any[]).map(r => ({
      id: r.id,
      recordNo: r.recordNo,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      costType: r.costType,
      amount: Number(r.amount),
      currency: r.currency,
      incurredAt: r.incurredAt,
      bearerType: r.bearerType,
      notes: r.notes,
      sourceLabel: sourceLabels.get(r.id) ?? null,
      occupied: occupied.has(r.id),
      occupiedBy: occupiedBy.get(r.id) ?? null,
    })),
    total,
  });
  } catch (error: any) {
    logger.error('[BillingItem] cost candidate scope or occupancy lookup failed', {error:error?.message});
    return fail('COST_CANDIDATES_LOAD_FAILED','费用来源或占用状态未能完整加载，请重试；不能按费用为空或未收费继续处理',500);
  }
}

/** 费用行来源标签（开发案编号/批次号/样品编号/订单号），用于开票勾选展示 */
async function resolveCostSourceLabels(prisma: PrismaClient, rows: any[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const group = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!group.has(r.sourceType)) group.set(r.sourceType, new Set());
    group.get(r.sourceType)!.add(r.sourceId);
  }
  const byId = async (model: string, ids: Set<string>, format: (row: any) => string) => {
    if (ids.size === 0) return;
    const found = await (prisma as any)[model].findMany({ where: { id: { in: [...ids] }, deletedAt: null } }).catch(() => []);
    // key 与 sourceType 枚举大小写一致（DevelopmentCase/SampleBatch/Sample/SealSample/Order）
    const sourceType = model === 'developmentCase' ? 'DevelopmentCase' : model === 'sampleBatch' ? 'SampleBatch' : model === 'sealSample' ? 'SealSample' : model === 'sample' ? 'Sample' : model === 'order' ? 'Order' : model;
    for (const row of found as any[]) map.set(`${sourceType}:${row.id}`, format(row));
  };
  await Promise.all([
    byId('developmentCase', group.get('DevelopmentCase') ?? new Set(), (row) => `${row.code}${row.name ? `（${row.name}）` : ''}`),
    byId('sampleBatch', group.get('SampleBatch') ?? new Set(), (row) => `批次 ${row.batchCode}`),
    byId('sample', group.get('Sample') ?? new Set(), (row) => `样品 ${row.code}`),
    byId('sealSample', group.get('SealSample') ?? new Set(), (row) => `封样 ${row.sealCode}`),
    byId('order', group.get('Order') ?? new Set(), (row) => `订单 ${row.code || row.poNumber || row.id}`),
  ]);
  for (const r of rows) {
    const label = map.get(`${r.sourceType}:${r.sourceId}`) ?? null;
    if (label) map.set(r.id, label);
  }
  return map;
}

// ───────────────────────────────────────────────────────────────────
// BillingItem：收费决定（收费事项）
// ───────────────────────────────────────────────────────────────────

/**
 * 收费事项创建 —— **事务内版本**（D7-①「转售双侧同事务」的前置能力）。
 *
 * 与 `createBillingItem` 的分工（**刻意拆成两个函数，勿合并**）：
 *   - 本函数**一律 throw**，不返回 `Result`。因为调用方通常已有自己的事务，
 *     而「在事务里返回 ok:false、让调用方自己判断」是个陷阱 —— 调用方一旦忘了看返回值，
 *     外层事务会照常提交，于是留下**一半成功**的数据（样品已扣、应收没建）。
 *     用 throw 则天然把外层事务带崩、整体回滚。
 *   - `createBillingItem` 负责开事务 + 把 throw 映射回 `Result`（既有 HTTP 契约不变）。
 *
 * 参数 `tx` 传 Prisma 事务客户端即可（delegate 齐全，`resolveSource` 内部已用可选链兜底）。
 */
export async function createBillingItemInTx(tx: any, params: {
  input: {
    sourceType: string; sourceId: string; chargeType: string;
    amount?: number | string; currency?: string;
    bearerType?: string; bearerRelationId?: string;
    costRecordId?: string; // DR-054 阶段 E：关联主成本记录（费用发生→收费决定）；sourceType='CostRecord' 时自动取 sourceId
    waivedAmount?: number | string; offsetAmount?: number | string; offsetOrderId?: string;
    notes?: string;
    registerCost?: { costType?: string; amount?: number; currency?: string; incurredAt?: string; bearerType?: string; bearerRelationId?: string; notes?: string };
  };
  actorId: string; ip?: string | null; trustedActor?: TokenPayload;
}): Promise<any> {
  const { input, actorId, ip } = params;
  /** 校验失败 → throw（携带与 `fail()` 同款的 code/status，供外层映射回 Result） */
  const throwFail = (code: string, message: string, status = 400): never => {
    throw Object.assign(new Error(message), { __billingFail: true, code, httpStatus: status, statusCode: status });
  };

  if (!BILLING_SOURCE_TYPES.includes(input.sourceType as any)) throwFail('INVALID_SOURCE_TYPE', `sourceType 必须是 ${BILLING_SOURCE_TYPES.join('|')}`, 400);
  // CostRecord 直连时 chargeType 缺省（自动映射）；其他来源必填且必须在白名单
  if (input.chargeType && !CHARGE_TYPES.includes(input.chargeType as any)) throwFail('INVALID_CHARGE_TYPE', `chargeType 必须是 ${CHARGE_TYPES.join('|')}`, 400);
  if (input.sourceType !== 'CostRecord' && !input.chargeType) throwFail('INVALID_CHARGE_TYPE', `chargeType 必须是 ${CHARGE_TYPES.join('|')}`, 400);

  const source = await resolveSource(tx, input.sourceType, input.sourceId);

  // DR-054 阶段 E：一 CostRecord 最多被一个未 cancelled 的 BillingItem 引用（应用层校验；并发由查后写兜底）。
  // sourceType='CostRecord' 直连时，费用行自身即收费决定单位（costRecordId = sourceId）。
  const costRecordId = input.sourceType === 'CostRecord' ? input.sourceId : (input.costRecordId ?? null);
  if (costRecordId) {
    const cost = await tx.costRecord.findFirst({ where: { id: costRecordId, deletedAt: null } });
    if (!cost) throwFail('INVALID_COST_SOURCE', '费用记录不存在或已删除', 404);
    await lockDevelopmentCostSource(tx, cost.sourceType, cost.sourceId);
    const locked = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${costRecordId} AND "deletedAt" IS NULL FOR UPDATE`);
    if (!locked.length) throwFail('INVALID_COST_SOURCE', '费用记录不存在或已删除', 404);
    const occupied = await tx.billingItem.findFirst({ where: { costRecordId, deletedAt: null, status: { not: 'cancelled' } }, select: { id: true, itemNo: true } });
    const coverage = await tx.billingItemCostCoverage.findFirst({ where: { costRecordId, releasedAt: null } });
    const invoice = await tx.invoiceLine.findFirst({ where: { sourceType: 'CostRecord', sourceId: costRecordId } });
    if (occupied || coverage || invoice) throwFail('COST_ALREADY_BILLED', '费用已被收费事项、整案收费或发票占用，请核实原记录', 409);
  }
  // CostRecord 直连：chargeType 缺省时按费用类型映射
  const chargeType = input.sourceType === 'CostRecord' && !input.chargeType
    ? ({ sample_making: 'sample_fee', shipping: 'shipping_fee', testing: 'testing_fee', development: 'development_fee', other: 'other' } as Record<string, string>)[String((source as any).costType || 'other')] || 'other'
    : input.chargeType;

  /**
   * ★ v3.15（B137）· 这里原先是 `assertNumber(input.amount,'amount') ?? source.defaultAmount ?? 0`，
   *   而换算口 `assertNumber`（**本文件已删的旧函数**，v3.16 起所有调用点都改走 `shared/moneyInput`）
   *   把**三件事压成同一个 `null`**：没填 / 非数 / **负数**（`n < 0` 也返回 null）。
   *   ⇒ 后果不是"提示不友好"，是**负数金额被静默换成费用源的默认金额**（没默认就换成 0）并照常开单；
   *   ⇒ 而紧跟其后的 `if (amount === null) throwFail('INVALID_AMOUNT',…)` **结构上永不可达**（`?? 0` 保证非 null）
   *     —— 一条看起来存在、其实一次都没执行过的校验，正是 §2 G3 判据 L-A 记的形态。
   *   本文件另外两条路径（成本记录、`registerCost`）当时也是"读到 null 就拒"⇒ 我据此说"拒非法是既有口径"。
   *   ⚠️ **那句话当时只是半真**（v3.15 复核 I-2 指出，v3.16 的 §9 B143 才修）：旧换算口**先做 `Number(v)`**，
   *   所以空白串 / `false` / `[]` 连 null 都拿不到，是被**折成 0 收进库**的；`true`、`'0x10'`、`'0o17'`
   *   同理被折成 1 / 16 / 15（这一条比"折成 0"更坏：是**存进去一个谁也没同意过的数**）。
   *   ⚠️ "没填 ⇒ 走默认金额"这一半**行为不动**；★ **v3.91（D107 自裁）收紧的是它后面那一截**（~~"再没有就是 0"~~）：
   *   §12.1 第 28 条按行业标准判成 **(b) 拒**（与理赔域 A6「0 元处置无意义」同族）⇒ **没填 + 来源没有默认金额 = 当场拒**，
   *   未定价的行不许静默变成 0 元应收；**显式填 0 仍合法**（免费行要人写出 0）。
   */
  const amountRead = parseNonNegativeDecimal(input.amount, '收费金额');
  if (!amountRead.ok && amountRead.reason !== 'missing') throwFail('INVALID_AMOUNT', amountRead.message, 400);
  const amount = amountRead.ok
    ? D(amountRead.value)
    : source.defaultAmount != null
      ? D(String(source.defaultAmount))
      : throwFail('INVALID_AMOUNT', '收费金额未填写，且该来源没有默认金额 ⇒ 请显式填写金额（要开免费行请填 0）');
  const waivedRead = parseNonNegativeDecimal(input.waivedAmount, '免收金额');
  if (!waivedRead.ok && waivedRead.reason !== 'missing') throwFail('INVALID_AMOUNT', waivedRead.message, 400);
  const waivedAmount = waivedRead.ok ? D(waivedRead.value) : D(0);
  const offsetRead = parseNonNegativeDecimal(input.offsetAmount, '抵货款金额');
  if (!offsetRead.ok && offsetRead.reason !== 'missing') throwFail('INVALID_AMOUNT', offsetRead.message, 400);
  const offsetAmount = offsetRead.ok ? D(offsetRead.value) : D(0);
  if (waivedAmount.plus(offsetAmount).gt(amount)) throwFail('INVALID_WAIVED', '免收+抵货款合计不能超过收费总额', 400);

  const bearerType = BEARER_TYPES.includes(input.bearerType as any) ? input.bearerType : 'customer';
  const bearerRelationId = str(input.bearerRelationId) ?? source.customerRelationId ?? undefined;
  const currency = str(input.currency) || 'CNY';
  const now = BigInt(Date.now());

  // 可选登记成本记录（费用发生层），并关联为主成本记录；无登记时沿用外部直连/传入的 costRecordId
  let effectiveCostRecordId = costRecordId;
  if (input.registerCost) {
    const costType = COST_TYPES.includes(input.registerCost.costType as any) ? input.registerCost.costType : 'other';
    // ★ B143：同一个读数口（旧写法把 `''`/`false`/`[]` 折成 0 直接落成本记录）。
    const registerCostRead = readCostAmount(input.registerCost.amount, '登记成本金额');
    if (!registerCostRead.ok) throw Object.assign(new Error(registerCostRead.message), { code: 'INVALID_AMOUNT' , statusCode: 400 });
    const costAmount = registerCostRead.value;
    const created = await createCostRecordInTx(tx, { actorId, ip, trustedActor: params.trustedActor, input: {
      sourceType: input.sourceType, sourceId: input.sourceId, costType: costType!,
      amount: costAmount.toString(), currency: str(input.registerCost.currency) || currency,
      incurredAt: str(input.registerCost.incurredAt) || todayLocalKey(),
      bearerType: BEARER_TYPES.includes(input.registerCost.bearerType as any) ? input.registerCost.bearerType : bearerType,
      bearerRelationId: str(input.registerCost.bearerRelationId) ?? bearerRelationId,
      notes: str(input.registerCost.notes) ?? undefined,
    } });
    effectiveCostRecordId = created.id;
  }

  // 抵扣订单快照
  let offsetOrderNumber: string | null = null;
  if (input.offsetOrderId) {
    const order = await tx.order.findFirst({ where: { id: input.offsetOrderId, deletedAt: null }, select: { code: true } }).catch(() => null);
    offsetOrderNumber = order?.code ?? null;
  }

  const created = await tx.billingItem.create({
    data: {
      id: genId('BI'),
      itemNo: await nextBusinessNumber(tx, 'BI', undefined, {
        occupied: async itemNo => !!(await tx.billingItem.findFirst({ where: { itemNo }, select: { id: true } })),
      }),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      costRecordId: effectiveCostRecordId ?? undefined,
      chargeType,
      bearerType,
      bearerRelationId,
      bearerName: source.customerName ?? undefined,
      amount: D(amount),
      currency,
      waivedAmount: D(waivedAmount),
      offsetAmount: D(offsetAmount),
      offsetOrderId: str(input.offsetOrderId) ?? undefined,
      offsetOrderNumber,
      status: 'draft',
      notes: str(input.notes) ?? undefined,
      createdAt: now,
      updatedAt: now,
    },
  });
  await writeRouteAuditLog({
    prisma: tx, actorId, source: 'route:billing', operation: 'create_billing_item',
    targetType: 'BillingItem', targetId: created.id,
    after: { itemNo: created.itemNo, sourceType: created.sourceType, sourceId: created.sourceId, chargeType: created.chargeType, amount: created.amount.toString(), currency: created.currency, waivedAmount: created.waivedAmount.toString(), offsetAmount: created.offsetAmount.toString() },
    ip: ip ?? null,
  });
  return serializeBillingItem(created);
}

export async function createBillingItem(params: {
  prisma: PrismaClient;
  input: {
    sourceType: string; sourceId: string; chargeType: string;
    amount?: number; currency?: string;
    bearerType?: string; bearerRelationId?: string;
    costRecordId?: string; // DR-054 阶段 E：关联主成本记录（费用发生→收费决定）；sourceType='CostRecord' 时自动取 sourceId
    waivedAmount?: number; offsetAmount?: number; offsetOrderId?: string;
    notes?: string;
    registerCost?: { costType?: string; amount?: number; currency?: string; incurredAt?: string; bearerType?: string; bearerRelationId?: string; notes?: string };
  };
  actorId: string; ip?: string | null; trustedActor?: TokenPayload;
}): Promise<Result<{ billingItem: any }>> {
  const { prisma, input, actorId, ip } = params;
  try {
    // 事务边界在这里；业务逻辑全在 createBillingItemInTx（throw 语义）内
    const billingItem = await (prisma as any).$transaction(
      (tx: any) => createBillingItemInTx(tx, { input, actorId, ip, trustedActor: params.trustedActor }),
    );
    return ok({ billingItem });
  } catch (e: any) {
    if (e?.__billingFail) return fail(e.code, String(e?.message ?? ''), e.httpStatus ?? 400);
    if (e?.code === 'INVALID_AMOUNT') return fail('INVALID_AMOUNT', String(e?.message ?? '金额非法'), 400);
    logger.error('[billing-item/create] failed', { error: e });
    const safe = safeRouteError(e, { fallbackCode: 'CREATE_FAILED', fallbackMessage: '创建收费事项失败，请稍后核对原请求。' });
    return fail(safe.code, safe.message, safe.status);
  }
}

export async function listBillingItems(params: {
  prisma: PrismaClient;
  accessWhere?: Record<string,unknown>;
  query: { sourceType?: string; sourceId?: string; status?: string; limit?: number; offset?: number };
}): Promise<Result<{ billingItems: any[]; total: number }>> {
  const { prisma, query } = params;
  const where: any = { deletedAt: null, ...(params.accessWhere?{AND:[params.accessWhere]}:{}) };
  if (query.sourceType) where.sourceType = query.sourceType;
  if (query.sourceId) where.sourceId = query.sourceId;
  if (query.status && BILLING_STATUSES.includes(query.status as any)) where.status = query.status;
  const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
  const offset = Number(query.offset ?? 0) || 0;
  const [rows, total] = await Promise.all([
    (prisma as any).billingItem.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit }),
    (prisma as any).billingItem.count({ where }),
  ]);
  return ok({ billingItems: rows.map(serializeBillingItem), total });
}

export async function getBillingItem(params: { prisma: PrismaClient; id: string }): Promise<Result<{ billingItem: any; flow: any }>> {
  const { prisma, id } = params;
  const row = await (prisma as any).billingItem.findFirst({ where: { id, deletedAt: null } }).catch(() => null);
  if (!row) return fail('NOT_FOUND', `收费事项 ${id} 不存在`, 404);
  const flow = await buildBillingFlow(prisma, row);
  return ok({ billingItem: serializeBillingItem(row), flow });
}

export async function updateBillingItem(params: {
  prisma: PrismaClient;
  id: string;
  input: {
    chargeType?: string; bearerType?: string; bearerRelationId?: string;
    amount?: number; currency?: string;
    waivedAmount?: number; offsetAmount?: number; offsetOrderId?: string; notes?: string;
  };
  actorId: string; ip?: string | null;
}): Promise<Result<{ billingItem: any }>> {
  const { prisma, id, input, actorId, ip } = params;
  const now = BigInt(Date.now());
  const row = await (prisma as any).billingItem.findFirst({ where: { id, deletedAt: null } }).catch(() => null);
  if (!row) return fail('NOT_FOUND', `收费事项 ${id} 不存在`, 404);
  if (row.developmentWorkflowState) return fail('WORKFLOW_REQUIRED', '请从原开发案修改收费方案，保留提交和退回记录', 409);
  if (row.status !== 'draft') return fail('LOCKED', `收费事项 ${row.itemNo} 已${row.status}，不可编辑（收费决定确认后锁定）`, 409);

  /**
   * ★ v3.15（B137 的第二半 —— 复核 B-1 抓出来的，我上一版只修了开单那一处）：
   *   编辑路径上同一族**改前**还有三处 `assertNumber(...) ?? Number(row.旧值)`（v3.15 复核 B-1 抓出、当批已修）。它的危害比开单那一处更隐蔽：
   *   **送负数或垃圾串不会报错，而是静默保留库里的旧值并返回 200"改好了"** ⇒ 单子一分没动，用户以为改了。
   *   接同一个读数口后：`missing`（只有 `null`/`undefined`）⇒ 保留旧值（PATCH 语义，与改前对 null/undefined 的行为逐字相同）；
   *   非法（负数 / 非数 / 空白串）⇒ 当场 400。⚠️ 有一处行为确实变了：`amount: ''` 以前被 JS 折成 0 写进库，现在拒
   *   —— 这是复核 B-2 实测逼出来的定夺：`Number('') === 0` 而 `??` 不吞 0，把 `''` 算成"没填"会让调用方去抬默认值
   *   （开单侧从"0 元单"变"120 元单"，方向是凭空多出钱），所以空白串一律归"非法"。
   */
  const readOrKeep = (raw: unknown, current: unknown, label: string): { value?: Prisma.Decimal; err?: string } => {
    const r = parseNonNegativeDecimal(raw, label);
    if (r.ok) return { value: D(r.value) };
    if (r.reason !== 'missing') return { err: r.message };
    return { value: D(String(current)) };
  };
  const readAmount = readOrKeep(input.amount, row.amount, '收费金额');
  if (readAmount.err) return fail('INVALID_AMOUNT', readAmount.err, 400);
  const readWaived = readOrKeep(input.waivedAmount, row.waivedAmount, '免收金额');
  if (readWaived.err) return fail('INVALID_AMOUNT', readWaived.err, 400);
  const readOffset = readOrKeep(input.offsetAmount, row.offsetAmount, '抵货款金额');
  if (readOffset.err) return fail('INVALID_AMOUNT', readOffset.err, 400);
  const amount = readAmount.value as Prisma.Decimal;
  const waivedAmount = readWaived.value as Prisma.Decimal;
  const offsetAmount = readOffset.value as Prisma.Decimal;
  if (waivedAmount.plus(offsetAmount).gt(amount)) return fail('INVALID_WAIVED', '免收+抵货款合计不能超过收费总额', 400);
  const chargeType = input.chargeType && CHARGE_TYPES.includes(input.chargeType as any) ? input.chargeType : row.chargeType;
  const bearerType = input.bearerType && BEARER_TYPES.includes(input.bearerType as any) ? input.bearerType : row.bearerType;

  let offsetOrderNumber: string | null = row.offsetOrderNumber;
  if (input.offsetOrderId) {
    const order = await (prisma as any).order?.findFirst?.({ where: { id: input.offsetOrderId, deletedAt: null }, select: { code: true } }).catch(() => null) ?? null;
    offsetOrderNumber = order?.code ?? null;
  }

  const data: any = {
    chargeType, bearerType,
    amount: D(amount),
    waivedAmount: D(waivedAmount),
    offsetAmount: D(offsetAmount),
    notes: str(input.notes) ?? row.notes,
    updatedAt: now,
  };
  if (input.bearerRelationId !== undefined) data.bearerRelationId = str(input.bearerRelationId) ?? null;
  if (input.currency && input.currency !== row.currency) data.currency = str(input.currency);
  if (input.offsetOrderId !== undefined) { data.offsetOrderId = str(input.offsetOrderId) ?? null; data.offsetOrderNumber = offsetOrderNumber; }

  try {
    const updated = await (prisma as any).$transaction(async (tx: any) => {
      if (row.sourceType === 'DevelopmentCase' || row.developmentExpenseReviewId) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${row.sourceId} FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${id} FOR UPDATE`);
      const current=await tx.billingItem.findFirst({where:{id,deletedAt:null}});
      const sameSnapshot=current && ['sourceId','developmentExpenseReviewId','updatedAt','amount','waivedAmount','offsetAmount','currency','bearerType','bearerRelationId','notes','offsetOrderId','chargeType'].every(key=>String(current[key]??'')===String(row[key]??''));
      if(!current||current.developmentWorkflowState||current.status!=='draft'||!sameSnapshot) throw Object.assign(new Error('收费草稿已被其他操作更新或确认，请刷新后重新核对'),{code:'BILLING_CHANGED', statusCode: 409 });
      const saved = await tx.billingItem.update({ where: { id }, data });
      await writeRouteAuditLog({
        prisma: tx, actorId, source: 'route:billing', operation: 'update_billing_item',
        targetType: 'BillingItem', targetId: id,
        before: { itemNo: row.itemNo, amount: row.amount.toString(), waivedAmount: row.waivedAmount.toString(), offsetAmount: row.offsetAmount.toString() },
        after: { itemNo: row.itemNo, amount: saved.amount.toString(), waivedAmount: saved.waivedAmount.toString(), offsetAmount: saved.offsetAmount.toString() },
        ip: ip ?? null,
      });
      return saved;
    });
    return ok({ billingItem: serializeBillingItem(updated) });
  } catch (e: any) {
    if(e?.code==='BILLING_CHANGED')return fail(e.code,e.message,409);
    return fail('UPDATE_FAILED', `更新收费事项失败：${String(e?.message ?? e)}`, 500);
  }
}

export async function confirmBillingItemInTx(tx: any, { row, actorId, ip }: { row: any; actorId: string; ip?: string | null }) {
  const id = row.id, now = BigInt(Date.now());
      if (row.sourceType === 'DevelopmentCase' || row.developmentExpenseReviewId) {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${row.sourceId} FOR UPDATE`);
      }
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${id} FOR UPDATE`);
      const current = await tx.billingItem.findFirst({ where: { id, deletedAt: null } });
      if (!current || current.status !== 'draft' || current.developmentExpenseReviewId !== row.developmentExpenseReviewId || current.sourceId !== row.sourceId) {
        throw Object.assign(new Error('收费草稿已变化，请刷新后确认'), { code: 'BILLING_CHANGED', status: 409 , statusCode: 409 });
      }
      if(current.sourceType==='DevelopmentCase'&&!current.developmentExpenseReviewId)throw Object.assign(new Error('整案收费草稿尚未绑定有效费用核齐依据，不能确认收费'),{code:'REVIEW_REQUIRED',status:409, statusCode: 409 });
      if(current.developmentWorkflowState&&current.developmentWorkflowState!=='ready')throw Object.assign(new Error('请先完成财务核对及必要审批'),{code:'BILLING_CHANGED',status:409, statusCode: 409 });
      if (current.developmentExpenseReviewId) await assertDevelopmentBillingCoverageCurrentInTx(tx, current);
      const saved = await tx.billingItem.update({
        where: { id },
        data: { status: 'confirmed', confirmedAt: now, confirmedBy: actorId, updatedAt: now },
      });
      await writeRouteAuditLog({
        prisma: tx, actorId, source: 'route:billing', operation: 'confirm_billing_item',
        targetType: 'BillingItem', targetId: id,
        before: { status: current.status },
        after: { status: 'confirmed', itemNo: current.itemNo, netAmount: Number(netOf(current)) },
        ip: ip ?? null,
      });
      return saved;
}

export async function confirmBillingItem(params: { prisma: PrismaClient; id: string; actorId: string; ip?: string | null }): Promise<Result<{ billingItem: any }>> {
  const { prisma, id, actorId, ip } = params;
  const now = BigInt(Date.now());
  const row = await (prisma as any).billingItem.findFirst({ where: { id, deletedAt: null } }).catch(() => null);
  if (!row) return fail('NOT_FOUND', `收费事项 ${id} 不存在`, 404);
  if (row.status === 'invoiced') return fail('ALREADY_INVOICED', `收费事项 ${row.itemNo} 已完结，不可重复确认`, 409);
  if (row.status === 'cancelled') return fail('CANCELLED', `收费事项 ${row.itemNo} 已取消，不可确认`, 409);
  if (row.status === 'confirmed') return fail('ALREADY_CONFIRMED', `收费事项 ${row.itemNo} 已确认`, 409);

  try {
    const confirmed = await (prisma as any).$transaction(async (tx: any) => {
      return confirmBillingItemInTx(tx, { row, actorId, ip });
    });
    return ok({ billingItem: serializeBillingItem(confirmed) });
  } catch (e: any) {
    if (['BILLING_CHANGED', 'INVALID_BILLING_SOURCE', 'REVIEW_REQUIRED', 'REVIEW_STALE', 'COVERAGE_CONFLICT'].includes(e?.code)) return fail(e.code, e.message, 409);
    return fail('CONFIRM_FAILED', `确认收费事项失败：${String(e?.message ?? e)}`, 500);
  }
}

/** Manual finance commands reuse one transaction for authority, source locks,
 * canonical Invoice writes, projections and mandatory audit. */
export class ManualInvoiceAbort extends Error {
  constructor(readonly failure: { code: string; message: string; status: number }) {
    super(failure.message);
  }
}
export function abortManualInvoice(code: string, message: string, status: number): never {
  throw new ManualInvoiceAbort({ code, message, status });
}
export function manualInvoiceFailure(error: unknown, fallbackCode: string, fallbackMessage: string) {
  if (error instanceof ManualInvoiceAbort) return fail(error.failure.code, error.failure.message, error.failure.status);
  const result = safeRouteError(error, { fallbackCode, fallbackMessage });
  return fail(result.code, result.message, result.status);
}
export async function currentManualInvoiceActor(tx: any, actorId: string, trustedActor?: TokenPayload | null) {
  if (trustedActor === null || trustedActor !== undefined && trustedActor.userId !== actorId)
    throw businessError('UNAUTHORIZED', '开票主体无法核验。');
  // Undefined is an explicit internal compatibility call; it still reloads
  // the actual active account and stored grants. No token or grant is invented.
  return currentProformaActor(tx, actorId, trustedActor);
}
const manualSourceModels: Record<string, string> = {
  DevelopmentCase: 'developmentCase', Order: 'order', OrderLine: 'orderLine',
  Sample: 'sample', SampleBatch: 'sampleBatch', SealSample: 'sealSample',
  CostRecord: 'costRecord', Shipment: 'shipment', Quotation: 'quotation',
};
type ManualSourceRef = { type: string; id: string };
type ManualSourceSnapshot = { refs: ManualSourceRef[]; signature: string };
/** Only persisted parent bindings are lock identities. Amounts and statuses are
 * reread after locks and continue to use the original business rules. */
async function readManualInvoiceSources(tx: any, sources: ManualSourceRef[]): Promise<ManualSourceSnapshot> {
  const refs = new Map<string, ManualSourceRef>();
  const bindings = new Map<string, unknown>();
  const visit = async (type: string, id: string, ancestry: Set<string>): Promise<void> => {
    const key = `${type}:${id}`;
    if (ancestry.has(key)) throw businessError('CONFLICT', '费用来源关联需要核对，请刷新后重试。');
    if (refs.has(key)) return;
    const model = manualSourceModels[type];
    if (!Object.prototype.hasOwnProperty.call(manualSourceModels, type) || !model || !id) throw businessError('NOT_FOUND', '费用来源不存在或无权操作。');
    const row = type === 'OrderLine'
      ? await tx[model].findUnique({ where: { id } })
      : await tx[model].findFirst({ where: { id, deletedAt: null } });
    if (!row || row.deletedAt != null) throw businessError('NOT_FOUND', '费用来源不存在或无权操作。');
    refs.set(key, { type, id });
    bindings.set(key, [row.id, row.sourceType ?? null, row.sourceId ?? null, row.sourceCaseId ?? null,
      row.developmentCaseId ?? null, row.orderId ?? null, row.sourceOrderId ?? null, row.orderLineId ?? null, row.convertedOrderId ?? null, row.customerRelationId ?? null]);
    const path = new Set(ancestry); path.add(key);
    if (type === 'CostRecord') await visit(row.sourceType, row.sourceId, path);
    if (type === 'Sample' && row.sourceCaseId) await visit('DevelopmentCase', row.sourceCaseId, path);
    if ((type === 'SampleBatch' || type === 'SealSample' || type === 'Quotation') && row.developmentCaseId)
      await visit('DevelopmentCase', row.developmentCaseId, path);
    if ((type === 'OrderLine' || type === 'Quotation') && row.orderId) await visit('Order', row.orderId, path);
    if (type === 'Sample' && row.sourceOrderId) await visit('Order', row.sourceOrderId, path);
    if (type === 'Quotation' && row.orderLineId) await visit('OrderLine', row.orderLineId, path);
    if (type === 'Quotation' && row.convertedOrderId) await visit('Order', row.convertedOrderId, path);
  };
  for (const source of sources) await visit(source.type, source.id, new Set());
  const priority = (type: string) => type === 'Order' || type === 'DevelopmentCase' ? 0 : type === 'CostRecord' ? 2 : 1;
  const sorted = [...refs.values()].sort((a, b) => priority(a.type) - priority(b.type) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  return { refs: sorted, signature: JSON.stringify([...bindings.entries()].sort(([a], [b]) => a.localeCompare(b))) };
}
async function lockManualInvoiceSource(tx: any, source: ManualSourceRef) {
  // Table names are the closed server whitelist above, never an HTTP value.
  const table = manualSourceModels[source.type];
  if (!Object.prototype.hasOwnProperty.call(manualSourceModels, source.type) || !table) throw businessError('NOT_FOUND', '费用来源不存在或无权操作。');
  const result = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${source.type}"`)} WHERE "id"=${source.id} FOR UPDATE`);
  if (!result.length) throw businessError('NOT_FOUND', '费用来源不存在或无权操作。');
}
export async function lockManualInvoiceSources(tx: any, sources: ManualSourceRef[], billingId?: string) {
  const before = await readManualInvoiceSources(tx, sources);
  for (const source of before.refs.filter(ref => ref.type !== 'CostRecord')) await lockManualInvoiceSource(tx, source);
  if (billingId) {
    const result = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${billingId} FOR UPDATE`);
    if (!result.length) throw businessError('NOT_FOUND', '收费记录不存在或无权操作。');
  }
  for (const source of before.refs.filter(ref => ref.type === 'CostRecord')) await lockManualInvoiceSource(tx, source);
  const after = await readManualInvoiceSources(tx, sources);
  if (after.signature !== before.signature) throw businessError('CONFLICT', '费用来源关联已变化，请刷新后核对。');
}
function billingInvoiceBinding(row: any) {
  return JSON.stringify([row.sourceType, row.sourceId, row.costRecordId ?? null, row.developmentExpenseReviewId ?? null]);
}

/** 收费事项 → 应收草稿，来源恢复、回填与审计同事务完成。 */
export async function invoiceBillingItem(params: {
  prisma: PrismaClient; id: string; input?: { issueDate?: string; notes?: string };
  actorId: string; trustedActor?: TokenPayload | null; ip?: string | null;
}): Promise<Result<{ billingItem: any; invoice?: any; recovered?: boolean; noReceivable?: boolean }>> {
  const { prisma, id, input, actorId, ip } = params;
  const effects: Array<() => Promise<void>> = [];
  try {
    const data = await prisma.$transaction(async (tx: any) => {
      let actor = await currentManualInvoiceActor(tx, actorId, params.trustedActor);
      const row = await assertDevelopmentBillingRouteAccess(tx, actor, id, 'write', { fresh: true });
      const sourceBinding = billingInvoiceBinding(row);
      const coverage = row.developmentExpenseReviewId
        ? await tx.billingItemCostCoverage.findMany({ where: { billingItemId: id, releasedAt: null }, orderBy: { costRecordId: 'asc' } }) : [];
      const initiallyNoReceivable = netOf(row).lte(0);
      const costIds = [...new Set<string>([row.costRecordId, ...coverage.map((line: any) => line.costRecordId)].filter(Boolean))].sort();
      if (row.sourceType === 'DevelopmentCase') {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${row.sourceId} AND "deletedAt" IS NULL FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${id} FOR UPDATE`);
        for (const costId of costIds) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${costId} FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCiBillingClaim" WHERE "billingItemId"=${id} ORDER BY "id" FOR UPDATE`);
        await lockDevelopmentCiDocumentsInTx(tx, row.sourceId);
      }
      await lockManualInvoiceSources(tx, [{ type: row.sourceType, id: row.sourceId }, ...costIds.map(costId => ({ type: 'CostRecord', id: costId }))], id);
      actor = await currentManualInvoiceActor(tx, actorId, params.trustedActor);
      const current = await assertDevelopmentBillingRouteAccess(tx, actor, id, 'write', { fresh: true });
      if (current.sourceType === 'DevelopmentCase') {
        const original = await tx.invoice.findFirst({ where: { deletedAt: null, ...(current.invoiceId ? { id: current.invoiceId } : { sourceType: 'BillingItem', sourceId: id }) } });
        if (original) {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "id"=${original.id} FOR UPDATE`);
          const actual = await tx.invoice.findFirst({ where: { id: original.id, deletedAt: null } });
          await assertLegacyDevelopmentBillingInvoiceInTx(tx, current, actual);
        }
        await assertDevelopmentBillingNotClaimedInTx(tx, current.sourceId, [current.id], undefined, original?.id);
      }
      if (billingInvoiceBinding(current) !== sourceBinding)
        throw businessError('CONFLICT', '收费来源已变化，请刷新后核对。');
      if (current.developmentExpenseReviewId) {
        const lockedCoverage = await tx.billingItemCostCoverage.findMany({ where: { billingItemId: id, releasedAt: null }, orderBy: { costRecordId: 'asc' } });
        if (JSON.stringify(lockedCoverage.map((line: any) => line.costRecordId).sort()) !== JSON.stringify(coverage.map((line: any) => line.costRecordId).sort()))
          throw businessError('CONFLICT', '收费覆盖范围已变化，请刷新后核对。');
      }
      if (current.status === 'cancelled') abortManualInvoice('CANCELLED', `收费事项 ${current.itemNo} 已取消，不可开票`, 409);
      if (current.status === 'invoiced') {
        if (!current.invoiceId) return { billingItem: serializeBillingItem(current), noReceivable: true };
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "id"=${current.invoiceId} FOR UPDATE`);
        const existing = await tx.invoice.findFirst({ where: { id: current.invoiceId, deletedAt: null } });
        if (!existing) abortManualInvoice('HANDOFF_CONFLICT', '原发票关联无法核对，请从财务核清原单。', 409);
        await currentManualInvoiceActor(tx, actorId, params.trustedActor);
        return { billingItem: serializeBillingItem(current), invoice: existing, recovered: true };
      }
      if (current.status !== 'confirmed') abortManualInvoice('NOT_CONFIRMED', `收费事项 ${current.itemNo} 尚未确认收费决定，请先确认后再开票`, 409);
      const net = netOf(current);
      if (initiallyNoReceivable && !net.eq(0)) abortManualInvoice('BILLING_CHANGED', '收费决定已变化，请刷新后核对', 409);
      if (net.lte(0)) {
        if (!net.eq(0)) throw businessError('CONFLICT', '收费决定已变化，请刷新后核对。');
        if (current.developmentExpenseReviewId) await assertDevelopmentBillingCoverageCurrentInTx(tx, current);
        try {
          const saved = await tx.billingItem.update({ where: { id }, data: { status: 'invoiced', updatedAt: BigInt(Date.now()) } });
          await completeDevelopmentFinanceTaskInTx(tx, saved, actorId);
          await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:billing', operation: 'invoice_billing_item_no_receivable', targetType: 'BillingItem', targetId: id,
            before: { status: current.status }, after: { status: 'invoiced', itemNo: current.itemNo, netAmount: 0, note: '免收/抵货款全额冲抵，无应收' }, ip: ip ?? null });
          await currentManualInvoiceActor(tx, actorId, params.trustedActor);
          return { billingItem: serializeBillingItem(saved), noReceivable: true };
        } catch (error) {
          if (error instanceof ManualInvoiceAbort || (error as any)?.statusCode) throw error;
          logger.error('[BillingItem] no receivable transaction failed', { id, error });
          throw new ManualInvoiceAbort({ code: 'NO_RECEIVABLE_FAILED', message: '免收完结未能完成，请刷新核对后重试', status: 500 });
        }
      }
      const existing = await tx.invoice.findFirst({ where: { sourceType: 'BillingItem', sourceId: id, deletedAt: null } });
      if (existing) {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "id"=${existing.id} FOR UPDATE`);
        const actual = await tx.invoice.findFirst({ where: { id: existing.id, deletedAt: null } });
        if (!actual) abortManualInvoice('HANDOFF_CONFLICT', '原发票关联无法核对，请从财务核清原单。', 409);
        const saved = await backfillBillingItemInvoiceIdInTx(tx, current, actual, actorId, ip ?? null);
        await currentManualInvoiceActor(tx, actorId, params.trustedActor);
        return { billingItem: serializeBillingItem(saved), invoice: actual, recovered: true };
      }
      const source = await resolveSource(tx, current.sourceType, current.sourceId, true);
      const bearerName = current.bearerName ?? source.customerName ?? undefined;
      const notes = [input?.notes ? str(input.notes) : null, `收费事项 ${current.itemNo}（${source.description}）`, netWaivedNote(current), netOffsetNote(current)].filter(Boolean).join('；');
      const r = await createInvoice({ prisma, transaction: { tx, deferAfterCommit: work => { effects.push(work); } }, actor, actorId, ip: ip ?? null,
        input: { invoiceNumber: `BI-INV-${Date.now().toString(36).toUpperCase()}`, type: 'Receivable', status: 'Draft', amount: net.toString(), currency: current.currency,
          issueDate: str(input?.issueDate) || todayLocalKey(), customerRelationId: current.bearerType === 'customer' ? current.bearerRelationId ?? undefined : undefined,
          customerName: current.bearerType === 'customer' ? bearerName : undefined, notes: notes || undefined, sourceType: 'BillingItem', sourceId: id,
          invoiceLines: current.costRecordId && !current.developmentExpenseReviewId
            ? [{ sourceType: 'CostRecord', sourceId: current.costRecordId, amount: net.toString(), currency: current.currency, description: `收费事项 ${current.itemNo} 主成本记录` }]
            : [{ sourceType: 'BillingItem', sourceId: id, amount: net.toString(), currency: current.currency, description: `收费事项 ${current.itemNo}` }], } });
      // Canonical reports failure as a Result. Throw so its partial work cannot
      // commit when canonical reuses this transaction.
      if (!r.ok) abortManualInvoice(r.error?.code ?? 'INVOICE_CREATE_FAILED', r.error?.message ?? '创建应收草稿失败', httpStatusOfCode(r.error?.code ?? 'INVOICE_CREATE_FAILED'));
      const invoice = r.data!.invoice;
      try {
        const saved = await backfillBillingItemInvoiceIdInTx(tx, current, invoice, actorId, ip ?? null);
        await currentManualInvoiceActor(tx, actorId, params.trustedActor);
        return { billingItem: serializeBillingItem(saved), invoice, recovered: false };
      } catch (error) {
        if (error instanceof ManualInvoiceAbort || (error as any)?.statusCode) throw error;
        logger.error('[BillingItem] invoice handoff rolled back', { id, error });
        throw new ManualInvoiceAbort({ code: 'BACKFILL_FAILED', message: '开票与收费关联未能完成，本次事务未确认成功，请核对后重试。', status: 500 });
      }
    });
    for (const effect of effects) await effect().catch(error => logger.error('[BillingItem] post-commit effect failed', { id, error }));
    return ok(data);
  } catch (error) {
    logger.error('[BillingItem] invoice transaction failed', { id, error });
    return manualInvoiceFailure(error, 'INVOICE_CREATE_FAILED', '开票未能完成，请核对原收费事项后重试。');
  }
}

export async function cancelBillingItem(params: { prisma: PrismaClient; id: string; reason?: string; actorId: string; ip?: string | null }): Promise<Result<{ billingItem: any }>> {
  const { prisma, id, reason, actorId, ip } = params;
  const now = BigInt(Date.now());
  const row = await (prisma as any).billingItem.findFirst({ where: { id, deletedAt: null } }).catch(() => null);
  if (!row) return fail('NOT_FOUND', `收费事项 ${id} 不存在`, 404);
  if (row.developmentWorkflowState) return fail('WORKFLOW_REQUIRED', '开发收费需通过专用流转取消，不能绕过当前待办', 409);
  if (row.status === 'invoiced') return fail('ALREADY_INVOICED', `收费事项 ${row.itemNo} 已开票，不可取消；请先作废对应发票`, 409);
  if (row.status === 'cancelled') return fail('ALREADY_CANCELLED', `收费事项 ${row.itemNo} 已取消`, 409);

  try {
    const updated = await (prisma as any).$transaction(async (tx: any) => {
      if (row.sourceType === 'DevelopmentCase' || row.developmentExpenseReviewId) {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${row.sourceId} FOR UPDATE`);
      }
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${id} FOR UPDATE`);
      const current = await tx.billingItem.findFirst({ where: { id, deletedAt: null } });
      if (!current || current.developmentWorkflowState || !['draft', 'confirmed'].includes(current.status) || current.sourceId !== row.sourceId || current.developmentExpenseReviewId !== row.developmentExpenseReviewId) {
        throw Object.assign(new Error('收费决定已变化，请刷新后处理'), { code: 'BILLING_CHANGED' , statusCode: 409 });
      }
      const invoice = await tx.invoice.findFirst({ where: { sourceType: 'BillingItem', sourceId: id } });
      if (current.invoiceId || invoice) throw Object.assign(new Error('已有应收单据，请先从财务处理原单据，不能直接取消收费'), { code: 'ALREADY_INVOICED' , statusCode: 409 });
      if (current.sourceType === 'DevelopmentCase') {
        const coverage = await tx.billingItemCostCoverage.findMany({ where: { billingItemId: id, releasedAt: null } });
        const costs = [...new Set<string>([current.costRecordId, ...coverage.map((line: any) => line.costRecordId)].filter(Boolean))].sort();
        for (const costId of costs) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${costId} FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCiBillingClaim" WHERE "billingItemId"=${id} ORDER BY "id" FOR UPDATE`);
        await lockDevelopmentCiDocumentsInTx(tx, current.sourceId);
        await assertDevelopmentBillingNotClaimedInTx(tx, current.sourceId, [id]);
      }
      if (current.developmentExpenseReviewId) {
        if (!str(reason)) throw Object.assign(new Error('取消整案收费必须填写原因'), { code: 'REASON_REQUIRED' , statusCode: 400 });
        const coverage = await tx.billingItemCostCoverage.findMany({ where: { billingItemId: id, releasedAt: null }, orderBy: { costRecordId: 'asc' } });
        for (const line of coverage) {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${line.costRecordId} FOR UPDATE`);
          await tx.billingItemCostCoverage.update({ where: { id: line.id }, data: { releasedAt: now, releaseReason: str(reason) } });
        }
      }
      const saved = await tx.billingItem.update({
        where: { id },
        data: { status: 'cancelled', notes: reason ? (`${current.notes ? `${current.notes}；` : ''}取消原因：${str(reason)}`) : current.notes, updatedAt: now },
      });
      await cancelDevelopmentFinanceTaskInTx(tx, saved, actorId, str(reason) ?? '取消收费');
      await writeRouteAuditLog({
        prisma: tx, actorId, source: 'route:billing', operation: 'cancel_billing_item',
        targetType: 'BillingItem', targetId: id,
        before: { status: current.status, itemNo: current.itemNo },
        after: { status: 'cancelled', reason: str(reason) ?? null },
        ip: ip ?? null,
      });
      return saved;
    });
    return ok({ billingItem: serializeBillingItem(updated) });
  } catch (e: any) {
    if (['BILLING_CHANGED', 'ALREADY_INVOICED', 'REASON_REQUIRED'].includes(e?.code)) return fail(e.code, e.message, 409);
    return fail('CANCEL_FAILED', `取消收费事项失败：${String(e?.message ?? e)}`, 500);
  }
}

// ───────────────────────────────────────────────────────────────────
// 内部工具
// ───────────────────────────────────────────────────────────────────

/** 净应收 = amount − waivedAmount − offsetAmount（派生，不落库） */
function netOf(row: any): Prisma.Decimal {
  return D(row.amount).minus(D(row.waivedAmount)).minus(D(row.offsetAmount));
}

function netWaivedNote(row: any): string | null {
  return D(row.waivedAmount).gt(0) ? `免收 ${D(row.waivedAmount).toNumber()} ${row.currency}` : null;
}
function netOffsetNote(row: any): string | null {
  if (!D(row.offsetAmount).gt(0)) return null;
  return `抵货款 ${D(row.offsetAmount).toNumber()} ${row.currency}${row.offsetOrderNumber ? `（${row.offsetOrderNumber}）` : ''}`;
}

function serializeBillingItem(row: any) {
  return {
    ...row,
    amount: Number(row.amount),
    waivedAmount: Number(row.waivedAmount),
    offsetAmount: Number(row.offsetAmount),
    netAmount: netOf(row).toNumber(),
    netAmountExact: netOf(row).toFixed(4),
  };
}

async function backfillBillingItemInvoiceIdInTx(tx: any, row: any, invoice: any, actorId: string, ip: string | null): Promise<any> {
  if (row.sourceType === 'DevelopmentCase') await assertLegacyDevelopmentBillingInvoiceInTx(tx, row, await tx.invoice.findFirst({ where: { id: invoice.id, deletedAt: null } }));
  if (row.developmentExpenseReviewId) {
    const actual = await tx.invoice.findFirst({ where: { id: invoice.id, deletedAt: null } });
    if (!actual || actual.status === 'Cancelled' || actual.sourceType !== 'BillingItem' || actual.sourceId !== row.id
      || !netOf(row).eq(actual.amount) || actual.currency !== row.currency || actual.customerRelationId !== row.bearerRelationId)
      abortManualInvoice('HANDOFF_CONFLICT', '应收结果与收费决定不一致，不能回填完成', 409);
    await assertDevelopmentBillingCoverageCurrentInTx(tx, row);
  }
  const saved = await tx.billingItem.update({ where: { id: row.id }, data: { status: 'invoiced', invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, updatedAt: BigInt(Date.now()) } });
  await completeDevelopmentFinanceTaskInTx(tx, saved, actorId);
  const sampleTable = row.sourceType === 'Sample' ? 'sample' : row.sourceType === 'SealSample' ? 'sealSample' : row.sourceType === 'SampleBatch' ? 'sampleBatch' : null;
  if (sampleTable) {
    const actualSource = await tx[sampleTable].findFirst({ where: { id: row.sourceId, deletedAt: null } });
    if (!actualSource) throw businessError('NOT_FOUND', '原收费来源不存在或无权操作。');
    const beforeInvoiceId = actualSource.invoiceId ?? null;
    await tx[sampleTable].update({ where: { id: row.sourceId }, data: { invoiceId: invoice.id } });
    await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:billing', operation: 'invoice_sample_link_backfill', targetType: sampleTable, targetId: row.sourceId,
      before: { invoiceId: beforeInvoiceId }, after: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, billingItemId: row.id }, ip });
  }
  await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:billing', operation: 'invoice_billing_item_link_backfill', targetType: 'BillingItem', targetId: row.id,
    before: { itemNo: row.itemNo, status: row.status, invoiceId: row.invoiceId ?? null }, after: { itemNo: row.itemNo, status: 'invoiced', invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber }, ip });
  return saved;
}

async function assertLegacyDevelopmentBillingInvoiceInTx(tx: any, row: any, invoice: any) {
  if (!invoice || invoice.status === 'Cancelled' || invoice.sourceType !== 'BillingItem' || invoice.sourceId !== row.id)
    abortManualInvoice('HANDOFF_CONFLICT', '开发收费原票来源或应收关联无法核对，不能从其他票据恢复。', 409);
  const lines = await tx.invoiceLine.findMany({ where: { invoiceId: invoice.id } });
  const usesCostLine = row.costRecordId && !row.developmentExpenseReviewId;
  if (lines.length && (lines.length !== 1 || lines[0].sourceType !== (usesCostLine ? 'CostRecord' : 'BillingItem')
    || lines[0].sourceId !== (usesCostLine ? row.costRecordId : row.id)))
    abortManualInvoice('HANDOFF_CONFLICT', '开发收费原票成员与准确原来源不一致，不能按单项原票恢复。', 409);
  assertDevelopmentBillingInvoiceFacts(invoice, [row], lines);
}

/** 四层表达视图：费用发生（成本记录）→ 收费决定（本事项）→ 应收草稿/签发（发票状态） */
async function buildBillingFlow(prisma: PrismaClient, row: any): Promise<{
  costRecords: any[];
  invoice: any | null;
  invoiceStatus: string | null; // null | Draft | Issued | PartiallyPaid | Paid | Cancelled
  stage: string; // cost_incurred | decision_draft | decision_confirmed | draft_receivable | issued
}> {
  const where: any = { sourceType: row.sourceType, sourceId: row.sourceId, deletedAt: null };
  if (row.costRecordId) {
    // 有主成本记录：优先展示主记录，其余来源成本记录并列展示
    where.OR = [{ id: row.costRecordId }, { sourceType: row.sourceType, sourceId: row.sourceId, deletedAt: null }];
    delete where.sourceType; delete where.sourceId;
  }
  const costRecords = await (prisma as any).costRecord.findMany({ where, orderBy: { createdAt: 'asc' } }).catch(() => []) || [];

  let invoice: any | null = null;
  let invoiceStatus: string | null = null;
  if (row.invoiceId) {
    invoice = await (prisma as any).invoice.findFirst({ where: { id: row.invoiceId } }).catch(() => null) ?? null;
    invoiceStatus = invoice?.status ?? null;
  }

  let stage: string;
  if (row.status === 'cancelled') stage = 'cancelled';
  else if (invoiceStatus === 'Issued' || invoiceStatus === 'PartiallyPaid' || invoiceStatus === 'Paid') stage = 'issued';
  else if (invoiceStatus === 'Draft') stage = 'draft_receivable';
  else if (row.status === 'confirmed') stage = netOf(row).lte(0) ? 'no_receivable' : 'decision_confirmed';
  else if (row.status === 'invoiced') stage = row.invoiceId ? 'draft_receivable' : 'no_receivable';
  else stage = 'decision_draft';

  return { costRecords, invoice, invoiceStatus, stage };
}
