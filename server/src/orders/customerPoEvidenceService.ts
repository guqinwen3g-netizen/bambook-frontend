import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { PRIVATE_FILES_DIR, isInsideDir } from '../lib/privateFiles';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { buildOrderListScopeWhere } from './orderService';
import { businessError } from '../shared/errorCodes';

export const CUSTOMER_PO_EVIDENCE_MAX_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

export interface CustomerPoUpload { buffer: Buffer; originalName: string; size: number }
export interface CustomerPoEvidenceFiles { privateFilesDir: string }

function safeName(value: unknown): string {
  const name = path.basename(String(value ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name.length > 180 || name === '.' || name === '..') throw businessError('INVALID_INPUT', '客户 PO 文件名无效。');
  return name;
}

function describeUpload(file: CustomerPoUpload) {
  if (!Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) throw businessError('INVALID_INPUT', '请选择非空的客户 PO 原件。');
  if (file.buffer.length > CUSTOMER_PO_EVIDENCE_MAX_BYTES || file.size !== file.buffer.length) throw businessError('INVALID_INPUT', '客户 PO 文件不能超过 20 MiB。');
  const originalName = safeName(file.originalName);
  const extension = path.extname(originalName).toLowerCase();
  const bytes = file.buffer;
  const matches = extension === '.pdf' && bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    || extension === '.png' && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || ['.jpg', '.jpeg'].includes(extension) && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    || extension === '.webp' && bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!MIME_BY_EXTENSION[extension] || !matches) throw businessError('INVALID_INPUT', '文件扩展名与内容不匹配；仅支持 PDF、PNG、JPG/JPEG、WEBP。');
  return { originalName, extension, mimeType: MIME_BY_EXTENSION[extension] };
}

function safeOrderSegment(orderId: string): string {
  const segment = orderId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  if (!segment) throw businessError('NOT_FOUND', '订单证据不存在或无权访问。');
  return segment;
}

async function authorizeOrder(db: any, actor: TokenPayload | null | undefined, orderId: string) {
  if (!actor?.userId) throw businessError('UNAUTHORIZED', '请登录后访问客户 PO 原件。');
  const scope = await buildOrderListScopeWhere(db, actor);
  const order = await db.order.findFirst({
    where: { id: orderId, deletedAt: null, AND: [scope] },
    select: { id: true },
  });
  if (!order) throw businessError('NOT_FOUND', '订单证据不存在或无权访问。');
  return order;
}

function publicEvidence(row: any) {
  return {
    id: row.id, orderId: row.orderId, version: row.version, fileName: row.originalName,
    mimeType: row.mimeType, byteSize: row.byteSize, sha256: row.sha256,
    uploadedBy: row.uploadedBy, uploadedAt: Number(row.uploadedAt),
  };
}

function resolveStoredPath(privateFilesDir: string, storageKey: unknown): string {
  if (typeof storageKey !== 'string' || !storageKey || storageKey.includes('\\') || storageKey.split('/').includes('..'))
    throw businessError('NOT_FOUND', '客户 PO 文件路径无效。');
  const root = path.resolve(privateFilesDir);
  const base = path.resolve(root, 'customer-po-evidence');
  const target = path.resolve(root, storageKey);
  if (!isInsideDir(base, target) || !target.startsWith(`${base}${path.sep}`)) throw businessError('NOT_FOUND', '客户 PO 文件路径无效。');
  if (!fs.existsSync(target)) throw businessError('NOT_FOUND', '客户 PO 原件不存在。');
  const realRoot = fs.realpathSync(root), realBase = fs.realpathSync(base), realFile = fs.realpathSync(target);
  if (!isInsideDir(realRoot, realBase) || !isInsideDir(realBase, realFile)) throw businessError('CONFLICT', '客户 PO 文件不在受保护目录内。');
  return realFile;
}

function ensureStoragePath(privateFilesDir: string, orderId: string, id: string, extension: string) {
  const root = path.resolve(privateFilesDir);
  fs.mkdirSync(root, { recursive: true });
  const base = path.join(root, 'customer-po-evidence');
  const orderDir = path.join(base, safeOrderSegment(orderId));
  fs.mkdirSync(orderDir, { recursive: true });
  const realRoot = fs.realpathSync(root), realBase = fs.realpathSync(base), realOrderDir = fs.realpathSync(orderDir);
  if (!isInsideDir(realRoot, realBase) || !isInsideDir(realBase, realOrderDir)) throw businessError('CONFLICT', '客户 PO 文件目录不安全。');
  const fileName = `${id}${extension}`;
  const absolutePath = path.join(orderDir, fileName);
  if (!isInsideDir(orderDir, absolutePath)) throw businessError('CONFLICT', '客户 PO 文件路径无效。');
  return { absolutePath, storageKey: `customer-po-evidence/${safeOrderSegment(orderId)}/${fileName}` };
}

