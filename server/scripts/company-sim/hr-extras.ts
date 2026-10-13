/**
 * company-sim/hr-extras.ts — HR 薪资批次（PayrollRun/PayrollItem）+ ProductionStage 孤儿清理
 *
 * 批次：2026-07 Paid（8/5 发薪）/ 2026-08 Paid（9/1 发薪）/ 2026-09 Draft（本月草稿）
 * 员工：DB 实查 EmployeeProfile（12 人，与 hr-kb.ts 职级设定同口径的工资水平）
 * 口径：net = base + allowance + commission - deduction
 *       deduction = 社保（base×10.5%）+ 公积金（base×7%）+ 个税（简化：应纳税所得额≤1万 3%、超过 10%）
 *       —— schema 无社保/公积金/个税独立字段，合计入 deduction，构成写入 item.note
 * 幂等：PayrollRun upsert by period、PayrollItem upsert by id，确定性重放
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { USERS, SIM_EXTRA_ACCOUNTS, round2 } from './common';

/** 职级工资表（userId → base/岗位津贴；与 hr-kb.ts 员工设定一致） */
const SALARY_TABLE: Record<string, { base: number; allowance: number }> = {
  [USERS.boss]: { base: 42000, allowance: 6000 },            // Jason Shen 总经理
  [USERS.gm]: { base: 32000, allowance: 5000 },              // Raymond Lin 分管副总
  [USERS.salesManager]: { base: 24000, allowance: 4000 },    // Vivian Chen 销售主管
  [USERS.salesA]: { base: 15000, allowance: 2500 },          // Chloe Su 业务员
  [USERS.salesB]: { base: 14000, allowance: 2500 },          // Marcus Zhou 业务员
  [USERS.financeManager]: { base: 23000, allowance: 3500 },  // Melissa Zhao 财务经理
  [USERS.finance]: { base: 13000, allowance: 2000 },         // Charlie Qian 会计
  [USERS.qc]: { base: 16000, allowance: 3000 },              // Wilson Wu QC 主管（温州驻场）
  [USERS.logistics]: { base: 15500, allowance: 2500 },       // Hank Zheng 物流主管
  [SIM_EXTRA_ACCOUNTS[0].id]: { base: 9000, allowance: 1200 },  // Grace Liu 跟单（试用期）
  [SIM_EXTRA_ACCOUNTS[1].id]: { base: 10000, allowance: 1500 }, // Tony Fang 跟单
  [SIM_EXTRA_ACCOUNTS[2].id]: { base: 10500, allowance: 1800 }, // Ivy Zhang 跟单（苏州驻场）
};

/** 销售线佣金（与 W1-W6 28 单 Delivered 回款剧情一致；9 月 draft 未结算=0） */
const COMMISSION: Record<string, Record<string, number>> = {
  [USERS.salesManager]: { '2026-07': 3800, '2026-08': 4200, '2026-09': 0 },
  [USERS.salesA]: { '2026-07': 2600, '2026-08': 3100, '2026-09': 0 },
  [USERS.salesB]: { '2026-07': 2400, '2026-08': 2900, '2026-09': 0 },
};

const RUN_DEFS: Array<{
  id: string; period: string; status: string; note: string;
  createdAt: string; confirmedAt: string | null; paidAt: string | null;
}> = [
  {
    id: 'SIM-PAYRUN-202607', period: '2026-07', status: 'Paid',
    note: '7 月工资单（7/31 确认，8/5 发薪）',
    createdAt: '2026-07-30T02:00:00Z', confirmedAt: '2026-07-31T02:00:00Z', paidAt: '2026-08-05T02:00:00Z',
  },
  {
    id: 'SIM-PAYRUN-202608', period: '2026-08', status: 'Paid',
    note: '8 月工资单（8/31 确认，9/1 发薪）',
    createdAt: '2026-08-28T02:00:00Z', confirmedAt: '2026-08-31T02:00:00Z', paidAt: '2026-09-01T02:00:00Z',
  },
  {
    id: 'SIM-PAYRUN-202609', period: '2026-09', status: 'Draft',
    note: '9 月工资单（草稿，佣金未结算，待月底确认）',
    createdAt: '2026-09-02T02:00:00Z', confirmedAt: null, paidAt: null,
  },
];

