/**
 * 库存管理服务 Inventory Service
 *
 * 职责：
 *   1. 仓库 CRUD（多仓库支持）
 *   2. 库存物料 CRUD（按仓库+物料维度）
 *   3. 库存变动：入库/出库/调拨/盘点调整（事务内更新余额 + 写流水）
 *   4. 库存锁定/解锁（已分配未出库）
 *   5. 库存预警（低于最低库存 / 超过最高库存）
 *   6. 业务事件发布（StockLowAlarm / StockOverstockAlarm）
 *
 * 设计原则：
 *   - 软删除（deletedAt BigInt），不物理删除
 *   - 所有库存变动在事务内完成：更新余额 + 写流水 + 审计日志
 *   - 变动类型严格校验（Inbound 增 / Outbound 减 / Transfer 双仓 / Adjustment 任意）
 *   - 余额不可为负（Outbound 时校验 sufficient stock，fail-closed）
 *   - 事件发布失败不阻断业务（fire-and-forget）
 */

import { Prisma, PrismaClient, Warehouse, InventoryItem, StockMovement } from '@prisma/client';
import { logger } from '../lib/logger';
import { businessEventBus } from '../events/businessEventBus';
import { syncStockMovementReferences } from '../entities/sync';
import { isValidLocalDateKey, todayLocalKey } from '../shared/localDate';
import { convertLength } from '../lib/unitConversion';
import { businessError, httpStatusOfCode } from '../shared/errorCodes';

/** A known balance conflict must survive the transaction and HTTP boundaries. */
export class InventoryStockInsufficientError extends Error {
  readonly code = 'STOCK_INSUFFICIENT';
  readonly statusCode = httpStatusOfCode(this.code);
}

// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

// D7-②（2026-09-16）新增第三方仓/货代仓语义：
//   ThirdParty = 客户指定仓/第三方监管仓；Forwarder = 货代仓。
//   ⚠️ **货权不在仓上**（同一个第三方仓里可能同时有我方货权与已转移的货）——
//   货权标记在 `InventoryItem.ownership`，报表按货权汇总（见 inventoryOwnershipService）。
export type WarehouseType = 'Main' | 'Auxiliary' | 'Temporary' | 'Virtual' | 'ThirdParty' | 'Forwarder';

export interface WarehouseProfile {
  country?: string;
  region?: string;
  city?: string;
  custodianRelationId?: string;
  contactId?: string;
  responsibleUserId?: string;
  usage?: 'owned' | 'leased' | 'custody';
  temporary?: boolean;
  startDate?: string;
  endDate?: string;
  billingBasis?: 'none' | 'month' | 'day' | 'quantity' | 'agreement';
  rate?: number;
  currency?: string;
  billingNotes?: string;
  contractReference?: string;
}

export interface WarehouseInput {
  profile?: WarehouseProfile;
  code: string;
  name: string;
  type: WarehouseType;
  address?: string;
  manager?: string;
  phone?: string;
  isActive?: boolean;
  sortOrder?: number;
  notes?: string;
}

export type StockMovementType = 'Inbound' | 'Outbound' | 'Transfer' | 'Adjustment' | 'Lock' | 'Unlock';

export interface StockDetails {
  color?: string;
  dyeLot?: string;
  composition?: string;
  weightGsm?: number;
  widthCm?: number;
  rolls?: Array<{number:string;quantity:number}>;
  sizes?: Array<{size:string;quantity:number}>;
  packaging?: string;
}

export interface InventoryItemInput {
  receiptDate?: string;
  requestKey?: string;
  details?: StockDetails;
  warehouseId: string;
  productAssetId?: string;
  materialCode?: string;
  description: string;
  category?: string;
  specification?: string;
  batchNumber?: string;
  locationCode?: string;
  quantity: number;
  unit: string;
  unitCost?: number;
  currency?: string;
  minStock?: number;
  maxStock?: number;
  notes?: string;
}

export interface StockMovementInput {
  itemId: string;
  type: StockMovementType;
  quantity: number;
  unit?: string;
  unitCost?: number;
  targetWarehouseId?: string; // 仅 Transfer
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  movementDate?: string;
  notes?: string;
}

export interface InventoryItemDetail extends InventoryItem {
  warehouse?: Warehouse | null;
  movements?: StockMovement[];
}

// ────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────

export const VALID_MOVEMENT_TYPES: readonly StockMovementType[] = ['Inbound', 'Outbound', 'Transfer', 'Adjustment', 'Lock', 'Unlock'];

/** 库存变动可写字段白名单（route / Agent Flow 共用真源；字段语义见 StockMovementInput） */
export const STOCK_MOVEMENT_INPUT_FIELDS: readonly string[] = [
  'itemId', 'type', 'quantity', 'unit', 'unitCost', 'targetWarehouseId',
  'reason', 'referenceType', 'referenceId', 'movementDate', 'notes',
];

// ────────────────────────────────────────────────────────────────
// 辅助函数
// ────────────────────────────────────────────────────────────────

