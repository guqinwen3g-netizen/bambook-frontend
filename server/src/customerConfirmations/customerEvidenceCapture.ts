import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PRIVATE_FILES_DIR, ensurePrivateDir, isInsideDir } from '../lib/privateFiles';
import {
  canonicalCustomerConfirmationJson,
  currentCustomerConfirmationActor,
  customerConfirmationSha256,
  CustomerConfirmationError,
} from './customerConfirmationService';
import type {
  CustomerConfirmationEvidenceSource,
  PreparedCustomerEvidence,
  PreparedEvidenceBlob,
} from './customerConfirmationTypes';

const MAX_EMAIL_BODY_CHARS = 2_000_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;

function invalid(message: string): never {
  throw new CustomerConfirmationError('INVALID_INPUT', message, 400);
}

function fileStoreDirectory(): string {
  const directory = ensurePrivateDir('customer-confirmations');
  if (fs.lstatSync(directory).isSymbolicLink() || !isInsideDir(fs.realpathSync(PRIVATE_FILES_DIR), fs.realpathSync(directory)))
    throw new Error('Invalid private customer confirmation directory');
  return directory;
}

function attachmentPath(filePath: unknown): string {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\\') || filePath.split('/').includes('..'))
    invalid('所选邮件附件原件路径无法核验，请改用截图或取消该附件。');
  const serverRoot = path.resolve(__dirname, '../..');
  const legacyRoot = path.resolve(serverRoot, 'uploads/email-attachments');
  const privateRoot = path.resolve(PRIVATE_FILES_DIR, 'email-attachments');
  const candidate = filePath.startsWith('email-attachments/')
    ? path.resolve(PRIVATE_FILES_DIR, filePath)
    : filePath.startsWith('uploads/email-attachments/')
      ? path.resolve(serverRoot, filePath)
      : invalid('所选邮件附件不在受保护的邮件附件目录中。');
  if (!isInsideDir(privateRoot, candidate) && !isInsideDir(legacyRoot, candidate))
    invalid('所选邮件附件不在受保护的邮件附件目录中。');
  return candidate;
}

async function readEmailAttachment(filePath: unknown): Promise<Buffer> {
  const fullPath = attachmentPath(filePath);
  const serverRoot = path.resolve(__dirname, '../..');
  const allowedRoot = isInsideDir(path.resolve(PRIVATE_FILES_DIR, 'email-attachments'), fullPath)
    ? path.resolve(PRIVATE_FILES_DIR, 'email-attachments')
    : path.resolve(serverRoot, 'uploads/email-attachments');
  const realRoot = fs.realpathSync(allowedRoot);
  const realFile = fs.realpathSync(fullPath);
  if (!isInsideDir(realRoot, realFile)) invalid('所选邮件附件路径已变化，未保存本次确认。');
  const noFollow = (fs.constants as any).O_NOFOLLOW ?? 0;
  const handle = await fs.promises.open(realFile, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ATTACHMENT_BYTES)
      invalid('邮件附件为空或超过 20MB，无法作为本次客户确认依据保存。');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function storageKeyFor(sha256: string): string {
  return `customer-confirmations/${sha256}`;
}

async function verifyPrivateBlob(storageKey: string, sha256: string, byteSize: number): Promise<void> {
  const bytes = await readCustomerEvidenceFile(storageKey);
  if (bytes.length !== byteSize || customerConfirmationSha256(bytes) !== sha256)
    throw new Error('Content-addressed evidence file mismatch');
}

export interface PersistedCustomerEvidenceBlobs {
  /** Only files created by this transaction; remove only while its advisory locks remain held. */
  newlyCreatedStorageKeys: string[];
}

/**
 * Persist immutable bytes and their metadata rows under a transaction-scoped
 * hash lock. Preparing/validating an upload never writes a file, so a failed
 * partial email capture cannot leave a formal or unbound evidence object.
 */
export async function persistPreparedCustomerEvidenceBlobsInTx(
  tx: any,
  prepared: PreparedCustomerEvidence,
  actor: { userId: string },
  now: number,
): Promise<PersistedCustomerEvidenceBlobs> {
  const newlyCreatedStorageKeys: string[] = [];
  if (!prepared.blobs.length) return { newlyCreatedStorageKeys };
  const hashes = [...new Set(prepared.blobs.map(blob => blob.sha256))].sort();
  try {
    for (const sha256 of hashes) {
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid customer evidence digest');
      await tx.$queryRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text',
        `customer-evidence:${sha256}`,
      );
    }
    const root = fileStoreDirectory();
    const noFollow = (fs.constants as any).O_NOFOLLOW ?? 0;
    for (const sha256 of hashes) {
      const matching = prepared.blobs.filter(blob => blob.sha256 === sha256);
      if (matching.some(blob => !Buffer.isBuffer(blob.bytes)
        || blob.bytes.length !== blob.byteSize || customerConfirmationSha256(blob.bytes) !== sha256))
        throw new Error('Prepared customer evidence bytes do not match their digest');
      const representative = matching[0];
      const storageKey = storageKeyFor(sha256);
      const row = await tx.customerEvidenceFile.findUnique({ where: { sha256 } });
      if (row) {
        if (row.storageKey !== storageKey || row.byteSize !== representative.byteSize)
          throw new Error('Stored customer evidence metadata mismatch');
        await verifyPrivateBlob(row.storageKey, sha256, row.byteSize);
        continue;
      }

      const destination = path.join(root, sha256);
      let createdHere = false;
      try {
        const handle = await fs.promises.open(destination,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
        createdHere = true;
        newlyCreatedStorageKeys.push(storageKey);
        try { await handle.writeFile(representative.bytes); } finally { await handle.close(); }
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        await verifyPrivateBlob(storageKey, sha256, representative.byteSize);
      }
      if (createdHere) await verifyPrivateBlob(storageKey, sha256, representative.byteSize);
      await tx.customerEvidenceFile.create({ data: {
        id: `CEB__${crypto.randomUUID()}`, sha256, storageKey,
        byteSize: representative.byteSize, createdBy: actor.userId, createdAt: BigInt(now),
      } });
    }
    return { newlyCreatedStorageKeys };
  } catch (error) {
    await removeNewlyCreatedFilesWhileLocked(newlyCreatedStorageKeys);
    throw error;
  }
}

/** Call only before rejecting an interactive tx callback, while the hash locks are still held. */
export async function removeNewlyCreatedFilesWhileLocked(storageKeys: string[]): Promise<void> {
  const root = fileStoreDirectory();
  for (const storageKey of storageKeys) {
    try {
      if (!/^customer-confirmations\/[a-f0-9]{64}$/.test(storageKey)) continue;
      const target = path.resolve(root, storageKey.slice('customer-confirmations/'.length));
      if (!isInsideDir(root, target) || path.dirname(target) !== root) continue;
      await fs.promises.unlink(target).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; });
    } catch {
      // Leave private bytes in place if their state is uncertain; content addressing makes retry safe.
    }
  }
}

function screenshotMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function emailSnapshot(email: any, selectedAttachments: Array<{ row: any; sha256: string }>) {
  return {
    schemaVersion: 1,
    kind: 'email',
    email: {
      id: email.id, messageId: email.messageId, direction: email.direction,
      fromAddress: email.fromAddress, fromName: email.fromName,
      toAddresses: email.toAddresses, ccAddresses: email.ccAddresses, bccAddresses: email.bccAddresses,
      replyToAddress: email.replyToAddress, subject: email.subject,
      bodyText: email.bodyText, bodyHtml: email.bodyHtml,
      mailbox: email.mailbox, uid: email.uid, uidValidity: email.uidValidity, threadId: email.threadId,
      sentAt: email.sentAt, receivedAt: email.receivedAt,
      relationId: email.relationId, relationName: email.relationName,
      orderId: email.orderId, orderPo: email.orderPo, invoiceId: email.invoiceId, invoiceNumber: email.invoiceNumber,
      labels: email.labels, syncedAt: email.syncedAt == null ? null : String(email.syncedAt),
    },
    attachments: selectedAttachments.map(({ row, sha256 }) => ({
      id: row.id, filename: row.filename, contentType: row.contentType,
      fileSize: row.fileSize, contentId: row.contentId, isInline: row.isInline, sha256,
    })),
  };
}

