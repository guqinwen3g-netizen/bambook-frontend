/**
 * P1-4 物料退换货测试（设计文档 §验收要点：500 米检出不符 100 米 → 退货扣库存 →
 * 供应商确认 → 索赔 200 USD 挂应付冲减 → 供应商绩效更新）
 *
 * 覆盖：
 *   1. createReturn 校验：type 枚举 / claim 必填金额 / return·exchange 必填物料编码与数量 /
 *      实物额度上限（totalRejected − 已占）
 *   2. markShipped：库存 Outbound 联动 + 库存不足 fail-closed + 无库存项跳过留痕 + 幂等防重
 *   3. confirmReturn：claim 生成负向 Payable 发票（CLM 前缀/负金额/claimInvoiceId 回填）+
 *      exchange 同项回冲 + 供应商绩效评分（recordAutoEvaluation 口径）
 *   4. settleReturn / cancelReturn 状态机
 *   5. returnRateScore 拒收率分级
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { createMaterialReturnService, returnRateScore } from '../materialReturnService';

function makeMockPrisma(seed: {
  receipts?: any[]; pos?: any[]; returns?: any[]; inventoryItems?: any[]; warehouses?: any[];
} = {}) {
  const receipts = [...(seed.receipts ?? [])];
  const pos = [...(seed.pos ?? [])];
  const returns = [...(seed.returns ?? [])];
  const inventoryItems = [...(seed.inventoryItems ?? [])];
  const warehouses = [...(seed.warehouses ?? [{ id: 'WH1', deletedAt: null }])];
  const invoices: any[] = [];
  const paymentVouchers: any[] = [];
  const invoiceAllocations: any[] = [];
  const creditAllocations: any[] = [];
  const stockMovements: any[] = [];
  const auditLogs: any[] = [];
  const evaluations: any[] = [];
  const sequences: Record<string, number> = {};
  const profiles = [{ id: 'FP1', relationId: 'REL-SUP', deletedAt: null }];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('increment' in cond) return true;
        return true;
      }
      if (Array.isArray(v)) return v.some((sub: any) => matchWhere(row, sub));
      return row[k] === v;
    });

  const tx: any = {
    materialReceipt: { findUnique: async ({ where }: any) => receipts.find(r => r.id === where.id) ?? null },
    purchaseOrder: { findUnique: async ({ where }: any) => pos.find(p => p.id === where.id) ?? null },
    materialReturn: {
      findUnique: async ({ where }: any) => returns.find(r => r.id === where.id) ?? null,
      findMany: async ({ where }: any) => returns.filter(r => matchWhere(r, where)),
      findFirst: async ({ where }: any) => returns.find(r => matchWhere(r, where)) ?? null,
      create: async ({ data }: any) => { const row = { claimInvoiceId: null, stockItemId: null, deletedAt: null, ...data }; returns.push(row); return row; },
      update: async ({ where, data }: any) => {
        const idx = returns.findIndex(r => r.id === where.id);
        returns[idx] = { ...returns[idx], ...data };
        return { ...returns[idx] };
      },
      updateMany: async ({ where, data }: any) => {
        const matched = returns.filter(row => matchWhere(row, where));
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      },
    },
    invoice: {
      findFirst: async ({ where }: any) => invoices.find(i => i.invoiceNumber === where.invoiceNumber) ?? null,
      findUnique: async ({ where }: any) => invoices.find(invoice => invoice.id === where.id) ?? null,
      create: async ({ data }: any) => { invoices.push({ deletedAt: null, ...data }); return data; },
    },
    paymentVoucher: { findUnique: async ({ where }: any) => paymentVouchers.find(voucher => voucher.id === where.id) ?? null },
    invoiceAllocation: { findMany: async ({ where }: any) => invoiceAllocations.filter(row => matchWhere(row, where)) },
    creditNoteAllocation: { findMany: async ({ where }: any) => creditAllocations.filter(row => matchWhere(row, where)) },
    inventoryItem: {
      findFirst: async ({ where }: any) => inventoryItems.find(i => matchWhere(i, where)) ?? null,
      findUnique: async ({ where }: any) => inventoryItems.find(i => i.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const idx = inventoryItems.findIndex(i => i.id === where.id);
        inventoryItems[idx] = { ...inventoryItems[idx], ...data };
        return { ...inventoryItems[idx] };
      },
      // CAS 守卫式原子更新（inventoryService.createStockMovement 余额路径）：
      // where 快照（quantity/lockedQuantity/deletedAt）全匹配才落库增量，否则 count=0
      updateMany: async ({ where, data }: any) => {
        const idx = inventoryItems.findIndex(i => i.id === where.id);
        if (idx < 0) return { count: 0 };
        const row = inventoryItems[idx];
        if (Number(where.quantity) !== Number(row.quantity)) return { count: 0 };
        if (Number(where.lockedQuantity ?? 0) !== Number(row.lockedQuantity ?? 0)) return { count: 0 };
        if (where.deletedAt === null && row.deletedAt != null) return { count: 0 };
        const patch: any = { ...row };
        if (typeof data?.quantity?.increment === 'number') patch.quantity = Number(row.quantity) + data.quantity.increment;
        if (typeof data?.lockedQuantity?.increment === 'number') patch.lockedQuantity = Number(row.lockedQuantity ?? 0) + data.lockedQuantity.increment;
        if (data?.lastInDate !== undefined) patch.lastInDate = data.lastInDate;
        if (data?.lastOutDate !== undefined) patch.lastOutDate = data.lastOutDate;
        inventoryItems[idx] = patch;
        return { count: 1 };
      },
    },
    warehouse: { findUnique: async ({ where }: any) => warehouses.find(w => w.id === where.id) ?? null },
    stockMovement: {
      findFirst: async ({ where }: any) => stockMovements.find(m => matchWhere(m, where)) ?? null,
      create: async ({ data }: any) => { const row = { id: `SM_${stockMovements.length + 1}`, ...data }; stockMovements.push(row); return row; },
    },
    auditLog: { findMany: async ({where}: any) => auditLogs.filter(r=>matchWhere(r,where)), create: async ({ data }: any) => { auditLogs.push(data); return data; } },
    // EntityLink 图谱（W-C A1）：inventoryService.createStockMovement 内 syncStockMovementReferences 走 tx 内 upsert
    entityReference: { upsert: async () => ({}) },
    entityLink: { upsert: async () => ({}) },
    businessSequence: {
      upsert: async ({ where }: any) => ({ id: where.id, seq: sequences[where.id] ?? 0 }),
      update: async ({ where }: any) => {
        sequences[where.id] = (sequences[where.id] ?? 0) + 1;
        return { seq: sequences[where.id] };
      },
    },
    // factoryService.recordAutoEvaluation（confirm 绩效联动经 dynamic import 真实调用）
    factoryProfile: {
      findFirst: async ({ where }: any) => profiles.find(p => where.relationId ? p.relationId === where.relationId : true) ?? null,
      findUnique: async ({ where }: any) => profiles.find(p =>
        where.id ? p.id === where.id : where.relationId ? p.relationId === where.relationId : false) ?? null,
      update: async ({ where, data }: any) => {
        const idx = profiles.findIndex(p => p.id === where.id);
        profiles[idx] = { ...profiles[idx], ...data };
        return { ...profiles[idx] };
      },
    },
    factoryEvaluation: {
      findFirst: async ({ where }: any) => evaluations.find(e => matchWhere(e, where)) ?? null,
      findMany: async ({ where }: any) => evaluations.filter(e => matchWhere(e, where)).map(e => ({ score: e.score })),
      create: async ({ data }: any) => { const row = { id: `FE_${evaluations.length + 1}`, deletedAt: null, ...data }; evaluations.push(row); return row; },
    },
  };
  // Mandatory source/document locks execute against this storage substitute.
  // These spies prove invocation only; PostgreSQL lock/rollback behavior is
  // covered by supplierClaimSettlementRealDb.test.ts, not by this fixture.
  tx.$queryRaw = vi.fn(async () => []);
  tx.$transaction = async (fn: any) => fn(tx);
  const prisma: any = { ...tx, $transaction: tx.$transaction };
  return { prisma, _stores: { receipts, pos, returns, invoices, paymentVouchers, invoiceAllocations, creditAllocations, stockMovements, auditLogs, evaluations, inventoryItems } };
}

/** Same financial facts as the SCS01 real-PG positive: the exact native
 * negative Payable is covered by a positive incoming supplier Receipt and its
 * allocation. A Paid header alone, approved outgoing payment, or unrelated
 * customer credit is not a settlement. This is financial storage input, not
 * proof that this unit substitute ran the finance HTTP producer. */