function generateWarehouseId(): string {
  return `WH_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateInventoryId(): string {
  return `INV_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateMovementId(): string {
  return `SM_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toDecimal(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function validateMovementType(type: string): asserts type is StockMovementType {
  if (!VALID_MOVEMENT_TYPES.includes(type as StockMovementType)) {
    throw new Error(`非法库存变动类型：${type}（允许：${VALID_MOVEMENT_TYPES.join(', ')}）`);
  }
}

/** 库存余额 CAS 重试上限（超限抛错 fail-closed；对齐 creditService MAX_SHIFT_CAS_ATTEMPTS 先例） */
const MAX_MOVEMENT_CAS_ATTEMPTS = 5;

/** 内部标记：CAS 守卫未命中（余额快照被并发事务推进）→ 令事务回滚，外层重读快照重试 */
class StockMovementCasConflictError extends Error {
  constructor(itemId: string) {
    super(`库存余额并发冲突（itemId=${itemId}）`);
    this.name = 'StockMovementCasConflictError';
  }
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createInventoryService(prisma: PrismaClient) {
  // ════════════════════════════════════════
  // 仓库 CRUD
  // ════════════════════════════════════════

  async function validateProfile(raw: WarehouseProfile | undefined): Promise<WarehouseProfile> {
    if (!raw) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('仓库档案格式无效');
    const allowed = ['country','region','city','custodianRelationId','contactId','responsibleUserId','usage','temporary','startDate','endDate','billingBasis','rate','currency','billingNotes','contractReference'];
    const profile = Object.fromEntries(Object.entries(raw).filter(([k])=>allowed.includes(k))) as WarehouseProfile;
    for (const [key,value] of Object.entries(profile)) {
      if (key === 'rate') { if(typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('费率必须为非负数'); }
      else if(key === 'temporary') { if(typeof value !== 'boolean') throw new Error('临时使用标记无效'); }
      else if(typeof value !== 'string' || value.length > 2000) throw new Error('仓库档案字段无效');
    }
    if(profile.usage && !['owned','leased','custody'].includes(profile.usage)) throw new Error('使用方式无效');
    if(profile.billingBasis && !['none','month','day','quantity','agreement'].includes(profile.billingBasis)) throw new Error('计费方式无效');
    for(const date of [profile.startDate,profile.endDate]) if(date && !isValidLocalDateKey(date)) throw new Error('使用日期无效');
    if(profile.startDate && profile.endDate && profile.startDate > profile.endDate) throw new Error('结束日期不能早于开始日期');
    if(profile.custodianRelationId && !await prisma.relation.findFirst({where:{id:profile.custodianRelationId,deletedAt:null,isOrganization:true}})) throw new Error('请选择有效保管组织');
    if(profile.contactId && (!profile.custodianRelationId || !await prisma.contact.findFirst({where:{id:profile.contactId,relationId:profile.custodianRelationId,deletedAt:null,status:'Active'}}))) throw new Error('联系人必须属于所选保管组织');
    if(profile.responsibleUserId && !await prisma.userAccount.findFirst({where:{id:profile.responsibleUserId,deletedAt:null,status:'active'}})) throw new Error('请选择有效员工账号');
    return profile;
  }

  async function createWarehouse(input: WarehouseInput, actorId: string): Promise<Warehouse> {
    const profile = await validateProfile(input.profile);
    const existing = await prisma.warehouse.findUnique({ where: { code: input.code } });
    if (existing && !existing.deletedAt) {
      throw new Error(`仓库编码 ${input.code} 已存在`);
    }

    const now = Date.now();
    const warehouse = await prisma.warehouse.create({
      data: {
        profile: profile as Prisma.InputJsonValue,
        id: generateWarehouseId(),
        code: input.code,
        name: input.name,
        type: input.type,
        address: input.address ?? null,
        manager: input.manager ?? null,
        phone: input.phone ?? null,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      },
    });

    await prisma.auditLog.create({
      data: {
        id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
        actorId: actorId || 'system',
        action: 'create_warehouse',
        targetType: 'Warehouse',
        targetId: warehouse.id,
        detail: { source: 'api:inventory', after: { code: input.code, name: input.name, type: input.type, profile } } as any,
        ip: null,
        operationType: 'create',
        fieldPath: null,
        beforeValue: null as any,
        afterValue: null as any,
        transactionId: null,
      },
    });

    logger.info('[InventoryService] warehouse created', { id: warehouse.id, code: input.code });
    return warehouse;
  }

  async function listWarehouses(includeInactive = false): Promise<Warehouse[]> {
    const where: any = { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) };
    return prisma.warehouse.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async function updateWarehouse(id: string, input: Partial<WarehouseInput>, actorId: string): Promise<Warehouse> {
    const profile = input.profile === undefined ? undefined : await validateProfile(input.profile);
    const existing = await prisma.warehouse.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`仓库 ${id} 不存在`);
    if(input.isActive===false&&await prisma.inventoryTransfer.count({where:{status:{in:["pending","in_transit"]},OR:[{targetWarehouseId:id},{sourceItem:{warehouseId:id}}]}}))throw new Error("仓库仍有未完成调拨任务，不能停用");
    if (input.isActive === false && await prisma.inventoryItem.count({where:{warehouseId:id,deletedAt:null,OR:[{quantity:{not:0}},{lockedQuantity:{not:0}}]}})) throw new Error("仓库仍有库存或预留，不能停用");

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      const warehouse = await tx.warehouse.update({
        where: { id },
        data: {
          profile: profile as Prisma.InputJsonValue | undefined,
          name: input.name ?? undefined,
          type: input.type ?? undefined,
          address: input.address ?? undefined,
          manager: input.manager ?? undefined,
          phone: input.phone ?? undefined,
          isActive: input.isActive ?? undefined,
          sortOrder: input.sortOrder ?? undefined,
          notes: input.notes ?? undefined,
          updatedAt: now,
        },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'update_warehouse',
          targetType: 'Warehouse',
          targetId: id,
          detail: { source: 'api:inventory', before: { name: existing.name, profile: existing.profile }, after: { name: input.name, profile: profile ?? existing.profile } } as any,
          ip: null,
          operationType: 'update',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      return warehouse;
    });

    return updated;
  }

  async function deleteWarehouse(id: string, actorId: string): Promise<void> {
    const existing = await prisma.warehouse.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`仓库 ${id} 不存在`);

    // 检查是否有关联库存项
    const itemCount = await prisma.inventoryItem.count({ where: { warehouseId: id, deletedAt: null, quantity: { gt: 0 } } });
    if (itemCount > 0) {
      throw new Error(`仓库 ${id} 仍有 ${itemCount} 个非零库存项，不可删除`);
    }

    const now = Date.now();
    await prisma.$transaction(async (tx) => {
      await tx.warehouse.update({ where: { id }, data: { deletedAt: now, isActive: false, updatedAt: now } });
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'delete_warehouse',
          targetType: 'Warehouse',
          targetId: id,
          detail: { source: 'api:inventory', before: { code: existing.code, name: existing.name } } as any,
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
  // 库存物料 CRUD
  // ════════════════════════════════════════

  function validateStockDetails(raw: StockDetails | undefined, category?: string | null, quantity?: number): StockDetails {
    if(!raw)return {};
    if(typeof raw !== 'object' || Array.isArray(raw))throw new Error('库存批次明细无效');
    const allowed=['color','dyeLot','composition','weightGsm','widthCm','rolls','sizes','packaging'];
    if(Object.keys(raw).some(k=>!allowed.includes(k)))throw new Error('库存批次含未知字段');
    for(const key of ['color','dyeLot','composition','packaging'] as const)if(raw[key]!==undefined&&(typeof raw[key]!=='string'||raw[key]!.length>1000))throw new Error('批次规格文字无效');
    for(const key of ['weightGsm','widthCm'] as const)if(raw[key]!==undefined&&(!Number.isFinite(raw[key])||raw[key]!<=0))throw new Error('克重与幅宽必须为正数');
    if(raw.rolls && category!=='Fabric')throw new Error('卷号明细只用于面料');
    if(raw.sizes && category!=='Garment')throw new Error('尺码明细只用于成衣');
    for(const kind of ['rolls','sizes'] as const){const rows=raw[kind];if(!rows)continue;if(!Array.isArray(rows)||rows.length>1000)throw new Error('批次明细格式无效');const keys=new Set<string>();let sum=0;for(const row of rows){const label=kind==='rolls'?(row as any).number:(row as any).size;if(typeof label!=='string'||!label.trim()||keys.has(label.trim())||!Number.isFinite(row.quantity)||row.quantity<=0||(kind==='sizes'&&!Number.isInteger(row.quantity)))throw new Error('卷号或尺码须唯一，数量须有效');keys.add(label.trim());sum+=row.quantity;}if(quantity!==undefined&&rows.length&&Math.abs(sum-quantity)>0.0001)throw new Error('明细数量合计必须等于实际入库数量');}
    return raw;
  }

  async function createInventoryItem(input: InventoryItemInput, actorId: string, opts?: {tx:any}): Promise<InventoryItemDetail> {
    if(!Number.isFinite(input.quantity)||input.quantity<0||new Prisma.Decimal(input.quantity).decimalPlaces()>4)throw new Error("实际库存数量必须为非负数，最多四位小数");
    if(input.receiptDate && !isValidLocalDateKey(input.receiptDate))throw new Error("实际收货日期无效");
    const receiptDate=input.receiptDate || todayLocalKey();
    const details = validateStockDetails(input.details, input.category, input.quantity);
    if(input.productAssetId){const asset=await prisma.productAsset.findFirst({where:{id:input.productAssetId,deletedAt:null}});if(!asset)throw new Error("产品档案不存在");if(input.category && asset.mainCategory!==input.category)throw new Error("货品类别与产品档案不一致");}
    const warehouse = await prisma.warehouse.findUnique({ where: { id: input.warehouseId } });
    if (!warehouse || !warehouse.isActive || warehouse.deletedAt) {
      throw new Error(`仓库 ${input.warehouseId} 不存在或已停用`);
    }

    const now = Date.now();
    const run = async (tx:any) => {
      const created = await tx.inventoryItem.create({
        data: {
          details: details as Prisma.InputJsonValue,
          id: generateInventoryId(),
          warehouseId: input.warehouseId,
          productAssetId: input.productAssetId ?? null,
          materialCode: input.materialCode ?? null,
          description: input.description,
          category: input.category ?? null,
          specification: input.specification ?? null,
          batchNumber: input.batchNumber ?? null,
          locationCode: input.locationCode ?? null,
          quantity: input.quantity,
          lockedQuantity: 0,
          unit: input.unit,
          unitCost: input.unitCost ?? null,
          currency: input.currency ?? 'CNY',
          minStock: input.minStock ?? null,
          maxStock: input.maxStock ?? null,
          lastInDate: input.quantity > 0 ? receiptDate : null,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
        },
        include: { warehouse: true },
      });

      // 如果初始数量 > 0，自动生成一条入库流水
      if (input.quantity > 0) {
        const initMovement = await tx.stockMovement.create({
          data: {
            id: generateMovementId(),
            movementNumber: `SM-INIT-${now}-${Math.random().toString(36).slice(2, 6)}`,
            type: 'Inbound',
            itemId: created.id,
            warehouseId: input.warehouseId,
            quantity: input.quantity,
            unit: input.unit,
            unitCost: input.unitCost ?? null,
            balanceBefore: 0,
            balanceAfter: input.quantity,
            reason: input.notes || '初始入库',
            referenceType: 'Manual',
            movementDate: receiptDate,
            createdAt: now,
          },
        });
        // W-C A1：StockMovement 图谱入链（S2 三击追溯）——同事务双写
        await syncStockMovementReferences(prisma, initMovement, { source: 'api:inventory' }, tx);
      }

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'create_inventory_item',
          targetType: 'InventoryItem',
          targetId: created.id,
          detail: { source: 'api:inventory', after: { description: input.description, quantity: input.quantity, unit: input.unit } } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      return created;
    };
    const item = opts?.tx ? await run(opts.tx) : await prisma.$transaction(run);

    logger.info('[InventoryService] inventory item created', { id: item.id, description: input.description });
    return item as InventoryItemDetail;
  }

  async function listInventoryItems(params: {
    orderId?:string;
    productAssetId?:string;
    warehouseId?: string;
    category?: string;
    materialCode?: string;
    search?: string;
    lowStockOnly?: boolean;
    limit?: number;
    offset?: number;
    /** Excel 台账导出=true：忽略分页上限全量导出（route 层 format=xlsx 专用） */
    exportAll?: boolean;
    /** Trusted server-side visibility filter, applied before page/count. */
    readScopeWhere?: Prisma.InventoryItemWhereInput;
  }): Promise<{ items: InventoryItemDetail[]; total: number }> {
    const where: any = { deletedAt: null };
    if (params.readScopeWhere) where.AND = [params.readScopeWhere];
    if (params.warehouseId) where.warehouseId = params.warehouseId;
    if(params.orderId)where.orderId=params.orderId;
    if(params.productAssetId)where.productAssetId=params.productAssetId;
    if (params.category) where.category = params.category;
    if (params.materialCode) where.materialCode = { contains: params.materialCode };
    if (params.search) {
      where.OR = [
        { description: { contains: params.search } },
        { materialCode: { contains: params.search } },
        { batchNumber: { contains: params.search } },
      ];
    }
    if (params.lowStockOnly) {
      where.minStock = { not: null };
      // lowStock: quantity <= minStock —— 用 Prisma 字段引用把跨字段比较下推 DB
      // （先过滤后分页）。旧实现「分页后在内存过滤」，低库存项落在第 2 页及以后时
      // 永久漏掉，且 total 用过滤后条数、分页数错。
      where.quantity = { lte: prisma.inventoryItem.fields.minStock };
    }

    const limit = params.exportAll ? undefined : Math.min(params.limit ?? 100, 500);
    const offset = params.exportAll ? 0 : (params.offset ?? 0);

    const [items, total] = await Promise.all([
      prisma.inventoryItem.findMany({
        where,
        include: { warehouse: true },
        orderBy: { updatedAt: 'desc' },
        ...(limit != null ? { take: limit, skip: offset } : {}),
      }),
      prisma.inventoryItem.count({ where }),
    ]);

    // lowStockOnly 已下推 DB 过滤（见上），分页与 total 语义恢复一致
    return { items: items as InventoryItemDetail[], total };
  }

  async function getInventoryItem(id: string, readScopeWhere?: Prisma.InventoryItemWhereInput, movementWhere?: Prisma.StockMovementWhereInput): Promise<InventoryItemDetail | null> {
    const item = await prisma.inventoryItem.findUnique({
      where: { id, ...(readScopeWhere ? { AND: [readScopeWhere] } : {}) },
      include: {
        warehouse: true,
        movements: { ...(movementWhere ? { where: movementWhere } : {}), orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!item || item.deletedAt) return null;
    return item as InventoryItemDetail;
  }

  async function updateInventoryItem(id: string, input: Partial<InventoryItemInput>, actorId: string): Promise<InventoryItemDetail> {
    const existing = await prisma.inventoryItem.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`库存项 ${id} 不存在`);

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.update({
        where: { id },
        data: {
          materialCode: input.materialCode ?? undefined,
          description: input.description ?? undefined,
          category: input.category ?? undefined,
          specification: input.specification ?? undefined,
          batchNumber: input.batchNumber ?? undefined,
          locationCode: input.locationCode ?? undefined,
          unitCost: input.unitCost ?? undefined,
          currency: input.currency ?? undefined,
          minStock: input.minStock ?? undefined,
          maxStock: input.maxStock ?? undefined,
          notes: input.notes ?? undefined,
          updatedAt: now,
        },
        include: { warehouse: true },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'update_inventory_item',
          targetType: 'InventoryItem',
          targetId: id,
          detail: { source: 'api:inventory', after: input } as any,
          ip: null,
          operationType: 'update',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      return item;
    });

    return updated as InventoryItemDetail;
  }

  async function deleteInventoryItem(id: string, actorId: string): Promise<void> {
    const existing = await prisma.inventoryItem.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`库存项 ${id} 不存在`);
    if (Number(existing.quantity) !== 0) {
      throw new Error(`库存项 ${id} 仍有库存 ${existing.quantity} ${existing.unit}，不可删除（请先出库或盘点清零）`);
    }

    const now = Date.now();
    await prisma.$transaction(async (tx) => {
      await tx.inventoryItem.update({ where: { id }, data: { deletedAt: now, updatedAt: now } });
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'delete_inventory_item',
          targetType: 'InventoryItem',
          targetId: id,
          detail: { source: 'api:inventory', before: { description: existing.description } } as any,
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
  // 库存变动（核心：入库/出库/调拨/盘点/锁定）
  // ════════════════════════════════════════

  /** Internal native receipt/shipment entry: exact Decimal18_4 quantities remain
   * in the central ledger and in the caller's source/authorization transaction. */
  async function createExactStockMovement(input: StockMovementInput, actorId: string, tx: any, quantity: Prisma.Decimal): Promise<StockMovement> {
    if (!tx || !actorId || !['Inbound', 'Outbound'].includes(input.type)
      || !quantity.isFinite() || quantity.lte(0) || quantity.decimalPlaces() > 4 || quantity.gte('100000000000000')) {
      throw businessError('INVALID_INPUT', '实物库存须使用事务内明确的正数数量和当前操作人。');
    }
    const item = await tx.inventoryItem.findUnique({ where: { id: input.itemId } });
    if (!item || item.deletedAt != null) throw businessError('NOT_FOUND', '原实物库存不存在或已删除。');
    const warehouse = await tx.warehouse.findUnique({ where: { id: item.warehouseId } });
    if (!warehouse || warehouse.deletedAt != null || !warehouse.isActive) throw businessError('NOT_FOUND', '原实物仓库不存在或已停用。');
    if (!input.unit || input.unit !== item.unit || !input.movementDate) throw businessError('INVALID_INPUT', '实物流水须明确与原库存一致的单位和日期，不隐式换算。');
    const before = new Prisma.Decimal(item.quantity), locked = new Prisma.Decimal(item.lockedQuantity);
    if (input.type === 'Outbound' && quantity.gt(before.minus(locked))) throw new InventoryStockInsufficientError('原实物库存的可用数量不足，请核对本次出货范围。');
    const delta = input.type === 'Outbound' ? quantity.negated() : quantity, after = before.plus(delta);
    if (after.lt(0) || after.gte('100000000000000')) throw businessError('CONFLICT', '原实物库存余额超出可登记范围。');
    const now = Date.now();
    const movement = await tx.stockMovement.create({ data: {
      id: generateMovementId(), movementNumber: `SM-${input.movementDate.replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      type: input.type, itemId: item.id, warehouseId: item.warehouseId, quantity, unit: item.unit, unitCost: item.unitCost,
      balanceBefore: before, balanceAfter: after, reason: input.reason ?? null, referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null, operator: actorId, movementDate: input.movementDate, notes: input.notes ?? null, createdAt: now,
    } });
    await syncStockMovementReferences(prisma, movement, { source: 'api:inventory' }, tx);
    const cas = await tx.inventoryItem.updateMany({ where: { id: item.id, deletedAt: null, quantity: item.quantity, lockedQuantity: item.lockedQuantity },
      data: { quantity: { increment: delta }, updatedAt: now,
        ...(input.type === 'Inbound' ? { lastInDate: input.movementDate } : { lastOutDate: input.movementDate }) } });
    if (cas.count !== 1) throw new StockMovementCasConflictError(item.id);
    await tx.auditLog.create({ data: {
      id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`, actorId, action: `stock_movement_${input.type.toLowerCase()}`,
      targetType: 'InventoryItem', targetId: item.id,
      detail: { source: 'api:inventory', after: { movementId: movement.id, type: input.type, quantity: quantity.toString(),
        balanceBefore: before.toString(), balanceAfter: after.toString(), unit: item.unit, referenceType: input.referenceType ?? null, referenceId: input.referenceId ?? null } },
      operationType: input.type === 'Outbound' ? 'decrement' : 'increment', fieldPath: 'quantity',
      beforeValue: before.toString(), afterValue: after.toString(), ip: null, transactionId: null,
    } });
    return movement;
  }

  async function createStockMovement(input: StockMovementInput, actorId: string, opts?: { tx?: any; exactQuantity?: Prisma.Decimal }): Promise<StockMovement> {
    validateMovementType(input.type);
    if (opts?.exactQuantity !== undefined) return createExactStockMovement(input, actorId, opts.tx, opts.exactQuantity);
    // opts.tx = 外部事务模式（如出运放行扣库存要求与门禁同事务原子提交）：
    // 快照读写与流水写入全部走传入的事务客户端，自身不再开 $transaction；
    // CAS 冲突不重试、直接上抛（同事务内快照不会推进，重试必然同样失败）由外层回滚；
    // 事务后预警发布跳过（此刻外层事务尚未提交，订阅方可能读到未提交余额）。
    const db: any = opts?.tx ?? prisma;

    // 并发安全（对齐 creditService shiftUsedAmount CAS 先例）：旧实现「事务外读快照 → 内存算
    // 新值 → 事务内绝对值覆盖写」，两个并发出库基于同一陈旧快照各自校验通过后互相覆盖
    // → 丢更新 → 超卖。现改为守卫式 CAS 原子增量：
    //   updateMany({ where: { id, deletedAt: null, quantity: 快照, lockedQuantity: 快照 },
    //               data: { quantity: { increment: Δ }, lockedQuantity: { increment: Δ } } })
    // count=0 说明快照已被并发事务推进 → 抛内部冲突标记令事务回滚 → 重读快照重试
    // （上限 MAX_MOVEMENT_CAS_ATTEMPTS 次，fail-closed）。流水/审计的 before/after 取自
    // CAS 命中时的快照，与落库终值严格一致（append-only 流水语义不变）。
    for (let attempt = 0; attempt < MAX_MOVEMENT_CAS_ATTEMPTS; attempt++) {
      const item = await db.inventoryItem.findUnique({ where: { id: input.itemId } });
      if (!item || item.deletedAt) throw new Error(`库存项 ${input.itemId} 不存在`);

      const warehouse = await db.warehouse.findUnique({ where: { id: item.warehouseId } });
      if (!warehouse || warehouse.deletedAt) throw new Error(`仓库 ${item.warehouseId} 不存在`);

      const now = Date.now();
      const movementDate = input.movementDate || todayLocalKey();
      const currentQty = Number(item.quantity);
      const currentLocked = Number(item.lockedQuantity ?? 0);
      // 单位归一（勿再踩）：入/出库数量必须先换算到**库存项单位**再参与余额增减，
      // 否则 m/yd、kg/lb 混加会静默算错数量（与合票分配同族缺陷）。
      // 长度走 lib/unitConversion（1 yd = 0.9144 m 精确值）；不可互算（PCS vs M 等）直接拒绝——报错优于算错。
      const unit: string = item.unit || input.unit || '';
      let moveQty = input.quantity;
      if (input.unit && item.unit && input.unit !== item.unit) {
        const converted = convertLength(moveQty, input.unit, item.unit);
        if (converted == null) {
          throw new Error(`单位不可换算：流水单位 ${input.unit} 与库存项单位 ${item.unit} 不可互算，请统一单位后重试`);
        }
        moveQty = converted;
      }

      // 计算原子增量（相对快照）与变动后余额
      let qtyDelta = 0;
      let lockedDelta = 0;
      let balanceAfter: number;
      let lastInDate = item.lastInDate;
      let lastOutDate = item.lastOutDate;

      switch (input.type) {
        case 'Inbound':
          qtyDelta = moveQty;
          balanceAfter = toDecimal(currentQty + qtyDelta);
          lastInDate = movementDate;
          break;
        case 'Outbound': {
          // B3：出库校验可用量（总量 - 锁定量），锁定为订单预留的货不可被其他出库单发掉
          const availableQty = toDecimal(currentQty - currentLocked);
          if (moveQty > availableQty) {
            throw new InventoryStockInsufficientError(`库存不足（含锁定量 ${currentLocked} ${unit}）：当前可用 ${availableQty} ${unit}，尝试出库 ${moveQty} ${unit}`);
          }
          qtyDelta = -moveQty;
          balanceAfter = toDecimal(currentQty + qtyDelta);
          lastOutDate = movementDate;
          break;
        }
        case 'Adjustment':
          // Adjustment: quantity 为目标绝对值（盘点后实际数量）→ 换算为相对快照的原子增量
          qtyDelta = toDecimal(moveQty - currentQty);
          balanceAfter = toDecimal(moveQty);
          break;
        case 'Lock':
          if (toDecimal(currentLocked + moveQty) > currentQty) {
            throw new Error(`可锁定库存不足：当前可用 ${currentQty - currentLocked} ${unit}，尝试锁定 ${moveQty} ${unit}`);
          }
          lockedDelta = moveQty;
          balanceAfter = currentQty; // 锁定不改变 quantity
          break;
        case 'Unlock':
          if (moveQty > currentLocked) {
            throw new Error(`解锁数量超过已锁定：当前锁定 ${currentLocked} ${unit}，尝试解锁 ${moveQty} ${unit}`);
          }
          lockedDelta = -moveQty;
          balanceAfter = currentQty; // 解锁不改变 quantity
          break;
        case 'Transfer': {
          // 调拨：从源仓库出库，在目标仓库入库（分两步，但同一事务）
          if (!input.targetWarehouseId) throw new Error('调拨必须指定目标仓库');
          // B3：调拨出库同样校验可用量（总量 - 锁定量）
          const availableQty = toDecimal(currentQty - currentLocked);
          if (moveQty > availableQty) {
            throw new Error(`库存不足（含锁定量 ${currentLocked} ${unit}）：当前可用 ${availableQty} ${unit}，尝试调拨 ${moveQty} ${unit}`);
          }
          qtyDelta = -moveQty;
          balanceAfter = toDecimal(currentQty + qtyDelta);
          lastOutDate = movementDate;
          break;
        }
        default:
          throw new Error(`未实现的变动类型：${input.type}`);
      }

      const newQty = toDecimal(currentQty + qtyDelta);

      const runMovementTx = async (tx: any): Promise<StockMovement> => {
        // 1. 创建流水记录
        const created = await tx.stockMovement.create({
          data: {
            id: generateMovementId(),
            movementNumber: `SM-${movementDate.replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            type: input.type,
            itemId: input.itemId,
            warehouseId: item.warehouseId,
            targetWarehouseId: input.targetWarehouseId ?? null,
            quantity: moveQty,
            unit,
            unitCost: input.type === 'Transfer' ? (item.unitCost ?? null) : (input.unitCost ?? null),
            balanceBefore: currentQty,
            balanceAfter,
            reason: input.reason ?? null,
            referenceType: input.referenceType ?? null,
            referenceId: input.referenceId ?? null,
            operator: actorId || 'system',
            movementDate,
            notes: input.notes ?? null,
            createdAt: now,
          },
        });

        // W-C A1：StockMovement 图谱入链（S2 三击追溯）——同事务双写
        await syncStockMovementReferences(prisma, created, { source: 'api:inventory' }, tx);

        // 2. 守卫式 CAS 原子更新库存余额：where 携带快照（原值守卫，防丢更新/超卖），
        //    data 用原子 increment/decrement；count=0 → 快照已被并发推进 → 回滚重试
        const cas = await tx.inventoryItem.updateMany({
          where: {
            id: input.itemId,
            deletedAt: null,
            quantity: item.quantity,
            lockedQuantity: item.lockedQuantity ?? 0,
          },
          data: {
            quantity: { increment: qtyDelta },
            lockedQuantity: { increment: lockedDelta },
            lastInDate,
            lastOutDate,
            updatedAt: now,
          },
        });
        if (cas.count === 0) throw new StockMovementCasConflictError(input.itemId);

        // 3. 调拨：在目标仓库创建/累加库存项 + 写入库流水
        if (input.type === 'Transfer' && input.targetWarehouseId) {
          const targetWarehouse = await tx.warehouse.findUnique({ where: { id: input.targetWarehouseId } });
          if (!targetWarehouse || !targetWarehouse.isActive || targetWarehouse.deletedAt) {
            throw new Error(`目标仓库 ${input.targetWarehouseId} 不存在或已停用`);
          }

          // 源物料标识必须可追溯；新目标项保留所有源标识。
          const hasIdentity = item.materialCode != null || item.productAssetId != null || item.batchNumber != null;
          if (!hasIdentity) {
            throw new Error('调拨失败：源库存项缺少物料标识（materialCode / productAssetId / batchNumber 全空），无法在目标仓定位对应项');
          }
          // 尚无结构化来源批次键：每次调拨独立建项，禁止按物料名称推断同源。
          const targetQtyBefore = 0;
          const targetItem = await tx.inventoryItem.create({
              data: {
                id: generateInventoryId(),
                details: item.details ?? undefined,
                warehouseId: input.targetWarehouseId,
                productAssetId: item.productAssetId ?? null,
                materialCode: item.materialCode ?? null,
                description: item.description,
                category: item.category ?? null,
                specification: item.specification ?? null,
                batchNumber: item.batchNumber ?? null,
                locationCode: null,
                quantity: moveQty,
                lockedQuantity: 0,
                unit: item.unit,
                unitCost: item.unitCost ?? null,
                currency: item.currency,
                ownership: item.ownership,
                orderId: item.orderId ?? null,
                stockPrep: item.stockPrep ?? false,
                minStock: item.minStock ?? null,
                maxStock: item.maxStock ?? null,
                lastInDate: movementDate,
                notes: [item.notes, `从仓库 ${warehouse.code} 调入；来源库存 ${item.id}；来源流水 ${created.id}`].filter(Boolean).join("\n"),
                createdAt: now,
                updatedAt: now,
              },
            });

          // 写目标仓库入库流水
          const targetMovement = await tx.stockMovement.create({
            data: {
              id: generateMovementId(),
              movementNumber: `SM-${movementDate.replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
              type: 'Inbound',
              itemId: targetItem.id,
              warehouseId: input.targetWarehouseId,
              quantity: moveQty,
              unit,
              unitCost: input.type === 'Transfer' ? (item.unitCost ?? null) : (input.unitCost ?? null),
              balanceBefore: targetQtyBefore,
              balanceAfter: toDecimal(targetQtyBefore + moveQty),
              reason: `从仓库 ${warehouse.code} 调入`,
              referenceType: 'Transfer',
              referenceId: created.id,
              operator: actorId || 'system',
              movementDate,
              createdAt: now,
            },
          });

          // W-C A1：StockMovement 图谱入链（S2 三击追溯）——同事务双写
          await syncStockMovementReferences(prisma, targetMovement, { source: 'api:inventory' }, tx);
        }

        // 4. 审计日志
        await tx.auditLog.create({
          data: {
            id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
            actorId: actorId || 'system',
            action: `stock_movement_${input.type.toLowerCase()}`,
            targetType: 'InventoryItem',
            targetId: input.itemId,
            detail: {
              source: 'api:inventory',
              after: { movementId: created.id, type: input.type, quantity: moveQty, balanceBefore: currentQty, balanceAfter,
                ...(input.type === 'Transfer' ? { sourceSnapshot: {
                  itemId: item.id, warehouseId: item.warehouseId, targetWarehouseId: input.targetWarehouseId,
                  ownership: item.ownership, orderId: item.orderId ?? null, stockPrep: item.stockPrep ?? false,
                  materialCode: item.materialCode ?? null, productAssetId: item.productAssetId ?? null,
                  batchNumber: item.batchNumber ?? null, unit: item.unit, currency: item.currency,
                  unitCost: item.unitCost == null ? null : String(item.unitCost),
                } } : {}),
              },
            } as any,
            ip: null,
            operationType: input.type === 'Outbound' || input.type === 'Transfer' ? 'decrement' : 'increment',
            fieldPath: 'quantity',
            beforeValue: currentQty as any,
            afterValue: balanceAfter as any,
            transactionId: null,
          },
        });

        return created;
      };

      let movement: StockMovement;
      try {
        movement = opts?.tx ? await runMovementTx(db) : await prisma.$transaction(runMovementTx);
      } catch (e) {
        // CAS 冲突 → 重读快照重试；其余错误（业务校验/事务内失败）原样抛出不重试。
        // 外部事务模式不重试：直接上抛让外层整体回滚。
        if (e instanceof StockMovementCasConflictError && !opts?.tx && attempt < MAX_MOVEMENT_CAS_ATTEMPTS - 1) continue;
        throw e;
      }

      // 5. 库存预警事件（自身事务提交后发布，fire-and-forget；外部事务模式跳过——
      // 此刻外层事务尚未提交，订阅方可能读到未提交余额，见函数头注释）
      if (!opts?.tx) {
      try {
        if (item.minStock != null && newQty <= Number(item.minStock)) {
          businessEventBus.publish({
            id: `bev_stock_low_${now}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'StockLowAlarm',
            sourceEntityType: 'InventoryItem',
            sourceEntityId: input.itemId,
            payload: {
              itemId: input.itemId,
              description: item.description,
              materialCode: item.materialCode,
              warehouseCode: warehouse.code,
              warehouseName: warehouse.name,
              currentQty: newQty,
              minStock: Number(item.minStock),
              unit: item.unit,
              movementType: input.type,
            },
            occurredAt: now,
            actorId: actorId || 'system',
          });
        }
        if (item.maxStock != null && newQty >= Number(item.maxStock) && input.type === 'Inbound') {
          businessEventBus.publish({
            id: `bev_stock_over_${now}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'StockOverstockAlarm',
            sourceEntityType: 'InventoryItem',
            sourceEntityId: input.itemId,
            payload: {
              itemId: input.itemId,
              description: item.description,
              materialCode: item.materialCode,
              warehouseCode: warehouse.code,
              warehouseName: warehouse.name,
              currentQty: newQty,
              maxStock: Number(item.maxStock),
              unit: item.unit,
            },
            occurredAt: now,
            actorId: actorId || 'system',
          });
        }
      } catch (e: any) {
        logger.warn('[InventoryService] stock alarm event publish failed (non-blocking)', { error: e?.message });
      }
      }

      logger.info('[InventoryService] stock movement created', {
        itemId: input.itemId, type: input.type, qty: moveQty, balanceBefore: currentQty, balanceAfter,
      });

      return movement;
    }

    throw new Error(`库存余额并发冲突：CAS 重试 ${MAX_MOVEMENT_CAS_ATTEMPTS} 次仍失败（itemId=${input.itemId}）`);
  }

  // ════════════════════════════════════════
  // 库存变动流水查询
  // ════════════════════════════════════════

  async function listStockMovements(params: {
    itemId?: string;
    warehouseId?: string;
    type?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
    readScopeWhere?: Prisma.StockMovementWhereInput;
  }): Promise<{ items: StockMovement[]; total: number }> {
    const where: any = {};
    if (params.readScopeWhere) where.AND = [params.readScopeWhere];
    if (params.itemId) where.itemId = params.itemId;
    if (params.warehouseId) where.warehouseId = params.warehouseId;
    if (params.type) where.type = params.type;
    if (params.dateFrom || params.dateTo) {
      where.movementDate = {};
      if (params.dateFrom) where.movementDate.gte = params.dateFrom;
      if (params.dateTo) where.movementDate.lte = params.dateTo;
    }

    const limit = Math.min(params.limit ?? 100, 500);
    const offset = params.offset ?? 0;

    const [items, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.stockMovement.count({ where }),
    ]);

    return { items, total };
  }

  // ════════════════════════════════════════
  // 库存预警查询
  // ════════════════════════════════════════

  async function getLowStockItems(readScopeWhere?: Prisma.InventoryItemWhereInput): Promise<InventoryItemDetail[]> {
    const items = await prisma.inventoryItem.findMany({
      where: { deletedAt: null, minStock: { not: null }, ...(readScopeWhere ? { AND: [readScopeWhere] } : {}) },
      include: { warehouse: true },
    });
    return items.filter((item: any) => Number(item.quantity) <= Number(item.minStock)) as InventoryItemDetail[];
  }

  return {
    // 仓库
    createWarehouse,
    listWarehouses,
    updateWarehouse,
    deleteWarehouse,
    // 库存物料
    createInventoryItem,
    listInventoryItems,
    getInventoryItem,
    updateInventoryItem,
    deleteInventoryItem,
    // 库存变动
    createStockMovement,
    listStockMovements,
    // 预警
    getLowStockItems,
  };
}

export type InventoryService = ReturnType<typeof createInventoryService>;
