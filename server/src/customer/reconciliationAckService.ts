/**
 * reconciliationAckService.ts — H16-② 客户对账确认回执（对账函回签的电子化）
 *
 * 行业口径：企业与客户定期（通常按月）核对往来余额，客户确认（盖章回传）后双方账目锁定。
 * 电子化 = 客户在门户看到对账单 → 点「确认无异议」或「有异议（附说明）」。
 *
 * 口径（业务方授权按专业判断，2026-09-16）：
 *   1. **按期间**（月度对账函），不是逐张发票确认 —— 与客户财务的对账习惯一致。
 *   2. 确认后**记录 + 通知内部**，但**不锁定数据**（对账后仍可能有新业务；锁定会卡死开票）。
 *   3. **不做回执 PDF**（结构化记录已足够，避免过度建设）。
 *   4. 快照按**币种分组**（跨币种不合并 —— T7-① 口径）；金额口径与客户门户一致
 *      （客户看的是「我开了多少票 / 我付了多少钱」）。
 *
 * 纯只读的对账单计算 + 单条回执写入；不触发任何单据状态变更。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, error: { code, message, status } });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dec = (v: unknown): Prisma.Decimal => {
  if (v === null || v === undefined) return new Prisma.Decimal(0);
  try { return new Prisma.Decimal(v as any); } catch { return new Prisma.Decimal(0); }
};
const d2n = (d: Prisma.Decimal) => Number(d.toFixed(4));

/** 按币种分组的对账行（跨币种不合并） */
export interface StatementCurrencyRow {
  currency: string;
  openingBalance: number;   // 期初应收余额（截至 periodStart 前一天）
  invoiced: number;         // 本期开票
  received: number;         // 本期收款
  closingBalance: number;   // 期末应收余额 = 期初 + 本期开票 − 本期收款
}

export interface PeriodStatement {
  customerRelationId: string;
  periodStart: string;
  periodEnd: string;
  byCurrency: StatementCurrencyRow[];
  /** 该期间是否已有回执（有则前端显示回执状态，不再重复提交） */
  existingAck: { id: string; status: string; createdAt: number } | null;
}

/** 累计开票 / 收款（按币种），截止日可选（< = 不含该日） */
async function aggregate(
  db: any,
  relationId: string,
  opts: { untilExclusive?: string; fromInclusive?: string; toInclusive?: string },
): Promise<{ invoiced: Map<string, Prisma.Decimal>; received: Map<string, Prisma.Decimal> }> {
  const invWhere: any = { customerRelationId: relationId, type: 'Receivable', status: { not: 'Cancelled' }, deletedAt: null };
  const payWhere: any = { customerRelationId: relationId, type: 'Receipt', deletedAt: null };
  if (opts.untilExclusive) {
    invWhere.issueDate = { lt: opts.untilExclusive };
    payWhere.paymentDate = { lt: opts.untilExclusive };
  } else if (opts.fromInclusive && opts.toInclusive) {
    invWhere.issueDate = { gte: opts.fromInclusive, lte: opts.toInclusive };
    payWhere.paymentDate = { gte: opts.fromInclusive, lte: opts.toInclusive };
  }

  const [invoices, vouchers] = await Promise.all([
    db.invoice.findMany({ where: invWhere, select: { amount: true, currency: true } }),
    db.paymentVoucher.findMany({ where: payWhere, select: { amount: true, currency: true } }),
  ]);

  const invoiced = new Map<string, Prisma.Decimal>();
  for (const i of invoices) {
    const cur = String(i.currency ?? '').trim() || 'CNY';
    invoiced.set(cur, (invoiced.get(cur) ?? new Prisma.Decimal(0)).plus(dec(i.amount)));
  }
  const received = new Map<string, Prisma.Decimal>();
  for (const v of vouchers) {
    const cur = String(v.currency ?? '').trim() || 'CNY';
    received.set(cur, (received.get(cur) ?? new Prisma.Decimal(0)).plus(dec(v.amount)));
  }
  return { invoiced, received };
}

