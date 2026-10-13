/**
 * BOM / 成本核算服务 BOM Service
 *
 * 职责：
 *   1. BOM CRUD（含物料行明细 + 成本估算项，事务内创建/更新）
 *   2. 状态流转：Draft → Confirmed → Archived
 *   3. 成本汇总自动计算：物料成本 + 人工成本 + 制造费用 = 总成本
 *   4. 利润分析：sellingPrice → profitAmount / profitMargin
 *   5. 业务事件发布（BOMConfirmed / BOMCostCalculated）
 *   6. 版本管理：Confirmed 后修订生成新版本
 *
 * 设计原则：
 *   - 软删除（deletedAt BigInt），不物理删除
 *   - 事务内创建 BOM + 行 + 成本项 + 审计日志
 *   - 行金额自动计算：effectiveQty = quantity * (1 + wastage%)；amount = effectiveQty * unitCost
 *   - 状态转换有严格校验（非法转换抛错，fail-closed）
 *   - 事件发布失败不阻断业务（fire-and-forget）
 */

import { PrismaClient, BOM, BOMLine, CostEstimate } from '@prisma/client';
import { logger } from '../lib/logger';
import { businessEventBus } from '../events/businessEventBus';
import { deactivateEntityLinks, syncBomReferences } from '../entities/sync';

// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export type MaterialType = 'Main' | 'Contrast' | 'Lining' | 'Pocketing' | 'Trimmings' | 'Thread' | 'Packaging' | 'Other';
export type CostType = 'Material' | 'Labor' | 'Overhead' | 'Other';
export type BOMStatus = 'Draft' | 'Confirmed' | 'Archived';

export interface BOMLineInput {
  materialType: MaterialType;
  materialCode?: string;
  description: string;
  category?: string;
  specification?: string;
  supplierId?: string;
  quantity: number;
  unit: string;
  wastagePercent?: number; // 损耗率 %
  unitCost: number;
  notes?: string;
}

export interface CostEstimateInput {
  costType: CostType;
  description: string;
  amount: number;
  notes?: string;
}

import { nextBusinessNumber } from '../shared/businessNumberService';

import { buildOrderLinkedScope } from '../auth/orderVisibility';
export interface CreateBOMInput {
  /** BOM 编号（可选，服务端自动生成 BOM-YYYY-NNNN；传入时优先使用传入值并校验唯一性） */
  bomNumber?: string;
  description: string;
  productAssetId?: string;
  orderId?: string;
  quotationId?: string;
  currency?: string;
  sellingPrice?: number;
  notes?: string;
  lines: BOMLineInput[];
  costEstimates?: CostEstimateInput[];
}

export interface UpdateBOMInput extends Partial<CreateBOMInput> {
  status?: string;
}

export interface BOMDetail extends BOM {
  lines: BOMLine[];
  costEstimates: CostEstimate[];
}

// ────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────

const VALID_MATERIAL_TYPES: MaterialType[] = ['Main', 'Contrast', 'Lining', 'Pocketing', 'Trimmings', 'Thread', 'Packaging', 'Other'];
const VALID_COST_TYPES: CostType[] = ['Material', 'Labor', 'Overhead', 'Other'];

// 状态转换矩阵：key → 允许的目标状态
const TRANSITIONS: Record<string, BOMStatus[]> = {
  Draft: ['Confirmed', 'Archived'],
  Confirmed: ['Archived'],
  Archived: [], // 终态
};

// ────────────────────────────────────────────────────────────────
// 辅助函数
// ────────────────────────────────────────────────────────────────

