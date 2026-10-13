import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createInventoryService, WarehouseInput, InventoryItemInput, StockMovementInput } from '../inventoryService';
import { businessEventBus } from '../../events/businessEventBus';

/**
 * task ERP-P2-inventory-service-foundation:
 * 覆盖 inventoryService 的仓库/库存物料 CRUD + 库存变动（入库/出库/调拨/盘点/锁定/解锁）
 * + 余额校验 + 事务回滚 + 审计 + 预警事件发布 + fail-closed 契约。
 *
 * 设计：
 *   - 用 $transaction: (fn) => fn(tx) 透明穿透模式，验证 audit reject → 事务回滚
 *   - 所有 mutation 都在事务内写 auditLog，audit reject 必须回滚业务操作
 *   - 库存变动在事务提交后 publish 预警事件（StockLowAlarm / StockOverstockAlarm）
 *   - 余额不可为负：Outbound / Transfer / Lock 校验 sufficient stock，fail-closed
 *   - 变动类型严格校验：非法类型抛错
 *   - 调拨：源仓库出库 + 目标仓库入库（同事务双写）
 */

// ── Mock businessEventBus.publish（fire-and-forget，但需验证调用契约） ──
const publishSpy = vi.spyOn(businessEventBus, 'publish').mockResolvedValue(undefined);

// ── 工厂：构造 mock prisma + tx ──
function makePrisma(opts: {
  existingWarehouse?: any;
  existingItem?: any;
  existingTargetItem?: any;
  targetWarehouse?: any;
  auditFail?: boolean;
  movementCreateFail?: boolean;
  itemUpdateFail?: boolean;
  warehouseCount?: number;
} = {}) {
  const existingWarehouse = opts.existingWarehouse ?? null;
  const existingItem = opts.existingItem ?? null;
  const existingTargetItem = opts.existingTargetItem ?? null;

  // 内存 DB 行（模拟数据库落库状态）：CAS updateMany 读写此行，重试循环的重读由此体现
  const dbItem = existingItem ? { ...existingItem } : null;

  // Warehouse
  const warehouseFindUnique = vi.fn().mockImplementation(async ({ where }: any) => {
    if (where.id === existingWarehouse?.id || where.code === existingWarehouse?.code) return existingWarehouse;
    if (where.id === opts.targetWarehouse?.id) return opts.targetWarehouse;
    return null;
  });
  const warehouseFindMany = vi.fn().mockResolvedValue(existingWarehouse ? [existingWarehouse] : []);
  const warehouseCreate = vi.fn().mockImplementation(async ({ data }: any) => ({
    ...data,
    items: [],
  }));
  const warehouseUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({
    ...existingWarehouse,
    ...data,
    id: where.id,
  }));

  // InventoryItem
  const inventoryItemFindUnique = vi.fn().mockImplementation(async ({ where }: any) => {
    if (dbItem && where.id === dbItem.id) return dbItem;
    return null;
  });
  const inventoryItemFindFirst = vi.fn().mockImplementation(async () => existingTargetItem);
  const inventoryItemFindMany = vi.fn().mockResolvedValue(existingItem ? [existingItem] : []);
  const inventoryItemCount = vi.fn().mockResolvedValue(opts.warehouseCount ?? 0);
  const inventoryItemCreate = vi.fn().mockImplementation(async ({ data, include }: any) => ({
    ...data,
    warehouse: existingWarehouse,
  }));
  const inventoryItemUpdate = opts.itemUpdateFail
    ? vi.fn().mockRejectedValue(new Error('UPDATE_BOOM'))
    : vi.fn().mockImplementation(async ({ where, data, include }: any) => {
        const base = existingTargetItem && where.id === existingTargetItem.id ? existingTargetItem : existingItem;
        const resolved: any = { ...data };
        // 原子增量语义（Transfer 目标仓累加走 { increment: n }）：基于内存行数值化返回
        if (data?.quantity && typeof data.quantity === 'object' && typeof data.quantity.increment === 'number') {
          resolved.quantity = Number(base?.quantity ?? 0) + data.quantity.increment;
        }
        return { ...base, ...resolved, id: where.id, warehouse: existingWarehouse };
      });
  // CAS 守卫式原子更新（源仓余额）：where 快照（quantity/lockedQuantity/deletedAt）全匹配才
  // 落库增量，否则 count=0 —— 模拟真实 updateMany 的行级守卫语义
  const inventoryItemUpdateMany = vi.fn().mockImplementation(async ({ where, data }: any) => {
    if (!dbItem || where.id !== dbItem.id) return { count: 0 };
    if (Number(where.quantity) !== Number(dbItem.quantity)) return { count: 0 };
    if (Number(where.lockedQuantity ?? 0) !== Number(dbItem.lockedQuantity ?? 0)) return { count: 0 };
    if (where.deletedAt === null && dbItem.deletedAt != null) return { count: 0 };
    if (typeof data?.quantity?.increment === 'number') {
      dbItem.quantity = Number(dbItem.quantity) + data.quantity.increment;
    }
    if (typeof data?.lockedQuantity?.increment === 'number') {
      dbItem.lockedQuantity = Number(dbItem.lockedQuantity ?? 0) + data.lockedQuantity.increment;
    }
    return { count: 1 };
  });

  // StockMovement
  const stockMovementCreate = opts.movementCreateFail
    ? vi.fn().mockRejectedValue(new Error('SM_BOOM'))
    : vi.fn().mockImplementation(async ({ data }: any) => ({ ...data }));
  const stockMovementFindMany = vi.fn().mockResolvedValue([]);
  const stockMovementCount = vi.fn().mockResolvedValue(0);

  // Audit
  const auditCreate = opts.auditFail
    ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT'))
    : vi.fn().mockResolvedValue({ id: 'AL-1' });

  const tx: any = {
    warehouse: { update: warehouseUpdate, findUnique: warehouseFindUnique },
    inventoryItem: {
      create: inventoryItemCreate,
      update: inventoryItemUpdate,
      updateMany: inventoryItemUpdateMany,
      findFirst: inventoryItemFindFirst,
    },
    stockMovement: { create: stockMovementCreate },
    auditLog: { create: auditCreate },
    // EntityLink 图谱（W-C A1）：syncStockMovementReferences 走 tx 内 upsert
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}) },
  };

  const prisma: any = {
    warehouse: {
      findUnique: warehouseFindUnique,
      findMany: warehouseFindMany,
      create: warehouseCreate,
      update: warehouseUpdate,
    },
    inventoryItem: {
      // Prisma 字段引用（lowStockOnly 跨字段比较下推 DB 用）
      fields: { minStock: 'FIELD_REF:minStock' },
      findUnique: inventoryItemFindUnique,
      findFirst: inventoryItemFindFirst,
      findMany: inventoryItemFindMany,
      count: inventoryItemCount,
      create: inventoryItemCreate,
      update: inventoryItemUpdate,
    },
    stockMovement: {
      create: stockMovementCreate,
      findMany: stockMovementFindMany,
      count: stockMovementCount,
    },
    auditLog: { create: auditCreate },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };

  return {
    prisma, tx, dbItem,
    warehouseFindUnique, warehouseFindMany, warehouseCreate, warehouseUpdate,
    inventoryItemFindUnique, inventoryItemFindFirst, inventoryItemFindMany, inventoryItemCount,
    inventoryItemCreate, inventoryItemUpdate, inventoryItemUpdateMany,
    stockMovementCreate, stockMovementFindMany, stockMovementCount,
    auditCreate,
  };
}