export function createCustomerReconciliationAckService(prisma: PrismaClient) {
  const db = prisma as any;

  /** 计算某期间的对账单（纯只读） */
  async function computePeriodStatement(
    relationId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<Result<PeriodStatement>> {
    if (!DATE_RE.test(periodStart) || !DATE_RE.test(periodEnd)) {
      return fail('INVALID_PERIOD', '期间格式应为 YYYY-MM-DD');
    }
    if (periodStart > periodEnd) return fail('INVALID_PERIOD', '期间起始不得晚于结束');

    const [opening, current] = await Promise.all([
      aggregate(db, relationId, { untilExclusive: periodStart }),
      aggregate(db, relationId, { fromInclusive: periodStart, toInclusive: periodEnd }),
    ]);

    const currencies = [...new Set([
      ...opening.invoiced.keys(), ...opening.received.keys(),
      ...current.invoiced.keys(), ...current.received.keys(),
    ])].sort((a, b) => a.localeCompare(b));

    const byCurrency: StatementCurrencyRow[] = currencies.map(cur => {
      const openInv = opening.invoiced.get(cur) ?? new Prisma.Decimal(0);
      const openRec = opening.received.get(cur) ?? new Prisma.Decimal(0);
      const curInv = current.invoiced.get(cur) ?? new Prisma.Decimal(0);
      const curRec = current.received.get(cur) ?? new Prisma.Decimal(0);
      const openingBalance = openInv.minus(openRec);
      const closingBalance = openingBalance.plus(curInv).minus(curRec);
      return {
        currency: cur,
        openingBalance: d2n(openingBalance),
        invoiced: d2n(curInv),
        received: d2n(curRec),
        closingBalance: d2n(closingBalance),
      };
    });

    const existing = await db.customerReconciliationAck.findFirst({
      where: { customerRelationId: relationId, periodStart, periodEnd, deletedAt: null },
      select: { id: true, status: true, createdAt: true },
    }).catch(() => null);

    return ok({
      customerRelationId: relationId,
      periodStart,
      periodEnd,
      byCurrency,
      existingAck: existing ? { id: existing.id, status: existing.status, createdAt: Number(existing.createdAt) } : null,
    });
  }

  /**
   * 提交回执（确认无异议 / 有异议）。
   * 幂等与防反复：**同一期间只允许一条未删除回执**（已存在 → 409，提示联系业务员）。
   * 快照在提交时**重新计算并冻结**（回执代表客户在那一刻确认的数字）。
   */
  async function submitAck(params: {
    relationId: string;
    customerUserId?: string | null;
    customerUserName?: string | null;
    periodStart: string;
    periodEnd: string;
    decision: string;
    disputeNote?: string | null;
    ip?: string | null;
  }): Promise<Result<any>> {
    const decision = String(params.decision ?? '').trim();
    if (decision !== 'confirmed' && decision !== 'disputed') {
      return fail('INVALID_DECISION', `decision 必须是 confirmed | disputed，收到 ${String(params.decision)}`);
    }
    const disputeNote = String(params.disputeNote ?? '').trim();
    if (decision === 'disputed' && !disputeNote) {
      return fail('DISPUTE_NOTE_REQUIRED', '提交异议时必须填写异议说明（便于内部核查）');
    }

    const stmt = await computePeriodStatement(params.relationId, params.periodStart, params.periodEnd);
    if (!stmt.ok) return stmt;
    if (stmt.data.existingAck) {
      return fail('ACK_ALREADY_EXISTS',
        `该期间已有回执（${stmt.data.existingAck.status === 'confirmed' ? '已确认' : '有异议'}），如需变更请联系业务员`, 409);
    }

    try {
      const now = BigInt(Date.now());
      const row = await db.customerReconciliationAck.create({
        data: {
          id: `CRA__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          customerRelationId: params.relationId,
          customerUserId: params.customerUserId ?? null,
          customerUserName: params.customerUserName ?? null,
          periodStart: params.periodStart,
          periodEnd: params.periodEnd,
          status: decision,
          // 冻结快照（客户确认的就是这些数字）
          snapshot: {
            byCurrency: stmt.data.byCurrency,
            capturedAt: new Date().toISOString(),
          } as any,
          disputeNote: decision === 'disputed' ? disputeNote : null,
          ip: params.ip ?? null,
          createdAt: now,
          updatedAt: now,
        },
      });

      // 通知内部（best-effort：通知失败不阻断回执落库 —— 回执本身是客户的凭证）。
      // 落库结构与 notificationService 内部一致（单租户：所有 active 用户都收到）。
      try {
        const users = await db.userAccount.findMany({ where: { status: 'active' }, select: { id: true } });
        if (users.length > 0) {
          await db.notification.createMany({
            data: users.map((u: any) => ({
              id: `ntf_cra_${row.id}_${u.id}`,
              userId: u.id,
              type: 'customer_reconciliation_ack',
              title: decision === 'confirmed'
                ? `客户已确认对账单（${params.periodStart} ~ ${params.periodEnd}）`
                : `客户对账单提出异议（${params.periodStart} ~ ${params.periodEnd}）`,
              body: decision === 'confirmed'
                ? `${params.customerUserName ?? params.relationId} 确认无异议`
                : `${params.customerUserName ?? params.relationId}：${disputeNote}`,
              level: decision === 'confirmed' ? 'info' : 'warning',
              link: null,
              metadata: { ackId: row.id, periodStart: params.periodStart, periodEnd: params.periodEnd, decision } as any,
            })),
            skipDuplicates: true,
          });
        }
      } catch (e: any) {
        logger.warn('[CustomerReconAck] notify failed (non-blocking)', { error: e?.message });
      }

      return ok({ ack: row });
    } catch (e: any) {
      logger.error('[CustomerReconAck] submit failed', { error: e?.message, relationId: params.relationId });
      return fail('SUBMIT_FAILED', String(e?.message ?? e), 500);
    }
  }

  /** 某客户的历史回执（倒序） */
  async function listAcks(relationId: string, limit = 24): Promise<Result<any>> {
    const rows = await db.customerReconciliationAck.findMany({
      where: { customerRelationId: relationId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
    return ok({ acks: rows });
  }

  return { computePeriodStatement, submitAck, listAcks };
}

// ─────────────────────────────────────────────────────────────────────────
// 内部侧：跨客户回执列表（H16-② 的配套 —— 客户能回签，内部必须看得到）
// ─────────────────────────────────────────────────────────────────────────

export interface ReconciliationAckListItem {
  id: string;
  customerRelationId: string;
  /** 客户名（由 Relation 补；Relation 缺失/改名时回退 null，不阻断列表） */
  customerName: string | null;
  customerUserName: string | null;
  periodStart: string;
  periodEnd: string;
  status: string;
  disputeNote: string | null;
  /** 客户确认时的冻结快照（按币种分组）—— 财务要能核对「他到底确认了哪些数字」 */
  snapshot: unknown;
  ip: string | null;
  createdAt: number;
}

/**
 * 内部侧回执列表（跨客户，只读）。
 *
 * 与门户侧 `listAcks(relationId)` 的区别：**不强制绑客户**（财务要看「哪些客户回签了」），
 * 并补出客户名 + 状态汇总。
 *
 * 口径：
 *   - 期间筛选用**区间相交**（`periodStart <= periodTo ∧ periodEnd >= periodFrom`），
 *     不是严格包含 —— 财务按「9 月」筛时，跨月对账单也应命中。
 *   - `summary` 统计**同一基础筛选（客户/期间）下**的 confirmed / disputed 两数，
 *     **不受 `status` 筛选影响** —— 否则一旦按 disputed 筛，confirmed 数就恒为 0，失去对照意义。
 *   - 排序 `createdAt desc`（最新回签在前）。
 */
export async function listReconciliationAcks(prisma: PrismaClient, params: {
  relationId?: string;
  status?: string;
  periodFrom?: string;
  periodTo?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<Result<{
  items: ReconciliationAckListItem[];
  total: number;
  page: number;
  pageSize: number;
  summary: { confirmed: number; disputed: number; total: number };
}>> {
  const db = prisma as any;

  const status = String(params.status ?? '').trim();
  if (status && status !== 'confirmed' && status !== 'disputed') {
    return fail('INVALID_STATUS', `status 必须是 confirmed | disputed，收到 ${status}`);
  }
  const periodFrom = String(params.periodFrom ?? '').trim();
  const periodTo = String(params.periodTo ?? '').trim();
  if (periodFrom && !DATE_RE.test(periodFrom)) return fail('INVALID_PERIOD', `periodFrom 需为 YYYY-MM-DD，收到 ${periodFrom}`);
  if (periodTo && !DATE_RE.test(periodTo)) return fail('INVALID_PERIOD', `periodTo 需为 YYYY-MM-DD，收到 ${periodTo}`);
  if (periodFrom && periodTo && periodFrom > periodTo) return fail('INVALID_PERIOD', `periodFrom(${periodFrom}) 不能晚于 periodTo(${periodTo})`);

  const limit = Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 200);
  const pageSize = limit;
  const page = Math.max(Math.floor((Number(params.offset ?? 0) || 0) / pageSize) + 1, 1);

  // 基础筛选（不含 status）—— summary 与 total 都基于它
  const baseWhere: any = { deletedAt: null };
  if (params.relationId) baseWhere.customerRelationId = String(params.relationId);
  if (periodFrom || periodTo) {
    baseWhere.AND = [];
    if (periodTo) baseWhere.AND.push({ periodStart: { lte: periodTo } });
    if (periodFrom) baseWhere.AND.push({ periodEnd: { gte: periodFrom } });
  }
  const where: any = status ? { ...baseWhere, status } : baseWhere;

  const [rows, total, confirmedCount, disputedCount] = await Promise.all([
    db.customerReconciliationAck.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: Math.max(Number(params.offset ?? 0) || 0, 0),
      take: pageSize,
    }),
    db.customerReconciliationAck.count({ where }),
    db.customerReconciliationAck.count({ where: { ...baseWhere, status: 'confirmed' } }),
    db.customerReconciliationAck.count({ where: { ...baseWhere, status: 'disputed' } }),
  ]);

  // 客户名批量补（一次查询，避免 N+1；Relation 缺失不阻断）
  const relationIds = [...new Set((rows as any[]).map(r => String(r.customerRelationId)).filter(Boolean))];
  const nameMap = new Map<string, string>();
  if (relationIds.length > 0) {
    try {
      const rels = await db.relation.findMany({ where: { id: { in: relationIds } }, select: { id: true, name: true } });
      for (const r of rels ?? []) nameMap.set(String(r.id), String(r.name ?? ''));
    } catch { /* Relation 不可用时不阻断列表 */ }
  }

  const items: ReconciliationAckListItem[] = (rows as any[]).map(r => ({
    id: String(r.id),
    customerRelationId: String(r.customerRelationId),
    customerName: nameMap.get(String(r.customerRelationId)) ?? null,
    customerUserName: r.customerUserName ?? null,
    periodStart: String(r.periodStart),
    periodEnd: String(r.periodEnd),
    status: String(r.status),
    disputeNote: r.disputeNote ?? null,
    snapshot: r.snapshot ?? null,
    ip: r.ip ?? null,
    createdAt: Number(r.createdAt ?? 0),
  }));

  return ok({
    items,
    total: Number(total ?? 0),
    page,
    pageSize,
    summary: {
      confirmed: Number(confirmedCount ?? 0),
      disputed: Number(disputedCount ?? 0),
      total: Number(confirmedCount ?? 0) + Number(disputedCount ?? 0),
    },
  });
}
