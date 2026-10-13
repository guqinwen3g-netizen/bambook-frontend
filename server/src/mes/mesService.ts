
/**
 * 生产 MES 服务 — 制造执行系统深化 (Phase 3 C2)
 *
 * 职责：
 *   1. WorkStation：工位 CRUD + 软删除 + 产能管理
 *   2. ProductionPlan：排产单 CRUD + 状态机（Draft→Confirmed→InProgress→Completed/Cancelled）+ 进度更新
 *   3. WorkHour：工时记录 CRUD + 汇总
 *   4. PieceRateRule：计件规则 CRUD + 软删除 + 生效期管理
 *   5. PieceRateRecord：计件记录 CRUD + 自动金额计算 + 状态机（Pending→Confirmed→Paid）+ 汇总
 *   6. OutsourcingOrder：外协订单 CRUD + 状态机（Draft→Sent→Confirmed→InProduction→Received/Cancelled）+ 质量验收
 *   7. OutsourcingLine：外协行明细 CRUD（随外协单事务内创建）
 *
 * 设计原则：
 *   - 软删除（deletedAt BigInt），不物理删除
 *   - 事务内创建主表 + 行明细 + 审计日志
 *   - 金额自动计算：PieceRateRecord.amount = quantity × ratePerUnit（单价快照防回溯）
 *   - 外协 totalAmount = quantity × unitPrice
 *   - 状态转换有严格校验（非法转换抛错，fail-closed）
 *   - 事件发布失败不阻断业务（fire-and-forget）
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { legacySupplierMutation } from '../procurement/supplierContractPolicy';
import { logger } from '../lib/logger';
import { businessEventBus } from '../events/businessEventBus';
import { syncOutsourcingOrderReferences, deactivateEntityLinks } from '../entities/sync';
import { todayLocalKey } from '../shared/localDate';


// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export type WorkStationType = 'Sewing' | 'Cutting' | 'Printing' | 'Embroidery' | 'Packing' | 'QC' | 'Other';

export type ProductionPlanStatus = 'Draft' | 'Confirmed' | 'InProgress' | 'Completed' | 'Cancelled';
export type Priority = 'High' | 'Normal' | 'Low';

export type PieceRateStatus = 'Pending' | 'Confirmed' | 'Paid';

export type OutsourcingStatus = 'Draft' | 'Sent' | 'Confirmed' | 'InProduction' | 'Received' | 'Cancelled';

export type OutsourcingProcessType = 'Sewing' | 'Cutting' | 'Washing' | 'Printing' | 'Embroidery' | 'Dyeing' | 'Other';

export interface WorkStationInput {
  code: string;
  name: string;
  type: WorkStationType;
  capacityPerDay?: number;
  capacityUnit?: string;
  isActive?: boolean;
  location?: string;
  manager?: string;
  sortOrder?: number;
  notes?: string;
}

export interface ProductionPlanInput {
  planNumber: string;
  orderId?: string;
  workStationId: string;
  processType: WorkStationType;
  processSeq?: number;
  plannedQuantity: number;
  unit: string;
  plannedStartDate: string;
  plannedEndDate: string;
  priority?: Priority;
  assignedTo?: string;
  notes?: string;
}

export interface WorkHourInput {
  productionPlanId: string;
  employeeId?: string;
  employeeName?: string;
  workDate: string;
  hours: number;
  overtimeHours?: number;
  notes?: string;
}

export interface PieceRateRuleInput {
  code: string;
  name: string;
  processType: WorkStationType;
  productAssetId?: string;
  unit: string;
  ratePerUnit: number;
  effectiveFrom: string;
  effectiveTo?: string;
  isActive?: boolean;
  description?: string;
  notes?: string;
}

export interface PieceRateRecordInput {
  pieceRateRuleId: string;
  productionPlanId?: string;
  employeeId?: string;
  employeeName?: string;
  workDate: string;
  quantity: number;
  unit: string;
  notes?: string;
}

export interface OutsourcingOrderInput {
  orderNumber: string;
  supplierId?: string;
  orderId?: string;
  bomId?: string;
  processType: OutsourcingProcessType;
  description?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  currency?: string;
  orderDate?: string;
  plannedDeliveryDate?: string;
  notes?: string;
  lines?: OutsourcingLineInput[];
}

export interface OutsourcingLineInput {
  processType: OutsourcingProcessType;
  description: string;
  materialCode?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  notes?: string;
}

// ────────────────────────────────────────────────────────────────
// 辅助函数
// ────────────────────────────────────────────────────────────────

const now = (): bigint => BigInt(Date.now());

/** 列表分页参数（R678：六 list 端点 limit/offset + total 真实计数） */
export interface MesListPage {
  limit?: number;
  offset?: number;
}

/**
 * 分页参数归一为 Prisma take/skip：
 *   - limit 缺省 → 不分页（向后兼容：返回全量，total = items.length 由 count 兜底）
 *   - limit 提供 → 收敛 [1, 500]；offset 缺省/负数 → 0
 */
function pageArgs(opts: MesListPage): { take?: number; skip?: number } {
  if (opts.limit == null || !Number.isFinite(opts.limit)) return {};
  const take = Math.min(Math.max(Math.floor(opts.limit), 1), 500);
  const skip = opts.offset != null && Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;
  return { take, skip };
}

