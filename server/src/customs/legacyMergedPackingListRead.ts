/** Historical composite producer compatibility, reads only. It never mints
 * carton/source receipts, regenerates files or invokes the sealed old writer. */
import type { TokenPayload } from '../auth/service';
import { businessError, readBusinessErrorMint } from '../shared/errorCodes';
import { currentDocumentActor, authorizedDocumentOrders, documentSourceFingerprint as hash,
  documentSourceJson as json } from '../shipping/shipmentDocumentSource';
import type { MergedDocumentSetData } from '../templates/docTemplates/mergedPackingList';
const prefix = 'composite:MERGED_PL:';
const bad = (): never => { throw businessError('CONFLICT', '历史合并装箱单来源无法完整核对；保留原记录待核对。'); };
const missing = (): never => { throw businessError('NOT_FOUND', '历史合并装箱单不存在或不可查看。'); };
const ids = (values: string[]) => [...new Set(values)].sort();
const record = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v: any) => typeof v === 'string' && !!v.trim() && v === v.trim();
const optionalText = (v: any) => v == null || typeof v === 'string';
const number = (v: any) => v === null || typeof v === 'number' && Number.isFinite(v);
export function isLegacyMergedPackingListReadCandidate(document: any): boolean {
  return typeof document?.sourceRef === 'string' && document.sourceRef.startsWith(prefix);
}
export type LegacyMergedPackingListPreview = { legacyMergedReadProtocol: 1; data: MergedDocumentSetData;
  document: { documentNumber: string; issueDate: string | null }; version: number; createdAt: string };
