import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../../auth/service';
import { readSupplierContractDocument } from '../../procurement/supplierContractDocument';
import { supplierSnapshot } from '../../procurement/supplierContractStore';
import { supplierFail, supplierFingerprint, supplierObject, type SupplierContractKind } from '../../procurement/supplierContractPolicy';
import { esc, type DocSeal } from '../docPrintBase';
import type { DocExporterProfile } from './packingList';
import type { ServerSupplierContractDocumentData } from './types';

export async function loadSupplierContractTemplateData(prisma: PrismaClient, context: { sourceRef: string | null; trustedActor?: TokenPayload | null; expectedSourceFingerprint?: string }, expectedKind: SupplierContractKind): Promise<ServerSupplierContractDocumentData> {
  const parts = context.sourceRef?.split(':');
  if (!parts || parts.length !== 4 || parts[0] !== 'supplier' || parts[1] !== expectedKind || !parts[2] || !parts[3])
    return supplierFail('SOURCE_PROOF_UNKNOWN', '请引用准确供应商合同批准版本生成文件。', 409);
  if (!context.trustedActor) return supplierFail('UNAUTHORIZED', '读取供应商文件需要真实当前账号。', 401);
  const document = await readSupplierContractDocument({ prisma, actor: context.trustedActor, kind: expectedKind, id: parts[2], revisionId: parts[3] });
  if (context.expectedSourceFingerprint && context.expectedSourceFingerprint !== document.contentFingerprint)
    return supplierFail('SOURCE_PROOF_CHANGED', '正式文件来源摘要与准确批准版不一致。', 409);
  return { supplierContractDocumentProtocol: 1, document };
}
export function renderSupplierCommitmentBody(data: ServerSupplierContractDocumentData, exporter: DocExporterProfile, expectedKind: SupplierContractKind, _seal?: DocSeal | null): string {
  const document = data?.document;
  if (data?.supplierContractDocumentProtocol !== 1 || document?.contractKind !== expectedKind || supplierFingerprint(document.snapshot) !== document.contentFingerprint)
    return supplierFail('SOURCE_PROOF_UNKNOWN', '供应商正式文件缺少准确不可变批准依据。', 409);
  const snapshot = supplierSnapshot(document.snapshot, expectedKind), party = supplierObject(snapshot.supplierParty), isPurchase = expectedKind === 'purchase';
  const title = isPurchase ? 'PURCHASE ORDER / 采购单' : 'PROCESSING CONTRACT / 加工合同';
  const sourceLabel = (id: string) => {
    const proof = snapshot.sourceProofs.find(row => row.orderLineId === id), order = supplierObject(supplierObject(proof?.commercial).order);
    return `${typeof order.code === 'string' ? order.code : proof?.orderId ?? '来源未知'} / ${id}${typeof order.poNumber === 'string' && order.poNumber ? ` · 外部 PO ${order.poNumber}` : ''}`;
  };
  return `<div class="doc-header"><div class="doc-brand">${esc(exporter.nameEn || '')}</div><h1>${title}</h1></div>
    <div class="doc-meta"><div><span class="label">单据编号</span><strong>${esc(document.number)}-R${document.revision}</strong><br><small>合同 ${esc(document.number)}</small></div><div><span class="label">准确批准版本</span>${document.revision}${document.historical ? ' · 历史版本' : ''}</div><div><span class="label">下单日期</span>${esc(snapshot.orderDate)}</div></div>
    <div class="doc-parties"><div class="doc-party"><div class="label">Supplier / 供应商</div><div class="name">${esc(String(party.name ?? snapshot.supplierRelationId))}</div><div class="detail">${esc(String(party.officialAddress ?? ''))}</div></div><div class="doc-party"><div class="label">主要交付地点</div><div class="detail">${esc(snapshot.mainDeliveryLocation?.address ?? '')}</div><div>付款条件：${esc(snapshot.paymentTerms ?? '')}</div><div>币种：${esc(snapshot.currency)}</div></div></div>
    <table class="doc-table"><thead><tr><th># / 准确来源</th><th>${isPurchase ? '货品' : '工序 / 加工内容'}</th><th>规格</th><th>数量</th><th>${isPurchase ? '购货单价' : '加工单价'}</th><th>金额</th><th>要求交期</th></tr></thead><tbody>${snapshot.lines.map((line, index) => `<tr><td>${index + 1}<br><small>${esc(sourceLabel(line.orderLineId))}</small></td><td>${esc([line.processType, line.materialCode, line.description].filter(Boolean).join(' · '))}</td><td>${esc(line.specification ?? '')}</td><td>${esc(line.quantity)} ${esc(line.unit)}</td><td>${esc(line.unitPrice)}</td><td>${esc(line.amount)}</td><td>${esc(line.requestedDeliveryDate ?? '')}</td></tr>`).join('')}</tbody></table>
    <div class="doc-totals">合计：${esc(snapshot.totalAmount)} ${esc(snapshot.currency)}</div><p>${esc(snapshot.notes ?? '')}</p>
    <div class="doc-notes">准确批准版：${esc(document.revisionId)}<br>依据摘要：${esc(document.contentFingerprint)}<br>本文件不代表供应商在线签收。实际线下发出、供应商反馈与实物交接另行记录。</div>`;
}
export const renderProcessingContractBody = (data: ServerSupplierContractDocumentData, exporter: DocExporterProfile, seal?: DocSeal | null) => renderSupplierCommitmentBody(data, exporter, 'processing', seal);
