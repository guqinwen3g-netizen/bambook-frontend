import { isValidLocalDateKey, todayLocalKey } from '../shared/localDate';
/**
 * 采购管理服务 Procurement Service
 *
 * 职责：
 *   1. 采购单 CRUD（含行明细，事务内创建/更新）
 *   2. 状态流转：Draft → Sent → Confirmed → PartiallyReceived/Received → Closed
 *   3. 来料检验记录（MaterialReceipt）
 *   4. 业务事件发布（PurchaseOrderSent / PurchaseOrderConfirmed / MaterialReceived）
 *   5. 行金额自动计算 + 采购总金额汇总
 *
 * 设计原则：
 *   - 软删除（deletedAt BigInt），不物理删除
 *   - 事务内创建采购单 + 行 + 审计日志
 *   - 状态转换有严格校验（非法转换抛 409）
 *   - 事件发布失败不阻断业务（fire-and-forget）
 */

import { Prisma, PrismaClient, PurchaseOrder, PurchaseLine, MaterialReceipt, SupplierInquiry } from '@prisma/client';
import { legacySupplierMutation } from './supplierContractPolicy';
import { logger } from '../lib/logger';
import { businessEventBus, persistBusinessEventInTransaction, publishBusinessEvent, type BusinessEvent } from '../events/businessEventBus';
import { deactivateEntityLinks, syncMaterialReceiptReferences, syncPurchaseOrderReferences } from '../entities/sync';
import { accumulateCompletedPurchaseOrderStats } from '../suppliers/factoryService';
import { writeFieldAuditDiff } from '../audit/routeAudit'; // ★ B220：采购单逐字段留痕复用共享真源
import { ReceiptDomainError, resolveReceiptWarehouse } from './receiptWarehouseAccess';
import { PurchaseOrderDomainError } from './purchaseOrderErrors';

// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export interface ProcurementWriteOptions { expectedOrderId?: string | null; }

export type PurchaseKind = 'Material' | 'FinishedGoods' | 'ProcessingService';
export interface PurchaseLineInput {
  kind?: PurchaseKind;
  orderLineId?: string;
  materialCode?: string;
  description: string;
  category?: string;
  specification?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  notes?: string;
}

import { nextBusinessNumber } from '../shared/businessNumberService';

import { buildOrderLinkedScope } from '../auth/orderVisibility';
export interface CreatePurchaseOrderInput {
  /** 采购单号（可选，服务端自动生成 PO-YYYY-NNNN；传入时优先使用传入值并校验唯一性） */
  poNumber?: string;
  currency: string;
  supplierRelationId?: string;
  supplierName?: string;
  supplierCode?: string;
  orderDate: string;
  expectedDeliveryDate?: string;
  deliveryTerms?: string;
  paymentTerms?: string;
  shipToAddress?: string;
  orderId?: string;
  quotationId?: string;
  bomId?: string;
  buyer?: string;
  exchangeRate?: number;
  baseCurrency?: string;
  notes?: string;
  lines: PurchaseLineInput[];
}

export interface UpdatePurchaseOrderInput extends Partial<CreatePurchaseOrderInput> {
  status?: string;
}

export type PurchaseOrderStatus = 'Draft' | 'Sent' | 'Confirmed' | 'PartiallyReceived' | 'Received' | 'Closed' | 'Cancelled';

/**
 * 可手动流转的目标状态（Agent Flow / route 共用此真源）。
 * PartiallyReceived/Received 由来料检验（createMaterialReceipt）驱动，Draft 为初始态，均不可手动设置。
 */
export const MANUAL_PURCHASE_ORDER_TRANSITION_TARGETS: readonly PurchaseOrderStatus[] = ['Sent', 'Confirmed', 'Cancelled', 'Closed'];

/** 采购单创建可写字段白名单（route / Agent Flow 共用真源；lines 元素字段见 PurchaseLineInput） */
export const PURCHASE_ORDER_CREATE_FIELDS: readonly string[] = [
  'poNumber', 'currency', 'supplierRelationId', 'supplierName', 'supplierCode', 'orderDate',
  'expectedDeliveryDate', 'deliveryTerms', 'paymentTerms', 'shipToAddress', 'orderId', 'quotationId',
  'bomId', 'buyer', 'exchangeRate', 'baseCurrency', 'notes', 'lines',
];

/**
 * ★ B220（v3.111）：采购单**逐字段**留痕的追踪面 —— 直接派生自上面的可写白名单（同一份真源），
 * 只去掉 `lines`（行明细不是一个标量字段，改了要看得懂得到"哪几行"，那是另一件事）。
 */
export const PURCHASE_ORDER_AUDIT_FIELDS: readonly string[] =
  PURCHASE_ORDER_CREATE_FIELDS.filter((f) => f !== 'lines');

/** 进 `Json` 列前把 Decimal 这类对象值折成字符串（`totalAmount`/`exchangeRate` 是 `@db.Decimal`）。 */
function poAuditSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of PURCHASE_ORDER_AUDIT_FIELDS) {
    const v = row[f];
    out[f] = v == null || ['string', 'number', 'boolean'].includes(typeof v) ? v : String(v);
  }
  return out;
}

export interface PurchaseOrderDetail extends PurchaseOrder {
  lines: PurchaseLine[];
  receipts?: MaterialReceipt[];
}

export interface MaterialReceiptInput {
  receiptNumber: string;
  receivedDate: string;
  receivedBy?: string;
  warehouseId?: string;
  warehouseName?: string;
  totalReceived: number;
  totalAccepted: number;
  totalRejected: number;
  rejectionReason?: string;
  qualityNotes?: string;
  notes?: string;
  /**
   * D6 行级收货明细（可选）：每行本次收了多少。
   * 传入时按明细精确回写各行 receivedQuantity（真源在行），并强校验
   * Σaccepted === totalAccepted / Σrejected === totalRejected；
   * 缺省仅允许一个物料行，多行必须明确本次逐行数量，禁止猜测分摊。
   */
  lineReceipts?: MaterialReceiptLineInput[];
}

/** D6 行级收货明细行 */
export interface MaterialReceiptLineInput {
  /** PurchaseLine.id（必须属于本采购单） */
  lineId: string;
  /** 本次该行合格数量（行级回写 + L8 入库口径） */
  accepted: number;
  /** 本次该行不合格数量（精确回写行拒收数量，审计保留本次明细） */
  rejected?: number;
}

/**
 * MaterialReceived 事件 payload.stockInLines 行级入库增量（L8 消费契约）。
 *
 * 口径裁决（真源 docs/design/04-模块设计/03-订单与生产/Procurement-采购管理/采购到货与质检.md）：
 *   - PO 是否收齐按每个采购行累计合格量独立判定，超收不能抵另一行缺口；
 *   - §七 7.2「自动入库联动设计」：quantity: totalAccepted, // 仅合格数量入库
 *     → L8 入库数量即本字段的行级分配值。
 *
 * L8 断层修复说明：payload 携带行级增量后，多张部分收料时 L8 只入库"本次"数量，
 * 不会把历史累计值重复入一遍库。
 */
export interface MaterialReceivedStockInLine {
  lineId: string;
  materialCode: string | null;
  description: string;
  category: string | null;
  specification: string | null;
  unit: string | null;
  unitPrice: number | null;
  /** 本次该行入库增量（合格数口径），非累计值 */
  quantity: number;
}

// ─── 卡点 3：供应商询价比价（剧本 2.10） ───

export interface SupplierQuoteRecord {
  id: string;
  supplierId?: string;
  supplierName: string;
  quoteAmount: number;
  currency: string;
  exchangeRate?: number;
  baseAmount?: number;
  quoteDate: string;
  deliveryTerms?: string;
  paymentTerms?: string;
  expectedDeliveryDate?: string;
  notes?: string;
  isSelected?: boolean;
}

export interface CreateSupplierInquiryInput {
  description: string;
  materialCode?: string;
  quantity?: number;
  unit?: string;
  currency: string;
  expectedDeliveryDate?: string;
  orderId?: string;
  bomId?: string;
  buyer?: string;
  notes?: string;
}

export interface UpdateSupplierInquiryInput extends Partial<CreateSupplierInquiryInput> {
  status?: string;
}

export interface AddSupplierQuoteInput {
  supplierId?: string;
  supplierName: string;
  quoteAmount: number;
  currency: string;
  exchangeRate?: number;
  quoteDate: string;
  deliveryTerms?: string;
  paymentTerms?: string;
  expectedDeliveryDate?: string;
  notes?: string;
}

export const SUPPLIER_INQUIRY_CREATE_FIELDS: readonly string[] = [
  'description', 'materialCode', 'quantity', 'unit', 'currency',
  'expectedDeliveryDate', 'orderId', 'bomId', 'buyer', 'notes',
];

// ────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────

// 状态转换矩阵：key → 允许的目标状态
const TRANSITIONS: Record<string, PurchaseOrderStatus[]> = {
  Draft: ['Sent', 'Cancelled'],
  Sent: ['Confirmed', 'Cancelled'],
  Confirmed: ['PartiallyReceived', 'Received', 'Cancelled'],
  PartiallyReceived: ['Received', 'Closed'],
  Received: ['Closed'],
  Closed: [], // 终态
  Cancelled: [], // 终态
};

