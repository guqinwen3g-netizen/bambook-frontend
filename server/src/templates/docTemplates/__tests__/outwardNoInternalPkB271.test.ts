/**
 * outwardNoInternalPkB271.test.ts — 台账 §9 B271：B269 那一族按"落点"数的时候我把落点定成了
 * 「relation 主键」，而真正的落点是**任何内部主键都不许顶替业务编号出现在对外件上**——
 * 同一把尺换个键就扫出来两处（客户发票 PDF 的订单引用行、付款申请单的来源单号），
 * 外加 B269 自己漏的两枚 xlsx 文件名当时**只有人工 curl 证人、没有门禁证人**。
 *
 * 规则仍是 B269 那条（`quotation.ts` / `paymentRequest.ts` 既有形状）：有业务编号就印编号，
 * 没有就**整段不出现**，宁缺格不拿主键顶。
 *
 * ★ 阳性对照：业务编号在时那一格照印（防止"把整行删掉蒙过去"这种假修法）。
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { createFinanceRouter } from '../../../finance/route';
import { invoicePdfHtml } from '../financeInvoice';
import { renderPaymentRequestBody } from '../paymentRequest';
import { statementExportFileName } from '../../../finance/reportExportService';

const EXPORTER = {
  nameEn: 'B271 Exporter Ltd', addressEn: 'B271 Road 1', beneficiary: '', bankName: '',
  swiftCode: '', bankAddress: '', usdAccountNumber: '',
};

const invoiceDoc = (allocs: any[]) => ({
  invoice: {
    id: 'FIN-B271-1', invoiceNumber: 'INV-B271-1', type: 'Receivable', status: 'Issued',
    currency: 'USD', amount: 1000, issueDate: '2026-09-01', dueDate: '2026-10-01',
    customerName: 'B271 Buyer Co', remark: null,
  },
  allocs,
  exporter: EXPORTER,
  relation: null,
  ordersById: new Map<string, any>(),
  linesByOrder: new Map<string, any[]>(),
  shipment: null,
}) as any;

describe('B271·客户发票 PDF 的订单引用行：没有订单号时不许拿订单主键顶位', () => {
  it('① 缺订单号 ⇒ 内部 orderId 不许出现在发票 HTML 里', () => {
    const html = invoicePdfHtml(invoiceDoc([
      { orderId: 'ORD-B271-PK-9931', orderNumber: null, poNumber: null, allocatedAmount: 1000 },
    ]));
    expect(html, '★ 病灶：`Order ${esc(a.orderNumber ?? a.orderId)}`').not.toContain('ORD-B271-PK-9931');
  });

  it('② 有订单号 ⇒ 照印订单号（阳性对照：不许用"整行删掉"蒙过去）', () => {
    const html = invoicePdfHtml(invoiceDoc([
      { orderId: 'ORD-B271-PK-9931', orderNumber: 'SO-B271-0007', poNumber: 'PO-B271-1', allocatedAmount: 1000 },
    ]));
    expect(html).toContain('SO-B271-0007');
    expect(html).toContain('PO-B271-1');
    expect(html).not.toContain('ORD-B271-PK-9931');
  });

  it('③ 只有 P/O 号、没有订单号 ⇒ 印 P/O 号，仍不许印主键', () => {
    const html = invoicePdfHtml(invoiceDoc([
      { orderId: 'ORD-B271-PK-9931', orderNumber: null, poNumber: 'PO-B271-2', allocatedAmount: 1000 },
    ]));
    expect(html).toContain('PO-B271-2');
    expect(html).not.toContain('ORD-B271-PK-9931');
  });
});

describe('B271·付款申请单的来源单号：同一族（本批引为"既有规则"的那份模板自己也在漏）', () => {
  const prDoc = (pr: any) => ({ pr }) as any;
  const base = {
    id: 'PR-B271-1', requestNumber: 'PREQ-B271-1', status: 'Pending', currency: 'CNY',
    totalAmount: '500', paymentCategory: 'Freight', sourceType: 'Shipment',
    supplierName: 'B271 Mill', supplierCode: 'SUP-B271-9',
  };

  it('④ 缺来源单号 ⇒ 内部 sourceId 不许出现在单子上', () => {
    const html = renderPaymentRequestBody(prDoc({ ...base, sourceNumber: null, sourceId: 'SRC-B271-PK-7712' }), EXPORTER, null);
    expect(html, '★ 病灶：`${pr.sourceNumber || pr.sourceId || "—"}`').not.toContain('SRC-B271-PK-7712');
  });

  it('⑤ 有来源单号 ⇒ 照印（阳性对照）', () => {
    const html = renderPaymentRequestBody(prDoc({ ...base, sourceNumber: 'SHP-B271-0042', sourceId: 'SRC-B271-PK-7712' }), EXPORTER, null);
    expect(html).toContain('SHP-B271-0042');
    expect(html).not.toContain('SRC-B271-PK-7712');
  });
});

describe('B271·两枚 xlsx 文件名：B269 改对了但没有门禁证人 ⇒ 收成一个可测的函数', () => {
  it('⑥ 名字优先、编码次之、两个都没有就整段省略对象段', () => {
    expect(statementExportFileName('客户对账单', '杭州锦绣', 'CUS-00069', null)).toBe('客户对账单_杭州锦绣_全部.xlsx');
    expect(statementExportFileName('客户对账单', null, 'CUS-00069', '2026-09-27')).toBe('客户对账单_CUS-00069_2026-09-27.xlsx');
    expect(statementExportFileName('客户对账单', null, null, null)).toBe('客户对账单_全部.xlsx');
  });

  it('★ 结构性保证：这个函数**没有**接收内部 id 的参数位（要退回主键必须改签名，改签名会红在类型上）', () => {
    expect(statementExportFileName.length, '形参个数＝4（前缀/名字/编码/to）⇒ 多一个参数位就是给内部主键开口子').toBe(4);
  });
});

/**
 * ★ 调用点证人（独立复核抓出来的洞：B269 那两枚 xlsx 文件名当时只有人工 curl 读数，
 *   回归了不会有任何门禁红）。这里把 `route.ts` 那一档钉成 HTTP 级判据——
 *   文件名里出现被查询的内部 id 就红。
 */