const baseWarehouseInput: WarehouseInput = {
  code: 'WH-001',
  name: '上海主仓',
  type: 'Main',
  address: '上海市浦东新区',
  manager: '张三',
  phone: '13800000000',
};

const baseItemInput: InventoryItemInput = {
  warehouseId: 'WH_1',
  description: '面料 A - 蓝色',
  materialCode: 'FAB-001',
  category: 'Fabric',
  quantity: 100,
  unit: 'YD',
  unitCost: 5.5,
  minStock: 20,
  maxStock: 500,
};

// ═══════════════════════════════════════════════════════════════
// createWarehouse
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: createWarehouse', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('成功创建 → 事务外 create + audit', async () => {
    const { prisma, warehouseCreate, auditCreate } = makePrisma();
    const service = createInventoryService(prisma);

    const result = await service.createWarehouse(baseWarehouseInput, 'u_test');

    expect(warehouseCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        code: 'WH-001',
        name: '上海主仓',
        type: 'Main',
        isActive: true,
        sortOrder: 0,
      }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'create_warehouse',
        targetType: 'Warehouse',
        actorId: 'u_test',
        operationType: 'create',
      }),
    }));
    expect(result.code).toBe('WH-001');
  });

  it('仓库编码已存在（未删除）→ 抛错', async () => {
    const existing = { id: 'WH_1', code: 'WH-001', deletedAt: null };
    const { prisma } = makePrisma({ existingWarehouse: existing });

    const service = createInventoryService(prisma);
    await expect(service.createWarehouse(baseWarehouseInput, 'u_test')).rejects.toThrow('已存在');
  });

  it('actorId 为空时使用 system 作为 actor', async () => {
    const { prisma, auditCreate } = makePrisma();
    const service = createInventoryService(prisma);

    await service.createWarehouse(baseWarehouseInput, '');

    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: 'system' }),
    }));
  });
});

// ═══════════════════════════════════════════════════════════════
// listWarehouses
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: listWarehouses', () => {
  it('默认仅返回活跃仓库', async () => {
    const { prisma, warehouseFindMany } = makePrisma();
    const service = createInventoryService(prisma);

    await service.listWarehouses();

    expect(warehouseFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { isActive: true, deletedAt: null },
    }));
  });

  it('includeInactive=true → 返回未删除的活跃和停用仓库', async () => {
    const { prisma, warehouseFindMany } = makePrisma();
    const service = createInventoryService(prisma);

    await service.listWarehouses(true);

    expect(warehouseFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { deletedAt: null },
    }));
  });
});

