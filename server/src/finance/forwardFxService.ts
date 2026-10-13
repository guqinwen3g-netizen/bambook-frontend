import { businessNowDate } from '../shared/businessClock';
/**
 * forwardFxService.ts — ★ D6 与银行的远期结汇合约（2026-09-18）
 *
 * ── 为什么需要它（零基础障碍清单 D6「远期结汇/锁汇缺合约模型」· 实测核实）──
 * 本仓**已经有两层**：
 *   · `FxRateLock`（订单级锁汇：orderId+currency+rate）—— 解决「这笔生意按什么汇率算成本/利润」。
 *   · `FxSettlement`（每笔结汇水单：voucherId+foreignAmount+fxRate+bank）—— 解决「实际结了多少」。
 * 缺的是**与银行的远期合约**这一层 ⇒
 *   · **到期日没人管**（远期合约到期必须交割，逾期有展期成本/罚息）；
 *   · **合约汇率 vs 实际结汇汇率的损益算不出来** —— 而"锁汇率 + 算损益"正是远期结汇的意义。
 *
 * ── 口径（写下来防后人踩）──
 *   · 一笔**合约**可覆盖**多笔结汇水单**（分次交割）；一笔水单只能用一张合约（唯一键 `@@unique([contractId, settlementId])`）。
 *   · 合约的 `settledForeignAmount` / `status` 是**派生值**，由 `ForwardFxSettlementLink` 累计、在**同一事务**内维护（与 C3 的 shipmentQuantity 快照同思路）。
 *   · ⚠️ **不往 `FxRateLock` 塞银行字段**：`FxRateLock` 是**订单侧的内部定价锚**，远期合约是**外部金融合约**，语义不同，混在一个模型里必然漂移。
 *
 * ── 损益口径 ──
 *   本次损益(CNY) = (实际结汇汇率 − 合约汇率) × 本次交割外币金额。正 = 比合约汇率更划算（赚）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { localDateKey } from '../shared/localDate';

// ────────────────────────────────────────────────────────────────
// 真源（纯函数，可单测）
// ────────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'object' ? Number(String(v)) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export type ForwardFxStatus = 'Open' | 'PartiallySettled' | 'Settled' | 'Cancelled';

export const FORWARD_FX_STATUSES: ForwardFxStatus[] = ['Open', 'PartiallySettled', 'Settled', 'Cancelled'];

export const FORWARD_FX_STATUS_LABELS: Record<string, string> = {
  Open: '未交割',
  PartiallySettled: '部分交割',
  Settled: '已交割',
  Cancelled: '已取消',
};

/** 剩余可交割外币金额（不会为负 —— 超额交割在创建时就被拒） */
export function forwardFxRemainingOf(foreignAmount: unknown, settledForeignAmount: unknown): number {
  const total = num(foreignAmount) ?? 0;
  const settled = num(settledForeignAmount) ?? 0;
  return round4(Math.max(0, total - settled));
}

/**
 * 合约状态（纯函数）。
 *   Cancelled 优先（终态）；已交割 ≥ 合约额 → Settled；部分 → PartiallySettled；否则 Open。
 */
export function forwardFxStatusOf(input: {
  foreignAmount: unknown;
  settledForeignAmount: unknown;
  cancelled?: boolean;
}): ForwardFxStatus {
  if (input.cancelled) return 'Cancelled';
  const total = num(input.foreignAmount) ?? 0;
  const settled = num(input.settledForeignAmount) ?? 0;
  if (total > 0 && settled >= total - 1e-9) return 'Settled';
  if (settled > 0) return 'PartiallySettled';
  return 'Open';
}

/**
 * 本次交割的损益（CNY）：(实际汇率 − 合约汇率) × 本次外币金额。正 = 比合约划算。
 * 入参非法 → null（**不猜**）。
 */
export function forwardFxPnlCnyOf(input: {
  contractRate: unknown;
  actualRate: unknown;
  foreignAmount: unknown;
}): number | null {
  const cr = num(input.contractRate);
  const ar = num(input.actualRate);
  const amt = num(input.foreignAmount);
  if (cr == null || ar == null || amt == null || amt <= 0) return null;
  return round4((ar - cr) * amt);
}

/** 距到期天数（负 = 已逾期）。日期非法 → null。 */
export function daysToMaturityOf(maturityDate: unknown, today: string = localDateKey(businessNowDate())): number | null {
  const d = String(maturityDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const ms = Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 86_400_000);
}

