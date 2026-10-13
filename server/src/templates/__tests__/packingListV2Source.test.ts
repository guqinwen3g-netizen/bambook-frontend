import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { renderPackingListBody } from '../docTemplates/packingList';
import { assertPackingListEnvelope, buildPackingListEnvelope } from '../docTemplates/packingListSource';
import { documentSourceFingerprint } from '../../shipping/shipmentDocumentSource';

function fixture() {
  const lines = [
    { id: 'SL-A', lineNumber: 1, orderId: 'O-A', orderLineId: 'OL-A', productName: 'Actual cloth <A>', productCode: 'SKU-A', quantity: '1.2345', unit: 'm', originalOrderLine: { id: 'OL-A', orderId: 'O-A', description: 'Known original cloth', itemNo: 'KNOWN-ORIGINAL-A' } },
    { id: 'SL-B', lineNumber: 2, orderId: 'O-B', orderLineId: 'OL-B', productName: 'Actual garment B', productCode: 'SKU-B', quantity: '3.0001', unit: 'pcs', originalOrderLine: { id: 'OL-B', orderId: 'O-B' } },
  ];
  const source: any = { shipment: { id: 'S', shipmentNumber: 'SHIP-REAL', updatedAt: BigInt('9007199254740993'), totalPackages: 2,
    grossWeight: new Prisma.Decimal('60'), netWeight: new Prisma.Decimal('50'), volume: new Prisma.Decimal('0.5') },
    orders: [{ id: 'O-A', poNumber: 'PO-A', customer: 'Customer A', amount: 'private-cost' }, { id: 'O-B', poNumber: null, customer: 'Customer B' }],
    orderIds: ['O-A', 'O-B'], lines, fingerprint: 'a'.repeat(64), kind: 'legacy', cartonCoverageComplete: true,
    cartons: [
      { id: 'C-A', cartonNo: 'A-7', description: null, length: null, width: null, height: null, grossWeight: '3.001', netWeight: null, volume: '0.0051',
        items: [{ id: 'I-A', shipmentLineId: 'SL-A', orderId: 'O-A', orderLineId: 'OL-A', quantity: '1.0001', unit: 'm' }, { id: 'I-B', shipmentLineId: 'SL-B', orderId: 'O-B', orderLineId: 'OL-B', quantity: '3.0001', unit: 'pcs' }] },
      { id: 'C-Z', cartonNo: 'Z-42', description: 'Second real box', length: '30.02', width: '20', height: null, grossWeight: null, netWeight: '2', volume: null,
        items: [{ id: 'I-Z', shipmentLineId: 'SL-A', orderId: 'O-A', orderLineId: 'OL-A', quantity: '0.2344', unit: 'm' }] },
    ] };
  const document = { id: 'PL-DRAFT', type: 'PackingList', domain: 'customs', shipmentId: 'S', documentNumber: 'PL-2026-0042', issueDate: '2026-01-02', consignee: 'Real consignee' };
  const exporter = { nameEn: 'Frozen Exporter', addressEn: 'Frozen address', source: 'configured' as const, configVersion: 2 };
  const envelope = buildPackingListEnvelope(source, document, exporter);
  return { source, document, exporter, envelope };
}
const render = (f = fixture()) => renderPackingListBody(f.envelope, { nameEn: 'Later exporter must not leak', addressEn: 'Later address' });
const rehash = (value: any) => { value.packingListHash = documentSourceFingerprint(value.packingListSource); return value; };

