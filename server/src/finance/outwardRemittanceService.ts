/**
 * 阶段 C6 — 付汇水单（OutwardRemittance）mutation + 凭证摘要服务
 *
 * 设计决策（镜像 fxSettlementService 付款侧口径）：
 *   - 核销主干：OutwardRemittance.voucherId → PaymentVoucher（type=Disbursement 外币凭证）
 *     一笔外币付款可分次付汇；未付余额 = voucher.amount - Σactive remittances.foreignAmount
 *   - cnyAmount 服务端计算 = round4(foreignAmount × fxRate)，客户端传入一律拒绝（防篡改口径漂移）
 *   - orderId / customerRelationId 从凭证继承（单一真源），不接受客户端覆盖
 *   - CNY 凭证无付汇语义（fail closed）；Receipt 凭证走 FxSettlement 结汇路径
 *   - 软删即回滚未付余额（余额是 derived 查询，无冗余字段，无双写漂移风险）
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { syncOutwardRemittanceReferences, deactivateEntityLinks } from '../entities/sync';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { publishBusinessEvent } from '../events/businessEventBus';

export type OutwardRemittanceErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_AMOUNT'
  | 'INVALID_DATE'
  | 'INVALID_PURPOSE'
  | 'VOUCHER_NOT_FOUND'
  | 'NOT_A_DISBURSEMENT'
  | 'CNY_VOUCHER_NO_REMITTANCE'
  | 'CURRENCY_MISMATCH'
  | 'OVER_REMITTANCE'
  | 'REMITTANCE_NOT_FOUND'
  | 'CREATE_FAILED'
  | 'DELETE_FAILED';

export interface OutwardRemittanceError {
  code: OutwardRemittanceErrorCode;
  message: string;
}

export type OutwardRemittanceMutationResult =
  | { ok: true; data: { remittance: any; auditId: string } }
  | { ok: false; error: OutwardRemittanceError };

export const REMITTANCE_PURPOSES = ['GoodsPayment', 'Freight', 'Insurance', 'Commission', 'Other'] as const;
export type OutwardRemittancePurpose = typeof REMITTANCE_PURPOSES[number];

export interface OutwardRemittanceCreateInput {
  remittanceNumber?: string;
  voucherId: string;
  remitDate: string;
  foreignAmount: number | string;
  currency?: string; // 缺省继承凭证币种；显式传入必须一致
  fxRate: number | string;
  payeeName?: string;
  payeeBank?: string;
  payeeSwift?: string;
  purpose?: string;
  bank?: string;
  slipNumber?: string;
  notes?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDecimalInput(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return false;
    try { return new Prisma.Decimal(v).isFinite(); } catch { return false; }
  }
  return false;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function decimalString(v: any): string | null {
  if (v === undefined || v === null) return null;
  return typeof v?.toString === 'function' ? v.toString() : String(v);
}

function generateId(prefix: string): string {
  return `${prefix}__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function generateRemittanceNumber(remitDate: string): string {
  const compact = remitDate.replace(/-/g, '');
  return `OWR-${compact}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** 凭证已付汇总额（active remittances ΣforeignAmount）。tx 感知。 */
async function sumRemittedForVoucher(ctx: any, voucherId: string): Promise<number> {
  const rows = await ctx.outwardRemittance.findMany({
    where: { voucherId, deletedAt: null },
    select: { foreignAmount: true },
  });
  return rows.reduce((acc: number, r: any) => acc + Number(r.foreignAmount.toString()), 0);
}

