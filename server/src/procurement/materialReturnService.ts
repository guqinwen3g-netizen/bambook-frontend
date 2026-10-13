/**
 * materialReturnService — P1-4 物料退换货（退货/换货/索赔）
 *
 * 设计真源：docs/design/10-评审与决策/2026-08-25-中度与严重缺失功能开发优先级规划.md P1-4
 * schema 真源：schema.prisma model MaterialReturn（含设计决策注释）
 *
 * 状态机：pending(待退回) → shipped(已退回) → confirmed(供应商确认) → settled(结算完成)
 *         pending → cancelled
 *
 * 拒收退回只记录交回供应商事实，不扣减合格库存；换货确认不等于新货验收入库。
 * 金额索赔确认仍生成负向应付。实物额度按收料逐行拒收证据及物料单位核对；
 * 无逐行证据的旧单仅允许唯一单行匹配，多行不得用单头数量猜测。
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { logger } from '../lib/logger';
import { todayLocalKey } from '../shared/localDate';


export type MaterialReturnResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): MaterialReturnResult<never> =>
  ({ ok: false, error: { code, message, status } });

export const MATERIAL_RETURN_TYPES = ['return', 'exchange', 'claim'] as const;
export const MATERIAL_RETURN_STATUSES = ['pending', 'shipped', 'confirmed', 'settled', 'cancelled'] as const;

export const MATERIAL_RETURN_TYPE_LABELS: Record<string, string> = {
  return: '退货', exchange: '换货', claim: '索赔',
};
export const MATERIAL_RETURN_STATUS_LABELS: Record<string, string> = {
  pending: '待退回', shipped: '已退回', confirmed: '供应商已确认', settled: '结算完成', cancelled: '已取消',
};

/** 拒收率 → 供应商绩效评分（对齐供应商对账文档 §5 差异处理分级） */
export function returnRateScore(rejected: number, received: number): number {
  if (!(received > 0)) return 60;
  const rate = rejected / received;
  if (rate <= 0.05) return 90; // ≤5%：退货折让扣款档
  if (rate <= 0.10) return 70; // 5-10%：退货 + 整改档
  return 40; // >10%：批次拒收 + 评级降级档
}