function supplierReceiptSettlement(stores: ReturnType<typeof makeMockPrisma>['_stores'], returnId: string) {
  const source = stores.returns.find(row => row.id === returnId)!;
  const invoice = stores.invoices.find(row => row.id === source.claimInvoiceId)!;
  const voucherId = `RECEIPT__${returnId}`, allocationId = `ALLOC__${invoice.id}__${voucherId}`;
  stores.paymentVouchers.push({ id: voucherId, type: 'Receipt', status: 'reconciled', amount: Math.abs(Number(invoice.amount)),
    customerRelationId: source.supplierRelationId, currency: source.currency, deletedAt: null });
  stores.invoiceAllocations.push({ id: allocationId, invoiceId: invoice.id, voucherId, appliedAmount: Math.abs(Number(invoice.amount)) });
  invoice.status = 'Paid';
  return { source, invoice, voucher: stores.paymentVouchers[stores.paymentVouchers.length - 1]!, allocationId };
}

/** 验收剧本基线：来料 500 米不合格 100 米 */
const RECEIPT = { id: 'MR-1', receiptNumber: 'MR-2026-001', purchaseOrderId: 'PO-1', totalReceived: 500, totalAccepted: 400, totalRejected: 100, rejectionReason: '色差超标', warehouseId: 'WH1', deletedAt: null };
const PO = { id: 'PO-1', poNumber: 'PO-2026-001', supplierRelationId: 'REL-SUP', supplierName: '绍兴染厂', currency: 'USD', deletedAt: null, lines:[{id:'PL1',materialCode:'FAB-X',unit:'m'}] };