describe('PL v2 actual frozen packing source template', () => {
  it('P01 renders the true PL number/date and frozen exporter, never an invented Invoice or today', () => {
    const html = render(); expect(html).toContain('PL-2026-0042'); expect(html).toContain('2026-01-02');
    expect(html).toContain('Frozen Exporter'); expect(html).not.toContain('Later exporter'); expect(html).not.toContain('INV-SHIP-REAL');
    const f = fixture(); f.source.lines[0].productName = null; f.source.lines[0].productCode = null; f.envelope = buildPackingListEnvelope(f.source, f.document, f.exporter);
    expect(render(f)).toContain('Known original cloth'); expect(render(f)).toContain('KNOWN-ORIGINAL-A');
  });
  it('P02 prints real sparse boxes and all same-box original lines with exact four-place quantities', () => {
    const html = render(); for (const value of ['A-7', 'Z-42', '1.0001 m', '3.0001 pcs', '0.2344 m', 'PO-A', 'Actual cloth &lt;A&gt;']) expect(html).toContain(value);
    expect(html).not.toContain('C/NO. 1-2'); expect(html).toContain('rowspan="2"');
  });
  it('P03 preserves unknown box measurements separately from known shipment header 60/50/0.5', () => {
    const f = fixture(); expect(f.envelope.packingListSource.cartons[0].netWeight).toBeNull(); expect(f.envelope.packingListSource.summaries.cartons.grossWeight).toBeNull();
    const html = render(f); expect(html).toContain('Shipment header 原运单汇总'); expect(html).toContain('>60</td>'); expect(html).toContain('>50</td>'); expect(html).toContain('>0.5</td>');
    expect(html).toContain('部分箱级测量未知'); expect(html).toContain('3.001'); expect(html).toContain('0.0051');
  });
  it('P04 keeps m and pcs quantity summaries separate and contains no Order price/cost projection', () => {
    const f = fixture(); expect(f.envelope.packingListSource.summaries.quantities).toEqual([{ unit: 'm', quantity: '1.2345' }, { unit: 'pcs', quantity: '3.0001' }]);
    const html = render(f); expect(html).toContain('1.2345 m / 3.0001 pcs'); expect(JSON.stringify(f.envelope)).not.toContain('private-cost');
  });
  it('P05 later carton/exporter changes do not change this selected frozen version', () => {
    const f = fixture(), before = render(f); f.source.cartons[0].cartonNo = 'NEW'; f.document.issueDate = '2099-12-31'; f.exporter.nameEn = 'New name';
    expect(render(f)).toBe(before); expect(f.envelope.packingListSource.source.shipmentUpdatedAt).toBe('9007199254740993');
  });
  it('P06 absent date/PO stays unknown without today or internal Order primary keys on paper', () => {
    const f = fixture(); f.document.issueDate = null as any; f.source.orders[0].poNumber = null; f.envelope = buildPackingListEnvelope(f.source, f.document, f.exporter);
    const html = render(f); expect(html).toContain('Date: —'); expect(html).not.toContain('O-A'); expect(html).not.toContain('O-B'); expect(html).not.toContain('INV-');
  });
  it('P07 wrong box/order/line mapping is rejected even after an attacker recomputes the content hash', () => {
    const f = fixture(); f.envelope.packingListSource.cartons[0].items[0].orderId = 'O-B';
    expect(() => renderPackingListBody(rehash(f.envelope), f.exporter)).toThrow();
  });
  it('P08 orphan item, overpacked quantity and invented carton range are refused by the strict source validator', () => {
    for (const change of [(v: any) => v.cartons[0].items[0].shipmentLineId = 'OTHER', (v: any) => v.cartons[0].items[0].quantity = '9', (v: any) => v.cartons[0].cartonNo = '1-60']) {
      const f = fixture(); change(f.envelope.packingListSource); expect(() => assertPackingListEnvelope(rehash(f.envelope))).toThrow();
    }
  });
  it('P09 large stored quantity preserves decimal digits without Number conversion in paper or snapshot', () => {
    const f = fixture(); f.source.lines[0].quantity = '9007199254740.0001'; f.source.cartons[0].items[0].quantity = '9007199254739.7657';
    f.envelope = buildPackingListEnvelope(f.source, f.document, f.exporter); const html = render(f);
    expect(html).toContain('9,007,199,254,740.0001 m'); expect(f.envelope.packingListSource.lines[0].quantity).toBe('9007199254740.0001');
  });
  it('P10 missing boxes stay a truthful Draft warning and never synthesize box 1-N', () => {
    const f = fixture(); f.source.cartons = []; f.source.cartonCoverageComplete = false; f.envelope = buildPackingListEnvelope(f.source, f.document, f.exporter);
    const html = render(f); expect(html).toContain('尚未登记逐箱包装资料'); expect(html).toContain('箱内分配尚未完整'); expect(html).not.toContain('1-2');
  });
  it('P11 malformed v2/fake v1 promotion and extra fiscal keys fail instead of a legacy fallback', () => {
    const f = fixture(); expect(() => renderPackingListBody({ plSourceProtocol: 2, documentSet: {} } as any, f.exporter)).toThrow();
    (f.envelope.packingListSource.orders[0] as any).amount = '1'; expect(() => assertPackingListEnvelope(rehash(f.envelope))).toThrow();
    expect(() => assertPackingListEnvelope({ ...fixture().envelope, plSourceProtocol: 1 })).toThrow();
  });
  it('P12 existing legacy renderer output remains unchanged for the original documentSet contract', () => {
    const f = fixture(); const legacy: any = { shipment: f.source.shipment, order: { poNumber: 'PO-OLD', invoiceNumber: 'INV-OLD', invoiceDate: '2020-01-01' },
      parties: { consignee: { name: 'Old customer' } }, lines: [{ description: 'Old row', quantity: 5, unit: 'pcs', cartons: 2, grossWeight: 2, netWeight: 1, volume: 0.1 }],
      totals: { quantity: 5, cartons: 2, grossWeight: 2, netWeight: 1, volume: 0.1 } };
    const html = renderPackingListBody(legacy, f.exporter); expect(html).toContain('INV-OLD'); expect(html).toContain('2020-01-01'); expect(html).toContain('Old row');
    expect(html).toContain('C/NO. 1-2'); expect(html).not.toContain('Shipment header 原运单汇总');
  });
});