// ═══════════════════════════════════════════════════════════════
// updateWarehouse
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: updateWarehouse', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('成功更新 → 事务内 update + audit', async () => {
    const existing = { id: 'WH_1', code: 'WH-001', name: '老名字', deletedAt: null };
    const { prisma, tx, auditCreate } = makePrisma({ existingWarehouse: existing });

    const service = createInventoryService(prisma);
    const result = await service.updateWarehouse('WH_1', { name: '新名字', manager: '李四' }, 'u_test');

    expect(tx.warehouse.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'WH_1' },
      data: expect.objectContaining({ name: '新名字', manager: '李四' }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'update_warehouse',
        operationType: 'update',
      }),
    }));
    expect(result.name).toBe('新名字');
  });

  it('仓库不存在 → 抛错', async () => {
    const { prisma, tx } = makePrisma({ existingWarehouse: null });
    const service = createInventoryService(prisma);

    await expect(service.updateWarehouse('NOT_EXIST', { name: 'x' }, 'u_test')).rejects.toThrow('不存在');
    expect(tx.warehouse.update).not.toHaveBeenCalled();
  });

  it('已软删除 → 抛错', async () => {
    const existing = { id: 'WH_1', deletedAt: 123456 };
    const { prisma } = makePrisma({ existingWarehouse: existing });
    const service = createInventoryService(prisma);

    await expect(service.updateWarehouse('WH_1', { name: 'x' }, 'u_test')).rejects.toThrow('不存在');
  });

  it('audit reject → 事务回滚', async () => {
    const existing = { id: 'WH_1', name: '老', deletedAt: null };
    const { prisma, tx } = makePrisma({ existingWarehouse: existing, auditFail: true });
    const service = createInventoryService(prisma);

    await expect(service.updateWarehouse('WH_1', { name: '新' }, 'u_test')).rejects.toThrow('AUDIT_REJECT');
    expect(tx.warehouse.update).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// deleteWarehouse
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: deleteWarehouse', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('成功软删除 → 事务内 update + audit', async () => {
    const existing = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const { prisma, tx, auditCreate } = makePrisma({ existingWarehouse: existing, warehouseCount: 0 });

    const service = createInventoryService(prisma);
    await service.deleteWarehouse('WH_1', 'u_test');

    expect(tx.warehouse.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'WH_1' },
      data: expect.objectContaining({ deletedAt: expect.any(Number), isActive: false }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'delete_warehouse', operationType: 'delete' }),
    }));
  });

  it('仓库不存在 → 抛错', async () => {
    const { prisma } = makePrisma({ existingWarehouse: null });
    const service = createInventoryService(prisma);

    await expect(service.deleteWarehouse('NOT_EXIST', 'u_test')).rejects.toThrow('不存在');
  });

  it('仓库仍有非零库存项 → 抛错（fail-closed）', async () => {
    const existing = { id: 'WH_1', code: 'WH-001', deletedAt: null };
    const { prisma, tx } = makePrisma({ existingWarehouse: existing, warehouseCount: 3 });

    const service = createInventoryService(prisma);
    await expect(service.deleteWarehouse('WH_1', 'u_test')).rejects.toThrow('不可删除');
    expect(tx.warehouse.update).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// createInventoryItem
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: createInventoryItem', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('成功创建（初始数量>0）→ 事务内 create item + create Inbound movement + audit', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', isActive: true, deletedAt: null };
    const { prisma, tx, inventoryItemCreate, stockMovementCreate, auditCreate } = makePrisma({ existingWarehouse: warehouse });

    const service = createInventoryService(prisma);
    const result = await service.createInventoryItem(baseItemInput, 'u_test');

    // create inventory item
    expect(tx.inventoryItem.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        warehouseId: 'WH_1',
        description: '面料 A - 蓝色',
        materialCode: 'FAB-001',
        quantity: 100,
        lockedQuantity: 0,
        unit: 'YD',
        unitCost: 5.5,
        minStock: 20,
        maxStock: 500,
      }),
      include: { warehouse: true },
    }));
    // 初始数量>0 → 自动写一条入库流水
    expect(tx.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'Inbound',
        quantity: 100,
        unit: 'YD',
        balanceBefore: 0,
        balanceAfter: 100,
        reason: '初始入库',
      }),
    }));
    // audit
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'create_inventory_item',
        targetType: 'InventoryItem',
        operationType: 'create',
      }),
    }));
    expect(result.description).toBe('面料 A - 蓝色');
  });

  it('初始数量=0 → 不写入库流水', async () => {
    const warehouse = { id: 'WH_1', isActive: true, deletedAt: null };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse });
    const service = createInventoryService(prisma);

    await service.createInventoryItem({ ...baseItemInput, quantity: 0 }, 'u_test');

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('仓库不存在 → 抛错', async () => {
    const { prisma, tx } = makePrisma({ existingWarehouse: null });
    const service = createInventoryService(prisma);

    await expect(service.createInventoryItem(baseItemInput, 'u_test')).rejects.toThrow('不存在或已停用');
    expect(tx.inventoryItem.create).not.toHaveBeenCalled();
  });

  it('仓库已停用 → 抛错', async () => {
    const warehouse = { id: 'WH_1', isActive: false, deletedAt: null };
    const { prisma } = makePrisma({ existingWarehouse: warehouse });
    const service = createInventoryService(prisma);

    await expect(service.createInventoryItem(baseItemInput, 'u_test')).rejects.toThrow('不存在或已停用');
  });

  it('audit reject → 事务回滚（不伪成功）', async () => {
    const warehouse = { id: 'WH_1', isActive: true, deletedAt: null };
    const { prisma } = makePrisma({ existingWarehouse: warehouse, auditFail: true });
    const service = createInventoryService(prisma);

    await expect(service.createInventoryItem(baseItemInput, 'u_test')).rejects.toThrow('AUDIT_REJECT');
  });
});

// ═══════════════════════════════════════════════════════════════
// listInventoryItems
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: listInventoryItems', () => {
  it('按仓库筛选 + 分页', async () => {
    const { prisma, inventoryItemFindMany } = makePrisma();
    const service = createInventoryService(prisma);

    await service.listInventoryItems({ warehouseId: 'WH_1', limit: 50, offset: 10 });

    expect(inventoryItemFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ warehouseId: 'WH_1', deletedAt: null }),
      take: 50,
      skip: 10,
      include: { warehouse: true },
    }));
  });

  it('搜索关键词 → OR 条件', async () => {
    const { prisma, inventoryItemFindMany } = makePrisma();
    const service = createInventoryService(prisma);

    await service.listInventoryItems({ search: '蓝色' });

    const call = inventoryItemFindMany.mock.calls[0][0];
    expect(call.where.OR).toHaveLength(3);
    expect(call.where.OR[0]).toEqual({ description: { contains: '蓝色' } });
  });

  it('lowStockOnly → 跨字段比较下推 DB（先过滤后分页），不再内存过滤', async () => {
    const { prisma, inventoryItemFindMany } = makePrisma();
    const service = createInventoryService(prisma);

    await service.listInventoryItems({ lowStockOnly: true, limit: 50, offset: 10 });

    // 断言：where 携带字段引用（quantity <= minStock），分页参数不被内存过滤破坏
    const call = inventoryItemFindMany.mock.calls[0][0];
    expect(call.where.minStock).toEqual({ not: null });
    expect(call.where.quantity).toEqual({ lte: (prisma.inventoryItem as any).fields.minStock });
    expect(call.take).toBe(50);
    expect(call.skip).toBe(10);
  });

  it('limit 上限 500', async () => {
    const { prisma, inventoryItemFindMany } = makePrisma();
    const service = createInventoryService(prisma);

    await service.listInventoryItems({ limit: 9999 });

    expect(inventoryItemFindMany.mock.calls[0][0].take).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════
// getInventoryItem
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: getInventoryItem', () => {
  it('存在 → 返回详情（含仓库 + 最近流水）', async () => {
    const item = { id: 'INV_1', description: '面料', deletedAt: null, warehouse: { id: 'WH_1' }, movements: [] };
    const { prisma, inventoryItemFindUnique } = makePrisma({ existingItem: item });
    const service = createInventoryService(prisma);

    const result = await service.getInventoryItem('INV_1');

    expect(inventoryItemFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'INV_1' },
      include: { warehouse: true, movements: expect.objectContaining({ orderBy: { createdAt: 'desc' }, take: 50 }) },
    }));
    expect(result?.id).toBe('INV_1');
  });

  it('不存在 → 返回 null', async () => {
    const { prisma } = makePrisma({ existingItem: null });
    const service = createInventoryService(prisma);

    const result = await service.getInventoryItem('NOT_EXIST');
    expect(result).toBeNull();
  });

  it('已软删除 → 返回 null', async () => {
    const item = { id: 'INV_1', deletedAt: 123456 };
    const { prisma } = makePrisma({ existingItem: item });
    const service = createInventoryService(prisma);

    const result = await service.getInventoryItem('INV_1');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// updateInventoryItem
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: updateInventoryItem', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('成功更新（不改 quantity）→ 事务内 update + audit', async () => {
    const existing = { id: 'INV_1', description: '老', quantity: 100, deletedAt: null };
    const { prisma, tx, auditCreate } = makePrisma({ existingItem: existing });

    const service = createInventoryService(prisma);
    const result = await service.updateInventoryItem('INV_1', { materialCode: 'FAB-NEW', minStock: 30 }, 'u_test');

    expect(tx.inventoryItem.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'INV_1' },
      data: expect.objectContaining({ materialCode: 'FAB-NEW', minStock: 30 }),
    }));
    // quantity 不在可更新字段中
    expect(tx.inventoryItem.update.mock.calls[0][0].data.quantity).toBeUndefined();
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'update_inventory_item', operationType: 'update' }),
    }));
    expect(result.materialCode).toBe('FAB-NEW');
  });

  it('库存项不存在 → 抛错', async () => {
    const { prisma, tx } = makePrisma({ existingItem: null });
    const service = createInventoryService(prisma);

    await expect(service.updateInventoryItem('NOT_EXIST', { notes: 'x' }, 'u_test')).rejects.toThrow('不存在');
    expect(tx.inventoryItem.update).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// deleteInventoryItem
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: deleteInventoryItem', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('quantity=0 → 成功软删除', async () => {
    const existing = { id: 'INV_1', description: '已清零', quantity: 0, deletedAt: null };
    const { prisma, tx, auditCreate } = makePrisma({ existingItem: existing });

    const service = createInventoryService(prisma);
    await service.deleteInventoryItem('INV_1', 'u_test');

    expect(tx.inventoryItem.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'INV_1' },
      data: expect.objectContaining({ deletedAt: expect.any(Number) }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'delete_inventory_item', operationType: 'delete' }),
    }));
  });

  it('quantity != 0 → 抛错（不可删除）', async () => {
    const existing = { id: 'INV_1', quantity: 50, unit: 'YD', deletedAt: null };
    const { prisma, tx } = makePrisma({ existingItem: existing });

    const service = createInventoryService(prisma);
    await expect(service.deleteInventoryItem('INV_1', 'u_test')).rejects.toThrow('不可删除');
    expect(tx.inventoryItem.update).not.toHaveBeenCalled();
  });

  it('库存项不存在 → 抛错', async () => {
    const { prisma } = makePrisma({ existingItem: null });
    const service = createInventoryService(prisma);

    await expect(service.deleteInventoryItem('NOT_EXIST', 'u_test')).rejects.toThrow('不存在');
  });
});

