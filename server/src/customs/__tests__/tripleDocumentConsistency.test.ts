/**
 * tripleDocumentConsistency.test.ts — T7-② 三单一致核对（箱单/商业发票/报关单）
 *
 * 口径 C（2026-09-16 拍板）：比金额+数量+件数+毛净重+品名，**不一致只预警不阻断**。
 * 本组用例钉住的核心不变量：
 *   1. 所有差异 severity **恒为 warning**（不得出现 critical —— 口径 C）
 *   2. 金额项**只在同币种内比**（跨币种只报币种差异，与 T7-① 同口径）
 *   3. 缺单只报 missing_document，不刷一屏无意义的「0 vs X」
 *   4. 一方缺值 → 报「无法核对」，不当作「不一致」
 */
import { describe, expect, it } from 'vitest';
import { checkTripleConsistency } from '../tripleDocumentConsistency';
import { ciActor, createCiStorage } from './ciLegacyContractStorage';

function makePrisma(seed: {
  shipment?: any;
  tradeDocuments?: any[];
  declaration?: any;
  invoice?: any;
  shipmentLines?: any[];
} = {}) {
  const state = {
    shipment: seed.shipment === undefined
      ? { id: 'SHP1', shipmentNumber: 'SHP-001', orderId: 'ORD1', totalPackages: 100, grossWeight: '1200', netWeight: '1100', deletedAt: null }
      : seed.shipment,
    tradeDocuments: seed.tradeDocuments ?? [
      { id: 'TD-PL', documentNumber: 'PL-001', status: 'Issued', type: 'PackingList', shipmentId: 'SHP1', totalAmount: null, currency: null, sourceInvoiceId: null, deletedAt: null },
      { id: 'TD-CI', documentNumber: 'CI-001', status: 'Issued', type: 'CommercialInvoice', shipmentId: 'SHP1', totalAmount: '10000', currency: 'USD', sourceInvoiceId: 'INV_NATIVE', deletedAt: null },
    ],
    declaration: seed.declaration === undefined
      ? {
          id: 'CD1', declarationNumber: 'CD-001', status: 'Released', shipmentId: 'SHP1',
          totalValue: '10000', currency: 'USD', totalPackages: 100, grossWeight: '1200', netWeight: '1100',
          lines: [{ id: 'CDL1', lineNumber: 1, productCode: 'P1', productName: 'Cotton Fabric', quantity: '100', unit: 'm', totalAmount: '10000' }],
        }
      : seed.declaration,
    invoice: seed.invoice ?? null,
    shipmentLines: seed.shipmentLines ?? [
      { id: 'SL1', lineNumber: 1, productCode: 'P1', productName: 'Cotton Fabric', quantity: '100', unit: 'm' },
    ],
  };
  const native = createCiStorage({ invoiceNumber: 'CI-001', amount: '10000', currency: state.invoice?.currency ?? 'USD' });
  Object.assign(native.tables.order[0], { id: 'ORD1' });
  native.tables.orderLine[0].orderId = 'ORD1';
  native.tables.invoice[0].orderId = 'ORD1';
  native.tables.invoiceOrderAllocation[0].orderId = 'ORD1';
  native.tables.orderShipmentBatch[0].orderId = 'ORD1'; native.tables.orderShipmentBatch[0].shipmentId = 'SHP1';
  native.tables.shipmentOrderAllocation[0].orderId = 'ORD1'; native.tables.shipmentOrderAllocation[0].shipmentId = 'SHP1';
  native.tables.shipmentOrderAllocation[0].actualQty = '100'; native.tables.shipmentOrderAllocation[0].plannedQty = '100';
  native.tables.shipment = state.shipment ? [{ ...native.tables.shipment[0], ...state.shipment }] : [];
  native.tables.shipmentLine = state.shipmentLines.map(row => ({ ...row, shipmentId: 'SHP1', orderLineId: 'OL' }));
  native.tables.shipmentCarton = []; native.tables.shipmentCartonItem = [];
  native.tables.tradeDocument = state.tradeDocuments;
  native.tables.customsDeclaration = state.declaration ? [state.declaration] : [];
  if (state.invoice) {
    Object.assign(native.tables.invoice[0], state.invoice);
    native.tables.invoiceOrderAllocation[0].invoiceId = state.invoice.id;
  }
  native.tables.documentVersion = state.tradeDocuments.filter(row => row.type === 'CommercialInvoice').map(row => ({ id: 'OLD-V1-' + row.id, documentId: row.id, version: 1, content: {} }));
  // Historical v1 exists as stored old history, not a synthesized new receipt.
  // No ciSourceProtocol/audits are manufactured to bypass canonical checks.
  return native.db as any;
}

