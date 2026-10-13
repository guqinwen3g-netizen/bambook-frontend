import { lockSupplierClaimInvoice } from './supplierClaimSettlementGuard';
/**
 * ERP-P1-finance-void-delete-route-foundation
 *
 * Invoice 作废/cancel + Invoice/PaymentVoucher 软删 service（route + Agent flow 共用契约）。
 * 业务写入 + EntityLink inactive + AuditLog 同事务闭环，失败 fail closed。
 * 删除 invoice/voucher 如存在 InvoiceAllocation → 409 HAS_ALLOCATIONS，不留下孤儿核销。
 */

import { releaseSupplierClaimInvoiceInTx } from './supplierClaimInvoiceRelease';
import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../lib/logger';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { deactivateEntityLinks } from '../entities/sync';
import { notifyCustomerCreditRecalc } from '../credit/creditService';
import { notifyShipmentBatchSettlementRecalc } from './shipmentBatchSettlementHook';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { createFinanceSourceAccess } from './financeSourceAccess';
import { beginFinanceCommand, assertFinanceRevision, type FinanceCommandReceipt } from './financeCommandReceipt';
import { assertNotCashRefundVoucher } from '../claims/claimCashRefundFact';
import {assertVoucherCashUse} from './companyCashAccountService';

export type FinanceVoidDeleteErrorCode =
  | 'INVOICE_NOT_FOUND'
  | 'VOUCHER_NOT_FOUND'
  | 'INVALID_STATUS'
  | 'HAS_ALLOCATIONS'
  | 'SOURCE_CLAIM_CONFLICT'
  | 'HANDOFF_CONFLICT'
  | 'CANCEL_FAILED'
  | 'DELETE_FAILED';

export interface FinanceVoidDeleteError {
  code: string;
  message: string;
}

async function beginVoidCommand(tx: any, params: { actor?: TokenPayload | null; actorId?: string; requestKey?: string; expectedUpdatedAt?: string; reason?: string },
  kind: 'invoice' | 'voucher', targetId: string, action: 'cancel' | 'delete') {
  const access = await createFinanceSourceAccess(tx, params.actor, [kind === 'invoice' ? 'invoices:write' : 'vouchers:write']);
  if (params.actorId !== access.actor.userId) throw businessError('UNAUTHORIZED', '财务命令缺少可信操作人。');
  if (kind === 'invoice') await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "id"=${targetId} FOR UPDATE`);
  else await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PaymentVoucher" WHERE "id"=${targetId} FOR UPDATE`);
  const model = kind === 'invoice' ? tx.invoice : tx.paymentVoucher;
  const existing = await model.findUnique({ where: { id: targetId } });
  if (!existing || !await access[kind]({ ...existing, deletedAt: null })) throw businessError('NOT_FOUND', '财务记录不存在或不在当前来源范围。');
  if(kind==='voucher')await assertVoucherCashUse(tx,access.actor,existing);
  if (kind === 'invoice' && ['BusinessShipmentCI', 'BusinessDevelopmentCI'].includes(existing.sourceType))
    throw businessError('HANDOFF_CONFLICT', '该应收来自已签发业务 CI，财务不能删除或单独作废原票登记。');
  const command = await beginFinanceCommand(tx, access.actor, `${kind}.${action}`, { targetId, requestKey: params.requestKey,
    expectedUpdatedAt: params.expectedUpdatedAt, reason: params.reason });
  if (!command.replayed) {
    if (existing.deletedAt != null) throw businessError('NOT_FOUND', '该财务记录已删除。');
    assertFinanceRevision(existing, params.expectedUpdatedAt);
  }
  return { access, command, existing };
}

export interface CancelInvoiceParams {
  prisma: PrismaClient;
  invoiceId: string;
  actorId?: string;
  actor?: TokenPayload | null;
  requestKey?: string;
  expectedUpdatedAt?: string;
  reason?: string;
}