function generateWorkStationId(): string {
  return `WS_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generatePlanId(): string {
  return `PP_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateWorkHourId(): string {
  return `WHR_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateRuleId(): string {
  return `PRR_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateRecordId(): string {
  return `PRC_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateOutsourcingId(): string {
  return `OSO_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateOutsourcingLineId(): string {
  return `OSL_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

const VALID_WS_TYPES = ['Sewing', 'Cutting', 'Printing', 'Embroidery', 'Packing', 'QC', 'Other'];
const VALID_PLAN_STATUSES = ['Draft', 'Confirmed', 'InProgress', 'Completed', 'Cancelled'];
const VALID_PRIORITIES = ['High', 'Normal', 'Low'];
const VALID_PIECE_RATE_STATUSES = ['Pending', 'Confirmed', 'Paid'];
const VALID_OUTSOURCING_STATUSES = ['Draft', 'Sent', 'Confirmed', 'InProduction', 'Received', 'Cancelled'];
const VALID_OUTSOURCING_PROCESS_TYPES = ['Sewing', 'Cutting', 'Washing', 'Printing', 'Embroidery', 'Dyeing', 'Other'];

function validateWorkStationType(type: string): asserts type is WorkStationType {
  if (!VALID_WS_TYPES.includes(type)) throw new Error(`非法工位类型: ${type}`);
}

function validatePlanStatus(status: string): asserts status is ProductionPlanStatus {
  if (!VALID_PLAN_STATUSES.includes(status)) throw new Error(`非法排产状态: ${status}`);
}

function validatePriority(priority: string): asserts priority is Priority {
  if (!VALID_PRIORITIES.includes(priority)) throw new Error(`非法优先级: ${priority}`);
}

function validatePieceRateStatus(status: string): asserts status is PieceRateStatus {
  if (!VALID_PIECE_RATE_STATUSES.includes(status)) throw new Error(`非法计件状态: ${status}`);
}

function validateOutsourcingStatus(status: string): asserts status is OutsourcingStatus {
  if (!VALID_OUTSOURCING_STATUSES.includes(status)) throw new Error(`非法外协状态: ${status}`);
}

function validateOutsourcingProcessType(type: string): asserts type is OutsourcingProcessType {
  if (!VALID_OUTSOURCING_PROCESS_TYPES.includes(type)) throw new Error(`非法外协工序类型: ${type}`);
}

// ────────────────────────────────────────────────────────────────
// 排产状态转换规则
// ────────────────────────────────────────────────────────────────

const PLAN_TRANSITIONS: Record<string, string[]> = {
  Draft: ['Confirmed', 'Cancelled'],
  Confirmed: ['InProgress', 'Cancelled'],
  InProgress: ['Completed', 'Cancelled'],
  Completed: [],
  Cancelled: [],
};

const OUTSOURCING_TRANSITIONS: Record<string, string[]> = {
  Draft: ['Sent', 'Cancelled'],
  Sent: ['Confirmed', 'Cancelled'],
  Confirmed: ['InProduction', 'Cancelled'],
  InProduction: ['Received', 'Cancelled'],
  Received: [],
  Cancelled: [],
};

const PIECE_RATE_TRANSITIONS: Record<string, string[]> = {
  Pending: ['Confirmed'],
  Confirmed: ['Paid'],
  Paid: [],
};

// ════════════════════════════════════════════════════════════════
// Service Factory
// ════════════════════════════════════════════════════════════════

export function createMesService(prisma: PrismaClient) {
  // ────────────────────────────────────────────────────────────
  // 1. WorkStation
  // ────────────────────────────────────────────────────────────

  async function createWorkStation(input: WorkStationInput, actorId: string) {
    validateWorkStationType(input.type);

    const existing = await prisma.workStation.findFirst({
      where: { code: input.code, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new Error(`工位编码 ${input.code} 已存在`);

    const ts = now();
    const ws = await prisma.$transaction(async (tx) => {
      const station = await tx.workStation.create({
        data: {
          id: generateWorkStationId(),
          code: input.code,
          name: input.name,
          type: input.type,
          capacityPerDay: input.capacityPerDay ?? null,
          capacityUnit: input.capacityUnit ?? null,
          isActive: true,
          sortOrder: input.sortOrder ?? 0,
          location: input.location ?? null,
          manager: input.manager ?? null,
          notes: input.notes ?? null,
          createdAt: ts,
          updatedAt: ts,
        },
      });

      await tx.auditLog.create({
        data: {
          id: `AUD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          action: 'MES_WS_CREATE',
          actorId,
          targetType: 'WorkStation',
          targetId: station.id,
          detail: { source: 'api:mes', after: { code: station.code, name: station.name, type: station.type } } as any,
        },
      });

      return station;
    });

    logger.info('[MesService] work station created', { id: ws.id, code: ws.code, actorId });
    return ws;
  }

  async function updateWorkStation(id: string, input: Partial<WorkStationInput>, actorId: string) {
    const ts = now();
    const existing = await prisma.workStation.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`工位 ${id} 不存在`);

    if (input.type) validateWorkStationType(input.type);

    const updated = await prisma.workStation.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.type !== undefined && { type: input.type }),
        ...(input.capacityPerDay !== undefined && { capacityPerDay: input.capacityPerDay }),
        ...(input.capacityUnit !== undefined && { capacityUnit: input.capacityUnit }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        ...(input.location !== undefined && { location: input.location }),
        ...(input.manager !== undefined && { manager: input.manager }),
        ...(input.notes !== undefined && { notes: input.notes }),
        updatedAt: ts,
      },
    });

    logger.info('[MesService] work station updated', { id, actorId });
    return updated;
  }

  async function deleteWorkStation(id: string, actorId: string): Promise<void> {
    const ts = now();
    const existing = await prisma.workStation.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new Error(`工位 ${id} 不存在`);

    await prisma.workStation.update({
      where: { id },
      data: { deletedAt: ts, updatedAt: ts },
    });

    logger.info('[MesService] work station soft-deleted', { id, actorId });
  }

  async function listWorkStations(opts: { type?: string; isActive?: boolean } & MesListPage = {}) {
    const where: Record<string, unknown> = { deletedAt: null };
    if (opts.type) where.type = opts.type;
    if (opts.isActive !== undefined) where.isActive = opts.isActive;

    const [items, total] = await Promise.all([
      prisma.workStation.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        ...pageArgs(opts),
      }),
      prisma.workStation.count({ where }),
    ]);
    return { items, total };
  }

  async function getWorkStation(id: string, planReadScopeWhere?: Prisma.ProductionPlanWhereInput) {
    return prisma.workStation.findFirst({
      where: { id, deletedAt: null },
      include: { productionPlans: { where: { deletedAt: null, ...(planReadScopeWhere ? { AND: [planReadScopeWhere] } : {}) }, orderBy: { createdAt: 'desc' }, take: 10 } },
    });
  }

  /** 工位利用率 = 已排产数量 / (日产能 × 天数) */
  async function getWorkStationUtilization(workStationId: string, startDate: string, endDate: string, readScopeWhere?: Prisma.ProductionPlanWhereInput) {
    const station = await prisma.workStation.findFirst({
      where: { id: workStationId, deletedAt: null },
    });
    if (!station) throw new Error(`工位 ${workStationId} 不存在`);

    const plans = await prisma.productionPlan.findMany({
      where: {
        workStationId,
        deletedAt: null,
        status: { in: ['Confirmed', 'InProgress'] },
        plannedStartDate: { lte: endDate },
        plannedEndDate: { gte: startDate },
        ...(readScopeWhere ? { AND: [readScopeWhere] } : {}),
      },
      select: { plannedQuantity: true },
    });

    const plannedQty = plans.reduce((sum, p) => sum + Number(p.plannedQuantity), 0);
    const days = Math.max(1, Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1);
    const capacity = station.capacityPerDay ? Number(station.capacityPerDay) * days : 0;
    const utilization = capacity > 0 ? round4(plannedQty / capacity) : 0;

    return { workStationId, plannedQty, capacity, days, utilization };
  }

  // ────────────────────────────────────────────────────────────
  // 2. ProductionPlan
  // ────────────────────────────────────────────────────────────

  async function createProductionPlan(input: ProductionPlanInput, actorId: string) {
    validateWorkStationType(input.processType);
    if (input.priority) validatePriority(input.priority);

    const ws = await prisma.workStation.findFirst({
      where: { id: input.workStationId, deletedAt: null },
      select: { id: true },
    });
    if (!ws) throw new Error(`工位 ${input.workStationId} 不存在`);

    const existing = await prisma.productionPlan.findFirst({
      where: { planNumber: input.planNumber, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new Error(`排产单号 ${input.planNumber} 已存在`);

    const ts = now();
    const plan = await prisma.$transaction(async (tx) => {
      const p = await tx.productionPlan.create({
        data: {
          id: generatePlanId(),
          planNumber: input.planNumber,
          orderId: input.orderId ?? null,
          workStationId: input.workStationId,
          processType: input.processType,
          processSeq: input.processSeq ?? 0,
          plannedQuantity: round4(input.plannedQuantity),
          actualQuantity: 0,
          unit: input.unit,
          plannedStartDate: input.plannedStartDate,
          plannedEndDate: input.plannedEndDate,
          status: 'Draft',
          priority: input.priority ?? 'Normal',
          assignedTo: input.assignedTo ?? null,
          notes: input.notes ?? null,
          createdAt: ts,
          updatedAt: ts,
        },
      });

      await tx.auditLog.create({
        data: {
          id: `AUD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          action: 'MES_PLAN_CREATE',
          actorId,
          targetType: 'ProductionPlan',
          targetId: p.id,
          detail: { source: 'api:mes', after: { planNumber: p.planNumber, workStationId: p.workStationId, processType: p.processType } } as any,
        },
      });

      return p;
    });

    logger.info('[MesService] production plan created', { id: plan.id, planNumber: plan.planNumber, actorId });
    return plan;
  }

  async function updateProductionPlan(id: string, input: Partial<ProductionPlanInput>, actorId: string) {
    const ts = now();
    const existing = await prisma.productionPlan.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`排产单 ${id} 不存在`);

    if (existing.status !== 'Draft') {
      throw new Error(`排产单 ${id} 状态为 ${existing.status}，仅 Draft 可编辑`);
    }

    if (input.processType) validateWorkStationType(input.processType);
    if (input.priority) validatePriority(input.priority);

    const updated = await prisma.productionPlan.update({
      where: { id },
      data: {
        ...(input.workStationId !== undefined && { workStationId: input.workStationId }),
        ...(input.processType !== undefined && { processType: input.processType }),
        ...(input.processSeq !== undefined && { processSeq: input.processSeq }),
        ...(input.plannedQuantity !== undefined && { plannedQuantity: round4(input.plannedQuantity) }),
        ...(input.unit !== undefined && { unit: input.unit }),
        ...(input.plannedStartDate !== undefined && { plannedStartDate: input.plannedStartDate }),
        ...(input.plannedEndDate !== undefined && { plannedEndDate: input.plannedEndDate }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.assignedTo !== undefined && { assignedTo: input.assignedTo }),
        ...(input.notes !== undefined && { notes: input.notes }),
        updatedAt: ts,
      },
    });

    logger.info('[MesService] production plan updated', { id, actorId });
    return updated;
  }

  async function deleteProductionPlan(id: string, actorId: string): Promise<void> {
    const ts = now();
    const existing = await prisma.productionPlan.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!existing) throw new Error(`排产单 ${id} 不存在`);
    if (existing.status !== 'Draft') throw new Error(`排产单 ${id} 状态为 ${existing.status}，仅 Draft 可删除`);

    await prisma.productionPlan.update({
      where: { id },
      data: { deletedAt: ts, updatedAt: ts },
    });

    logger.info('[MesService] production plan soft-deleted', { id, actorId });
  }

  async function listProductionPlans(opts: {
    orderId?: string;
    workStationId?: string;
    status?: string;
    processType?: string;
    dateFrom?: string;
    dateTo?: string;
    readScopeWhere?: Prisma.ProductionPlanWhereInput;
  } & MesListPage = {}) {
    const where: Record<string, unknown> = { deletedAt: null };
    if (opts.readScopeWhere) where.AND = [opts.readScopeWhere];
    if (opts.orderId) where.orderId = opts.orderId;
    if (opts.workStationId) where.workStationId = opts.workStationId;
    if (opts.status) where.status = opts.status;
    if (opts.processType) where.processType = opts.processType;
    if (opts.dateFrom) where.plannedStartDate = { gte: opts.dateFrom };
    if (opts.dateTo) where.plannedEndDate = { lte: opts.dateTo };

    const [items, total] = await Promise.all([
      prisma.productionPlan.findMany({
        where,
        include: { workStation: { select: { code: true, name: true, type: true } } },
        orderBy: { createdAt: 'desc' },
        ...pageArgs(opts),
      }),
      prisma.productionPlan.count({ where }),
    ]);
    return { items, total };
  }

  async function getProductionPlan(id: string, readScopeWhere?: Prisma.ProductionPlanWhereInput) {
    return prisma.productionPlan.findFirst({
      where: { id, deletedAt: null, ...(readScopeWhere ? { AND: [readScopeWhere] } : {}) },
      include: {
        workStation: true,
        workHours: { orderBy: { workDate: 'desc' } },
      },
    });
  }

  /** 排产状态流转 */
  async function transitionPlanStatus(id: string, toStatus: ProductionPlanStatus, actorId: string) {
    validatePlanStatus(toStatus);
    const ts = now();

    const existing = await prisma.productionPlan.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`排产单 ${id} 不存在`);

    const fromStatus = existing.status as ProductionPlanStatus;
    const allowed = PLAN_TRANSITIONS[fromStatus] ?? [];
    if (!allowed.includes(toStatus)) {
      throw new Error(`非法状态转换: ${fromStatus} → ${toStatus}`);
    }

    const data: Record<string, unknown> = { status: toStatus, updatedAt: ts };
    if (toStatus === 'InProgress' && !existing.actualStartDate) {
      data.actualStartDate = todayLocalKey();
    }
    if (toStatus === 'Completed') {
      data.actualEndDate = todayLocalKey();
    }

    const updated = await prisma.productionPlan.update({ where: { id }, data });

    // 事件发布（fire-and-forget）
    const eventType = toStatus === 'Confirmed' ? 'ProductionPlanConfirmed'
      : toStatus === 'InProgress' ? 'ProductionPlanStarted'
      : toStatus === 'Completed' ? 'ProductionPlanCompleted'
      : null;

    if (eventType) {
      businessEventBus.publish({
        type: eventType,
        sourceEntityType: 'ProductionPlan',
        sourceEntityId: id,
        orderId: existing.orderId ?? undefined,
        payload: { planNumber: existing.planNumber, fromStatus, toStatus, workStationId: existing.workStationId },
        actorId,
        timestamp: Date.now(),
      } as any).catch((err) => logger.warn('[MesService] event publish failed', { eventType, id, err }));
    }

    logger.info('[MesService] plan status transitioned', { id, fromStatus, toStatus, actorId });
    return updated;
  }

  /** 更新生产进度（实际完成数量） */
  async function updatePlanProgress(id: string, actualQuantity: number, actorId: string) {
    const ts = now();
    const existing = await prisma.productionPlan.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, plannedQuantity: true },
    });
    if (!existing) throw new Error(`排产单 ${id} 不存在`);
    if (existing.status !== 'InProgress') {
      throw new Error(`排产单 ${id} 状态为 ${existing.status}，仅 InProgress 可更新进度`);
    }

    const updated = await prisma.productionPlan.update({
      where: { id },
      data: { actualQuantity: round4(actualQuantity), updatedAt: ts },
    });

    logger.info('[MesService] plan progress updated', { id, actualQuantity, actorId });
    return updated;
  }

  // ────────────────────────────────────────────────────────────
  // 3. WorkHour
  // ────────────────────────────────────────────────────────────

  async function createWorkHour(input: WorkHourInput, actorId: string) {
    const ts = now();
    const plan = await prisma.productionPlan.findFirst({
      where: { id: input.productionPlanId, deletedAt: null },
      select: { id: true },
    });
    if (!plan) throw new Error(`排产单 ${input.productionPlanId} 不存在`);

    const wh = await prisma.workHour.create({
      data: {
        id: generateWorkHourId(),
        productionPlanId: input.productionPlanId,
        employeeId: input.employeeId ?? null,
        employeeName: input.employeeName ?? null,
        workDate: input.workDate,
        hours: round4(input.hours),
        overtimeHours: round4(input.overtimeHours ?? 0),
        notes: input.notes ?? null,
        createdAt: ts,
        updatedAt: ts,
      },
    });

    logger.info('[MesService] work hour created', { id: wh.id, planId: input.productionPlanId, actorId });
    return wh;
  }

  async function listWorkHours(opts: { productionPlanId?: string; employeeId?: string; dateFrom?: string; dateTo?: string; readScopeWhere?: Prisma.WorkHourWhereInput } & MesListPage = {}) {
    const where: Record<string, unknown> = {};
    if (opts.readScopeWhere) where.AND = [opts.readScopeWhere];
    if (opts.productionPlanId) where.productionPlanId = opts.productionPlanId;
    if (opts.employeeId) where.employeeId = opts.employeeId;
    if (opts.dateFrom || opts.dateTo) {
      where.workDate = {};
      if (opts.dateFrom) (where.workDate as Record<string, unknown>).gte = opts.dateFrom;
      if (opts.dateTo) (where.workDate as Record<string, unknown>).lte = opts.dateTo;
    }

    const [items, total] = await Promise.all([
      prisma.workHour.findMany({
        where,
        orderBy: { workDate: 'desc' },
        ...pageArgs(opts),
      }),
      prisma.workHour.count({ where }),
    ]);
    return { items, total };
  }

  /** 工时汇总：按员工聚合 */
  async function getWorkHourSummary(opts: { productionPlanId?: string; dateFrom?: string; dateTo?: string; readScopeWhere?: Prisma.WorkHourWhereInput } = {}) {
    const where: Record<string, unknown> = {};
    if (opts.readScopeWhere) where.AND = [opts.readScopeWhere];
    if (opts.productionPlanId) where.productionPlanId = opts.productionPlanId;
    if (opts.dateFrom || opts.dateTo) {
      where.workDate = {};
      if (opts.dateFrom) (where.workDate as Record<string, unknown>).gte = opts.dateFrom;
      if (opts.dateTo) (where.workDate as Record<string, unknown>).lte = opts.dateTo;
    }

    const records = await prisma.workHour.findMany({
      where,
      select: { employeeId: true, employeeName: true, hours: true, overtimeHours: true },
    });

    const summary: Record<string, { employeeId: string; employeeName: string | null; totalHours: number; totalOvertime: number }> = {};
    for (const r of records) {
      const key = r.employeeId ?? 'unknown';
      if (!summary[key]) {
        summary[key] = { employeeId: key, employeeName: r.employeeName, totalHours: 0, totalOvertime: 0 };
      }
      summary[key].totalHours += Number(r.hours);
      summary[key].totalOvertime += Number(r.overtimeHours);
    }

    return Object.values(summary);
  }

  async function deleteWorkHour(id: string, actorId: string): Promise<void> {
    await prisma.workHour.delete({ where: { id } });
    logger.info('[MesService] work hour deleted', { id, actorId });
  }

  // ────────────────────────────────────────────────────────────
  // 4. PieceRateRule
  // ────────────────────────────────────────────────────────────

  async function createPieceRateRule(input: PieceRateRuleInput, actorId: string) {
    validateWorkStationType(input.processType);

    const existing = await prisma.pieceRateRule.findFirst({
      where: { code: input.code, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new Error(`计件规则编码 ${input.code} 已存在`);

    const ts = now();
    const rule = await prisma.$transaction(async (tx) => {
      const r = await tx.pieceRateRule.create({
        data: {
          id: generateRuleId(),
          code: input.code,
          name: input.name,
          processType: input.processType,
          productAssetId: input.productAssetId ?? null,
          unit: input.unit,
          ratePerUnit: round4(input.ratePerUnit),
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          isActive: true,
          description: input.description ?? null,
          notes: input.notes ?? null,
          createdAt: ts,
          updatedAt: ts,
        },
      });

      await tx.auditLog.create({
        data: {
          id: `AUD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          action: 'MES_PRRULE_CREATE',
          actorId,
          targetType: 'PieceRateRule',
          targetId: r.id,
          detail: { source: 'api:mes', after: { code: r.code, name: r.name, ratePerUnit: r.ratePerUnit } } as any,
        },
      });

      return r;
    });

    logger.info('[MesService] piece rate rule created', { id: rule.id, code: rule.code, actorId });
    return rule;
  }

  async function updatePieceRateRule(id: string, input: Partial<PieceRateRuleInput>, actorId: string) {
    const ts = now();
    const existing = await prisma.pieceRateRule.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`计件规则 ${id} 不存在`);

    if (input.processType) validateWorkStationType(input.processType);

    const updated = await prisma.pieceRateRule.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.processType !== undefined && { processType: input.processType }),
        ...(input.unit !== undefined && { unit: input.unit }),
        ...(input.ratePerUnit !== undefined && { ratePerUnit: round4(input.ratePerUnit) }),
        ...(input.effectiveFrom !== undefined && { effectiveFrom: input.effectiveFrom }),
        ...(input.effectiveTo !== undefined && { effectiveTo: input.effectiveTo }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.notes !== undefined && { notes: input.notes }),
        updatedAt: ts,
      },
    });

    logger.info('[MesService] piece rate rule updated', { id, actorId });
    return updated;
  }

  async function deletePieceRateRule(id: string, actorId: string): Promise<void> {
    const ts = now();
    const existing = await prisma.pieceRateRule.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new Error(`计件规则 ${id} 不存在`);

    await prisma.pieceRateRule.update({
      where: { id },
      data: { deletedAt: ts, updatedAt: ts, isActive: false },
    });

    logger.info('[MesService] piece rate rule soft-deleted', { id, actorId });
  }

  async function listPieceRateRules(opts: { processType?: string; productAssetId?: string; isActive?: boolean } & MesListPage = {}) {
    const where: Record<string, unknown> = { deletedAt: null };
    if (opts.processType) where.processType = opts.processType;
    if (opts.productAssetId) where.productAssetId = opts.productAssetId;
    if (opts.isActive !== undefined) where.isActive = opts.isActive;

    const [items, total] = await Promise.all([
      prisma.pieceRateRule.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { effectiveFrom: 'desc' }],
        ...pageArgs(opts),
      }),
      prisma.pieceRateRule.count({ where }),
    ]);
    return { items, total };
  }

  // ────────────────────────────────────────────────────────────
  // 5. PieceRateRecord
  // ────────────────────────────────────────────────────────────

  async function createPieceRateRecord(input: PieceRateRecordInput, actorId: string) {
    const ts = now();
    const rule = await prisma.pieceRateRule.findFirst({
      where: { id: input.pieceRateRuleId, deletedAt: null, isActive: true },
    });
    if (!rule) throw new Error(`计件规则 ${input.pieceRateRuleId} 不存在或已停用`);

    // 单价快照
    const ratePerUnit = Number(rule.ratePerUnit);
    const amount = round4(input.quantity * ratePerUnit);

    const record = await prisma.$transaction(async (tx) => {
      const r = await tx.pieceRateRecord.create({
        data: {
          id: generateRecordId(),
          pieceRateRuleId: input.pieceRateRuleId,
          productionPlanId: input.productionPlanId ?? null,
          employeeId: input.employeeId ?? null,
          employeeName: input.employeeName ?? null,
          workDate: input.workDate,
          quantity: round4(input.quantity),
          unit: input.unit,
          ratePerUnit,
          amount,
          currency: 'CNY',
          status: 'Pending',
          notes: input.notes ?? null,
          createdAt: ts,
          updatedAt: ts,
        },
      });

      await tx.auditLog.create({
        data: {
          id: `AUD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          action: 'MES_PRREC_CREATE',
          actorId,
          targetType: 'PieceRateRecord',
          targetId: r.id,
          detail: { source: 'api:mes', after: { quantity: r.quantity, ratePerUnit: r.ratePerUnit, amount: r.amount, employeeId: r.employeeId } } as any,
        },
      });

      return r;
    });

    logger.info('[MesService] piece rate record created', { id: record.id, amount, actorId });
    return record;
  }

  async function listPieceRateRecords(opts: {
    pieceRateRuleId?: string;
    productionPlanId?: string;
    employeeId?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    readScopeWhere?: Prisma.PieceRateRecordWhereInput;
  } & MesListPage = {}) {
    const where: Record<string, unknown> = {};
    if (opts.readScopeWhere) where.AND = [opts.readScopeWhere];
    if (opts.pieceRateRuleId) where.pieceRateRuleId = opts.pieceRateRuleId;
    if (opts.productionPlanId) where.productionPlanId = opts.productionPlanId;
    if (opts.employeeId) where.employeeId = opts.employeeId;
    if (opts.status) where.status = opts.status;
    if (opts.dateFrom || opts.dateTo) {
      where.workDate = {};
      if (opts.dateFrom) (where.workDate as Record<string, unknown>).gte = opts.dateFrom;
      if (opts.dateTo) (where.workDate as Record<string, unknown>).lte = opts.dateTo;
    }

    const [items, total] = await Promise.all([
      prisma.pieceRateRecord.findMany({
        where,
        include: { pieceRateRule: { select: { code: true, name: true, processType: true } } },
        orderBy: { workDate: 'desc' },
        ...pageArgs(opts),
      }),
      prisma.pieceRateRecord.count({ where }),
    ]);
    return { items, total };
  }

  /** 计件状态流转：Pending → Confirmed → Paid */
  async function transitionPieceRateStatus(id: string, toStatus: PieceRateStatus, actorId: string) {
    validatePieceRateStatus(toStatus);
    const ts = now();

    const existing = await prisma.pieceRateRecord.findFirst({ where: { id } });
    if (!existing) throw new Error(`计件记录 ${id} 不存在`);

    const fromStatus = existing.status as PieceRateStatus;
    const allowed = PIECE_RATE_TRANSITIONS[fromStatus] ?? [];
    if (!allowed.includes(toStatus)) {
      throw new Error(`非法状态转换: ${fromStatus} → ${toStatus}`);
    }

    const updated = await prisma.pieceRateRecord.update({
      where: { id },
      data: { status: toStatus, updatedAt: ts },
    });

    logger.info('[MesService] piece rate record status transitioned', { id, fromStatus, toStatus, actorId });
    return updated;
  }

  /** 计件工资汇总：按员工聚合金额 */
  async function getPiceRateSummary(opts: {
    employeeId?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    readScopeWhere?: Prisma.PieceRateRecordWhereInput;
  } = {}) {
    const where: Record<string, unknown> = {};
    if (opts.readScopeWhere) where.AND = [opts.readScopeWhere];
    if (opts.employeeId) where.employeeId = opts.employeeId;
    if (opts.status) where.status = opts.status;
    if (opts.dateFrom || opts.dateTo) {
      where.workDate = {};
      if (opts.dateFrom) (where.workDate as Record<string, unknown>).gte = opts.dateFrom;
      if (opts.dateTo) (where.workDate as Record<string, unknown>).lte = opts.dateTo;
    }

    const records = await prisma.pieceRateRecord.findMany({
      where,
      select: { employeeId: true, employeeName: true, amount: true, status: true },
    });

    const summary: Record<string, { employeeId: string; employeeName: string | null; totalAmount: number; pendingAmount: number; confirmedAmount: number; paidAmount: number }> = {};
    for (const r of records) {
      const key = r.employeeId ?? 'unknown';
      if (!summary[key]) {
        summary[key] = { employeeId: key, employeeName: r.employeeName, totalAmount: 0, pendingAmount: 0, confirmedAmount: 0, paidAmount: 0 };
      }
      const amt = Number(r.amount);
      summary[key].totalAmount += amt;
      if (r.status === 'Pending') summary[key].pendingAmount += amt;
      if (r.status === 'Confirmed') summary[key].confirmedAmount += amt;
      if (r.status === 'Paid') summary[key].paidAmount += amt;
    }

    return Object.values(summary);
  }

  async function deletePieceRateRecord(id: string, actorId: string): Promise<void> {
    const existing = await prisma.pieceRateRecord.findFirst({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) throw new Error(`计件记录 ${id} 不存在`);
    if (existing.status === 'Paid') throw new Error(`已支付记录不可删除`);

    await prisma.pieceRateRecord.delete({ where: { id } });
    logger.info('[MesService] piece rate record deleted', { id, actorId });
  }

  // ────────────────────────────────────────────────────────────
  // 6. OutsourcingOrder
  // ────────────────────────────────────────────────────────────

  async function createOutsourcingOrder(input: OutsourcingOrderInput, actorId: string) {
    validateOutsourcingProcessType(input.processType);

    const existing = await prisma.outsourcingOrder.findFirst({
      where: { orderNumber: input.orderNumber, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new Error(`外协单号 ${input.orderNumber} 已存在`);

    const ts = now();
    const totalAmount = round4(input.quantity * input.unitPrice);

    const order = await prisma.$transaction(async (tx) => {
      const o = await tx.outsourcingOrder.create({
        data: {
          id: generateOutsourcingId(),
          orderNumber: input.orderNumber,
          supplierId: input.supplierId ?? null,
          orderId: input.orderId ?? null,
          bomId: input.bomId ?? null,
          processType: input.processType,
          description: input.description ?? null,
          quantity: round4(input.quantity),
          unit: input.unit,
          unitPrice: round4(input.unitPrice),
          currency: input.currency ?? 'CNY',
          totalAmount,
          orderDate: input.orderDate ?? todayLocalKey(),
          plannedDeliveryDate: input.plannedDeliveryDate ?? null,
          status: 'Draft',
          notes: input.notes ?? null,
          createdAt: ts,
          updatedAt: ts,
        },
        include: { lines: true },
      });

      // 创建行明细
      if (input.lines && input.lines.length > 0) {
        for (const line of input.lines) {
          validateOutsourcingProcessType(line.processType);
          const lineAmount = round4(line.quantity * line.unitPrice);
          await tx.outsourcingLine.create({
            data: {
              id: generateOutsourcingLineId(),
              outsourcingOrderId: o.id,
              processType: line.processType,
              description: line.description,
              materialCode: line.materialCode ?? null,
              quantity: round4(line.quantity),
              unit: line.unit,
              unitPrice: round4(line.unitPrice),
              amount: lineAmount,
              createdAt: ts,
              updatedAt: ts,
            },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          id: `AUD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          action: 'MES_OSO_CREATE',
          actorId,
          targetType: 'OutsourcingOrder',
          targetId: o.id,
          detail: { source: 'api:mes', after: { orderNumber: o.orderNumber, supplierId: o.supplierId, totalAmount: o.totalAmount } } as any,
        },
      });

      // 阶段 D / D5：外协单 FK 入图（EntityLink），与写入同事务
      await syncOutsourcingOrderReferences(prisma, o, { source: 'api:mes' }, tx);

      return tx.outsourcingOrder.findUnique({ where: { id: o.id }, include: { lines: true } });
    });

    if (!order) {
      // 理论不可达：事务内刚创建，findUnique 应返回非空
      throw new Error('外协单创建后查询失败（数据不一致）');
    }

    logger.info('[MesService] outsourcing order created', { id: order.id, orderNumber: order.orderNumber, actorId });
    return order;
  }

  async function updateOutsourcingOrder(id: string, input: Partial<OutsourcingOrderInput>, actorId: string) {
    const ts = now();
    const existing = await prisma.outsourcingOrder.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`外协单 ${id} 不存在`);
    if (existing.status !== 'Draft') {
      throw new Error(`外协单 ${id} 状态为 ${existing.status}，仅 Draft 可编辑`);
    }

    if (input.processType) validateOutsourcingProcessType(input.processType);

    // 重新计算 totalAmount
    const quantity = input.quantity !== undefined ? input.quantity : Number(existing.quantity);
    const unitPrice = input.unitPrice !== undefined ? input.unitPrice : Number(existing.unitPrice);
    const totalAmount = round4(quantity * unitPrice);

    const updated = await prisma.outsourcingOrder.update({
      where: { id },
      data: {
        ...(input.supplierId !== undefined && { supplierId: input.supplierId }),
        ...(input.orderId !== undefined && { orderId: input.orderId }),
        ...(input.bomId !== undefined && { bomId: input.bomId }),
        ...(input.processType !== undefined && { processType: input.processType }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.quantity !== undefined && { quantity: round4(input.quantity) }),
        ...(input.unit !== undefined && { unit: input.unit }),
        ...(input.unitPrice !== undefined && { unitPrice: round4(input.unitPrice) }),
        ...(input.currency !== undefined && { currency: input.currency }),
        ...(input.plannedDeliveryDate !== undefined && { plannedDeliveryDate: input.plannedDeliveryDate }),
        ...(input.notes !== undefined && { notes: input.notes }),
        totalAmount,
        updatedAt: ts,
      },
      include: { lines: true },
    });

    // 阶段 D / D5：外协单 FK 入图（EntityLink）
    await syncOutsourcingOrderReferences(prisma, updated, { source: 'api:mes' });

    logger.info('[MesService] outsourcing order updated', { id, actorId });
    return updated;
  }

  async function deleteOutsourcingOrder(id: string, actorId: string): Promise<void> {
    const ts = now();
    const existing = await prisma.outsourcingOrder.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!existing) throw new Error(`外协单 ${id} 不存在`);
    if (existing.status !== 'Draft') throw new Error(`外协单 ${id} 状态为 ${existing.status}，仅 Draft 可删除`);

    await prisma.outsourcingOrder.update({
      where: { id },
      data: { deletedAt: ts, updatedAt: ts },
    });

    // 阶段 D / D5：软删联动 — 发出的图谱关联同步停用
    await deactivateEntityLinks(prisma, 'outsourcingOrder', id, ts);

    logger.info('[MesService] outsourcing order soft-deleted', { id, actorId });
  }

  async function listOutsourcingOrders(opts: {
    supplierId?: string;
    orderId?: string;
    status?: string;
    processType?: string;
    readScopeWhere?: Prisma.OutsourcingOrderWhereInput;
  } & MesListPage = {}) {
    const where: Record<string, unknown> = { deletedAt: null, businessOwnerId: null, approvedCommitmentRevisionId: null };
    if (opts.readScopeWhere) where.AND = [opts.readScopeWhere];
    if (opts.supplierId) where.supplierId = opts.supplierId;
    if (opts.orderId) where.orderId = opts.orderId;
    if (opts.status) where.status = opts.status;
    if (opts.processType) where.processType = opts.processType;

    const [items, total] = await Promise.all([
      prisma.outsourcingOrder.findMany({
        where,
        include: { lines: true },
        orderBy: { createdAt: 'desc' },
        ...pageArgs(opts),
      }),
      prisma.outsourcingOrder.count({ where }),
    ]);
    return { items, total };
  }

  async function getOutsourcingOrder(id: string, readScopeWhere?: Prisma.OutsourcingOrderWhereInput) {
    return prisma.outsourcingOrder.findFirst({
      where: { id, deletedAt: null, businessOwnerId: null, approvedCommitmentRevisionId: null, ...(readScopeWhere ? { AND: [readScopeWhere] } : {}) },
      include: { lines: true },
    });
  }

  /** 外协状态流转 */
  async function transitionOutsourcingStatus(id: string, toStatus: OutsourcingStatus, actorId: string) {
    if (toStatus === 'Received') throw Object.assign(new Error('请通过到货验收登记合格与拒收数量，不能直接改为已收货'), { code: 'VALIDATION_FAILED', status: 400, statusCode: 400 });
    validateOutsourcingStatus(toStatus);
    const ts = now();

    const existing = await prisma.outsourcingOrder.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`外协单 ${id} 不存在`);

    const fromStatus = existing.status as OutsourcingStatus;
    const allowed = OUTSOURCING_TRANSITIONS[fromStatus] ?? [];
    if (!allowed.includes(toStatus)) {
      throw new Error(`非法状态转换: ${fromStatus} → ${toStatus}`);
    }

    const data: Record<string, unknown> = { status: toStatus, updatedAt: ts };

    const updated = await prisma.outsourcingOrder.update({ where: { id }, data });

    // 事件发布（fire-and-forget）
    const eventType = toStatus === 'Sent' ? 'OutsourcingSent'
      : toStatus === 'Confirmed' ? 'OutsourcingConfirmed'
      : toStatus === 'InProduction' ? 'OutsourcingInProduction'
      : null;

    if (eventType) {
      businessEventBus.publish({
        type: eventType,
        sourceEntityType: 'OutsourcingOrder',
        sourceEntityId: id,
        orderId: existing.orderId ?? undefined,
        payload: { orderNumber: existing.orderNumber, fromStatus, toStatus, supplierId: existing.supplierId },
        actorId,
        timestamp: Date.now(),
      } as any).catch((err) => logger.warn('[MesService] event publish failed', { eventType, id, err }));
    }

    logger.info('[MesService] outsourcing status transitioned', { id, fromStatus, toStatus, actorId });
    return updated;
  }

  /** 外协到货验收 */
  async function receiveOutsourcing(id: string, opts: {
    qualityAcceptedQty: number;
    qualityRejectedQty?: number;
  }, actorId: string) {
    for (const [label, value] of [['合格数量', opts.qualityAcceptedQty], ['拒收数量', opts.qualityRejectedQty ?? 0]] as const) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Math.abs(value * 10000 - Math.round(value * 10000)) > 0.000001) {
        throw Object.assign(new Error(`${label}必须为非负有限数字，最多四位小数`), { code: 'VALIDATION_FAILED', status: 400, statusCode: 400 });
      }
    }
    const ts = now();
    const existing = await prisma.outsourcingOrder.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, quantity: true, orderId: true, orderNumber: true },
    });
    if (!existing) throw new Error(`外协单 ${id} 不存在`);
    if (existing.status !== 'InProduction') {
      throw new Error(`外协单 ${id} 状态为 ${existing.status}，仅 InProduction 可验收`);
    }

    const accepted = round4(opts.qualityAcceptedQty);
    const rejected = round4(opts.qualityRejectedQty ?? 0);
    const totalReceived = accepted + rejected;
    const ordered = Number(existing.quantity);

    if (totalReceived <= 0) throw Object.assign(new Error('验收合计必须大于零'), { code: 'VALIDATION_FAILED', status: 400, statusCode: 400 });
    if (totalReceived > ordered + 0.00001) {
      throw Object.assign(new Error(`验收数量 ${totalReceived} 超过订单数量 ${ordered}`), { code: 'VALIDATION_FAILED', status: 400, statusCode: 400 });
    }
    if (Math.abs(totalReceived - ordered) > 0.00001) {
      throw Object.assign(new Error('当前整单验收要求合格与拒收合计等于计划数量；分批验收尚未启用，请勿将部分到货结为整单完成'), { code: 'VALIDATION_FAILED', status: 400, statusCode: 400 });
    }

    const updated = await prisma.outsourcingOrder.update({
      where: { id, status: 'InProduction', deletedAt: null },
      data: {
        qualityAcceptedQty: accepted,
        qualityRejectedQty: rejected,
        status: 'Received',
        actualDeliveryDate: todayLocalKey(),
        updatedAt: ts,
      },
    });

    // 事件发布
    businessEventBus.publish({
      type: 'OutsourcingReceived',
      sourceEntityType: 'OutsourcingOrder',
      sourceEntityId: id,
      orderId: (existing as any).orderId ?? undefined,
      payload: { acceptedQty: accepted, rejectedQty: rejected, orderNumber: (existing as any).orderNumber },
      actorId,
      timestamp: Date.now(),
    } as any).catch((err) => logger.warn('[MesService] event publish failed', { id, err }));

    logger.info('[MesService] outsourcing received', { id, accepted, rejected, actorId });
    return updated;
  }

  return {
    // WorkStation
    createWorkStation,
    updateWorkStation,
    deleteWorkStation,
    listWorkStations,
    getWorkStation,
    getWorkStationUtilization,
    // ProductionPlan
    createProductionPlan,
    updateProductionPlan,
    deleteProductionPlan,
    listProductionPlans,
    getProductionPlan,
    transitionPlanStatus,
    updatePlanProgress,
    // WorkHour
    createWorkHour,
    listWorkHours,
    getWorkHourSummary,
    deleteWorkHour,
    // PieceRateRule
    createPieceRateRule,
    updatePieceRateRule,
    deletePieceRateRule,
    listPieceRateRules,
    // PieceRateRecord
    createPieceRateRecord,
    listPieceRateRecords,
    transitionPieceRateStatus,
    getPiceRateSummary,
    deletePieceRateRecord,
    // OutsourcingOrder
    createOutsourcingOrder: legacySupplierMutation(createOutsourcingOrder),
    updateOutsourcingOrder: legacySupplierMutation(updateOutsourcingOrder),
    deleteOutsourcingOrder: legacySupplierMutation(deleteOutsourcingOrder),
    listOutsourcingOrders,
    getOutsourcingOrder,
    transitionOutsourcingStatus: legacySupplierMutation(transitionOutsourcingStatus),
    receiveOutsourcing: legacySupplierMutation(receiveOutsourcing),
  };
}
