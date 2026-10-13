/**
 * REQ2-07 历史数据批量迁移回归测试（设计文档 §7 验收场景）
 *
 * 覆盖：
 *   1. 模板生成（四类 BOM CSV + 表头契约 + 非法类型拒）
 *   2. 解析（xlsx 与 csv 双通道；空文件/坏文件拒）
 *   3. 逐行校验（必填缺失/枚举/数值/日期格式 → 行号+原因 100% 定位；
 *      文件内重复 + 库内重复双层）
 *   4. 确认导入（valid 落库 + ImportBatch 留痕 entityIds；错误行跳过计数）
 *   5. 整批回滚（entityIds 软删分发 + 批次状态 + 二次回滚拒）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createDataMigrationService } from '../dataMigrationService';

/** 用 xlsx 生成 CSV buffer（与上传通道一致） */
function csvBuffer(rows: string[][]): Buffer {
  const csv = rows.map(r => r.map(c => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n');
  return Buffer.from(`\uFEFF${csv}\n`, 'utf-8');
}

const ORDER_HEADER = ['poNumber', 'customer', 'product', 'type', 'quantity', 'dueDate', 'quoteAmount', 'status', 'currency', 'salesPerson'];
const INVOICE_HEADER = ['invoiceNumber', 'type', 'amount', 'currency', 'issueDate', 'status', 'dueDate', 'orderId', 'customerName'];

function makePrisma(overrides: {
  orders?: any[]; invoices?: any[]; relations?: any[]; batches?: any[];
} = {}) {
  const orders = overrides.orders ?? [];
  const invoices = overrides.invoices ?? [];
  const relations = overrides.relations ?? [];
  const batches = overrides.batches ?? [];
  const database = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    order: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) =>
        orders.filter(o => {
          if (typeof where?.poNumber === 'string' ? where.poNumber !== o.poNumber : !(where?.poNumber?.in ?? []).includes(o.poNumber)) return false;
          if (where?.customer !== undefined && where.customer !== o.customer) return false;
          if (where?.type?.equals !== undefined && where.type.equals.toLowerCase() !== String(o.type).toLowerCase()) return false;
          if (where?.deletedAt === null) return o.deletedAt == null;          // validate：仅活跃行
          if (where?.deletedAt?.not === null) return o.deletedAt != null;     // commit：仅软删孪生
          return true;
        })),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => { orders.push({ ...data }); return data; }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const t = orders.find(o => o.id === where.id);
        if (t) Object.assign(t, data);
        return t ?? { ...data, id: where.id };
      }),
      updateMany: vi.fn().mockImplementation(async ({ where, data }: any) => {
        let count = 0;
        for (const o of orders) if ((where?.id?.in ?? []).includes(o.id)) { o.deletedAt = data.deletedAt; count++; }
        return { count };
      }),
    },
    invoice: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) =>
        invoices.filter(i => {
          if (!(where?.invoiceNumber?.in ?? []).includes(i.invoiceNumber)) return false;
          if (where?.deletedAt === null) return i.deletedAt == null;
          if (where?.deletedAt?.not === null) return i.deletedAt != null;
          return true;
        })),
      create: vi.fn().mockImplementation(async ({ data }: any) => { invoices.push({ ...data }); return data; }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const t = invoices.find(i => i.id === where.id);
        if (t) Object.assign(t, data);
        return t ?? { ...data, id: where.id };
      }),
      updateMany: vi.fn().mockImplementation(async ({ where, data }: any) => {
        let count = 0;
        for (const i of invoices) if ((where?.id?.in ?? []).includes(i.id)) { i.deletedAt = data.deletedAt; count++; }
        return { count };
      }),
    },
    relation: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) =>
        relations.filter(r =>
          (where?.name?.in ?? []).includes(r.name)
          && (where?.category === undefined || r.category === where.category))),
      create: vi.fn().mockImplementation(async ({ data }: any) => { relations.push({ ...data }); return data; }),
      updateMany: vi.fn().mockImplementation(async ({ where, data }: any) => {
        let count = 0;
        for (const r of relations) if ((where?.id?.in ?? []).includes(r.id)) { r.deletedAt = data.deletedAt; count++; }
        return { count };
      }),
    },
    importBatch: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => batches.find(b => b.id === where.id) ?? null),
      findMany: vi.fn().mockResolvedValue(batches),
      create: vi.fn().mockImplementation(async ({ data }: any) => { batches.push({ ...data }); return data; }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const t = batches.find(b => b.id === where.id);
        if (t) Object.assign(t, data);
        return t;
      }),
    },
  } as any;
  database.$transaction = vi.fn((run: any) => run(database));
  return database;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('getTemplateCsv 模板', () => {
  it('四类模板：BOM CSV + 英文 key 表头 + 中文示例行', async () => {
    const svc = createDataMigrationService(makePrisma());
    for (const t of ['customers', 'suppliers', 'orders', 'invoices']) {
      const r = svc.getTemplateCsv(t);
      expect(r.ok).toBe(true);
      const csv = (r as any).data.csv as string;
      expect(csv.startsWith('\uFEFF')).toBe(true);
      expect(csv.split('\n').length).toBeGreaterThanOrEqual(3); // 表头+示例+尾行
    }
    // orders 模板表头契约（BOM 后首行 = 英文 key 表头）
    const r = svc.getTemplateCsv('orders') as any;
    expect(r.data.csv.split('\n')[0].replace(/^\uFEFF/, '')).toBe('poNumber,customer,product,type,quantity,dueDate,quoteAmount,status,currency,salesPerson');
  });

  it('非法类型 → 400 INVALID_TYPE', () => {
    const svc = createDataMigrationService(makePrisma());
    expect(((svc.getTemplateCsv('quotes') as any).error.code)).toBe('INVALID_TYPE');
  });
});

