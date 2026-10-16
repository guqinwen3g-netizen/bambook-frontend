/** BB-QUO-6 报价单 PDF：服务端按冻结快照渲染、校验，写入私有存储后绑定为命令上下文中的归档产物。 */
import { createHash } from 'node:crypto';
import { renderHtmlToPdf, type PdfRenderResult } from '../templates/pdf';
import { renderQuotationDocumentHtml } from '../templates/quotationDocument';
import { MistCommandError, type MistState } from '../shared/mistWorkspace';
import { quoteDocumentFileName, quoteDocumentFingerprint, type QuoteDocumentArtifact, type QuoteDocumentSnapshot } from '../shared/mistQuotationDocument';
import type { MistFileInput, MistStoredFile } from './files';

export { prepareQuotationDocumentSnapshot } from '../shared/mistMarket';
export type PreparedQuotationDocument = { snapshot: QuoteDocumentSnapshot; snapshotFingerprint: string; file: MistFileInput; sha256: string; bytes: number };
const fail = (message: string): never => { throw new MistCommandError('QUOTATION_DOCUMENT_PRECONDITION', message, 422); };

/** 同一报价已生成份数 + 1，用于文件名序号；记录本身只追加。 */
export function nextQuotationDocumentSeq(state: MistState, quotationId: string) {
  const q = (state as MistState & { market?: { quotations: Array<{ id: string; documents?: unknown[] }> } }).market?.quotations.find(item => item.id === quotationId);
  return (q?.documents?.length || 0) + 1;
}

export async function buildQuotationDocument(snapshot: QuoteDocumentSnapshot, seq: number, options: { renderPdf?: (html: string) => Promise<PdfRenderResult> } = {}): Promise<PreparedQuotationDocument> {
  const html = renderQuotationDocumentHtml(snapshot), render = options.renderPdf || ((value: string) => renderHtmlToPdf(value, { format: 'A4' }));
  let result: PdfRenderResult;
  // 渲染发生在写文件与落库之前：失败即确定未生成，返回明确原因，避免前端按“结果未确认”处理。
  try { result = await render(html); } catch (error) { console.error('[mist] quotation PDF render failed:', error instanceof Error ? error.message : error); throw new MistCommandError('QUOTATION_PDF_UNAVAILABLE', '报价单 PDF 渲染服务暂不可用，本次未生成文件，请稍后重试或联系管理员', 422); }
  const bytes = Buffer.from(result.pdf);
  if (bytes.length < 10 || bytes.subarray(0, 5).toString() !== '%PDF-' || !bytes.subarray(Math.max(0, bytes.length - 1024)).toString('ascii').includes('%%EOF')) return fail('PDF渲染未返回有效报价单');
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (result.sha !== sha || result.bytes !== bytes.length) return fail('报价单PDF哈希或大小不一致');
  return { snapshot: structuredClone(snapshot), snapshotFingerprint: quoteDocumentFingerprint(snapshot), file: { bytes, name: quoteDocumentFileName(snapshot, seq), mimeType: 'application/pdf' }, sha256: sha, bytes: bytes.length };
}

export function bindQuotationDocument(prepared: PreparedQuotationDocument, file: MistStoredFile, context: { id: () => string; workspaceId: string; requestId: string }): QuoteDocumentArtifact {
  if (file.mimeType !== 'application/pdf' || file.size !== prepared.bytes || file.name !== prepared.file.name || file.storageKey !== context.workspaceId + '/' + file.id || !context.requestId) return fail('报价单未按当前工作区安全归档');
  if (createHash('sha256').update(Buffer.from(prepared.file.bytes)).digest('hex') !== prepared.sha256) return fail('待归档报价单字节已变化');
  const s = prepared.snapshot;
  return { requestId: context.requestId, file: structuredClone(file), record: { id: context.id(), quotationId: s.quotationId, revision: s.revision, draft: s.draft, fileId: file.id, fileName: file.name, sha256: prepared.sha256, bytes: prepared.bytes, templateVersion: s.templateVersion, snapshotFingerprint: prepared.snapshotFingerprint, snapshot: structuredClone(s), generatedAt: s.generatedAt, generatedBy: s.generatedBy, generatedById: s.generatedById } };
}