export interface CancelInvoiceResult {
  ok: boolean;
  error?: FinanceVoidDeleteError;
  data?: { invoice: any; auditId: string; financeCommand?: FinanceCommandReceipt };
}

const VALID_CANCEL_FROM = new Set(['Draft', 'Issued', 'PartiallyPaid', 'Paid']);

/**
 * Invoice 作废（status→Cancelled）。校验状态转移合法性。
 * 同事务：update status + deactivate EntityLinks + AuditLog。
 */
export async function cancelInvoice(params: CancelInvoiceParams): Promise<CancelInvoiceResult> {
  const { prisma, invoiceId, actorId, reason } = params;
  const now = BigInt(Date.now());

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      await lockSupplierClaimInvoice(tx, invoiceId);
      const { access, command, existing } = await beginVoidCommand(tx, params, 'invoice', invoiceId, 'cancel');
      if (command.replayed) { await access.finish({ deletedInvoiceIds: [invoiceId] }); return command.receipt; }
      if (!existing || existing.deletedAt) {
        throw Object.assign(new Error(`Invoice ${invoiceId} not found`), { code: 'INVOICE_NOT_FOUND', statusCode: 404 });
      }
      if (['SupplierVatPayable', 'FabricCommissionCI'].includes(existing.sourceType)) throw businessError('HANDOFF_CONFLICT', '原生供应商账款不能普通作废；请核对原票并通过独立冲销依据处理，不得改写已付或已退事实。');
      if (['BusinessShipmentCI', 'BusinessDevelopmentCI'].includes(existing.sourceType)) {
        throw Object.assign(new Error('该应收登记业务已签发的商业发票，财务不能单独作废；请保留原票与来源链。'), { code: 'HANDOFF_CONFLICT', statusCode: 409 });
      }
      if (existing.status === undefined) {
        throw Object.assign(new Error(`Invoice ${invoiceId} status undefined`), { code: 'INVALID_STATUS', statusCode: 400 });
      }
      if (existing.status === 'Cancelled') {
        throw Object.assign(new Error(`Invoice ${invoiceId} already cancelled`), { code: 'INVALID_STATUS', statusCode: 400 });
      }
      if (!VALID_CANCEL_FROM.has(existing.status)) {
        throw Object.assign(new Error(`Cannot cancel invoice with status=${existing.status}`), { code: 'INVALID_STATUS', statusCode: 400 });
      }

      // 检查是否有核销记录：有核销的发票不能直接作废，必须先撤销核销
      const allocCount = await tx.invoiceAllocation.count({ where: { invoiceId } });
      if (allocCount > 0) {
        throw Object.assign(new Error(`Cannot cancel invoice with ${allocCount} allocation(s); remove allocations first`), { code: 'HAS_ALLOCATIONS', statusCode: 400 });
      }

      const updated = await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: 'Cancelled', updatedAt: now },
      });

      await releaseSupplierClaimInvoiceInTx(tx, existing, actorId || 'api', now, reason);

      // EntityLink inactive（deactivate 该 invoice 发出的所有 active link）
      await deactivateEntityLinks(tx, 'invoice', invoiceId, now);

      // §10.7 开票互斥口径：作废即释放——发票作废后，来源收费事项从 invoiced 回退 confirmed，
      // 释放费用行占用（否则事项卡在已开票：不可取消、不可重开票，形成死锁）
      if (existing.sourceType === 'BillingItem' && existing.sourceId) {
        const bi = await tx.billingItem.findFirst({ where: { id: existing.sourceId, deletedAt: null } });
        if (bi && bi.status === 'invoiced') {
          await tx.billingItem.update({
            where: { id: bi.id },
            data: { status: 'confirmed', invoiceId: null, updatedAt: now },
          });
          await writeRouteAuditLog({
            prisma: tx, actorId: actorId || 'api', source: 'route:finance:cancel',
            operation: 'cancel_invoice_release_billing_item',
            targetType: 'BillingItem', targetId: bi.id,
            before: { status: 'invoiced', invoiceId: invoiceId },
            after: { status: 'confirmed', invoiceId: null, reason: `发票 ${existing.invoiceNumber} 作废，释放收费事项` },
          });
        }
      }

      // H14 作废回冲：发票作废退出批次结算口径 → 同事务重算受影响批次的
      // invoicedAmount/settleStatus（recalcSettlement 内部已排除 Cancelled 发票）。
      // 此前只有 PATCH /invoices/:id {status:Cancelled} 这一条路径挂了重算，
      // 走本函数（POST /invoices/:id/cancel 与 Agent invoice.cancel）作废的票
      // 批次快照会一直把已作废金额算作"已开票"——静默错账。
      await notifyShipmentBatchSettlementRecalc(tx, { invoiceId, source: 'route:finance:cancel' });

      // 修复1：应收发票作废（status→Cancelled 退出净额口径）→ 同事务重算客户 usedAmount
      if (existing.type === 'Receivable' && existing.customerRelationId) {
        await notifyCustomerCreditRecalc(tx, {
          relationId: existing.customerRelationId,
          source: 'route:finance:cancel',
          triggerId: invoiceId,
          triggerBy: actorId || 'api',
          reason: reason ? `发票作废（${reason}）后应收净额重算` : '发票作废后应收净额重算',
        });
      }

      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:finance:cancel',
        operation: 'cancel_invoice', targetType: 'Invoice', targetId: invoiceId,
        before: { status: existing.status },
        after: { status: 'Cancelled', reason: reason || null },
      });

      // 纯化 BigInt 字段（避免 JSON 序列化失败）
      const safeInvoice = { ...updated, createdAt: Number(updated.createdAt), updatedAt: Number(updated.updatedAt), deletedAt: updated.deletedAt ? Number(updated.deletedAt) : null };
      await access.finish();
      return await command.commit({ invoice: safeInvoice, auditId });
    });
    return { ok: true, data: result };
  } catch (e: any) {
    if (typeof e?.code === 'string' && !/^P[0-9]{4}$/.test(e.code)) return { ok: false, error: { code: e.code, message: e.message } };
    logger.error('[finance/cancel-invoice] transaction failed', { error: e?.message ?? String(e) });
    return { ok: false, error: { code: 'CANCEL_FAILED', message: '这张发票未能作废，本次未确认任何改动，请稍后重试；若该发票已被核销，请先撤销核销再作废。持续失败请联系管理员。' } };
  }
}