beforeEach(() => { vi.clearAllMocks(); });

describe('createReturn 登记校验', () => {
  it('验收锚点：登记退货（pending，单号 RT- 前缀，reason 快照自不合格原因）', async () => {
    const { prisma, _stores } = makeMockPrisma({ receipts: [RECEIPT], pos: [PO] });
    const svc = createMaterialReturnService(prisma);
    const r = await svc.createReturn({ receiptId: 'MR-1', type: 'return', materialCode: 'FAB-X', quantity: 100, unit: 'm' });
    expect(r.ok).toBe(true);
    const row = _stores.returns[0];
    expect(row.status).toBe('pending');
    expect(row.returnNumber).toMatch(/^RT-\d{4}-\d{4}$/);
    expect(row.reason).toBe('色差超标');
    expect(row.supplierRelationId).toBe('REL-SUP');
    expect(row.type).toBe('return');
  });

  it('校验：非法 type / claim 缺金额 / return 缺物料编码或数量 / 额度上限', async () => {
    const { prisma } = makeMockPrisma({ receipts: [RECEIPT], pos: [PO] });
    const svc = createMaterialReturnService(prisma);
    expect(((await svc.createReturn({ receiptId: 'MR-1', type: 'swap', quantity: 10 })) as any).error.code).toBe('INVALID_TYPE');
    expect(((await svc.createReturn({ receiptId: 'MR-1', type: 'claim', quantity: 0 })) as any).error.code).toBe('AMOUNT_REQUIRED');
    expect(((await svc.createReturn({ receiptId: 'MR-1', type: 'return', quantity: 100 })) as any).error.code).toBe('REJECTION_SOURCE_UNRESOLVED');
    expect(((await svc.createReturn({ receiptId: 'MR-1', type: 'return', materialCode: 'FAB-X', quantity: 0 })) as any).error.code).toBe('INVALID_QUANTITY');
    // 额度：不合格 100，登记 150 → 超限
    expect(((await svc.createReturn({ receiptId: 'MR-1', type: 'return', materialCode: 'FAB-X', quantity: 150 })) as any).error.code).toBe('QUOTA_EXCEEDED');
    // 额度扣减：已登记退货 100 后再登记 → 额度 0 拒绝
    await svc.createReturn({ receiptId: 'MR-1', type: 'return', materialCode: 'FAB-X', quantity: 100 });
    expect(((await svc.createReturn({ receiptId: 'MR-1', type: 'exchange', materialCode: 'FAB-X', quantity: 10 })) as any).error.code).toBe('QUOTA_EXCEEDED');
  });

  it('claim 纯金额索赔不占实物额度（可同收据叠加）', async () => {
    const { prisma, _stores } = makeMockPrisma({ receipts: [RECEIPT], pos: [PO] });
    const svc = createMaterialReturnService(prisma);
    const r1 = await svc.createReturn({ receiptId: 'MR-1', type: 'return', materialCode: 'FAB-X', quantity: 100 });
    expect(r1.ok).toBe(true);
    const r2 = await svc.createReturn({ receiptId: 'MR-1', type: 'claim', quantity: 0, amount: 200, currency: 'USD', reason: '索赔 200 USD' });
    expect(r2.ok).toBe(true);
    expect(_stores.returns).toHaveLength(2);
  });
});

