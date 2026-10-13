import { supplierFail, type SupplierContractKind } from '../procurement/supplierContractPolicy';

export function isSupplierContractDocumentCandidate(doc: { domain?: string | null; type?: string | null; sourceRef?: string | null; filePath?: string | null } | null | undefined): boolean {
  return !!doc && (doc.domain === 'procurement' || doc.type === 'PurchaseOrder' || doc.type === 'ProcessingContract'
    || doc.sourceRef?.startsWith('supplier:') === true || doc.filePath?.startsWith('trade-documents/supplier-') === true);
}
export function parseSupplierContractDocumentSource(sourceRef: unknown): { kind: SupplierContractKind; contractId: string; revisionId: string } {
  const parts = typeof sourceRef === 'string' ? sourceRef.split(':') : [];
  if (parts.length !== 4 || parts[0] !== 'supplier' || !['purchase', 'processing'].includes(parts[1]) || !parts[2] || !parts[3])
    return supplierFail('SOURCE_PROOF_UNKNOWN', '正式文件须引用准确采购或加工合同批准版本；旧记录保留，不从可变表头重制。', 409);
  return { kind: parts[1] as SupplierContractKind, contractId: parts[2], revisionId: parts[3] };
}
export function rejectGenericSupplierDocumentWrite(...records: Array<{ domain?: string | null; type?: string | null; sourceRef?: string | null; filePath?: string | null } | null | undefined>): void {
  if (records.some(isSupplierContractDocumentCandidate)) supplierFail('NATIVE_SUPPLIER_DOCUMENT_REQUIRED', '采购与加工正式文件只由准确批准版登记，不能手改内容、状态或删除历史。', 409);
}
