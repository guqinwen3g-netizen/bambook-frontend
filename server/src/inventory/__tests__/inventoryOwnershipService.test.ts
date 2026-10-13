/**
 * inventoryOwnershipService.test.ts — D7-② 货权标记 + 按货权汇总
 *
 * 拍板：**资产/存货报表按货权汇总，不按物理位置** —— 货权已转移的不得计入我方存货。
 *
 * 本组钉住的不变量：
 *   1. `ownedOnly` 只含 Owned（报表口径：已转移不计入我方存货）
 *   2. **数量跨单位不相加**（M / PC 各算各的 —— T7-① 跨币种不可加的同一类纪律）
 *   3. **金额跨币种不相加**（CNY / USD 各算各的）
 *   4. 货权值必须在白名单内；已是该值时幂等（不写库）
 *   5. 无 unitCost 的项不计入金额（不猜成本）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const auditCalls: any[] = [];
vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: vi.fn(async (p: any) => { auditCalls.push(p); return {}; }),
}));

import { createInventoryOwnershipService } from '../inventoryOwnershipService';

function makePrisma(items: any[] = []) {
  const updates: any[] = [];
  return {
    prisma: {
      inventoryTransfer: {findMany:async()=>[]},
      inventoryItem: {
        findFirst: async ({ where }: any) => items.find(i => i.id === where.id && i.deletedAt == null) ?? null,
        findMany: async ({ where }: any) => items.filter(i => i.deletedAt == null && (!where?.warehouseId || i.warehouseId === where.warehouseId)),
        update: async ({ where, data }: any) => { updates.push({ where, data }); return { id: where.id, ...data }; },
      },
      auditLog: { create: async () => ({ id: 'AUD1' }) },
    } as any,
    updates,
  };
}

beforeEach(() => { auditCalls.length = 0; });

describe('setOwnership — 货权标记', () => {
  it('Owned → Transferred 成功 + 写审计', async () => {
    const { prisma, updates } = makePrisma([{ id: 'INV1', ownership: 'Owned', warehouseId: 'WH_TP', deletedAt: null }]);
    const svc = createInventoryOwnershipService(prisma);
    const r = await svc.setOwnership({ itemId: 'INV1', ownership: 'Transferred', actorId: 'u1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.changed).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].data.ownership).toBe('Transferred');
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].operation).toBe('set_inventory_ownership');
  });

  it('已是该值 → 幂等（changed=false，不写库）', async () => {
    const { prisma, updates } = makePrisma([{ id: 'INV1', ownership: 'Owned', deletedAt: null }]);
    const svc = createInventoryOwnershipService(prisma);
    const r = await svc.setOwnership({ itemId: 'INV1', ownership: 'Owned' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.changed).toBe(false);
      expect(r.data.message).toContain('无需变更');
    }
    expect(updates).toHaveLength(0);
  });

  it('非法货权值 → 400', async () => {
    const { prisma } = makePrisma([{ id: 'INV1', ownership: 'Owned', deletedAt: null }]);
    const svc = createInventoryOwnershipService(prisma);
    const r = await svc.setOwnership({ itemId: 'INV1', ownership: 'Whatever' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(400);
  });

  it('库存项不存在 → 404', async () => {
    const { prisma } = makePrisma([]);
    const svc = createInventoryOwnershipService(prisma);
    const r = await svc.setOwnership({ itemId: 'NOPE', ownership: 'Transferred' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(404);
  });
});

describe('summarizeByOwnership — 按货权汇总（报表口径）', () => {
  const items = [
    { id: 'A', ownership: 'Owned', quantity: '100', unit: 'M', unitCost: '10', currency: 'CNY', warehouseId: 'WH1', deletedAt: null },
    { id: 'B', ownership: 'Owned', quantity: '50', unit: 'PC', unitCost: '20', currency: 'CNY', warehouseId: 'WH1', deletedAt: null },
    { id: 'C', ownership: 'Owned', quantity: '30', unit: 'M', unitCost: '5', currency: 'USD', warehouseId: 'WH_TP', deletedAt: null },
    { id: 'D', ownership: 'Transferred', quantity: '999', unit: 'M', unitCost: '7', currency: 'CNY', warehouseId: 'WH_TP', deletedAt: null },
  ];

  it('按货权分组；ownedOnly 只含 Owned（已转移不计入我方存货）', async () => {
    const { prisma } = makePrisma(items);
    const svc = createInventoryOwnershipService(prisma);
    const r = await svc.summarizeByOwnership();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.byOwnership.map(g => g.ownership)).toEqual(['Owned', 'Transferred']);
    const owned = r.data.ownedOnly!;
    expect(owned.itemCount).toBe(3);
    // 已转移的 999 绝不能出现在我方口径里
    const ownedQty = owned.quantityByUnit.reduce((s, x) => s + x.quantity, 0);
    expect(ownedQty).toBe(180); // 100(M) + 50(PC) + 30(M)
  });

  it('**数量跨单位不相加**（M 与 PC 各算各的）', async () => {
    const { prisma } = makePrisma(items);
    const svc = createInventoryOwnershipService(prisma);
    const r = await svc.summarizeByOwnership();
    if (!r.ok) throw new Error('expected ok');
    const owned = r.data.ownedOnly!;
    expect(owned.quantityByUnit).toEqual([
      { unit: 'M', quantity: 130 },  // 100 + 30
      { unit: 'PC', quantity: 50 },
    ]);
  });

  it('**金额跨币种不相加**（CNY / USD 各算各的）', async () => {
    const { prisma } = makePrisma(items);
    const svc = createInventoryOwnershipService(prisma);
    const r = await svc.summarizeByOwnership();
    if (!r.ok) throw new Error('expected ok');
    const owned = r.data.ownedOnly!;
    expect(owned.valueByCurrency).toEqual([
      { currency: 'CNY', value: 2000 },  // 100×10 + 50×20
      { currency: 'USD', value: 150 },   // 30×5
    ]);
  });

  it('无 unitCost 的项**不计入金额**（不猜成本）', async () => {
    const { prisma } = makePrisma([
      { id: 'A', ownership: 'Owned', quantity: '100', unit: 'M', unitCost: null, currency: 'CNY', deletedAt: null },
    ]);
    const svc = createInventoryOwnershipService(prisma);
    const r = await svc.summarizeByOwnership();
    if (!r.ok) throw new Error('expected ok');
    expect(r.data.ownedOnly!.valueByCurrency).toEqual([]);
    expect(r.data.ownedOnly!.quantityByUnit).toEqual([{ unit: 'M', quantity: 100 }]);
  });

  it('warehouseId 过滤：只看某仓（同仓可混合货权）', async () => {
    const { prisma } = makePrisma(items);
    const svc = createInventoryOwnershipService(prisma);
    const r = await svc.summarizeByOwnership({ warehouseId: 'WH_TP' });
    if (!r.ok) throw new Error('expected ok');
    // WH_TP 里同时有 Owned(C) 与 Transferred(D) —— 这正是货权必须挂在"货"上的原因
    expect(r.data.byOwnership.map(g => g.ownership)).toEqual(['Owned', 'Transferred']);
    expect(r.data.ownedOnly!.itemCount).toBe(1);
    expect(r.data.warehouseId).toBe('WH_TP');
  });

  it('空库 → byOwnership 空、ownedOnly 为 null', async () => {
    const { prisma } = makePrisma([]);
    const svc = createInventoryOwnershipService(prisma);
    const r = await svc.summarizeByOwnership();
    if (!r.ok) throw new Error('expected ok');
    expect(r.data.byOwnership).toEqual([]);
    expect(r.data.ownedOnly).toBeNull();
  });
});