// ═══════════════════════════════════════════════════════════════
// createStockMovement — Inbound
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: createStockMovement Inbound', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('入库 → 数量增加 + 写流水 + 更新 lastInDate + audit', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      quantity: 100, lockedQuantity: 0, unit: 'YD', minStock: 20, maxStock: 500,
      lastInDate: '2026-08-01', lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx, stockMovementCreate, auditCreate } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    const movement = await service.createStockMovement({
      itemId: 'INV_1', type: 'Inbound', quantity: 50, unitCost: 6, reason: '采购到货',
    }, 'u_test');

    // 流水：balanceBefore=100, balanceAfter=150
    expect(tx.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'Inbound',
        quantity: 50,
        unit: 'YD',
        unitCost: 6,
        balanceBefore: 100,
        balanceAfter: 150,
        reason: '采购到货',
        operator: 'u_test',
      }),
    }));
    // 库存项更新：CAS 守卫式原子增量（where 携带快照，data 用 increment 而非绝对值）
    expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'INV_1', deletedAt: null, quantity: 100, lockedQuantity: 0 },
      data: expect.objectContaining({ quantity: { increment: 50 }, lastInDate: expect.any(String) }),
    }));
    // audit
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'stock_movement_inbound',
        operationType: 'increment',
        fieldPath: 'quantity',
        beforeValue: 100,
        afterValue: 150,
      }),
    }));
    expect(movement.type).toBe('Inbound');
  });

  it('入库后超过 maxStock → 发布 StockOverstockAlarm 事件', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      quantity: 480, lockedQuantity: 0, unit: 'YD', minStock: 20, maxStock: 500,
      lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await service.createStockMovement({
      itemId: 'INV_1', type: 'Inbound', quantity: 50,
    }, 'u_test');

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0][0];
    expect(event.type).toBe('StockOverstockAlarm');
    expect(event.sourceEntityType).toBe('InventoryItem');
    expect(event.sourceEntityId).toBe('INV_1');
    expect(event.payload.currentQty).toBe(530);
    expect(event.payload.maxStock).toBe(500);
    expect(event.payload.warehouseCode).toBe('WH-001');
  });

  it('入库未超过 maxStock → 不发布积压事件', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      quantity: 100, lockedQuantity: 0, unit: 'YD', minStock: 20, maxStock: 500,
      lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await service.createStockMovement({ itemId: 'INV_1', type: 'Inbound', quantity: 50 }, 'u_test');

    expect(publishSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// createStockMovement — Outbound
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: createStockMovement Outbound', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('出库 → 数量减少 + 写流水 + 更新 lastOutDate + audit（decrement）', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      quantity: 100, lockedQuantity: 0, unit: 'YD', minStock: 20, maxStock: 500,
      lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx, auditCreate } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    const movement = await service.createStockMovement({
      itemId: 'INV_1', type: 'Outbound', quantity: 30, reason: '生产领料',
    }, 'u_test');

    expect(tx.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'Outbound',
        quantity: 30,
        balanceBefore: 100,
        balanceAfter: 70,
      }),
    }));
    expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'INV_1', deletedAt: null, quantity: 100, lockedQuantity: 0 },
      data: expect.objectContaining({ quantity: { increment: -30 }, lastOutDate: expect.any(String) }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'stock_movement_outbound',
        operationType: 'decrement',
        beforeValue: 100,
        afterValue: 70,
      }),
    }));
    expect(movement.type).toBe('Outbound');
  });

  it('库存不足 → 抛错（fail-closed）', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 10, lockedQuantity: 0, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Outbound', quantity: 50,
    }, 'u_test')).rejects.toThrow('库存不足');
    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Outbound', quantity: 50,
    }, 'u_test')).rejects.toMatchObject({ code: 'STOCK_INSUFFICIENT', statusCode: 409 });

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(tx.inventoryItem.updateMany).not.toHaveBeenCalled();
  });

  // B3：锁定量拦截 —— 总量够但锁定后可用量不足 → 拒绝出库（409 文案含锁定量数值）
  it('总量足够但含锁定量后可用量不足 → 抛错（文案含锁定量数值）', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 100, lockedQuantity: 80, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    // 总量 100 >= 50，但可用量 = 100 - 80 = 20 < 50
    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Outbound', quantity: 50,
    }, 'u_test')).rejects.toThrow('库存不足（含锁定量 80 YD）');

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(tx.inventoryItem.updateMany).not.toHaveBeenCalled();
  });

  it('可用量充足（总量 - 锁定量 >= 出库量）→ 正常出库', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      quantity: 100, lockedQuantity: 80, unit: 'YD', minStock: null, maxStock: null,
      lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    // 可用量 = 100 - 80 = 20，出库 20 恰好放行
    const movement = await service.createStockMovement({
      itemId: 'INV_1', type: 'Outbound', quantity: 20, reason: '生产领料',
    }, 'u_test');

    expect(movement.type).toBe('Outbound');
    expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'INV_1', deletedAt: null, quantity: 100, lockedQuantity: 80 },
      data: expect.objectContaining({ quantity: { increment: -20 }, lockedQuantity: { increment: 0 } }),
    }));
  });

  it('出库后低于 minStock → 发布 StockLowAlarm 事件', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      quantity: 25, lockedQuantity: 0, unit: 'YD', minStock: 20, maxStock: null,
      lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await service.createStockMovement({ itemId: 'INV_1', type: 'Outbound', quantity: 10 }, 'u_test');

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0][0];
    expect(event.type).toBe('StockLowAlarm');
    expect(event.payload.currentQty).toBe(15);
    expect(event.payload.minStock).toBe(20);
    expect(event.payload.movementType).toBe('Outbound');
  });
});

