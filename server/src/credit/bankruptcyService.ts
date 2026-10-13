/**
 * bankruptcyService.ts — REQ2-15 客户破产货权处置（DR-055）
 *
 * 设计真源：docs/design/04-模块设计/05-财务与结算/客户破产货权处置.md
 *
 * DR-055 三决策：
 *   ① 案件 + 动作流双表：BankruptcyProceeding（processing→closed 状态机）+
 *      BankruptcyAction（append-only：declare/resale/return_shipment/bad_debt/recover/close）
 *   ② 发票/订单闭环靠 payload 快照引用 + 既有 void 通道，不双轨（P1-004 教训）
 *   ③ 开案即信用冻结（best-effort：无额度/已冻结静默——案件照开）；闭案不自动解冻（人工决策）
 *
 * 净损失 = 申报债权额 − 转卖回收 − 部分回款 + 退运成本
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { createCreditService } from './creditService';
import { todayLocalKey } from '../shared/localDate';


// ────────────────────────────────────────────────────────────────────
// 常量与校验
// ────────────────────────────────────────────────────────────────────

export const BANKRUPTCY_ACTION_TYPES = ['declare', 'resale', 'return_shipment', 'bad_debt', 'recover', 'close'] as const;
/** 处置期可追加的动作（declare/close 由专用端点触发） */
export const DISPOSAL_ACTION_TYPES = ['resale', 'return_shipment', 'bad_debt', 'recover'] as const;

export const BANKRUPTCY_ACTION_LABELS: Record<string, string> = {
  declare: '宣告破产', resale: '转卖处置', return_shipment: '退运', bad_debt: '坏账登记', recover: '部分回款', close: '闭案',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type BankruptcyResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): BankruptcyResult<never> => ({ ok: false, error: { code, message, status } });