export async function prepareCustomerConfirmationEvidence(params: {
  tx: any;
  actor: any;
  source: CustomerConfirmationEvidenceSource;
  file?: { buffer: Buffer; originalname: string; mimetype: string; size: number } | null;
}): Promise<PreparedCustomerEvidence> {
  const { tx, source, file } = params;
  if (!source || typeof source !== 'object') invalid('请选邮件证据或客户截图。');

  if (source.kind === 'screenshot') {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length < 1 || file.buffer.length > MAX_SCREENSHOT_BYTES)
      invalid('请在本次确认提交中附上一张不超过 12MB 的截图原件。');
    const detected = screenshotMime(file.buffer);
    if (!detected || file.mimetype !== detected) invalid('截图必须是可核验的 PNG、JPEG 或 WebP 原件。');
    const sha256 = customerConfirmationSha256(file.buffer);
    const storageKey = storageKeyFor(sha256);
    const snapshot = {
      schemaVersion: 1, kind: 'screenshot', mimeType: detected, byteSize: file.buffer.length, sha256,
    };
    const originalName = path.basename(file.originalname || 'customer-confirmation');
    return {
      sourceType: 'screenshot',
      sourceFingerprint: customerConfirmationSha256(canonicalCustomerConfirmationJson({ kind: 'screenshot', sha256 })),
      sourceSnapshot: snapshot,
      // A filename belongs to this confirmation's source reference, not to the
      // content-addressed source itself. The same original bytes can be reused
      // on another business item even when the operator chose another name.
      selectionSnapshot: { kind: 'screenshot', originalName, mimeType: detected, sha256, byteSize: file.buffer.length },
      blobs: [{ bytes: file.buffer, sha256, storageKey, byteSize: file.buffer.length,
        purpose: 'screenshot', fileName: originalName, mimeType: detected, metadataSnapshot: snapshot }],
    };
  }

  if (source.kind !== 'email_selection') invalid('证据来源类型无效。');
  if (file) invalid('邮件选文无需额外文件；如使用截图，请切换到截图证据并随本次提交上传。');
  await currentCustomerConfirmationActor(tx, params.actor, 'emails:read');
  if (typeof source.emailId !== 'string' || !source.emailId.trim()) invalid('请选择邮件。');
  if (typeof source.selectedText !== 'string' || !source.selectedText.trim() || source.selectedText.length > 20_000
    || !Number.isSafeInteger(source.selectionStart) || !Number.isSafeInteger(source.selectionEnd)
    || source.selectionStart < 0 || source.selectionEnd <= source.selectionStart)
    invalid('请在邮件正文中选取要作为证据的原文。');
  const attachmentIds = source.attachmentIds ?? [];
  if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS
    || attachmentIds.some(id => typeof id !== 'string' || !id.trim())
    || new Set(attachmentIds).size !== attachmentIds.length) invalid('所选附件列表无效。');

  const email = await tx.email.findFirst({ where: { id: source.emailId, deletedAt: null } });
  if (!email || email.direction !== 'inbound') invalid('客户确认只能引用当前有效的客户来信；所选邮件已失效或不是来信。');
  if (typeof email.bodyText !== 'string' || !email.bodyText.length || email.bodyText.length > MAX_EMAIL_BODY_CHARS
    || (typeof email.bodyHtml === 'string' && email.bodyHtml.length > MAX_EMAIL_BODY_CHARS))
    invalid('所选邮件没有可核对的纯文本正文；请确认该邮件原件或上传截图。');
  if (email.bodyText.slice(source.selectionStart, source.selectionEnd) !== source.selectedText)
    invalid('选文位置与当前邮件正文不一致，请重新选择原文。');
  const attachmentRows = attachmentIds.length ? await tx.emailAttachment.findMany({
    where: { emailId: email.id, id: { in: attachmentIds } }, orderBy: { id: 'asc' },
  }) : [];
  if (attachmentRows.length !== attachmentIds.length) invalid('所选邮件附件已变化或无权读取；请刷新后重选。');
  let totalSize = 0;
  const selectedAttachments: Array<{ row: any; sha256: string; bytes: Buffer }> = [];
  for (const row of attachmentRows) {
    const bytes = await readEmailAttachment(row.filePath);
    totalSize += bytes.length;
    if (totalSize > MAX_TOTAL_ATTACHMENT_BYTES) invalid('所选邮件附件合计超过 40MB，无法作为本次证据保存。');
    selectedAttachments.push({ row, bytes, sha256: customerConfirmationSha256(bytes) });
  }
  const snapshot = emailSnapshot(email, selectedAttachments);
  const sourceFingerprint = customerConfirmationSha256(canonicalCustomerConfirmationJson(snapshot));
  const blobs: PreparedEvidenceBlob[] = [];
  for (const { row, sha256, bytes } of selectedAttachments) {
    blobs.push({ bytes, sha256, storageKey: storageKeyFor(sha256), byteSize: bytes.length, purpose: 'email_attachment',
      sourceAttachmentId: row.id, fileName: row.filename, mimeType: row.contentType,
      metadataSnapshot: { emailId: email.id, sourceAttachmentId: row.id, filename: row.filename, contentType: row.contentType, byteSize: bytes.length, sha256 } });
  }
  return {
    sourceType: 'email_selection', sourceFingerprint, sourceSnapshot: snapshot,
    selectionSnapshot: {
      kind: 'email_selection', emailId: email.id, messageId: email.messageId,
      selectedField: 'bodyText', selectionStart: source.selectionStart, selectionEnd: source.selectionEnd,
      selectedText: source.selectedText, attachmentIds: attachmentIds.slice().sort(),
      attachmentVersions: selectedAttachments.map(({ row, sha256 }) => ({ id: row.id, sha256 })).sort((a, b) => a.id.localeCompare(b.id)),
    },
    blobs,
  };
}

export async function readCustomerEvidenceFile(storageKey: string): Promise<Buffer> {
  if (!/^customer-confirmations\/[a-f0-9]{64}$/.test(storageKey)) throw new Error('Invalid customer evidence storage key');
  const root = fileStoreDirectory();
  const fullPath = path.resolve(root, storageKey.slice('customer-confirmations/'.length));
  if (!isInsideDir(root, fullPath) || path.dirname(fullPath) !== root) throw new Error('Invalid customer evidence path');
  const handle = await fs.promises.open(fullPath, fs.constants.O_RDONLY | ((fs.constants as any).O_NOFOLLOW ?? 0));
  try { const stat = await handle.stat(); if (!stat.isFile()) throw new Error('Invalid customer evidence file'); return await handle.readFile(); }
  finally { await handle.close(); }
}