describe('markShipped 发运确认（库存联动）', () => {
  it('退回拒收品100，不扣减已验收合格库存400', async () => {
    const { prisma, _stores } = makeMockPrisma({
      receipts: [RECEIPT], pos: [PO],
      inventoryItems: [{ id: 'INV-1', warehouseId: 'WH1', materialCode: 'FAB-X', quantity: 400, unit: 'm', lockedQuantity: 0, deletedAt: null }],
    });
    const svc = createMaterialReturnService(prisma);
    const created = await svc.createReturn({ receiptId: 'MR-1', type: 'return', materialCode: 'FAB-X', quantity: 100, unit: 'm' });
    const r = await svc.markShipped((created as any).data.materialReturn.id);
    expect(r.ok).toBe(true);
    expect(_stores.stockMovements).toHaveLength(0);
    expect(Number(_stores.inventoryItems[0].quantity)).toBe(400);
    expect((r as any).data.materialReturn.status).toBe('shipped');
    expect((r as any).data.materialReturn.stockItemId).toBeNull();
  });

  it('合格库存不足或不存在都不影响未入库拒收品交回', async () => {
    const { prisma, _stores } = makeMockPrisma({
      receipts: [RECEIPT], pos: [PO],
      inventoryItems: [{ id: 'INV-1', warehouseId: 'WH1', materialCode: 'FAB-X', quantity: 50, unit: 'm', lockedQuantity: 0, deletedAt: null }],
    });
    const svc = createMaterialReturnService(prisma);
    const created = await svc.createReturn({ receiptId: 'MR-1', type: 'return', materialCode: 'FAB-X', quantity: 100 });
    const blocked = await svc.markShipped((created as any).data.materialReturn.id);
    expect(blocked.ok).toBe(true);
    expect(Number(_stores.inventoryItems[0].quantity)).toBe(50);

    // 无库存项场景（次品未入库）：跳过联动，状态仍推进
    const { prisma: prisma2, _stores: s2 } = makeMockPrisma({ receipts: [RECEIPT], pos: [PO] });
    const svc2 = createMaterialReturnService(prisma2);
    const created2 = await svc2.createReturn({ receiptId: 'MR-1', type: 'return', materialCode: 'FAB-X', quantity: 100 });
    const r2 = await svc2.markShipped((created2 as any).data.materialReturn.id);
    expect(r2.ok).toBe(true);
    expect((r2 as any).data.skipStockReason).toContain('不扣减合格库存');
    expect(s2.stockMovements).toHaveLength(0);
    expect(s2.returns[0].status).toBe('shipped');
  });

  it('重复交回登记不产生任何合格库存流水', async () => {
    const { prisma, _stores } = makeMockPrisma({
      receipts: [RECEIPT], pos: [PO],
      inventoryItems: [{ id: 'INV-1', warehouseId: 'WH1', materialCode: 'FAB-X', quantity: 400, unit: 'm', lockedQuantity: 0, deletedAt: null }],
    });
    const svc = createMaterialReturnService(prisma);
    const created = await svc.createReturn({ receiptId: 'MR-1', type: 'return', materialCode: 'FAB-X', quantity: 100 });
    const id = (created as any).data.materialReturn.id;
    await svc.markShipped(id);
    // 人为回退状态模拟「出库成功但状态更新失败」的重试
    _stores.returns[0].status = 'pending';
    const retry = await svc.markShipped(id);
    expect(retry.ok).toBe(true);
    expect(_stores.stockMovements).toHaveLength(0);
  });
});