function shortId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function todayYmd(): string {
  return todayLocalKey();
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface CreateMaterialReturnInput {
  receiptId: string;
  type: string;
  materialCode?: string;
  materialName?: string;
  quantity: number;
  unit?: string;
  amount?: number;
  currency?: string;
  reason?: string;
  notes?: string;
}

export function createMaterialReturnService(prisma: PrismaClient) {
  const db = prisma as any;


  const boundaryError = (code: string, message: string): never => { throw Object.assign(new Error(message), { boundaryCode: code, code, statusCode: 409 }); };
  async function rejectionBasis(store: any, receiptId: string, materialCode?: string, unit?: string | null) {
    const receipt = await store.materialReceipt.findUnique({ where: { id: receiptId } });
    if (!receipt || receipt.deletedAt) return boundaryError('RECEIPT_NOT_FOUND', '来源收料记录不存在，请核对');
    const po = await store.purchaseOrder.findUnique({ where: { id: receipt.purchaseOrderId }, include: { lines: true } });
    if (!po || po.deletedAt) return boundaryError('REJECTION_SOURCE_UNRESOLVED', '来源采购单不存在或已删除，请先核对');
    const lines = po.lines ?? [];
    const matching = lines.filter((line: any) => String(line.materialCode ?? '').trim() === String(materialCode ?? '').trim());
    if (matching.length !== 1 || (!String(materialCode ?? '').trim() && lines.length !== 1)) return boundaryError('REJECTION_SOURCE_UNRESOLVED', '无法唯一匹配拒收物料来源，请先核对采购行与收料明细');
    const line = matching[0];
    if (!line.unit || (unit && unit !== line.unit)) return boundaryError('REJECTION_UNIT_MISMATCH', '退回单位与来源采购行不一致，请核对，不自动换算');
    const audits = store.auditLog?.findMany ? await store.auditLog.findMany({ where: { action: 'create_material_receipt', targetType: 'PurchaseOrder', targetId: receipt.purchaseOrderId }, orderBy: { createdAt: 'desc' } }) : [];
    const evidence = audits.find((a: any) => a.detail?.after?.receiptId === receiptId)?.detail?.after?.lineReceipts;
    let rejected: number;
    if (Array.isArray(evidence)) {
      const row = evidence.find((l: any) => l.lineId === line.id);
      if (!row || row.materialCode !== line.materialCode || row.unit !== line.unit || !Number.isFinite(Number(row.rejected)) || Number(row.rejected)<0) return boundaryError('REJECTION_SOURCE_UNRESOLVED', '拒收行证据无法与物料及单位对应，请先核对收料明细');
      rejected = Number(row.rejected);
    } else if (lines.length === 1) rejected = Number(receipt.totalRejected);
    else return boundaryError('REJECTION_SOURCE_UNRESOLVED', '旧多行收料缺少逐行拒收证据，不能按单头数量猜测退货物料，请先核对');
    if (!Number.isFinite(rejected) || rejected < 0) return boundaryError('REJECTION_SOURCE_UNRESOLVED', '来源拒收数量无效，请先核对');
    return { receipt, line, rejected };
  }
  /** Rejects are never part of accepted stock. Quota is scoped to the evidenced receipt line. */
  async function remainingQuota(receiptId: string, excludeReturnId?: string, identity?: {materialCode:string;unit?:string|null}, store: any = db): Promise<number> {
    const basis = await rejectionBasis(store, receiptId, identity?.materialCode, identity?.unit);
    const siblings = await store.materialReturn.findMany({ where: { receiptId, materialCode: basis.line.materialCode, status: { not: 'cancelled' }, deletedAt: null, type: { in: ['return','exchange'] }, ...(excludeReturnId?{id:{not:excludeReturnId}}:{}) } });
    if (siblings.some((r: any)=>r.unit && r.unit !== basis.line.unit)) return boundaryError('REJECTION_UNIT_MISMATCH','已有退回记录单位不一致，请先核对，不能混加');
    return new Prisma.Decimal(basis.rejected).minus(siblings.reduce((sum: any,r: any)=>sum.plus(r.quantity),new Prisma.Decimal(0))).toNumber();
  }

  async function lockTransition(tx: any, id: string, receiptId: string, expected: string) {
    if (tx.$queryRaw) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MaterialReceipt" WHERE "id" = ${receiptId} FOR UPDATE`);
    const current = await tx.materialReturn.findUnique({where:{id}});
    if (!current || current.deletedAt || current.receiptId !== receiptId || current.status !== expected) boundaryError('INVALID_STATUS','退换货状态已变化，请刷新后重试');
    return current;
  }

  // ── 登记退换货/索赔（pending）──
  async function createReturn(input: CreateMaterialReturnInput, actorId?: string): Promise<MaterialReturnResult<any>> {
    try {
      const receiptId = String(input.receiptId ?? '').trim();
      if (!receiptId) return fail('RECEIPT_REQUIRED', 'receiptId 必填（退换货锚定来料检验单）');
      const type = String(input.type ?? '').trim();
      if (!(MATERIAL_RETURN_TYPES as readonly string[]).includes(type)) {
        return fail('INVALID_TYPE', `type 须为 ${MATERIAL_RETURN_TYPES.join(' | ')}`);
      }
      const quantity = num(input.quantity) ?? -1;
      if (quantity < 0) return fail('INVALID_QUANTITY', 'quantity 须为非负数');
      if (type !== 'claim' && quantity <= 0) {
        return fail('INVALID_QUANTITY', '退货/换货数量必须大于 0');
      }
      const amount = num(input.amount ?? null);
      if (type === 'claim' && (amount == null || amount <= 0)) {
        return fail('AMOUNT_REQUIRED', '索赔（claim）必须填写索赔金额（正数）');
      }
      if (amount != null && amount < 0) return fail('INVALID_AMOUNT', 'amount 须为非负数（索赔/折让金额）');

      const receipt = await db.materialReceipt.findUnique({ where: { id: receiptId } });
      if (!receipt) return fail('RECEIPT_NOT_FOUND', `来料检验单 ${receiptId} 不存在`, 404);
      const po = await db.purchaseOrder.findUnique({ where: { id: receipt.purchaseOrderId } });
      if (!po) return fail('PO_NOT_FOUND', `采购单 ${receipt.purchaseOrderId} 不存在`, 404);

      // 实物额度校验（claim 纯金额不占额度）
      if (type !== 'claim') {
        const quota = await remainingQuota(receiptId, undefined, {materialCode:String(input.materialCode ?? '').trim(),unit:input.unit});
        if (quantity > quota + 1e-9) {
          return fail('QUOTA_EXCEEDED', `退换数量超出来料不合格额度：本单不合格 ${Number(receipt.totalRejected)}，剩余可退 ${Math.max(0, Math.round(quota * 10000) / 10000)}`);
        }
      }

      const now = Date.now();
      const currency = String(input.currency ?? po.currency ?? 'CNY').trim() || 'CNY';
      const returnNumber = await nextBusinessNumber(db, 'RT', undefined, {
        occupied: async (n: string) => !!(await db.materialReturn.findFirst({ where: { returnNumber: n }, select: { id: true } })),
      });

      const created = await db.$transaction(async (tx: any) => {
        if (type !== 'claim') {
          if (tx.$queryRaw) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MaterialReceipt" WHERE "id" = ${receiptId} FOR UPDATE`);
          const quota = await remainingQuota(receiptId, undefined, {materialCode:String(input.materialCode ?? '').trim(),unit:input.unit}, tx);
          if (quantity > quota + 1e-9) boundaryError('QUOTA_EXCEEDED', '本次退回数量超过该物料剩余拒收额度，请刷新后核对');
        }
        const basis = type === 'claim' ? null : await rejectionBasis(tx,receiptId,String(input.materialCode ?? '').trim(),input.unit);
        const row = await tx.materialReturn.create({
          data: {
            id: shortId('MATRET'),
            returnNumber,
            receiptId,
            purchaseOrderId: receipt.purchaseOrderId,
            supplierRelationId: po.supplierRelationId ?? null,
            supplierName: po.supplierName ?? null,
            type,
            materialCode: String(input.materialCode ?? '').trim() || null,
            materialName: String(input.materialName ?? '').trim() || null,
            quantity,
            unit: basis?.line.unit ?? (String(input.unit ?? '').trim() || null),
            amount: amount ?? null,
            currency,
            status: 'pending',
            reason: String(input.reason ?? receipt.rejectionReason ?? '').trim() || null,
            notes: String(input.notes ?? '').trim() || null,
            createdAt: now,
            updatedAt: now,
          },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:procurement:material-return',
          operation: 'create_material_return',
          targetType: 'MaterialReturn',
          targetId: row.id,
          after: { returnNumber, type, quantity, amount: amount ?? null, receiptId },
          ip: null,
        });
        return row;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      logger.info('[MaterialReturn] created', { returnNumber, type, quantity, receiptId });
      return { ok: true, data: { materialReturn: created } };
    } catch (e: any) {
      if (e?.boundaryCode) return fail(e.boundaryCode, e.message, 409);
      logger.error('[MaterialReturn] create failed', { error: e?.message });
      // B33：原文只进日志（上一行），对外只给中文 + 下一步。登记全在事务内 ⇒ 失败时确实零写入。
      return fail('CREATE_FAILED', '退换货登记未能完成，本次没有写入任何数据，请稍后重试；持续失败请联系管理员核对该来料检验单的退换记录。', 500);
    }
  }

  /** 幂等防重：该退换单是否已产生指定类型的库存流水（对齐 L8 联动去重范式，重试安全） */
  async function hasStockMovement(returnId: string, type: 'Inbound' | 'Outbound'): Promise<boolean> {
    const dup = await db.stockMovement.findFirst({
      where: { referenceType: 'MaterialReturn', referenceId: returnId, type },
      select: { id: true },
    });
    return !!dup;
  }

  // ── 发运确认（pending → shipped；仅登记拒收品交回事实）──
  async function markShipped(id: string, actorId?: string): Promise<MaterialReturnResult<any>> {
    try {
      const row = await db.materialReturn.findUnique({ where: { id } });
      if (!row || row.deletedAt) return fail('NOT_FOUND', `退换货单 ${id} 不存在`, 404);
      if (row.status !== 'pending') {
        return fail('INVALID_STATUS', `退换货单状态为 ${row.status}，仅 pending 可发运确认`, 409);
      }

      // This model records rejected goods that were never accepted into available stock.
      // A matching material code is not evidence of ownership/location of rejected stock.
      const stockItemId: string | null = null;
      const skipStockReason = row.type === 'claim' ? null : '拒收品未计入合格库存，本次仅登记交回供应商事实，不扣减合格库存';
      if (row.type !== 'claim') {
        if (row.stockItemId || await hasStockMovement(row.id,'Outbound')) return fail('LEGACY_STOCK_REVIEW','旧退回单已有库存出库关联，请先核对并调整，不能自动重复或冲回',409);
        const quota = await remainingQuota(row.receiptId,row.id,{materialCode:row.materialCode,unit:row.unit});
        if (Number(row.quantity)>quota+1e-9) return fail('QUOTA_EXCEEDED','退回数量超过该物料拒收额度，请先核对来源',409);
      }

      const now = Date.now();
      const updated = await db.$transaction(async (tx: any) => {
        const current = await lockTransition(tx,id,row.receiptId,'pending');
        if (current.type !== 'claim' && Number(current.quantity) > await remainingQuota(current.receiptId,current.id,{materialCode:current.materialCode,unit:current.unit},tx) + 1e-9) boundaryError('QUOTA_EXCEEDED','拒收额度已变化，请刷新后核对');
        const next = await tx.materialReturn.update({
          where: { id },
          data: { status: 'shipped', stockItemId, updatedAt: now },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:procurement:material-return',
          operation: 'mark_shipped_material_return',
          targetType: 'MaterialReturn',
          targetId: id,
          before: { status: 'pending' },
          after: { status: 'shipped', stockItemId, skipStockReason: skipStockReason ?? null },
          ip: null,
        });
        return next;
      });
      if (skipStockReason) logger.info('[MaterialReturn] stock outbound skipped', { id, reason: skipStockReason });
      return { ok: true, data: { materialReturn: updated, skipStockReason } };
    } catch (e: any) {
      if (e?.boundaryCode) return fail(e.boundaryCode, e.message, 409);
      logger.error('[MaterialReturn] markShipped failed', { error: e?.message });
      // 原文仅进日志；拒收品交回不写合格库存流水。
      return fail('SHIP_FAILED', '退换货发运确认未能完成，退换单仍停在待退回状态，请稍后重试；持续失败请联系管理员核对该退换单的交回记录。', 500);
    }
  }

  // ── 供应商确认（shipped → confirmed；claim负向应付发票 / 绩效评分）──
  async function confirmReturn(id: string, actorId?: string): Promise<MaterialReturnResult<any>> {
    try {
      const row = await db.materialReturn.findUnique({ where: { id } });
      if (!row || row.deletedAt) return fail('NOT_FOUND', `退换货单 ${id} 不存在`, 404);
      if (row.status !== 'shipped') {
        return fail('INVALID_STATUS', `退换货单状态为 ${row.status}，仅 shipped 可供应商确认`, 409);
      }
      const receipt = await db.materialReceipt.findUnique({ where: { id: row.receiptId } });

      // Supplier confirmation is not a new accepted receipt. Replacement goods require ordinary receiving/QC.
      if (row.type !== 'claim' && (row.stockItemId || await hasStockMovement(row.id,'Outbound'))) return fail('LEGACY_STOCK_REVIEW','旧退回单已有库存出库关联，请先核对并调整，供应商确认不能自动生成换货入库',409);

      const now = Date.now();
      const today = todayYmd();
      const result = await db.$transaction(async (tx: any) => {
        const current = await lockTransition(tx,id,row.receiptId,'shipped');
        let claimInvoiceId: string | null = current.claimInvoiceId;

        // claim：生成负向 Payable 发票（CLM-YYYY-NNNN，贷项通知单——对账单自然冲减应付）
        if (row.type === 'claim' && row.amount != null && !claimInvoiceId) {
          const invoiceNumber = await nextBusinessNumber(tx, 'CLM', undefined, {
            occupied: async (n: string) => !!(await tx.invoice.findFirst({ where: { invoiceNumber: n }, select: { id: true } })),
          });
          const invoice = await tx.invoice.create({
            data: {
              id: shortId('INV'),
              invoiceNumber,
              type: 'Payable',
              status: 'Issued',
              amount: -Math.abs(Number(row.amount)), // 负向冲减
              currency: row.currency,
              issueDate: today,
              customerRelationId: row.supplierRelationId ?? null,
              customerName: row.supplierName ?? null,
              notes: `物料索赔贷项：退换单 ${row.returnNumber}${row.reason ? `（${row.reason}）` : ''}，冲减应付`,
              createdAt: now,
              updatedAt: now,
            },
          });
          claimInvoiceId = invoice.id;
        }

        const next = await tx.materialReturn.update({
          where: { id },
          data: { status: 'confirmed', claimInvoiceId, updatedAt: now },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:procurement:material-return',
          operation: 'confirm_material_return',
          targetType: 'MaterialReturn',
          targetId: id,
          before: { status: 'shipped' },
          after: { status: 'confirmed', claimInvoiceId, exchangeStockIn: row.type === 'exchange' && !!row.stockItemId },
          ip: null,
        });
        return { materialReturn: next, claimInvoiceId };
      });

      // 供应商绩效：拒收率分级评分（非阻塞，幂等）
      if (row.supplierRelationId && receipt) {
        try {
          const { createFactoryService } = await import('../suppliers/factoryService');
          const factoryService = createFactoryService(prisma);
          const score = returnRateScore(Number(receipt.totalRejected), Number(receipt.totalReceived));
          await factoryService.recordAutoEvaluation({
            relationId: row.supplierRelationId,
            kind: 'inspection',
            score,
            sourceType: 'materialReturn',
            sourceId: row.id,
            evaluatedAt: today,
            note: `物料退换货 ${row.returnNumber}（${MATERIAL_RETURN_TYPE_LABELS[row.type] ?? row.type}）：本单拒收 ${Number(receipt.totalRejected)}/${Number(receipt.totalReceived)}`,
            actorId: actorId || 'system',
          });
        } catch (e: any) {
          logger.warn('[MaterialReturn] evaluation failed (non-blocking)', { error: e?.message });
        }
      }

      logger.info('[MaterialReturn] confirmed', { id: row.id, type: row.type, claimInvoiceId: result.claimInvoiceId });
      return { ok: true, data: result };
    } catch (e: any) {
      if (e?.boundaryCode) return fail(e.boundaryCode, e.message, 409);
      logger.error('[MaterialReturn] confirm failed', { error: e?.message });
      // B33：同 markShipped —— exchange 回冲流水在事务之前已落库，故只承诺「状态未变更」。
      return fail('CONFIRM_FAILED', '供应商确认未能完成，退换单仍停在已退回状态，请稍后重试；持续失败请联系管理员核对该退换单的库存回冲与索赔贷项发票。', 500);
    }
  }

  /** A supplier claim closes only against its exact native credit invoice and
   * actual incoming cash allocations. A Paid/header projection is insufficient.
   * Common financial writers lock Invoice before PaymentVoucher; keep that
   * order here after the material-return parent/source lock. */
  async function assertSupplierClaimSettled(tx: any, current: any) {
    if (!current.claimInvoiceId || !current.supplierRelationId || current.amount == null
        || !new Prisma.Decimal(current.amount).isFinite() || new Prisma.Decimal(current.amount).lte(0)) {
      boundaryError('SOURCE_CLAIM_CONFLICT', '索赔缺少准确供应商、正数金额或当前贷项来源，请先对账，不能直接结案');
    }
    const receipt = await tx.materialReceipt.findUnique({ where: { id: current.receiptId } });
    const po = await tx.purchaseOrder.findUnique({ where: { id: current.purchaseOrderId } });
    if (!receipt || receipt.deletedAt || receipt.purchaseOrderId !== current.purchaseOrderId
        || !po || po.deletedAt || po.supplierRelationId !== current.supplierRelationId) {
      boundaryError('SOURCE_CLAIM_CONFLICT', '索赔与原收料、采购单或供应商来源不一致，请先核对');
    }
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "id" = ${current.claimInvoiceId} FOR UPDATE`);
    const invoice = await tx.invoice.findUnique({ where: { id: current.claimInvoiceId } });
    const sources = await tx.materialReturn.findMany({ where: { claimInvoiceId: current.claimInvoiceId, deletedAt: null } });
    const confirmations = await tx.auditLog.findMany({ where: { action: 'confirm_material_return', targetType: 'MaterialReturn', targetId: current.id } });
    const nativeSource = confirmations.filter((audit: any) => audit.detail?.after?.status === 'confirmed' && audit.detail?.after?.claimInvoiceId === current.claimInvoiceId);
    if (!invoice || invoice.deletedAt || invoice.type !== 'Payable' || !new Prisma.Decimal(invoice.amount).lt(0)
        || !new Prisma.Decimal(invoice.amount).abs().equals(current.amount) || invoice.currency !== current.currency
        || invoice.customerRelationId !== current.supplierRelationId || ['Draft', 'Cancelled'].includes(invoice.status)
        || sources.length !== 1 || sources[0].id !== current.id || nativeSource.length !== 1) {
      boundaryError('SOURCE_CLAIM_CONFLICT', '当前索赔贷项的来源、供应商、币种、金额或确认审计不一致，请先对账');
    }
    const allocations = await tx.invoiceAllocation.findMany({ where: { invoiceId: invoice.id }, orderBy: { id: 'asc' } });
    const credits = await tx.creditNoteAllocation.findMany({ where: { invoiceId: invoice.id } });
    const total = allocations.reduce((sum: Prisma.Decimal, row: any) => {
      const amount = new Prisma.Decimal(row.appliedAmount);
      if (!amount.isFinite() || amount.lte(0)) boundaryError('SOURCE_CLAIM_CONFLICT', '索赔核销含无效金额，请先核对真实收款');
      return sum.plus(amount);
    }, new Prisma.Decimal(0));
    if (credits.length || !total.equals(new Prisma.Decimal(invoice.amount).abs()) || invoice.status !== 'Paid') {
      boundaryError('INVALID_STATE', '供应商索赔尚未由准确收款全额核销，或发票结算状态不一致，请完成财务核对后再结案');
    }
    for (const voucherId of [...new Set(allocations.map((row: any) => String(row.voucherId)))].sort()) {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PaymentVoucher" WHERE "id" = ${voucherId} FOR UPDATE`);
      const voucher = await tx.paymentVoucher.findUnique({ where: { id: voucherId } });
      if (!voucher || voucher.deletedAt || voucher.type !== 'Receipt'
          || !['unreconciled', 'partially_reconciled', 'reconciled'].includes(voucher.status)
          || voucher.customerRelationId !== current.supplierRelationId || voucher.currency !== current.currency
          || !new Prisma.Decimal(voucher.amount).isFinite() || new Prisma.Decimal(voucher.amount).lte(0)) {
        boundaryError('SOURCE_CLAIM_CONFLICT', '索赔核销来源不是该供应商同币种的有效真实收款，请先对账');
      }
      const all = await tx.invoiceAllocation.findMany({ where: { voucherId } });
      const voucherTotal = all.reduce((sum: Prisma.Decimal, row: any) => {
        const amount = new Prisma.Decimal(row.appliedAmount);
        if (!amount.isFinite() || amount.lte(0)) boundaryError('SOURCE_CLAIM_CONFLICT', '收款凭证含无效核销明细，请先核对');
        return sum.plus(amount);
      }, new Prisma.Decimal(0));
      if (voucherTotal.gt(voucher.amount)) boundaryError('SOURCE_CLAIM_CONFLICT', '收款凭证已被超额核销，请先对账，不能据投影结案');
    }
    return { invoiceId: invoice.id, amount: total.toString(), allocationIds: allocations.map((row: any) => row.id) };
  }

  // ── 结算完成（confirmed → settled）──
  async function settleReturn(id: string, actorId?: string): Promise<MaterialReturnResult<any>> {
    try {
      const row = await db.materialReturn.findUnique({ where: { id } });
      if (!row || row.deletedAt) return fail('NOT_FOUND', `退换货单 ${id} 不存在`, 404);
      if (row.status !== 'confirmed') {
        return fail('INVALID_STATUS', `退换货单状态为 ${row.status}，仅 confirmed 可结算完成`, 409);
      }
      const now = Date.now();
      const updated = await db.$transaction(async (tx: any) => {
        await lockTransition(tx,id,row.receiptId,'confirmed');
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MaterialReturn" WHERE "id" = ${id} FOR UPDATE`);
        const current = await tx.materialReturn.findUnique({ where: { id } });
        if (!current || current.deletedAt || current.receiptId !== row.receiptId || current.status !== 'confirmed') boundaryError('INVALID_STATUS', '退换货状态已变化，请刷新后重试');
        const settlement = current.type === 'claim' ? await assertSupplierClaimSettled(tx, current) : null;
        const changed = await tx.materialReturn.updateMany({ where: { id, status: 'confirmed', claimInvoiceId: current.claimInvoiceId, deletedAt: null }, data: { status: 'settled', updatedAt: now } });
        if (changed.count !== 1) boundaryError('INVALID_STATUS', '退换货来源或状态已变化，本次结案未提交，请刷新后重试');
        const next = await tx.materialReturn.findUnique({ where: { id } });
        await writeRouteAuditLog({
          prisma: tx, actorId: actorId || 'api', source: 'route:procurement:material-return',
          operation: 'settle_material_return', targetType: 'MaterialReturn', targetId: id,
          before: { status: 'confirmed' }, after: { status: 'settled', ...(settlement ? { supplierClaimSettlement: settlement } : {}) }, ip: null,
        });
        return next;
      });
      return { ok: true, data: { materialReturn: updated } };
    } catch (e: any) {
      if (e?.boundaryCode) return fail(e.boundaryCode, e.message, 409);
      logger.error('[MaterialReturn] settle failed', { error: e?.message });
      // B33：结算只做状态流转，全在事务内 ⇒ 失败时零写入。
      return fail('SETTLE_FAILED', '退换货结算未能完成，本次没有写入任何数据，请稍后重试；持续失败请联系管理员核对该退换单的结算状态。', 500);
    }
  }

  // ── 取消（pending → cancelled）──
  async function cancelReturn(id: string, actorId?: string): Promise<MaterialReturnResult<any>> {
    try {
      const row = await db.materialReturn.findUnique({ where: { id } });
      if (!row || row.deletedAt) return fail('NOT_FOUND', `退换货单 ${id} 不存在`, 404);
      if (row.status !== 'pending') {
        return fail('INVALID_STATUS', `退换货单状态为 ${row.status}，已发运/确认的退换货不可取消（冲销走结算流程）`, 409);
      }
      const now = Date.now();
      const updated = await db.$transaction(async (tx: any) => {
        const current = await lockTransition(tx,id,row.receiptId,'pending');
        const next = await tx.materialReturn.update({ where: { id }, data: { status: 'cancelled', updatedAt: now } });
        await writeRouteAuditLog({
          prisma: tx, actorId: actorId || 'api', source: 'route:procurement:material-return',
          operation: 'cancel_material_return', targetType: 'MaterialReturn', targetId: id,
          before: { status: 'pending' }, after: { status: 'cancelled' }, ip: null,
        });
        return next;
      });
      return { ok: true, data: { materialReturn: updated } };
    } catch (e: any) {
      if (e?.boundaryCode) return fail(e.boundaryCode, e.message, 409);
      logger.error('[MaterialReturn] cancel failed', { error: e?.message });
      // B33：取消只做状态流转，全在事务内 ⇒ 失败时零写入。
      return fail('CANCEL_FAILED', '退换货取消未能完成，本次没有写入任何数据，请稍后重试；持续失败请联系管理员核对该退换单当前状态。', 500);
    }
  }

  // ── 列表（采购单/检验单/供应商/状态过滤）──
  async function listReturns(params: {
    purchaseOrderId?: string; receiptId?: string; supplierRelationId?: string; status?: string; limit?: number; visibleOrderIds?: string[] | null;
  }): Promise<MaterialReturnResult<{ items: any[] }>> {
    const where: any = { deletedAt: null };
    if (params.visibleOrderIds != null) {
      const visiblePOs = await db.purchaseOrder.findMany({ where: { deletedAt: null, orderId: { in: params.visibleOrderIds } }, select: { id: true } });
      where.AND = [{ purchaseOrderId: { in: visiblePOs.map((po: any) => po.id) } }];
    }
    if (params.purchaseOrderId) where.purchaseOrderId = params.purchaseOrderId;
    if (params.receiptId) where.receiptId = params.receiptId;
    if (params.supplierRelationId) where.supplierRelationId = params.supplierRelationId;
    if (params.status) where.status = params.status;
    const items = await db.materialReturn.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(params.limit ?? 100, 1), 500),
    });
    return { ok: true, data: { items } };
  }

  return { createReturn, markShipped, confirmReturn, settleReturn, cancelReturn, listReturns, remainingQuota };
}
