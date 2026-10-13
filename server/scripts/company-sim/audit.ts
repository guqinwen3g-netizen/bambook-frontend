/**
 * company-sim/audit.ts — 关键节点 AuditLog 留痕
 * actor 映射（全部为库内真实账号）：sales 单 Vivian/Chloe/Marcus、QC 单 Wilson、
 * 财务 Melissa/Charlie、出货 Hank、审批 Raymond、生产流转 SIM 跟单账号。
 * 面料外销单（SIM-FORD-*）与成衣单共用同一条审计链（建单→确认→生产→QC→出运→交付→开票→回款）。
 */

import { Prisma } from '@prisma/client';
import { createManyLogged, USERS, deliveredFinance } from './common';
import { isFabricPlan, type FabricOrderPlan } from './fabric-orders';
import type { OrderPlan } from './orders';

const DAY = 24 * 3600 * 1000;

interface AuditRowInput {
  id: string; actorId: string; action: string; targetType?: string; targetId?: string;
  detail?: unknown; operationType?: string; transactionId?: string; atMs: number;
}

function row(i: AuditRowInput): Prisma.AuditLogUncheckedCreateInput {
  return {
    id: i.id, actorId: i.actorId, action: i.action,
    targetType: i.targetType ?? null, targetId: i.targetId ?? null,
    detail: (i.detail ?? null) as Prisma.InputJsonValue | null,
    ip: '10.0.0.8', operationType: i.operationType ?? null,
    fieldPath: null, beforeValue: null, afterValue: null,
    transactionId: i.transactionId ?? null,
    createdAt: new Date(i.atMs),
  };
}

