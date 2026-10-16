/** BB-DEV-4 试样通知单 PDF：服务端按冻结快照渲染、校验，写入私有存储后绑定为命令上下文中的归档产物。 */
import { createHash } from 'node:crypto';
import { renderHtmlToPdf, type PdfRenderResult } from '../templates/pdf';
import { renderDevelopmentNoticeHtml } from '../templates/developmentNotice';
import { MistCommandError } from '../shared/mistWorkspace';
import { developmentNoticeFileName, developmentNoticeFingerprint, type DevNoticeArtifact, type DevNoticeSnapshot } from '../shared/mistDevelopmentNotice';
import type { MistFileInput, MistStoredFile } from './files';

export { prepareDevelopmentNoticeSnapshot } from '../shared/mistWorkspace';
export type PreparedDevelopmentNotice = { snapshot: DevNoticeSnapshot; snapshotFingerprint: string; contentFingerprint: string; file: MistFileInput; sha256: string; bytes: number };
const fail = (message: string): never => { throw new MistCommandError('DEVELOPMENT_NOTICE_PRECONDITION', message, 422); };
const contentOf = (s: DevNoticeSnapshot) => { const { noticeNo: _n, seq: _s, templateVersion: _t, generatedAt: _a, generatedBy: _b, generatedById: _c, ...content } = s; return content; };

export async function buildDevelopmentNotice(snapshot: DevNoticeSnapshot, options: { renderPdf?: (html: string) => Promise<PdfRenderResult> } = {}): Promise<PreparedDevelopmentNotice> {
  const result = await (options.renderPdf || ((html: string) => renderHtmlToPdf(html, { format: 'A4' })))(renderDevelopmentNoticeHtml(snapshot));
  const bytes = Buffer.from(result.pdf);
  if (bytes.length < 10 || bytes.subarray(0, 5).toString() !== '%PDF-' || !bytes.subarray(Math.max(0, bytes.length - 1024)).toString('ascii').includes('%%EOF')) return fail('PDF渲染未返回有效通知单');
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (result.sha !== sha || result.bytes !== bytes.length) return fail('通知单PDF哈希或大小不一致');
  return { snapshot: structuredClone(snapshot), snapshotFingerprint: developmentNoticeFingerprint(snapshot), contentFingerprint: developmentNoticeFingerprint(contentOf(snapshot)), file: { bytes, name: developmentNoticeFileName(snapshot), mimeType: 'application/pdf' }, sha256: sha, bytes: bytes.length };
}

export function bindDevelopmentNotice(prepared: PreparedDevelopmentNotice, file: MistStoredFile, context: { id: () => string; workspaceId: string; requestId: string }): DevNoticeArtifact {
  if (file.mimeType !== 'application/pdf' || file.size !== prepared.bytes || file.name !== prepared.file.name || file.storageKey !== context.workspaceId + '/' + file.id || !context.requestId) return fail('通知单未按当前工作区安全归档');
  if (createHash('sha256').update(Buffer.from(prepared.file.bytes)).digest('hex') !== prepared.sha256) return fail('待归档通知单字节已变化');
  const s = prepared.snapshot;
  return { requestId: context.requestId, file: structuredClone(file), record: { id: context.id(), versionId: s.versionId, seq: s.seq, noticeNo: s.noticeNo, fileId: file.id, fileName: file.name, sha256: prepared.sha256, bytes: prepared.bytes, templateVersion: s.templateVersion, contentFingerprint: prepared.contentFingerprint, snapshotFingerprint: prepared.snapshotFingerprint, snapshot: structuredClone(s), generatedAt: s.generatedAt, generatedBy: s.generatedBy, generatedById: s.generatedById } };
}
