/**
 * returnReceiptService.ts — 退货入库单（货这条腿）服务
 *
 * 口径依据：`docs/业务口径决策单-2026-09-17.md` **A1-附 ③**
 *   「**退回来的货必须记清去向**：报废 / 换货补发 / 返修。**不记清，货就在账上凭空消失。**」
 *
 * ── 职责边界（刻意切分）─────────────────────────────────
 * 本服务只负责**开单 + 登记去向**；**实际动库存**发生在货真正到仓时（`markReceived`），
 * 且必须走 `inventoryService` 的 Inbound 流水 —— **本服务不自己写库存**
 * （否则会出现两套库存账，本仓已多次踩过"收口点错位"）。
 */

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { localDateKey } from '../shared/localDate';
import { RETURN_DISPOSITIONS } from './claimCaseService';
import { ClaimTransactionError, claimRefusal, lockClaimRows } from './claimApprovalFact';
import { receiveClaimReturn, RETURN_RECEIVED_ACTION, RETURN_DISPOSED_ACTION } from './claimReturnFulfillmentService';

export type ReturnReceiptCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE';
export interface ReturnReceiptError { code: ReturnReceiptCode; message: string }
export interface ReturnReceiptResult<T = unknown> { ok: boolean; data?: T; error?: ReturnReceiptError }

const fail = <T>(code: ReturnReceiptCode, message: string): ReturnReceiptResult<T> => ({ ok: false, error: { code, message } });
const ok = <T>(data: T): ReturnReceiptResult<T> => ({ ok: true, data });

export interface CreateReturnReceiptInput {
  claimCaseId: string;
  warehouseId: string;
  /** ★ 去向**必填**：Scrap(报废) | Replace(换货补发) | Repair(返修) */
  disposition: string;
  claimDispositionId: string;
  materialCode: string;
  quantity: number | string;
  unit: string;
  notes?: string | null;
}