export async function seedAuditLogs(prisma: PrismaClient, plans: Array<OrderPlan | FabricOrderPlan>): Promise<void> {
  console.log('── AuditLog：关键节点审计留痕 ──');
  const rows: Prisma.AuditLogUncheckedCreateInput[] = [];
  const merch = ['SIM-usr-merch-1', 'SIM-usr-merch-2', 'SIM-usr-merch-3'];

  for (const p of plans) {
    const b: AuditRowInput[] = [];
    // ① 建单（sales 本人）
    b.push({
      id: `${p.id}-A1`, actorId: p.salesId, action: 'order:create', targetType: 'Order', targetId: p.id,
      operationType: 'create', atMs: p.createdAtMs,
      detail: { code: p.code, poNumber: p.poNumber, customer: p.customerName, amount: p.amount, currency: p.currency },
    });
    // ② 确认
    if (p.confirmMs) {
      b.push({
        id: `${p.id}-A2`, actorId: p.salesId, action: 'order:confirm', targetType: 'Order', targetId: p.id,
        operationType: 'transition', transactionId: `${p.id}-T1`, atMs: p.confirmMs,
        detail: { from: 'Pending', to: 'Confirmed' },
      });
    }
    // ③ MOQ 豁免审批（Confirmed 前三单同款剧情）
    if (['SIM-ORD-048', 'SIM-ORD-050', 'SIM-ORD-053'].includes(p.id) || p.fate === 'Confirmed') {
      const idxConf = plans.filter((x) => x.fate === 'Confirmed').indexOf(p);
      if (idxConf >= 0 && idxConf < 3) {
        b.push({
          id: `${p.id}-A2B`, actorId: USERS.gm, action: 'approval:decide', targetType: 'Order', targetId: p.id,
          operationType: 'update', atMs: (p.confirmMs ?? p.createdAtMs) - 2 * 3600 * 1000,
          detail: { approval: 'order:moq-exemption', decision: 'approved', note: 'Gold/Platinum 客户小单补色，批准豁免' },
        });
      }
    }
    // ④ 进入生产
    if (p.prodStartMs) {
      b.push({
        id: `${p.id}-A3`, actorId: merch[p.idx % 3], action: 'order:transition', targetType: 'Order', targetId: p.id,
        operationType: 'transition', transactionId: `${p.id}-T2`, atMs: p.prodStartMs,
        detail: { from: 'Confirmed', to: 'Production' },
      });
    }
    // ⑤ QC 终验 + 裁前检查
    if (p.shipMs) {
      const shadeDeduction = !!(p as { shadeDeduction?: boolean }).shadeDeduction; // 面料缸差索赔单
      b.push({
        id: `${p.id}-A4`, actorId: USERS.qc, action: 'inspection:final_pass', targetType: 'Order', targetId: p.id,
        operationType: 'create', atMs: p.shipMs - 2 * DAY,
        detail: shadeDeduction
          ? { inspectionType: 'final', result: 'conditional', inspector: 'Wilson Wu', note: '缸差索赔 3%，发票按 97% 开具' }
          : { inspectionType: 'final', result: 'pass', inspector: 'Wilson Wu' },
      });
    }
    // ⑥ 发运/交付（Hank）
    if (p.shipMs) {
      b.push({
        id: `${p.id}-A5`, actorId: USERS.logistics, action: 'shipment:create', targetType: 'Order', targetId: p.id,
        operationType: 'create', atMs: p.shipMs - 7 * DAY,
        detail: {
          shipment: 'SIM-SHP-4xxx', // 演示文案占位（真实票号见 Shipment 表）
          method: isFabricPlan(p) ? 'Sea' : p.idx % 6 === 0 ? 'Air' : 'Sea',
          portOfLoading: 'Shanghai',
        },
      });
      b.push({
        id: `${p.id}-A6`, actorId: USERS.logistics, action: 'order:transition', targetType: 'Order', targetId: p.id,
        operationType: 'transition', transactionId: `${p.id}-T3`, atMs: p.shipMs,
        detail: { from: 'Production', to: 'Shipping' },
      });
    }
    if (p.deliveredMs) {
      b.push({
        id: `${p.id}-A7`, actorId: USERS.logistics, action: 'order:transition', targetType: 'Order', targetId: p.id,
        operationType: 'transition', transactionId: `${p.id}-T4`, atMs: p.deliveredMs,
        detail: { from: 'Shipping', to: 'Delivered' },
      });
      // ⑦ 开票（Melissa）
      b.push({
        id: `${p.id}-A8`, actorId: USERS.financeManager, action: 'invoice:create', targetType: 'Order', targetId: p.id,
        operationType: 'create', atMs: p.shipMs,
        detail: { invoiceType: 'Receivable', amount: p.amount, currency: p.currency },
      });
      // ⑧ 回款（Charlie）—— 随 deliveredFinance 分流（与 orders/fabric-orders 凭证口径一致）：
      //    paid=交付+3 天全额；overdue=发运+12 天半款；deposit=开票+6 天定金；issued=未收款（无回款审计）
      const fin = deliveredFinance(p);
      if (fin.kind !== 'issued') {
        const payMs = fin.kind === 'overdue' ? p.shipMs + 12 * DAY
          : fin.kind === 'paid' ? p.deliveredMs + 3 * DAY
          : p.shipMs + 6 * DAY;
        b.push({
          id: `${p.id}-A9`, actorId: USERS.finance, action: 'payment:receive', targetType: 'Order', targetId: p.id,
          operationType: 'create', atMs: payMs,
          detail: fin.kind === 'paid'
            ? { amount: p.amount, status: 'reconciled' }
            : fin.kind === 'overdue'
              ? { amount: round2(p.amount * 0.5), status: 'partially_reconciled', note: '余款逾期挂账' }
              : { amount: round2(p.amount * 0.3), status: 'partially_reconciled', note: '定金 30% 到账，尾款待付' },
        });
      }
      if (p.overdue) {
        b.push({
          id: `${p.id}-A10`, actorId: USERS.financeManager, action: 'dunning:record', targetType: 'Order', targetId: p.id,
          operationType: 'create', atMs: Date.UTC(2026, 7, 20),
          detail: { channel: 'email', stage: 'firm', totalOverdue: round2(p.amount * 0.5) },
        });
      }
    }
    for (const x of b) rows.push(row(x));
  }

  // 开发案创建留痕
  plans.slice(0, 12).forEach((p, i) => {
    rows.push(row({
      id: `SIM-DEV-${String(5001 + i)}-A1`, actorId: merch[i % 3], action: 'devcase:create',
      targetType: 'DevelopmentCase', targetId: `SIM-DEV-${String(5001 + i)}`,
      operationType: 'create', atMs: p.createdAtMs + DAY,
      detail: { name: `dev-case-${i + 1}` },
    }));
  });

  await createManyLogged(prisma, 'auditLog', 'AuditLog', rows);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