function snapshot(document: any, version: any) {
  if (!document || document.deletedAt != null) missing();
  if (document.domain !== 'customs' || document.type !== 'PackingList' || document.shipmentId !== null || document.orderId !== null
    || !text(document.documentNumber) || !isLegacyMergedPackingListReadCandidate(document)) bad();
  const c = version?.content, data = c?.data;
  if (!record(c) || Object.keys(c).sort().join(',') !== 'data,kind,source,sourceIds' || c.source !== 'composite' || c.kind !== 'MERGED_PL'
    || !Array.isArray(c.sourceIds) || c.sourceIds.length < 2 || c.sourceIds.length > 200 || c.sourceIds.some((id: any) => !text(id) || id.includes(','))
    || ids(c.sourceIds).length !== c.sourceIds.length || document.sourceRef !== prefix + [...c.sourceIds].sort().join(',')
    || !record(data) || Object.keys(data).sort().join(',') !== 'lines,missing,orders,parties,shipments,totals'
    || !Array.isArray(data.shipments) || !Array.isArray(data.orders) || !Array.isArray(data.lines) || !Array.isArray(data.missing)
    || data.shipments.length !== c.sourceIds.length || data.orders.length !== c.sourceIds.length
    || data.missing.some((v: any) => typeof v !== 'string') || !record(data.parties) || !record(data.totals)) bad();
  for (let i = 0; i < c.sourceIds.length; i++) {
    const ship = data.shipments[i], order = data.orders[i];
    if (!record(ship) || ship.id !== c.sourceIds[i] || !text(ship.shipmentNumber) || typeof ship.status !== 'string'
      || ['vesselOrFlight','voyageNumber','portOfLoading','portOfDischarge','containerNumber','sealNumber'].some(k => !optionalText(ship[k]))
      || ['totalPackages','grossWeight','netWeight','volume'].some(k => !number(ship[k]))
      || order !== null && (!record(order) || !text(order.id) || typeof order.customer !== 'string' || !optionalText(order.poNumber))) bad();
  }
  if (data.lines.some((line: any) => !record(line) || !Number.isInteger(line.shipmentIndex) || line.shipmentIndex < 1 || line.shipmentIndex > c.sourceIds.length
    || !Number.isInteger(line.lineNumber) || line.lineNumber < 1 || typeof line.description !== 'string' || !number(line.quantity)
    || ['cartons','grossWeight','netWeight','volume'].some(k => line[k] !== undefined && !number(line[k]))
    || ['productCode','unit'].some(k => !optionalText(line[k])))) bad();
  if (['customer','consignee','carrier'].some(k => data.parties[k] !== null && (!record(data.parties[k]) || typeof data.parties[k].name !== 'string'
    || !optionalText(data.parties[k].address) || !optionalText(data.parties[k].contact)))
    || ['quantity','amount','cartons','grossWeight','netWeight','volume'].some(k => !number(data.totals[k])) || !optionalText(data.totals.currency)) bad();
  return { sourceIds: [...c.sourceIds] as string[], frozenParents: ids(data.orders.filter(Boolean).map((o: any) => o.id)) as string[], data: data as MergedDocumentSetData };
}
async function oldAudits(tx: any, document: any, version: any) {
  const rows = await tx.auditLog.findMany({ where: { targetType: 'TradeDocument', targetId: document.id }, orderBy: { id: 'asc' } });
  if (rows.some((a: any) => ['APPEND_PACKING_LIST_DRAFT','MERGED_PACKING_LIST_VERSION'].includes(a.action)
    || a.detail?.packingListRegistration || a.detail?.packingListReceipt || a.detail?.mergedPackingListReceipt)) bad();
  const created = rows.filter((a: any) => a.action === 'TRADE_DOCUMENT_CREATE' && a.detail?.source === 'composite'
    && a.detail?.type === 'PackingList' && a.detail?.kind === 'MERGED_PL' && a.detail?.sourceRef === document.sourceRef
    && a.detail?.documentNumber === document.documentNumber);
  const selected = rows.filter((a: any) => a.action === 'DOCUMENT_VERSION_CREATE' && a.detail?.source === 'lifecycle'
    && a.detail?.version === version.version && a.actorId === version.changedBy && a.detail?.changeReason === version.changeReason);
  if (created.length !== 1 || selected.length !== 1) bad();
  return hash({ created, selected });
}
async function currentParents(tx: any, sourceIds: string[]) {
  const all: any[] = [], parentIds: string[] = [];
  try {
    for (const id of sourceIds) {
      const [shipment, lines, allocations, physical] = await Promise.all([
        tx.shipment.findUnique({ where: { id }, select: { id: true, orderId: true, status: true, deletedAt: true } }),
        tx.shipmentLine.findMany({ where: { shipmentId: id }, select: { id: true, orderLineId: true }, orderBy: { id: 'asc' } }),
        tx.shipmentOrderAllocation.findMany({ where: { shipmentId: id }, select: { id: true, orderId: true, orderLineId: true }, orderBy: { id: 'asc' } }),
        tx.shipmentProductionAllocation.findMany({ where: { shipmentId: id }, select: { id: true, orderId: true, orderLineId: true }, orderBy: { id: 'asc' } }),
      ]);
      if (!shipment || !Array.isArray(lines) || !Array.isArray(allocations) || !Array.isArray(physical)) bad();
      const lineIds = ids([...lines,...allocations,...physical].map((l: any) => l.orderLineId).filter((v: any) => v != null));
      if (lineIds.some(id => !text(id)) || [...allocations,...physical].some((a: any) => !text(a.orderId))) bad();
      const originals = lineIds.length ? await tx.orderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, orderId: true }, orderBy: { id: 'asc' } }) : [];
      if (originals.length !== lineIds.length || originals.some((l: any) => !text(l.orderId))
        || [...allocations,...physical].some((a: any) => a.orderLineId && !originals.some((l: any) => l.id === a.orderLineId && l.orderId === a.orderId))) bad();
      parentIds.push(...[shipment.orderId,...allocations.map((a: any) => a.orderId),...physical.map((a: any) => a.orderId),...originals.map((l: any) => l.orderId)].filter((v: any) => v != null));
      all.push({ shipment, lines, allocations, physical, originals });
    }
  } catch (error) {
    if (readBusinessErrorMint(error)) throw error;
    throw businessError('AUTHORIZATION_UNAVAILABLE', '历史合并装箱单当前父来源暂时无法核验。');
  }
  if (parentIds.some(id => !text(id))) bad();
  return { all, parentIds: ids(parentIds) };
}
async function authority(tx: any, prior: TokenPayload | null, frozenParents: string[], sourceIds: string[]) {
  const current = await currentParents(tx, sourceIds), parents = ids([...frozenParents,...current.parentIds]);
  const required = ['customs:read','shipments:read',...(parents.length ? ['orders:read'] : [])] as const;
  const actor = await currentDocumentActor(tx, prior, required as readonly ('customs:read'|'shipments:read'|'orders:read')[]);
  const orders = await authorizedDocumentOrders(tx, actor, parents);
  const finalActor = await currentDocumentActor(tx, prior, required as readonly ('customs:read'|'shipments:read'|'orders:read')[]);
  if (hash(actor) !== hash(finalActor)) bad();
  return { parents, current, stamp: hash({ current, orders, actor: finalActor }) };
}
export async function readLegacyMergedPackingListVersionInTx(tx: any, params: { documentId: string; version?: number; trustedActor: TokenPayload | null; write?: boolean }) {
  if (params.write) bad();
  await currentDocumentActor(tx, params.trustedActor, ['customs:read','shipments:read']);
  const document = await tx.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } });
  const version = params.version === undefined ? await tx.documentVersion.findFirst({ where: { documentId: params.documentId }, orderBy: { version: 'desc' } })
    : await tx.documentVersion.findUnique({ where: { documentId_version: { documentId: params.documentId, version: params.version } } });
  if (!version) missing();
  const first = snapshot(document, version), proof = await oldAudits(tx, document, version);
  const before = await authority(tx, params.trustedActor, first.frozenParents, first.sourceIds);
  const finalDoc = await tx.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } });
  const finalVersion = await tx.documentVersion.findUnique({ where: { id: version.id } });
  if (!finalVersion || hash(document) !== hash(finalDoc) || hash(version) !== hash(finalVersion)) bad();
  snapshot(finalDoc, finalVersion);
  const after = await authority(tx, params.trustedActor, first.frozenParents, first.sourceIds);
  if (before.stamp !== after.stamp || proof !== await oldAudits(tx, finalDoc, finalVersion)) bad();
  const warnings = ['历史汇总来源待核对：非原生箱级来源；原历史汇总收货方未逐票确认，不代表共同收货主体。',
    ...(after.current.all.some(x => x.shipment.status === 'Cancelled' || x.shipment.deletedAt != null) ? ['当前原运单已取消或不可操作；仅浏览此原历史版本。'] : [])];
  const preview: LegacyMergedPackingListPreview = { legacyMergedReadProtocol: 1, data: json(first.data),
    document: { documentNumber: finalDoc.documentNumber, issueDate: finalDoc.issueDate ?? null }, version: finalVersion.version, createdAt: String(finalVersion.createdAt) };
  return { document: finalDoc, item: json(finalVersion), version: json(finalVersion), protocol: 1 as const, provenance: 'legacy_unverified' as const,
    envelope: null, receipt: null, orderIds: after.parents, shipmentIds: first.sourceIds, warnings, legacyMergedPreview: preview,
    authorityStamp: after.stamp, fingerprint: hash({ document: finalDoc, version: finalVersion, proof, authority: after.stamp }) };
}
