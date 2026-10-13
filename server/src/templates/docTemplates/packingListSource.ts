/** PL v2 is a frozen, minimal shipment projection. It contains no prices,
 * payment facts, private full Order, or invented carton range/invoice number. */
import { Prisma } from '@prisma/client';
import { businessError } from '../../shared/errorCodes';
import { documentDecimal, documentSourceFingerprint, documentSourceJson, type ShipmentDocumentSource } from '../../shipping/shipmentDocumentSource';

type Text = string | null;
type Measures = { length: Text; width: Text; height: Text; grossWeight: Text; netWeight: Text; volume: Text };
export type PackingListLine = { shipmentLineId: string; orderId: Text; orderLineId: Text; lineNumber: number;
  description: Text; productCode: Text; quantity: Text; unit: Text };
export type PackingListCarton = Measures & { id: string; cartonNo: string; description: Text;
  items: Array<{ id: string; shipmentLineId: string; orderId: Text; orderLineId: Text; quantity: string; unit: Text }> };
export type PackingListSnapshot = {
  schemaVersion: 2;
  document: { id: string; documentNumber: string; issueDate: Text };
  source: { shipmentId: string; shipmentUpdatedAt: string; fingerprint: string; kind: ShipmentDocumentSource['kind'];
    orderIds: string[]; cartonCoverageComplete: boolean };
  exporter: { nameEn: string; addressEn: string; source: 'configured' | 'default'; configVersion: number | null };
  shipment: { shipmentNumber: string; vesselOrFlight: Text; voyageNumber: Text; portOfLoading: Text; portOfDischarge: Text;
    containerNumber: Text; sealNumber: Text; customsDeclarationNumber: Text };
  orders: Array<{ id: string; poNumber: Text; customer: string }>;
  consignee: { name: Text };
  lines: PackingListLine[];
  cartons: PackingListCarton[];
  summaries: { header: { packages: number | null; grossWeight: Text; netWeight: Text; volume: Text };
    cartons: { packages: number; grossWeight: Text; netWeight: Text; volume: Text };
    quantities: Array<{ unit: Text; quantity: Text }> };
  warnings: string[];
};
export type PackingListEnvelope = { plSourceProtocol: 2; packingListHash: string; packingListSource: PackingListSnapshot };