export interface DeleteInvoiceParams {
  prisma: PrismaClient;
  invoiceId: string;
  actorId?: string;
  actor?: TokenPayload | null;
  requestKey?: string;
  expectedUpdatedAt?: string;
}

export interface DeleteInvoiceResult {
  ok: boolean;
  error?: FinanceVoidDeleteError;
  data?: { auditId: string; financeCommand?: FinanceCommandReceipt };
}

/**
 * Invoice 软删（deletedAt）。如存在 InvoiceAllocation → 409 HAS_ALLOCATIONS。
 * 同事务：check allocations + update deletedAt + deactivate EntityLinks + AuditLog。
 */
export async function deleteInvoice(params: DeleteInvoiceParams): Promise<DeleteInvoiceResult> {
  const { prisma, invoiceId, actorId } = params;
  const now = BigInt(Date.now());

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      await lockSupplierClaimInvoice(tx, invoiceId);
      const { access, command, existing } = await beginVoidCommand(tx, params, 'invoice', invoiceId, 'delete');
      if (command.replayed) { await access.finish({ deletedInvoiceIds: [invoiceId] }); return command.receipt; }
      if (!existing || existing.deletedAt) {
        throw Object.assign(new Error(`Invoice ${invoiceId} not found`), { code: 'INVOICE_NOT_FOUND', statusCode: 404 });
      }
      if (['SupplierVatPayable', 'FabricCommissionCI'].includes(existing.sourceType)) throw businessError('HANDOFF_CONFLICT', '原生供应商账款及登记回执须保留，不能删除；请核对原票与独立冲销依据。');
      if (['BusinessShipmentCI', 'BusinessDevelopmentCI'].includes(existing.sourceType)) {
        throw Object.assign(new Error('该应收登记业务已签发的商业发票，不能删除财务登记记录。'), { code: 'HANDOFF_CONFLICT', statusCode: 409 });
      }

      // allocation 阻断（不留下孤儿核销）
      const allocCount = await tx.invoiceAllocation.count({ where: { invoiceId } });
      if (allocCount > 0) {
        throw Object.assign(new Error(`Invoice ${invoiceId} has ${allocCount} allocations, cannot delete`), { code: 'HAS_ALLOCATIONS', statusCode: 409 });
      }

      await tx.invoice.update({
        where: { id: invoiceId },
        data: { deletedAt: now, updatedAt: now },
      });

      await releaseSupplierClaimInvoiceInTx(tx, existing, actorId || 'api', now, '删除未核销单据，释放当前索赔关联');

      // EntityLink inactive
      await deactivateEntityLinks(tx, 'invoice', invoiceId, now);

      // 修复1：应收发票软删（deletedAt 退出净额口径）→ 同事务重算客户 usedAmount
      if (existing.type === 'Receivable' && existing.customerRelationId) {
        await notifyCustomerCreditRecalc(tx, {
          relationId: existing.customerRelationId,
          source: 'route:finance:delete',
          triggerId: invoiceId,
          triggerBy: actorId || 'api',
          reason: '发票删除后应收净额重算',
        });
      }

      const committedAuditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:finance:delete',
        operation: 'delete_invoice', targetType: 'Invoice', targetId: invoiceId,
        before: { deletedAt: null },
        after: { deletedAt: Number(now) },
      });
      await access.finish({ deletedInvoiceIds: [invoiceId] });
      return await command.commit({ auditId: committedAuditId });
    });
    return { ok: true, data: result };
  } catch (e: any) {
    if (typeof e?.code === 'string' && !/^P[0-9]{4}$/.test(e.code)) return { ok: false, error: { code: e.code, message: e.message } };
    logger.error('[finance/delete-invoice] transaction failed', { error: e?.message ?? String(e) });
    return { ok: false, error: { code: 'DELETE_FAILED', message: '这张发票未能删除，本次未确认任何改动，请稍后重试；持续失败请联系管理员。' } };
  }
}