describe('confirmReturn 供应商确认', () => {
  it('验收锚点：索赔 200 USD 确认 → 负向 Payable 发票（CLM 前缀，-200，供应商锚定）+ claimInvoiceId 回填 + 绩效评分', async () => {
    const { prisma, _stores } = makeMockPrisma({ receipts: [RECEIPT], pos: [PO] });
    const svc = createMaterialReturnService(prisma);
    const created = await svc.createReturn({ receiptId: 'MR-1', type: 'claim', quantity: 0, amount: 200, currency: 'USD', reason: '索赔 200 USD' });
    const id = (created as any).data.materialReturn.id;
    await svc.markShipped(id);
    const r = await svc.confirmReturn(id);
    expect(r.ok).toBe(true);
    const inv = _stores.invoices[0];
    expect(inv.invoiceNumber).toMatch(/^CLM-\d{4}-\d{4}$/);
    expect(Number(inv.amount)).toBe(-200);
    expect(inv.type).toBe('Payable');
    expect(inv.customerRelationId).toBe('REL-SUP');
    expect(_stores.returns[0].claimInvoiceId).toBe(inv.id);
    expect(_stores.returns[0].status).toBe('confirmed');
    // 供应商绩效：拒收率 100/500=20% > 10% → 40 分（inspection，幂等键 sourceType=materialReturn）
    expect(_stores.evaluations.length).toBe(1);
    expect(_stores.evaluations[0]).toMatchObject({ factoryId: 'FP1', kind: 'inspection', score: 40, sourceType: 'materialReturn', sourceId: id });
  });

  it('换货供应商确认不能代替新货验收入库', async () => {
    const { prisma, _stores } = makeMockPrisma({
      receipts: [RECEIPT], pos: [PO],
      inventoryItems: [{ id: 'INV-1', warehouseId: 'WH1', materialCode: 'FAB-X', quantity: 400, unit: 'm', lockedQuantity: 0, deletedAt: null }],
    });
    const svc = createMaterialReturnService(prisma);
    const created = await svc.createReturn({ receiptId: 'MR-1', type: 'exchange', materialCode: 'FAB-X', quantity: 100, unit: 'm' });
    const id = (created as any).data.materialReturn.id;
    await svc.markShipped(id);
    expect(Number(_stores.inventoryItems[0].quantity)).toBe(400);
    const r = await svc.confirmReturn(id);
    expect(r.ok).toBe(true);
    expect(_stores.stockMovements.filter(m => m.type === 'Inbound')).toHaveLength(0);
    expect(Number(_stores.inventoryItems[0].quantity)).toBe(400); // 回冲对称
  });

  it('状态机：非 shipped 确认 → 409', async () => {
    const { prisma } = makeMockPrisma({ receipts: [RECEIPT], pos: [PO] });
    const svc = createMaterialReturnService(prisma);
    const created = await svc.createReturn({ receiptId: 'MR-1', type: 'claim', quantity: 0, amount: 100 });
    const r = await svc.confirmReturn((created as any).data.materialReturn.id); // pending 直接确认
    expect((r as any).error.code).toBe('INVALID_STATUS');
  });
});

