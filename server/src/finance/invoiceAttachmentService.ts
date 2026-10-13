import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { PRIVATE_FILES_DIR, ensurePrivateDir, isInsideDir } from '../lib/privateFiles';
import { exactJsonValue } from '../lib/exactJsonValue';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;
const digest = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const operation = 'register_invoice_attachment';
type AttachmentCode = 'UNAUTHORIZED' | 'ACCOUNT_DISABLED' | 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_FILE' | 'CONFLICT' | 'AUTHORIZATION_UNAVAILABLE';
type AttachmentRefusal = Readonly<{ code: AttachmentCode; message: string; statusCode: number }>;
const attachmentRefusals = new WeakMap<object, AttachmentRefusal>();
export class InvoiceAttachmentError extends Error {
  constructor(readonly code: AttachmentCode, message: string, readonly statusCode: number) {
    super(message);
    attachmentRefusals.set(this, Object.freeze({ code, message, statusCode }));
  }
  /** Only the actual constructor mints this original tuple. Public fields,
   * prototypes and clones cannot manufacture or alter a public refusal. */
  static readOriginal(error: unknown): AttachmentRefusal | undefined {
    return error !== null && (typeof error === 'object' || typeof error === 'function')
      ? attachmentRefusals.get(error as object) : undefined;
  }
}
function reject(code: AttachmentCode, message: string, status: number): never { throw new InvoiceAttachmentError(code, message, status); }
function invisible(): never { return reject('NOT_FOUND', '发票或附件不存在，或当前无权访问。', 404); }
export interface RegisteredInvoiceAttachment {
  fileId: string; receiptId: string; invoiceId: string; fileName: string; url: string;
  mimeType: string; fileSize: number; uploadedAt: string; sha256: string;
}
export interface InvoiceAttachmentReceipt {
  operation: typeof operation; actorId: string; invoiceId: string; clientRequestId: string;
  commandHash: string; auditId: string; attachment: RegisteredInvoiceAttachment;
}
function auditKey(actorId: string, invoiceId: string, key: string) { return 'iatt_' + digest(JSON.stringify([actorId, invoiceId, key])); }
export function invoiceAttachmentKey(value: unknown): string {
  if (!uuid(value)) reject('INVALID_FILE', '上传文件需要有效的本次归档编号，请重新选择文件。', 400);
  return value;
}
export function invoiceAttachmentDirectory(): string {
  const directory = ensurePrivateDir('invoices');
  if (fs.lstatSync(directory).isSymbolicLink() || !isInsideDir(fs.realpathSync(PRIVATE_FILES_DIR), fs.realpathSync(directory)))
    throw Error('Invalid private invoice directory');
  return directory;
}
export function invoiceAttachmentFiles(metadata: unknown): any[] {
  if (metadata === null || metadata === undefined) return [];
  if (Array.isArray(metadata)) return metadata;
  if (typeof metadata === 'object') {
    const value = (metadata as any).invoiceFiles;
    if (value === undefined) return [];
    if (Array.isArray(value)) return value;
  }
  reject('CONFLICT', '原附件资料无法核对，请先核对原档案；本次不会覆盖资料。', 409);
}
function withFile(metadata: unknown, attachment: RegisteredInvoiceAttachment): unknown {
  const files = [...invoiceAttachmentFiles(metadata), attachment];
  return metadata && !Array.isArray(metadata) && typeof metadata === 'object' ? { ...metadata, invoiceFiles: files } : files;
}
/** The general invoice body cannot register files or rewrite their provenance.
 * Real PI conversion copies the original metadata in its own audited producer. */