function generateBOMId(): string {
  return `BOM_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateLineId(): string {
  return `BL_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateCostId(): string {
  return `CE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 实际用量 = quantity * (1 + wastage%) */
export function calcEffectiveQty(quantity: number, wastagePercent: number): number {
  return round4(quantity * (1 + wastagePercent / 100));
}

/** 行金额 = effectiveQty * unitCost */
export function calcLineAmount(effectiveQty: number, unitCost: number): number {
  return round4(effectiveQty * unitCost);
}

function validateMaterialType(type: string): asserts type is MaterialType {
  if (!VALID_MATERIAL_TYPES.includes(type as MaterialType)) {
    throw new Error(`非法物料类型：${type}（允许：${VALID_MATERIAL_TYPES.join(', ')}）`);
  }
}

function validateCostType(type: string): asserts type is CostType {
  if (!VALID_COST_TYPES.includes(type as CostType)) {
    throw new Error(`非法成本类型：${type}（允许：${VALID_COST_TYPES.join(', ')}）`);
  }
}

/**
 * 汇总成本：
 *   - totalMaterialCost = BOMLine 中 category 属于 Fabric/Trimmings/Accessories 的行金额 + CostEstimate(Material)
 *   - totalLaborCost = CostEstimate(Labor)
 *   - totalOverheadCost = CostEstimate(Overhead) + CostEstimate(Other)
 *   - totalCost = 物料 + 人工 + 费用
 */
export function aggregateCosts(lines: BOMLineInput[], costEstimates: CostEstimateInput[]) {
  // 物料成本 = 行金额合计（所有 BOMLine 都是物料）+ CostEstimate(Material)
  const lineMaterialCost = lines.reduce((sum, l) => {
    const eff = calcEffectiveQty(l.quantity, l.wastagePercent ?? 0);
    return sum + calcLineAmount(eff, l.unitCost);
  }, 0);
  const extraMaterialCost = costEstimates
    .filter(c => c.costType === 'Material')
    .reduce((s, c) => s + c.amount, 0);
  const totalMaterialCost = round4(lineMaterialCost + extraMaterialCost);

  const totalLaborCost = round4(
    costEstimates.filter(c => c.costType === 'Labor').reduce((s, c) => s + c.amount, 0),
  );

  const totalOverheadCost = round4(
    costEstimates
      .filter(c => c.costType === 'Overhead' || c.costType === 'Other')
      .reduce((s, c) => s + c.amount, 0),
  );

  const totalCost = round4(totalMaterialCost + totalLaborCost + totalOverheadCost);

  return { totalMaterialCost, totalLaborCost, totalOverheadCost, totalCost };
}

/** 利润分析：sellingPrice - totalCost */
function calcProfit(sellingPrice: number | undefined, totalCost: number) {
  if (sellingPrice == null) return { profitAmount: null, profitMargin: null };
  const profitAmount = round4(sellingPrice - totalCost);
  const profitMargin = sellingPrice > 0 ? round4((profitAmount / sellingPrice) * 100) : 0;
  return { profitAmount, profitMargin };
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createBOMService(prisma: PrismaClient) {
  // ════════════════════════════════════════
  // createBOM
  // ════════════════════════════════════════

  async function createBOM(input: CreateBOMInput, actorId: string): Promise<BOMDetail> {
    // 校验 bomNumber 唯一（仅在传入时校验；未传入时服务端自动生成，无重号风险）
    if (input.bomNumber) {
      const existing = await prisma.bOM.findUnique({ where: { bomNumber: input.bomNumber } });
      if (existing && !existing.deletedAt) {
        throw new Error(`BOM 编号 ${input.bomNumber} 已存在`);
      }
    }

    // 校验行明细
    if (!input.lines || input.lines.length === 0) {
      throw new Error('BOM 至少需要一行物料明细');
    }
    for (const line of input.lines) {
      validateMaterialType(line.materialType);
    }
    const costEstimates = input.costEstimates ?? [];
    for (const ce of costEstimates) {
      validateCostType(ce.costType);
    }

    const now = Date.now();
    const currency = input.currency ?? 'CNY';
    const { totalMaterialCost, totalLaborCost, totalOverheadCost, totalCost } = aggregateCosts(input.lines, costEstimates);
    const { profitAmount, profitMargin } = calcProfit(input.sellingPrice, totalCost);

    const bom = await prisma.$transaction(async (tx) => {
      // PRD 5.6：服务端自动生成 BOM 编号（BOM-YYYY-NNNN），传入时优先使用传入值
      const bomNumber = input.bomNumber || await nextBusinessNumber(tx, 'BOM', undefined, {
        occupied: async (num) => (await tx.bOM.findFirst({ where: { bomNumber: num }, select: { id: true } })) != null,
      });
      const created = await tx.bOM.create({
        data: {
          id: generateBOMId(),
          bomNumber,
          status: 'Draft',
          description: input.description,
          productAssetId: input.productAssetId ?? null,
          orderId: input.orderId ?? null,
          quotationId: input.quotationId ?? null,
          version: 1,
          parentBomId: null,
          totalMaterialCost,
          totalLaborCost,
          totalOverheadCost,
          totalCost,
          currency,
          sellingPrice: input.sellingPrice ?? null,
          profitMargin: profitMargin ?? null,
          profitAmount: profitAmount ?? null,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
        },
        include: { lines: true, costEstimates: true },
      });

      // 创建物料行
      await tx.bOMLine.createMany({
        data: input.lines.map((l, i) => {
          const eff = calcEffectiveQty(l.quantity, l.wastagePercent ?? 0);
          const amount = calcLineAmount(eff, l.unitCost);
          return {
            id: generateLineId(),
            bomId: created.id,
            lineNumber: i + 1,
            materialType: l.materialType,
            materialCode: l.materialCode ?? null,
            description: l.description,
            category: l.category ?? null,
            specification: l.specification ?? null,
            supplierId: l.supplierId ?? null,
            quantity: l.quantity,
            unit: l.unit,
            wastagePercent: l.wastagePercent ?? 0,
            effectiveQty: eff,
            unitCost: l.unitCost,
            amount,
            currency,
            notes: l.notes ?? null,
            createdAt: now,
            updatedAt: now,
          };
        }),
      });

      // 创建成本估算项
      if (costEstimates.length > 0) {
        await tx.costEstimate.createMany({
          data: costEstimates.map(ce => ({
            id: generateCostId(),
            bomId: created.id,
            costType: ce.costType,
            description: ce.description,
            amount: ce.amount,
            currency,
            notes: ce.notes ?? null,
            createdAt: now,
            updatedAt: now,
          })),
        });
      }

      // 审计日志
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'create_bom',
          targetType: 'BOM',
          targetId: created.id,
          detail: {
            source: 'api:bom',
            after: { bomNumber: input.bomNumber, description: input.description, totalCost, lineCount: input.lines.length },
          } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      // EntityLink 图谱：forOrder / aboutProduct / fromQuotation
      await syncBomReferences(prisma, created, { source: 'api:bom' }, tx);

      // 重新查询返回完整明细
      return tx.bOM.findUnique({
        where: { id: created.id },
        include: { lines: { orderBy: { lineNumber: 'asc' } }, costEstimates: { orderBy: { createdAt: 'asc' } } },
      });
    });

    logger.info('[BOMService] BOM created', { id: bom?.id, bomNumber: input.bomNumber, totalCost });
    return bom as unknown as BOMDetail;
  }

  // ════════════════════════════════════════
  // getBOM
  // ════════════════════════════════════════

  async function getBOM(id: string): Promise<BOMDetail | null> {
    const bom = await prisma.bOM.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { lineNumber: 'asc' } },
        costEstimates: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!bom || bom.deletedAt) return null;
    return bom as unknown as BOMDetail;
  }

  // ════════════════════════════════════════
  // listBOMs
  // ════════════════════════════════════════

  async function listBOMs(params: {
    status?: string;
    productAssetId?: string;
    orderId?: string;
    quotationId?: string;
    search?: string;
    limit?: number;
    offset?: number;
    /** Excel 台账导出=true：忽略分页上限全量导出（route 层 format=xlsx 专用） */
    exportAll?: boolean;
    /**
     * §10.4.2 可见订单白名单（route 层解析注入）：BOM 随关联订单可见。
     * null/undefined = 不受限；空数组 = 一张都看不到。
     * 注：**无关联订单**的 BOM 不在白名单内 → 非全权角色看不到（fail-closed，
     * 「自建 BOM 怎么可见」待业务方确认）。
     */
    visibleOrderIds?: string[] | null;
  }): Promise<{ items: BOM[]; total: number }> {
    const where: any = { deletedAt: null };
    if (params.status) where.status = params.status;
    if (params.productAssetId) where.productAssetId = params.productAssetId;
    if (params.orderId) where.orderId = params.orderId;
    if (params.quotationId) where.quotationId = params.quotationId;
    if (params.search) {
      where.OR = [
        { bomNumber: { contains: params.search } },
        { description: { contains: params.search } },
      ];
    }
    // §10.4.2：可见订单白名单用 AND 叠加（顶层 OR 已被 search 占用）。
    // **无关联订单**的 BOM（自建 / 只挂产品档案，B-2 允许留空）不按订单收窄——
    // 否则业务员刚建好的成本核算表会立刻从列表消失；这类 BOM 走产品档案的
    // 「图书馆」口径（全员可查），成本字段仍受 sensitive:cost 遮罩。
    // 待业务方确认：若要更严（仅全权角色可见无订单 BOM），去掉 { orderId: null } 即可。
    if (params.visibleOrderIds) {
      const linked = buildOrderLinkedScope(params.visibleOrderIds, 'orderId');
      where.AND = [...(where.AND ?? []), { OR: [linked, { orderId: null }] }];
    }

    const limit = params.exportAll ? undefined : Math.min(params.limit ?? 100, 500);
    const offset = params.exportAll ? 0 : (params.offset ?? 0);

    const [items, total] = await Promise.all([
      prisma.bOM.findMany({
        where,
        include: { lines: { select: { id: true } } },
        orderBy: { updatedAt: 'desc' },
        ...(limit != null ? { take: limit, skip: offset } : {}),
      }),
      prisma.bOM.count({ where }),
    ]);

    return { items, total };
  }

  // ════════════════════════════════════════
  // updateBOM（仅 Draft 可编辑）
  // ════════════════════════════════════════

  async function updateBOM(id: string, input: UpdateBOMInput, actorId: string): Promise<BOMDetail> {
    const existing = await prisma.bOM.findUnique({ where: { id }, include: { lines: true, costEstimates: true } });
    if (!existing || existing.deletedAt) throw new Error(`BOM ${id} 不存在`);
    if (existing.status !== 'Draft') {
      throw new Error(`仅 Draft 状态可编辑（当前：${existing.status}）`);
    }

    // 校验行明细（若提供）
    const newLines = input.lines ?? null;
    if (newLines !== null) {
      if (newLines.length === 0) throw new Error('BOM 至少需要一行物料明细');
      for (const line of newLines) {
        validateMaterialType(line.materialType);
      }
    }
    const newCostEstimates = input.costEstimates ?? null;
    if (newCostEstimates !== null) {
      for (const ce of newCostEstimates) {
        validateCostType(ce.costType);
      }
    }

    const now = Date.now();
    const linesForCalc = newLines ?? (existing.lines as unknown as BOMLineInput[]);
    const costsForCalc = newCostEstimates ?? (existing.costEstimates as unknown as CostEstimateInput[]);
    const { totalMaterialCost, totalLaborCost, totalOverheadCost, totalCost } = aggregateCosts(linesForCalc, costsForCalc);
    const sellingPrice = input.sellingPrice ?? (existing.sellingPrice != null ? Number(existing.sellingPrice) : undefined);
    const { profitAmount, profitMargin } = calcProfit(sellingPrice, totalCost);
    const currency = input.currency ?? existing.currency;

    const updated = await prisma.$transaction(async (tx) => {
      const bom = await tx.bOM.update({
        where: { id },
        data: {
          description: input.description ?? undefined,
          productAssetId: input.productAssetId ?? undefined,
          orderId: input.orderId ?? undefined,
          quotationId: input.quotationId ?? undefined,
          sellingPrice: input.sellingPrice ?? undefined,
          notes: input.notes ?? undefined,
          totalMaterialCost,
          totalLaborCost,
          totalOverheadCost,
          totalCost,
          currency,
          profitMargin: profitMargin ?? null,
          profitAmount: profitAmount ?? null,
          updatedAt: now,
        },
        include: { lines: true, costEstimates: true },
      });

      // 行明细替换（若提供）
      if (newLines !== null) {
        await tx.bOMLine.deleteMany({ where: { bomId: id } });
        await tx.bOMLine.createMany({
          data: newLines.map((l, i) => {
            const eff = calcEffectiveQty(l.quantity, l.wastagePercent ?? 0);
            const amount = calcLineAmount(eff, l.unitCost);
            return {
              id: generateLineId(),
              bomId: id,
              lineNumber: i + 1,
              materialType: l.materialType,
              materialCode: l.materialCode ?? null,
              description: l.description,
              category: l.category ?? null,
              specification: l.specification ?? null,
              supplierId: l.supplierId ?? null,
              quantity: l.quantity,
              unit: l.unit,
              wastagePercent: l.wastagePercent ?? 0,
              effectiveQty: eff,
              unitCost: l.unitCost,
              amount,
              currency,
              notes: l.notes ?? null,
              createdAt: now,
              updatedAt: now,
            };
          }),
        });
      }

      // 成本估算项替换（若提供）
      if (newCostEstimates !== null) {
        await tx.costEstimate.deleteMany({ where: { bomId: id } });
        if (newCostEstimates.length > 0) {
          await tx.costEstimate.createMany({
            data: newCostEstimates.map(ce => ({
              id: generateCostId(),
              bomId: id,
              costType: ce.costType,
              description: ce.description,
              amount: ce.amount,
              currency,
              notes: ce.notes ?? null,
              createdAt: now,
              updatedAt: now,
            })),
          });
        }
      }

      // 审计日志
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'update_bom',
          targetType: 'BOM',
          targetId: id,
          detail: {
            source: 'api:bom',
            after: { totalCost, totalMaterialCost, totalLaborCost, totalOverheadCost },
          } as any,
          ip: null,
          operationType: 'update',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      // EntityLink 图谱：FK 快照随 update 同步
      await syncBomReferences(prisma, bom, { source: 'api:bom' }, tx);

      return tx.bOM.findUnique({
        where: { id },
        include: { lines: { orderBy: { lineNumber: 'asc' } }, costEstimates: { orderBy: { createdAt: 'asc' } } },
      });
    });

    logger.info('[BOMService] BOM updated', { id, totalCost });
    return updated as unknown as BOMDetail;
  }

  // ════════════════════════════════════════
  // deleteBOM（仅 Draft 可删除）
  // ════════════════════════════════════════

  async function deleteBOM(id: string, actorId: string): Promise<void> {
    const existing = await prisma.bOM.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`BOM ${id} 不存在`);
    if (existing.status !== 'Draft') {
      throw new Error(`仅 Draft 状态可删除（当前：${existing.status}）`);
    }

    const now = Date.now();
    await prisma.$transaction(async (tx) => {
      await tx.bOM.update({ where: { id }, data: { deletedAt: now, updatedAt: now } });
      // EntityLink 图谱：软删同步失效发出的关联
      await deactivateEntityLinks(tx, 'bom', id, BigInt(now));
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'delete_bom',
          targetType: 'BOM',
          targetId: id,
          detail: { source: 'api:bom', before: { bomNumber: existing.bomNumber } } as any,
          ip: null,
          operationType: 'delete',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });
    });
  }

  // ════════════════════════════════════════
  // confirmBOM (Draft → Confirmed)
  // ════════════════════════════════════════

  async function confirmBOM(id: string, actorId: string): Promise<BOMDetail> {
    const existing = await prisma.bOM.findUnique({
      where: { id },
      include: { lines: true, costEstimates: true },
    });
    if (!existing || existing.deletedAt) throw new Error(`BOM ${id} 不存在`);

    const allowed = TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes('Confirmed')) {
      throw new Error(`非法状态转换：${existing.status} → Confirmed（允许：${allowed.join(', ') || '无'}）`);
    }

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      const bom = await tx.bOM.update({
        where: { id },
        data: { status: 'Confirmed', updatedAt: now },
        include: { lines: true, costEstimates: true },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'confirm_bom',
          targetType: 'BOM',
          targetId: id,
          detail: { source: 'api:bom', after: { status: 'Confirmed' } } as any,
          ip: null,
          operationType: 'transition',
          fieldPath: 'status',
          beforeValue: existing.status as any,
          afterValue: 'Confirmed' as any,
          transactionId: null,
        },
      });

      return bom;
    });

    // 事务提交后发布事件
    try {
      businessEventBus.publish({
        id: `bev_bom_confirmed_${now}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'BOMConfirmed',
        sourceEntityType: 'BOM',
        sourceEntityId: id,
        payload: {
          bomId: id,
          bomNumber: existing.bomNumber,
          description: existing.description,
          totalCost: Number(existing.totalCost),
          totalMaterialCost: Number(existing.totalMaterialCost),
          totalLaborCost: Number(existing.totalLaborCost),
          totalOverheadCost: Number(existing.totalOverheadCost),
          currency: existing.currency,
          orderId: existing.orderId,
          lineCount: existing.lines.length,
        },
        occurredAt: now,
        actorId: actorId || 'system',
      });
    } catch (e: any) {
      logger.warn('[BOMService] BOMConfirmed event publish failed (non-blocking)', { error: e?.message });
    }

    logger.info('[BOMService] BOM confirmed', { id, bomNumber: existing.bomNumber });
    return updated as unknown as BOMDetail;
  }

  // ════════════════════════════════════════
  // archiveBOM (Draft/Confirmed → Archived)
  // ════════════════════════════════════════

  async function archiveBOM(id: string, actorId: string): Promise<BOMDetail> {
    const existing = await prisma.bOM.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`BOM ${id} 不存在`);

    const allowed = TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes('Archived')) {
      throw new Error(`非法状态转换：${existing.status} → Archived（允许：${allowed.join(', ') || '无'}）`);
    }

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      const bom = await tx.bOM.update({
        where: { id },
        data: { status: 'Archived', updatedAt: now },
        include: { lines: true, costEstimates: true },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'archive_bom',
          targetType: 'BOM',
          targetId: id,
          detail: { source: 'api:bom', after: { status: 'Archived' } } as any,
          ip: null,
          operationType: 'transition',
          fieldPath: 'status',
          beforeValue: existing.status as any,
          afterValue: 'Archived' as any,
          transactionId: null,
        },
      });

      return bom;
    });

    logger.info('[BOMService] BOM archived', { id });
    return updated as unknown as BOMDetail;
  }

  // ════════════════════════════════════════
  // recalculateCost — 重新汇总成本（Draft 状态）
  // ════════════════════════════════════════

  // ══════════════════════════════════════════════════════════
  // reviseBOM — 修订出新版（Confirmed → 原 BOM 归档 + 新 Draft v+1）
  // ══════════════════════════════════════════════════════════

  /**
   * 修订出新版（版本链落地，兑现 schema parentBomId 设计）：
   *   1. 原 BOM（Confirmed）归档——已确认基线不可篡改，修订走新版本；
   *   2. 事务内复制头 + 物料行 + 成本估算项 → 新 BOM（Draft，version+1，
   *      parentBomId 指回原 BOM，编号服务端自动生成 BOM-YYYY-NNNN）；
   *   3. 新版为 Draft 状态，走既有编辑/确认路径；审计 + EntityLink 同步。
   * 仅 Confirmed 可修订：Draft 直接编辑即可，Archived 为终态。
   */
  async function reviseBOM(id: string, actorId: string): Promise<BOMDetail> {
    const existing = await prisma.bOM.findUnique({
      where: { id },
      include: { lines: true, costEstimates: true },
    });
    if (!existing || existing.deletedAt) throw new Error(`BOM ${id} 不存在`);
    if (existing.status !== 'Confirmed') {
      throw new Error(`仅 Confirmed 状态可修订出新版（当前：${existing.status}；Draft 可直接编辑）`);
    }

    const now = Date.now();
    const revised = await prisma.$transaction(async (tx) => {
      // 1. 原 BOM 归档
      await tx.bOM.update({ where: { id }, data: { status: 'Archived', updatedAt: now } });

      // 2. 新版本：复制头 + 行 + 成本项
      const bomNumber = await nextBusinessNumber(tx, 'BOM', undefined, {
        occupied: async (num) => (await tx.bOM.findFirst({ where: { bomNumber: num }, select: { id: true } })) != null,
      });
      const created = await tx.bOM.create({
        data: {
          id: generateBOMId(),
          bomNumber,
          status: 'Draft',
          description: existing.description,
          productAssetId: existing.productAssetId,
          orderId: existing.orderId,
          quotationId: existing.quotationId,
          version: existing.version + 1,
          parentBomId: existing.id,
          totalMaterialCost: existing.totalMaterialCost,
          totalLaborCost: existing.totalLaborCost,
          totalOverheadCost: existing.totalOverheadCost,
          totalCost: existing.totalCost,
          currency: existing.currency,
          sellingPrice: existing.sellingPrice,
          profitMargin: existing.profitMargin,
          profitAmount: existing.profitAmount,
          notes: existing.notes,
          createdAt: now,
          updatedAt: now,
        },
      });

      await tx.bOMLine.createMany({
        data: existing.lines.map((l) => ({
          id: generateLineId(),
          bomId: created.id,
          lineNumber: l.lineNumber,
          materialType: l.materialType,
          materialCode: l.materialCode,
          description: l.description,
          category: l.category,
          specification: l.specification,
          supplierId: l.supplierId,
          quantity: l.quantity,
          unit: l.unit,
          wastagePercent: l.wastagePercent,
          effectiveQty: l.effectiveQty,
          unitCost: l.unitCost,
          amount: l.amount,
          currency: l.currency,
          notes: l.notes,
          createdAt: now,
          updatedAt: now,
        })),
      });

      if (existing.costEstimates.length > 0) {
        await tx.costEstimate.createMany({
          data: existing.costEstimates.map((ce) => ({
            id: generateCostId(),
            bomId: created.id,
            costType: ce.costType,
            description: ce.description,
            amount: ce.amount,
            currency: ce.currency,
            notes: ce.notes,
            createdAt: now,
            updatedAt: now,
          })),
        });
      }

      // 3. 审计：一次修订动作两头留痕（新 BOM 为 target，from/to 记版本链）
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'revise_bom',
          targetType: 'BOM',
          targetId: created.id,
          detail: {
            source: 'api:bom',
            after: {
              fromBomNumber: existing.bomNumber,
              toBomNumber: bomNumber,
              parentBomId: existing.id,
              version: existing.version + 1,
              archivedOriginal: true,
            },
          } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      // EntityLink 图谱：新 BOM 的 FK 快照
      await syncBomReferences(prisma, created, { source: 'api:bom' }, tx);

      return tx.bOM.findUnique({
        where: { id: created.id },
        include: {
          lines: { orderBy: { lineNumber: 'asc' } },
          costEstimates: { orderBy: { createdAt: 'asc' } },
        },
      });
    });

    logger.info('[BOMService] BOM revised', {
      fromId: id, toId: revised?.id, fromVersion: existing.version, toVersion: existing.version + 1,
    });
    return revised as unknown as BOMDetail;
  }

  async function recalculateCost(id: string, actorId: string): Promise<BOMDetail> {
    const existing = await prisma.bOM.findUnique({
      where: { id },
      include: { lines: true, costEstimates: true },
    });
    if (!existing || existing.deletedAt) throw new Error(`BOM ${id} 不存在`);
    if (existing.status !== 'Draft') {
      throw new Error(`仅 Draft 状态可重新计算（当前：${existing.status}）`);
    }

    const lines = existing.lines as unknown as BOMLineInput[];
    const costs = existing.costEstimates as unknown as CostEstimateInput[];
    const { totalMaterialCost, totalLaborCost, totalOverheadCost, totalCost } = aggregateCosts(lines, costs);
    const sellingPrice = existing.sellingPrice != null ? Number(existing.sellingPrice) : undefined;
    const { profitAmount, profitMargin } = calcProfit(sellingPrice, totalCost);
    const now = Date.now();

    const updated = await prisma.$transaction(async (tx) => {
      const bom = await tx.bOM.update({
        where: { id },
        data: {
          totalMaterialCost,
          totalLaborCost,
          totalOverheadCost,
          totalCost,
          profitMargin: profitMargin ?? null,
          profitAmount: profitAmount ?? null,
          updatedAt: now,
        },
        include: { lines: true, costEstimates: true },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'recalculate_bom_cost',
          targetType: 'BOM',
          targetId: id,
          detail: { source: 'api:bom', after: { totalCost, totalMaterialCost, totalLaborCost, totalOverheadCost } } as any,
          ip: null,
          operationType: 'update',
          fieldPath: 'totalCost',
          beforeValue: Number(existing.totalCost) as any,
          afterValue: totalCost as any,
          transactionId: null,
        },
      });

      return bom;
    });

    // 发布成本计算事件
    try {
      businessEventBus.publish({
        id: `bev_bom_cost_${now}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'BOMCostCalculated',
        sourceEntityType: 'BOM',
        sourceEntityId: id,
        payload: {
          bomId: id,
          bomNumber: existing.bomNumber,
          totalCost,
          totalMaterialCost,
          totalLaborCost,
          totalOverheadCost,
          profitAmount,
          profitMargin,
        },
        occurredAt: now,
        actorId: actorId || 'system',
      });
    } catch (e: any) {
      logger.warn('[BOMService] BOMCostCalculated event publish failed (non-blocking)', { error: e?.message });
    }

    logger.info('[BOMService] BOM cost recalculated', { id, totalCost });
    return updated as unknown as BOMDetail;
  }

  return {
    createBOM,
    getBOM,
    listBOMs,
    updateBOM,
    deleteBOM,
    confirmBOM,
    archiveBOM,
    reviseBOM,
    recalculateCost,
  };
}

export type BOMService = ReturnType<typeof createBOMService>;