// ═══════════════════════════════════════════════════════════════
// createStockMovement — Adjustment (盘点)
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: createStockMovement Adjustment', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('盘点 → quantity 设为目标绝对值（非增减）', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      quantity: 98, lockedQuantity: 0, unit: 'YD', minStock: null, maxStock: null,
      lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await service.createStockMovement({
      itemId: 'INV_1', type: 'Adjustment', quantity: 100, reason: '盘点盈盈+2', notes: '实物盘点',
    }, 'u_test');

    // balanceBefore=98（账面）, balanceAfter=100（实物）
    expect(tx.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'Adjustment',
        quantity: 100,
        balanceBefore: 98,
        balanceAfter: 100,
        notes: '实物盘点',
      }),
    }));
    expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'INV_1', deletedAt: null, quantity: 98, lockedQuantity: 0 },
      data: expect.objectContaining({ quantity: { increment: 2 } }),
    }));
  });
});

// ═══════════════════════════════════════════════════════════════
// createStockMovement — Lock / Unlock
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: createStockMovement Lock/Unlock', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('锁定 → lockedQuantity 增加，quantity 不变', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      quantity: 100, lockedQuantity: 20, unit: 'YD', minStock: null, maxStock: null,
      lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await service.createStockMovement({
      itemId: 'INV_1', type: 'Lock', quantity: 30, reason: '订单分配',
    }, 'u_test');

    // quantity 不变（increment 0），lockedQuantity 原子增加
    expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'INV_1', deletedAt: null, quantity: 100, lockedQuantity: 20 },
      data: expect.objectContaining({ quantity: { increment: 0 }, lockedQuantity: { increment: 30 } }),
    }));
    expect(tx.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'Lock', quantity: 30, balanceBefore: 100, balanceAfter: 100 }),
    }));
  });

  it('可锁定库存不足 → 抛错（locked + new > quantity）', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 100, lockedQuantity: 80, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Lock', quantity: 30,
    }, 'u_test')).rejects.toThrow('可锁定库存不足');

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('解锁 → lockedQuantity 减少，quantity 不变', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      quantity: 100, lockedQuantity: 50, unit: 'YD', minStock: null, maxStock: null,
      lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await service.createStockMovement({
      itemId: 'INV_1', type: 'Unlock', quantity: 20, reason: '订单取消',
    }, 'u_test');

    expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'INV_1', deletedAt: null, quantity: 100, lockedQuantity: 50 },
      data: expect.objectContaining({ quantity: { increment: 0 }, lockedQuantity: { increment: -20 } }),
    }));
  });

  it('解锁数量超过已锁定 → 抛错', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 100, lockedQuantity: 10, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Unlock', quantity: 50,
    }, 'u_test')).rejects.toThrow('解锁数量超过已锁定');

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// createStockMovement — Transfer (调拨)
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: createStockMovement Transfer', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('调拨（目标仓库无同物料）→ 源仓出库 + 目标仓新建库存项 + 双流水', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '上海仓', deletedAt: null };
    const targetWarehouse = { id: 'WH_2', code: 'WH-002', name: '广州仓', isActive: true, deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      productAssetId: null, category: 'Fabric', specification: null, batchNumber: null,
      quantity: 100, lockedQuantity: 0, unit: 'YD', unitCost: 5, currency: 'CNY',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({
      existingWarehouse: warehouse, targetWarehouse, existingItem: item, existingTargetItem: null,
    });

    const service = createInventoryService(prisma);
    await service.createStockMovement({
      itemId: 'INV_1', type: 'Transfer', quantity: 30, targetWarehouseId: 'WH_2', reason: '调拨至广州',
    }, 'u_test');

    // 源仓流水（Transfer）
    expect(tx.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'Transfer',
        itemId: 'INV_1',
        warehouseId: 'WH_1',
        targetWarehouseId: 'WH_2',
        quantity: 30,
        balanceBefore: 100,
        balanceAfter: 70,
      }),
    }));
    // 源仓库存减少（CAS 原子减量）
    expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'INV_1', deletedAt: null, quantity: 100, lockedQuantity: 0 },
      data: expect.objectContaining({ quantity: { increment: -30 } }),
    }));
    // 目标仓新建库存项（notes 使用源仓库 code）
    expect(tx.inventoryItem.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        warehouseId: 'WH_2',
        description: '面料',
        materialCode: 'FAB-001',
        quantity: 30,
        lockedQuantity: 0,
        unit: 'YD',
        notes: expect.stringContaining('WH-001'),
      }),
    }));
    // 目标仓入库流水
    expect(tx.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'Inbound',
        warehouseId: 'WH_2',
        quantity: 30,
        referenceType: 'Transfer',
      }),
    }));
  });

  it('调拨（目标仓库已有同物料）→ 独立来源项不合并', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '上海仓', deletedAt: null };
    const targetWarehouse = { id: 'WH_2', code: 'WH-002', name: '广州仓', isActive: true, deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      productAssetId: null, category: 'Fabric', specification: null, batchNumber: null,
      quantity: 100, lockedQuantity: 0, unit: 'YD', unitCost: 5, currency: 'CNY',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const targetItem = { id: 'INV_2', warehouseId: 'WH_2', quantity: 20, unit: 'YD', deletedAt: null };
    const { prisma, tx } = makePrisma({
      existingWarehouse: warehouse, targetWarehouse, existingItem: item, existingTargetItem: targetItem,
    });

    const service = createInventoryService(prisma);
    await service.createStockMovement({
      itemId: 'INV_1', type: 'Transfer', quantity: 30, targetWarehouseId: 'WH_2',
    }, 'u_test');

    expect(tx.inventoryItem.update).not.toHaveBeenCalled();
    expect(tx.inventoryItem.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({quantity:30,unit:'YD',unitCost:5,currency:'CNY'})}));
  });

  it.each(['Owned','Transferred','Consignment','InTransit'])('调拨保留%s货权与订单/历史单价，忽略调用方改价', async (ownership) => {
    const item = {id:'INV_1',warehouseId:'WH_1',description:'原批次',materialCode:'FAB',productAssetId:'P',category:'Fabric',specification:'150cm',batchNumber:'B1',quantity:100,lockedQuantity:0,unit:'M',unitCost:0,currency:'USD',ownership,orderId:'O1',stockPrep:true,notes:'原始凭据',deletedAt:null};
    const {prisma,tx}=makePrisma({existingWarehouse:{id:'WH_1',code:'SRC',deletedAt:null},targetWarehouse:{id:'WH_2',isActive:true,deletedAt:null},existingItem:item,existingTargetItem:{id:'WRONG',unit:'KG',currency:'CNY',unitCost:999,ownership:'Owned',orderId:'OTHER'}});
    await createInventoryService(prisma).createStockMovement({itemId:'INV_1',type:'Transfer',quantity:10,targetWarehouseId:'WH_2',unitCost:999},'u');
    expect(tx.inventoryItem.findFirst).not.toHaveBeenCalled();
    expect(tx.inventoryItem.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({ownership,orderId:'O1',stockPrep:true,unit:'M',unitCost:0,currency:'USD',productAssetId:'P',specification:'150cm',batchNumber:'B1',locationCode:null,notes:expect.stringContaining('原始凭据')})}));
    for(const call of tx.stockMovement.create.mock.calls) expect(call[0].data.unitCost).toBe(0);
    expect(tx.stockMovement.create.mock.calls[1][0].data.referenceId).toBeTruthy();
  });

  it('未指定 targetWarehouseId → 抛错', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 100, lockedQuantity: 0, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Transfer', quantity: 30,
    }, 'u_test')).rejects.toThrow('调拨必须指定目标仓库');

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('库存不足 → 抛错（不可调拨）', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 10, lockedQuantity: 0, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Transfer', quantity: 50, targetWarehouseId: 'WH_2',
    }, 'u_test')).rejects.toThrow('库存不足');

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  // B3：锁定量拦截 —— 调拨出库同样按可用量校验（文案含锁定量数值）
  it('调拨：总量足够但含锁定量后可用量不足 → 抛错（文案含锁定量数值）', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 100, lockedQuantity: 80, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    // 可用量 = 100 - 80 = 20 < 50
    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Transfer', quantity: 50, targetWarehouseId: 'WH_2',
    }, 'u_test')).rejects.toThrow('库存不足（含锁定量 80 YD）');

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(tx.inventoryItem.updateMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// createStockMovement — CAS 并发回归（守卫式原子增量，防丢更新/超卖）
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: createStockMovement CAS 并发回归', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('CAS 快照冲突 → 重读新快照二次 CAS 成功，流水/审计取 CAS 命中时快照', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      quantity: 100, lockedQuantity: 0, unit: 'YD', minStock: null, maxStock: null,
      lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx, dbItem, stockMovementCreate, auditCreate } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    // 第一轮 CAS 时模拟并发事务已把 100 推进到 70 并提交（快照 100 陈旧）→ 守卫未命中
    tx.inventoryItem.updateMany.mockImplementationOnce(async () => {
      dbItem.quantity = 70;
      return { count: 0 };
    });

    const movement = await service.createStockMovement({
      itemId: 'INV_1', type: 'Outbound', quantity: 30, reason: '生产领料',
    }, 'u_test');

    // CAS 打了 2 次：第一次陈旧快照失败，第二次以重读后的 70 为守卫命中
    expect(tx.inventoryItem.updateMany).toHaveBeenCalledTimes(2);
    const secondCall = tx.inventoryItem.updateMany.mock.calls[1][0];
    expect(secondCall.where).toMatchObject({ id: 'INV_1', deletedAt: null, quantity: 70, lockedQuantity: 0 });
    expect(secondCall.data.quantity).toEqual({ increment: -30 });
    // 流水/审计的 before/after 取 CAS 命中时的新快照（70 → 40），丢更新被重试兜住
    expect(stockMovementCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ balanceBefore: 70, balanceAfter: 40 }),
    }));
    expect(auditCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ beforeValue: 70, afterValue: 40 }),
    }));
    expect(movement.type).toBe('Outbound');
    // mock 内存行终值 = 70 - 30 = 40（并发先行的 100→70 增量未被覆盖）
    expect(dbItem.quantity).toBe(40);
  });

  it('防超卖：陈旧快照校验通过但余额已被并发出库压低 → 重试重读后按新余额拦截', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 100, lockedQuantity: 0, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx, dbItem } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    // 陈旧快照 100 下出库 50 校验通过；但 CAS 时模拟并发大额出库已把余额压到 10 并提交
    tx.inventoryItem.updateMany.mockImplementationOnce(async () => {
      dbItem.quantity = 10;
      return { count: 0 };
    });

    // 重试重读到 10 → 可用 10 < 50 → fail-closed 拒绝（旧实现会覆盖写为 50 → 超卖）
    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Outbound', quantity: 50,
    }, 'u_test')).rejects.toThrow('库存不足');

    // 第二轮在事务前校验即被拒，CAS 只打了 1 次；快照确实重读过
    expect(tx.inventoryItem.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.inventoryItem.findUnique).toHaveBeenCalledTimes(2);
  });

  it('CAS 持续冲突达上限（5 次）→ fail-closed 抛并发冲突错误', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 100, lockedQuantity: 0, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx, stockMovementCreate } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    tx.inventoryItem.updateMany.mockResolvedValue({ count: 0 }); // 永远冲突

    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Outbound', quantity: 30,
    }, 'u_test')).rejects.toThrow('并发冲突');

    // 重试上限 5 次（每次循环一次 findUnique + 一次 updateMany）
    expect(prisma.inventoryItem.findUnique).toHaveBeenCalledTimes(5);
    expect(tx.inventoryItem.updateMany).toHaveBeenCalledTimes(5);
    // 每轮事务都尝试写流水（回滚由事务语义保证，不出现半提交）
    expect(stockMovementCreate).toHaveBeenCalledTimes(5);
  });

  it('事务内非 CAS 错误（audit reject）→ 不重试直接抛出', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 100, lockedQuantity: 0, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item, auditFail: true });

    const service = createInventoryService(prisma);
    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Inbound', quantity: 10,
    }, 'u_test')).rejects.toThrow('AUDIT_REJECT');

    // 业务/基础设施错误不占用 CAS 重试轮次
    expect(tx.inventoryItem.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.inventoryItem.findUnique).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// createStockMovement — 通用校验
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: createStockMovement 通用校验', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('非法变动类型 → validateMovementType 抛错', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 100, lockedQuantity: 0, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'InvalidType' as any, quantity: 10,
    }, 'u_test')).rejects.toThrow('非法库存变动类型');

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('库存项不存在 → 抛错', async () => {
    const { prisma, tx } = makePrisma({ existingItem: null });
    const service = createInventoryService(prisma);

    await expect(service.createStockMovement({
      itemId: 'NOT_EXIST', type: 'Inbound', quantity: 10,
    }, 'u_test')).rejects.toThrow('不存在');

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('库存项已软删除 → 抛错', async () => {
    const item = { id: 'INV_1', deletedAt: 123456, quantity: 100, lockedQuantity: 0, unit: 'YD' };
    const { prisma, tx } = makePrisma({ existingItem: item });
    const service = createInventoryService(prisma);

    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Inbound', quantity: 10,
    }, 'u_test')).rejects.toThrow('不存在');

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('audit reject → 事务回滚（fail-closed）', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 100, lockedQuantity: 0, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma } = makePrisma({ existingWarehouse: warehouse, existingItem: item, auditFail: true });
    const service = createInventoryService(prisma);

    await expect(service.createStockMovement({
      itemId: 'INV_1', type: 'Inbound', quantity: 10,
    }, 'u_test')).rejects.toThrow('AUDIT_REJECT');
  });

  it('事件发布失败不阻断业务（fire-and-forget）', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
      quantity: 5, lockedQuantity: 0, unit: 'YD', minStock: 20, maxStock: null,
      lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma } = makePrisma({ existingWarehouse: warehouse, existingItem: item });
    publishSpy.mockRejectedValueOnce(new Error('EVENT_BUS_DOWN'));

    const service = createInventoryService(prisma);
    // 触发 StockLowAlarm（5 + 10 = 15 <= 20）
    const result = await service.createStockMovement({
      itemId: 'INV_1', type: 'Inbound', quantity: 10,
    }, 'u_test');
    // 不抛错 — 事件发布是 fire-and-forget
    expect(result.type).toBe('Inbound');
  });

  it('actorId 为空时使用 system 作为 operator', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', deletedAt: null };
    const item = {
      id: 'INV_1', warehouseId: 'WH_1', quantity: 100, lockedQuantity: 0, unit: 'YD',
      minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });

    const service = createInventoryService(prisma);
    await service.createStockMovement({
      itemId: 'INV_1', type: 'Inbound', quantity: 10,
    }, '');

    expect(tx.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ operator: 'system' }),
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: 'system' }),
    }));
  });
});