describe('settle / cancel 状态机', () => {
  it('confirmed → settled；pending → cancelled；非法流转 → 409', async () => {
    const { prisma, _stores } = makeMockPrisma({ receipts: [RECEIPT], pos: [PO] });
    const svc = createMaterialReturnService(prisma);
    const created = await svc.createReturn({ receiptId: 'MR-1', type: 'claim', quantity: 0, amount: 100 });
    const id = (created as any).data.materialReturn.id;

    expect(((await svc.settleReturn(id)) as any).error.code).toBe('INVALID_STATUS'); // pending 不可结算
    expect(((await svc.cancelReturn(id)) as any).ok).toBe(true); // pending → cancelled
    expect(((await svc.cancelReturn(id)) as any).error.code).toBe('INVALID_STATUS'); // 不可重复取消

    const created2 = await svc.createReturn({ receiptId: 'MR-1', type: 'claim', quantity: 0, amount: 100 });
    const id2 = (created2 as any).data.materialReturn.id;
    await svc.markShipped(id2);
    await svc.confirmReturn(id2);
    expect(((await svc.cancelReturn(id2)) as any).error.code).toBe('INVALID_STATUS'); // confirmed 不可取消
    const settlement = supplierReceiptSettlement(_stores, id2);
    expect((await svc.settleReturn(id2) as any).ok).toBe(true); // confirmed → settled
    expect(_stores.auditLogs.filter(audit => audit.action === 'settle_material_return')).toEqual([
      expect.objectContaining({ targetType: 'MaterialReturn', targetId: id2,
        detail: expect.objectContaining({ after: { status: 'settled', supplierClaimSettlement: {
          invoiceId: settlement.invoice.id, amount: '100', allocationIds: [settlement.allocationId],
        } } }) }),
    ]);
  });

  it.each(['unpaid', 'paid-without-allocation', 'outgoing', 'wrong-supplier', 'wrong-currency', 'missing-confirmation-audit'] as const)(
    '%s 不得代替原索赔真实同供应商收款核销，拒绝不产生结案行或成功审计', async variant => {
      const { prisma, _stores } = makeMockPrisma({ receipts: [RECEIPT], pos: [PO] });
      const svc = createMaterialReturnService(prisma);
      const created = await svc.createReturn({ receiptId: 'MR-1', type: 'claim', quantity: 0, amount: 100 });
      const id = (created as any).data.materialReturn.id;
      await svc.markShipped(id); await svc.confirmReturn(id);
      if (variant === 'paid-without-allocation') _stores.invoices[0].status = 'Paid';
      if (variant !== 'unpaid' && variant !== 'paid-without-allocation') {
        const fact = supplierReceiptSettlement(_stores, id);
        if (variant === 'outgoing') fact.voucher.type = 'Disbursement';
        if (variant === 'wrong-supplier') fact.voucher.customerRelationId = 'REL-OTHER';
        if (variant === 'wrong-currency') fact.voucher.currency = 'CNY';
        if (variant === 'missing-confirmation-audit') {
          _stores.auditLogs.splice(0, _stores.auditLogs.length, ..._stores.auditLogs.filter(audit => audit.action !== 'confirm_material_return'));
        }
      }
      const before = JSON.stringify({ source: _stores.returns, invoices: _stores.invoices, vouchers: _stores.paymentVouchers,
        allocations: _stores.invoiceAllocations, audits: _stores.auditLogs });
      const result = await svc.settleReturn(id);
      expect(result.ok).toBe(false);
      expect((result as any).error.code).toBe(variant === 'unpaid' || variant === 'paid-without-allocation' ? 'INVALID_STATE' : 'SOURCE_CLAIM_CONFLICT');
      expect(JSON.stringify({ source: _stores.returns, invoices: _stores.invoices, vouchers: _stores.paymentVouchers,
        allocations: _stores.invoiceAllocations, audits: _stores.auditLogs })).toBe(before);
      expect(_stores.returns.find(row => row.id === id).status).toBe('confirmed');
      expect(_stores.auditLogs.filter(audit => audit.action === 'settle_material_return')).toHaveLength(0);
    },
  );
});