// ────────────────────────────────────────────────────────────────
// 落库
// ────────────────────────────────────────────────────────────────

export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, error: { code, message, status } });

const isYmd = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

export interface CreateForwardFxInput {
  contractNumber: string;
  bankRelationId?: string | null;
  bankName?: string | null;
  currency: string;
  foreignAmount: number | string;
  contractRate: number | string;
  signedDate: string;
  maturityDate: string;
  notes?: string | null;
}

/** 登记一张远期合约（唯一合约号；币种与金额/汇率有基本校验；到期日不得早于签约日） */
export async function createForwardFxContract(
  prisma: PrismaClient,
  input: CreateForwardFxInput,
  actorId: string,
): Promise<Result<{ contract: any }>> {
  const contractNumber = String(input?.contractNumber ?? '').trim();
  if (!contractNumber) return fail('INVALID_INPUT', 'contractNumber（银行合约号）必填（对账口径）');
  const currency = String(input?.currency ?? '').trim().toUpperCase();
  if (!currency) return fail('INVALID_INPUT', 'currency 必填');
  const amount = num(input?.foreignAmount);
  if (amount == null || amount <= 0) return fail('INVALID_AMOUNT', 'foreignAmount（合约外币金额）必须为正数');
  const rate = num(input?.contractRate);
  if (rate == null || rate <= 0) return fail('INVALID_AMOUNT', 'contractRate（约定汇率）必须为正数');
  if (!isYmd(input?.signedDate) || !isYmd(input?.maturityDate)) {
    return fail('INVALID_DATE', 'signedDate / maturityDate 格式须为 YYYY-MM-DD');
  }
  if (String(input.maturityDate).trim() < String(input.signedDate).trim()) {
    return fail('INVALID_DATE', 'maturityDate（到期交割日）不得早于 signedDate（签约日）');
  }

  const db: any = prisma as any;
  const dup = await db.forwardFxContract.findFirst({ where: { contractNumber }, select: { id: true } }).catch(() => null);
  if (dup) return fail('DUPLICATE_CONTRACT', `合约号 ${contractNumber} 已存在（银行合约号用于对账，不可重复）`, 409);

  const now = BigInt(Date.now());
  try {
    const contract = await db.$transaction(async (tx: any) => {
      const row = await tx.forwardFxContract.create({
        data: {
          id: `FFX__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          contractNumber,
          bankRelationId: (input.bankRelationId ?? '').trim() || null,
          bankName: input.bankName ?? null,
          currency,
          foreignAmount: new Prisma.Decimal(amount),
          contractRate: new Prisma.Decimal(rate),
          signedDate: String(input.signedDate).trim(),
          maturityDate: String(input.maturityDate).trim(),
          settledForeignAmount: new Prisma.Decimal(0),
          status: 'Open',
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
        },
      });
      await writeRouteAuditLog({
        prisma: tx, actorId, source: 'route:finance:forward_fx', operation: 'create_forward_fx_contract',
        targetType: 'ForwardFxContract', targetId: row.id,
        after: { contractNumber, currency, foreignAmount: String(amount), contractRate: String(rate), maturityDate: row.maturityDate },
      });
      return row;
    });
    return ok({ contract });
  } catch (e: any) {
    return fail('CREATE_FAILED', e?.message ?? '远期合约登记失败', 500);
  }
}

export interface SettleForwardFxInput {
  contractId: string;
  settlementId: string;
  foreignAmount: number | string;
  settleDate?: string;
}

/**
 * 用远期合约交割一笔结汇水单（分次交割）。
 *
 * 校验（顺序即优先级）：合约存在且未取消 → 水单存在 → **币种一致** → 金额为正 →
 * 该水单未挂过其它合约 → 本次金额 ≤ 合约剩余 → 本次金额 ≤ 水单剩余（该水单已挂合约的累计）。
 * 损益同时落库到 link（`actualRate` 取水单的 `fxRate`）⇒ 事后可查"这张合约赚/亏了多少"。
 */
export async function settleForwardFx(
  prisma: PrismaClient,
  input: SettleForwardFxInput,
  actorId: string,
): Promise<Result<{ link: any; pnlCny: number | null; contract: any }>> {
  const contractId = String(input?.contractId ?? '').trim();
  const settlementId = String(input?.settlementId ?? '').trim();
  if (!contractId || !settlementId) return fail('INVALID_INPUT', 'contractId 与 settlementId 必填');
  const amount = num(input?.foreignAmount);
  if (amount == null || amount <= 0) return fail('INVALID_AMOUNT', 'foreignAmount（本次交割外币金额）必须为正数');
  const settleDate = input?.settleDate && isYmd(input.settleDate) ? String(input.settleDate).trim() : localDateKey(businessNowDate());

  const db: any = prisma as any;
  try {
    const out = await db.$transaction(async (tx: any) => {
      const contract = await tx.forwardFxContract.findFirst({ where: { id: contractId, deletedAt: null } });
      if (!contract) throw Object.assign(new Error('远期合约不存在'), { code: 'CONTRACT_NOT_FOUND', statusCode: 404 });
      if (contract.status === 'Cancelled') {
        throw Object.assign(new Error('该合约已取消，不可再交割'), { code: 'CONTRACT_CANCELLED', statusCode: 409 });
      }
      const settlement = await tx.fxSettlement.findFirst({ where: { id: settlementId, deletedAt: null } });
      if (!settlement) throw Object.assign(new Error('结汇水单不存在'), { code: 'SETTLEMENT_NOT_FOUND', statusCode: 404 });
      const sCur = String(settlement.currency ?? '').trim().toUpperCase();
      if (sCur !== String(contract.currency).trim().toUpperCase()) {
        throw Object.assign(new Error(`币种不一致：合约 ${contract.currency} vs 结汇水单 ${settlement.currency}`), { code: 'CURRENCY_MISMATCH', statusCode: 400 });
      }
      const existingLinks = await tx.forwardFxSettlementLink.findMany({
        where: { contractId, deletedAt: null },
        select: { id: true },
      });
      const otherContractLinks = await tx.forwardFxSettlementLink.findMany({
        where: { settlementId, deletedAt: null, contractId: { not: contractId } },
        select: { foreignAmount: true },
      });
      if (otherContractLinks.length > 0) {
        throw Object.assign(new Error('该结汇水单已挂其它远期合约（一笔水单只能用一张合约）'), { code: 'SETTLEMENT_ALREADY_LINKED', statusCode: 409 });
      }
      const alreadyLinked = await tx.forwardFxSettlementLink.findFirst({
        where: { contractId, settlementId, deletedAt: null },
        select: { id: true },
      });
      if (alreadyLinked) {
        throw Object.assign(new Error('该结汇水单已用本合约交割过（同一水单不可重复挂同一合约）'), { code: 'LINK_ALREADY_EXISTS', statusCode: 409 });
      }

      // 本次金额 ≤ 合约剩余
      const remaining = forwardFxRemainingOf(contract.foreignAmount, contract.settledForeignAmount);
      if (amount > remaining + 1e-9) {
        throw Object.assign(new Error(`本次交割 ${amount} 超过合约剩余可交割 ${remaining}`), { code: 'OVER_CONTRACT', statusCode: 409 });
      }
      // 本次金额 ≤ 水单剩余（水单金额 − 已用本合约交割的累计
      const usedOnThisSettlement = await tx.forwardFxSettlementLink
        .findMany({ where: { settlementId, deletedAt: null }, select: { foreignAmount: true } })
        .catch(() => [] as any[]);
      const used = (usedOnThisSettlement as any[]).reduce((s, l) => s + (num(l?.foreignAmount) ?? 0), 0);
      const settlementRemain = round4((num(settlement.foreignAmount) ?? 0) - used);
      if (amount > settlementRemain + 1e-9) {
        throw Object.assign(new Error(`本次交割 ${amount} 超过该结汇水单剩余 ${settlementRemain}`), { code: 'OVER_SETTLEMENT', statusCode: 409 });
      }

      const link = await tx.forwardFxSettlementLink.create({
        data: {
          id: `FFSL__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          contractId,
          settlementId,
          foreignAmount: new Prisma.Decimal(amount),
          actualRate: new Prisma.Decimal(num(settlement.fxRate) ?? 0),
          settleDate,
          operatorId: actorId || null,
          createdAt: BigInt(Date.now()),
        },
      });

      const newSettled = round4((num(contract.settledForeignAmount) ?? 0) + amount);
      const updated = await tx.forwardFxContract.update({
        where: { id: contractId },
        data: {
          settledForeignAmount: new Prisma.Decimal(newSettled),
          status: forwardFxStatusOf({ foreignAmount: contract.foreignAmount, settledForeignAmount: newSettled }),
          updatedAt: BigInt(Date.now()),
        },
      });

      await writeRouteAuditLog({
        prisma: tx, actorId, source: 'route:finance:forward_fx', operation: 'settle_forward_fx',
        targetType: 'ForwardFxContract', targetId: contractId,
        before: { settledForeignAmount: String(contract.settledForeignAmount), status: contract.status },
        after: { settledForeignAmount: String(newSettled), status: updated.status, settlementId, amount: String(amount) },
      });

      return { link, contract: updated };
    });

    const pnlCny = forwardFxPnlCnyOf({
      contractRate: out.contract.contractRate,
      actualRate: out.link.actualRate,
      foreignAmount: out.link.foreignAmount,
    });
    return ok({ link: out.link, pnlCny, contract: out.contract });
  } catch (e: any) {
    return fail(e?.code ?? 'SETTLE_FAILED', e?.message ?? '远期交割失败', e?.statusCode ?? 400);
  }
}