// ═══════════════════════════════════════════════════════════════
// listStockMovements
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: listStockMovements', () => {
  it('按库存项 + 类型筛选 + 分页', async () => {
    const { prisma, stockMovementFindMany } = makePrisma();
    const service = createInventoryService(prisma);

    await service.listStockMovements({ itemId: 'INV_1', type: 'Inbound', limit: 50, offset: 10 });

    expect(stockMovementFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { itemId: 'INV_1', type: 'Inbound' },
      take: 50,
      skip: 10,
    }));
  });

  it('日期范围筛选', async () => {
    const { prisma, stockMovementFindMany } = makePrisma();
    const service = createInventoryService(prisma);

    await service.listStockMovements({ dateFrom: '2026-08-01', dateTo: '2026-08-31' });

    expect(stockMovementFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { movementDate: { gte: '2026-08-01', lte: '2026-08-31' } },
    }));
  });

  it('limit 上限 500', async () => {
    const { prisma, stockMovementFindMany } = makePrisma();
    const service = createInventoryService(prisma);

    await service.listStockMovements({ limit: 9999 });

    expect(stockMovementFindMany.mock.calls[0][0].take).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════
// getLowStockItems
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: getLowStockItems', () => {
  it('返回 quantity <= minStock 的库存项（内存过滤）', async () => {
    const lowItem = { id: 'INV_1', quantity: 10, minStock: 20, deletedAt: null, warehouse: { id: 'WH_1' } };
    const okItem = { id: 'INV_2', quantity: 100, minStock: 20, deletedAt: null, warehouse: { id: 'WH_1' } };
    const noMinItem = { id: 'INV_3', quantity: 5, minStock: null, deletedAt: null, warehouse: { id: 'WH_1' } };
    const { prisma } = makePrisma();
    prisma.inventoryItem.findMany.mockResolvedValue([lowItem, okItem, noMinItem]);
    const service = createInventoryService(prisma);

    const result = await service.getLowStockItems();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('INV_1');
  });

  it('查询条件包含 minStock not null', async () => {
    const { prisma, inventoryItemFindMany } = makePrisma();
    const service = createInventoryService(prisma);

    await service.getLowStockItems();

    expect(inventoryItemFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { deletedAt: null, minStock: { not: null } },
      include: { warehouse: true },
    }));
  });
});

