/** A distinct frozen multi-shipment projection; it is never a fabricated
 * Shipment or a fabricated independent PL. No prices/payment facts are copied. */
import { Prisma } from '@prisma/client';
import { businessError } from '../../shared/errorCodes';
import { documentDecimal as dec, documentSourceFingerprint as hash, documentSourceJson as json, type ShipmentDocumentSource } from '../../shipping/shipmentDocumentSource';
import { assertPackingListEnvelope, type PackingListSnapshot } from './packingListSource';
type Child = Omit<PackingListSnapshot, 'document' | 'exporter'> & {
  parties: { customerRelationIds: Array<string | null>; businessLines: Array<string | null>;
    consigneeRelationId: string | null; consigneeName: string | null; docRecipientRelationId: string | null; docRecipientName: string | null };
};
export type MergedPackingListSnapshot = { schemaVersion: 1; document: PackingListSnapshot['document']; exporter: PackingListSnapshot['exporter'];
  shipments: Child[]; summaries: { cartons: PackingListSnapshot['summaries']['cartons']; quantities: PackingListSnapshot['summaries']['quantities'] }; warnings: string[] };
export type MergedPackingListEnvelope = { mergedPlSourceProtocol: 1; mergedPackingListHash: string; mergedPackingListSource: MergedPackingListSnapshot };
const bad = (): never => { throw businessError('CONFLICT', '合并装箱单固定来源不完整或已损坏，请核对原版本。'); };
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const nullable = (v: unknown) => v === null || typeof v === 'string';
function keys(v: any, fields: string[]) { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== fields.length || fields.some(k => !Object.prototype.hasOwnProperty.call(v, k))) bad(); }
function sum(rows: any[], key: string) { return !rows.length || rows.some(row => row[key] === null) ? null : rows.reduce((s, row) => s.plus(row[key]), new Prisma.Decimal(0)).toFixed(); }
function summaries(shipments: Child[]): MergedPackingListSnapshot['summaries'] {
  const cartons = shipments.flatMap(s => s.cartons), lines = shipments.flatMap(s => s.lines);
  const units = [...new Set(lines.map(l => l.unit))].sort((a,b) => String(a).localeCompare(String(b)));
  return { cartons: { packages: cartons.length, grossWeight: sum(cartons,'grossWeight'), netWeight: sum(cartons,'netWeight'), volume: sum(cartons,'volume') },
    quantities: units.map(unit => ({ unit, quantity: unit === null ? null : sum(lines.filter(l => l.unit === unit),'quantity') })) };
}
export function assertMergedPackingListEnvelope(value: unknown): MergedPackingListEnvelope {
  const row: any=value; keys(row,['mergedPlSourceProtocol','mergedPackingListHash','mergedPackingListSource']);
  if (row.mergedPlSourceProtocol!==1 || !/^[a-f0-9]{64}$/.test(row.mergedPackingListHash)) bad();
  const s: MergedPackingListSnapshot=row.mergedPackingListSource; keys(s,['schemaVersion','document','exporter','shipments','summaries','warnings']);
  if (s.schemaVersion!==1 || hash(s)!==row.mergedPackingListHash || !Array.isArray(s.shipments) || s.shipments.length<2) bad();
  const ids=s.shipments.map(c=>c.source.shipmentId); if (new Set(ids).size!==ids.length || hash(ids)!==hash([...ids].sort())) bad();
  const globallyUsed=new Set<string>();
  for (const child of s.shipments) {
    keys(child,['schemaVersion','source','shipment','orders','consignee','lines','cartons','summaries','warnings','parties']);
    keys(child.parties,['customerRelationIds','businessLines','consigneeRelationId','consigneeName','docRecipientRelationId','docRecipientName']);
    if (!Array.isArray(child.parties.customerRelationIds) || child.parties.customerRelationIds.length!==child.orders.length || child.parties.customerRelationIds.some(v=>!nullable(v))
      || !Array.isArray(child.parties.businessLines) || child.parties.businessLines.length!==child.orders.length || child.parties.businessLines.some(v=>!nullable(v))
      || ['consigneeRelationId','consigneeName','docRecipientRelationId','docRecipientName'].some(k=>!nullable((child.parties as any)[k]))) bad();
    // Reuse the strict mathematical child projection validator. The document
    // here is the actual aggregate document header, not an invented child PL.
    const { parties, ...projection }=child;
    const source: PackingListSnapshot={...projection,document:s.document,exporter:s.exporter};
    assertPackingListEnvelope({plSourceProtocol:2,packingListHash:hash(source),packingListSource:source});
    if (!child.source.cartonCoverageComplete || !child.cartons.length || child.cartons.some(c=>!c.items.length)) bad();
    for (const id of [...child.lines.map(l=>l.shipmentLineId),...child.cartons.map(c=>c.id),...child.cartons.flatMap(c=>c.items.map(i=>i.id))]) {
      if (!text(id) || globallyUsed.has(id)) bad(); globallyUsed.add(id);
    }
    if (child.consignee.name!==child.parties.consigneeName) bad();
  }
  if (hash(s.summaries)!==hash(summaries(s.shipments)) || !Array.isArray(s.warnings) || s.warnings.some(v=>typeof v!=='string')) bad();
  return row;
}
export function buildMergedPackingListEnvelope(facts: ShipmentDocumentSource[], document: MergedPackingListSnapshot['document'], exporter: MergedPackingListSnapshot['exporter']): MergedPackingListEnvelope {
  if (facts.length<2) throw businessError('VALIDATION_FAILED','合并装箱单至少明确选择两张真实运单。');
  const shipments: Child[]=facts.slice().sort((a,b)=>a.shipment.id.localeCompare(b.shipment.id)).map(f=>{
    if (!f.cartonCoverageComplete || !f.cartons.length || f.cartons.some(c=>!c.items.length)) throw businessError('CONFLICT','请先完成每票真实逐箱分配，再保存合并装箱单。');
    const n=(v: any): string|null => v==null?null:typeof v==='string'?v:bad();
    const lines=f.lines.map(l=>({shipmentLineId:l.id,orderId:l.orderId??null,orderLineId:l.orderLineId??null,lineNumber:l.lineNumber,
      description:n(l.productName??l.originalOrderLine?.description),productCode:n(l.productCode??l.originalOrderLine?.itemNo),quantity:dec(l.quantity),unit:n(l.unit)}));
    const cartons=f.cartons.map(c=>({id:c.id,cartonNo:c.cartonNo,description:n(c.description),
      ...Object.fromEntries(['length','width','height','grossWeight','netWeight','volume'].map(k=>[k,dec(c[k])])) as Pick<Child['cartons'][number],'length'|'width'|'height'|'grossWeight'|'netWeight'|'volume'>,
      items:c.items.map((i:any)=>({id:i.id,shipmentLineId:i.shipmentLineId,orderId:i.orderId??null,orderLineId:i.orderLineId??null,quantity:dec(i.quantity)!,unit:n(i.unit)}))}));
    const units=[...new Set(lines.map(l=>l.unit))].sort((a,b)=>String(a).localeCompare(String(b))),sh=f.shipment;
    return {schemaVersion:2,source:{shipmentId:sh.id,shipmentUpdatedAt:String(sh.updatedAt),fingerprint:f.fingerprint,kind:f.kind,orderIds:[...f.orderIds],cartonCoverageComplete:true},
      shipment:{shipmentNumber:sh.shipmentNumber,...Object.fromEntries(['vesselOrFlight','voyageNumber','portOfLoading','portOfDischarge','containerNumber','sealNumber','customsDeclarationNumber'].map(k=>[k,n(sh[k])]))} as Child['shipment'],
      orders:f.orders.map(o=>({id:o.id,poNumber:n(o.poNumber),customer:o.customer})),consignee:{name:n(sh.consigneeName)},lines,cartons,
      summaries:{header:{packages:sh.totalPackages??null,grossWeight:dec(sh.grossWeight),netWeight:dec(sh.netWeight),volume:dec(sh.volume)},
        cartons:{packages:cartons.length,grossWeight:sum(cartons,'grossWeight'),netWeight:sum(cartons,'netWeight'),volume:sum(cartons,'volume')},
        quantities:units.map(unit=>({unit,quantity:unit===null?null:sum(lines.filter(l=>l.unit===unit),'quantity')}))},
      warnings:cartons.some(c=>c.grossWeight===null||c.netWeight===null||c.volume===null)?['部分箱级测量未知；原票级汇总另列，不补造数值。']:[],
      parties:{customerRelationIds:f.orders.map(o=>n(o.customerRelationId)),businessLines:f.orders.map(o=>n(o.businessLine)),
        consigneeRelationId:n(sh.consigneeRelationId),consigneeName:n(sh.consigneeName),docRecipientRelationId:n(sh.docRecipientRelationId),docRecipientName:n(sh.docRecipientName)}};
  });
  const warnings=[...new Set(shipments.flatMap(s=>s.warnings))];
  const customers=shipments.flatMap(s=>s.orders.map((o,i)=>s.parties.customerRelationIds[i]??o.customer));
  if (new Set(customers).size>1) warnings.push('来源客户不同；本单逐票列示，不声明共同客户。');
  if (new Set(shipments.flatMap(s=>s.parties.businessLines)).size>1) warnings.push('来源业务线不同；本单逐票列示。');
  if (new Set(shipments.map(s=>JSON.stringify([s.parties.consigneeRelationId,s.parties.consigneeName]))).size>1) warnings.push('收货主体不同；本单逐票列示，不声明共同收货方。');
  if (shipments.some(s=>s.consignee.name===null)) warnings.push('部分原票收货主体未知；不取第一票替代。');
  const source: MergedPackingListSnapshot={schemaVersion:1,document:json(document),exporter:json(exporter),shipments,summaries:summaries(shipments),warnings};
  return assertMergedPackingListEnvelope({mergedPlSourceProtocol:1,mergedPackingListHash:hash(source),mergedPackingListSource:source});
}