export interface ForwardFxViewRow {
  id: string;
  contractNumber: string;
  bankName: string | null;
  currency: string;
  foreignAmount: number;
  contractRate: number;
  settledForeignAmount: number;
  remainingForeignAmount: number;
  status: string;
  statusLabel: string;
  signedDate: string;
  maturityDate: string;
  daysToMaturity: number | null;
  /** 已实现损益合计（CNY）—— 由各次交割的 (实际汇率 − 合约汇率) × 金额 汇总
   *  币种不同则无法相加 ⇒ 这里只在同一外币币种下有意义；CNY 金额可跨合约汇总。 */
  realizedPnlCny: number;
}

/** 远期合约一览（含到期天数与已实现损益） */
export async function listForwardFxContracts(
  prisma: PrismaClient,
  params: { currency?: string; includeCancelled?: boolean } = {},
): Promise<Result<{ rows: ForwardFxViewRow[] }>> {
  const db: any = prisma as any;
  try {
    const where: any = { deletedAt: null };
    if (params.currency) where.currency = String(params.currency).trim().toUpperCase();
    if (!params.includeCancelled) where.status = { not: 'Cancelled' };

    const contracts: any[] = await db.forwardFxContract.findMany({
      where,
      orderBy: [{ maturityDate: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true, contractNumber: true, bankName: true, currency: true, foreignAmount: true,
        contractRate: true, settledForeignAmount: true, status: true, signedDate: true, maturityDate: true,
      },
    }).catch(() => []);
    if (contracts.length === 0) return ok({ rows: [] });

    const ids = contracts.map(c => c.id);
    const links: any[] = await db.forwardFxSettlementLink.findMany({
      where: { contractId: { in: ids }, deletedAt: null },
      select: { contractId: true, foreignAmount: true, actualRate: true },
    }).catch(() => []);
    const pnlByContract = new Map<string, number>();
    for (const l of links) {
      const c = contracts.find(x => x.id === l.contractId);
      const pnl = forwardFxPnlCnyOf({
        contractRate: c?.contractRate,
        actualRate: l.actualRate,
        foreignAmount: l.foreignAmount,
      });
      pnlByContract.set(l.contractId, round4((pnlByContract.get(l.contractId) ?? 0) + (pnl ?? 0)));
    }

    const rows: ForwardFxViewRow[] = contracts.map(c => ({
      id: c.id,
      contractNumber: c.contractNumber,
      bankName: c.bankName ?? null,
      currency: String(c.currency).trim().toUpperCase(),
      foreignAmount: round4(num(c.foreignAmount) ?? 0),
      contractRate: Number(c.contractRate),
      settledForeignAmount: round4(num(c.settledForeignAmount) ?? 0),
      remainingForeignAmount: forwardFxRemainingOf(c.foreignAmount, c.settledForeignAmount),
      status: c.status,
      statusLabel: FORWARD_FX_STATUS_LABELS[c.status] ?? c.status,
      signedDate: c.signedDate,
      maturityDate: c.maturityDate,
      daysToMaturity: daysToMaturityOf(c.maturityDate),
      realizedPnlCny: pnlByContract.get(c.id) ?? 0,
    }));
    return ok({ rows });
  } catch (e: any) {
    return fail('LIST_FAILED', e?.message ?? '远期合约查询失败', 500);
  }
}