export function createCustomerPoEvidenceService(prisma: PrismaClient, files: CustomerPoEvidenceFiles = { privateFilesDir: PRIVATE_FILES_DIR }) {
  const privateFilesDir = path.resolve(files.privateFilesDir);

  async function list(actor: TokenPayload | null | undefined, orderId: string) {
    await authorizeOrder(prisma, actor, orderId);
    const rows = await (prisma as any).customerPoEvidence.findMany({ where: { orderId }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }] });
    return { orderId, items: rows.map(publicEvidence) };
  }

  async function upload(actor: TokenPayload | null | undefined, orderId: string, file: CustomerPoUpload, requestKey: string, ip?: string | null) {
    await authorizeOrder(prisma, actor, orderId);
    if (!actor?.userId) throw businessError('UNAUTHORIZED', '请登录后上传客户 PO 原件。');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey))
      throw businessError('INVALID_INPUT', '上传请求编号无效，请重新选择文件后再试。');
    const parsed = describeUpload(file);
    const id = `CPOE__${randomUUID()}`;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    let writtenPath: string | null = null;
    try {
      const result = await (prisma as any).$transaction(async (tx: any) => {
        await authorizeOrder(tx, actor, orderId);
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} AND "deletedAt" IS NULL FOR UPDATE`;
        const replay = await tx.customerPoEvidence.findFirst({ where: { orderId, requestKey } });
        if (replay) {
          if (replay.sha256 !== sha256 || replay.originalName !== parsed.originalName || replay.byteSize !== file.buffer.length)
            throw businessError('CONFLICT', '同一上传请求编号对应了不同文件；请保留原文件并重新发起上传。');
          return { row: replay, replayed: true };
        }
        const previous = await tx.customerPoEvidence.findFirst({ where: { orderId }, orderBy: { version: 'desc' }, select: { version: true } });
        const now = BigInt(Date.now());
        const stored = ensureStoragePath(privateFilesDir, orderId, id, parsed.extension);
        fs.writeFileSync(stored.absolutePath, file.buffer, { flag: 'wx', mode: 0o600 });
        writtenPath = stored.absolutePath;
        const created = await tx.customerPoEvidence.create({ data: {
          id, orderId, version: Number(previous?.version ?? 0) + 1, requestKey, originalName: parsed.originalName,
          mimeType: parsed.mimeType, byteSize: file.buffer.length, sha256, storageKey: stored.storageKey,
          uploadedBy: actor.userId, uploadedAt: now, createdAt: now,
        } });
        await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'orders:customer-po-evidence',
          operation: 'archive_customer_po_evidence', targetType: 'Order', targetId: orderId,
          operationType: 'create', after: { evidenceId: id, version: created.version, fileName: parsed.originalName, sha256, byteSize: file.buffer.length }, ip });
        return { row: created, replayed: false };
      });
      if (result.replayed) writtenPath = null;
      return { ...publicEvidence(result.row), replayed: result.replayed };
    } catch (error) {
      if (writtenPath) try { fs.unlinkSync(writtenPath); } catch { /* preserve the primary failure */ }
      throw error;
    }
  }

  async function download(actor: TokenPayload | null | undefined, orderId: string, evidenceId: string) {
    await authorizeOrder(prisma, actor, orderId);
    const row = await (prisma as any).customerPoEvidence.findFirst({ where: { id: evidenceId, orderId } });
    if (!row) throw businessError('NOT_FOUND', '客户 PO 文件不存在或无权访问。');
    const filePath = resolveStoredPath(privateFilesDir, row.storageKey);
    const bytes = fs.readFileSync(filePath);
    if (bytes.length !== row.byteSize || createHash('sha256').update(bytes).digest('hex') !== row.sha256)
      throw businessError('CONFLICT', '客户 PO 原件与归档校验值不一致。');
    return { evidence: publicEvidence(row), bytes };
  }

  return { list, upload, download };
}