function generateId(prefix: string): string {
  return `${prefix}__${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function assertAmount(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error('amount 必须为非负数'), { code: 'INVALID_AMOUNT' });
  }
  return n;
}

// ────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────

export function createBankruptcyService(prisma: PrismaClient) {
  const db = prisma as any;
  const creditSvc = createCreditService({ prisma });

  async function nextProceedingNumber(): Promise<string> {
    const prefix = `BKP-${todayLocalKey().replace(/-/g, '')}`;
    const count = await db.bankruptcyProceeding.count({ where: { proceedingNumber: { startsWith: prefix } } });
    return `${prefix}-${String(count + 1).padStart(3, '0')}`;
  }

  /** 动作金额汇总 → 损益（净损失 = 申报 − 回收 − 回款 + 退运成本） */
  function summarize(totalClaimed: number, actions: any[]) {
    const sumOf = (type: string) => actions
      .filter(a => a.actionType === type && a.deletedAt == null)
      .reduce((s, a) => s + Number(a.amount), 0);
    const resaleRecovered = sumOf('resale');
    const returnShippingCost = sumOf('return_shipment');
    const badDebt = sumOf('bad_debt');
    const recovered = sumOf('recover');
    const netLoss = Math.round((totalClaimed - resaleRecovered - recovered + returnShippingCost) * 10000) / 10000;
    return {
      totalClaimed, resaleRecovered, returnShippingCost, badDebt, recovered, netLoss,
      actionCount: actions.filter(a => a.deletedAt == null).length,
    };
  }

  // ── 开案（declare 首动作 + 自动信用冻结 best-effort DR-055-③） ──
  async function openProceeding(input: {
    relationId?: string; declaredAt?: string; totalClaimedAmount?: number; note?: string;
  }, actorId?: string): Promise<BankruptcyResult<any>> {
    try {
      const relationId = String(input.relationId ?? '').trim();
      if (!relationId) return fail('RELATION_REQUIRED', 'relationId 必填（破产客户）');
      const declaredAt = String(input.declaredAt ?? '').trim();
      if (!DATE_RE.test(declaredAt)) return fail('INVALID_DATE', 'declaredAt 必须为 YYYY-MM-DD（宣告日）');
      const totalClaimedAmount = assertAmount(input.totalClaimedAmount);

      const relation = await db.relation.findFirst({ where: { id: relationId, deletedAt: null } });
      if (!relation) return fail('RELATION_NOT_FOUND', `客户 ${relationId} 不存在`, 404);

      // 同客户唯一活跃案件（业务约束）
      const active = await db.bankruptcyProceeding.findFirst({
        where: { relationId, status: 'processing', deletedAt: null },
      });
      if (active) {
        return fail('ACTIVE_PROCEEDING_EXISTS', `客户已有进行中的破产案件（${active.proceedingNumber}），须先闭案`, 409);
      }

      const ts = Date.now();
      const proceeding = await db.bankruptcyProceeding.create({
        data: {
          id: generateId('BKP'),
          proceedingNumber: await nextProceedingNumber(),
          relationId, relationName: relation.name,
          status: 'processing',
          declaredAt, totalClaimedAmount,
          createdAt: BigInt(ts), updatedAt: BigInt(ts),
        },
      });

      // 首动作 declare（append-only 时间线起点）
      await db.bankruptcyAction.create({
        data: {
          id: generateId('BKA'), proceedingId: proceeding.id, actionType: 'declare',
          amount: 0,
          payload: { declaredAt, totalClaimedAmount, relationName: relation.name } as any,
          note: input.note?.trim() || null,
          actor: actorId ?? null, createdAt: BigInt(ts),
        },
      });

      // 信用冻结 best-effort（无额度/已冻结静默——案件照开不阻断；DR-055-③）
      let creditFrozen = false;
      try {
        const fr = await creditSvc.freezeCredit({
          relationId,
          reason: `客户破产开案自动冻结（${proceeding.proceedingNumber}）`,
          actorId: actorId ?? 'system',
        });
        creditFrozen = fr.ok;
      } catch {
        // best-effort 边界
      }

      logger.info('[Bankruptcy] proceeding opened', { id: proceeding.id, proceedingNumber: proceeding.proceedingNumber, relationId, creditFrozen });
      return { ok: true, data: { proceeding, creditFrozen } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message);
      logger.error('[Bankruptcy] open failed', { error: e?.message });
      return fail('OPEN_FAILED', e?.message || '开案失败', 500);
    }
  }

  // ── 追加处置动作（append-only；closed 案件 409） ──
  async function addAction(proceedingId: string, input: {
    actionType?: string; amount?: number; payload?: Record<string, unknown>; note?: string;
  }, actorId?: string): Promise<BankruptcyResult<any>> {
    try {
      const proceeding = await db.bankruptcyProceeding.findFirst({ where: { id: proceedingId, deletedAt: null } });
      if (!proceeding) return fail('PROCEEDING_NOT_FOUND', `破产案件 ${proceedingId} 不存在`, 404);
      if (proceeding.status !== 'processing') {
        return fail('PROCEEDING_CLOSED', `案件已闭案（${proceeding.proceedingNumber}），不可再追加处置动作`, 409);
      }

      const actionType = String(input.actionType ?? '').trim();
      if (!(DISPOSAL_ACTION_TYPES as readonly string[]).includes(actionType)) {
        return fail('INVALID_ACTION_TYPE', `actionType 须为 ${DISPOSAL_ACTION_TYPES.join(' | ')}`);
      }
      const amount = assertAmount(input.amount);

      const ts = Date.now();
      const action = await db.bankruptcyAction.create({
        data: {
          id: generateId('BKA'), proceedingId, actionType, amount,
          payload: (input.payload ?? null) as any,
          note: input.note?.trim() || null,
          actor: actorId ?? null, createdAt: BigInt(ts),
        },
      });

      // 追加后实时汇总（前端即时呈现）
      const actions = await db.bankruptcyAction.findMany({ where: { proceedingId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
      const summary = summarize(Number(proceeding.totalClaimedAmount), actions);
      logger.info('[Bankruptcy] action added', { proceedingId, actionType, amount });
      return { ok: true, data: { action, summary } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message);
      logger.error('[Bankruptcy] add action failed', { error: e?.message });
      return fail('ACTION_FAILED', e?.message || '动作登记失败', 500);
    }
  }

  // ── 闭案（终态：close 动作 + 汇总结论落 closeNote） ──
  async function closeProceeding(proceedingId: string, input: { note?: string }, actorId?: string): Promise<BankruptcyResult<any>> {
    try {
      const proceeding = await db.bankruptcyProceeding.findFirst({ where: { id: proceedingId, deletedAt: null } });
      if (!proceeding) return fail('PROCEEDING_NOT_FOUND', `破产案件 ${proceedingId} 不存在`, 404);
      if (proceeding.status !== 'processing') {
        return fail('PROCEEDING_CLOSED', `案件已闭案（${proceeding.proceedingNumber}）`, 409);
      }

      const ts = Date.now();
      const actions = await db.bankruptcyAction.findMany({ where: { proceedingId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
      const summary = summarize(Number(proceeding.totalClaimedAmount), actions);

      // 汇总结论（闭案快照落 closeNote——后续动作不可再追加，结论不失真）
      const conclusion = `申报 ¥${summary.totalClaimed} · 转卖回收 ¥${summary.resaleRecovered} · 退运成本 ¥${summary.returnShippingCost} · 坏账 ¥${summary.badDebt} · 回款 ¥${summary.recovered} · 净损失 ¥${summary.netLoss}`
        + (input.note?.trim() ? ` ｜ ${input.note.trim()}` : '');

      const updated = await db.bankruptcyProceeding.update({
        where: { id: proceedingId },
        data: { status: 'closed', closeNote: conclusion, closedAt: BigInt(ts), updatedAt: BigInt(ts) },
      });

      await db.bankruptcyAction.create({
        data: {
          id: generateId('BKA'), proceedingId, actionType: 'close', amount: 0,
          payload: { ...summary } as any,
          note: input.note?.trim() || null,
          actor: actorId ?? null, createdAt: BigInt(ts),
        },
      });

      logger.info('[Bankruptcy] proceeding closed', { proceedingId, netLoss: summary.netLoss });
      return { ok: true, data: { proceeding: updated, summary } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message);
      logger.error('[Bankruptcy] close failed', { error: e?.message });
      return fail('CLOSE_FAILED', e?.message || '闭案失败', 500);
    }
  }

  // ── 列表（含每案动作计数与金额汇总） ──
  async function listProceedings(params: { relationId?: string; status?: string; limit?: number }): Promise<BankruptcyResult<any>> {
    const where: any = { deletedAt: null };
    if (params.relationId) where.relationId = params.relationId;
    if (params.status) where.status = params.status;
    const proceedings = await db.bankruptcyProceeding.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(params.limit ?? 50, 1), 200),
    });
    const items = [];
    for (const p of proceedings) {
      const actions = await db.bankruptcyAction.findMany({ where: { proceedingId: p.id, deletedAt: null } });
      items.push({ ...p, summary: summarize(Number(p.totalClaimedAmount), actions) });
    }
    return { ok: true, data: { items } };
  }

  // ── 详情（案件 + 动作时间线 append-only 正序 + 损益汇总） ──
  async function getProceeding(proceedingId: string): Promise<BankruptcyResult<any>> {
    const proceeding = await db.bankruptcyProceeding.findFirst({ where: { id: proceedingId, deletedAt: null } });
    if (!proceeding) return fail('PROCEEDING_NOT_FOUND', `破产案件 ${proceedingId} 不存在`, 404);
    const actions = await db.bankruptcyAction.findMany({
      where: { proceedingId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ok: true,
      data: { proceeding, actions, summary: summarize(Number(proceeding.totalClaimedAmount), actions) },
    };
  }

  return { openProceeding, addAction, closeProceeding, listProceedings, getProceeding };
}
