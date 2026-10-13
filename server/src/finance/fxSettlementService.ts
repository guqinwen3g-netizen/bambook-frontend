/**
 * 阶段 F / F2 — 结汇水单（FxSettlement）mutation + 台账聚合服务
 *
 * 设计决策：
 *   - 核销主干：FxSettlement.voucherId → PaymentVoucher（type=Receipt 外币凭证）
 *     一笔外币收款可分次结汇；核销余额 = voucher.amount - Σactive settlements.foreignAmount
 *   - cnyAmount 服务端计算 = round4(foreignAmount × fxRate)，客户端传入一律拒绝（防篡改口径漂移）
 *   - orderId / customerRelationId 从凭证继承（单一真源），不接受客户端覆盖
 *   - CNY 凭证无结汇语义（fail closed）；Disbursement 凭证同理
 *   - 软删即回滚核销余额（余额是 derived 查询，无冗余字段，无双写漂移风险）
 *   - 台账（getFxLedger）只读聚合：按币种分行的收汇/已结汇/未结汇/加权汇率/汇兑差额估算
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { syncFxSettlementReferences, deactivateEntityLinks } from '../entities/sync';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { publishBusinessEvent } from '../events/businessEventBus';

export type FxSettlementErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_AMOUNT'
  | 'INVALID_DATE'
  | 'VOUCHER_NOT_FOUND'
  | 'NOT_A_RECEIPT'
  | 'CNY_VOUCHER_NO_SETTLEMENT'
  | 'CURRENCY_MISMATCH'
  | 'OVER_SETTLEMENT'
  | 'SETTLEMENT_NOT_FOUND'
  | 'CREATE_FAILED'
  | 'DELETE_FAILED';

export interface FxSettlementError {
  code: FxSettlementErrorCode;
  message: string;
}

export type FxSettlementMutationResult =
  | { ok: true; data: { settlement: any; auditId: string } }
  | { ok: false; error: FxSettlementError };

export interface FxSettlementCreateInput {
  settlementNumber?: string;
  voucherId: string;
  settleDate: string;
  foreignAmount: number | string;
  currency?: string; // 缺省继承凭证币种；显式传入必须一致
  fxRate: number | string;
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

function generateSettlementNumber(settleDate: string): string {
  const compact = settleDate.replace(/-/g, '');
  return `FXS-${compact}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** 凭证已结汇总额（active settlements ΣforeignAmount）。tx 感知。 */
async function sumSettledForVoucher(ctx: any, voucherId: string): Promise<number> {
  const rows = await ctx.fxSettlement.findMany({
    where: { voucherId, deletedAt: null },
    select: { foreignAmount: true },
  });
  return rows.reduce((acc: number, r: any) => acc + Number(r.foreignAmount.toString()), 0);
}

