import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isInsideDir } from '../lib/privateFiles';
import { businessError } from '../shared/errorCodes';
import { appendTradeDocumentVersion, toTradeDocumentSnapshot } from './tradeDocumentLifecycleService';

export const EXTERNAL_TRADE_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

const EXTERNAL_CUSTOMS_TYPES = new Set([
  'CertificateOfOrigin', 'BillOfLading', 'AirWaybill', 'InsuranceCert',
  'InspectionCert', 'PhytosanitaryCert', 'ExportDeclarationProof', 'Other',
]);

export interface ExternalTradeDocumentUpload {
  buffer: Buffer;
  originalName: string;
  size: number;
}

export interface ExternalTradeDocumentArchiveMetadata {
  version: number;
  fileName: string;
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';
  byteSize: number;
  sha256: string;
  uploadedAt: number;
  uploadedBy: string;
}

export function isExternalCustomsTradeDocument(doc: { domain?: string | null; type?: string | null } | null | undefined): boolean {
  return Boolean(doc && (!doc.domain || doc.domain === 'customs') && EXTERNAL_CUSTOMS_TYPES.has(String(doc.type)));
}

function safeOriginalName(value: string): string {
  const basename = path.basename(String(value || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!basename || basename.length > 180 || basename === '.' || basename === '..') {
    throw businessError('VALIDATION_FAILED', '文件名无效，请使用常见 PDF 或图片文件。');
  }
  return basename;
}

function sniffExternalFile(file: ExternalTradeDocumentUpload): { originalName: string; extension: string; mimeType: ExternalTradeDocumentArchiveMetadata['mimeType'] } {
  if (!Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) throw businessError('VALIDATION_FAILED', '请选择非空的外部单据文件。');
  if (file.buffer.length > EXTERNAL_TRADE_DOCUMENT_MAX_BYTES || file.size !== file.buffer.length) {
    throw businessError('VALIDATION_FAILED', '外部单据文件不能超过 20 MiB。');
  }

  const originalName = safeOriginalName(file.originalName);
  const extension = path.extname(originalName).toLowerCase();
  const bytes = file.buffer;
  const pdf = extension === '.pdf' && bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  const png = extension === '.png' && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = ['.jpg', '.jpeg'].includes(extension) && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = extension === '.webp' && bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (pdf) return { originalName, extension, mimeType: 'application/pdf' };
  if (png) return { originalName, extension, mimeType: 'image/png' };
  if (jpeg) return { originalName, extension, mimeType: 'image/jpeg' };
  if (webp) return { originalName, extension, mimeType: 'image/webp' };
  throw businessError('VALIDATION_FAILED', '文件扩展名与文件内容不匹配；仅支持 PDF、PNG、JPG/JPEG、WEBP。');
}

function archiveFromVersion(row: any): (ExternalTradeDocumentArchiveMetadata & { filePath: string }) | null {
  const archive = row?.content && typeof row.content === 'object' ? (row.content as any).externalArchive : null;
  if (!archive || typeof archive !== 'object') return null;
  if (!Number.isSafeInteger(row.version) || row.version < 1
    || typeof archive.filePath !== 'string' || !archive.filePath.startsWith('trade-documents/external/')
    || typeof archive.fileName !== 'string' || typeof archive.mimeType !== 'string'
    || !['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(archive.mimeType)
    || !Number.isSafeInteger(archive.byteSize) || archive.byteSize < 1
    || typeof archive.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(archive.sha256)
    || !Number.isSafeInteger(archive.uploadedAt) || typeof archive.uploadedBy !== 'string') return null;
  return { version: row.version, filePath: archive.filePath, fileName: archive.fileName, mimeType: archive.mimeType,
    byteSize: archive.byteSize, sha256: archive.sha256, uploadedAt: archive.uploadedAt, uploadedBy: archive.uploadedBy };
}

function archiveRoot(uploadRoot: string): string {
  return path.resolve(uploadRoot, 'trade-documents');
}

function resolveArchivePath(uploadRoot: string, relativePath: string): string {
  if (relativePath.includes('\\') || path.posix.normalize(relativePath) !== relativePath) throw businessError('NOT_FOUND', '归档路径非法。');
  const base = archiveRoot(uploadRoot);
  const absolute = path.resolve(uploadRoot, relativePath);
  if (!isInsideDir(base, absolute) || !absolute.startsWith(path.join(base, 'external') + path.sep)) throw businessError('NOT_FOUND', '归档路径非法。');
  if (!fs.existsSync(absolute)) throw businessError('NOT_FOUND', '外部单据归档文件缺失。');
  const realBase = fs.realpathSync(base);
  const realFile = fs.realpathSync(absolute);
  if (!isInsideDir(realBase, realFile)) throw businessError('CONFLICT', '归档文件不属于受保护的单据目录。');
  return realFile;
}

export async function archiveExternalTradeDocumentFile(
  prisma: PrismaClient,
  params: { documentId: string; actorId: string; file: ExternalTradeDocumentUpload; uploadRoot: string },
): Promise<ExternalTradeDocumentArchiveMetadata> {
  const parsed = sniffExternalFile(params.file);
  const doc = await prisma.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } });
  if (!doc) throw businessError('NOT_FOUND', '外部单据不存在或已删除。');
  if (!isExternalCustomsTradeDocument(doc)) throw businessError('CONFLICT', '该单据由系统模板或业务来源生成，不能使用外部文件归档。');

  const safeId = String(doc.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'document';
  const storedName = `${crypto.randomUUID()}${parsed.extension}`;
  const relativePath = `trade-documents/external/${safeId}/${storedName}`;
  const absolutePath = path.resolve(params.uploadRoot, relativePath);
  const targetDir = path.dirname(absolutePath);
  fs.mkdirSync(targetDir, { recursive: true });
  const base = archiveRoot(params.uploadRoot);
  if (!isInsideDir(base, absolutePath) || !absolutePath.startsWith(path.join(base, 'external') + path.sep)) throw businessError('CONFLICT', '归档目标路径非法。');
  // Lexical containment is not enough: an existing external/<document-id>
  // directory could be a symlink. Resolve each directory after creation and
  // refuse to write anywhere outside the configured upload root's protected
  // trade-documents/external subtree.
  try {
    const realUploadRoot = fs.realpathSync(params.uploadRoot);
    const realBase = fs.realpathSync(base);
    const realExternalRoot = fs.realpathSync(path.join(base, 'external'));
    const realTargetDir = fs.realpathSync(targetDir);
    if (!isInsideDir(realUploadRoot, realBase)
      || !isInsideDir(realBase, realExternalRoot)
      || !isInsideDir(realExternalRoot, realTargetDir)) {
      throw businessError('CONFLICT', '归档目标目录不属于受保护的单据目录。');
    }
  } catch (error: any) {
    if (error?.code && error.code !== 'ENOENT') throw error;
    throw businessError('CONFLICT', '归档目标目录无法安全核验。');
  }

  let written = false;
  try {
    fs.writeFileSync(absolutePath, params.file.buffer, { flag: 'wx', mode: 0o600 });
    written = true;
    const uploadedAt = Date.now();
    const sha256 = crypto.createHash('sha256').update(params.file.buffer).digest('hex');
    let savedVersion = 0;
    await prisma.$transaction(async tx => {
      const current = await tx.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } });
      if (!current || !isExternalCustomsTradeDocument(current)) throw businessError('CONFLICT', '单据类型或状态已变化，请刷新后重试。');
      const latest = await tx.documentVersion.findFirst({ where: { documentId: params.documentId }, orderBy: { version: 'desc' }, select: { version: true } });
      savedVersion = (latest?.version ?? 0) + 1;
      const metadata = { version: savedVersion, filePath: relativePath, fileName: parsed.originalName, mimeType: parsed.mimeType,
        byteSize: params.file.buffer.length, sha256, uploadedAt, uploadedBy: params.actorId };
      const updated = await tx.tradeDocument.update({ where: { id: params.documentId }, data: {
        filePath: relativePath, fileName: parsed.originalName, updatedAt: BigInt(uploadedAt),
      } });
      await appendTradeDocumentVersion(tx, {
        documentId: params.documentId,
        content: { ...toTradeDocumentSnapshot(updated), externalArchive: metadata },
        actorId: params.actorId,
        changeReason: `外部文件归档：${parsed.originalName}`,
      });
      await tx.auditLog.create({ data: {
        id: `AUD_${crypto.randomUUID()}`, action: 'TRADE_DOCUMENT_EXTERNAL_ARCHIVE_UPLOAD', actorId: params.actorId,
        targetType: 'TradeDocument', targetId: params.documentId,
        detail: { version: savedVersion, filePath: relativePath, fileName: parsed.originalName, mimeType: parsed.mimeType,
          byteSize: params.file.buffer.length, sha256 },
      } });
    });
    return { version: savedVersion, fileName: parsed.originalName, mimeType: parsed.mimeType, byteSize: params.file.buffer.length,
      sha256, uploadedAt, uploadedBy: params.actorId };
  } catch (error) {
    if (written) {
      try {
        const published = await prisma.tradeDocument.findFirst({ where: { id: params.documentId, filePath: relativePath }, select: { id: true } });
        if (!published) fs.unlinkSync(absolutePath);
      } catch { /* 若数据库提交结果不确定，保留文件避免已提交记录变成断链。 */ }
    }
    throw error;
  }
}