/** 扣款计算（简化口径，见模块头注释） */
function computePay(base: number, allowance: number, commission: number) {
  const social = round2(base * 0.105);
  const housingFund = round2(base * 0.07);
  const taxable = Math.max(0, base + allowance + commission - social - housingFund - 5000);
  const tax = round2(taxable <= 10000 ? taxable * 0.03 : taxable * 0.10);
  const deduction = round2(social + housingFund + tax);
  const net = round2(base + allowance + commission - deduction);
  return { social, housingFund, tax, deduction, net };
}

export async function seedHrExtras(prisma: PrismaClient): Promise<void> {
  console.log('── HR 薪资：PayrollRun 3 批次（7 月 Paid / 8 月 Paid / 9 月 Draft）──');

  const employees = await prisma.employeeProfile.findMany({
    where: { deletedAt: null, employmentStatus: { in: ['Probation', 'Regular', 'Suspended'] } },
    orderBy: { employeeNo: 'asc' },
  });

  let unknown = 0;
  for (const def of RUN_DEFS) {
    const run = await prisma.payrollRun.upsert({
      where: { period: def.period },
      create: {
        id: def.id, period: def.period, status: def.status, note: def.note,
        totalNet: 0, headcount: 0,
        createdAt: new Date(def.createdAt),
        confirmedAt: def.confirmedAt ? new Date(def.confirmedAt) : null,
        paidAt: def.paidAt ? new Date(def.paidAt) : null,
      },
      update: {
        status: def.status, note: def.note,
        confirmedAt: def.confirmedAt ? new Date(def.confirmedAt) : null,
        paidAt: def.paidAt ? new Date(def.paidAt) : null,
      },
    });

    for (const emp of employees) {
      const salary = SALARY_TABLE[emp.userId];
      if (!salary) { unknown += 1; continue; } // 库内未知员工（工资表未覆盖）→ 跳过不臆造
      const commission = COMMISSION[emp.userId]?.[def.period] ?? 0;
      const { social, housingFund, tax, deduction, net } = computePay(salary.base, salary.allowance, commission);
      const itemId = `SIM-PAYITEM-${def.period}-${emp.employeeNo.replace('-', '')}`;
      const note = `社保 ${social} + 公积金 ${housingFund} + 个税 ${tax}（应纳税所得额≤1万 3%、超过 10% 简化）`
        + (commission > 0 ? `；佣金 ${commission}` : '');
      const payload = {
        base: salary.base, allowance: salary.allowance, overtimePay: 0,
        commission, bonus: 0, deduction, net, note,
      };
      await prisma.payrollItem.upsert({
        where: { id: itemId },
        create: { id: itemId, runId: run.id, userId: emp.userId, ...payload },
        update: payload,
      });
    }

    const items = await prisma.payrollItem.findMany({ where: { runId: run.id }, select: { net: true } });
    const totalNet = round2(items.reduce((s, i) => s + i.net, 0));
    await prisma.payrollRun.update({ where: { id: run.id }, data: { totalNet, headcount: items.length } });
    console.log(`  ${def.period}（${def.status}）: ${items.length} 人，合计实发 ${totalNet}`);
  }
  if (unknown > 0) console.warn(`  [warn] ${unknown} 条员工明细因工资表未覆盖该 userId 被跳过`);
}

/**
 * ProductionStage 孤儿清理：orderId='FAB-UI-ONLY'（旧面料库退役占位残留，10 行阶段记录）。
 * 防御性：先确认 Order 表确无此单才删（万一将来真建了同名订单则跳过并 warn）；
 * 幂等：删 0 行也正常。返回删除行数。
 */
export async function cleanupOrphanStages(prisma: PrismaClient): Promise<number> {
  const ORPHAN_ORDER_ID = 'FAB-UI-ONLY';
  const order = await prisma.order.findUnique({ where: { id: ORPHAN_ORDER_ID } });
  if (order) {
    console.warn(`  [cleanupOrphanStages] Order ${ORPHAN_ORDER_ID} 已存在，跳过清理（防误删真实订单阶段）`);
    return 0;
  }
  const r = await prisma.productionStage.deleteMany({ where: { orderId: ORPHAN_ORDER_ID } });
  console.log(`  ProductionStage 孤儿清理（${ORPHAN_ORDER_ID}）: 删除 ${r.count} 行`);
  return r.count;
}