// ────────────────────────────────────────────────────────────────
// 辅助函数
// ────────────────────────────────────────────────────────────────

function generatePurchaseOrderId(): string {
  return `PO_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateLineId(): string {
  return `PL_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}


function generateReceiptId(): string {
  return `MR_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateInquiryId(): string {
  return `SI_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateQuoteId(): string {
  return `SQ_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function calcLineAmount(quantity: number, unitPrice: number): number {
  return Math.round(quantity * unitPrice * 10000) / 10000;
}

function calcTotalAmount(lines: PurchaseLineInput[]): number {
  return lines.reduce((sum, l) => sum + calcLineAmount(l.quantity, l.unitPrice), 0);
}

function validateStatusTransition(from: string, to: PurchaseOrderStatus): void {
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`非法状态转换：${from} → ${to}（允许的目标：${allowed?.join(', ') || '无（终态）'}）`);
  }
}

// ─── 供应商询价状态转换（Open → Compared → Closed；C9：Compared → Open 撤回比价） ───
const INQUIRY_TRANSITIONS: Record<string, string[]> = {
  Open: ['Compared', 'Closed'],
  Compared: ['Closed', 'Open'], // Open = 撤回比价（C9：选错中选供应商可回退重新决策，报价行保留）
  Closed: [], // 终态
};

function validateInquiryStatusTransition(from: string, to: string): void {
  const allowed = INQUIRY_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`询价单非法状态转换：${from} → ${to}（允许的目标：${allowed?.join(', ') || '无（终态）'}）`);
  }
}

/** 计算报价的基准币种金额（用于横向比价） */
function calcBaseAmount(quoteAmount: number, exchangeRate?: number): number {
  const rate = exchangeRate && exchangeRate > 0 ? exchangeRate : 1;
  return Math.round(quoteAmount * rate * 10000) / 10000;
}

/**
 * B2：询价比价报价门禁 — 报价供应商必须来自供应商档案且未被拉黑
 * （与 createPurchaseOrder 的 PRD 13.1 黑名单门禁同源：身份真源 Relation → FactoryProfile 1:1。
 *   此前报价环节 supplierName 手打，黑名单供应商可绕过门禁报价甚至中选，本校验收口该旁路。）
 */
async function assertQuotableSupplier(prisma: PrismaClient, supplierId: string | undefined, supplierName?: string): Promise<void> {
  if (!supplierId) {
    throw new Error('报价供应商必须从供应商档案中选择（supplierId 必填，禁止手打供应商名称）');
  }
  const factory = await (prisma as any).factoryProfile?.findUnique?.({ where: { relationId: supplierId } });
  if (!factory || factory.deletedAt !== null) {
    throw new Error(`供应商 ${supplierName || supplierId} 不存在于供应商档案，禁止报价`);
  }
  if (factory.blacklistedAt !== null) {
    throw new Error('该供应商已被拉黑，禁止报价');
  }
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createProcurementService(prisma: PrismaClient) {
  // ── 创建采购单（含行明细，事务） ──
  async function createPurchaseOrder(input: CreatePurchaseOrderInput, actorId: string, transaction?: any): Promise<PurchaseOrderDetail> {
    validatePurchaseLines(input.lines);
    // PRD 13.1：被拉黑的工厂禁止新建采购单（身份真源 Relation → FactoryProfile 1:1）
    if (input.supplierRelationId) {
      const factory = await (prisma as any).factoryProfile?.findUnique?.({ where: { relationId: input.supplierRelationId } });
      if (factory && factory.deletedAt === null && factory.blacklistedAt !== null) {
        throw new PurchaseOrderDomainError(`该供应商已被拉黑（原因：${factory.blacklistReason || '未填写'}），禁止新建采购单`);
      }
    }
    const totalAmount = calcTotalAmount(input.lines);
    const now = Date.now();
    const purchaseOrderId = generatePurchaseOrderId();

    const runTransaction = transaction ? async (fn: (tx: any) => Promise<any>) => fn(transaction) : prisma.$transaction.bind(prisma);
    const created = await runTransaction(async (tx: any) => {
      await validatePurchaseLineSources(tx, input.lines, input.orderId);
      if (input.orderId) {
        const sourceOrder = await tx.order.findUnique({ where: { id: input.orderId }, select: { id: true, deletedAt: true } });
        if (!sourceOrder || sourceOrder.deletedAt != null) throw new PurchaseOrderDomainError('来源订单不存在', 'NOT_FOUND');
      }
      if (input.bomId) {
        const sourceBOM = await tx.bOM.findUnique({ where: { id: input.bomId }, select: { orderId: true, deletedAt: true } });
        if (!sourceBOM || sourceBOM.deletedAt) throw new PurchaseOrderDomainError('来源BOM不存在', 'NOT_FOUND');
        if ((sourceBOM.orderId ?? null) !== (input.orderId ?? null)) throw new PurchaseOrderDomainError('来源BOM与采购关联订单不一致', 'CONFLICT');
      }
      // PRD 5.6：服务端自动生成采购单号（PO-YYYY-NNNN），传入时优先使用传入值
      const poNumber = input.poNumber || await nextBusinessNumber(tx, 'PO', undefined, {
        occupied: async (num) => (await tx.purchaseOrder.findFirst({ where: { poNumber: num }, select: { id: true } })) != null,
      });
      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          id: purchaseOrderId,
          poNumber,
          status: 'Draft',
          currency: input.currency,
          totalAmount,
          exchangeRate: input.exchangeRate ?? null,
          baseCurrency: input.baseCurrency ?? 'CNY',
          supplierRelationId: input.supplierRelationId ?? null,
          supplierName: input.supplierName ?? null,
          supplierCode: input.supplierCode ?? null,
          orderDate: input.orderDate,
          expectedDeliveryDate: input.expectedDeliveryDate ?? null,
          deliveryTerms: input.deliveryTerms ?? null,
          paymentTerms: input.paymentTerms ?? null,
          shipToAddress: input.shipToAddress ?? null,
          orderId: input.orderId ?? null,
          quotationId: input.quotationId ?? null,
          bomId: input.bomId ?? null,
          buyer: input.buyer ?? null,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
          lines: {
            create: input.lines.map((line, i) => ({
              id: generateLineId(),
              lineNumber: i + 1,
              kind: line.kind ?? 'Material',
              orderLineId: line.orderLineId ?? null,
              materialCode: line.materialCode ?? null,
              description: line.description,
              category: line.category ?? null,
              specification: line.specification ?? null,
              quantity: line.quantity,
              unit: line.unit,
              unitPrice: line.unitPrice,
              amount: calcLineAmount(line.quantity, line.unitPrice),
              notes: line.notes ?? null,
              createdAt: now,
            })),
          },
        },
        include: {
          lines: { orderBy: { lineNumber: 'asc' } },
          receipts: { orderBy: { receivedDate: 'desc' } },
        },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'create_purchase_order',
          targetType: 'PurchaseOrder',
          targetId: purchaseOrderId,
          detail: { source: 'api:procurement', after: { poNumber: input.poNumber, totalAmount, lineCount: input.lines.length } } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      // EntityLink 图谱：purchasedFrom / forOrder / fromBom / fromQuotation
      await syncPurchaseOrderReferences(prisma, purchaseOrder, { source: 'api:procurement' }, tx);

      return purchaseOrder;
    });

    logger.info('[ProcurementService] purchase order created', { id: purchaseOrderId, poNumber: input.poNumber, totalAmount });
    return created as PurchaseOrderDetail;
  }

  // ── 更新采购单（仅 Draft 状态可编辑） ──
  async function updatePurchaseOrder(id: string, input: UpdatePurchaseOrderInput, actorId: string, options?: ProcurementWriteOptions): Promise<PurchaseOrderDetail> {
    const existing = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!existing || existing.deletedAt) throw new Error(`采购单 ${id} 不存在`);
    if (existing.status !== 'Draft') {
      throw new Error(`采购单 ${id} 状态为 ${existing.status}，仅 Draft 状态可编辑`);
    }

    const now = Date.now();
    let lines = input.lines;
    if (lines !== undefined) validatePurchaseLines(lines);
    const totalAmount = lines ? calcTotalAmount(lines) : Number(existing.totalAmount);

    const updated = await prisma.$transaction(async (tx) => {
      await assertCurrentPurchaseOrder(tx, id, existing.status, existing.updatedAt, options);
      if (await (tx as any).purchaseDemandAllocation?.count({ where: { purchaseOrderId: id, status: 'Active' } })) {
        const locked = ['currency', 'supplierRelationId', 'supplierName', 'supplierCode', 'orderId', 'bomId'] as const;
        if (locked.some(key => input[key] !== undefined && String(input[key] ?? '') !== String(existing[key] ?? ''))) throw new Error('需求分配采购的供应商、币种与来源不可通用编辑，请取消后重新分配');
        if (lines) {
          const same = lines.length === existing.lines.length && lines.every((line, i) => {
            const old = existing.lines.slice().sort((a,b)=>a.lineNumber-b.lineNumber)[i];
            return (line.kind ?? 'Material') === ((old as any).kind ?? 'Material') && String(line.orderLineId ?? '') === String((old as any).orderLineId ?? '') && ['materialCode','description','category','specification','unit','notes'].every(key => String((line as any)[key] ?? '') === String((old as any)[key] ?? '')) && Number(line.quantity) === Number(old.quantity) && Number(line.unitPrice) === Number(old.unitPrice);
          });
          if (!same) throw new Error('需求分配采购的物料、数量与单价不可通用编辑，请取消后重新分配');
          lines = undefined; // Unchanged frontend payload must preserve the allocated PurchaseLine IDs.
        }
      }
      await validatePurchaseLineSources(tx, lines ?? existing.lines as any, input.orderId ?? existing.orderId);
      if (lines && lines.length > 0) {
        await tx.purchaseLine.deleteMany({ where: { purchaseOrderId: id } });
        await tx.purchaseLine.createMany({
          data: lines.map((line, i) => ({
            id: generateLineId(),
            purchaseOrderId: id,
            lineNumber: i + 1,
            kind: line.kind ?? 'Material',
            orderLineId: line.orderLineId ?? null,
            materialCode: line.materialCode ?? null,
            description: line.description,
            category: line.category ?? null,
            specification: line.specification ?? null,
            quantity: line.quantity,
            unit: line.unit,
            unitPrice: line.unitPrice,
            amount: calcLineAmount(line.quantity, line.unitPrice),
            notes: line.notes ?? null,
            createdAt: now,
          })),
        });
      }

      const purchaseOrder = await tx.purchaseOrder.update({
        where: { id },
        data: {
          poNumber: input.poNumber ?? undefined,
          currency: input.currency ?? undefined,
          totalAmount,
          exchangeRate: input.exchangeRate ?? undefined,
          baseCurrency: input.baseCurrency ?? undefined,
          supplierRelationId: input.supplierRelationId ?? undefined,
          supplierName: input.supplierName ?? undefined,
          supplierCode: input.supplierCode ?? undefined,
          orderDate: input.orderDate ?? undefined,
          expectedDeliveryDate: input.expectedDeliveryDate ?? undefined,
          deliveryTerms: input.deliveryTerms ?? undefined,
          paymentTerms: input.paymentTerms ?? undefined,
          shipToAddress: input.shipToAddress ?? undefined,
          buyer: input.buyer ?? undefined,
          notes: input.notes ?? undefined,
          updatedAt: now,
        },
        include: {
          lines: { orderBy: { lineNumber: 'asc' } },
          receipts: { orderBy: { receivedDate: 'desc' } },
        },
      });

      const auditId = `alog_${now}_${Math.random().toString(36).slice(2, 8)}`;
      await tx.auditLog.create({
        data: {
          id: auditId,
          actorId: actorId || 'system',
          action: 'update_purchase_order',
          targetType: 'PurchaseOrder',
          targetId: id,
          detail: { source: 'api:procurement', before: { poNumber: existing.poNumber }, after: { poNumber: input.poNumber ?? existing.poNumber } } as any,
          ip: null,
          operationType: 'update',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      // ★ B220（v3.111）：上面那条汇总审计只带 `poNumber` —— 而 poNumber 几乎不会改 ⇒
      //   改交货条款 / 改备注 / 改预计交期之后的两条审计行**长得一模一样**（真库实测：
      //   两次 PUT 出来的行 fieldPath=null、before/after 各只有 1 个键）。变更史于是只能回答
      //   "谁在什么时候动过"，答不了"改了什么"。这里补字段级留痕，追踪面派生自既有可写白名单，
      //   与 Shipment 域 D5 那一次同形状（复用共享 `writeFieldAuditDiff`，不自造 diff）。
      await writeFieldAuditDiff({
        prisma: tx,
        actorId: actorId || 'system',
        source: 'api:procurement',
        operation: 'update_purchase_order_field',
        targetType: 'PurchaseOrder',
        targetId: id,
        before: poAuditSnapshot(existing as unknown as Record<string, unknown>),
        after: poAuditSnapshot(purchaseOrder as unknown as Record<string, unknown>),
        trackedFields: [...PURCHASE_ORDER_AUDIT_FIELDS],
        operationType: 'update',
        transactionId: auditId,
      });

      // EntityLink 图谱：FK 快照随 update 同步
      await syncPurchaseOrderReferences(prisma, purchaseOrder, { source: 'api:procurement' }, tx);

      return purchaseOrder;
    });

    logger.info('[ProcurementService] purchase order updated', { id });
    return updated as PurchaseOrderDetail;
  }

  // ── 软删除采购单（仅 Draft 状态可删除） ──
  async function deletePurchaseOrder(id: string, actorId: string, options?: ProcurementWriteOptions): Promise<void> {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`采购单 ${id} 不存在`);
    if (existing.status !== 'Draft') {
      throw new Error(`采购单 ${id} 状态为 ${existing.status}，仅 Draft 状态可删除`);
    }

    const now = Date.now();
    await prisma.$transaction(async (tx) => {
      await assertCurrentPurchaseOrder(tx, id, existing.status, existing.updatedAt, options);
      if (await (tx as any).purchaseServiceDelivery?.count({where:{purchaseOrderId:id}})) throw new Error('已发生加工服务交付，不能取消或删除，请走结算变更');
      await releaseDemandAllocations(tx, id, now);
      await tx.purchaseOrder.update({ where: { id }, data: { deletedAt: now, updatedAt: now } });
      // EntityLink 图谱：软删同步失效发出的关联
      await deactivateEntityLinks(tx, 'purchaseOrder', id, BigInt(now));
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'delete_purchase_order',
          targetType: 'PurchaseOrder',
          targetId: id,
          detail: { source: 'api:procurement', before: { poNumber: existing.poNumber, status: existing.status } } as any,
          ip: null,
          operationType: 'delete',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });
    });

    logger.info('[ProcurementService] purchase order deleted', { id });
  }

  // ── 查询采购单列表 ──
  async function listPurchaseOrders(params: {
    status?: string;
    supplierRelationId?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    limit?: number;
    offset?: number;
    /** Excel 台账导出=true：忽略分页上限全量导出（route 层 format=xlsx 专用） */
    exportAll?: boolean;
    /**
     * §10.4.2 可见订单白名单（route 层解析注入）：采购单随关联订单可见。
     * null/undefined = 不受限（真全权角色 / dev 旧口径）；空数组 = 一张都看不到。
     */
    visibleOrderIds?: string[] | null;
  }): Promise<{ items: PurchaseOrder[]; total: number }> {
    const where: any = { deletedAt: null, businessOwnerId: null, approvedCommitmentRevisionId: null };
    if (params.status) where.status = params.status;
    if (params.supplierRelationId) where.supplierRelationId = params.supplierRelationId;
    if (params.dateFrom || params.dateTo) {
      where.orderDate = {};
      if (params.dateFrom) where.orderDate.gte = params.dateFrom;
      if (params.dateTo) where.orderDate.lte = params.dateTo;
    }
    if (params.search) {
      where.OR = [
        { poNumber: { contains: params.search } },
        { supplierName: { contains: params.search } },
        { buyer: { contains: params.search } },
      ];
    }
    // §10.4.2：可见订单白名单用 AND 叠加（顶层 OR 已被 search 占用，裸 OR 会互相覆盖）
    if (params.visibleOrderIds) {
      const linked = buildOrderLinkedScope(params.visibleOrderIds, 'orderId');
      if (Object.keys(linked).length > 0) where.AND = [...(where.AND ?? []), linked];
      else if (params.visibleOrderIds.length === 0) where.AND = [...(where.AND ?? []), { orderId: { in: [] } }];
    }

    const limit = params.exportAll ? undefined : Math.min(params.limit ?? 50, 200);
    const offset = params.exportAll ? 0 : (params.offset ?? 0);
    const [items, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        ...(limit != null ? { take: limit, skip: offset } : {}),
      }),
      prisma.purchaseOrder.count({ where }),
    ]);

    return { items, total };
  }

  // ── 查询单个采购单（含行明细 + 收料记录） ──
  async function getPurchaseOrder(id: string): Promise<PurchaseOrderDetail | null> {
    const purchaseOrder = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { lineNumber: 'asc' } },
        receipts: { orderBy: { receivedDate: 'desc' } },
      },
    });
    if (!purchaseOrder || purchaseOrder.deletedAt || purchaseOrder.businessOwnerId || purchaseOrder.approvedCommitmentRevisionId) return null;
    return purchaseOrder as PurchaseOrderDetail;
  }

  // ── 状态转换：发送采购单 Draft → Sent ──
  async function sendPurchaseOrder(id: string, actorId: string, options?: ProcurementWriteOptions): Promise<PurchaseOrderDetail> {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!existing || existing.deletedAt) throw new Error(`采购单 ${id} 不存在`);
    validateStatusTransition(existing.status, 'Sent');

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      await assertCurrentPurchaseOrder(tx, id, existing.status, existing.updatedAt, options);
      const purchaseOrder = await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'Sent', updatedAt: now },
        include: {
          lines: { orderBy: { lineNumber: 'asc' } },
          receipts: { orderBy: { receivedDate: 'desc' } },
        },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'send_purchase_order',
          targetType: 'PurchaseOrder',
          targetId: id,
          detail: { source: 'api:procurement', before: { status: 'Draft' }, after: { status: 'Sent' } } as any,
          ip: null,
          operationType: 'transition',
          fieldPath: 'status',
          beforeValue: 'Draft',
          afterValue: 'Sent',
          transactionId: null,
        },
      });

      return purchaseOrder;
    });

    // 发布 PurchaseOrderSent 事件
    try {
      businessEventBus.publish({
        id: `bev_po_sent_${now}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'PurchaseOrderSent',
        sourceEntityType: 'PurchaseOrder',
        sourceEntityId: id,
        payload: {
          purchaseOrderId: id,
          poNumber: existing.poNumber,
          supplierName: existing.supplierName,
          supplierRelationId: existing.supplierRelationId,
          totalAmount: Number(existing.totalAmount),
          currency: existing.currency,
          lineCount: existing.lines.length,
        },
        occurredAt: now,
        actorId: actorId || 'system',
      });
    } catch (e: any) {
      logger.warn('[ProcurementService] PurchaseOrderSent event publish failed (non-blocking)', { error: e?.message });
    }

    logger.info('[ProcurementService] purchase order sent', { id, poNumber: existing.poNumber });
    return updated as PurchaseOrderDetail;
  }

  // ── 状态转换：确认采购单 Sent → Confirmed ──
  async function confirmPurchaseOrder(id: string, actorId: string, options?: ProcurementWriteOptions): Promise<PurchaseOrderDetail> {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!existing || existing.deletedAt) throw new Error(`采购单 ${id} 不存在`);
    validateStatusTransition(existing.status, 'Confirmed');

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      await assertCurrentPurchaseOrder(tx, id, existing.status, existing.updatedAt, options);
      const purchaseOrder = await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'Confirmed', updatedAt: now },
        include: {
          lines: { orderBy: { lineNumber: 'asc' } },
          receipts: { orderBy: { receivedDate: 'desc' } },
        },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'confirm_purchase_order',
          targetType: 'PurchaseOrder',
          targetId: id,
          detail: { source: 'api:procurement', before: { status: 'Sent' }, after: { status: 'Confirmed' } } as any,
          ip: null,
          operationType: 'transition',
          fieldPath: 'status',
          beforeValue: 'Sent',
          afterValue: 'Confirmed',
          transactionId: null,
        },
      });

      return purchaseOrder;
    });

    // 发布 PurchaseOrderConfirmed 事件
    try {
      businessEventBus.publish({
        id: `bev_po_conf_${now}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'PurchaseOrderConfirmed',
        sourceEntityType: 'PurchaseOrder',
        sourceEntityId: id,
        payload: {
          purchaseOrderId: id,
          poNumber: existing.poNumber,
          supplierName: existing.supplierName,
          supplierRelationId: existing.supplierRelationId,
          totalAmount: Number(existing.totalAmount),
          currency: existing.currency,
          lines: existing.lines.map(l => ({
            materialCode: l.materialCode,
            description: l.description,
            quantity: Number(l.quantity),
            unit: l.unit,
            unitPrice: Number(l.unitPrice),
          })),
        },
        occurredAt: now,
        actorId: actorId || 'system',
      });
    } catch (e: any) {
      logger.warn('[ProcurementService] PurchaseOrderConfirmed event publish failed (non-blocking)', { error: e?.message });
    }

    logger.info('[ProcurementService] purchase order confirmed', { id, poNumber: existing.poNumber });
    return updated as PurchaseOrderDetail;
  }

  // ── 取消采购单 ──
  async function cancelPurchaseOrder(id: string, actorId: string, reason?: string, options?: ProcurementWriteOptions): Promise<PurchaseOrderDetail> {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`采购单 ${id} 不存在`);
    validateStatusTransition(existing.status, 'Cancelled');

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      await assertCurrentPurchaseOrder(tx, id, existing.status, existing.updatedAt, options);
      if (await (tx as any).purchaseServiceDelivery?.count({where:{purchaseOrderId:id}})) throw new Error('已发生加工服务交付，不能取消或删除，请走结算变更');
      await releaseDemandAllocations(tx, id, now);
      const purchaseOrder = await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'Cancelled', notes: reason ? `${existing.notes || ''}\n[取消原因] ${reason}`.trim() : existing.notes, updatedAt: now },
        include: {
          lines: { orderBy: { lineNumber: 'asc' } },
          receipts: { orderBy: { receivedDate: 'desc' } },
        },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'cancel_purchase_order',
          targetType: 'PurchaseOrder',
          targetId: id,
          detail: { source: 'api:procurement', before: { status: existing.status }, after: { status: 'Cancelled', reason } } as any,
          ip: null,
          operationType: 'transition',
          fieldPath: 'status',
          beforeValue: existing.status,
          afterValue: 'Cancelled',
          transactionId: null,
        },
      });

      return purchaseOrder;
    });

    logger.info('[ProcurementService] purchase order cancelled', { id, poNumber: existing.poNumber });
    return updated as PurchaseOrderDetail;
  }

  // ── 关闭采购单 ──
  async function closePurchaseOrder(id: string, actorId: string, options?: ProcurementWriteOptions): Promise<PurchaseOrderDetail> {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`采购单 ${id} 不存在`);
    validateStatusTransition(existing.status, 'Closed');

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      await assertCurrentPurchaseOrder(tx, id, existing.status, existing.updatedAt, options);
      const purchaseOrder = await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'Closed', actualDeliveryDate: existing.actualDeliveryDate ?? todayLocalKey(), updatedAt: now },
        include: {
          lines: { orderBy: { lineNumber: 'asc' } },
          receipts: { orderBy: { receivedDate: 'desc' } },
        },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'close_purchase_order',
          targetType: 'PurchaseOrder',
          targetId: id,
          detail: { source: 'api:procurement', before: { status: existing.status }, after: { status: 'Closed' } } as any,
          ip: null,
          operationType: 'transition',
          fieldPath: 'status',
          beforeValue: existing.status,
          afterValue: 'Closed',
          transactionId: null,
        },
      });

      return purchaseOrder;
    });

    logger.info('[ProcurementService] purchase order closed', { id });
    return updated as PurchaseOrderDetail;
  }

  // ── 状态转换统一入口：按既有状态机流转到目标状态（Agent Flow 与 route 共用） ──
  // 仅委托既有 send/confirm/cancel/close 原子方法，状态机真源仍是 TRANSITIONS + validateStatusTransition；
  // PartiallyReceived/Received 由来料检验驱动，Draft 为初始态，手动设置一律拒绝。
  async function transitionPurchaseOrderStatus(id: string, toStatus: PurchaseOrderStatus, actorId: string, reason?: string): Promise<PurchaseOrderDetail> {
    switch (toStatus) {
      case 'Sent': return sendPurchaseOrder(id, actorId);
      case 'Confirmed': return confirmPurchaseOrder(id, actorId);
      case 'Cancelled': return cancelPurchaseOrder(id, actorId, reason);
      case 'Closed': return closePurchaseOrder(id, actorId);
      default:
        throw new Error(`采购单状态 ${toStatus} 不可手动流转（PartiallyReceived/Received 由来料检验驱动，Draft 为初始态）`);
    }
  }

  // ── 来料检验记录 ──
  async function createMaterialReceipt(
    purchaseOrderId: string,
    input: MaterialReceiptInput,
    actorId: string,
    options?: ProcurementWriteOptions,
  ): Promise<MaterialReceipt> {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, include: { lines: true } });
    if (!existing || existing.deletedAt) throw new ReceiptDomainError(`采购单 ${purchaseOrderId} 不存在`, 'NOT_FOUND');
    input = normalizeReceiptInput(input);
    const now = Date.now();
    const receiptId = generateReceiptId();
    const lineById = new Map(existing.lines.map(l => [l.id, l] as const));
    const materialLines = existing.lines.filter(l => l.kind !== 'ProcessingService');
    if (!materialLines.length) throw new ReceiptDomainError('加工服务请登记服务交付，不能物料收料');
    const suppliedLines = input.lineReceipts?.length ? input.lineReceipts : materialLines.length === 1
      ? [{ lineId: materialLines[0].id, accepted: input.totalAccepted, rejected: input.totalRejected }]
      : null;
    if (!suppliedLines) throw new ReceiptDomainError('多行采购单必须逐行填写收料数量，不能按单头数量推断物料');
    const seen = new Set<string>();
    const lineReceipts = suppliedLines.map(lr => {
      const line = lineById.get(lr.lineId);
      if (!line) throw new ReceiptDomainError(`行级收货明细引用了不属于采购单 ${purchaseOrderId} 的行：${lr.lineId}`);
      if (line.kind === 'ProcessingService') throw new ReceiptDomainError('加工服务不能登记物料收料');
      if (seen.has(lr.lineId)) throw new ReceiptDomainError(`行级收货明细行 ${lr.lineId} 重复`);
      seen.add(lr.lineId);
      return { lineId: line.id, materialCode: line.materialCode ?? null, description: line.description, unit: line.unit,
        accepted: receiptQuantity(lr.accepted, '行级合格数量'), rejected: receiptQuantity(lr.rejected ?? 0, '行级不合格数量') };
    }).sort((a,b)=>a.lineId.localeCompare(b.lineId));
    const sum = (key: 'accepted' | 'rejected') => lineReceipts.reduce((a,l)=>a.plus(l[key]), new Prisma.Decimal(0));
    if (!sum('accepted').eq(input.totalAccepted)) throw new ReceiptDomainError('行级合格合计与收货单总合格数不一致');
    if (!sum('rejected').eq(input.totalRejected)) throw new ReceiptDomainError('行级不合格合计与收货单总不合格数不一致');
    const stockInLineAllocations = lineReceipts.filter(l=>l.accepted>0).map(l=>({line:lineById.get(l.lineId)!,quantity:l.accepted}));
    const newStatus: PurchaseOrderStatus = existing.lines.length > 0 && existing.lines.every(line =>
      new Prisma.Decimal(line.receivedQuantity).plus(lineReceipts.find(l=>l.lineId===line.id)?.accepted ?? 0).gte(line.quantity)) ? 'Received' : 'PartiallyReceived';
    const isFirstFullReceipt = newStatus === 'Received' && existing.status !== 'Received';
    const receiptSnapshot = { receiptNumber: input.receiptNumber, receivedDate: input.receivedDate,
      receivedBy: input.receivedBy ?? null, warehouseId: input.warehouseId ?? null, warehouseName: input.warehouseName ?? null,
      totalReceived: input.totalReceived, totalAccepted: input.totalAccepted, totalRejected: input.totalRejected,
      rejectionReason: input.rejectionReason ?? null, qualityNotes: input.qualityNotes ?? null, notes: input.notes ?? null,
      lineReceipts };
    const event: BusinessEvent = {
      id: `bev_material_received_${receiptId}`, type: 'MaterialReceived', sourceEntityType: 'PurchaseOrder', sourceEntityId: purchaseOrderId,
      occurredAt: now, actorId: actorId || 'system',
      payload: { purchaseOrderId, poNumber: existing.poNumber, receiptId, receiptNumber: input.receiptNumber,
        supplierName: existing.supplierName, supplierRelationId: existing.supplierRelationId,
        totalReceived: input.totalReceived, totalAccepted: input.totalAccepted, totalRejected: input.totalRejected,
        warehouseId: input.warehouseId ?? null, warehouseName: input.warehouseName, currency: existing.currency, purchaseOrderStatus: newStatus,
        stockInLines: stockInLineAllocations.map(({line,quantity}): MaterialReceivedStockInLine => ({ lineId: line.id,
          materialCode: line.materialCode ?? null, description: line.description || line.materialCode || '未知物料',
          category: line.category ?? null, specification: line.specification ?? null, unit: line.unit ?? null,
          unitPrice: line.unitPrice == null ? null : Number(line.unitPrice), quantity })) }
    };
    let replayedDuplicate = false;

    const result = await prisma.$transaction(async (tx) => {
      // Lock before idempotency lookup, but do not reject a retry merely because the first request advanced status.
      if ((tx as any).$queryRaw) {
        const rows = await tx.$queryRaw<Array<{ orderId: string | null; deletedAt: bigint | null }>>(Prisma.sql`SELECT "orderId", "deletedAt" FROM "PurchaseOrder" WHERE "id" = ${purchaseOrderId} FOR UPDATE`);
        const current = rows[0];
        if (!current || current.deletedAt) throw new ReceiptDomainError('采购单不存在或已删除','NOT_FOUND');
        if (options?.expectedOrderId !== undefined && (current.orderId ?? null) !== options.expectedOrderId) throw new ReceiptDomainError('采购单关联订单已变化，请刷新后重新授权','CONFLICT');
      }
      const duplicateReceipt = await tx.materialReceipt.findFirst({
        where: { purchaseOrderId, receiptNumber: input.receiptNumber },
      });
      if (duplicateReceipt) {
        const priorAudit = await tx.auditLog.findFirst({ where: { action: 'create_material_receipt', targetType: 'PurchaseOrder', targetId: purchaseOrderId,
          detail: { path: ['after','receiptId'], equals: duplicateReceipt.id } }, orderBy: { createdAt: 'desc' } });
        const priorSnapshot = (priorAudit?.detail as any)?.after?.receiptSnapshot;
        let same = false;
        if (priorSnapshot) same = stableReceiptJSON(priorSnapshot) === stableReceiptJSON(receiptSnapshot);
        else if (existing.lines.length === 1) {
          same = ['receiptNumber','receivedDate','receivedBy','warehouseId','warehouseName','rejectionReason','qualityNotes','notes'].every(key => ((duplicateReceipt as any)[key] ?? null) === ((receiptSnapshot as any)[key] ?? null))
            && ['totalReceived','totalAccepted','totalRejected'].every(key => Number((duplicateReceipt as any)[key]) === (receiptSnapshot as any)[key]);
        }
        if (!same) throw new ReceiptDomainError('收料单号已使用，但内容不同或旧行级依据不完整，请核对原单','CONFLICT');
        replayedDuplicate = true;
        return { receipt: duplicateReceipt, purchaseOrder: existing };
      }
      await assertCurrentPurchaseOrder(tx, purchaseOrderId, existing.status, existing.updatedAt, options, true);
      if (!['Confirmed','PartiallyReceived','Received'].includes(existing.status)) throw new ReceiptDomainError(`采购单 ${purchaseOrderId} 状态为 ${existing.status}，仅 Confirmed/PartiallyReceived/Received 状态可收料`, 'CONFLICT');

      // Preserve the original command snapshot above for exact replay. The
      // actual destination is a separate server fact, never a caller's label.
      // All-rejected receipts produce no inbound stock and need no warehouse.
      const warehouse = input.totalAccepted > 0 ? await resolveReceiptWarehouse(tx, input.warehouseId) : null;
      const warehouseId = warehouse?.id ?? input.warehouseId ?? null;
      const warehouseName = warehouse?.name ?? input.warehouseName ?? null;
      event.payload.warehouseId = warehouseId;
      event.payload.warehouseName = warehouseName;

      // 创建收料记录
      const receipt = await tx.materialReceipt.create({
        data: {
          id: receiptId,
          receiptNumber: input.receiptNumber,
          purchaseOrderId,
          status: input.totalRejected === 0 ? 'Accepted' : input.totalAccepted === 0 ? 'Rejected' : 'PartiallyAccepted',
          receivedDate: input.receivedDate,
          receivedBy: input.receivedBy ?? null,
          inspectedBy: actorId || 'system',
          inspectionDate: input.receivedDate,
          warehouseId,
          warehouseName,
          totalReceived: input.totalReceived,
          totalAccepted: input.totalAccepted,
          totalRejected: input.totalRejected,
          rejectionReason: input.rejectionReason ?? null,
          qualityNotes: input.qualityNotes ?? null,
          notes: input.notes ?? null,
          createdAt: now,
        },
      });

      // W-C A1：MaterialReceipt 图谱入链（S2 三击追溯）——同事务双写 entityReference/entityLink，
      // 幂等重放路径已在上方提前返回，不会重复挂载。
      await syncMaterialReceiptReferences(prisma, receipt, { source: 'api:procurement' }, tx);

      // 行级回写（L8 断层修复）：PurchaseLine.receivedQuantity += 本次合格数量的行级分配
      // 口径 = 合格数（totalAccepted），与逐行收齐判定及「仅合格数量入库」一致；
      // 超采允许累计超过 orderedQuantity。回写必须在事务内、事件发布前完成，
      // 保证 MaterialReceived 事件触发 L8 时行级数据已就绪。
      const lineWritebackAudit: Array<{ lineId: string; quantity: number; rejected: number }> = [];
      for (const line of lineReceipts) {
        await tx.purchaseLine.update({ where: { id: line.lineId }, data: {
          receivedQuantity: { increment: line.accepted }, rejectedQuantity: { increment: line.rejected }
        } });
        lineWritebackAudit.push({ lineId: line.lineId, quantity: line.accepted, rejected: line.rejected });
      }

      // 更新采购单状态
      const purchaseOrder = await tx.purchaseOrder.update({
        where: { id: purchaseOrderId },
        data: { status: newStatus, updatedAt: now },
      });

      // C6：首次全部收齐（→Received）→ 供应商累计单数/金额同事务累加。
      // 幂等口径：仅「首次进入 Received」累加；超收补收（Received → Received）不重复计数。
      // 无工厂档案的供应商静默跳过。
      if (isFirstFullReceipt && existing.supplierRelationId) {
        await accumulateCompletedPurchaseOrderStats(tx, {
          relationId: existing.supplierRelationId,
          amount: Number(existing.totalAmount ?? 0),
          updatedAt: BigInt(now),
        });
      }

      // 审计日志
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'create_material_receipt',
          targetType: 'PurchaseOrder',
          targetId: purchaseOrderId,
          detail: { source: 'api:procurement', after: { receiptId, receiptNumber: input.receiptNumber, totalAccepted: input.totalAccepted, totalRejected: input.totalRejected, newStatus, lineWriteback: lineWritebackAudit, lineReceipts, receiptSnapshot, warehouseResolution: warehouse } } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      await persistBusinessEventInTransaction(tx, event);
      return { receipt, purchaseOrder };
    });

    // 幂等重放：重复确认直接返回原收料单，不发布事件、不触发 L8、不计交期评分
    if (replayedDuplicate) {
      return result.receipt;
    }

    // Durable event already committed with the receipt. Wake the same ID; failure remains recoverable.
    publishBusinessEvent({ ...event, eventId: event.id }).catch(e => {
      logger.warn('[ProcurementService] MaterialReceived wake-up failed; event remains queued', { error: e?.message });
    });

    logger.info('[ProcurementService] material receipt created', {
      purchaseOrderId, receiptId, totalAccepted: input.totalAccepted, newStatus,
    });

    // H1c：全部收齐 → 自动追加交期评分（幂等：同采购单只评一次；无档案供应商静默跳过）
    if (newStatus === 'Received' && existing.supplierRelationId) {
      try {
        const { createFactoryService, deliveryScoreForDaysLate } = await import('../suppliers/factoryService');
        const factoryService = createFactoryService(prisma);
        const DAY_MS = 86_400_000;
        const parse = (s?: string | null) => {
          if (!s) return null;
          const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
          return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
        };
        const expectedMs = parse(existing.expectedDeliveryDate);
        const actualMs = parse(input.receivedDate);
        const daysLate = expectedMs !== null && actualMs !== null ? Math.round((actualMs - expectedMs) / DAY_MS) : null;
        await factoryService.recordAutoEvaluation({
          relationId: existing.supplierRelationId,
          kind: 'delivery',
          score: deliveryScoreForDaysLate(daysLate),
          sourceType: 'purchaseOrder',
          sourceId: purchaseOrderId,
          evaluatedAt: input.receivedDate,
          note: `采购单 ${existing.poNumber} 全部收齐${daysLate !== null ? `，交期偏差 ${daysLate} 天` : '（未约定交期）'}`,
          actorId: actorId || 'system',
        });
      } catch (e: any) {
        logger.warn('[ProcurementService] delivery auto-evaluation failed (non-blocking)', { error: e?.message });
      }
    }

    return result.receipt;
  }

  // ─── 卡点 3：供应商询价比价（剧本 2.10 验收点） ───

  // ── 创建询价单（Open 状态） ──
  async function createSupplierInquiry(input: CreateSupplierInquiryInput, actorId: string): Promise<SupplierInquiry> {
    const now = Date.now();
    const inquiryId = generateInquiryId();

    const created = await prisma.$transaction(async (tx) => {
      const inquiryNumber = await nextBusinessNumber(tx, 'SI', undefined, {
        occupied: async (num) => (await tx.supplierInquiry.findFirst({ where: { inquiryNumber: num }, select: { id: true } })) != null,
      });
      const inquiry = await tx.supplierInquiry.create({
        data: {
          id: inquiryId,
          inquiryNumber,
          status: 'Open',
          description: input.description,
          materialCode: input.materialCode ?? null,
          quantity: input.quantity ?? null,
          unit: input.unit ?? null,
          currency: input.currency,
          expectedDeliveryDate: input.expectedDeliveryDate ?? null,
          orderId: input.orderId ?? null,
          bomId: input.bomId ?? null,
          buyer: input.buyer ?? null,
          supplierQuotes: [],
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
        },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'create_supplier_inquiry',
          targetType: 'SupplierInquiry',
          targetId: inquiryId,
          detail: { source: 'api:procurement', after: { inquiryNumber, description: input.description } } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      return inquiry;
    });

    logger.info('[ProcurementService] supplier inquiry created', { id: inquiryId });
    return created;
  }

  // ── 更新询价单（仅 Open 状态可编辑；C9：Compared → Open 撤回比价专用分支） ──
  async function updateSupplierInquiry(id: string, input: UpdateSupplierInquiryInput, actorId: string, options?: ProcurementWriteOptions): Promise<SupplierInquiry> {
    const existing = await prisma.supplierInquiry.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`询价单 ${id} 不存在`);

    // C9 撤回比价（Compared → Open）：body 携带与现态不同的 status 时按状态机处理。
    // 撤回后回到可编辑/可增删报价/可重新决策态；清除中选快照与决策备注（决策留痕转审计），
    // 报价行全部保留但 isSelected 清零（可重新勾选决策）。
    if (input.status !== undefined && input.status !== existing.status) {
      validateInquiryStatusTransition(existing.status, input.status);
      if (!(existing.status === 'Compared' && input.status === 'Open')) {
        throw new Error(`询价单状态流转 ${existing.status} → ${input.status} 请使用专属操作（比价决策/关闭询价），更新接口仅支持 Compared → Open 撤回比价`);
      }
      const now = Date.now();
      const quotes: SupplierQuoteRecord[] = Array.isArray(existing.supplierQuotes) ? (existing.supplierQuotes as unknown as SupplierQuoteRecord[]) : [];
      const cleared = quotes.map(q => ({ ...q, isSelected: false }));
      const updated = await prisma.$transaction(async (tx) => {
      await assertCurrentInquiry(tx, existing, options);
        const inquiry = await tx.supplierInquiry.update({
          where: { id },
          data: {
            status: 'Open',
            supplierQuotes: cleared as any,
            selectedSupplierId: null,
            selectedSupplierName: null,
            decisionNote: null,
            updatedAt: now,
          },
        });
        await tx.auditLog.create({
          data: {
            id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
            actorId: actorId || 'system',
            action: 'reopen_supplier_inquiry',
            targetType: 'SupplierInquiry',
            targetId: id,
            detail: { source: 'api:procurement', before: { status: existing.status, selectedSupplierName: existing.selectedSupplierName ?? null, decisionNote: existing.decisionNote ?? null }, after: { status: 'Open' } } as any,
            ip: null,
            operationType: 'transition',
            fieldPath: 'status',
            beforeValue: existing.status,
            afterValue: 'Open',
            transactionId: null,
          },
        });
        return inquiry;
      });

      logger.info('[ProcurementService] supplier comparison reverted (Compared → Open)', { id });
      return updated;
    }

    if (existing.status !== 'Open') {
      throw new Error(`询价单 ${id} 状态为 ${existing.status}，仅 Open 状态可编辑`);
    }

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      await assertCurrentInquiry(tx, existing, options);
      const inquiry = await tx.supplierInquiry.update({
        where: { id },
        data: {
          description: input.description ?? undefined,
          materialCode: input.materialCode ?? undefined,
          quantity: input.quantity ?? undefined,
          unit: input.unit ?? undefined,
          currency: input.currency ?? undefined,
          expectedDeliveryDate: input.expectedDeliveryDate ?? undefined,
          orderId: input.orderId ?? undefined,
          bomId: input.bomId ?? undefined,
          buyer: input.buyer ?? undefined,
          notes: input.notes ?? undefined,
          updatedAt: now,
        },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'update_supplier_inquiry',
          targetType: 'SupplierInquiry',
          targetId: id,
          detail: { source: 'api:procurement' } as any,
          ip: null,
          operationType: 'update',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      return inquiry;
    });

    logger.info('[ProcurementService] supplier inquiry updated', { id });
    return updated;
  }

  // ── 软删除询价单（仅 Open 状态） ──
  async function deleteSupplierInquiry(id: string, actorId: string, options?: ProcurementWriteOptions): Promise<void> {
    const existing = await prisma.supplierInquiry.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`询价单 ${id} 不存在`);
    if (existing.status !== 'Open') {
      throw new Error(`询价单 ${id} 状态为 ${existing.status}，仅 Open 状态可删除`);
    }

    const now = Date.now();
    await prisma.$transaction(async (tx) => {
      await assertCurrentInquiry(tx, existing, options);
      await tx.supplierInquiry.update({ where: { id }, data: { deletedAt: now, updatedAt: now } });
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'delete_supplier_inquiry',
          targetType: 'SupplierInquiry',
          targetId: id,
          detail: { source: 'api:procurement', before: { inquiryNumber: existing.inquiryNumber, status: existing.status } } as any,
          ip: null,
          operationType: 'delete',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });
    });

    logger.info('[ProcurementService] supplier inquiry deleted', { id });
  }

  // ── 查询询价单列表 ──
  async function listSupplierInquiries(params: {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    limit?: number;
    offset?: number;
    visibleOrderIds?: string[] | null;
  }): Promise<{ items: SupplierInquiry[]; total: number }> {
    const where: any = { deletedAt: null };
    if (params.status) where.status = params.status;
    if (params.search) {
      where.OR = [
        { inquiryNumber: { contains: params.search } },
        { description: { contains: params.search } },
        { materialCode: { contains: params.search } },
        { buyer: { contains: params.search } },
      ];
    }
    if (params.visibleOrderIds != null) where.AND = [buildOrderLinkedScope(params.visibleOrderIds, 'orderId')];
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    const [items, total] = await Promise.all([
      prisma.supplierInquiry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.supplierInquiry.count({ where }),
    ]);
    return { items, total };
  }

  // ── 查询单个询价单 ──
  async function getSupplierInquiry(id: string): Promise<SupplierInquiry | null> {
    const inquiry = await prisma.supplierInquiry.findUnique({ where: { id } });
    if (!inquiry || inquiry.deletedAt) return null;
    return inquiry;
  }

  // ── 添加供应商报价（验收点②：多供应商报价记录） ──
  async function addSupplierQuote(inquiryId: string, input: AddSupplierQuoteInput, actorId: string, options?: ProcurementWriteOptions): Promise<SupplierInquiry> {
    const existing = await prisma.supplierInquiry.findUnique({ where: { id: inquiryId } });
    if (!existing || existing.deletedAt) throw new Error(`询价单 ${inquiryId} 不存在`);
    if (existing.status !== 'Open') {
      throw new Error(`询价单 ${inquiryId} 状态为 ${existing.status}，仅 Open 状态可添加报价`);
    }

    // B2：报价供应商档案校验（存在且未拉黑；黑名单供应商 403 由路由层映射）
    await assertQuotableSupplier(prisma, input.supplierId, input.supplierName);

    const quotes: SupplierQuoteRecord[] = Array.isArray(existing.supplierQuotes) ? (existing.supplierQuotes as unknown as SupplierQuoteRecord[]) : [];
    const newQuote: SupplierQuoteRecord = {
      id: generateQuoteId(),
      supplierId: input.supplierId ?? undefined,
      supplierName: input.supplierName,
      quoteAmount: input.quoteAmount,
      currency: input.currency,
      exchangeRate: input.exchangeRate,
      baseAmount: calcBaseAmount(input.quoteAmount, input.exchangeRate),
      quoteDate: input.quoteDate,
      deliveryTerms: input.deliveryTerms ?? undefined,
      paymentTerms: input.paymentTerms ?? undefined,
      expectedDeliveryDate: input.expectedDeliveryDate ?? undefined,
      notes: input.notes ?? undefined,
      isSelected: false,
    };
    quotes.push(newQuote);

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      await assertCurrentInquiry(tx, existing, options);
      const inquiry = await tx.supplierInquiry.update({
        where: { id: inquiryId },
        data: { supplierQuotes: quotes as any, updatedAt: now },
      });
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'add_supplier_quote',
          targetType: 'SupplierInquiry',
          targetId: inquiryId,
          detail: { source: 'api:procurement', after: { supplierName: input.supplierName, quoteAmount: input.quoteAmount, currency: input.currency } } as any,
          ip: null,
          operationType: 'update',
          fieldPath: 'supplierQuotes',
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });
      return inquiry;
    });

    logger.info('[ProcurementService] supplier quote added', { inquiryId, supplierName: input.supplierName });
    return updated;
  }

  // ── 更新供应商报价 ──
  async function updateSupplierQuote(inquiryId: string, quoteId: string, input: Partial<AddSupplierQuoteInput>, actorId: string, options?: ProcurementWriteOptions): Promise<SupplierInquiry> {
    const existing = await prisma.supplierInquiry.findUnique({ where: { id: inquiryId } });
    if (!existing || existing.deletedAt) throw new Error(`询价单 ${inquiryId} 不存在`);
    if (existing.status !== 'Open') {
      throw new Error(`询价单 ${inquiryId} 状态为 ${existing.status}，仅 Open 状态可编辑报价`);
    }

    const quotes: SupplierQuoteRecord[] = Array.isArray(existing.supplierQuotes) ? (existing.supplierQuotes as unknown as SupplierQuoteRecord[]) : [];
    const idx = quotes.findIndex(q => q.id === quoteId);
    if (idx < 0) throw new Error(`报价 ${quoteId} 不存在于询价单 ${inquiryId}`);
    const prev = quotes[idx];
    // B2：编辑报价若改动供应商身份（supplierId/supplierName），同样过档案校验，
    // 防止"先加正常供应商报价、再改成黑名单供应商"的旁路；仅改金额等非身份字段不拦截（兼容存量手打报价）
    if (input.supplierId !== undefined || input.supplierName !== undefined) {
      await assertQuotableSupplier(prisma, input.supplierId ?? prev.supplierId, input.supplierName ?? prev.supplierName);
    }
    const next: SupplierQuoteRecord = {
      ...prev,
      supplierId: input.supplierId ?? prev.supplierId,
      supplierName: input.supplierName ?? prev.supplierName,
      quoteAmount: input.quoteAmount ?? prev.quoteAmount,
      currency: input.currency ?? prev.currency,
      exchangeRate: input.exchangeRate ?? prev.exchangeRate,
      quoteDate: input.quoteDate ?? prev.quoteDate,
      deliveryTerms: input.deliveryTerms ?? prev.deliveryTerms,
      paymentTerms: input.paymentTerms ?? prev.paymentTerms,
      expectedDeliveryDate: input.expectedDeliveryDate ?? prev.expectedDeliveryDate,
      notes: input.notes ?? prev.notes,
    };
    // 金额/汇率变化时重算 baseAmount（用于横向比价）
    if (input.quoteAmount != null || input.exchangeRate != null) {
      next.baseAmount = calcBaseAmount(next.quoteAmount, next.exchangeRate);
    }
    quotes[idx] = next;

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      await assertCurrentInquiry(tx, existing, options);
      const inquiry = await tx.supplierInquiry.update({
        where: { id: inquiryId },
        data: { supplierQuotes: quotes as any, updatedAt: now },
      });
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'update_supplier_quote',
          targetType: 'SupplierInquiry',
          targetId: inquiryId,
          detail: { source: 'api:procurement', quoteId } as any,
          ip: null,
          operationType: 'update',
          fieldPath: 'supplierQuotes',
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });
      return inquiry;
    });

    logger.info('[ProcurementService] supplier quote updated', { inquiryId, quoteId });
    return updated;
  }

  // ── 删除供应商报价 ──
  async function removeSupplierQuote(inquiryId: string, quoteId: string, actorId: string, options?: ProcurementWriteOptions): Promise<SupplierInquiry> {
    const existing = await prisma.supplierInquiry.findUnique({ where: { id: inquiryId } });
    if (!existing || existing.deletedAt) throw new Error(`询价单 ${inquiryId} 不存在`);
    if (existing.status !== 'Open') {
      throw new Error(`询价单 ${inquiryId} 状态为 ${existing.status}，仅 Open 状态可删除报价`);
    }

    const quotes: SupplierQuoteRecord[] = Array.isArray(existing.supplierQuotes) ? (existing.supplierQuotes as unknown as SupplierQuoteRecord[]) : [];
    const filtered = quotes.filter(q => q.id !== quoteId);
    if (filtered.length === quotes.length) throw new Error(`报价 ${quoteId} 不存在于询价单 ${inquiryId}`);

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      await assertCurrentInquiry(tx, existing, options);
      const inquiry = await tx.supplierInquiry.update({
        where: { id: inquiryId },
        data: { supplierQuotes: filtered as any, updatedAt: now },
      });
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'remove_supplier_quote',
          targetType: 'SupplierInquiry',
          targetId: inquiryId,
          detail: { source: 'api:procurement', quoteId } as any,
          ip: null,
          operationType: 'update',
          fieldPath: 'supplierQuotes',
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });
      return inquiry;
    });

    logger.info('[ProcurementService] supplier quote removed', { inquiryId, quoteId });
    return updated;
  }

  // ── 比价决策：选定中选供应商（Open → Compared）（验收点③：比价决策可记录） ──
  async function selectSupplier(inquiryId: string, quoteId: string, decisionNote: string, actorId: string, options?: ProcurementWriteOptions): Promise<SupplierInquiry> {
    const existing = await prisma.supplierInquiry.findUnique({ where: { id: inquiryId } });
    if (!existing || existing.deletedAt) throw new Error(`询价单 ${inquiryId} 不存在`);
    validateInquiryStatusTransition(existing.status, 'Compared');

    const quotes: SupplierQuoteRecord[] = Array.isArray(existing.supplierQuotes) ? (existing.supplierQuotes as unknown as SupplierQuoteRecord[]) : [];
    const selected = quotes.find(q => q.id === quoteId);
    if (!selected) throw new Error(`报价 ${quoteId} 不存在于询价单 ${inquiryId}，无法比价决策`);

    // 标记中选/落选
    const marked = quotes.map(q => ({ ...q, isSelected: q.id === quoteId }));

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      await assertCurrentInquiry(tx, existing, options);
      const inquiry = await tx.supplierInquiry.update({
        where: { id: inquiryId },
        data: {
          status: 'Compared',
          supplierQuotes: marked as any,
          selectedSupplierId: selected.supplierId ?? null,
          selectedSupplierName: selected.supplierName,
          decisionNote: decisionNote || null,
          updatedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'select_supplier',
          targetType: 'SupplierInquiry',
          targetId: inquiryId,
          detail: { source: 'api:procurement', before: { status: existing.status }, after: { status: 'Compared', selectedSupplierName: selected.supplierName, decisionNote } } as any,
          ip: null,
          operationType: 'transition',
          fieldPath: 'status',
          beforeValue: existing.status,
          afterValue: 'Compared',
          transactionId: null,
        },
      });
      return inquiry;
    });

    logger.info('[ProcurementService] supplier selected', { inquiryId, quoteId, supplierName: selected.supplierName });
    return updated;
  }

  // ── 关闭询价单（Compared → Closed） ──
  async function closeSupplierInquiry(inquiryId: string, actorId: string, options?: ProcurementWriteOptions): Promise<SupplierInquiry> {
    const existing = await prisma.supplierInquiry.findUnique({ where: { id: inquiryId } });
    if (!existing || existing.deletedAt) throw new Error(`询价单 ${inquiryId} 不存在`);
    validateInquiryStatusTransition(existing.status, 'Closed');

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      await assertCurrentInquiry(tx, existing, options);
      const inquiry = await tx.supplierInquiry.update({
        where: { id: inquiryId },
        data: { status: 'Closed', updatedAt: now },
      });
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'close_supplier_inquiry',
          targetType: 'SupplierInquiry',
          targetId: inquiryId,
          detail: { source: 'api:procurement', before: { status: existing.status }, after: { status: 'Closed' } } as any,
          ip: null,
          operationType: 'transition',
          fieldPath: 'status',
          beforeValue: existing.status,
          afterValue: 'Closed',
          transactionId: null,
        },
      });
      return inquiry;
    });

    logger.info('[ProcurementService] supplier inquiry closed', { inquiryId });
    return updated;
  }

  return {
    createPurchaseOrder: legacySupplierMutation(createPurchaseOrder),
    updatePurchaseOrder: legacySupplierMutation(updatePurchaseOrder),
    deletePurchaseOrder: legacySupplierMutation(deletePurchaseOrder),
    listPurchaseOrders,
    getPurchaseOrder,
    sendPurchaseOrder: legacySupplierMutation(sendPurchaseOrder),
    confirmPurchaseOrder: legacySupplierMutation(confirmPurchaseOrder),
    cancelPurchaseOrder: legacySupplierMutation(cancelPurchaseOrder),
    closePurchaseOrder: legacySupplierMutation(closePurchaseOrder),
    transitionPurchaseOrderStatus: legacySupplierMutation(transitionPurchaseOrderStatus),
    createMaterialReceipt: legacySupplierMutation(createMaterialReceipt),
    createSupplierInquiry,
    updateSupplierInquiry,
    deleteSupplierInquiry,
    listSupplierInquiries,
    getSupplierInquiry,
    addSupplierQuote,
    updateSupplierQuote,
    removeSupplierQuote,
    selectSupplier,
    closeSupplierInquiry,
  };
}

export type ProcurementService = ReturnType<typeof createProcurementService>;

/** Reject incomplete lines explicitly; zero price is permitted while preparing a draft. */
export function validatePurchaseLines(lines: PurchaseLineInput[]): void {
  if (!Array.isArray(lines) || !lines.length) throw new PurchaseOrderDomainError('采购明细至少需要一行');
  lines.forEach((line, index) => {
    if (!['Material','FinishedGoods','ProcessingService'].includes(line?.kind ?? 'Material')) throw new PurchaseOrderDomainError('采购类型无效');
    if (line?.kind === 'ProcessingService' && !(line.unitPrice > 0)) throw new PurchaseOrderDomainError('加工服务必须明确大于零的采购单价');
    if (!line || typeof line.description !== 'string' || !line.description.trim() || typeof line.unit !== 'string' || !line.unit.trim() || typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0 || typeof line.unitPrice !== 'number' || !Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
      throw new PurchaseOrderDomainError(`采购明细第${index + 1}行无效：描述、单位必填，数量必须大于零，单价不得为负数`);
    }
  });
}
async function releaseDemandAllocations(tx: any, purchaseOrderId: string, now: number) {
  const allocations = await tx.purchaseDemandAllocation?.findMany({ where: { purchaseOrderId, status: 'Active' } });
  if (!allocations?.length) return;
  if (tx.$queryRaw) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${purchaseOrderId} FOR UPDATE`);
  const received = await tx.materialReceipt?.count?.({ where: { purchaseOrderId, totalReceived: { gt: 0 } } });
  if (received) throw new Error('需求采购已发生收货，不能取消或释放数量，请走退货与变更处理');
  const lines = await tx.purchaseLine.findMany({ where: { purchaseOrderId } });
  if (lines.some((line: any) => Number(line.receivedQuantity) > 0 || Number(line.rejectedQuantity) > 0)) {
    throw new Error('需求采购已发生收货，不能取消或释放数量，请走退货与变更处理');
  }
  await tx.purchaseDemandAllocation.updateMany({ where: { purchaseOrderId, status: 'Active' }, data: { status: 'Released', releasedAt: now } });
  for (const demandId of [...new Set(allocations.map((a: any) => a.demandId))]) {
    await tx.procurementDemand.update({ where: { id: demandId }, data: { revision: { increment: 1 }, updatedAt: now } });
  }
}

/** All mutations serialize against the same PO row; stale preflight snapshots never revive a cancelled PO. */
async function assertCurrentPurchaseOrder(tx: any, purchaseOrderId: string, expectedStatus: string, expectedUpdatedAt?: bigint, options?: ProcurementWriteOptions, receiptBoundary = false) {
  if (!tx.$queryRaw) return; // Minimal test transaction doubles do not expose raw-query execution.
  const rows = await tx.$queryRaw(Prisma.sql`SELECT "status", "deletedAt", "updatedAt", "orderId" FROM "PurchaseOrder" WHERE "id" = ${purchaseOrderId} FOR UPDATE`);
  const current = rows[0];
  if (!current || current.deletedAt) { if(receiptBoundary)throw new ReceiptDomainError('采购单不存在或已删除，请刷新','NOT_FOUND'); throw new Error('采购单不存在或已删除，请刷新'); }
  if (receiptBoundary && options?.expectedOrderId !== undefined && (current.orderId ?? null) !== options.expectedOrderId) throw new ReceiptDomainError('采购单关联订单已变化，请刷新后重新授权','CONFLICT');
  if (options?.expectedOrderId !== undefined && (current.orderId ?? null) !== options.expectedOrderId) throw Object.assign(new Error('采购单关联订单已变化，请刷新后重新授权'), { code: 'CONFLICT', status: 409, statusCode: 409 });
  if (current.status !== expectedStatus || (expectedUpdatedAt != null && String(current.updatedAt) !== String(expectedUpdatedAt))) {
    if (receiptBoundary) throw new ReceiptDomainError('采购单状态或内容已变化，请刷新后重试','CONFLICT');
    throw Object.assign(new Error('采购单状态或内容已变化，请刷新后重试'), { code: 'CONFLICT', status: 409, statusCode: 409 });
  }
}

/** Locks the inquiry before writing JSON quotes or changing ownership/state. */
async function assertCurrentInquiry(tx: any, expected: any, options?: ProcurementWriteOptions) {
  if (!tx.$queryRaw) return;
  const rows = await tx.$queryRaw(Prisma.sql`SELECT "status", "deletedAt", "updatedAt", "orderId" FROM "SupplierInquiry" WHERE "id" = ${expected.id} FOR UPDATE`);
  const current = rows[0];
  if (!current || current.deletedAt) throw Object.assign(new Error('询价单不存在或已删除'), { code: 'NOT_FOUND', status: 404, statusCode: 404 });
  if (options?.expectedOrderId !== undefined && (current.orderId ?? null) !== options.expectedOrderId) throw Object.assign(new Error('询价单关联订单已变化，请刷新后重新授权'), { code: 'CONFLICT', status: 409, statusCode: 409 });
  if (current.status !== expected.status || (expected.updatedAt != null && String(current.updatedAt) !== String(expected.updatedAt))) throw Object.assign(new Error('询价单状态或报价已变化，请刷新后重试'), { code: 'CONFLICT', status: 409, statusCode: 409 });
}

function receiptQuantity(value: unknown, label: string): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') throw new ReceiptDomainError(`${label}必须为非负数字`);
  let decimal: Prisma.Decimal;
  try { decimal = new Prisma.Decimal(value); } catch { throw new ReceiptDomainError(`${label}必须为非负数字`); }
  if (!decimal.isFinite() || decimal.lt(0) || decimal.decimalPlaces()>4 || decimal.gte('100000000000000')) throw new ReceiptDomainError(`${label}必须为非负数字，最多四位小数`);
  return Number(decimal);
}
function normalizeReceiptInput(input: MaterialReceiptInput): MaterialReceiptInput {
  if (typeof input.receiptNumber !== 'string' || !input.receiptNumber.trim() || typeof input.receivedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.receivedDate)) throw new ReceiptDomainError('收料单号与有效收货日期必填');
  if (!isValidLocalDateKey(input.receivedDate)) throw new ReceiptDomainError('收货日期无效');
  if (input.lineReceipts != null && !Array.isArray(input.lineReceipts)) throw new ReceiptDomainError('行级收料明细必须为数组');
  const totalReceived=receiptQuantity(input.totalReceived,'总收货量'),totalAccepted=receiptQuantity(input.totalAccepted,'合格量'),totalRejected=receiptQuantity(input.totalRejected,'不合格量');
  if (totalReceived<=0 || !new Prisma.Decimal(totalAccepted).plus(totalRejected).eq(totalReceived)) throw new ReceiptDomainError('总收货量必须大于零且等于合格量与不合格量之和');
  return {...input,receiptNumber:input.receiptNumber.trim(),totalReceived,totalAccepted,totalRejected};
}
function stableReceiptJSON(value: any): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])) : v;
  return JSON.stringify(stable(value));
}

async function validatePurchaseLineSources(tx:any, lines:PurchaseLineInput[], orderId?:string|null) {
  for (const line of lines) {
    if(line.kind === 'ProcessingService' && (!orderId || !line.orderLineId)) throw new PurchaseOrderDomainError('加工服务必须关联订单及真实订单行');
    if(line.orderLineId) {const source=await tx.orderLine.findUnique({where:{id:line.orderLineId},select:{orderId:true}});if(!source || !orderId || source.orderId!==orderId) throw new PurchaseOrderDomainError('采购来源订单行不属于当前订单');}
  }
}