describe('checkTripleConsistency — T7-② 三单一致（只预警不阻断）', () => {
  it('三单齐全且完全一致 → 零差异', async () => {
    const r = await checkTripleConsistency(makePrisma(), 'SHP1', { trustedActor: ciActor });
    expect(r).not.toBeNull();
    expect(r!.discrepancies).toEqual([]);
    expect(r!.documents.packingList?.documentNumber).toBe('PL-001');
    expect(r!.documents.customsDeclaration?.declarationNumber).toBe('CD-001');
  });

  it('数量不一致 → warning（口径 C：绝不 critical）', async () => {
    const r = await checkTripleConsistency(makePrisma({
      declaration: {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released', shipmentId: 'SHP1',
        totalValue: '10000', currency: 'USD', totalPackages: 100, grossWeight: '1200', netWeight: '1100',
        lines: [{ id: 'CDL1', lineNumber: 1, productCode: 'P1', productName: 'Cotton Fabric', quantity: '98', unit: 'm' }],
      },
    }), 'SHP1', { trustedActor: ciActor });
    const d = r!.discrepancies.find(x => x.type === 'quantity_mismatch');
    expect(d).toBeDefined();
    expect(d!.expected).toBe('100');
    expect(d!.actual).toBe('98');
    expect(d!.severity).toBe('warning');
    expect(r!.discrepancies.every(x => x.severity === 'warning')).toBe(true);
  });

  it('件数 / 毛重 / 净重不一致 → 各自 warning', async () => {
    const r = await checkTripleConsistency(makePrisma({
      declaration: {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released', shipmentId: 'SHP1',
        totalValue: '10000', currency: 'USD', totalPackages: 96, grossWeight: '1180', netWeight: '1080',
        lines: [{ id: 'CDL1', lineNumber: 1, productCode: 'P1', productName: 'Cotton Fabric', quantity: '100', unit: 'm' }],
      },
    }), 'SHP1', { trustedActor: ciActor });
    expect(r!.discrepancies.map(x => x.type).sort()).toEqual(['gross_weight_mismatch', 'net_weight_mismatch', 'packages_mismatch']);
  });

  it('金额不一致 → warning', async () => {
    const r = await checkTripleConsistency(makePrisma({
      declaration: {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released', shipmentId: 'SHP1',
        totalValue: '9800', currency: 'USD', totalPackages: 100, grossWeight: '1200', netWeight: '1100',
        lines: [{ id: 'CDL1', lineNumber: 1, productCode: 'P1', productName: 'Cotton Fabric', quantity: '100', unit: 'm' }],
      },
    }), 'SHP1', { trustedActor: ciActor });
    const d = r!.discrepancies.find(x => x.type === 'amount_mismatch');
    expect(d).toBeDefined();
    expect(d!.expected).toBe('10000'); // 发票侧（TradeDocument 副本）
    expect(d!.actual).toBe('9800');
  });

  it('跨币种（发票 EUR / 报关 USD）→ 只报币种差异，**不报金额差异**（与 T7-① 同口径）', async () => {
    const r = await checkTripleConsistency(makePrisma({
      tradeDocuments: [
        { id: 'TD-PL', documentNumber: 'PL-001', status: 'Issued', type: 'PackingList', shipmentId: 'SHP1', totalAmount: null, currency: null, sourceInvoiceId: null, deletedAt: null },
        { id: 'TD-CI', documentNumber: 'CI-001', status: 'Issued', type: 'CommercialInvoice', shipmentId: 'SHP1', totalAmount: '10000', currency: 'EUR', sourceInvoiceId: 'INV_NATIVE', deletedAt: null },
      ],
      invoice: { id: 'INV_NATIVE', invoiceNumber: 'CI-001', amount: '10000', currency: 'EUR' },
      declaration: {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released', shipmentId: 'SHP1',
        totalValue: '10000', currency: 'USD', totalPackages: 100, grossWeight: '1200', netWeight: '1100',
        lines: [{ id: 'CDL1', lineNumber: 1, productCode: 'P1', productName: 'Cotton Fabric', quantity: '100', unit: 'm' }],
      },
    }), 'SHP1', { trustedActor: ciActor });
    const cm = r!.discrepancies.filter(x => x.type === 'currency_mismatch');
    expect(cm).toHaveLength(1);
    expect(cm[0].expected).toBe('EUR');
    expect(cm[0].actual).toBe('USD');
    // 金额相同但币种不同 → 不得产出 amount_mismatch
    expect(r!.discrepancies.some(x => x.type === 'amount_mismatch')).toBe(false);
  });

  it('缺报关单 → 只报 missing_document，不刷「0 vs X」的组 B 差异', async () => {
    const r = await checkTripleConsistency(makePrisma({ declaration: null }), 'SHP1', { trustedActor: ciActor });
    const types = r!.discrepancies.map(x => x.type);
    expect(types).toEqual(['missing_document']);
    expect(r!.discrepancies[0].severity).toBe('warning');
    expect(r!.documents.customsDeclaration).toBeNull();
  });

  it('缺箱单/发票 → 各自 missing_document', async () => {
    const r = await checkTripleConsistency(makePrisma({ tradeDocuments: [] }), 'SHP1', { trustedActor: ciActor });
    const missing = r!.discrepancies.filter(x => x.type === 'missing_document').map(x => x.field).sort();
    expect(missing).toEqual(['commercialInvoice', 'packingList']);
  });

  it('件数一方缺值 → 报「无法核对」而非「不一致」', async () => {
    const r = await checkTripleConsistency(makePrisma({
      shipment: { id: 'SHP1', shipmentNumber: 'SHP-001', orderId: 'ORD1', totalPackages: null, grossWeight: '1200', netWeight: '1100', deletedAt: null },
    }), 'SHP1', { trustedActor: ciActor });
    const d = r!.discrepancies.find(x => x.type === 'packages_mismatch');
    expect(d).toBeDefined();
    expect(d!.expected).toContain('未填');
    expect(d!.message).toContain('无法核对');
  });

  it('品名不一致 → warning（同 productCode 但描述不同）', async () => {
    const r = await checkTripleConsistency(makePrisma({
      declaration: {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released', shipmentId: 'SHP1',
        totalValue: '10000', currency: 'USD', totalPackages: 100, grossWeight: '1200', netWeight: '1100',
        lines: [{ id: 'CDL1', lineNumber: 1, productCode: 'P1', productName: 'Fabric', quantity: '100', unit: 'm' }],
      },
    }), 'SHP1', { trustedActor: ciActor });
    const d = r!.discrepancies.find(x => x.type === 'product_name_mismatch' && x.field === 'line.1');
    expect(d).toBeDefined();
    expect(d!.expected).toBe('Cotton Fabric');
    expect(d!.actual).toBe('Fabric');
  });

  it('品名仅多出后缀（报关侧更详细，如颜色）→ 仍报 warning，但 message 点明是后缀关系', async () => {
    const r = await checkTripleConsistency(makePrisma({
      shipmentLines: [{ id: 'SL1', lineNumber: 1, productCode: 'P1', productName: '空气层面料 Air Layer', quantity: '100', unit: 'm' }],
      declaration: {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released', shipmentId: 'SHP1',
        totalValue: '10000', currency: 'USD', totalPackages: 100, grossWeight: '1200', netWeight: '1100',
        lines: [{ id: 'CDL1', lineNumber: 1, productCode: 'P1', productName: '空气层面料 Air Layer（Terracotta）', quantity: '100', unit: 'm' }],
      },
    }), 'SHP1', { trustedActor: ciActor });
    const d = r!.discrepancies.find(x => x.type === 'product_name_mismatch' && x.field === 'line.1');
    expect(d).toBeDefined();
    expect(d!.severity).toBe('warning');
    expect(d!.message).toContain('报关侧 = 装运侧 + 后缀');
  });

  it('品名大小写/多余空白差异 → 不算不一致（归一化后相同）', async () => {
    const r = await checkTripleConsistency(makePrisma({
      declaration: {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released', shipmentId: 'SHP1',
        totalValue: '10000', currency: 'USD', totalPackages: 100, grossWeight: '1200', netWeight: '1100',
        lines: [{ id: 'CDL1', lineNumber: 1, productCode: 'P1', productName: '  cotton   FABRIC ', quantity: '100', unit: 'm' }],
      },
    }), 'SHP1', { trustedActor: ciActor });
    expect(r!.discrepancies).toEqual([]);
  });

  it('发票金额优先取回链的财务 Invoice（唯一真源），而非 TradeDocument 副本', async () => {
    const r = await checkTripleConsistency(makePrisma({
      tradeDocuments: [
        { id: 'TD-PL', documentNumber: 'PL-001', status: 'Issued', type: 'PackingList', shipmentId: 'SHP1', totalAmount: null, currency: null, sourceInvoiceId: null, deletedAt: null },
        { id: 'TD-CI', documentNumber: 'INV-001', status: 'Issued', type: 'CommercialInvoice', shipmentId: 'SHP1', totalAmount: '99999', currency: 'USD', sourceInvoiceId: 'INV1', deletedAt: null },
      ],
      invoice: { id: 'INV1', invoiceNumber: 'INV-001', amount: '10000', currency: 'USD', deletedAt: null },
    }), 'SHP1', { trustedActor: ciActor });
    // 回链真源 10000 == 报关 10000 → 无金额差异（若误用副本 99999 则会报差异）
    expect(r!.discrepancies.some(x => x.type === 'amount_mismatch')).toBe(false);
    expect(r!.internal.invoiceAmount).toBe(10000);
    expect(r!.documents.commercialInvoice?.invoiceNumber).toBe('INV-001');
  });

  it('运单不存在/已软删 → null（路由层转 404）', async () => {
    expect(await checkTripleConsistency(makePrisma({ shipment: null }), 'NOPE')).toBeNull();
  });
});