export interface DeleteVoucherParams {
  prisma: PrismaClient;
  voucherId: string;
  actorId?: string;
  actor?: TokenPayload | null;
  requestKey?: string;
  expectedUpdatedAt?: string;
}

export interface DeleteVoucherResult {
  ok: boolean;
  error?: FinanceVoidDeleteError;
  data?: { auditId: string; financeCommand?: FinanceCommandReceipt };
}

/**
 * PaymentVoucher 软删（deletedAt）。如存在 InvoiceAllocation → 409 HAS_ALLOCATIONS。
 */
export async function deleteVoucher(params: DeleteVoucherParams): Promise<DeleteVoucherResult> {
  const { prisma, voucherId, actorId } = params;
  const now = BigInt(Date.now());

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      const { access, command, existing } = await beginVoidCommand(tx, params, 'voucher', voucherId, 'delete');
      if (command.replayed) { await access.finish({ deletedVoucherIds: [voucherId] }); return command.receipt; }
      if (!existing || existing.deletedAt) {
        throw Object.assign(new Error(`Voucher ${voucherId} not found`), { code: 'VOUCHER_NOT_FOUND', statusCode: 404 });
      }

      // allocation 阻断
      await assertNotCashRefundVoucher(tx, voucherId);
      const allocCount = await tx.invoiceAllocation.count({ where: { voucherId } });
      if (allocCount > 0) {
        throw Object.assign(new Error(`Voucher ${voucherId} has ${allocCount} allocations, cannot delete`), { code: 'HAS_ALLOCATIONS', statusCode: 409 });
      }

      await tx.paymentVoucher.update({
        where: { id: voucherId },
        data: { deletedAt: now, updatedAt: now },
      });

      // EntityLink inactive
      await deactivateEntityLinks(tx, 'paymentVoucher', voucherId, now);

      const committedAuditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:finance:delete_voucher',
        operation: 'delete_voucher', targetType: 'PaymentVoucher', targetId: voucherId,
        before: { deletedAt: null },
        after: { deletedAt: Number(now) },
      });
      await access.finish({ deletedVoucherIds: [voucherId] });
      return await command.commit({ auditId: committedAuditId });
    });
    return { ok: true, data: result };
  } catch (e: any) {
    if (e.code) return { ok: false, error: { code: e.code, message: e.message } };
    logger.error('[finance/delete-voucher] transaction failed', { error: e?.message ?? String(e) });
    return { ok: false, error: { code: 'DELETE_FAILED', message: '这张收付款凭证未能删除，本次未确认任何改动，请稍后重试；若已被核销请先撤销核销。持续失败请联系管理员。' } };
  }
}