export async function readExternalTradeDocumentArchive(
  prisma: PrismaClient,
  params: { documentId: string; version?: number; uploadRoot: string },
): Promise<{ document: any; archive: ExternalTradeDocumentArchiveMetadata; bytes: Buffer }> {
  const document = await prisma.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } });
  if (!document) throw businessError('NOT_FOUND', '外部单据不存在或已删除。');
  if (!isExternalCustomsTradeDocument(document)) throw businessError('CONFLICT', '该单据不是外部归档类型。');
  const versions = params.version === undefined
    ? await prisma.documentVersion.findMany({ where: { documentId: params.documentId }, orderBy: { version: 'desc' } })
    : [await prisma.documentVersion.findFirst({ where: { documentId: params.documentId, version: params.version } })].filter(Boolean);
  const row = versions.find((candidate: any) => archiveFromVersion(candidate));
  const archive = archiveFromVersion(row);
  if (!archive) throw businessError('NOT_FOUND', '所选外部单据版本尚未归档。');
  const absolutePath = resolveArchivePath(params.uploadRoot, archive.filePath);
  const bytes = fs.readFileSync(absolutePath);
  if (bytes.length !== archive.byteSize || crypto.createHash('sha256').update(bytes).digest('hex') !== archive.sha256) {
    throw businessError('CONFLICT', '外部单据归档文件与版本留痕不一致。');
  }
  const parsed = sniffExternalFile({ buffer: bytes, size: bytes.length, originalName: archive.fileName });
  if (parsed.mimeType !== archive.mimeType) throw businessError('CONFLICT', '外部单据归档文件类型与版本留痕不一致。');
  return { document, archive, bytes };
}
