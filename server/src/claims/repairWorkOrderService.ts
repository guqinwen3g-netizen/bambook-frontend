/**
 * repairWorkOrderService.ts — 返修工单（A-3 二期 · 口径 A1「返修 = 只动货」）
 *
 * ════════════════════════════════════════════════════════════════════
 * ★ 为什么**独立成表**而不是复用 `ProductionPlan`（行业标准）
 *   **Odoo 有独立的 `repair.order`**（不是生产订单）· **SAP 用独立的 Rework Order 订单类型**。
 *   三条理由：
 *     ① 返修**没有 BOM 展开** —— 不是"做新货"，套生产订单会带出错误的物料需求
 *     ② 返修成本必须**单独归集**（**质量成本 ≠ 生产成本**）——
 *        混进排产会污染产能/成本统计，而这是服装厂的核心 KPI
 *     ③ 生命周期不同：**收件 → 修 → 发回**，与"排产 → 开工 → 完工"不同构
 *   ⇒ 独立表，但**复用 `WorkStation`（工位）** —— 与 Odoo「独立 repair.order + 共用 workcenter」同构。
 *
 * ★ 与 `ProductionPlan` 的关键区别（防止后来人"顺手合并"）：
 *   本表**没有** `plannedQuantity` 产能概念、**不进**排产计划、**不计**正常产能 ——
 *   它是**质量成本的载体**。
 * ════════════════════════════════════════════════════════════════════
 */

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { parsePositiveDecimal } from '../shared/moneyInput';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { claimRefusal, lockClaimRows } from './claimApprovalFact';

export type RepairWorkOrderCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE';
export interface RepairWorkOrderError { code: RepairWorkOrderCode; message: string }
export interface RepairWorkOrderResult<T = unknown> { ok: boolean; data?: T; error?: RepairWorkOrderError }

const fail = <T>(code: RepairWorkOrderCode, message: string): RepairWorkOrderResult<T> => ({ ok: false, error: { code, message } });
const ok = <T>(data: T): RepairWorkOrderResult<T> => ({ ok: true, data });

/** 返修工单状态机（与 `ProductionPlan` 的排产状态**刻意不同构**） */
export const REPAIR_STATUSES = ['Draft', 'InRepair', 'Completed', 'Shipped', 'Cancelled'] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];

export interface CreateRepairWorkOrderInput {
  claimCaseId: string;
  dispositionId?: string | null;
  /** ★ 复用现有工位（不另造） */
  workStationId: string;
  quantity: number | string;
  unit?: string | null;
  materialCode?: string | null;
  sourceShipmentId?: string | null;
  sourceProductionPlanId?: string | null;
  repairReason?: string | null;
  needsReinspection?: boolean;
  notes?: string | null;
}

/** 开一张返修工单（取号 `RW` —— 本批新增的前缀） */
export async function createRepairWorkOrder(
  prisma: PrismaClient,
  input: CreateRepairWorkOrderInput,
  _actorId: string,
  opts: { tx?: any } = {},
): Promise<RepairWorkOrderResult<{ workOrder: any }>> {
  if (!input?.claimCaseId) return fail('VALIDATION_FAILED', 'claimCaseId 必填');
  if (!input?.workStationId) return fail('VALIDATION_FAILED', 'workStationId 必填（★ 复用现有工位，不另造）');
  const parsedQty = parsePositiveDecimal(input.quantity, '返修数量');
  if (!parsedQty.ok) return fail('VALIDATION_FAILED', parsedQty.message);
  const qty = new Prisma.Decimal(parsedQty.value);

  const runInTx = opts.tx ? (fn: (tx: any) => Promise<any>) => fn(opts.tx) : (fn: (tx: any) => Promise<any>) => prisma.$transaction(fn);
  const workOrder = await runInTx(async (tx: any) => {
    const station = await tx.workStation.findUnique({ where: { id: input.workStationId } });
    if (!station || station.deletedAt || !station.isActive) claimRefusal('返修工位不存在或已停用');
    if (input.dispositionId) {
      const { disposition: d, claimCase } = await lockClaimRows(tx, input.dispositionId);
      if (claimCase.id !== input.claimCaseId || d.status !== 'Approved' || d.repairWorkOrderId
          || d.materialCode !== input.materialCode || d.unit !== input.unit || !qty.equals(d.quantity)) claimRefusal('返修工单必须完整绑定准确的已批准物料、数量和单位');
    }
    const workOrderNumber = await nextBusinessNumber(tx, 'RW', undefined, {
      occupied: async (num) => {
        // ⚠️ 含软删行（唯一约束不排除软删行；过滤了会撞号 → P2002 → 整单失败）
        const dup = await tx.repairWorkOrder.findFirst({ where: { workOrderNumber: num }, select: { id: true } });
        return dup != null;
      },
    });
    return tx.repairWorkOrder.create({
      data: {
        id: `RW_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        workOrderNumber,
        claimCaseId: input.claimCaseId,
        dispositionId: input.dispositionId ?? null,
        sourceShipmentId: input.sourceShipmentId ?? null,
        sourceProductionPlanId: input.sourceProductionPlanId ?? null,
        materialCode: input.materialCode ?? null,
        quantity: qty,
        unit: input.unit ?? null,
        workStationId: input.workStationId,
        status: 'Draft',
        repairReason: input.repairReason ?? null,
        needsReinspection: input.needsReinspection ?? true,
        notes: input.notes ?? null,
        createdAt: BigInt(Date.now()),
        updatedAt: BigInt(Date.now()),
      },
    });
  });

  return ok({ workOrder });
}

/**
 * 推进返修工单状态。
 *
 * @deprecated Physical progress uses claimRepairFulfillmentService and the common shipment gate.
 * Header-only legacy updates cannot manufacture work, inspection or shipment facts.
 */
export async function advanceRepairStatus(
  prisma: PrismaClient,
  id: string,
  next: RepairStatus,
  patch: { reshipmentId?: string | null; notes?: string | null } = {},
): Promise<RepairWorkOrderResult<{ workOrder: any }>> {
  const w = await prisma.repairWorkOrder.findUnique({ where: { id } });
  if (!w || w.deletedAt) return fail('NOT_FOUND', `返修工单 ${id} 不存在`);
  if (w.status === 'Cancelled') return fail('INVALID_STATE', '工单已作废');
  if (!(REPAIR_STATUSES as readonly string[]).includes(next)) return fail('VALIDATION_FAILED', `非法状态：${next}`);

  return fail('VALIDATION_FAILED', '返修必须通过实际收货、开工、完工、复检和真实出运接口推进，不能仅改状态或填运单号');
}

export async function getRepairWorkOrder(prisma: PrismaClient, id: string): Promise<RepairWorkOrderResult<{ workOrder: any }>> {
  const w = await prisma.repairWorkOrder.findUnique({ where: { id }, include: {
    inspections: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } },
  } });
  if (!w || w.deletedAt) return fail('NOT_FOUND', `返修工单 ${id} 不存在`);
  return ok({ workOrder: w });
}

/** 案件下的返修工单列表（供案件详情展示） */
export async function listRepairWorkOrdersByCase(prisma: PrismaClient, claimCaseId: string): Promise<RepairWorkOrderResult<{ items: any[] }>> {
  const items = await prisma.repairWorkOrder.findMany({
    where: { claimCaseId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return ok({ items });
}