/** 开一张退货入库单（取号 RT —— 已在册；`MaterialReturn` 也用它，故 `occupied` 必须同时查两表） */
export async function createReturnReceipt(
  prisma: PrismaClient,
  input: CreateReturnReceiptInput,
  actorId: string,
  opts: { tx?: any } = {},
): Promise<ReturnReceiptResult<{ returnReceipt: any }>> {
  if (!input?.claimCaseId) return fail('VALIDATION_FAILED', 'claimCaseId 必填');
  if (!input?.warehouseId) return fail('VALIDATION_FAILED', 'warehouseId 必填（货要入哪个仓）');
  if (!input.claimDispositionId || !input.materialCode?.trim() || !input.unit?.trim()) return fail('VALIDATION_FAILED', '退货必须绑定真实处置、物料和单位');
  if (!input?.disposition || !(RETURN_DISPOSITIONS as readonly string[]).includes(input.disposition)) {
    return fail(
      'VALIDATION_FAILED',
      `退货去向必填且须合法（${RETURN_DISPOSITIONS.join(' / ')}）—— 不记清去向，货会在账上凭空消失`,
    );
  }

  const runInTx = opts.tx ? (fn: (tx: any) => Promise<any>) => fn(opts.tx) : (fn: (tx: any) => Promise<any>) => prisma.$transaction(fn);
  try {
  const returnReceipt = await runInTx(async (tx: any) => {
    const { disposition: d, claimCase } = await lockClaimRows(tx, input.claimDispositionId);
    if (claimCase.id !== input.claimCaseId || d.status !== 'Approved' || d.returnReceiptId) claimRefusal('退货来源处置不匹配或已生成产出');
    const expected = new Prisma.Decimal(String(d.quantity));
    if (!expected.isPositive() || d.materialCode !== input.materialCode || d.unit !== input.unit
        || !expected.equals(String(input.quantity)) || d.returnDisposition !== input.disposition) claimRefusal('退货明细必须完整等于已批准的处置物料、数量、单位和去向');
    const warehouse = await tx.warehouse.findUnique({ where: { id: input.warehouseId } });
    if (!warehouse || warehouse.deletedAt || !warehouse.isActive) claimRefusal('退货仓库不存在或已停用');
    // The case row serializes creation even though the historical model has no case uniqueness.
    await tx.$queryRawUnsafe('SELECT id FROM "ReturnReceipt" WHERE "claimCaseId" = $1 FOR UPDATE', claimCase.id);
    const active = await tx.returnReceipt.findMany({ where: { claimCaseId: claimCase.id, deletedAt: null, status: { not: 'Cancelled' } } });
    if (active.length > 1) claimRefusal('案件已有多张退货单，须先人工对账，不能选择其中一张继续');
    let receipt = active[0];
    let previousLines: any[] = [];
    if (receipt) {
      if (receipt.warehouseId !== input.warehouseId) claimRefusal('案件已有退货仓库；同一退货单不能混入第二个仓库');
      previousLines = await tx.returnReceiptLine.findMany({ where: { returnReceiptId: receipt.id } });
      if (!previousLines.length || previousLines.some((line: any) => line.claimDispositionId === d.id)) claimRefusal('历史退货单没有可核对明细或处置已关联；请先人工对账');
    } else {
    const receiptNumber = await nextBusinessNumber(tx, 'RT', undefined, {
      occupied: async (num) => {
        // ⚠️ 含软删行；★ 且 **RT 号段被两张表共用**（MaterialReturn 供应商退货 + 本表客户退货）
        //   ⇒ 占用校验必须**同时查两表**，否则会与供应商退货单撞号。
        const [a, b] = await Promise.all([
          tx.returnReceipt.findFirst({ where: { receiptNumber: num }, select: { id: true } }),
          tx.materialReturn.findFirst({ where: { returnNumber: num }, select: { id: true } }),
        ]);
        return a != null || b != null;
      },
    });
    receipt = await tx.returnReceipt.create({
      data: {
        id: `RETREC_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        receiptNumber,
        claimCaseId: input.claimCaseId,
        warehouseId: input.warehouseId,
        disposition: input.disposition,
        status: 'Draft',
        notes: input.notes ?? null,
        createdAt: BigInt(Date.now()),
        updatedAt: BigInt(Date.now()),
      },
    });
    }
    const now = BigInt(Date.now());
    const line = await tx.returnReceiptLine.create({ data: {
      id: `RTLINE_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      returnReceiptId: receipt.id, claimDispositionId: d.id, materialCode: d.materialCode,
      expectedQuantity: expected, receivedQuantity: new Prisma.Decimal(0), unit: d.unit,
      disposition: d.returnDisposition, status: 'Draft', createdAt: now, updatedAt: now,
    } });
    const allLines = [...previousLines, line];
    const destinations = new Set(allLines.map(row => row.disposition));
    const status = allLines.some(row => new Prisma.Decimal(row.receivedQuantity).gt(0)) ? 'PartiallyReceived' : 'Draft';
    const updated = await tx.returnReceipt.update({ where: { id: receipt.id }, data: {
      disposition: destinations.size === 1 ? d.returnDisposition : 'Mixed', status, updatedAt: now,
    } });
    await tx.auditLog.create({ data: { id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      actorId, action: 'CLAIM_RETURN_LINE_APPENDED', targetType: 'ReturnReceipt', targetId: receipt.id,
      operationType: 'create', detail: { source: 'claim', before: { status: receipt.status, disposition: receipt.disposition },
        after: { status: updated.status, disposition: updated.disposition },
        returnLine: { id: line.id, claimDispositionId: d.id, materialCode: d.materialCode,
          expectedQuantity: expected.toString(), unit: d.unit, disposition: d.returnDisposition } } } });
    return { ...updated, lines: allLines };
  });

  return ok({ returnReceipt });
  } catch (error) {
    if (error instanceof ClaimTransactionError && !opts.tx) return fail(error.claimError.code as ReturnReceiptCode, error.claimError.message);
    throw error;
  }
}

/**
 * 登记实际收货（货到仓）。
 *
 * Compatibility entry: a header date alone is not physical receipt evidence.
 * @deprecated Use receiveClaimReturn with a real line, inventory item, quantity and stable request.
 */
export async function markReturnReceived(
  prisma: PrismaClient,
  id: string,
  receivedAt?: string,
  opts: { actorId?: string; lineId?: string; itemId?: string; quantity?: number | string; unit?: string; clientRequestId?: string; notes?: string | null } = {},
): Promise<ReturnReceiptResult<{ returnReceipt: any }>> {
  const r = await prisma.returnReceipt.findUnique({ where: { id } });
  if (!r || r.deletedAt) return fail('NOT_FOUND', `退货入库单 ${id} 不存在`);
  if (!opts.actorId || !opts.lineId || !opts.itemId || opts.quantity == null || !opts.unit || !opts.clientRequestId) return fail('VALIDATION_FAILED', '实际收货必须指定明细、库存批次、数量、单位、调用者和稳定请求标识；收货日期不能替代库存流水');
  const line = await (prisma as any).returnReceiptLine.findUnique({ where: { id: opts.lineId } });
  if (!line || line.returnReceiptId !== id) return fail('INVALID_STATE', '实际收货明细不属于指定退货单');
  const result = await receiveClaimReturn(prisma, line.id, { itemId: opts.itemId, quantity: opts.quantity, unit: opts.unit,
    clientRequestId: opts.clientRequestId, receivedAt, notes: opts.notes }, opts.actorId);
  return result.ok ? ok({ returnReceipt: result.data!.returnReceipt }) : fail(result.error!.code as ReturnReceiptCode, result.error!.message);
}

export async function getReturnReceipt(prisma: PrismaClient, id: string): Promise<ReturnReceiptResult<{ returnReceipt: any }>> {
  const r = await (prisma as any).returnReceipt.findUnique({ where: { id }, include: { lines: { orderBy: { createdAt: 'asc' } } } });
  if (!r || r.deletedAt) return fail('NOT_FOUND', `退货入库单 ${id} 不存在`);
  const audits = await (prisma as any).auditLog.findMany({ where: { targetType: 'ReturnReceiptLine', targetId: { in: r.lines.map((line: any) => line.id) },
    action: { in: [RETURN_RECEIVED_ACTION, RETURN_DISPOSED_ACTION] } } });
  const lines = r.lines.map((line: any) => ({ ...line, actualBatches: audits.filter((row: any) => row.targetId === line.id && row.action === RETURN_RECEIVED_ACTION)
    .map((row: any) => { const fact = row.detail?.claimReturn; return { receivedEventId: row.id, actorId: row.actorId,
      quantity: fact?.parameters?.quantity, unit: fact?.parameters?.unit, receivedAt: fact?.parameters?.receivedAt,
      itemId: fact?.batch?.itemId, batchNumber: fact?.batch?.batchNumber, stockQuantity: fact?.batch?.quantity, stockUnit: fact?.batch?.unit,
      disposedEventIds: audits.filter((other: any) => other.action === RETURN_DISPOSED_ACTION && other.detail?.claimReturn?.parameters?.receivedEventId === row.id).map((other: any) => other.id) }; }) }));
  return ok({ returnReceipt: { ...r, lines } });
}