export async function createFxSettlement(params: {
  prisma: PrismaClient;
  input: FxSettlementCreateInput;
  actorId?: string;
  ip?: string | null;
}): Promise<FxSettlementMutationResult> {
  const { prisma, input, actorId, ip } = params;

  // ── 输入校验（fail closed） ──
  if (!input || typeof input.voucherId !== 'string' || !input.voucherId.trim()) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'voucherId is required' } };
  }
  if (typeof input.settleDate !== 'string' || !DATE_RE.test(input.settleDate)) {
    return { ok: false, error: { code: 'INVALID_DATE', message: 'settleDate must be YYYY-MM-DD' } };
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

  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      // ── 凭证校验 ──
      const voucher = await tx.paymentVoucher.findUnique({ where: { id: input.voucherId.trim() } });
      if (!voucher || voucher.deletedAt) {
        throw Object.assign(new Error('voucher not found'), { code: 'VOUCHER_NOT_FOUND' });
      }
      if (voucher.type !== 'Receipt') {
        throw Object.assign(new Error('only Receipt vouchers can be settled (payment vouchers have no FX settlement semantics)'), { code: 'NOT_A_RECEIPT' });
      }
      if (voucher.currency === 'CNY') {
        throw Object.assign(new Error('CNY voucher has no FX settlement semantics'), { code: 'CNY_VOUCHER_NO_SETTLEMENT' });
      }
      const currency = input.currency?.trim() || voucher.currency;
      if (currency !== voucher.currency) {
        throw Object.assign(new Error(`settlement currency (${currency}) must match voucher currency (${voucher.currency})`), { code: 'CURRENCY_MISMATCH' });
      }

      // ── 核销余额校验（防超结） ──
      const settled = await sumSettledForVoucher(tx, voucher.id);
      const voucherAmount = Number(voucher.amount.toString());
      const remaining = round4(voucherAmount - settled);
      const foreignAmount = Number(input.foreignAmount);
      if (foreignAmount > remaining) {
        throw Object.assign(
          new Error(`over-settlement: foreignAmount ${foreignAmount} exceeds remaining ${remaining} ${voucher.currency} (voucher ${voucherAmount}, already settled ${round4(settled)})`),
          { code: 'OVER_SETTLEMENT' },
        );
      }

      // ── 服务端计算 cnyAmount ──
      const fxRate = Number(input.fxRate);
      const cnyAmount = round4(foreignAmount * fxRate);

      const now = BigInt(Date.now());
      const settlement = await tx.fxSettlement.create({
        data: {
          id: generateId('FXS'),
          settlementNumber: input.settlementNumber?.trim() || generateSettlementNumber(input.settleDate),
          voucherId: voucher.id,
          orderId: voucher.orderId ?? null,
          customerRelationId: voucher.customerRelationId ?? null,
          settleDate: input.settleDate,
          foreignAmount: new Prisma.Decimal(foreignAmount.toFixed(4)),
          currency,
          fxRate: new Prisma.Decimal(input.fxRate.toString()),
          cnyAmount: new Prisma.Decimal(cnyAmount.toFixed(4)),
          bank: input.bank?.trim() || null,
          slipNumber: input.slipNumber?.trim() || null,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
        },
      });

      await syncFxSettlementReferences(prisma, settlement, { source: 'route:fx-settlement:create' }, tx);
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:fx-settlement:create',
        operation: 'create_fx_settlement', targetType: 'FxSettlement', targetId: settlement.id,
        after: {
          id: settlement.id, settlementNumber: settlement.settlementNumber,
          voucherId: settlement.voucherId, foreignAmount: decimalString(settlement.foreignAmount),
          currency: settlement.currency, fxRate: decimalString(settlement.fxRate), cnyAmount: decimalString(settlement.cnyAmount),
        },
        ip: ip || null,
      });
      return { settlement, auditId };
    });

    publishBusinessEvent({
      type: 'FxSettlementCreated',
      sourceEntityType: 'FxSettlement',
      sourceEntityId: result.settlement.id,
      orderId: result.settlement.orderId || undefined,
      payload: {
        settlementId: result.settlement.id,
        settlementNumber: result.settlement.settlementNumber,
        voucherId: result.settlement.voucherId,
        foreignAmount: decimalString(result.settlement.foreignAmount),
        currency: result.settlement.currency,
        fxRate: decimalString(result.settlement.fxRate),
        cnyAmount: decimalString(result.settlement.cnyAmount),
        settleDate: result.settlement.settleDate,
        customerRelationId: result.settlement.customerRelationId,
      },
      actorId: actorId || 'api',
      transactionId: result.auditId,
    }).catch(() => { /* event publish failure must not fail business */ });

    return { ok: true, data: result };
  } catch (e: any) {
    if (e?.code && typeof e.code === 'string' && !e.code.startsWith('P')) {
      return { ok: false, error: { code: e.code, message: String(e.message ?? e) } };
    }
    logger.error('[finance/fx-settlement:create] transaction failed', { error: e?.message ?? String(e) });
    return { ok: false, error: { code: 'CREATE_FAILED', message: '结汇记录未能创建，本次未确认任何改动，请稍后重试；请同时核对汇率快照是否存在。持续失败请联系管理员。' } };
  }
}