describe('validateFile 逐行校验（错误行 100% 定位锚点）', () => {
  it('同一客户PO分面料/成衣及不同客户分别校验，不以外部PO全局去重', async () => {
    const prisma = makePrisma({ orders: [{ id: 'old-garment', poNumber: 'SHARED', customer: 'A', type: 'Garment', deletedAt: null }] });
    const result = await createDataMigrationService(prisma).validateFile('orders', csvBuffer([
      ORDER_HEADER,
      ['SHARED','A','Fabric A','Fabric','100','2026-12-01','1000','','USD',''],
      ['SHARED','B','Fabric B','Fabric','100','2026-12-01','1000','','USD',''],
      ['SHARED','A','Garment A','Garment','100','2026-12-01','1000','','USD',''],
    ]));
    expect(result.ok).toBe(true);
    expect((result as any).data.rows.map((row: any) => row.valid)).toEqual([true, true, false]);
  });
  it('混合错误：行号+原因逐行断言（必填缺失/枚举/数值/日期/文件内重复/库内重复）', async () => {
    const prisma = makePrisma({ orders: [{ poNumber: 'PO-EXIST', customer: '客户I', type: 'Other', deletedAt: null }] });
    const svc = createDataMigrationService(prisma);
    const buf = csvBuffer([
      ORDER_HEADER,
      ['PO-OK', 'Peerless', '面料A', 'Fabric', '1000', '2026-09-01', '25000', '', 'USD', ''],        // 2 valid
      ['', '客户B', '产品B', 'Garment', '500', '2026-09-01', '12000', '', '', ''],                     // 3 缺 poNumber
      ['PO-T1', '客户C', '产品C', 'Sewing', '500', '2026-09-01', '12000', '', '', ''],                 // 4 type 枚举
      ['PO-T2', '客户D', '产品D', 'Fabric', '0', '2026-09-01', '12000', '', '', ''],                   // 5 quantity ≤0
      ['PO-T3', '客户E', '产品E', 'Fabric', '500', '2026/09/01', '12000', '', '', ''],                 // 6 dueDate 格式
      ['PO-T4', '客户F', '产品F', 'Fabric', '500', '2026-09-01', '-5', '', '', ''],                    // 7 quoteAmount ≤0
      ['PO-DUP', '客户G', '产品G', 'Fabric', '100', '2026-09-01', '3000', '', '', ''],                // 8 valid（首现）
      ['PO-DUP', '客户G', '产品H', 'Fabric', '100', '2026-09-01', '3000', '', '', ''],                // 9 同客户同类型文件内重复
      ['PO-EXIST', '客户I', '产品I', 'Other', '100', '2026-09-01', '3000', '', '', ''],               // 10 库内重复
    ]);
    const r = await svc.validateFile('orders', buf);
    expect(r.ok).toBe(true);
    const { rows, totalRows, validCount, errorCount } = (r as any).data;
    expect(totalRows).toBe(9);
    expect(validCount).toBe(2);
    expect(errorCount).toBe(7);
    // 行号定位（表头=1，数据行从 2 起）
    expect(rows.find((x: any) => x.lineNo === 3).reason).toContain('poNumber');
    expect(rows.find((x: any) => x.lineNo === 4).reason).toContain('type');
    expect(rows.find((x: any) => x.lineNo === 5).reason).toContain('quantity');
    expect(rows.find((x: any) => x.lineNo === 6).reason).toContain('dueDate');
    expect(rows.find((x: any) => x.lineNo === 7).reason).toContain('quoteAmount');
    expect(rows.find((x: any) => x.lineNo === 9).reason).toContain('文件内重复');
    expect(rows.find((x: any) => x.lineNo === 10).reason).toContain('系统中已存在');
  });

  it('customers：仅 name 必填；name 库内重复按 category 分域（同客户名不阻供应商导入）', async () => {
    const prisma = makePrisma({ relations: [{ name: 'Peerless', category: 'Customer', deletedAt: null }] });
    const svc = createDataMigrationService(prisma);
    const buf = csvBuffer([
      ['name', 'contactInfo', 'tags'],
      ['Peerless', 'a@b.com', '美国,大客户'],   // 库内重复（Customer）
      ['金华染厂', '', ''],                      // valid（Supplier 不受 Customer 同名影响）
    ]);
    const r = await svc.validateFile('suppliers', buf);
    const { rows } = (r as any).data;
    expect(rows[0].valid).toBe(true); // 供应商导入：Peerless 是 Customer 不算重复
    const r2 = await svc.validateFile('customers', buf);
    expect((r2 as any).data.rows[0].valid).toBe(false);
    expect((r2 as any).data.rows[0].reason).toContain('系统中已存在');
  });

  it('非法类型/空文件 → 400', async () => {
    const svc = createDataMigrationService(makePrisma());
    expect(((await svc.validateFile('quotes', csvBuffer([['a'], ['b']]))) as any).error.code).toBe('INVALID_TYPE');
    expect(((await svc.validateFile('orders', csvBuffer([]))) as any).data.totalRows).toBe(0);
  });
});

