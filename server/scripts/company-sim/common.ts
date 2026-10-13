/**
 * company-sim/common.ts — 13 周公司数据模拟共享工具
 *
 * 公司设定：竹衍服饰（PandaClothing）女装出口商
 * 时间线：13 周 = 2026-06-08（周一）~ 2026-08-30（今天）
 * ID 约定：所有确定性 ID / 单据编号统一 SIM- 前缀（与发号器区间避让）
 */

import { PrismaClient } from '@prisma/client';

// ─── 时间基线（UTC 构造，确定性不受运行时区影响） ───
export const W1_START = Date.UTC(2026, 5, 8); // 2026-06-08 周一
export const WEEK_MS = 7 * 24 * 3600 * 1000;
export const DAY_MS = 24 * 3600 * 1000;
export const SIM_END = Date.UTC(2026, 7, 30); // 2026-08-30

/** 第 w 周（1-based）周一起的偏移毫秒；dayOfWeek 1=周一 … 7=周日 */
export function weekStart(w: number): number {
  return W1_START + (w - 1) * WEEK_MS;
}
/** 第 w 周第 d 天（1=周一）的某时刻（h 点 m 分，业务工作时间） */
export function at(w: number, d: number, h = 10, m = 0): number {
  return weekStart(w) + (d - 1) * DAY_MS + h * 3600 * 1000 + m * 60 * 1000;
}
/** epoch ms → 'YYYY-MM-DD'（UTC 口径） */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
/** epoch ms → 'YYYY-MM-DD HH:mm:ss'（Email.sentAt 口径） */
export function isoDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// ─── 确定性伪随机（mulberry32，种子固定保证可重放） ───
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rng = mulberry32(20260608);
export function pick<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
export function randInt(min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

// ─── Delivered 单收款时序分流（2026-09-02 拍板，orders/fabric-orders/audit/crm-dev 四处消费） ───
// 业务口径：提前出运合法（status=Delivered 保留），但交期在未来的单交易周期未完，
// 货款不能全额结清——「交期未到、账期未开、货款全清」是时序悖论（日历页实机发现）。
// 锚点固定 2026-09-03（> seed 时间锚 2026-08-30），保证确定性重放，不用运行时 Date.now()。
export const FUTURE_DUE_CUTOFF_MS = Date.UTC(2026, 8, 3); // 2026-09-03

export interface DeliveredFinance {
  kind: 'paid' | 'deposit' | 'issued' | 'overdue';
  paidRatio: number; // 已收比例：1 / 0.3 / 0 / 0.5
  invoiceStatus: 'Paid' | 'PartiallyPaid' | 'Issued';
  voucherStatus: 'reconciled' | 'partially_reconciled' | null;
  settleStatus: 'settled' | 'partially_settled' | 'unsettled';
}

/**
 * Delivered 单收款分流（唯一真源）：
 * - overdue  逾期剧情单：半款 50% + Dunning 挂账（账期口径已过，与交期无关，保留原剧情）
 * - paid     交期已过（< 2026-09-03）：全额结清
 * - deposit  交期在未来：30% 定金在途，尾款 70% 占用信用额度
 * - issued   交期在未来（idx%3===1，约 1/3）：零收款开票待付
 */
export function deliveredFinance(p: { fate: string; overdue?: boolean; dueMs?: number; idx: number }): DeliveredFinance {
  if (p.fate !== 'Delivered') throw new Error(`deliveredFinance 仅用于 Delivered 单（fate=${p.fate}, idx=${p.idx}）`);
  if (p.overdue) {
    return { kind: 'overdue', paidRatio: 0.5, invoiceStatus: 'PartiallyPaid', voucherStatus: 'partially_reconciled', settleStatus: 'partially_settled' };
  }
  if ((p.dueMs ?? 0) < FUTURE_DUE_CUTOFF_MS) {
    return { kind: 'paid', paidRatio: 1, invoiceStatus: 'Paid', voucherStatus: 'reconciled', settleStatus: 'settled' };
  }
  return p.idx % 3 === 1
    ? { kind: 'issued', paidRatio: 0, invoiceStatus: 'Issued', voucherStatus: null, settleStatus: 'unsettled' }
    : { kind: 'deposit', paidRatio: 0.3, invoiceStatus: 'PartiallyPaid', voucherStatus: 'partially_reconciled', settleStatus: 'partially_settled' };
}

// ─── 汇率快照常量（2026-09-02 修复：原硬编码 7.16 与系统 ExchangeRate 行情偏差 6%）───
// 真源对齐：ExchangeRate 行情 2026-08 USD 6.7369~6.7371 / EUR 7.80-7.84。
// USD 取 6.74（行情四舍五入）；EUR 7.82 原已吻合不动。发票/凭证汇率快照、
// 面料 FOB 折价（CNY→USD）全 seed 统一消费本常量，保证发票与凭证汇率一致。
export const USD_CNY_RATE = 6.74;
export const EUR_CNY_RATE = 7.82;

// ─── 金额工具 ───
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── 内部人员（AuditLog actor / ownerId，全部为库内既有账号 + SIM 补充跟单） ───
export const USERS = {
  boss: 'usr_demo_boss', // Jason Shen — 总经理
  gm: 'usr_demo_gm', // Raymond Lin — 审批/分管副总
  salesManager: 'usr_demo_sales_manager', // Vivian Chen — 销售主管
  salesA: 'usr_demo_sales_a', // Chloe Su — 业务员
  salesB: 'usr_demo_sales_b', // Marcus Zhou — 业务员
  financeManager: 'usr_demo_finance_manager', // Melissa Zhao — 财务经理
  finance: 'usr_demo_finance', // Charlie Qian — 会计
  qc: 'usr_demo_qc', // Wilson Wu — QC 主管
  logistics: 'usr_demo_logistics', // Hank Zheng — 物流主管
} as const;

/** SIM 补充账号（EmployeeProfile 挂载用，seed 幂等 upsert，不改动既有账号） */
export const SIM_EXTRA_ACCOUNTS = [
  { id: 'SIM-usr-merch-1', displayName: 'Grace Liu', email: 'grace.liu@pandaclothing.local' },
  { id: 'SIM-usr-merch-2', displayName: 'Tony Fang', email: 'tony.fang@pandaclothing.local' },
  { id: 'SIM-usr-merch-3', displayName: 'Ivy Zhang', email: 'ivy.zhang@pandaclothing.local' },
] as const;

export const SALES_POOL = [USERS.salesManager, USERS.salesA, USERS.salesB] as const;
export const SALES_NAME: Record<string, string> = {
  [USERS.salesManager]: 'Vivian Chen',
  [USERS.salesA]: 'Chloe Su',
  [USERS.salesB]: 'Marcus Zhou',
};

// ─── 通用 Prisma 生成器 ───
export function newPrisma(): PrismaClient {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient: PC } = require('@prisma/client');
  return new PC();
}

/** 统一批量建行 + 打印 */
export async function createManyLogged(
  prisma: PrismaClient,
  delegate: string,
  label: string,
  rows: unknown[],
): Promise<number> {
  if (!rows.length) return 0;
  const model = (prisma as any)[delegate];
  if (typeof model.createMany === 'function') {
    const r = await model.createMany({ data: rows, skipDuplicates: true });
    console.log(`  ${label}: ${r.count}`);
    return r.count;
  }
  // 无 createMany 的模型（如 PaymentVoucher 等带 unique 约束均可；兜底逐行）
  for (const row of rows) await model.create({ data: row });
  console.log(`  ${label}: ${rows.length}`);
  return rows.length;
}
