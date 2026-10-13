/**
 * §10.3-8 客户单据下载：契约测试。
 *
 * 业务方定案范围：PI（形式发票）/ CI（商业发票）/ 装箱单 / 发票。
 * 本测试锁住三类**门禁**（这些是"发错文件给客户"的唯一防线）：
 *  1) 归属：不属于该客户的单据一律 404（不区分"不存在/没权限"，防探测）；
 *  2) 状态：草稿与已作废单据**绝不下发**（未定稿的价格/数量不能外流）；
 *  3) 类型：PI 必须是 Proforma、发票必须是 Receivable —— 不给客户串类型的机会。
 * 渲染链（模板/Playwright/出运装配）在本测试内 mock，只验门禁与文件名。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const renderMock = vi.hoisted(() => ({ renderServerDocument: vi.fn() }));
vi.mock('../../templates/docTemplates/registry', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, renderServerDocument: renderMock.renderServerDocument };
});

const assembleMock = vi.hoisted(() => ({ assembleDocumentSetData: vi.fn() }));
vi.mock('../../shipping/documentSetService', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assembleDocumentSetData: assembleMock.assembleDocumentSetData };
});

const pdfMock = vi.hoisted(() => ({ renderHtmlToPdf: vi.fn() }));
vi.mock('../../templates/pdf', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, renderHtmlToPdf: pdfMock.renderHtmlToPdf };
});

import {
  isCustomerDocumentKind,
  renderCustomerDocumentPdf,
} from '../documentService';

const REL = 'SIM-CUS-03';

function makePrisma(opts: { invoice?: any; shipment?: any; allocs?: any[]; ownedOrder?: any } = {}) {
  return {
    invoice: { findFirst: vi.fn().mockResolvedValue(opts.invoice ?? null) },
    shipment: { findFirst: vi.fn().mockResolvedValue(opts.shipment ?? null) },
    shipmentOrderAllocation: { findMany: vi.fn().mockResolvedValue(opts.allocs ?? []) },
    order: { findFirst: vi.fn().mockResolvedValue(opts.ownedOrder ?? null) },
  } as any;
}

describe('客户单据下载 · 种类白名单', () => {
  it('只允许 pi / invoice / ci / pl / bl / awb；其他（含报关单/验货报告）一律不是合法种类', () => {
    expect(isCustomerDocumentKind('pi')).toBe(true);
    expect(isCustomerDocumentKind('invoice')).toBe(true);
    expect(isCustomerDocumentKind('ci')).toBe(true);
    expect(isCustomerDocumentKind('pl')).toBe(true);
    // H16（2026-09-16）：提单/空运单是**给买方的物权凭证**（买方凭以提货），
    // 与「报关单/验货报告/工艺单等内部单据不提供」的原则不冲突，故纳入。
    // ⚠️ 这是对 2026-09-12 定案（4 种）的**扩展**，已标注请业务方追认。
    expect(isCustomerDocumentKind('bl')).toBe(true);
    expect(isCustomerDocumentKind('awb')).toBe(true);
    // 业务方明确不提供的（内部/官方单据）
    for (const k of ['declaration', 'inspection', 'co', 'po', 'contract', 'form_a']) {
      expect(isCustomerDocumentKind(k)).toBe(false);
    }
  });
});

describe('客户单据下载 · 发票 / PI 门禁', () => {
  const issued = { id: 'INV1', invoiceNumber: 'INV-2026-001', status: 'Issued' };

  it('已签发的应收发票 → 出 PDF，文件名带单据号', async () => {
    renderMock.renderServerDocument.mockResolvedValue('<html>ok</html>');
    pdfMock.renderHtmlToPdf.mockResolvedValue({ pdf: Buffer.from('%PDF-1.4') });
    const prisma = makePrisma({ invoice: issued });

    const r = await renderCustomerDocumentPdf(prisma, REL, 'invoice', 'INV1');
    expect(r.ok).toBe(true);
    expect(r.filename).toBe('Commercial-Invoice-INV-2026-001.pdf');
    // 必须是按本客户 + 应收类型查的
    const where = prisma.invoice.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 'INV1', customerRelationId: REL, type: 'Receivable' });
  });

  it('PI 走 Proforma 类型（同一渲染链，类型门禁独立）', async () => {
    renderMock.renderServerDocument.mockResolvedValue('<html>ok</html>');
    pdfMock.renderHtmlToPdf.mockResolvedValue({ pdf: Buffer.from('%PDF-1.4') });
    const prisma = makePrisma({ invoice: { id: 'INV2', invoiceNumber: 'PI-1', status: 'Issued' } });

    const r = await renderCustomerDocumentPdf(prisma, REL, 'pi', 'INV2');
    expect(r.ok).toBe(true);
    expect(r.filename).toBe('Proforma-Invoice-PI-1.pdf');
    expect(prisma.invoice.findFirst.mock.calls[0][0].where.type).toBe('Proforma');
  });

  it('草稿 / 已作废发票不下发（404）', async () => {
    renderMock.renderServerDocument.mockResolvedValue('<html>ok</html>');
    for (const status of ['Draft', 'Cancelled']) {
      const prisma = makePrisma({ invoice: { id: 'INV3', invoiceNumber: 'INV-3', status } });
      const r = await renderCustomerDocumentPdf(prisma, REL, 'invoice', 'INV3');
      expect(r.ok, `${status} 不应下发`).toBe(false);
      expect(r.error?.code).toBe('NOT_FOUND');
    }
  });

  it('他人发票（查询按 relationId 过滤）→ 404', async () => {
    const prisma = makePrisma({ invoice: null });
    const r = await renderCustomerDocumentPdf(prisma, REL, 'invoice', 'INV-OTHER');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('模板缺失（渲染链返回 null）→ 404，不返回空 PDF', async () => {
    renderMock.renderServerDocument.mockResolvedValue(null);
    const prisma = makePrisma({ invoice: issued });
    const r = await renderCustomerDocumentPdf(prisma, REL, 'invoice', 'INV1');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('NOT_FOUND');
  });
});

describe('客户单据下载 · 出运单据（CI / 装箱单）门禁', () => {
  const shipped = { id: 'SHP1', shipmentNumber: 'SHP-2026-001', customerRelationId: REL, status: 'Shipped' };

  it('直接归属本客户的已发运运单 → CI 出 PDF', async () => {
    assembleMock.assembleDocumentSetData.mockResolvedValue({ ok: true, data: { shipment: { id: 'SHP1' } } });
    renderMock.renderServerDocument.mockResolvedValue('<html>ci</html>');
    pdfMock.renderHtmlToPdf.mockResolvedValue({ pdf: Buffer.from('%PDF-1.4') });
    const prisma = makePrisma({ shipment: shipped });

    const r = await renderCustomerDocumentPdf(prisma, REL, 'ci', 'SHP1');
    expect(r.ok).toBe(true);
    expect(r.filename).toBe('Commercial-Invoice-SHP-2026-001.pdf');
    expect(renderMock.renderServerDocument.mock.calls.at(-1)![1]).toBe('CI');
  });

  it('多单拼柜：运单未直接挂本客户，但分配表的来源订单属于本客户 → 放行', async () => {
    assembleMock.assembleDocumentSetData.mockResolvedValue({ ok: true, data: {} });
    renderMock.renderServerDocument.mockResolvedValue('<html>pl</html>');
    pdfMock.renderHtmlToPdf.mockResolvedValue({ pdf: Buffer.from('%PDF-1.4') });
    const prisma = makePrisma({
      shipment: { id: 'SHP2', shipmentNumber: 'SHP-2', customerRelationId: 'OTHER', status: 'Shipped' },
      allocs: [{ orderId: 'O1' }, { orderId: 'O2' }],
      ownedOrder: { id: 'O2' },
    });

    const r = await renderCustomerDocumentPdf(prisma, REL, 'pl', 'SHP2');
    expect(r.ok).toBe(true);
    expect(renderMock.renderServerDocument.mock.calls.at(-1)![1]).toBe('PL');
  });

  it('分配表的来源订单都属于别人 → 404', async () => {
    const prisma = makePrisma({
      shipment: { id: 'SHP3', shipmentNumber: 'SHP-3', customerRelationId: 'OTHER', status: 'Shipped' },
      allocs: [{ orderId: 'O9' }],
      ownedOrder: null,
    });
    const r = await renderCustomerDocumentPdf(prisma, REL, 'ci', 'SHP3');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('草稿/已取消运单不下发；装配失败 → 404', async () => {
    for (const status of ['Draft', 'Cancelled']) {
      const prisma = makePrisma({ shipment: { ...shipped, status } });
      const r = await renderCustomerDocumentPdf(prisma, REL, 'ci', 'SHP1');
      expect(r.ok, `${status} 不应下发`).toBe(false);
    }
    assembleMock.assembleDocumentSetData.mockResolvedValue({ ok: false, error: { code: 'SHIPMENT_NOT_FOUND' } });
    const prisma = makePrisma({ shipment: shipped });
    const r = await renderCustomerDocumentPdf(prisma, REL, 'ci', 'SHP1');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('NOT_FOUND');
  });
});
