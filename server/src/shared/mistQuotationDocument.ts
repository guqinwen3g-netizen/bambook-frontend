/** BB-QUO-6 正式报价单：冻结报价版本快照，服务端渲染 PDF 并归档为不可覆盖的文件记录。 */
import type { MistCompanyProfile } from './mistWorkspace';
import type { MarketQuotation, MarketQuoteLine } from './mistMarket';
import { quoteMoqStatus, quoteSpecItems, type QuoteSpecFamily } from './mistQuotationSpecs';
import { creditDocumentFingerprint } from './mistCreditDocuments';

export const QUOTE_DOCUMENT_TEMPLATE_VERSION = 1 as const;
export type QuoteDocumentLine = { no: number; lineId: string; name: string; style: string; specification: string; specs: Array<{ label: string; value: string }>; moq: string; /** 报价数量低于 MOQ（同单位比较）；历史快照无此字段。 */ moqBelow?: boolean; qty: string; unit: string; price: string; amount: string };
export type QuoteDocumentSnapshot = {
  quotationId: string; code: string; revision: number; draft: boolean; templateVersion: number;
  issuer: MistCompanyProfile; customer: { id: string; name: string; country: string; city: string };
  date: string; validUntil: string; currency: string; deliveryTerms: string; paymentTerms: string; note: string;
  lines: QuoteDocumentLine[]; total: string; sourceUpdatedAt: string;
  generatedAt: string; generatedBy: string; generatedById: string;
};
/** 每次生成一份记录，只追加不改写。 */
export type QuoteDocumentRecord = { id: string; quotationId: string; revision: number; draft: boolean; fileId: string; fileName: string; sha256: string; bytes: number; templateVersion: number; snapshotFingerprint: string; snapshot: QuoteDocumentSnapshot; generatedAt: string; generatedBy: string; generatedById: string };
export type QuoteDocumentFile = { id: string; name: string; mimeType: string; size: number; storageKey: string; createdAt: string; uploadedBy?: string };
/** 服务端渲染并写入私有存储后绑定到命令上下文；客户端 payload 不能提供。 */
export type QuoteDocumentArtifact = { requestId: string; record: QuoteDocumentRecord; file: QuoteDocumentFile };

export const quoteDocumentVersionLabel = (q: { revision?: number }) => 'V' + (q.revision || 1);

/** 正式版的前置条件：须审批的报价必须已批准；审批中或已退回只能出草稿水印版。 */
export function quotationFormalDocumentBlocker(q: Pick<MarketQuotation, 'approval'>, needsApproval: boolean): string | null {
  if (q.approval?.status === 'pending') return '报价审批中，审批通过前只能生成草稿水印版';
  if (q.approval?.status === 'rejected') return '审批已退回，修订并审批通过前只能生成草稿水印版';
  if (needsApproval && q.approval?.status !== 'approved') return '此报价须业务审批，未批准只能生成草稿水印版';
  return null;
}
/** 任何版本（含草稿）都需要的基础数据。 */
export function quotationDocumentBlocker(input: { issuer?: MistCompanyProfile; customerFound: boolean; lineCount: number }): string | null {
  if (!input.issuer || !input.issuer.legalName) return '工作区尚未维护公司资料（公司抬头），需管理员补全后才能生成报价单';
  if (!input.customerFound) return '报价客户不存在或无权查看';
  if (!input.lineCount) return '报价没有条目';
  return null;
}

export function buildQuotationDocumentSnapshot(input: { q: MarketQuotation; issuer: MistCompanyProfile; customer: { id: string; name: string; country?: string; city?: string }; family: (line: MarketQuoteLine) => QuoteSpecFamily | undefined; draft: boolean; date: string; now: string; actorName: string; actorId: string }): QuoteDocumentSnapshot {
  const { q } = input;
  return {
    quotationId: q.id, code: q.code, revision: q.revision || 1, draft: input.draft, templateVersion: QUOTE_DOCUMENT_TEMPLATE_VERSION,
    issuer: { ...input.issuer }, customer: { id: input.customer.id, name: input.customer.name, country: input.customer.country || '', city: input.customer.city || '' },
    date: input.date, validUntil: q.validUntil, currency: q.currency, deliveryTerms: q.deliveryTerms, paymentTerms: q.paymentTerms, note: q.note || '',
    lines: q.lines.map((l, i) => {
      const family = input.family(l), specs = quoteSpecItems(family, l.specs).filter(s => !s.missing).map(s => ({ label: s.label, value: s.value }));
      const moqItem = specs.length && l.specs?.moqQty ? specs.pop()! : undefined;
      const below = quoteMoqStatus(family, l).state === 'below';
      return { no: i + 1, lineId: l.id, name: l.name, style: l.style, specification: l.specification || '', specs, moq: moqItem ? moqItem.value : '', ...(below ? { moqBelow: true } : {}), qty: l.qty, unit: l.unit, price: l.price, amount: l.amount };
    }),
    total: q.total, sourceUpdatedAt: q.updatedAt, generatedAt: input.now, generatedBy: input.actorName, generatedById: input.actorId,
  };
}
export const quoteDocumentFingerprint = (snapshot: QuoteDocumentSnapshot) => creditDocumentFingerprint(snapshot);
export const quoteDocumentFileName = (snapshot: Pick<QuoteDocumentSnapshot, 'code' | 'revision' | 'draft'>, seq: number) => `${snapshot.code.replace(/-V\d+$/, '')}-V${snapshot.revision}-${String(seq).padStart(2, '0')}${snapshot.draft ? '-DRAFT' : ''}.pdf`;
/** 只读兼容：历史报价没有 documents 字段。 */
export const quotationDocuments = (q: { documents?: QuoteDocumentRecord[] }) => [...(q.documents || [])].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