describe('returnRateScore 拒收率分级', () => {
  it('≤5% → 90；5-10% → 70；>10% → 40；无收货 → 60', () => {
    expect(returnRateScore(10, 500)).toBe(90);
    expect(returnRateScore(50, 500)).toBe(70);
    expect(returnRateScore(100, 500)).toBe(40);
    expect(returnRateScore(0, 0)).toBe(60);
  });
});

describe('逐物料拒收证据边界',()=>{
 it('多行缺少逐行拒收证据时拒绝猜测单头额度',async()=>{
  const {prisma}=makeMockPrisma({receipts:[RECEIPT],pos:[{...PO,lines:[...PO.lines,{id:'PL2',materialCode:'BUTTON',unit:'pcs'}]}]});
  const result=await createMaterialReturnService(prisma).createReturn({receiptId:'MR-1',type:'return',materialCode:'FAB-X',quantity:1,unit:'m'});
  expect((result as any).error.code).toBe('REJECTION_SOURCE_UNRESOLVED');
 });
 it('FAB拒收20米与BUTTON拒收80粒分别限额，不能混用100的单头数',async()=>{
  const {prisma,_stores}=makeMockPrisma({receipts:[RECEIPT],pos:[{...PO,lines:[...PO.lines,{id:'PL2',materialCode:'BUTTON',unit:'pcs'}]}]});
  _stores.auditLogs.push({action:'create_material_receipt',targetType:'PurchaseOrder',targetId:'PO-1',detail:{after:{receiptId:'MR-1',lineReceipts:[{lineId:'PL1',materialCode:'FAB-X',unit:'m',accepted:300,rejected:20},{lineId:'PL2',materialCode:'BUTTON',unit:'pcs',accepted:100,rejected:80}]}}});
  const svc=createMaterialReturnService(prisma);
  expect((await svc.createReturn({receiptId:'MR-1',type:'return',materialCode:'FAB-X',quantity:21,unit:'m'}) as any).error.code).toBe('QUOTA_EXCEEDED');
  expect((await svc.createReturn({receiptId:'MR-1',type:'return',materialCode:'FAB-X',quantity:20,unit:'m'})).ok).toBe(true);
  expect((await svc.createReturn({receiptId:'MR-1',type:'exchange',materialCode:'BUTTON',quantity:80,unit:'pcs'})).ok).toBe(true);
  expect((await svc.createReturn({receiptId:'MR-1',type:'exchange',materialCode:'FAB-X',quantity:1,unit:'m'}) as any).error.code).toBe('QUOTA_EXCEEDED');
 });
 it('错误物料、错误单位及历史已扣库存单据均需核对',async()=>{
  const {prisma,_stores}=makeMockPrisma({receipts:[RECEIPT],pos:[PO]});const svc=createMaterialReturnService(prisma);
  expect((await svc.createReturn({receiptId:'MR-1',type:'return',materialCode:'OTHER',quantity:1}) as any).error.code).toBe('REJECTION_SOURCE_UNRESOLVED');
  expect((await svc.createReturn({receiptId:'MR-1',type:'return',materialCode:'FAB-X',quantity:1,unit:'kg'}) as any).error.code).toBe('REJECTION_UNIT_MISMATCH');
  const result=await svc.createReturn({receiptId:'MR-1',type:'exchange',materialCode:'FAB-X',quantity:20,unit:'m'});
  _stores.returns[0].stockItemId='LEGACY-GOOD-STOCK';
  expect((await svc.markShipped((result as any).data.materialReturn.id) as any).error.code).toBe('LEGACY_STOCK_REVIEW');
  _stores.returns[0].status='shipped';
  expect((await svc.confirmReturn((result as any).data.materialReturn.id) as any).error.code).toBe('LEGACY_STOCK_REVIEW');
  expect(_stores.stockMovements).toHaveLength(0);
 });
});