describe('B271·两枚 xlsx 文件名的调用点（HTTP 级证人，不再只靠人工 curl）', () => {
  const ID = 'REL-B271-PK-4242';
  const appFor = (relationRow: any) => {
    const prisma = {
      invoice: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
      invoiceAllocation: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
      paymentVoucher: { findMany: vi.fn().mockResolvedValue([]) },
      relation: { findUnique: vi.fn().mockResolvedValue(relationRow) },
    } as any;
    const app = express();
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange: vi.fn() } as any));
    return app;
  };
  const nameOf = (cd: string | undefined) => {
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd || '');
    return m ? decodeURIComponent(m[1]) : (cd || '');
  };

  it('⑦ 档案查不到（名字与编码都没有）⇒ 文件名整段省略对象段，不许把被查的 id 拼进去', async () => {
    const res = await request(appFor(null)).get(`/api/v1/finance/reports/statement?customerRelationId=${ID}&format=xlsx`);
    const fn = nameOf(res.headers['content-disposition'] as string);
    expect(res.status).toBe(200);
    expect(fn, '★ 病灶：这一档此前没有任何门禁证人').not.toContain(ID);
    expect(fn).toBe('客户对账单_全部.xlsx');
  });

  it('⑧ 阳性对照：档案有编码 ⇒ 名字优先（有名字时印名字）', async () => {
    const res = await request(appFor({ name: 'B271 Co', chineseName: '测试恒溢（B271）', code: 'CUS-B271-1' }))
      .get(`/api/v1/finance/reports/statement?customerRelationId=${ID}&format=xlsx`);
    const fn = nameOf(res.headers['content-disposition'] as string);
    expect(fn).toContain('测试恒溢（B271）');
    expect(fn).not.toContain(ID);
  });

  it('⑨ 供应商侧同族同修 ⇒ 文件名也不许带 id', async () => {
    const res = await request(appFor(null)).get(`/api/v1/finance/reports/supplier-statement?supplierRelationId=${ID}&format=xlsx`);
    const fn = nameOf(res.headers['content-disposition'] as string);
    expect(fn, '★ 病灶：供应商那枚文件名同样只在人工读数里验过').not.toContain(ID);
    expect(fn).toBe('供应商对账单_全部.xlsx');
  });
});