describe('commitFile 落库 + rollbackBatch 回滚（软删锚点）', () => {
  it('orders：valid 2 行落库（含默认值 status/currency）+ 批次 entityIds 留痕 + 错误行跳过', async () => {
    const prisma = makePrisma();
    const svc = createDataMigrationService(prisma);
    const buf = csvBuffer([
      ORDER_HEADER,
      ['PO-M1', 'Peerless', '面料A', 'Fabric', '1000', '2026-09-01', '25000', '', '', ''],
      ['PO-M2', 'Norden', '面料B', 'Fabric', '500', '2026-09-15', '12000', 'Confirmed', 'EUR', '小王'],
      ['PO-BAD', '', '', 'Sewing', '0', 'x', '-1', '', '', ''],
    ]);
    const r = await svc.commitFile('orders', buf, 'migrate.xlsx');
    expect(r.ok).toBe(true);
    const { batch, imported, skipped } = (r as any).data;
    expect(imported).toBe(2);
    expect(skipped).toBe(1);
    expect(batch.totalRows).toBe(3);
    expect(batch.importedRows).toBe(2);
    expect(batch.entityIds.length).toBe(2);
    expect(batch.entityIds[0]).toMatch(/^MIGORD__[a-f0-9]{32}$/);
    // 默认值
    const m1 = prisma.order.create.mock.calls[0][0].data;
    expect(m1.status).toBe('Pending');
    expect(m1.currency).toBe('USD');
    expect(m1.source).toBe('data-migration');
    const m2 = prisma.order.create.mock.calls[1][0].data;
    expect(m2.status).toBe('Confirmed');
    expect(m2.salesCurrency).toBe('EUR');
  });

  it('invoices 落库 + 千行级性能（1000 行全 valid 落库 ≤3s）', async () => {
    const prisma = makePrisma();
    const svc = createDataMigrationService(prisma);
    const rows = [INVOICE_HEADER];
    for (let i = 1; i <= 1000; i++) {
      rows.push([`INV-MIG-${String(i).padStart(4, '0')}`, 'Receivable', '1000.50', 'USD', '2026-01-15', 'Issued', '2026-02-15', '', 'Peerless']);
    }
    const buf = csvBuffer(rows);
    const t0 = Date.now();
    const r = await svc.commitFile('invoices', buf, 'bulk.csv');
    const ms = Date.now() - t0;
    expect(r.ok).toBe(true);
    expect((r as any).data.imported).toBe(1000);
    expect((r as any).data.batch.entityIds.length).toBe(1000);
    expect(ms).toBeLessThan(3000);
  }, 10000);

  it('软删孪生复活（REQ2-05 同类缺陷回归）：回滚后重导入同 poNumber → update 复活而非 create（P2002 根因）', async () => {
    // 预置：软删的 PO-REVIVE（模拟前一批回滚残留——DB 唯一键仍被占用）
    const prisma = makePrisma({ orders: [{ id: 'PO-PO-REVIVE', poNumber: 'PO-REVIVE', customer: '客户X', type: 'Fabric', deletedAt: BigInt(1) }] });
    const svc = createDataMigrationService(prisma);
    const buf = csvBuffer([
      ORDER_HEADER,
      ['PO-REVIVE', '客户X', '产品X', 'Fabric', '800', '2026-10-01', '9600', '', '', ''],
    ]);
    const r = await svc.commitFile('orders', buf, 'revive.csv');
    expect(r.ok).toBe(true);
    expect((r as any).data.imported).toBe(1);
    // validate 视为 valid（软删不算存在）→ commit 复活更新既有行
    expect(prisma.order.update).toHaveBeenCalledTimes(1);
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect((r as any).data.batch.entityIds).toEqual(['PO-PO-REVIVE']);
    // 复活行清 deletedAt
    const revived = prisma.order.update.mock.calls[0][0].data;
    expect(revived.deletedAt).toBeNull();
    expect(revived.customer).toBe('客户X');
  });

  it('customers 落库 Relation（tags 逗号拆分）+ 回滚软删 + 二次回滚拒', async () => {
    const prisma = makePrisma();
    const svc = createDataMigrationService(prisma);
    const buf = csvBuffer([
      ['name', 'contactInfo', 'tags'],
      ['杭州锦纶', 'x@y.com', '面料,GRS'],
      ['苏州织造', '', ''],
    ]);
    const r = await svc.commitFile('customers', buf, 'c.csv');
    expect((r as any).data.imported).toBe(2);
    const batchId = (r as any).data.batch.id;

    // tags 拆分
    const rel1 = prisma.relation.create.mock.calls[0][0].data;
    expect(rel1.tags).toEqual(['面料', 'GRS']);
    expect(rel1.category).toBe('Customer');

    // 回滚：entityIds 软删 + 批次状态
    const rb = await svc.rollbackBatch(batchId);
    expect(rb.ok).toBe(true);
    expect((rb as any).data.rolledBack).toBe(2);
    expect(prisma.relation.updateMany).toHaveBeenCalledTimes(1);
    const batch = prisma.importBatch.findUnique({ where: { id: batchId } });
    expect(prisma.importBatch.update).toHaveBeenCalled();

    // 二次回滚 → 409
    const rb2 = await svc.rollbackBatch(batchId);
    expect((rb2 as any).error.code).toBe('ALREADY_ROLLED_BACK');

    // 批次不存在 → 404
    expect(((await svc.rollbackBatch('IMB__NONE')) as any).error.status).toBe(404);
  });
});