export async function deleteFxSettlement(params: {
  prisma: PrismaClient;
  settlementId: string;
  actorId?: string;
  ip?: string | null;
}): Promise<FxSettlementMutationResult> {
  const { prisma, settlementId, actorId, ip } = params;
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const existing = await tx.fxSettlement.findUnique({ where: { id: settlementId } });
      if (!existing || existing.deletedAt) {
        throw Object.assign(new Error('fx settlement not found'), { code: 'SETTLEMENT_NOT_FOUND' });
      }
      const now = BigInt(Date.now());
      const settlement = await tx.fxSettlement.update({
        where: { id: settlementId },
        data: { deletedAt: now, updatedAt: now },
      });
      await deactivateEntityLinks(tx, 'fxSettlement', settlementId, now);
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:fx-settlement:delete',
        operation: 'delete_fx_settlement', targetType: 'FxSettlement', targetId: settlementId,
        before: {
          settlementNumber: existing.settlementNumber, voucherId: existing.voucherId,
          foreignAmount: decimalString(existing.foreignAmount), currency: existing.currency,
        },
        ip: ip || null,
      });
      return { settlement, auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    if (e?.code && typeof e.code === 'string' && !e.code.startsWith('P')) {
      return { ok: false, error: { code: e.code, message: String(e.message ?? e) } };
    }
    logger.error('[finance/fx-settlement:delete] transaction failed', { error: e?.message ?? String(e) });
    return { ok: false, error: { code: 'DELETE_FAILED', message: '结汇记录未能删除，本次未确认任何改动，请稍后重试；持续失败请联系管理员。' } };
  }
}

// ────────────────────────────────────────────────────────────────
// 只读查询：凭证核销摘要 / 外汇台账
// ────────────────────────────────────────────────────────────────

export interface VoucherSettlementSummary {
  voucherId: string;
  voucherNumber: string;
  voucherAmount: string;
  currency: string;
  settledAmount: string;
  remainingAmount: string;
  fullySettled: boolean;
  settlements: any[];
}

export async function getVoucherSettlementSummary(
  prisma: PrismaClient,
  voucherId: string,
): Promise<{ ok: true; data: VoucherSettlementSummary } | { ok: false; error: FxSettlementError }> {
  const voucher = await (prisma as any).paymentVoucher.findUnique({ where: { id: voucherId } });
  if (!voucher || voucher.deletedAt) {
    return { ok: false, error: { code: 'VOUCHER_NOT_FOUND', message: 'voucher not found' } };
  }
  const settlements = await (prisma as any).fxSettlement.findMany({
    where: { voucherId, deletedAt: null },
    orderBy: { settleDate: 'asc' },
  });
  const settled = settlements.reduce((acc: number, s: any) => acc + Number(s.foreignAmount.toString()), 0);
  const voucherAmount = Number(voucher.amount.toString());
  const remaining = round4(voucherAmount - settled);
  return {
    ok: true,
    data: {
      voucherId: voucher.id,
      voucherNumber: voucher.voucherNumber,
      voucherAmount: voucherAmount.toFixed(4),
      currency: voucher.currency,
      settledAmount: round4(settled).toFixed(4),
      remainingAmount: remaining.toFixed(4),
      fullySettled: remaining <= 0,
      settlements,
    },
  };
}

export interface FxLedgerRow {
  currency: string;
  receivedTotal: string;       // 期间内外币收汇总额（Receipt 凭证，排除 CNY）
  settledTotal: string;        // 期间内已结汇外币总额
  unsettledBalance: string;    // 截至当前未结汇余额（全量口径，不限期间）
  settlementCount: number;
  weightedAvgSettleRate: string | null; // ΣcnyAmount / ΣforeignAmount
  fxDiffEstimate: string | null;        // Σ((结汇汇率 - 收款日汇率快照) × foreignAmount)——汇兑损益线索
}

export interface FxLedger {
  from: string | null;
  to: string | null;
  rows: FxLedgerRow[];
  unsettledVouchers: Array<{
    voucherId: string;
    voucherNumber: string;
    customerName: string | null;
    paymentDate: string;
    currency: string;
    voucherAmount: string;
    remainingAmount: string;
  }>;
}

