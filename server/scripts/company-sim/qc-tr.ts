/**
 * company-sim/qc-tr.ts — QC 指派 + 第三方测试委托（联动⑤）
 *
 * 剧情（确定性）：
 *   - Delivered 订单（成衣 34 + 面料 7 = 41 单）每单 1 条 QCAssignment（final，qc=usr_demo_qc，
 *     Completed，reportId=InspectionReport final id，assignedAt/completedAt 按周回填；
 *     面料单文案为终期验布）；
 *   - 第三方测试 12 张（成衣 Delivered 订单 idx ∈ {0,3,…,33}，agencies sgs/its/bv 轮换，
 *     testItems=['color_fastness','shrinkage']，pass 为主 + 2 单 fail；面料单不建第三方测试）；
 *   - fail 单各挂 1 条 TestCorrectiveAction（status=closed，闭环留痕）。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { isoDate, createManyLogged, USERS } from './common';
import { isFabricPlan, type FabricOrderPlan } from './fabric-orders';
import type { OrderPlan } from './orders';

const DAY = 24 * 3600 * 1000;
const AGENCIES = ['sgs', 'its', 'bv'] as const;
const FAIL_ORDER_IDX = new Set([9, 27]); // 2 单 fail

export async function seedQcAndTests(prisma: PrismaClient, plans: Array<OrderPlan | FabricOrderPlan>): Promise<void> {
  console.log('── QC 指派 + 第三方测试委托 ──');

  const delivered = plans.filter((p) => p.fate === 'Delivered');

  // 1. QCAssignment（reportId 以库内 InspectionReport 实际存在为准；面料单=终期验布）
  const reports = await prisma.inspectionReport.findMany({
    where: { orderId: { in: delivered.map((p) => p.id) }, inspectionType: 'final' },
    select: { id: true, orderId: true, inspectionDate: true },
  });
  const reportByOrder = new Map(reports.map((r) => [r.orderId, r] as const));

  const qcRows = delivered
    .filter((p) => reportByOrder.has(p.id))
    .map((p, qi) => {
      const report = reportByOrder.get(p.id)!;
      const shipMs = p.shipMs ?? p.createdAtMs;
      const assignedMs = shipMs - 4 * DAY;
      const completedMs = shipMs - 2 * DAY;
      return {
        id: `SIM-QCA-${String(qi + 1).padStart(3, '0')}`,
        orderId: p.id, inspectionType: 'final',
        qcUserId: USERS.qc, locationId: null, factoryRelationId: p.factoryId,
        status: 'Completed',
        dueDate: isoDate(completedMs), assignedAt: BigInt(assignedMs),
        assignedById: USERS.salesManager, completedAt: BigInt(completedMs),
        reportId: report.id,
        notes: isFabricPlan(p) ? '终期验布完成，报告已归档（剧情回填）。' : '终期验货完成，报告已归档（剧情回填）。',
        createdAt: BigInt(assignedMs), updatedAt: BigInt(completedMs), deletedAt: null,
      };
    });
  await createManyLogged(prisma, 'qCAssignment', 'QCAssignment', qcRows);

  // 2. TestRequest（12 张，pass 为主 + 2 fail）+ fail 的 CorrectiveAction（仅成衣单）
  const trPlans = delivered.filter((p) => p.idx % 3 === 0 && !isFabricPlan(p));
  const trRows: Prisma.TestRequestUncheckedCreateInput[] = [];
  const caRows: Prisma.TestCorrectiveActionUncheckedCreateInput[] = [];
  trPlans.forEach((p, ti) => {
    const shipMs = p.shipMs ?? p.createdAtMs;
    const sentMs = shipMs - 12 * DAY;
    const reportMs = shipMs - 5 * DAY;
    const fail = FAIL_ORDER_IDX.has(p.idx);
    const trId = `SIM-TR-${String(ti + 1).padStart(3, '0')}`;
    const agency = AGENCIES[ti % 3];
    trRows.push({
      id: trId,
      trNo: `SIM-TR-2026-${String(ti + 1).padStart(3, '0')}`,
      orderId: p.id,
      testItems: ['color_fastness', 'shrinkage'],
      agency,
      sentDate: isoDate(sentMs), expectedDate: isoDate(reportMs),
      notes: '成衣第三方检测（客户要求：色牢度 + 缩水率）。',
      result: fail ? 'fail' : 'pass',
      reportNo: `${agency.toUpperCase()}-2026-${String(8000 + ti)}`,
      reportDate: isoDate(reportMs),
      failItems: fail ? ['color_fastness'] : [],
      createdAt: BigInt(sentMs), updatedAt: BigInt(reportMs), deletedAt: null,
    });
    if (fail) {
      caRows.push({
        id: `${trId}-CA1`, testRequestId: trId,
        failItem: 'color_fastness',
        action: '面料复染整改并第三方复测，合格后放行出货。',
        owner: 'Wilson Wu', dueDate: isoDate(reportMs - DAY),
        status: 'closed', closedAt: BigInt(reportMs),
        closeNote: '复测色牢度达 4 级，客户书面接受，闭环放行。',
        createdAt: BigInt(sentMs + 2 * DAY), updatedAt: BigInt(reportMs),
      });
    }
  });
  await createManyLogged(prisma, 'testRequest', 'TestRequest', trRows);
  await createManyLogged(prisma, 'testCorrectiveAction', 'TestCorrectiveAction', caRows);
}
