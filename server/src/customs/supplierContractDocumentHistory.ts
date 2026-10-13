import type { TokenPayload } from '../auth/service';
import type { SupplierContractTx } from '../procurement/supplierContractAccess';
import { supplierFail, supplierFingerprint, supplierObject } from '../procurement/supplierContractPolicy';
import { currentDocumentActor } from '../shipping/shipmentDocumentSource';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { readSupplierContractTradeDocumentInTx } from './supplierContractDocumentArchive';

/** Historical headers and versions keep their actual evidence. They are not
 * approved promises and are never rendered from today's mutable supplier row.
 * Current exact parent scope still controls every original history read. */
export async function readSupplierDocumentHistoryInTx(tx: SupplierContractTx, documentId: string,
  prior: TokenPayload | null | undefined, version?: number) {
  const doc = await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
  if (!doc) return supplierFail('NOT_FOUND', '供应商业务历史文件不存在。', 404);
  const versions = await tx.documentVersion.findMany({ where: { documentId }, orderBy: { version: 'desc' } });
  const native = doc.sourceRef?.startsWith('supplier:') || doc.filePath?.startsWith('trade-documents/supplier-')
    || versions.some(row => supplierObject(row.content).protocol === 'SupplierContractDocument');
  if (native) {
    const exact = await readSupplierContractTradeDocumentInTx(tx, documentId, prior, version);
    const snapshot = supplierObject(exact.source.snapshot), proofs = Array.isArray(snapshot.sourceProofs) ? snapshot.sourceProofs : [];
    return { native: true, document: exact.document, version: exact.version, proofState: 'approved_revision' as const,
      orderIds: [...new Set(proofs.map(proof => supplierObject(proof).orderId).filter((id): id is string => typeof id === 'string' && !!id))],
      fingerprint: supplierFingerprint(exact.version) };
  }
  const actor = await currentDocumentActor(tx, prior, ['procurement:read', 'orders:read']);
  const scope = await freshOrderLineScope(tx, actor);
  const purchase = doc.sourceRef ? await tx.purchaseOrder.findFirst({ where: { id: doc.sourceRef }, include: { lines: true } }) : null;
  const processing = doc.sourceRef ? await tx.outsourcingOrder.findFirst({ where: { id: doc.sourceRef }, include: { lines: true } }) : null;
  const lineIds = [...new Set([...(purchase?.lines ?? []), ...(processing?.lines ?? [])].map(line => line.orderLineId).filter((id): id is string => typeof id === 'string' && !!id))];
  const lines = lineIds.length ? await tx.orderLine.findMany({ where: { id: { in: lineIds } } }) : [];
  if (lines.length !== lineIds.length) return supplierFail('NOT_FOUND', '历史准确来源条目已无法核实。', 404);
  const orderIds = [...new Set([doc.orderId, purchase?.orderId, processing?.orderId, ...lines.map(line => line.orderId)].filter((id): id is string => typeof id === 'string' && !!id))].sort();
  if (!orderIds.length && Object.keys(scope).length) return supplierFail('NOT_FOUND', '该历史文件尚无当前可核实的数据归属。', 404);
  for (const id of orderIds) if (!await tx.order.findFirst({ where: { id, deletedAt: null, AND: [scope] } }))
    return supplierFail('NOT_FOUND', '历史文件来源不在当前业务范围。', 404);
  const selected = version === undefined ? versions[0] ?? null : versions.find(row => row.version === version);
  if (version !== undefined && !selected) return supplierFail('NOT_FOUND', '历史文件所选版本不存在。', 404);
  const finalActor = await currentDocumentActor(tx, prior, ['procurement:read', 'orders:read']);
  if (supplierFingerprint(finalActor) !== supplierFingerprint(actor) || supplierFingerprint(await freshOrderLineScope(tx, finalActor)) !== supplierFingerprint(scope))
    return supplierFail('SOURCE_CHANGED', '读取历史文件时当前授权已变化，请刷新。', 409);
  return { native: false, document: doc, version: selected ?? null, orderIds,
    proofState: 'legacy_approval_unknown' as const, fingerprint: supplierFingerprint({ doc, versions, orderIds }) };
}