const invalid = (): never => { throw businessError('CONFLICT', '装箱单版本来源不完整或已损坏，请核对原版本。'); };
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const nullableText = (v: unknown): v is Text => v === null || typeof v === 'string';
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function object(row: any, keys: string[]): void {
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(row, key))) invalid();
}
function decimal(v: unknown, places: number, positive = false): void {
  if (v === null && !positive) return;
  if (typeof v !== 'string' || !new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${places}})?$`).test(v)
    || (positive && new Prisma.Decimal(v).lte(0))) invalid();
}
function count(v: unknown, nullable: boolean): void {
  if (v === null && nullable) return;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) invalid();
}
function measure(row: any): void {
  for (const key of ['length', 'width', 'height']) decimal(row[key], 2);
  for (const key of ['grossWeight', 'netWeight']) decimal(row[key], 3);
  decimal(row.volume, 4);
}
function sum(rows: any[], key: string): string | null {
  return !rows.length || rows.some(row => row[key] === null) ? null
    : rows.reduce((total, row) => total.plus(row[key]), new Prisma.Decimal(0)).toFixed();
}
const measureKeys = ['length', 'width', 'height', 'grossWeight', 'netWeight', 'volume'];
const measureProjection = (row: any): Measures => Object.fromEntries(measureKeys.map(key => [key, documentDecimal(row[key])])) as Measures;
const stringOrNull = (v: unknown): Text => v === null || v === undefined ? null : typeof v === 'string' ? v : invalid();

/** Validation includes cross-box/line identity and exact totals. Recomputing a
 * hash does not turn malformed goods into a valid v2 source. Native audit
 * provenance is additionally required by shipmentPackingListCommand. */
export function assertPackingListEnvelope(value: unknown): PackingListEnvelope {
  const row: any = value;
  object(row, ['plSourceProtocol', 'packingListHash', 'packingListSource']);
  if (row.plSourceProtocol !== 2 || !hash(row.packingListHash)) invalid();
  const s: PackingListSnapshot = row.packingListSource;
  object(s, ['schemaVersion', 'document', 'source', 'exporter', 'shipment', 'orders', 'consignee', 'lines', 'cartons', 'summaries', 'warnings']);
  if (s.schemaVersion !== 2 || documentSourceFingerprint(s) !== row.packingListHash) invalid();
  object(s.document, ['id', 'documentNumber', 'issueDate']);
  if (!text(s.document.id) || !text(s.document.documentNumber) || !nullableText(s.document.issueDate)
    || s.document.issueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(s.document.issueDate)) invalid();
  object(s.source, ['shipmentId', 'shipmentUpdatedAt', 'fingerprint', 'kind', 'orderIds', 'cartonCoverageComplete']);
  if (!text(s.source.shipmentId) || typeof s.source.shipmentUpdatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(s.source.shipmentUpdatedAt) || !hash(s.source.fingerprint)
    || !['legacy', 'physical', 'claim'].includes(s.source.kind) || typeof s.source.cartonCoverageComplete !== 'boolean'
    || !Array.isArray(s.source.orderIds) || s.source.orderIds.some(id => !text(id))
    || new Set(s.source.orderIds).size !== s.source.orderIds.length) invalid();
  object(s.exporter, ['nameEn', 'addressEn', 'source', 'configVersion']);
  if (!text(s.exporter.nameEn) || typeof s.exporter.addressEn !== 'string' || !['configured', 'default'].includes(s.exporter.source)
    || (s.exporter.source === 'default' ? s.exporter.configVersion !== null : !Number.isSafeInteger(s.exporter.configVersion) || s.exporter.configVersion! < 1)) invalid();
  object(s.shipment, ['shipmentNumber', 'vesselOrFlight', 'voyageNumber', 'portOfLoading', 'portOfDischarge', 'containerNumber', 'sealNumber', 'customsDeclarationNumber']);
  if (!text(s.shipment.shipmentNumber) || Object.entries(s.shipment).some(([key, v]) => key !== 'shipmentNumber' && !nullableText(v))) invalid();
  if (!Array.isArray(s.orders) || s.orders.length !== s.source.orderIds.length || new Set(s.orders.map(o => o.id)).size !== s.orders.length) invalid();
  for (const order of s.orders) {
    object(order, ['id', 'poNumber', 'customer']);
    if (!text(order.id) || !s.source.orderIds.includes(order.id) || !nullableText(order.poNumber) || typeof order.customer !== 'string') invalid();
  }
  object(s.consignee, ['name']); if (!nullableText(s.consignee.name)) invalid();
  if (!Array.isArray(s.lines) || new Set(s.lines.map(l => l.shipmentLineId)).size !== s.lines.length) invalid();
  const lines = new Map<string, PackingListLine>();
  for (const line of s.lines) {
    object(line, ['shipmentLineId', 'orderId', 'orderLineId', 'lineNumber', 'description', 'productCode', 'quantity', 'unit']);
    if (!text(line.shipmentLineId) || !nullableText(line.orderId) || !nullableText(line.orderLineId)
      || line.orderId !== null && (!s.source.orderIds.includes(line.orderId) || !text(line.orderLineId))
      || line.orderId === null && line.orderLineId !== null || !Number.isSafeInteger(line.lineNumber) || line.lineNumber < 0
      || !nullableText(line.description) || !nullableText(line.productCode) || !nullableText(line.unit)) invalid();
    decimal(line.quantity, 4); lines.set(line.shipmentLineId, line);
  }
  if (!Array.isArray(s.cartons) || new Set(s.cartons.map(c => c.id)).size !== s.cartons.length
    || new Set(s.cartons.map(c => c.cartonNo)).size !== s.cartons.length) invalid();
  const packed = new Map<string, Prisma.Decimal>(), itemIds = new Set<string>();
  for (const carton of s.cartons) {
    object(carton, ['id', 'cartonNo', 'description', ...measureKeys, 'items']);
    if (!text(carton.id) || !text(carton.cartonNo) || carton.cartonNo !== carton.cartonNo.trim()
      || /^\d+\s*(?:-|~|～|—|–|至)\s*\d+$/.test(carton.cartonNo) || !nullableText(carton.description) || !Array.isArray(carton.items)) invalid();
    measure(carton); const used = new Set<string>();
    for (const item of carton.items) {
      object(item, ['id', 'shipmentLineId', 'orderId', 'orderLineId', 'quantity', 'unit']);
      const line = lines.get(item.shipmentLineId);
      if (!text(item.id) || itemIds.has(item.id) || used.has(item.shipmentLineId) || !line
        || item.orderId !== line.orderId || item.orderLineId !== line.orderLineId || item.unit !== line.unit) invalid();
      itemIds.add(item.id); used.add(item.shipmentLineId); decimal(item.quantity, 4, true);
      packed.set(item.shipmentLineId, (packed.get(item.shipmentLineId) ?? new Prisma.Decimal(0)).plus(item.quantity));
    }
  }
  for (const [id, quantity] of packed) if (lines.get(id)!.quantity === null || quantity.gt(lines.get(id)!.quantity!)) invalid();
  const complete = s.lines.length > 0 && s.lines.every(l => l.quantity !== null && (packed.get(l.shipmentLineId) ?? new Prisma.Decimal(0)).equals(l.quantity));
  if (complete !== s.source.cartonCoverageComplete) invalid();
  object(s.summaries, ['header', 'cartons', 'quantities']);
  for (const key of ['header', 'cartons'] as const) {
    object(s.summaries[key], ['packages', 'grossWeight', 'netWeight', 'volume']); count(s.summaries[key].packages, key === 'header');
    decimal(s.summaries[key].grossWeight, 3); decimal(s.summaries[key].netWeight, 3); decimal(s.summaries[key].volume, 4);
  }
  if (s.summaries.cartons.packages !== s.cartons.length || ['grossWeight', 'netWeight', 'volume'].some(key => (s.summaries.cartons as any)[key] !== sum(s.cartons, key))) invalid();
  const units = [...new Set(s.lines.map(l => l.unit))].sort((a, b) => String(a).localeCompare(String(b)));
  if (!Array.isArray(s.summaries.quantities) || s.summaries.quantities.length !== units.length) invalid();
  units.forEach((unit, index) => {
    const quantity = s.summaries.quantities[index]; object(quantity, ['unit', 'quantity']);
    if (quantity.unit !== unit || quantity.quantity !== (unit === null ? null : sum(s.lines.filter(l => l.unit === unit), 'quantity'))) invalid();
  });
  if (!Array.isArray(s.warnings) || s.warnings.some(w => typeof w !== 'string')) invalid();
  return row;
}

export function buildPackingListEnvelope(source: ShipmentDocumentSource, document: any, exporter: PackingListSnapshot['exporter']): PackingListEnvelope {
  if (document.type !== 'PackingList' || document.domain !== 'customs' || document.shipmentId !== source.shipment.id) invalid();
  const lines: PackingListLine[] = source.lines.map(l => {
    const original = l.originalOrderLine;
    if (l.orderLineId && (!original || original.id !== l.orderLineId || original.orderId !== l.orderId)) invalid();
    return { shipmentLineId: l.id, orderId: l.orderId ?? null, orderLineId: l.orderLineId ?? null, lineNumber: l.lineNumber,
      description: stringOrNull(l.productName ?? original?.description), productCode: stringOrNull(l.productCode ?? original?.itemNo), quantity: documentDecimal(l.quantity), unit: stringOrNull(l.unit) };
  });
  const cartons: PackingListCarton[] = source.cartons.map(c => ({ id: c.id, cartonNo: c.cartonNo, description: stringOrNull(c.description), ...measureProjection(c),
    items: c.items.map((i: any) => ({ id: i.id, shipmentLineId: i.shipmentLineId, orderId: i.orderId ?? null,
      orderLineId: i.orderLineId ?? null, quantity: documentDecimal(i.quantity)!, unit: stringOrNull(i.unit) })) }));
  const shipment = source.shipment, units = [...new Set(lines.map(l => l.unit))].sort((a, b) => String(a).localeCompare(String(b)));
  const snapshot: PackingListSnapshot = {
    schemaVersion: 2, document: { id: document.id, documentNumber: document.documentNumber, issueDate: stringOrNull(document.issueDate) },
    source: { shipmentId: shipment.id, shipmentUpdatedAt: String(shipment.updatedAt), fingerprint: source.fingerprint,
      kind: source.kind, orderIds: [...source.orderIds], cartonCoverageComplete: source.cartonCoverageComplete },
    exporter: documentSourceJson(exporter),
    shipment: { shipmentNumber: shipment.shipmentNumber, vesselOrFlight: stringOrNull(shipment.vesselOrFlight), voyageNumber: stringOrNull(shipment.voyageNumber),
      portOfLoading: stringOrNull(shipment.portOfLoading), portOfDischarge: stringOrNull(shipment.portOfDischarge), containerNumber: stringOrNull(shipment.containerNumber),
      sealNumber: stringOrNull(shipment.sealNumber), customsDeclarationNumber: stringOrNull(shipment.customsDeclarationNumber) },
    orders: source.orders.map(o => ({ id: o.id, poNumber: stringOrNull(o.poNumber), customer: o.customer })), consignee: { name: stringOrNull(document.consignee) }, lines, cartons,
    summaries: { header: { packages: shipment.totalPackages ?? null, grossWeight: documentDecimal(shipment.grossWeight), netWeight: documentDecimal(shipment.netWeight), volume: documentDecimal(shipment.volume) },
      cartons: { packages: cartons.length, grossWeight: sum(cartons, 'grossWeight'), netWeight: sum(cartons, 'netWeight'), volume: sum(cartons, 'volume') },
      quantities: units.map(unit => ({ unit, quantity: unit === null ? null : sum(lines.filter(l => l.unit === unit), 'quantity') })) },
    warnings: [...(!lines.length ? ['本票尚无实际装运行。'] : []), ...(!source.cartonCoverageComplete ? ['箱内分配尚未完整覆盖本票装运行。'] : []),
      ...(cartons.some(c => c.grossWeight === null || c.netWeight === null || c.volume === null) ? ['部分箱级测量未知；票级原汇总另列，不补造箱级数值。'] : [])],
  };
  return assertPackingListEnvelope({ plSourceProtocol: 2, packingListHash: documentSourceFingerprint(snapshot), packingListSource: snapshot });
}