// ═══════════════════════════════════════════════════════════════
// P4-1 回归：单位归一 + 调拨目标项匹配键（勿再踩）
//   ① 流水单位与库存项单位不同 → 必须换算后再累加（原实现直接裸加）
//   ② 不可互算单位 → 拒绝（报错优于算错）
//   ③ 调拨匹配键必须显式 IS NULL（原实现用 undefined，被 Prisma 忽略 → 命中任意物料）
// ═══════════════════════════════════════════════════════════════
describe('inventoryService: P4-1 单位归一与调拨匹配键回归', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  const makeItem = (over: Record<string, any> = {}) => ({
    id: 'INV_1', warehouseId: 'WH_1', description: '面料', materialCode: 'FAB-001',
    productAssetId: null, category: 'Fabric', specification: null, batchNumber: null,
    quantity: 0, lockedQuantity: 0, unit: 'YD', unitCost: 5, currency: 'CNY',
    minStock: null, maxStock: null, lastInDate: null, lastOutDate: null, deletedAt: null,
    ...over,
  });

  it('入库：流水单位 M 与库存项单位 YD 不同 → 按 1 yd = 0.9144 m 换算后累加', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '上海仓', deletedAt: null };
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: makeItem() });

    const service = createInventoryService(prisma);
    await service.createStockMovement({ itemId: 'INV_1', type: 'Inbound', quantity: 30, unit: 'M' }, 'u_test');

    // 30 m ÷ 0.9144 = 32.8084 yd
    expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ quantity: { increment: 32.8084 } }),
    }));
    expect(tx.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ quantity: 32.8084, unit: 'YD' }),
    }));
  });

  it('入库：不可互算单位（PCS vs YD）→ 抛错，不落库', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '上海仓', deletedAt: null };
    const { prisma } = makePrisma({ existingWarehouse: warehouse, existingItem: makeItem() });

    const service = createInventoryService(prisma);
    await expect(
      service.createStockMovement({ itemId: 'INV_1', type: 'Inbound', quantity: 10, unit: 'PCS' }, 'u_test'),
    ).rejects.toThrow('单位不可换算');
  });

  it('调拨：目标项匹配键显式 IS NULL（null 而非 undefined，后者会被 Prisma 忽略）', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '上海仓', deletedAt: null };
    const targetWarehouse = { id: 'WH_2', code: 'WH-002', name: '广州仓', isActive: true, deletedAt: null };
    const { prisma, tx } = makePrisma({
      existingWarehouse: warehouse, targetWarehouse,
      existingItem: makeItem({ quantity: 100 }), existingTargetItem: null,
    });

    const service = createInventoryService(prisma);
    await service.createStockMovement({ itemId: 'INV_1', type: 'Transfer', quantity: 10, targetWarehouseId: 'WH_2' }, 'u_test');

    expect(tx.inventoryItem.findFirst).not.toHaveBeenCalled();
    const data = tx.inventoryItem.create.mock.calls[0][0].data;
    expect(data.materialCode).toBe('FAB-001');
    expect(data.productAssetId).toBeNull();
    expect(data.batchNumber).toBeNull();
  });

  it('调拨：源库存项三键全空 → 拒绝（无法在目标仓定位对应项，禁止退化为「任意物料」）', async () => {
    const warehouse = { id: 'WH_1', code: 'WH-001', name: '上海仓', deletedAt: null };
    const targetWarehouse = { id: 'WH_2', code: 'WH-002', name: '广州仓', isActive: true, deletedAt: null };
    const { prisma } = makePrisma({
      existingWarehouse: warehouse, targetWarehouse,
      existingItem: makeItem({ materialCode: null, quantity: 100 }), existingTargetItem: null,
    });

    const service = createInventoryService(prisma);
    await expect(
      service.createStockMovement({ itemId: 'INV_1', type: 'Transfer', quantity: 10, targetWarehouseId: 'WH_2' }, 'u_test'),
    ).rejects.toThrow('缺少物料标识');
  });
});