export async function getFxLedger(
  prisma: PrismaClient,
  params: { from?: string; to?: string } = {},
): Promise<FxLedger> {
  const from = params.from && DATE_RE.test(params.from) ? params.from : null;
  const to = params.to && DATE_RE.test(params.to) ? params.to : null;

  // 期间内收汇（外币 Receipt 凭证）
  const voucherWhere: any = { type: 'Receipt', deletedAt: null, currency: { not: 'CNY' } };
  if (from) voucherWhere.paymentDate = { ...(voucherWhere.paymentDate || {}), gte: from };
  if (to) voucherWhere.paymentDate = { ...(voucherWhere.paymentDate || {}), lte: to };
  const periodVouchers = await (prisma as any).paymentVoucher.findMany({
    where: voucherWhere,
    select: { id: true, voucherNumber: true, amount: true, currency: true, exchangeRate: true, paymentDate: true, customerName: true },
  });

  // 期间内结汇（关联凭证取收款日汇率快照）
  const settlementWhere: any = { deletedAt: null };
  if (from) settlementWhere.settleDate = { ...(settlementWhere.settleDate || {}), gte: from };
  if (to) settlementWhere.settleDate = { ...(settlementWhere.settleDate || {}), lte: to };
  const periodSettlements = await (prisma as any).fxSettlement.findMany({ where: settlementWhere });
  const settlementVoucherIds = [...new Set(periodSettlements.map((s: any) => s.voucherId))] as string[];
  const settlementVouchers = settlementVoucherIds.length > 0
    ? await (prisma as any).paymentVoucher.findMany({ where: { id: { in: settlementVoucherIds } }, select: { id: true, exchangeRate: true, currency: true } })
    : [];
  const voucherRateById = new Map<string, any>(settlementVouchers.map((v: any) => [v.id, v]));

  // 全量口径未结汇余额（不限期间——台账回答"现在还有多少外币躺在账上"）
  const allForeignReceipts = await (prisma as any).paymentVoucher.findMany({
    where: { type: 'Receipt', deletedAt: null, currency: { not: 'CNY' } },
    select: { id: true, voucherNumber: true, amount: true, currency: true, paymentDate: true, customerName: true },
  });
  const allSettlements = await (prisma as any).fxSettlement.findMany({
    where: { deletedAt: null },
    select: { voucherId: true, foreignAmount: true },
  });
  const settledByVoucher = new Map<string, number>();
  for (const s of allSettlements) {
    settledByVoucher.set(s.voucherId, (settledByVoucher.get(s.voucherId) ?? 0) + Number(s.foreignAmount.toString()));
  }

  const rowsByCurrency = new Map<string, {
    received: number; settled: number; cny: number; count: number; fxDiff: number; fxDiffKnown: boolean; unsettled: number;
  }>();
  const bucket = (c: string) => {
    let b = rowsByCurrency.get(c);
    if (!b) { b = { received: 0, settled: 0, cny: 0, count: 0, fxDiff: 0, fxDiffKnown: false, unsettled: 0 }; rowsByCurrency.set(c, b); }
    return b;
  };

  for (const v of periodVouchers) bucket(v.currency).received += Number(v.amount.toString());
  for (const s of periodSettlements) {
    const b = bucket(s.currency);
    const foreign = Number(s.foreignAmount.toString());
    b.settled += foreign;
    b.cny += Number(s.cnyAmount.toString());
    b.count += 1;
    const vRate = voucherRateById.get(s.voucherId)?.exchangeRate;
    if (vRate != null) {
      b.fxDiff += (Number(s.fxRate.toString()) - Number(vRate.toString())) * foreign;
      b.fxDiffKnown = true;
    }
  }

  const unsettledVouchers: FxLedger['unsettledVouchers'] = [];
  for (const v of allForeignReceipts) {
    const settled = settledByVoucher.get(v.id) ?? 0;
    const remaining = round4(Number(v.amount.toString()) - settled);
    if (remaining <= 0) continue;
    bucket(v.currency).unsettled += remaining;
    unsettledVouchers.push({
      voucherId: v.id,
      voucherNumber: v.voucherNumber,
      customerName: v.customerName ?? null,
      paymentDate: v.paymentDate,
      currency: v.currency,
      voucherAmount: Number(v.amount.toString()).toFixed(4),
      remainingAmount: remaining.toFixed(4),
    });
  }

  const rows: FxLedgerRow[] = [...rowsByCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, b]) => ({
      currency,
      receivedTotal: round4(b.received).toFixed(4),
      settledTotal: round4(b.settled).toFixed(4),
      unsettledBalance: round4(b.unsettled).toFixed(4),
      settlementCount: b.count,
      weightedAvgSettleRate: b.settled > 0 ? (b.cny / b.settled).toFixed(8) : null,
      fxDiffEstimate: b.fxDiffKnown ? round4(b.fxDiff).toFixed(4) : null,
    }));

  // 未结汇凭证列表按日期倒序（最近收汇优先处理）
  unsettledVouchers.sort((a, b) => (a.paymentDate < b.paymentDate ? 1 : -1));

  return { from, to, rows, unsettledVouchers };
}
