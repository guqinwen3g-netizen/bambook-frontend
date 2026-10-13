import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { QcAssignmentError } from './qcAssignmentAccess';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { qcReportSourceFingerprint } from './qcReportAuthority';

export interface QcEvidenceFile { id: string; name: string; mimeType: string; size: number; sha256: string;
  uploadedBy: string; uploadedAt: string; sourceKind: 'assignment' | 'development_review'; sourceId: string; sourceFingerprint: string }
export interface QcEvidenceUpload { originalname: string; buffer: Buffer }
const invalid = (text: string) => new QcAssignmentError('VALIDATION_FAILED', text);
const conflict = (text: string) => new QcAssignmentError('CONFLICT', text);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const QC_EVIDENCE_MAX_SIZE = 15 * 1024 * 1024;

/** Validate actual bytes, never a supplied MIME type or an external file URL. */
export async function identifyQcEvidenceFile(file: QcEvidenceUpload) {
  const bytes = file.buffer;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > QC_EVIDENCE_MAX_SIZE) throw invalid('附件须为非空文件，且不超过 15 MB。');
  const extension = path.extname(file.originalname).toLowerCase();
  let mimeType: string;
  if (extension === '.png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.includes(Buffer.from('IHDR')) && bytes.includes(Buffer.from('IEND'))) mimeType = 'image/png';
  else if (['.jpg', '.jpeg'].includes(extension) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.subarray(-2).equals(Buffer.from([255, 217]))) mimeType = 'image/jpeg';
  else if (extension === '.webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mimeType = 'image/webp';
  else if (extension === '.pdf' && bytes.toString('ascii', 0, 5) === '%PDF-' && bytes.subarray(-1024).includes(Buffer.from('%%EOF'))) mimeType = 'application/pdf';
  else if (extension === '.doc' && bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')) && bytes.includes(Buffer.from('WordDocument', 'utf16le'))) mimeType = 'application/msword';
  else if (extension === '.docx' && bytes[0] === 80 && bytes[1] === 75) {
    let zip: JSZip;
    try { zip = await JSZip.loadAsync(bytes, { checkCRC32: false }); } catch { throw invalid('DOCX 文件结构无效。'); }
    const entries = Object.values(zip.files);
    if (entries.length > 250 || entries.some(entry => {
      const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
      return typeof data?.uncompressedSize === 'number' && data.uncompressedSize > 30 * 1024 * 1024;
    }) || !zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) throw invalid('DOCX 须为有效且大小合理的 Word 文档。');
    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  } else throw invalid('仅接受实际 PNG、JPEG、WebP 图片或 DOC、DOCX、PDF 报告，文件内容须与扩展名一致。');
  const name = path.basename(file.originalname).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
  if (!name) throw invalid('附件名称不能为空。');
  return { name, mimeType, size: bytes.length, sha256: sha256(bytes), extension };
}

function safePath(root: string, relativePath: string) {
  const resolved = path.resolve(root, relativePath), rel = path.relative(path.resolve(root), resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw conflict('附件存储路径不在私有目录内。');
  return resolved;
}
export async function verifyQcEvidenceBytes(root: string, file: QcEvidenceFile, relativePath: string) {
  const absolute = safePath(root, relativePath);
  let bytes: Buffer;
  try {
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw conflict('附件原件已不可核验。');
    const realRoot = await fs.realpath(root), realFile = await fs.realpath(absolute);
    if (path.relative(realRoot, realFile).startsWith('..')) throw conflict('附件原件不在私有目录内。');
    bytes = await fs.readFile(absolute);
  } catch (error) { if (error instanceof QcAssignmentError) throw error; throw conflict('附件原件已缺失，请核对原上传回执。'); }
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw conflict('附件原件与上传指纹不一致。');
  return { absolute, bytes };
}

/** Caller must already hold the exact source lock and authorize the current
 * professional actor. Both production and development use this storage proof. */
export async function stageQcEvidenceInTx(tx: any, input: { root: string; actorId: string; sourceKind: QcEvidenceFile['sourceKind'];
  sourceId: string; sourceFingerprint: string; requestKey: string; file: QcEvidenceUpload }, onCreated: (absolutePath: string) => void) {
  if (!input.requestKey?.trim() || input.requestKey.length > 160) throw invalid('上传附件须提供稳定的原请求键。');
  const identified = await identifyQcEvidenceFile(input.file);
  const commandHash = qcReportSourceFingerprint({ sourceKind: input.sourceKind, sourceId: input.sourceId, sourceFingerprint: input.sourceFingerprint,
    actorId: input.actorId, requestKey: input.requestKey, ...identified });
  const original = await tx.auditLog.findFirst({ where: { actorId: input.actorId, action: 'upload_qc_evidence',
    detail: { path: ['after', 'requestKey'], equals: input.requestKey } } });
  if (original) {
    const after = original.detail?.after;
    if (after?.commandHash !== commandHash || !after?.file || typeof after?.relativePath !== 'string') throw conflict('该上传请求键已经用于其他文件或来源。');
    await verifyQcEvidenceBytes(input.root, after.file, after.relativePath);
    return { ok: true, file: after.file as QcEvidenceFile, requestKey: input.requestKey, replayed: true };
  }
  const id = `qef_${randomUUID()}`;
  const relativePath = path.join('qc-evidence', input.sourceKind, id + identified.extension);
  const absolute = safePath(input.root, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const actualRoot = await fs.realpath(input.root), actualDirectory = await fs.realpath(path.dirname(absolute));
  const relativeDirectory = path.relative(actualRoot, actualDirectory);
  if (relativeDirectory.startsWith('..') || path.isAbsolute(relativeDirectory)) throw conflict('附件存储目录不在私有目录内。');
  await fs.writeFile(absolute, input.file.buffer, { flag: 'wx', mode: 0o600 }); onCreated(absolute);
  const file: QcEvidenceFile = { id, name: identified.name, mimeType: identified.mimeType, size: identified.size, sha256: identified.sha256,
    uploadedBy: input.actorId, uploadedAt: String(Date.now()), sourceKind: input.sourceKind, sourceId: input.sourceId, sourceFingerprint: input.sourceFingerprint };
  await writeRouteAuditLog({ prisma: tx, actorId: input.actorId, source: 'api:qc-evidence', operation: 'upload_qc_evidence',
    targetType: input.sourceKind === 'assignment' ? 'QCAssignment' : 'DevelopmentSampleQualityReview', targetId: input.sourceId,
    after: { file, relativePath, requestKey: input.requestKey, commandHash } });
  return { ok: true, file, requestKey: input.requestKey, replayed: false };
}

export function normalizeQcEvidenceIds(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30 || value.some(id => typeof id !== 'string' || !/^qef_[a-f0-9-]{36}$/.test(id)) || new Set(value).size !== value.length) throw invalid('须选择本来源实际上传的附件，最多 30 个且不能重复。');
  return [...value].sort();
}
export async function readQcEvidenceInTx(tx: any, input: { root: string; sourceKind: QcEvidenceFile['sourceKind']; sourceId: string;
  sourceFingerprint: string; ids: string[] }) {
  const files: QcEvidenceFile[] = [];
  for (const id of input.ids) {
    const audit = await tx.auditLog.findFirst({ where: { action: 'upload_qc_evidence', targetId: input.sourceId,
      targetType: input.sourceKind === 'assignment' ? 'QCAssignment' : 'DevelopmentSampleQualityReview', detail: { path: ['after', 'file', 'id'], equals: id } } });
    const after = audit?.detail?.after, file: QcEvidenceFile | undefined = after?.file;
    if (!file || file.id !== id || file.sourceKind !== input.sourceKind || file.sourceId !== input.sourceId || file.sourceFingerprint !== input.sourceFingerprint
      || audit.actorId !== file.uploadedBy || typeof after.relativePath !== 'string') throw invalid('附件不属于本次准确 QC 来源或无法核验实际上传人。');
    await verifyQcEvidenceBytes(input.root, file, after.relativePath);
    files.push(file);
  }
  return files;
}