/**
 * ★ 口径 E1（2026-09-17 校正）：`StockMovement.quantity` 恒为**绝对值（正数）**，
 *   方向由 `type` 表达；**递减体现在 `InventoryItem.quantity` 的 increment**。
 *
 * ── 为什么要这条测试 ─────────────────────────────────────
 * `prisma/schema.prisma` 的 `StockMovement.quantity` 原注释写「**Outbound 负**」——
 * **是错的**，`inventoryService` 写的是 `moveQty`（恒正）。
 * 两个字段语义不同（流水=变动量绝对值；余额=带符号当前值），**不是"同表两种口径"**。
 * 注释已校正；本测试把**真实口径钉死**，防止将来有人照旧注释把出库改成负数
 * （那会让「流水求和 = 余额变化」这类审计/重建逻辑整体错掉）。
 */
describe('★ 口径 E1：StockMovement.quantity 恒为绝对值（正数）', () => {
  const warehouse = { id: 'WH_1', code: 'WH-001', name: '主仓', isActive: true, deletedAt: null };
  const item = {
    id: 'IT_1', warehouseId: 'WH_1', quantity: 100, lockedQuantity: 0,
    unit: 'YD', deletedAt: null, minStock: 20, maxStock: 500,
  };

  it('★ 承重：Outbound 的流水数量是 **+30**（不是 -30），而余额 increment 才为负', async () => {
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: item });
    const service = createInventoryService(prisma);

    await service.createStockMovement(
      { itemId: 'IT_1', warehouseId: 'WH_1', type: 'Outbound' as any, quantity: 30, unit: 'YD', reason: '发货' } as any,
      'u_test',
    );

    const movement = tx.stockMovement.create.mock.calls[0][0].data;
    expect(movement.type).toBe('Outbound');
    // ★ 流水数量：绝对值（正）
    expect(Number(movement.quantity)).toBe(30);
    expect(Number(movement.quantity)).toBeGreaterThan(0);

    // ★ 对照：**方向没丢**，只是记在余额上（出库 ⇒ increment 为负）
    const itemUpdate = tx.inventoryItem.updateMany.mock.calls[0][0];
    expect(itemUpdate.data.quantity.increment).toBeLessThan(0);
    expect(Number(itemUpdate.data.quantity.increment)).toBe(-30);
  });

  it('★ 对照：Inbound 的流水数量同样是正数，余额 increment 为正（方向由 increment 表达）', async () => {
    const { prisma, tx } = makePrisma({ existingWarehouse: warehouse, existingItem: { ...item, quantity: 10 } });
    const service = createInventoryService(prisma);

    await service.createStockMovement(
      { itemId: 'IT_1', warehouseId: 'WH_1', type: 'Inbound' as any, quantity: 30, unit: 'YD', reason: '补货' } as any,
      'u_test',
    );

    expect(Number(tx.stockMovement.create.mock.calls[0][0].data.quantity)).toBe(30);
    const itemUpdate = tx.inventoryItem.updateMany.mock.calls[0][0];
    expect(itemUpdate.data.quantity.increment).toBeGreaterThan(0);
  });
});
