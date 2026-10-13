/** Immutable native PL PDFs. AuditLog is the committed publication ledger;
 * a header path or an unproved historical blob never creates provenance. */
import { Prisma, type PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { documentSourceFingerprint as hash, documentSourceJson as json } from '../shipping/shipmentDocumentSource';
import { readPackingListArchiveSourceInTx, readPackingListVersionInTx } from './shipmentPackingListCommand';
import { renderServerDocument } from '../templates/docTemplates/registry';
import { renderHtmlToPdf } from '../templates/pdf';

const operation = 'archive_packing_list_version' as const;
const action = 'TRADE_DOCUMENT_FILE_GENERATED';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function conflict(): never { throw businessError('CONFLICT', '装箱单原版本或归档文件无法完整核验，请保留原记录并核对。'); }
type Params = { documentId: string; version?: number; trustedActor: TokenPayload | null };
export type PackingListArchiveProof = { operation: typeof operation; protocol: 2; documentId: string; versionId: string; version: number;
  sourceHash: string; contentHash: string; pdfSha256: string; fileSize: number; filePath: string; fileName: string;
  actorId: string; auditId: string };
type Source = Awaited<ReturnType<typeof readPackingListArchiveSourceInTx>>;
const auditKey = (s: Source) => 'AUD_PL_ARCHIVE_' + hash({ documentId: s.document.id, versionId: s.version.id });
const hex = (value: any) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function prove(audit: any, source: Source): PackingListArchiveProof {
  const p = audit?.detail?.packingListArchive;
  if (!p || p.operation !== operation || p.protocol !== 2 || audit.id !== auditKey(source) || p.auditId !== audit.id
    || audit.action !== action || audit.targetType !== 'TradeDocument' || audit.targetId !== source.document.id
    || audit.transactionId !== 'PL-ARCHIVE:' + source.version.id || p.actorId !== audit.actorId
    || p.documentId !== source.document.id || p.versionId !== source.version.id || p.version !== source.version.version
    || p.contentHash !== hash(source.version.content) || p.sourceHash !== source.receipt.sourceFingerprint
    || !hex(p.pdfSha256) || !Number.isSafeInteger(p.fileSize) || p.fileSize < 1
    || typeof p.fileName !== 'string' || !p.fileName.endsWith('.pdf') || p.fileName.includes('/') || p.fileName.includes('\\')
    || typeof p.filePath !== 'string' || !/^trade-documents\/pl-v2-[a-f0-9-]{36}\.pdf$/.test(p.filePath)
    || Object.keys(p).length !== 13 || Object.keys(audit.detail).length !== 1) conflict();
  return p;
}
function directory(create = false) {
  const root = path.resolve(process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads'));
  if (create) fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) conflict();
  const dir = path.join(fs.realpathSync(root), 'trade-documents');
  if (create) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory()) conflict();
  return fs.realpathSync(dir);
}
function readFile(p: PackingListArchiveProof) {
  const dir = directory(), target = path.join(dir, path.posix.basename(p.filePath));
  let fd: number | undefined;
  try {
    if (fs.lstatSync(target).isSymbolicLink() || path.dirname(fs.realpathSync(target)) !== dir) conflict();
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size !== p.fileSize) conflict();
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== p.fileSize || sha(bytes) !== p.pdfSha256
      || bytes.subarray(0, 5).toString() !== '%PDF-') conflict();
    return bytes;
  } catch (error: any) { if (error?.code === 'ENOENT' || error?.code === 'ELOOP') conflict(); throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
async function existing(tx: any, source: Source): Promise<PackingListArchiveProof | null> {
  const audit = await tx.auditLog.findUnique({ where: { id: auditKey(source) } });
  if (audit) return prove(audit, source);
  const damaged = await tx.auditLog.findMany({ where: { targetType: 'TradeDocument', targetId: source.document.id, action } });
  if (damaged.some((row: any) => row.detail?.packingListArchive?.versionId === source.version.id
    || row.detail?.packingListArchive?.version === source.version.version)) conflict();
  return null;
}
const retainedAction = 'PACKING_LIST_LEGACY_HEADER_PRESERVED';
const retainedOperation = 'preserve_legacy_packing_list_header' as const;
const retainedKey = (documentId: string) => 'AUD_PL_LEGACY_HEADER_' + hash({ documentId });
type LegacyHeaderReference = { operation: typeof retainedOperation; protocol: 1; documentId: string;
  legacyVersionId: string; legacyVersion: number; legacyContentHash: string; filePath: string; fileName: string | null;
  actorId: string; archiveVersionId: string; archiveVersion: number; archiveAuditId: string; appendCommandId: string; auditId: string };
type HeaderState = { reference: LegacyHeaderReference | null; createReference?: boolean };

/** Only a verified append chain may locate a genuine unmarked predecessor.
 * Neither an ordinary filename nor a header path proves legacy file ownership. */
async function legacyPredecessor(tx: any, source: Source, params: Params) {
  let current: any = source;
  while (current.protocol === 2) {
    const receipt = current.receipt;
    if (receipt?.operation !== 'append_packing_list_draft_version' || !Number.isSafeInteger(receipt.previousVersion)
      || receipt.previousVersion < 1 || receipt.previousVersion >= current.version.version || !hex(receipt.previousContentHash)) conflict();
    const previous = await readPackingListVersionInTx(tx, { ...params, version: receipt.previousVersion });
    if (hash(previous.version.content) !== receipt.previousContentHash) conflict();
    current = previous;
  }
  if (current.protocol !== 1 || current.provenance !== 'legacy_unverified') conflict();
  return current.version;
}
function referenceFor(source: Source, legacy: any): LegacyHeaderReference {
  return { operation: retainedOperation, protocol: 1, documentId: source.document.id, legacyVersionId: legacy.id,
    legacyVersion: legacy.version, legacyContentHash: hash(legacy.content), filePath: source.document.filePath!, fileName: source.document.fileName,
    actorId: source.actor.userId, archiveVersionId: source.version.id, archiveVersion: source.version.version,
    archiveAuditId: auditKey(source), appendCommandId: source.receipt.commandId, auditId: retainedKey(source.document.id) };
}
const unsetAction = 'PACKING_LIST_UNSET_HEADER_PRESERVED';
const unsetOperation = 'preserve_unset_packing_list_header' as const;
const unsetKey = (source: Source) => 'AUD_PL_UNSET_HEADER_' + hash({ documentId: source.document.id, versionId: source.version.id });
type HeaderValue = { filePath: string | null; fileName: string | null };
const headValue = (source: Source): HeaderValue => ({ filePath: source.document.filePath, fileName: source.document.fileName });
/** A proven old N can be published while the newer N has no file yet. This
 * witness preserves that legitimate empty head; it cannot excuse a cleared
 * latest/native head or replace a missing legacy-reference witness. */
async function proveUnsetHead(tx: any, source: Source, rows: any[], params: Params) {
  for (const audit of rows) {
    const n = audit.detail?.packingListArchive?.version;
    if (!Number.isSafeInteger(n) || n < 1) conflict();
    const original = await readPackingListArchiveSourceInTx(tx, { ...params, version: n });
    const publication = prove(audit, original);
    const witness = await tx.auditLog.findUnique({ where: { id: unsetKey(original) } });
    const p = witness?.detail?.unsetHeaderReference;
    if (!p || p.operation !== unsetOperation || p.protocol !== 1 || Object.keys(p).length !== 12 || Object.keys(witness.detail).length !== 1
      || witness.id !== unsetKey(original) || p.auditId !== witness.id || witness.action !== unsetAction
      || witness.targetType !== 'TradeDocument' || witness.targetId !== source.document.id || witness.actorId !== publication.actorId
      || witness.transactionId !== audit.transactionId || p.actorId !== publication.actorId || p.documentId !== source.document.id
      || p.archiveVersionId !== original.version.id || p.archiveVersion !== original.version.version || p.archiveAuditId !== publication.auditId
      || !Number.isSafeInteger(p.latestVersion) || p.latestVersion <= p.archiveVersion
      || !p.headBefore || !p.headAfter || p.headBefore.filePath !== null || p.headAfter.filePath !== null
      || Object.keys(p.headBefore).length !== 2 || Object.keys(p.headAfter).length !== 2
      || hash(p.headBefore) !== hash(p.headAfter) || hash(p.headAfter) !== hash(headValue(source))) conflict();
    const latest = await tx.documentVersion.findUnique({ where: { id: p.latestVersionId } });
    if (!latest || latest.documentId !== source.document.id || latest.version !== p.latestVersion) conflict();
  }
}
/** This audit certifies only the observed head reference staying unchanged.
 * It never certifies, reads, adopts or publishes the old file's bytes. */
async function headerProof(tx: any, source: Source, params: Params): Promise<HeaderState> {
  const row = await tx.auditLog.findUnique({ where: { id: retainedKey(source.document.id) } });
  const references = await tx.auditLog.findMany({ where: { action: retainedAction, targetType: 'TradeDocument', targetId: source.document.id } });
  if (row) {
    const p: LegacyHeaderReference = row.detail?.legacyHeaderReference;
    if (!p || p.operation !== retainedOperation || p.protocol !== 1 || Object.keys(p).length !== 14 || Object.keys(row.detail).length !== 1
      || row.id !== retainedKey(source.document.id) || p.auditId !== row.id || row.action !== retainedAction
      || row.targetType !== 'TradeDocument' || row.targetId !== source.document.id || references.length !== 1 || references[0].id !== row.id
      || !Number.isSafeInteger(p.archiveVersion) || p.archiveVersion < 2 || p.documentId !== source.document.id
      || p.filePath !== source.document.filePath || p.fileName !== source.document.fileName || p.actorId !== row.actorId) conflict();
    const original = await readPackingListArchiveSourceInTx(tx, { ...params, version: p.archiveVersion });
    const legacy = await legacyPredecessor(tx, original, params);
    const expected = { ...referenceFor(original, legacy), actorId: row.actorId };
    const archive = await tx.auditLog.findUnique({ where: { id: auditKey(original) } });
    const publication = prove(archive, original);
    if (hash(p) !== hash(expected) || p.actorId !== publication.actorId || row.transactionId !== 'PL-ARCHIVE:' + original.version.id) conflict();
    const selectedLegacy = await legacyPredecessor(tx, source, params);
    if (selectedLegacy.id !== p.legacyVersionId || hash(selectedLegacy.content) !== p.legacyContentHash) conflict();
    return { reference: p };
  }
  if (references.length) conflict();
  const rows = await tx.auditLog.findMany({ where: { action, targetType: 'TradeDocument', targetId: params.documentId } });
  if (source.document.filePath === null) {
    if (rows.length) await proveUnsetHead(tx, source, rows, params);
    return { reference: null };
  }
  if (typeof source.document.filePath !== 'string' || !source.document.filePath) conflict();
  const matches = rows.filter((audit: any) => audit.detail?.packingListArchive?.filePath === source.document.filePath);
  if (matches.length === 1) {
    const original = await readPackingListArchiveSourceInTx(tx, { ...params, version: matches[0].detail.packingListArchive.version });
    prove(matches[0], original); return { reference: null };
  }
  // Any existing publication or native-like/borrowed reference is uncertain,
  // never an opportunity to replace missing proof with a new legacy audit.
  const borrowed = await tx.auditLog.findMany({ where: { action, targetType: 'TradeDocument',
    detail: { path: ['packingListArchive', 'filePath'], equals: source.document.filePath } } });
  if (rows.length || matches.length || borrowed.length || source.document.filePath.split(/[\\/]/).some((part: string) => /^pl-v2-/i.test(part))
    || typeof source.document.filePath !== 'string' || typeof source.document.fileName !== 'string' && source.document.fileName !== null) conflict();
  const legacy = await legacyPredecessor(tx, source, params);
  return { reference: referenceFor(source, legacy), createReference: true };
}
/** A candidate only triggers strict verification, never grants file ownership. */
export async function isPackingListArchiveCandidate(prisma: PrismaClient, doc: any): Promise<boolean> {
  if (!doc?.filePath) return false;
  if (/^pl-v2-[a-f0-9-]{36}\.pdf$/.test(path.posix.basename(path.posix.normalize(String(doc.filePath))))) return true;
  const rows = await prisma.auditLog.findMany({ where: { action, targetType: 'TradeDocument',
    detail: { path: ['packingListArchive', 'filePath'], equals: doc.filePath } } });
  return rows.length > 0;
}
/** The terminal authorization follows file/proof IO. Nothing later can fetch
 * another version or borrow the mutable header's path for the response. */
export async function readPackingListArchive(prisma: PrismaClient, params: Params & { allowMissing?: boolean }) {
  return prisma.$transaction(async tx => {
    const initial = await readPackingListArchiveSourceInTx(tx, params);
    const fixed = { ...params, version: initial.version.version };
    const header = await headerProof(tx, initial, fixed);
    const proof = await existing(tx, initial);
    if (!proof) {
      const after = await readPackingListArchiveSourceInTx(tx, fixed);
      if (after.archiveStamp !== initial.archiveStamp || hash((await headerProof(tx, after, fixed)).reference) !== hash(header.reference)) conflict();
      if (params.allowMissing) return null;
      throw businessError('NOT_FOUND', '所选装箱单版本尚未归档；请由有权限的人员明确生成。');
    }
    const bytes = readFile(proof);
    const audit = await tx.auditLog.findUnique({ where: { id: proof.auditId } });
    if (hash(prove(audit, initial)) !== hash(proof)) conflict();
    const after = await readPackingListArchiveSourceInTx(tx, fixed);
    if (after.archiveStamp !== initial.archiveStamp || hash((await headerProof(tx, after, fixed)).reference) !== hash(header.reference)) conflict();
    return { proof: json(proof) as PackingListArchiveProof, bytes, version: proof.version };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
export async function pinPackingListArchiveVersion(prisma: PrismaClient, params: Params) {
  const selected = await prisma.$transaction(tx => readPackingListArchiveSourceInTx(tx, params), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  return selected.version.version;
}
export async function recheckPackingListArchive(prisma: PrismaClient, params: Params, original: NonNullable<Awaited<ReturnType<typeof readPackingListArchive>>>) {
  const checked = await readPackingListArchive(prisma, { ...params, version: original.version });
  if (!checked || hash(checked.proof) !== hash(original.proof) || !checked.bytes.equals(original.bytes)) conflict();
}

/** Rendering is separate from atomic publication. Every attempt has its own
 * wx file; only a mandatory committed audit publishes that exact immutable N. */
export async function generatePackingListArchive(prisma: PrismaClient, params: Params & { actorId: string }) {
  const first = await prisma.$transaction(tx => readPackingListArchiveSourceInTx(tx, { ...params, write: true }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  if (params.actorId !== first.actor.userId) throw businessError('UNAUTHORIZED', '归档需要当前真实登录身份。');
  const fixed = { documentId: params.documentId, version: first.version.version, trustedActor: params.trustedActor };
  const registered = await readPackingListArchive(prisma, { ...fixed, allowMissing: true });
  if (registered) {
    const final = await prisma.$transaction(tx => readPackingListArchiveSourceInTx(tx, { ...fixed, write: true }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if (final.archiveStamp !== first.archiveStamp) conflict();
    return { filePath: registered.proof.filePath, fileName: registered.proof.fileName, fileSize: registered.proof.fileSize, version: registered.version, replayed: true };
  }
  const html = await renderServerDocument(prisma, 'shipmentIds' in first ? 'MERGED_PL' : 'PL', first.envelope);
  if (!html || html.length < 50 || html.length > 2 * 1024 * 1024) throw businessError('VALIDATION_FAILED', '原装箱单版本没有有效可渲染内容。');
  const rendered = await renderHtmlToPdf(html, { format: 'A4' });
  const bytes = rendered.pdf;
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('PL PDF engine returned no valid bytes');
  const dir = directory(true), physical = 'pl-v2-' + randomUUID() + '.pdf', filePath = 'trade-documents/' + physical;
  const physicalPath = path.join(dir, physical), fileName = first.document.documentNumber.replace(/[^\w.-]/g, '_') + '-v' + first.version.version + '.pdf';
  let written = false;
  try {
    fs.writeFileSync(physicalPath, bytes, { flag: 'wx' }); written = true;
    const published = await prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${params.documentId} FOR UPDATE`);
      const current = await readPackingListArchiveSourceInTx(tx, { ...fixed, write: true });
      if (current.archiveStamp !== first.archiveStamp) conflict();
      const prior = await existing(tx, current);
      if (prior) { readFile(prior); return { proof: prior, replayed: true }; }
      const header = await headerProof(tx, current, fixed);
      const proof: PackingListArchiveProof = { operation, protocol: 2, documentId: current.document.id, versionId: current.version.id, version: current.version.version,
        sourceHash: current.receipt.sourceFingerprint, contentHash: hash(current.version.content), pdfSha256: sha(bytes), fileSize: bytes.length,
        filePath, fileName, actorId: current.actor.userId, auditId: auditKey(current) };
      const latest = await tx.documentVersion.findFirst({ where: { documentId: params.documentId }, orderBy: { version: 'desc' }, select: { id: true, version: true } });
      if (!latest || !Number.isSafeInteger(latest.version) || latest.version < proof.version) conflict();
      // The current header pointer follows its current N; explicit old N is
      // preserved solely in its immutable publication ledger, never overrides N2.
      if (!header.reference && latest?.version === proof.version) await tx.tradeDocument.update({ where: { id: params.documentId }, data: { filePath, fileName, updatedAt: BigInt(Date.now()) } });
      if (header.createReference && header.reference) await tx.auditLog.create({ data: { id: header.reference.auditId, action: retainedAction,
        actorId: current.actor.userId, targetType: 'TradeDocument', targetId: current.document.id,
        transactionId: 'PL-ARCHIVE:' + current.version.id, detail: { legacyHeaderReference: json(header.reference) } } });
      const audit = await tx.auditLog.create({ data: { id: proof.auditId, action, actorId: current.actor.userId, targetType: 'TradeDocument', targetId: params.documentId,
        transactionId: 'PL-ARCHIVE:' + proof.versionId, detail: { packingListArchive: proof } } });
      if (current.document.filePath === null && latest.version !== proof.version) {
        const reference = { operation: unsetOperation, protocol: 1, documentId: current.document.id,
          archiveVersionId: current.version.id, archiveVersion: current.version.version, archiveAuditId: proof.auditId,
          latestVersionId: latest.id, latestVersion: latest.version, actorId: current.actor.userId,
          headBefore: headValue(current), headAfter: headValue(current), auditId: unsetKey(current) };
        await tx.auditLog.create({ data: { id: reference.auditId, action: unsetAction, actorId: current.actor.userId,
          targetType: 'TradeDocument', targetId: current.document.id, transactionId: 'PL-ARCHIVE:' + current.version.id,
          detail: { unsetHeaderReference: json(reference) } } });
      }
      prove(audit, current); readFile(proof);
      const final = await readPackingListArchiveSourceInTx(tx, { ...fixed, write: true });
      if (final.archiveStamp !== first.archiveStamp || hash((await headerProof(tx, final, fixed)).reference) !== hash(header.reference)) conflict();
      return { proof, replayed: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    const checked = await readPackingListArchive(prisma, fixed);
    if (!checked || hash(checked.proof) !== hash(published.proof)) conflict();
    if (published.proof.filePath !== filePath) fs.unlinkSync(physicalPath);
    return { filePath: checked.proof.filePath, fileName: checked.proof.fileName, fileSize: checked.proof.fileSize, version: checked.version, replayed: published.replayed };
  } catch (error) {
    if (written) {
      // A lost acknowledgement is not rollback proof. Preserve an uncertain
      // attempt even when a separate read cannot yet see its immutable audit.
      try {
        const committed = await prisma.auditLog.findUnique({ where: { id: auditKey(first) } });
        if (committed?.detail && (committed.detail as any).packingListArchive?.filePath === filePath) {
          const checked = await readPackingListArchive(prisma, fixed);
          if (checked?.proof.filePath === filePath) return { filePath, fileName: checked.proof.fileName, fileSize: checked.proof.fileSize, version: checked.version, replayed: true };
        }
      } catch { /* Unknown persistence/auth keeps this private attempt. */ }
    }
    throw error;
  }
}