export async function createOutwardRemittance(params: {
  prisma: PrismaClient;
  input: OutwardRemittanceCreateInput;
  actorId?: string;
  ip?: string | null;
}): Promise<OutwardRemittanceMutationResult> {
  const { prisma, input, actorId, ip } = params;

  // ── 输入校验（fail closed） ──
  if (!input || typeof input.voucherId !== 'string' || !input.voucherId.trim()) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'voucherId is required' } };
  }
  if (typeof input.remitDate !== 'string' || !DATE_RE.test(input.remitDate)) {
    return { ok: false, error: { code: 'INVALID_DATE', message: 'remitDate must be YYYY-MM-DD' } };
  }
  if (!isValidDecimalInput(input.foreignAmount) || Number(input.foreignAmount) <= 0) {
    return { ok: false, error: { code: 'INVALID_AMOUNT', message: 'foreignAmount must be a positive decimal' } };
  }
  if (!isValidDecimalInput(input.fxRate) || Number(input.fxRate) <= 0) {
    return { ok: false, error: { code: 'INVALID_AMOUNT', message: 'fxRate must be a positive decimal' } };
  }
  if ((input as any).cnyAmount !== undefined) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'cnyAmount is server-computed; do not pass it' } };
  }
  if (input.purpose !== undefined && input.purpose !== null && input.purpose !== ''
    && !REMITTANCE_PURPOSES.includes(input.purpose as OutwardRemittancePurpose)) {
    return { ok: false, error: { code: 'INVALID_PURPOSE', message: `purpose must be one of ${REMITTANCE_PURPOSES.join('|')}` } };
  }

  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      // ── 凭证校验 ──
      const voucher = await tx.paymentVoucher.findUnique({ where: { id: input.voucherId.trim() } });
      if (!voucher || voucher.deletedAt) {
        throw Object.assign(new Error('voucher not found'), { code: 'VOUCHER_NOT_FOUND' });
      }
      if (voucher.type !== 'Disbursement') {
        throw Object.assign(new Error('only Disbursement vouchers can be remitted (receipt vouchers use FX settlement)'), { code: 'NOT_A_DISBURSEMENT' });
      }
      if (voucher.currency === 'CNY') {
        throw Object.assign(new Error('CNY voucher has no outward remittance semantics'), { code: 'CNY_VOUCHER_NO_REMITTANCE' });
      }
      const currency = input.currency?.trim() || voucher.currency;
      if (currency !== voucher.currency) {
        throw Object.assign(new Error(`remittance currency (${currency}) must match voucher currency (${voucher.currency})`), { code: 'CURRENCY_MISMATCH' });
      }

      // ── 未付余额校验（防超付） ──
      const remitted = await sumRemittedForVoucher(tx, voucher.id);
      const voucherAmount = Number(voucher.amount.toString());
      const remaining = round4(voucherAmount - remitted);
      const foreignAmount = Number(input.foreignAmount);
      if (foreignAmount > remaining) {
        throw Object.assign(
          new Error(`over-remittance: foreignAmount ${foreignAmount} exceeds remaining ${remaining} ${voucher.currency} (voucher ${voucherAmount}, already remitted ${round4(remitted)})`),
          { code: 'OVER_REMITTANCE' },
        );
      }

      // ── 服务端计算 cnyAmount ──
      const fxRate = Number(input.fxRate);
      const cnyAmount = round4(foreignAmount * fxRate);

      const now = BigInt(Date.now());
      const remittance = await tx.outwardRemittance.create({
        data: {
          id: generateId('OWR'),
          remittanceNumber: input.remittanceNumber?.trim() || generateRemittanceNumber(input.remitDate),
          voucherId: voucher.id,
          orderId: voucher.orderId ?? null,
          customerRelationId: voucher.customerRelationId ?? null,
          remitDate: input.remitDate,
          foreignAmount: new Prisma.Decimal(foreignAmount.toFixed(4)),
          currency,
          fxRate: new Prisma.Decimal(input.fxRate.toString()),
          cnyAmount: new Prisma.Decimal(cnyAmount.toFixed(4)),
          payeeName: input.payeeName?.trim() || null,
          payeeBank: input.payeeBank?.trim() || null,
          payeeSwift: input.payeeSwift?.trim() || null,
          purpose: input.purpose?.trim() || null,
          bank: input.bank?.trim() || null,
          slipNumber: input.slipNumber?.trim() || null,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
        },
      });

      await syncOutwardRemittanceReferences(prisma, remittance, { source: 'route:outward-remittance:create' }, tx);
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:outward-remittance:create',
        operation: 'create_outward_remittance', targetType: 'OutwardRemittance', targetId: remittance.id,
        after: {
          id: remittance.id, remittanceNumber: remittance.remittanceNumber,
          voucherId: remittance.voucherId, foreignAmount: decimalString(remittance.foreignAmount),
          currency: remittance.currency, fxRate: decimalString(remittance.fxRate), cnyAmount: decimalString(remittance.cnyAmount),
          purpose: remittance.purpose,
        },
        ip: ip || null,
      });
      return { remittance, auditId };
    });

    publishBusinessEvent({
      type: 'OutwardRemittanceCreated',
      sourceEntityType: 'OutwardRemittance',
      sourceEntityId: result.remittance.id,
      orderId: result.remittance.orderId || undefined,
      payload: {
        remittanceId: result.remittance.id,
        remittanceNumber: result.remittance.remittanceNumber,
        voucherId: result.remittance.voucherId,
        foreignAmount: decimalString(result.remittance.foreignAmount),
        currency: result.remittance.currency,
        fxRate: decimalString(result.remittance.fxRate),
        cnyAmount: decimalString(result.remittance.cnyAmount),
        remitDate: result.remittance.remitDate,
        purpose: result.remittance.purpose,
        customerRelationId: result.remittance.customerRelationId,
      },
      actorId: actorId || 'api',
      transactionId: result.auditId,
    }).catch(() => { /* event publish failure must not fail business */ });

    return { ok: true, data: result };
  } catch (e: any) {
    if (e?.code && typeof e.code === 'string' && !e.code.startsWith('P')) {
      return { ok: false, error: { code: e.code, message: String(e.message ?? e) } };
    }
    logger.error('[finance/outward-remittance:create] transaction failed', { error: e?.message ?? String(e) });
    return { ok: false, error: { code: 'CREATE_FAILED', message: '付汇记录未能创建，本次未确认任何改动，请稍后重试；持续失败请联系管理员。' } };
  }
}

