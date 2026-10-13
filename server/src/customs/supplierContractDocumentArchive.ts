import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TokenPayload } from '../auth/service';
import type { SupplierContractTx } from '../procurement/supplierContractAccess';
import { readSupplierContractDocumentInTx } from '../procurement/supplierContractDocument';
import { beginSupplierCommand, replaySupplierCommand, persistSupplierCommand, supplierResponse,
  type SupplierCommand, type SupplierCommandResponse } from '../procurement/supplierContractCommandReceipt';
import { supplierFail, supplierFingerprint, supplierJson, supplierObject, type SupplierContractKind } from '../procurement/supplierContractPolicy';
import { renderServerDocument } from '../templates/docTemplates/registry';
import { renderHtmlToPdf } from '../templates/pdf';
import { isInsideDir } from '../lib/privateFiles';
import { logger } from '../lib/logger';
import { parseSupplierContractDocumentSource } from './supplierContractDocumentPolicy';

type ApprovedSource = Awaited<ReturnType<typeof readSupplierContractDocumentInTx>>;
const uploadRoot = () => path.resolve(process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads'));
const sourceType = (kind: SupplierContractKind) => kind === 'purchase' ? 'PurchaseOrder' : 'ProcessingContract';
const documentNumber = (source: ApprovedSource) => `${source.number}-R${source.revision}`;
const conflict = (message: string): never => supplierFail('SUPPLIER_DOCUMENT_CHANGED', message, 409);
const approvedSnapshot = (source: ApprovedSource) => supplierJson({ protocol: 'SupplierContractDocument', schemaVersion: 1,
  contractId: source.contractId, contractKind: source.contractKind, revisionId: source.revisionId, revision: source.revision,
  number: source.number, sourceRef: source.sourceRef, approvedAt: source.approvedAt,
  sourceFingerprint: source.contentFingerprint, snapshot: source.snapshot });

/** The formal original has exactly one snapshot. A later promise gets a new
 * approved-revision identity; generic document edits cannot rewrite an original. */
export async function readSupplierContractTradeDocumentInTx(tx: SupplierContractTx, documentId: string,
  actor: TokenPayload | null | undefined, version = 1) {
  if (!actor?.userId) return supplierFail('UNAUTHORIZED', '读取采购或加工文件需要真实登录账号。', 401);
  if (version !== 1) return supplierFail('NOT_FOUND', '该批准版的正式原件只有版本 1。', 404);
  const doc = await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
  if (!doc) return supplierFail('NOT_FOUND', '正式采购或加工文件不存在。', 404);
  const ref = parseSupplierContractDocumentSource(doc.sourceRef);
  const source = await readSupplierContractDocumentInTx(tx, { actor, kind: ref.kind, id: ref.contractId, revisionId: ref.revisionId, forNewPromise: false });
  const commercial = supplierObject(source.snapshot);
  if (doc.domain !== 'procurement' || doc.type !== sourceType(ref.kind) || doc.sourceInvoiceId != null || doc.orderId != null
    || doc.documentNumber !== documentNumber(source) || doc.status !== 'Issued' || source.sourceRef !== doc.sourceRef
    || doc.currency !== commercial.currency || doc.relationId !== commercial.supplierRelationId
    || doc.totalAmount == null || !new Prisma.Decimal(String(doc.totalAmount)).equals(String(commercial.totalAmount)))
    return conflict('正式文件身份与准确合同批准版不一致，不能改类型或借用来源。');
  const versions = await tx.documentVersion.findMany({ where: { documentId }, orderBy: { version: 'asc' } });
  if (versions.length !== 1 || versions[0].version !== 1) return conflict('批准版原件版本链发生变化，禁止用后续手工内容替换。');
  const content = supplierObject(versions[0].content), { html, ...basis } = content;
  if (typeof html !== 'string' || html.length < 50 || supplierFingerprint(basis) !== supplierFingerprint(approvedSnapshot(source))
    || supplierFingerprint(content.snapshot) !== source.contentFingerprint)
    return conflict('正式原件的冻结内容或批准摘要无法准确核实。');
  return { document: doc, version: versions[0], content, source, html };
}

type ArchiveProof = { filePath: string; fileName: string; fileSize: number; sha256: string; sourceFingerprint: string; documentVersionId: string; contentFingerprint: string };
async function archiveProofInTx(tx: SupplierContractTx, selected: Awaited<ReturnType<typeof readSupplierContractTradeDocumentInTx>>) {
  const { document: doc, version, source } = selected;
  if (!doc.filePath || !doc.fileName) return supplierFail('NOT_FOUND', '正式原件尚未生成归档文件。', 404);
  if (!doc.filePath.startsWith('trade-documents/supplier-')) return conflict('正式原件归档路径缺少原生来源凭据。');
  const audits = await tx.auditLog.findMany({ where: { action: 'TRADE_DOCUMENT_FILE_GENERATED', targetType: 'TradeDocument', targetId: doc.id }, orderBy: { createdAt: 'desc' } });
  const row = audits.find(audit => {
    const detail = supplierObject(audit.detail);
    return detail.filePath === doc.filePath && detail.fileName === doc.fileName && detail.documentVersionId === version.id
      && detail.sourceRef === source.sourceRef && detail.sourceFingerprint === source.contentFingerprint
      && detail.contentFingerprint === supplierFingerprint(version.content);
  });
  const detail = supplierObject(row?.detail);
  if (!row || typeof detail.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(detail.sha256)
    || !Number.isSafeInteger(detail.fileSize) || Number(detail.fileSize) <= 0)
    return conflict('正式归档缺少与准确原件一致的强制生成审计。');
  return { filePath: doc.filePath, fileName: doc.fileName, fileSize: Number(detail.fileSize), sha256: detail.sha256,
    sourceFingerprint: source.contentFingerprint, documentVersionId: version.id, contentFingerprint: supplierFingerprint(version.content) } satisfies ArchiveProof;
}
function archiveBytes(proof: ArchiveProof): Buffer {
  const directory = path.join(uploadRoot(), 'trade-documents'), absolute = path.resolve(uploadRoot(), proof.filePath);
  if (!isInsideDir(directory, absolute) || !fs.existsSync(absolute)) return conflict('正式原件归档文件缺失或路径非法。');
  if (!isInsideDir(fs.realpathSync(directory), fs.realpathSync(absolute))) return conflict('正式原件归档路径不属于受保护目录。');
  const bytes = fs.readFileSync(absolute);
  if (bytes.length !== proof.fileSize || createHash('sha256').update(bytes).digest('hex') !== proof.sha256)
    return conflict('正式原件归档字节与原生成审计不一致。');
  return bytes;
}
export async function readSupplierContractArchive(prisma: PrismaClient, params: { documentId: string; actor: TokenPayload | null | undefined; version?: number }) {
  return prisma.$transaction(async tx => {
    const selected = await readSupplierContractTradeDocumentInTx(tx, params.documentId, params.actor, params.version);
    const proof = await archiveProofInTx(tx, selected), bytes = archiveBytes(proof);
    const final = await readSupplierContractTradeDocumentInTx(tx, params.documentId, params.actor, params.version);
    if (supplierFingerprint(final.document) !== supplierFingerprint(selected.document)
      || supplierFingerprint(final.version) !== supplierFingerprint(selected.version)) return conflict('读取正式原件时来源或当前权限已变化。');
    return { document: selected.document, version: selected.version, proof, bytes };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function renderSupplierContractTradeDocument(prisma: PrismaClient, params: { documentId: string; actor?: TokenPayload | null; version?: number }): Promise<string> {
  return prisma.$transaction(async tx => {
    const selected = await readSupplierContractTradeDocumentInTx(tx, params.documentId, params.actor, params.version);
    await readSupplierContractTradeDocumentInTx(tx, params.documentId, params.actor, params.version);
    return selected.html;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

type RegisterInput = { actor: TokenPayload; kind: SupplierContractKind; contractId: string; revisionId?: string; requestKey: string };
async function authorizedReplay(tx: SupplierContractTx, command: SupplierCommand, fingerprint: string): Promise<SupplierCommandResponse | null> {
  const replay = await replaySupplierCommand(tx, command, fingerprint);
  if (!replay) return null;
  if (!replay.commandAck.documentId || !replay.commandAck.revisionId) return supplierFail('RECEIPT_UNAVAILABLE', '原正式出单回执缺少准确文档身份。', 503);
  const selected = await readSupplierContractTradeDocumentInTx(tx, replay.commandAck.documentId, command.actor);
  if (selected.source.contractId !== command.targetId || selected.source.contractKind !== command.kind
    || selected.source.revisionId !== replay.commandAck.revisionId) return conflict('原正式出单回执的来源身份不一致。');
  archiveBytes(await archiveProofInTx(tx, selected));
  return replay;
}

/** Rendering happens privately first. The locked commit publishes the original
 * file, immutable source version and exact successful command receipt together. */
export async function registerSupplierContractTradeDocument(prisma: PrismaClient, params: RegisterInput): Promise<SupplierCommandResponse> {
  const command: SupplierCommand = { actor: params.actor, kind: params.kind, targetId: params.contractId, operation: 'generate_document', requestKey: params.requestKey,
    input: { revisionId: params.revisionId ?? null } };
  const prepared = await prisma.$transaction(async tx => {
    const begin = await beginSupplierCommand(tx, command), replay = await authorizedReplay(tx, command, begin.fingerprint);
    if (replay) return { replay };
    const source = await readSupplierContractDocumentInTx(tx, { actor: params.actor, kind: params.kind, id: params.contractId, revisionId: params.revisionId, forNewPromise: true });
    const existing = await tx.tradeDocument.findMany({ where: { sourceRef: source.sourceRef } });
    if (existing.length > 1 || existing.some(doc => doc.deletedAt != null)) return conflict('准确批准版已有冲突或被删除的正式原件，不能另建替代。');
    if (existing[0]?.filePath) {
      const selected = await readSupplierContractTradeDocumentInTx(tx, existing[0].id, params.actor);
      const proof = await archiveProofInTx(tx, selected); archiveBytes(proof);
      const result = supplierResponse({ documentId: selected.document.id, documentNumber: selected.document.documentNumber, revisionId: source.revisionId, version: 1, ...proof }, command, begin.receiptId, params.contractId,
        { documentId: selected.document.id, revisionId: source.revisionId });
      return { replay: await persistSupplierCommand(tx, command, begin.fingerprint, result) };
    }
    return { source };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
  if (prepared.replay) return prepared.replay;
  const source = prepared.source!;
  const html = await renderServerDocument(prisma, params.kind === 'purchase' ? 'PO' : 'PROCESSING',
    { supplierContractDocumentProtocol: 1, document: source }, {}, { id: `supplier:${source.revisionId}`, type: sourceType(params.kind), sourceRef: source.sourceRef, trustedActor: params.actor });
  if (!html || html.length < 50 || html.length > 2 * 1024 * 1024) return supplierFail('INVALID_DOCUMENT_CONTENT', '批准版文件模板没有有效可渲染内容。', 409);
  const pdf = await renderHtmlToPdf(html, { format: 'A4' }), fileName = `${documentNumber(source).replace(/[^\w.-]/g, '_')}-v1.pdf`;
  const filePath = `trade-documents/supplier-${randomUUID()}-${fileName}`, physicalPath = path.join(uploadRoot(), filePath);
  fs.mkdirSync(path.dirname(physicalPath), { recursive: true }); fs.writeFileSync(physicalPath, pdf.pdf, { flag: 'wx' });
  let published = false;
  try {
    const result = await prisma.$transaction(async tx => {
      const begin = await beginSupplierCommand(tx, command), replay = await authorizedReplay(tx, command, begin.fingerprint);
      if (replay) return replay;
      const current = await readSupplierContractDocumentInTx(tx, { actor: params.actor, kind: params.kind, id: params.contractId, revisionId: source.revisionId, forNewPromise: true });
      if (supplierFingerprint(approvedSnapshot(current)) !== supplierFingerprint(approvedSnapshot(source))) return conflict('批准依据在生成期间变化，请重新核对当前版本。');
      await tx.$queryRaw(Prisma.sql`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`supplier-document:${source.sourceRef}`}, 0))) AS document_source_lock`);
      const existing = await tx.tradeDocument.findMany({ where: { sourceRef: source.sourceRef } });
      if (existing.length > 1 || existing.some(doc => doc.deletedAt != null)) return conflict('准确批准版已有冲突的正式原件。');
      if (existing[0]) {
        const selected = await readSupplierContractTradeDocumentInTx(tx, existing[0].id, params.actor);
        const proof = await archiveProofInTx(tx, selected); archiveBytes(proof);
        return persistSupplierCommand(tx, command, begin.fingerprint, supplierResponse({ documentId: selected.document.id,
          documentNumber: selected.document.documentNumber, revisionId: source.revisionId, version: 1, ...proof }, command, begin.receiptId, params.contractId,
        { documentId: selected.document.id, revisionId: source.revisionId }));
      }
      const snapshot = supplierObject(source.snapshot), timestamp = BigInt(Date.now()), id = `TD_${randomUUID()}`, versionId = `DVER_${randomUUID()}`;
      const content = supplierJson({ ...supplierObject(approvedSnapshot(source)), html });
      const document = await tx.tradeDocument.create({ data: { id, documentNumber: documentNumber(source), domain: 'procurement', type: sourceType(params.kind), status: 'Issued',
        sourceRef: source.sourceRef, orderId: null, relationId: typeof snapshot.supplierRelationId === 'string' ? snapshot.supplierRelationId : null,
        totalAmount: new Prisma.Decimal(String(snapshot.totalAmount)), currency: String(snapshot.currency), createdAt: timestamp, updatedAt: timestamp } });
      await tx.documentVersion.create({ data: { id: versionId, documentId: id, version: 1, content,
        changeReason: '准确供应商合同批准版正式原件', changedBy: params.actor.userId, createdAt: timestamp } });
      const proof = { filePath, fileName, fileSize: pdf.pdf.length, sha256: createHash('sha256').update(pdf.pdf).digest('hex'),
        sourceFingerprint: source.contentFingerprint, sourceRef: source.sourceRef, documentVersionId: versionId, contentFingerprint: supplierFingerprint(content) };
      await tx.tradeDocument.update({ where: { id }, data: { filePath, fileName } });
      await tx.auditLog.create({ data: { id: `AUD_${randomUUID()}`, actorId: params.actor.userId, action: 'TRADE_DOCUMENT_FILE_GENERATED', targetType: 'TradeDocument', targetId: id,
        detail: supplierJson({ ...proof, version: 1, requestKey: command.requestKey }) } });
      await readSupplierContractTradeDocumentInTx(tx, id, params.actor);
      return persistSupplierCommand(tx, command, begin.fingerprint, supplierResponse({ documentId: id, documentNumber: document.documentNumber, revisionId: source.revisionId, version: 1, ...proof }, command, begin.receiptId, params.contractId,
        { documentId: id, revisionId: source.revisionId }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
    published = supplierObject(result.item).filePath === filePath;
    return result;
  } finally {
    if (!published) {
      try {
        const actual = await prisma.tradeDocument.findFirst({ where: { filePath }, select: { id: true } });
        const audit = await prisma.auditLog.findFirst({ where: { action: 'TRADE_DOCUMENT_FILE_GENERATED', detail: { path: ['filePath'], equals: filePath } }, select: { id: true } });
        if (!actual && !audit) fs.unlinkSync(physicalPath);
      } catch (error) { logger.error('[SupplierDocument] unpublished file cleanup could not be verified', { error }); }
    }
  }
}
