import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { authorizeSupplierContract, requireApprovedSupplierBasis } from './supplierCommitmentService';
import { authorizeSupplierSources, type SupplierContractTx } from './supplierContractAccess';
import { supplierSnapshot } from './supplierContractStore';
import { supplierFail, supplierFingerprint, supplierJson, type SupplierContractKind } from './supplierContractPolicy';

/** The document adapter reads the approved immutable revision. Mutable header
 * rows and offline acknowledgement labels are never an approval substitute. */
export type SupplierContractDocumentParams = { actor: TokenPayload; kind: SupplierContractKind; id: string; revisionId?: string; forNewPromise?: boolean };
export async function readSupplierContractDocumentInTx(tx: SupplierContractTx, params: SupplierContractDocumentParams) {
    const current = await authorizeSupplierContract(tx, params.kind, params.id, params.actor, { mode: params.forNewPromise ? 'write' : 'read', lock: params.forNewPromise, businessGates: false });
    const id = params.revisionId ?? current.contract.approvedCommitmentRevisionId;
    if (!id) return supplierFail('APPROVED_REVISION_REQUIRED', '尚无明确批准版本，不能生成正式采购单或加工合同。', 409);
    const revision = await tx.supplierCommitmentRevision.findUnique({ where: { id } });
    if (!revision || (params.kind === 'purchase' ? revision.purchaseOrderId : revision.outsourcingOrderId) !== params.id
      || !['approved', 'superseded'].includes(revision.status) || supplierFingerprint(revision.snapshot) !== revision.contentFingerprint)
      return supplierFail('SOURCE_PROOF_UNKNOWN', '正式文件准确批准依据无法核实。', 409);
    const snapshot = supplierSnapshot(revision.snapshot, params.kind);
    await authorizeSupplierSources(tx, params.actor, [...new Set([...snapshot.lines.map(row => row.orderLineId), ...snapshot.sourceProofs.map(row => row.orderLineId)])], { mode: params.forNewPromise ? 'write' : 'read', businessGates: false });
    if (params.forNewPromise) await requireApprovedSupplierBasis(tx, params.kind, params.id, current, id, params.actor, true);
    return { contractId: params.id, contractKind: params.kind, number: current.contract.number, revisionId: revision.id, revision: revision.revision,
      contentFingerprint: revision.contentFingerprint, approvedAt: revision.decidedAt?.toString() ?? null, historical: current.contract.approvedCommitmentRevisionId !== revision.id,
      snapshot: supplierJson(snapshot), sourceRef: `supplier:${params.kind}:${params.id}:${revision.id}` };
}
export async function readSupplierContractDocument(params: SupplierContractDocumentParams & { prisma: PrismaClient }) {
  return params.prisma.$transaction(tx => readSupplierContractDocumentInTx(tx, params), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}
const htmlText = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export function renderSupplierContractHtml(document: Awaited<ReturnType<typeof readSupplierContractDocument>>) {
  const snapshot = supplierSnapshot(document.snapshot, document.contractKind), title = document.contractKind === 'purchase' ? '采购单' : '加工合同';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${htmlText(title)} ${htmlText(document.number)}</title><style>body{font:14px system-ui;margin:32px;color:#17252b}table{width:100%;border-collapse:collapse}td,th{border:1px solid #cad2d6;padding:8px;text-align:left}small{color:#52616b}</style></head><body><h1>${title} ${htmlText(document.number)}</h1><p>批准版本 ${document.revision}${document.historical ? ' · 历史版本' : ''}</p><p>供应商：${htmlText((snapshot.supplierParty as { name?: string } | undefined)?.name ?? snapshot.supplierRelationId)} · 币种：${htmlText(snapshot.currency)}</p><p>付款条件：${htmlText(snapshot.paymentTerms)} · 主要交付地点：${htmlText(snapshot.mainDeliveryLocation?.address)}</p><table><thead><tr><th>准确来源条目</th><th>${document.contractKind === 'purchase' ? '货品' : '加工工序与内容'}</th><th>规格</th><th>数量/单位</th><th>${document.contractKind === 'purchase' ? '单价' : '加工单价'}</th><th>金额</th><th>要求交期</th></tr></thead><tbody>${snapshot.lines.map(line => `<tr><td>${htmlText(line.orderLineId)}</td><td>${htmlText([line.processType, line.description].filter(Boolean).join(' · '))}</td><td>${htmlText(line.specification)}</td><td>${htmlText(line.quantity)} ${htmlText(line.unit)}</td><td>${htmlText(line.unitPrice)}</td><td>${htmlText(line.amount)}</td><td>${htmlText(line.requestedDeliveryDate)}</td></tr>`).join('')}</tbody></table><p>合计：${htmlText(snapshot.totalAmount)} ${htmlText(snapshot.currency)}</p><p>${htmlText(snapshot.notes)}</p><small>准确批准版本 ${htmlText(document.revisionId)} · ${htmlText(document.contentFingerprint)}<br>本文件不代表供应商在线签收；实际线下发出与反馈另行记录。</small></body></html>`;
}