it('单行无编码按唯一来源行限额，保留null编码且不生成库存流水',async()=>{
 const {prisma,_stores}=makeMockPrisma({receipts:[RECEIPT],pos:[{...PO,lines:[{id:'PL1',materialCode:null,unit:'m'}]}]});
 _stores.auditLogs.push({action:'create_material_receipt',targetType:'PurchaseOrder',targetId:'PO-1',detail:{after:{receiptId:'MR-1',lineReceipts:[{lineId:'PL1',materialCode:null,unit:'m',accepted:400,rejected:100}]}}});
 const svc=createMaterialReturnService(prisma);
 const first=await svc.createReturn({receiptId:'MR-1',type:'return',quantity:60});
 expect(first.ok).toBe(true);expect(_stores.returns[0]).toMatchObject({materialCode:null,unit:'m'});
 expect((await svc.createReturn({receiptId:'MR-1',type:'return',quantity:41}) as any).error.code).toBe('QUOTA_EXCEEDED');
 expect((await svc.markShipped(_stores.returns[0].id)).ok).toBe(true);
 expect(_stores.stockMovements).toHaveLength(0);
});
it('多行含无编码行仍拒绝推测物料身份',async()=>{
 const {prisma}=makeMockPrisma({receipts:[RECEIPT],pos:[{...PO,lines:[{id:'PL1',materialCode:null,unit:'m'},{id:'PL2',materialCode:'B',unit:'pcs'}]}]});
 expect((await createMaterialReturnService(prisma).createReturn({receiptId:'MR-1',type:'return',quantity:1}) as any).error.code).toBe('REJECTION_SOURCE_UNRESOLVED');
});
it.each([['markShipped','pending','cancelled'],['cancelReturn','pending','shipped'],['confirmReturn','shipped','confirmed'],['settleReturn','confirmed','settled']] as const)('%s 在事务锁内拒绝已被推进的旧状态，不能重复财务副作用',async(method,initial,changed)=>{
 const {prisma,_stores}=makeMockPrisma({receipts:[RECEIPT],pos:[PO],returns:[{id:'RT1',receiptId:'MR-1',status:initial,type:'claim',amount:200,claimInvoiceId:null,deletedAt:null}]});
 const original=(prisma as any).$transaction;
 (prisma as any).$transaction=async(fn:any,...args:any[])=>{_stores.returns[0].status=changed;return original(fn,...args);};
 const result=await createMaterialReturnService(prisma)[method]('RT1');
 expect((result as any).error.code).toBe('INVALID_STATUS');
 expect(_stores.returns[0].status).toBe(changed);expect(_stores.invoices).toHaveLength(0);expect(_stores.auditLogs).toHaveLength(0);
});