export interface CancelVoucherParams {
  prisma: PrismaClient;
  voucherId: string;
  actorId?: string;
  actor?: TokenPayload | null;
  requestKey?: string;
  expectedUpdatedAt?: string;
  reason?: string;
}

export interface CancelVoucherResult {
  ok: boolean;
  error?: FinanceVoidDeleteError;
  data?: { voucher: any; auditId: string; financeCommand?: FinanceCommandReceipt };
}

/**
 * PaymentVoucher 作废（status → cancelled）。校验状态 + allocation 检查。
 * 同事务：check allocations + update status + deactivate EntityLinks + AuditLog。
 */
export async function cancelVoucher(params: CancelVoucherParams): Promise<CancelVoucherResult> {
  const { prisma, voucherId, actorId, reason } = params;
  const now = BigInt(Date.now());

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      const { access, command, existing } = await beginVoidCommand(tx, params, 'voucher', voucherId, 'cancel');
      if (command.replayed) { await access.finish({ deletedVoucherIds: [voucherId] }); return command.receipt; }
      if (!existing || existing.deletedAt) {
        throw Object.assign(new Error(`Voucher ${voucherId} not found`), { code: 'VOUCHER_NOT_FOUND', statusCode: 404 });
      }

      // 已有核销记录的凭证不可作废，必须先撤销核销
      await assertNotCashRefundVoucher(tx, voucherId);
      const allocCount = await tx.invoiceAllocation.count({ where: { voucherId } });
      if (allocCount > 0) {
        throw Object.assign(new Error(`Cannot cancel voucher with ${allocCount} allocation(s); remove allocations first`), { code: 'HAS_ALLOCATIONS', statusCode: 400 });
      }

      const updated = await tx.paymentVoucher.update({
        where: { id: voucherId },
        data: { status: 'cancelled', updatedAt: now },
      });

      await deactivateEntityLinks(tx, 'paymentVoucher', voucherId, now);

      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:finance:cancel_voucher',
        operation: 'cancel_voucher', targetType: 'PaymentVoucher', targetId: voucherId,
        before: { status: existing.status },
        after: { status: 'cancelled', reason: reason || null },
      });

      const safeVoucher = { ...updated, createdAt: Number(updated.createdAt), updatedAt: Number(updated.updatedAt), deletedAt: updated.deletedAt ? Number(updated.deletedAt) : null };
      await access.finish();
      return await command.commit({ voucher: safeVoucher, auditId });
    });
    return { ok: true, data: result };
  } catch (e: any) {
    if (e.code) return { ok: false, error: { code: e.code, message: e.message } };
    logger.error('[finance/cancel-voucher] transaction failed', { error: e?.message ?? String(e) });
    return { ok: false, error: { code: 'CANCEL_FAILED', message: '这张收付款凭证未能作废，本次未确认任何改动，请稍后重试；若已被核销请先撤销核销。持续失败请联系管理员。' } };
  }
}