export function assertInvoiceFileLedgerInput(next: unknown, prior?: unknown): void {
  const files = invoiceAttachmentFiles(next), old = invoiceAttachmentFiles(prior);
  if (JSON.stringify(exactJsonValue(files)) !== JSON.stringify(exactJsonValue(old)))
    reject('CONFLICT', '发票文件请通过原生附件归档入口处理，不可直接改写文件引用。', 409);
  if (old.length && !Array.isArray(prior) && prior && typeof prior === 'object') {
    for (const key of ['proformaInvoiceId', 'proformaInvoiceNumber'])
      if ((next as any)?.[key] !== (prior as any)[key]) reject('CONFLICT', '原附件来源不能直接改绑。', 409);
  }
}
async function currentActor(db: any, prior: TokenPayload | null | undefined, writing: boolean): Promise<TokenPayload> {
  if (!prior?.userId) reject('UNAUTHORIZED', '请登录后核对发票附件。', 401);
  let context;
  try { context = await createPermissionService({ prisma: db }).getUserPermissionContext(prior.userId); }
  catch { reject('AUTHORIZATION_UNAVAILABLE', '当前账号权限暂时无法核验，请稍后核对。', 503); }
  if (!context) reject('ACCOUNT_DISABLED', '当前账号不可用，请重新登录。', 401);
  const actor: TokenPayload = { userId: context.userId, roles: context.legacyRoleCodes, roleIds: context.roleIds,
    permissions: context.scopes, departmentIds: context.departmentIds, authorizationLoaded: true,
    ...(prior.permissionCeiling === undefined ? {} : { permissionCeiling: [...prior.permissionCeiling] }) };
  if (!hasScope(actor, writing ? 'invoices:write' : 'invoices:read')) reject('FORBIDDEN', '当前账号没有发票附件的操作权限。', 403);
  return actor;
}
async function parents(db: any, invoice: any) {
  const allocations = await db.invoiceOrderAllocation.findMany({ where: { invoiceId: invoice.id, deletedAt: null }, orderBy: { id: 'asc' } });
  const orderIds = [...new Set<string>([invoice.orderId, ...allocations.map((row: any) => row.orderId)].filter(Boolean))].sort();
  return { allocations, orderIds, stamp: JSON.stringify([invoice.id, invoice.orderId, allocations.map((row: any) => [row.id, row.orderId, row.batchId, row.deletedAt])]) };
}
async function authorize(db: any, invoice: any, prior: TokenPayload | null | undefined, writing: boolean) {
  if (!invoice || invoice.deletedAt !== null) invisible();
  const actor = await currentActor(db, prior, writing);
  let scope, orderScope;
  try {
    scope = buildScopeWhereFromResolver(await createPermissionService({ prisma: db }).getDataScopeResolver(actor, 'finance'), actor.userId);
    orderScope = await freshOrderLineScope(db, actor);
  } catch { reject('AUTHORIZATION_UNAVAILABLE', '发票或订单可见范围暂时无法核验，请稍后核对。', 503); }
  if (!await db.invoice.findFirst({ where: { id: invoice.id, deletedAt: null, AND: [scope] }, select: { id: true } })) invisible();
  const source = await parents(db, invoice);
  for (const id of source.orderIds)
    if (!await db.order.findFirst({ where: { id, deletedAt: null, AND: [orderScope] }, select: { id: true } })) invisible();
  return { actor, ...source };
}
export async function preflightInvoiceAttachment(db: PrismaClient, invoiceId: string, prior: TokenPayload | null | undefined) {
  await currentActor(db, prior, true);
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
  return authorize(db, invoice, prior, true);
}
function receiptFromAudit(row: any, invoiceId: string, actorId?: string, key?: string): { receipt: InvoiceAttachmentReceipt; filename: string } {
  const data = row?.detail, receipt = data?.receipt, attachment = receipt?.attachment;
  if (!row || row.action !== operation || row.targetType !== 'Invoice' || row.targetId !== invoiceId
    || receipt?.operation !== operation || receipt.actorId !== row.actorId || receipt.invoiceId !== invoiceId
    || receipt.auditId !== row.id || !uuid(receipt.clientRequestId) || (actorId !== undefined && row.actorId !== actorId)
    || (key !== undefined && receipt.clientRequestId !== key) || !/^[a-f0-9]{64}$/.test(receipt.commandHash ?? '')
    || !uuid(attachment?.fileId) || attachment.receiptId !== row.id || attachment.invoiceId !== invoiceId
    || !text(attachment.fileName) || !text(attachment.mimeType) || !Number.isSafeInteger(attachment.fileSize)
    || attachment.fileSize < 1 || attachment.fileSize > 15 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(attachment.sha256 ?? '')
    || typeof attachment.uploadedAt !== 'string' || !Number.isFinite(Date.parse(attachment.uploadedAt))
    || attachment.url !== `/api/v1/finance/${encodeURIComponent(invoiceId)}/attachments/${attachment.fileId}/download`
    || !text(data.filename) || !new RegExp('^' + attachment.fileId + '\\.(pdf|png|jpe?g|webp|docx?|xlsx?)$', 'i').test(data.filename))
    reject('CONFLICT', '原附件归档回执无法核对，请联系管理员核对原记录。', 409);
  const expectedHash = digest(JSON.stringify({ operation, actorId: receipt.actorId, invoiceId, clientRequestId: receipt.clientRequestId,
    sha256: attachment.sha256, fileName: attachment.fileName, mimeType: attachment.mimeType, fileSize: attachment.fileSize }));
  if (data.source !== 'invoice-attachment:native' || row.id !== auditKey(receipt.actorId, invoiceId, receipt.clientRequestId)
    || row.transactionId !== receipt.clientRequestId || receipt.commandHash !== expectedHash)
    reject('CONFLICT', '原附件归档回执无法核对，请联系管理员核对原记录。', 409);
  return { receipt, filename: data.filename };
}
export async function readOwnInvoiceAttachmentReceipt(db: PrismaClient, invoiceId: string, prior: TokenPayload | null | undefined, key: string) {
  key = invoiceAttachmentKey(key); const actor = await currentActor(db, prior, false);
  const invoice = await db.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } });
  const before = await authorize(db, invoice, prior, false);
  // An owned request key proves historical authorship, not current permission
  // to disclose the Invoice or any of its active source Orders.
  const row = await db.auditLog.findUnique({ where: { id: auditKey(actor.userId, invoiceId, key) } });
  if (!row) invisible();
  const { receipt } = receiptFromAudit(row, invoiceId, actor.userId, key);
  const current = await db.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } });
  const after = await authorize(db, current, prior, false);
  const finalActor = await currentActor(db, prior, false);
  if (after.stamp !== before.stamp || digest(JSON.stringify(exactJsonValue(after.actor))) !== digest(JSON.stringify(exactJsonValue(finalActor))))
    reject('CONFLICT', '发票关联或当前权限已变化，请重新核对本次归档。', 409);
  return { ok: true as const, invoiceId, attachment: receipt.attachment, receipt, replayed: true };
}
export async function registerInvoiceAttachment(params: { prisma: PrismaClient; invoiceId: string; actor: TokenPayload | null | undefined; clientRequestId: string; file: Express.Multer.File; ip?: string | null }) {
  const { prisma, invoiceId, actor: prior, file } = params; const key = invoiceAttachmentKey(params.clientRequestId);
  const directory = invoiceAttachmentDirectory(), realPath = path.resolve(file.path);
  if (!isInsideDir(directory, realPath) || path.dirname(realPath) !== directory || path.basename(realPath) !== file.filename || !uuid(path.basename(file.filename, path.extname(file.filename)))) throw Error('Invalid staged invoice file');
  let bytes: Buffer;
  try { const handle = await fs.promises.open(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size !== file.size || stat.size < 1 || stat.size > 15 * 1024 * 1024) reject('INVALID_FILE', '文件内容或大小无法核对，请重新选择文件。', 400); bytes = await handle.readFile(); }
    finally { await handle.close(); }
  } catch (error) { try { await fs.promises.unlink(realPath); } catch (cleanupError) { console.error('[invoice-attachment] staged read cleanup failed', {error:cleanupError}); } throw error; }
  const blobHash = digest(bytes), fileId = path.basename(file.filename, path.extname(file.filename));
  let callbackRejected = false;
  let state: 'not-started' | 'pending' | 'committed' | 'rolled-back' | 'unknown' = 'not-started';
  const removeStage = async () => { await fs.promises.unlink(realPath); };
  try {
    const actor = await currentActor(prisma, prior, true), id = auditKey(actor.userId, invoiceId, key);
    const commandHash = digest(JSON.stringify({ operation, actorId: actor.userId, invoiceId, clientRequestId: key, sha256: blobHash, fileName: file.originalname, mimeType: file.mimetype, fileSize: bytes.length }));
    state = 'pending';
    const result = await prisma.$transaction(async tx => {
      try {
      const hint = await tx.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } });
      const before = await authorize(tx, hint, prior, true);
      for (const orderId of before.orderIds) if (!(await tx.$queryRaw<any[]>(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${orderId} AND "deletedAt" IS NULL FOR UPDATE`)).length) invisible();
      if (!(await tx.$queryRaw<any[]>(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "id"=${invoiceId} AND "deletedAt" IS NULL FOR UPDATE`)).length) invisible();
      for (const row of before.allocations) if (!(await tx.$queryRaw<any[]>(Prisma.sql`SELECT "id" FROM "InvoiceOrderAllocation" WHERE "id"=${row.id} AND "deletedAt" IS NULL FOR UPDATE`)).length)
        reject('CONFLICT', '发票关联订单已变化，请重新核对。', 409);
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } });
      const fresh = await authorize(tx, invoice, prior, true);
      if (fresh.stamp !== before.stamp) reject('CONFLICT', '发票关联订单已变化，请重新核对。', 409);
      const existing = await tx.auditLog.findUnique({ where: { id } });
      if (existing) {
        const { receipt } = receiptFromAudit(existing, invoiceId, actor.userId, key);
        if (receipt.commandHash !== commandHash) reject('CONFLICT', '本次归档编号已用于不同文件，请先核对原归档回执。', 409);
        return { ok: true as const, invoiceId, attachment: receipt.attachment, receipt, replayed: true };
      }
      const attachment: RegisteredInvoiceAttachment = { fileId, receiptId: id, invoiceId, fileName: file.originalname, url: `/api/v1/finance/${encodeURIComponent(invoiceId)}/attachments/${fileId}/download`, mimeType: file.mimetype, fileSize: bytes.length, uploadedAt: new Date().toISOString(), sha256: blobHash };
      const metadata = withFile(invoice!.attachments, attachment);
      await tx.invoice.update({ where: { id: invoiceId }, data: { attachments: metadata as any, updatedAt: BigInt(Date.now()) } });
      const final = await authorize(tx, invoice, prior, true);
      if (final.stamp !== fresh.stamp) reject('CONFLICT', '发票关联订单已变化，请重新核对。', 409);
      const receipt: InvoiceAttachmentReceipt = { operation, actorId: actor.userId, invoiceId, clientRequestId: key, commandHash, auditId: id, attachment };
      await tx.auditLog.create({ data: { id, actorId: actor.userId, action: operation, targetType: 'Invoice', targetId: invoiceId,
        operationType: 'update', fieldPath: 'attachments', transactionId: key, ip: params.ip ?? null,
        beforeValue: invoice!.attachments ?? Prisma.JsonNull, afterValue: metadata as any,
        detail: { source: 'invoice-attachment:native', filename: file.filename, receipt, parents: final.orderIds, before: { attachments: invoice!.attachments }, after: { attachments: metadata } } as any } });
      return { ok: true as const, invoiceId, attachment, receipt, replayed: false };
      } catch (error) { callbackRejected = true; throw error; }
    });
    state = 'committed';
    if (result.replayed) await removeStage();
    return result;
  } catch (error) {
    if (state === 'committed') throw error;
    // A rejected transaction promise alone is not proof of rollback. A lost
    // commit ACK may have persisted the immutable audit. Never unlink it.
    if (state === 'pending') {
      try {
        const row = await prisma.auditLog.findUnique({ where: { id: auditKey(prior!.userId, invoiceId, key) } });
        if (row) {
          const stored = receiptFromAudit(row, invoiceId, prior!.userId, key);
          if (stored.filename === file.filename) { state = 'committed'; throw error; }
          state = 'rolled-back';
        } else if (callbackRejected) state = 'rolled-back';
        else { state = 'unknown'; throw error; }
      } catch (lookupError) {
        if (state === 'committed') throw error;
        state = 'unknown'; throw error;
      }
    }
    if (state === 'not-started' || state === 'rolled-back') {
      try { await removeStage(); } catch (cleanupError) { console.error('[invoice-attachment] staged file cleanup failed', { error: cleanupError }); }
    }
    throw error;
  }
}
async function nativeFileForInvoice(db: any, invoice: any, fileId: string) {
  const entry = invoiceAttachmentFiles(invoice.attachments).find(row => row?.fileId === fileId);
  if (!entry || !text(entry.receiptId)) invisible();
  const row = await db.auditLog.findUnique({ where: { id: entry.receiptId } });
  const ownerInvoiceId = row?.targetId;
  if (!text(ownerInvoiceId)) invisible();
  const stored = receiptFromAudit(row, ownerInvoiceId);
  if (JSON.stringify(exactJsonValue(entry)) !== JSON.stringify(exactJsonValue(stored.receipt.attachment))) invisible();
  if (ownerInvoiceId !== invoice.id) {
    // An original audited PI conversion is the only native copy path. Body
    // metadata alone never grants ownership of another invoice's blob.
    if (invoice.attachments?.proformaInvoiceId !== ownerInvoiceId) invisible();
    const conversions = await db.auditLog.findMany({ where: { targetType: 'Invoice', targetId: invoice.id, action: 'convert_proforma_to_receivable' } });
    if (!conversions.some((audit: any) => audit.detail?.source === 'proforma-invoice:convert' && audit.detail?.before?.proformaInvoiceId === ownerInvoiceId && audit.detail?.after?.receivableInvoiceId === invoice.id)) invisible();
  }
  return { entry, ...stored };
}
export async function readInvoiceAttachment(params: { prisma: PrismaClient; actor: TokenPayload | null | undefined; invoiceId: string; fileId: string }) {
  if (!uuid(params.fileId)) invisible();
  const invoice = await params.prisma.invoice.findFirst({ where: { id: params.invoiceId, deletedAt: null } });
  const before = await authorize(params.prisma, invoice, params.actor, false);
  const stored = await nativeFileForInvoice(params.prisma, invoice, params.fileId);
  const directory = invoiceAttachmentDirectory(), handle = await fs.promises.open(path.join(directory, stored.filename), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes: Buffer;
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size !== stored.entry.fileSize) reject('CONFLICT', '原归档文件内容无法核对，请联系管理员核对原档案。', 409); bytes = await handle.readFile(); }
  finally { await handle.close(); }
  if (digest(bytes) !== stored.entry.sha256) reject('CONFLICT', '原归档文件内容无法核对，请联系管理员核对原档案。', 409);
  // Complete the native receipt/conversion reads before the final authority
  // observation. A historical blob proof is not current disclosure authority.
  const final = await nativeFileForInvoice(params.prisma, invoice, params.fileId);
  const current = await params.prisma.invoice.findFirst({ where: { id: params.invoiceId, deletedAt: null } });
  const after = await authorize(params.prisma, current, params.actor, false);
  const currentEntry = invoiceAttachmentFiles(current!.attachments).find(row => row?.fileId === params.fileId);
  const finalActor = await currentActor(params.prisma, params.actor, false);
  if (after.stamp !== before.stamp || final.filename !== stored.filename || JSON.stringify(final.entry) !== JSON.stringify(stored.entry)
    || JSON.stringify(currentEntry) !== JSON.stringify(final.entry)
    || (final.receipt.invoiceId !== current!.id && (current!.attachments as any)?.proformaInvoiceId !== final.receipt.invoiceId)
    || digest(JSON.stringify(exactJsonValue(after.actor))) !== digest(JSON.stringify(exactJsonValue(finalActor))))
    reject('CONFLICT', '附件或关联订单已变化，请重新核对。', 409);
  return { bytes, attachment: stored.entry as RegisteredInvoiceAttachment };
}
export async function readLegacyInvoiceAttachment(db: PrismaClient, prior: TokenPayload | null | undefined, filename: string) {
  // Only a native immutable upload receipt can establish an alias. Historical
  // unaudited entries remain in place for review/re-upload; none is adopted.
  if (!/^[a-f0-9-]{36}\.(pdf|png|jpe?g|webp|docx?|xlsx?)$/i.test(filename)) invisible();
  await currentActor(db, prior, false);
  const rows = await db.auditLog.findMany({ where: { action: operation, targetType: 'Invoice', detail: { path: ['filename'], equals: filename } } });
  if (rows.length !== 1 || !text(rows[0].targetId)) invisible();
  const invoice = await db.invoice.findFirst({ where: { id: rows[0].targetId, deletedAt: null } });
  await authorize(db, invoice, prior, false);
  const { receipt } = receiptFromAudit(rows[0], rows[0].targetId);
  return readInvoiceAttachment({ prisma: db, actor: prior, invoiceId: receipt.invoiceId, fileId: receipt.attachment.fileId });
}