export async function deleteOutwardRemittance(params: {
  prisma: PrismaClient;
  remittanceId: string;
  actorId?: string;
  ip?: string | null;
}): Promise<OutwardRemittanceMutationResult> {
  const { prisma, remittanceId, actorId, ip } = params;
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const existing = await tx.outwardRemittance.findUnique({ where: { id: remittanceId } });
      if (!existing || existing.deletedAt) {
        throw Object.assign(new Error('outward remittance not found'), { code: 'REMITTANCE_NOT_FOUND' });
      }
      const now = BigInt(Date.now());
      const remittance = await tx.outwardRemittance.update({
        where: { id: remittanceId },
        data: { deletedAt: now, updatedAt: now },
      });
      await deactivateEntityLinks(tx, 'outwardRemittance', remittanceId, now);
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:outward-remittance:delete',
        operation: 'delete_outward_remittance', targetType: 'OutwardRemittance', targetId: remittanceId,
        before: {
          remittanceNumber: existing.remittanceNumber, voucherId: existing.voucherId,
          foreignAmount: decimalString(existing.foreignAmount), currency: existing.currency,
        },
        ip: ip || null,
      });
      return { remittance, auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    if (e?.code && typeof e.code === 'string' && !e.code.startsWith('P')) {
      return { ok: false, error: { code: e.code, message: String(e.message ?? e) } };
    }
    logger.error('[finance/outward-remittance:delete] transaction failed', { error: e?.message ?? String(e) });
    return { ok: false, error: { code: 'DELETE_FAILED', message: '付汇记录未能删除，本次未确认任何改动，请稍后重试；持续失败请联系管理员。' } };
  }
}

// ────────────────────────────────────────────────────────────────
// 只读查询：凭证付汇摘要 / 付汇列表
// ────────────────────────────────────────────────────────────────

export interface VoucherRemittanceSummary {
  voucherId: string;
  voucherNumber: string;
  voucherAmount: string;
  currency: string;
  remittedAmount: string;
  remainingAmount: string;
  fullyRemitted: boolean;
  remittances: any[];
}

export async function getVoucherRemittanceSummary(
  prisma: PrismaClient,
  voucherId: string,
): Promise<{ ok: true; data: VoucherRemittanceSummary } | { ok: false; error: OutwardRemittanceError }> {
  const voucher = await (prisma as any).paymentVoucher.findUnique({ where: { id: voucherId } });
  if (!voucher || voucher.deletedAt) {
    return { ok: false, error: { code: 'VOUCHER_NOT_FOUND', message: 'voucher not found' } };
  }
  const remittances = await (prisma as any).outwardRemittance.findMany({
    where: { voucherId, deletedAt: null },
    orderBy: { remitDate: 'asc' },
  });
  const remitted = remittances.reduce((acc: number, s: any) => acc + Number(s.foreignAmount.toString()), 0);
  const voucherAmount = Number(voucher.amount.toString());
  const remaining = round4(voucherAmount - remitted);
  return {
    ok: true,
    data: {
      voucherId: voucher.id,
      voucherNumber: voucher.voucherNumber,
      voucherAmount: voucherAmount.toFixed(4),
      currency: voucher.currency,
      remittedAmount: round4(remitted).toFixed(4),
      remainingAmount: remaining.toFixed(4),
      fullyRemitted: remaining <= 0,
      remittances,
    },
  };
}

export async function listOutwardRemittances(
  prisma: PrismaClient,
  params: { voucherId?: string; from?: string; to?: string } = {},
): Promise<{ items: any[]; total: number }> {
  const where: any = { deletedAt: null };
  if (params.voucherId) where.voucherId = params.voucherId;
  if (params.from && DATE_RE.test(params.from)) where.remitDate = { ...(where.remitDate || {}), gte: params.from };
  if (params.to && DATE_RE.test(params.to)) where.remitDate = { ...(where.remitDate || {}), lte: params.to };
  const items = await (prisma as any).outwardRemittance.findMany({
    where,
    orderBy: [{ remitDate: 'desc' }, { createdAt: 'desc' }],
  });
  return { items, total: items.length };
}
