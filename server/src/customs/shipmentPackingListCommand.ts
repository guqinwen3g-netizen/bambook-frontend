import { isLegacyMergedPackingListReadCandidate, readLegacyMergedPackingListVersionInTx } from './legacyMergedPackingListRead';
/** Controlled PL Draft source unit. It appends immutable versions and their
 * mandatory receipts only. HTTP/publication/download integration is separate;
 * no shipment, stock, Invoice, QC or issued document fact is rewritten. */
import { Prisma, type PrismaClient } from '@prisma/client';
import { isMergedPackingListCandidateInTx, readMergedPackingListDraftSource, readMergedPackingListVersionInTx, saveMergedPackingListDraft,
  readOwnMergedPackingListCommand, authorizeMergedPackingListMetadataInTx, finishMergedPackingListMetadataInTx, readMergedPackingListArchiveSourceInTx } from './mergedPackingListCommand';
import { readDevelopmentDomainErrorMint } from '../development/developmentOperationalGuard';
import { lockReleaseSources } from '../production/releaseService';
import { readOrderLineWriteErrorMint } from '../orders/orderLineWriteAccess';
import { generateTradeDocumentNumber } from './tradeDocumentLifecycleService';
import { randomUUID } from 'node:crypto';
import type { TokenPayload } from '../auth/service';
import { businessError, readBusinessErrorMint } from '../shared/errorCodes';
import { DEFAULT_EXPORTER_PROFILE, EXPORTER_PROFILE_CONFIG_ID } from '../config/systemConfigRoute';
import { currentDocumentActor, authorizedDocumentOrders, documentSourceFingerprint as hash, documentSourceJson as json,
  shipmentDocumentSourceInTx, lockShipmentDocumentSourcesInTx } from '../shipping/shipmentDocumentSource';
import { assertPackingListEnvelope, buildPackingListEnvelope, type PackingListEnvelope, type PackingListSnapshot } from '../templates/docTemplates/packingListSource';
import { todayLocalKey } from '../shared/localDate';


const action = 'APPEND_PACKING_LIST_DRAFT', operation = 'append_packing_list_draft_version';
const scopes = ['customs:read', 'shipments:read'] as const;
const packingListFailures = new WeakSet<object>();
export function isPackingListFailure(error: unknown): boolean { return typeof error === 'object' && error !== null && packingListFailures.has(error); }
function conflict(message: string): never { const error = businessError('CONFLICT', message); packingListFailures.add(error); throw error; }
const invisible = (): never => { throw businessError('NOT_FOUND', '装箱单不存在或不可查看。'); };
const uuid = (v: any) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const fingerprint = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export type PackingListDraftInput = { requestKey: string; expectedLatestVersion: number; expectedContentHash: string;
  expectedSourceFingerprint: string; reason: string };
export type PackingListDraftReceipt = { operation: typeof operation; protocol: 2; commandId: string; requestKey: string;
  actorId: string; documentId: string; shipmentId: string; parameterHash: string; sourceFingerprint: string;
  previousVersion: number; previousContentHash: string; version: number; versionId: string; contentHash: string; auditIds: string[] };

function parse(value: unknown): PackingListDraftInput {
  const v: any = value;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 5
    || !uuid(v.requestKey) || !Number.isSafeInteger(v.expectedLatestVersion) || v.expectedLatestVersion < 1
    || !fingerprint(v.expectedContentHash) || !fingerprint(v.expectedSourceFingerprint)
    || typeof v.reason !== 'string' || !v.reason.trim() || v.reason.length > 2000) {
    throw businessError('INVALID_INPUT', '请保留原请求键、来源和版本校验值，并填写追加版本说明。');
  }
  return { requestKey: v.requestKey, expectedLatestVersion: v.expectedLatestVersion, expectedContentHash: v.expectedContentHash,
    expectedSourceFingerprint: v.expectedSourceFingerprint, reason: v.reason.trim() };
}
function assertDocument(document: any, draft = false): void {
  if (!document || document.deletedAt !== null && document.deletedAt !== undefined) invisible();
  if (document.type !== 'PackingList' || document.domain !== 'customs' || !document.shipmentId
    || typeof document.documentNumber !== 'string' || !document.documentNumber.trim()) conflict('原单据不是有准确运单来源的装箱单。');
  if (draft && document.status !== 'Draft') conflict('仅可给原 Draft 装箱单追加来源版本，已签发或交单事实保持原样。');
}
async function exporter(tx: any): Promise<PackingListSnapshot['exporter']> {
  // Bypass the display TTL cache: a dependency failure is unknown, not a
  // silently invented default. Absence uses the existing explicit default.
  const row = await tx.systemConfig.findUnique({ where: { id: EXPORTER_PROFILE_CONFIG_ID } });
  if (!row) return { nameEn: DEFAULT_EXPORTER_PROFILE.nameEn, addressEn: DEFAULT_EXPORTER_PROFILE.addressEn, source: 'default', configVersion: null };
  if (row.encrypted || row.valueType !== 'json' || !Number.isSafeInteger(row.version) || row.version < 1) conflict('当前出具方档案无法核验。');
  let value = row.value;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { conflict('当前出具方档案无法核验。'); } }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.nameEn !== 'string' || !value.nameEn.trim()
    || typeof value.addressEn !== 'string') conflict('当前出具方档案无法核验。');
  return { nameEn: value.nameEn, addressEn: value.addressEn, source: 'configured', configVersion: row.version };
}
async function currentSource(tx: any, document: any, prior: TokenPayload | null, write: boolean) {
  const required = write ? [...scopes, 'customs:write' as const] : [...scopes];
  const firstActor = await currentDocumentActor(tx, prior, required);
  const profile = await exporter(tx);
  const facts = await shipmentDocumentSourceInTx(tx, document.shipmentId, { trustedActor: prior, extraScopes: required });
  if (document.orderId !== null && document.orderId !== undefined && !facts.orderIds.includes(document.orderId)) conflict('原装箱单订单归属与当前运单不一致。');
  const originalConsignee = facts.shipment.consigneeName ?? null;
  const envelope = buildPackingListEnvelope(facts, { ...document, consignee: originalConsignee }, profile);
  if (originalConsignee === null || originalConsignee === '') {
    envelope.packingListSource.warnings.push('原运单收货主体未知；不以客户替代。');
    envelope.packingListHash = hash(envelope.packingListSource);
    assertPackingListEnvelope(envelope);
  }
  const actor = await currentDocumentActor(tx, prior, [...required, ...(facts.orderIds.length ? ['orders:read' as const] : [])]);
  await authorizedDocumentOrders(tx, actor, facts.orderIds);
  const finalActor = await currentDocumentActor(tx, prior, [...required, ...(facts.orderIds.length ? ['orders:read' as const] : [])]);
  if (hash(firstActor) !== hash(finalActor)) conflict('当前权限在读取装箱单来源时变化。');
  return { facts, envelope, actor: finalActor, fingerprint: hash(envelope) };
}
async function target(tx: any, documentId: string, prior: TokenPayload | null, draft: boolean, write: boolean) {
  await currentDocumentActor(tx, prior, write ? [...scopes, 'customs:write'] : scopes);
  const document = await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
  assertDocument(document, draft);
  const source = await currentSource(tx, document, prior, write);
  return { document, ...source };
}
async function historicalAuthority(tx: any, prior: TokenPayload | null, envelope: PackingListEnvelope, write: boolean) {
  const required = [...scopes, ...(write ? ['customs:write' as const] : []), ...(envelope.packingListSource.source.orderIds.length ? ['orders:read' as const] : [])];
  const actor = await currentDocumentActor(tx, prior, required);
  const orders = await authorizedDocumentOrders(tx, actor, envelope.packingListSource.source.orderIds);
  const finalActor = await currentDocumentActor(tx, prior, required);
  if (hash(actor) !== hash(finalActor)) conflict('当前历史版本权限已变化。');
  return hash({ actor: finalActor, orders });
}
const documentIdentity = (d: any) => ({ id: d.id, documentNumber: d.documentNumber, shipmentId: d.shipmentId, orderId: d.orderId,
  type: d.type, domain: d.domain, status: d.status, issueDate: d.issueDate, consignee: d.consignee, deletedAt: d.deletedAt });

/** A damaged native predecessor cannot become the basis of a new command.
 * Unmarked legacy content is retained as legacy; this does not mint old proof. */
async function nativePredecessorAuthority(tx: any, document: any, version: any, prior: TokenPayload | null, write: boolean) {
  const audits = await tx.auditLog.findMany({ where: { targetType: 'TradeDocument', targetId: document.id,
    action: { in: [action, 'TRADE_DOCUMENT_CREATE'] } } });
  const controlled = version.content?.plDraftProtocol !== undefined || audits.some((row: any) => {
    const receipt = row.detail?.packingListReceipt ?? row.detail?.packingListRegistration;
    return receipt?.versionId === version.id || receipt?.version === version.version;
  });
  if (!controlled) return null;
  const proved = await proveSelected(tx, document, version);
  if (proved.protocol !== 2) conflict('原生装箱单前版无法核验，不能继续追加。');
  return parentAuthority(tx, prior, proved.parentIds, write);
}

export async function readPackingListDraftSource(prisma: PrismaClient, documentId: string, trustedActor: TokenPayload | null) {
  if (await isMergedPackingListCandidateInTx(prisma, await prisma.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } }))) return readMergedPackingListDraftSource(prisma, documentId, trustedActor);
  return prisma.$transaction(async tx => {
    const first = await target(tx, documentId, trustedActor, true, false);
    const latest = await tx.documentVersion.findFirst({ where: { documentId }, orderBy: { version: 'desc' } });
    if (!latest || !Number.isSafeInteger(latest.version) || latest.version < 1) conflict('原装箱单没有可核对的既有版本。');
    const predecessor = await nativePredecessorAuthority(tx, first.document, latest, trustedActor, false);
    const final = await target(tx, documentId, trustedActor, true, false);
    const finalLatest = await tx.documentVersion.findUnique({ where: { id: latest.id } });
    if (!finalLatest || hash(finalLatest) !== hash(latest) || predecessor !== await nativePredecessorAuthority(tx, final.document, finalLatest, trustedActor, false)) conflict('原装箱单前版或可见范围在读取时变化。');
    if (first.fingerprint !== final.fingerprint || hash(documentIdentity(first.document)) !== hash(documentIdentity(final.document))) conflict('装箱单来源在读取时变化。');
    return { documentId, shipmentId: final.document.shipmentId, source: final.envelope, sourceFingerprint: final.fingerprint,
      latest: { id: latest.id, version: latest.version, contentHash: hash(latest.content), protocol: (latest.content as any)?.plDraftProtocol === 2 ? 2 : 1 } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function verifyReceipt(tx: any, audit: any, document: any, parameterHash?: string) {
  const receipt: PackingListDraftReceipt = audit?.detail?.packingListReceipt;
  if (!receipt || receipt.operation !== operation || receipt.protocol !== 2 || !uuid(receipt.commandId) || !uuid(receipt.requestKey)
    || receipt.documentId !== document.id || receipt.shipmentId !== document.shipmentId || receipt.actorId !== audit.actorId
    || audit.action !== action || audit.targetType !== 'TradeDocument' || audit.targetId !== document.id
    || !fingerprint(receipt.parameterHash) || parameterHash !== undefined && receipt.parameterHash !== parameterHash
    || !fingerprint(receipt.contentHash) || !fingerprint(receipt.sourceFingerprint) || !fingerprint(receipt.previousContentHash)
    || !Number.isSafeInteger(receipt.previousVersion) || receipt.previousVersion < 1 || receipt.version !== receipt.previousVersion + 1
    || !Array.isArray(receipt.auditIds) || receipt.auditIds.length !== 2 || receipt.auditIds[0] !== audit.id
    || audit.transactionId !== 'PL-DRAFT:' + receipt.commandId) conflict('原装箱单版本回执丢失或损坏，禁止补造替代版本。');
  const version = await tx.documentVersion.findUnique({ where: { id: receipt.versionId } });
  const predecessor = await tx.documentVersion.findUnique({ where: { documentId_version: { documentId: document.id, version: receipt.previousVersion } } });
  const versionAudit = await tx.auditLog.findUnique({ where: { id: receipt.auditIds[1] } });
  if (!version || version.documentId !== document.id || version.version !== receipt.version || version.changedBy !== receipt.actorId
    || hash(version.content) !== receipt.contentHash || !predecessor || hash(predecessor.content) !== receipt.previousContentHash
    || !versionAudit || versionAudit.action !== 'DOCUMENT_VERSION_CREATE' || versionAudit.targetType !== 'DocumentVersion'
    || versionAudit.targetId !== version.id || versionAudit.actorId !== receipt.actorId || versionAudit.transactionId !== audit.transactionId
    || hash(versionAudit.detail) !== hash({ protocol: 2, documentId: document.id, version: version.version,
      contentHash: receipt.contentHash, sourceFingerprint: receipt.sourceFingerprint, requestKey: receipt.requestKey, parameterHash: receipt.parameterHash }))
    conflict('原装箱单版本或 mandatory 审计无法完整核验。');
  const content: any = version.content;
  if (content?.plDraftProtocol !== 2 || Object.keys(content).length !== 3
    || hash(content.command) !== hash({ commandId: receipt.commandId, requestKey: receipt.requestKey, actorId: receipt.actorId, parameterHash: receipt.parameterHash, versionId: receipt.versionId }))
    conflict('原装箱单版本命令身份丢失或损坏。');
  const originalInput = parse(audit.detail.intent);
  if (hash({ operation, actorId: receipt.actorId, documentId: document.id, input: originalInput }) !== receipt.parameterHash) conflict('原版本意图与回执不一致。');
  const envelope = assertPackingListEnvelope(content.packingList);
  if (envelope.packingListSource.document.id !== document.id || envelope.packingListSource.document.documentNumber !== document.documentNumber
    || envelope.packingListSource.source.shipmentId !== document.shipmentId || hash(envelope) !== receipt.sourceFingerprint)
    conflict('原装箱单版本身份与来源回执不一致。');
  return { receipt, version, envelope };
}

/** Only an explicitly requested Draft append. Replaying the original key
 * returns its immutable result even after a later legitimate append. */
export async function appendPackingListDraftVersion(prisma: PrismaClient, params: {
  documentId: string; trustedActor: TokenPayload | null; input: unknown;
}) {
  if (await isMergedPackingListCandidateInTx(prisma, await prisma.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } }))) return saveMergedPackingListDraft(prisma, { ...params, documentId: params.documentId });
  const input = parse(params.input);
  return prisma.$transaction(async (tx: any) => {
    const first = await target(tx, params.documentId, params.trustedActor, true, true);
    await lockShipmentDocumentSourcesInTx(tx, [first.document.shipmentId], { trustedActor: params.trustedActor, extraScopes: ['customs:read', 'customs:write'] });
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${params.documentId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DocumentVersion" WHERE "documentId"=${params.documentId} ORDER BY "version" FOR UPDATE`);
    const locked = await target(tx, params.documentId, params.trustedActor, true, true);
    if (first.fingerprint !== locked.fingerprint || hash(documentIdentity(first.document)) !== hash(documentIdentity(locked.document))) conflict('装箱单来源在取得锁时变化。');
    const parameterHash = hash({ operation, actorId: locked.actor.userId, documentId: params.documentId, input });
    const commandAuditId = 'AUD_PL_DRAFT_' + hash({ actorId: locked.actor.userId, documentId: params.documentId, requestKey: input.requestKey });
    const existing = await tx.auditLog.findUnique({ where: { id: commandAuditId } });
    if (existing) {
      const proved = await verifyReceipt(tx, existing, locked.document, parameterHash);
      const historyBefore = await historicalAuthority(tx, params.trustedActor, proved.envelope, true);
      const final = await target(tx, params.documentId, params.trustedActor, true, true);
      if (final.fingerprint !== locked.fingerprint || historyBefore !== await historicalAuthority(tx, params.trustedActor, proved.envelope, true)) conflict('装箱单当前读取来源已变化。');
      return { receipt: json(proved.receipt), version: json(proved.version), replayed: true };
    }
    const orphan = await tx.documentVersion.findMany({ where: { documentId: params.documentId, AND: [
      { content: { path: ['command', 'requestKey'], equals: input.requestKey } }, { content: { path: ['command', 'actorId'], equals: locked.actor.userId } } ] }, select: { id: true } });
    if (orphan.length) conflict('原请求版本仍在但命令审计丢失，请人工核对，不能自动重建。');
    const latest = await tx.documentVersion.findFirst({ where: { documentId: params.documentId }, orderBy: { version: 'desc' } });
    if (!latest || latest.version !== input.expectedLatestVersion || hash(latest.content) !== input.expectedContentHash)
      conflict('原装箱单版本已变化，请重新核对后明确追加。');
    if (locked.fingerprint !== input.expectedSourceFingerprint) conflict('当前逐箱包装来源已变化，请重新核对。');
    const predecessor = await nativePredecessorAuthority(tx, locked.document, latest, params.trustedActor, true);
    const ts = BigInt(Date.now()), versionId = 'DVER_PL_' + randomUUID(), commandId = randomUUID(), versionAuditId = 'AUD_PL_VERSION_' + randomUUID();
    const content = { plDraftProtocol: 2, command: { commandId, requestKey: input.requestKey, actorId: locked.actor.userId, parameterHash, versionId }, packingList: locked.envelope };
    const receipt: PackingListDraftReceipt = { operation, protocol: 2, commandId, requestKey: input.requestKey, actorId: locked.actor.userId,
      documentId: params.documentId, shipmentId: locked.document.shipmentId, parameterHash, sourceFingerprint: locked.fingerprint,
      previousVersion: latest.version, previousContentHash: hash(latest.content), version: latest.version + 1, versionId,
      contentHash: hash(content), auditIds: [commandAuditId, versionAuditId] };
    const version = await tx.documentVersion.create({ data: { id: versionId, documentId: params.documentId, version: receipt.version,
      content: json(content), changedBy: locked.actor.userId, changeReason: input.reason, createdAt: ts } });
    await tx.auditLog.create({ data: { id: versionAuditId, action: 'DOCUMENT_VERSION_CREATE', actorId: locked.actor.userId,
      targetType: 'DocumentVersion', targetId: version.id, transactionId: 'PL-DRAFT:' + commandId,
      detail: { protocol: 2, documentId: params.documentId, version: version.version, contentHash: receipt.contentHash,
        sourceFingerprint: receipt.sourceFingerprint, requestKey: input.requestKey, parameterHash } } });
    await tx.auditLog.create({ data: { id: commandAuditId, action, actorId: locked.actor.userId, targetType: 'TradeDocument', targetId: params.documentId,
      transactionId: 'PL-DRAFT:' + commandId, detail: { packingListReceipt: receipt, intent: input } } });
    const updatedAt = ts > BigInt(locked.document.updatedAt) ? ts : BigInt(locked.document.updatedAt) + BigInt(1);
    await tx.tradeDocument.update({ where: { id: params.documentId }, data: { updatedAt } });
    const persistedAudit = await tx.auditLog.findUnique({ where: { id: commandAuditId } });
    await verifyReceipt(tx, persistedAudit, locked.document, parameterHash);
    const final = await target(tx, params.documentId, params.trustedActor, true, true);
    if (predecessor !== await nativePredecessorAuthority(tx, final.document, latest, params.trustedActor, true)) conflict('原装箱单前版来源或当前权限在追加时变化。');
    if (final.fingerprint !== locked.fingerprint || hash(documentIdentity(final.document)) !== hash(documentIdentity(locked.document))) conflict('装箱单来源或当前权限在追加版本时变化。');
    return { receipt: json(receipt), version: json(version), replayed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}


/** The public boundary recognizes actual mint provenance, not mutable code,
 * status or Error.name supplied by a storage exception. */
export function packingListHttpFailure(error: unknown) {
  const minted = readBusinessErrorMint(error) ?? readOrderLineWriteErrorMint(error) ?? readDevelopmentDomainErrorMint(error);
  return minted ? { status: minted.statusCode, code: minted.code, message: minted.message }
    : { status: 500, code: 'INTERNAL_ERROR', message: '装箱单结果暂不可确认，请刷新原记录后核对。' };
}
export const packingListFileUnavailable = (): never => conflict('装箱单文件需按确切版本受控归档，当前入口不能重新生成或下载未核验的旧文件。');

/** Markers never confer authority; an original native command cannot downgrade
 * to unverified legacy merely by replacing the content or header type. */
async function classificationRead(work: () => Promise<any>): Promise<any> {
  try { return await work(); } catch {
    const failure = new Error('单据来源分类暂不可核验。');
    packingListFailures.add(failure);
    throw failure;
  }
}
export async function isPackingListCandidateInTx(tx: any, doc: any): Promise<boolean> {
  if (!doc) return false;
  if (doc.type === 'PackingList' || doc.sourceRef?.startsWith('composite:MERGED_PL:')) return true;
  if (doc.filePath && await classificationRead(() => tx.tradeDocument.findFirst({ where: { type: 'PackingList', filePath: doc.filePath }, select: { id: true } }))) return true;
  if (await classificationRead(() => tx.auditLog.findFirst({ where: { targetType: 'TradeDocument', targetId: doc.id,
    OR: [{ action }, { action: 'TRADE_DOCUMENT_CREATE', detail: { path: ['packingListRegistration','protocol'], equals: 2 } },
      { action: 'TRADE_DOCUMENT_CREATE', detail: { path: ['type'], equals: 'PackingList' } }] }, select: { id: true } }))) return true;
  // A namespace is only a quarantine signal. It cannot mint native provenance
  // or turn arbitrary legacy JSON into an authorized packing-list version.
  for (let offset = 0; ; offset += 200) {
    const versions = await classificationRead(() => tx.documentVersion.findMany({ where: { documentId: doc.id },
      select: { content: true }, orderBy: { version: 'asc' }, skip: offset, take: 200 }));
    if (!Array.isArray(versions) || versions.length > 200) conflict('原单据版本集合暂不可核验。');
    if (versions.some((v: any) => v.content?.plDraftProtocol !== undefined || v.content?.plSourceProtocol !== undefined
      || v.content?.packingList?.plSourceProtocol !== undefined || v.content?.kind === 'MERGED_PL'
      || v.content?.type === 'PackingList' || v.content?.document?.type === 'PackingList')) return true;
    if (versions.length < 200) return false;
  }
}
export async function rejectGenericPackingListWrite(tx: any, doc: any, input?: any): Promise<void> {
  if (input?.filePath && await classificationRead(() => tx.tradeDocument.findFirst({ where: { type: 'PackingList', filePath: input.filePath }, select: { id: true } }))) packingListFileUnavailable();
  if (input?.plDraftProtocol !== undefined || input?.plSourceProtocol !== undefined || input?.packingList !== undefined || input?.kind === 'MERGED_PL') conflict('装箱单来源版本不能通过通用 JSON 入口登记。');
  if (input?.type === 'PackingList' || input?.sourceRef?.startsWith('composite:MERGED_PL:') || await isPackingListCandidateInTx(tx, doc))
    conflict('装箱单只由准确运单来源登记并明确追加，不能手工改类型、来源、文件或任意版本内容。');
}
function legacyParents(document: any, version: any): string[] {
  const ds = version?.content?.documentSet;
  if (!ds || typeof ds !== 'object' || ds.shipment?.id !== document.shipmentId
    || ds.source?.schemaVersion !== 1 || !Array.isArray(ds.source.orderIds) || !Array.isArray(ds.lines)
    || ds.source.orderIds.some((id: any) => typeof id !== 'string' || !id)
    || new Set(ds.source.orderIds).size !== ds.source.orderIds.length) conflict('历史装箱单父来源无法完整确定；保留原记录，待核对后查看。');
  const parents = [...ds.source.orderIds].sort();
  if (document.orderId && !parents.includes(document.orderId) || ds.order?.id && !parents.includes(ds.order.id)
    || ds.lines.some((line: any) => line.orderId !== null && line.orderId !== undefined && !parents.includes(line.orderId)))
    conflict('历史装箱单父来源不一致，不能只按第一订单查看。');
  if (!parents.length && (document.orderId || ds.order || ds.lines.some((l: any) => l.orderLineId || l.orderId))) conflict('历史装箱单父来源无法确定。');
  return parents;
}
async function parentAuthority(tx: any, prior: TokenPayload | null, orderIds: string[], write = false) {
  const required = [...scopes, ...(write ? ['customs:write' as const] : []), ...(orderIds.length ? ['orders:read' as const] : [])];
  const actor = await currentDocumentActor(tx, prior, required);
  const orders = await authorizedDocumentOrders(tx, actor, orderIds);
  const finalActor = await currentDocumentActor(tx, prior, required);
  if (hash(actor) !== hash(finalActor)) conflict('当前装箱单权限在读取时变化。');
  return hash({ actor: finalActor, orders });
}
async function registeredVersion(tx: any, doc: any, version: any, audit: any) {
  const p = audit?.detail?.packingListRegistration;
  if (!p || p.protocol !== 2 || p.documentId !== doc.id || p.shipmentId !== doc.shipmentId || p.documentNumber !== doc.documentNumber
    || audit.action !== 'TRADE_DOCUMENT_CREATE' || audit.targetType !== 'TradeDocument' || audit.targetId !== doc.id
    || p.actorId !== audit.actorId || !uuid(p.commandId) || audit.transactionId !== 'PL-REGISTER:' + p.commandId
    || p.version !== 1 || p.versionId !== version.id || version.version !== 1 || version.changedBy !== audit.actorId
    || !fingerprint(p.contentHash) || hash(version.content) !== p.contentHash || !fingerprint(p.sourceFingerprint)
    || !Array.isArray(p.auditIds) || p.auditIds.length !== 2 || p.auditIds[0] !== audit.id) conflict('原装箱单登记审计无法核验。');
  const va = await tx.auditLog.findUnique({ where: { id: p.auditIds[1] } });
  if (!va || va.action !== 'DOCUMENT_VERSION_CREATE' || va.targetType !== 'DocumentVersion' || va.targetId !== version.id
    || va.actorId !== p.actorId || va.transactionId !== audit.transactionId
    || hash(va.detail) !== hash({ protocol: 2, documentId: doc.id, version: 1, contentHash: p.contentHash, sourceFingerprint: p.sourceFingerprint }))
    conflict('原装箱单版本审计无法核验。');
  const envelope = assertPackingListEnvelope(version.content?.packingList);
  if (version.content?.plDraftProtocol !== 2 || hash(version.content.command) !== hash({ commandId: p.commandId, actorId: p.actorId, versionId: version.id })
    || Object.keys(version.content).length !== 3 || hash(envelope) !== p.sourceFingerprint
    || envelope.packingListSource.document.id !== doc.id || envelope.packingListSource.document.documentNumber !== doc.documentNumber
    || envelope.packingListSource.source.shipmentId !== doc.shipmentId) conflict('原装箱单登记身份或来源已损坏。');
  return { envelope, receipt: p };
}
async function proveSelected(tx: any, document: any, version: any) {
  const audits = await tx.auditLog.findMany({ where: { targetType: 'TradeDocument', targetId: document.id,
    action: { in: [action, 'TRADE_DOCUMENT_CREATE'] } } });
  const matching = audits.filter((a: any) => (a.detail?.packingListReceipt ?? a.detail?.packingListRegistration)?.versionId === version.id);
  if (matching.length > 1) conflict('原装箱单版本来源审计不唯一。');
  if (matching.length === 1) {
    const proved = matching[0].action === action ? await verifyReceipt(tx, matching[0], document) : await registeredVersion(tx, document, version, matching[0]);
    return { protocol: 2 as const, provenance: 'native' as const, envelope: proved.envelope, receipt: proved.receipt,
      parentIds: proved.envelope.packingListSource.source.orderIds };
  }
  if (version.content?.plDraftProtocol !== undefined || audits.some((a: any) => (a.detail?.packingListReceipt ?? a.detail?.packingListRegistration)?.version === version.version))
    conflict('原装箱单版本缺少完整来源审计，不能降级为历史内容。');
  return { protocol: 1 as const, provenance: 'legacy_unverified' as const, envelope: null, receipt: null, parentIds: legacyParents(document, version) };
}
async function historicalWarning(tx: any, document: any, envelope: PackingListEnvelope | null) {
  const current = await tx.shipment.findUnique({ where: { id: document.shipmentId }, select: { id: true, status: true, deletedAt: true, updatedAt: true } });
  const cartons = envelope ? await tx.shipmentCarton.findMany({ where: { shipmentId: document.shipmentId }, include: { items: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }) : [];
  const simple = (rows: any[]) => rows.map(row => ({ id: row.id, cartonNo: row.cartonNo, description: row.description ?? null,
    ...Object.fromEntries(['length','width','height','grossWeight','netWeight','volume'].map(key => [key, row[key] == null ? null : String(row[key])])),
    items: row.items.map((i: any) => ({ id: i.id, shipmentLineId: i.shipmentLineId, quantity: String(i.quantity) })).sort((a: any,b: any) => a.id.localeCompare(b.id)) })).sort((a,b) => a.id.localeCompare(b.id));
  const changed = !!envelope && (String(current?.updatedAt) !== envelope.packingListSource.source.shipmentUpdatedAt || hash(simple(cartons)) !== hash(simple(envelope.packingListSource.cartons)));
  return { stamp: hash({ current, cartons }), warnings: [
    ...(!envelope ? ['历史来源待核对；此版本未具备原生 v2 来源回执。'] : []),
    ...(!current || current.deletedAt !== null || current.status === 'Cancelled' ? ['当前运单已取消或不可操作；此处仅显示原历史版本。'] : []),
    ...(changed ? ['当前包装来源已更新；此处仍显示原历史版本。'] : []),
  ] };
}
/** No current-source eligibility check here: history is authorized against its
 * original frozen parents. Current cancellation is a warning, never a grant. */
export async function readPackingListVersionInTx(tx: any, params: { documentId: string; version?: number; trustedActor: TokenPayload | null; write?: boolean }) {
  if (await isMergedPackingListCandidateInTx(tx, await tx.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } }))) return readMergedPackingListVersionInTx(tx, params);
  if (isLegacyMergedPackingListReadCandidate(await tx.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } }))) return readLegacyMergedPackingListVersionInTx(tx, params);
  await currentDocumentActor(tx, params.trustedActor, params.write ? [...scopes, 'customs:write'] : scopes);
  const document = await tx.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } }); assertDocument(document);
  const version = params.version === undefined ? await tx.documentVersion.findFirst({ where: { documentId: params.documentId }, orderBy: { version: 'desc' } })
    : await tx.documentVersion.findUnique({ where: { documentId_version: { documentId: params.documentId, version: params.version } } });
  if (!version) invisible();
  const proved = await proveSelected(tx, document, version);
  const before = await parentAuthority(tx, params.trustedActor, proved.parentIds, params.write);
  const warning = await historicalWarning(tx, document, proved.envelope);
  const finalDoc = await tx.tradeDocument.findFirst({ where: { id: document.id, deletedAt: null } }); assertDocument(finalDoc);
  const finalVersion = await tx.documentVersion.findUnique({ where: { id: version.id } });
  if (!finalVersion || hash(finalVersion) !== hash(version) || hash(documentIdentity(document)) !== hash(documentIdentity(finalDoc))) conflict('原装箱单版本在读取时变化。');
  await proveSelected(tx, finalDoc, finalVersion);
  const finalWarning = await historicalWarning(tx, finalDoc, proved.envelope);
  if (warning.stamp !== finalWarning.stamp || before !== await parentAuthority(tx, params.trustedActor, proved.parentIds, params.write)) conflict('历史装箱单来源或当前范围在读取时变化。');
  return { document: finalDoc, item: json(finalVersion), version: json(finalVersion), protocol: proved.protocol, provenance: proved.provenance,
    envelope: proved.envelope, receipt: proved.receipt, orderIds: proved.parentIds, warnings: warning.warnings,
    authorityStamp: before, fingerprint: hash({ doc: documentIdentity(finalDoc), version: finalVersion, before, warning: warning.stamp }) };
}
export async function readPackingListVersion(prisma: PrismaClient, params: { documentId: string; version: number; trustedActor: TokenPayload | null }) {
  if (!Number.isSafeInteger(params.version) || params.version < 1) throw businessError('INVALID_INPUT', '请选择明确的装箱单版本。');
  return prisma.$transaction(tx => readPackingListVersionInTx(tx, params), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
export async function readPackingListDocument(prisma: PrismaClient, documentId: string, trustedActor: TokenPayload | null, write = false) {
  return prisma.$transaction(tx => readPackingListVersionInTx(tx, { documentId, trustedActor, write }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
export async function listPackingListVersions(prisma: PrismaClient, documentId: string, trustedActor: TokenPayload | null) {
  return prisma.$transaction(async tx => {
    const versions = await tx.documentVersion.findMany({ where: { documentId }, orderBy: { version: 'desc' } });
    const items = [];
    for (const v of versions) items.push(await readPackingListVersionInTx(tx, { documentId, version: v.version, trustedActor }));
    const final = await tx.documentVersion.findMany({ where: { documentId }, orderBy: { version: 'desc' } });
    if (hash(final) !== hash(versions)) conflict('装箱单版本集合在读取时变化。');
    // Re-observe each exact parent set after enumeration; no last-row loophole.
    for (const item of items) { const checked = await readPackingListVersionInTx(tx, { documentId, version: item.version.version, trustedActor });
      if (checked.fingerprint !== item.fingerprint) conflict('装箱单历史集合当前范围在读取时变化。'); }
    return { items: items.map(x => x.item), total: items.length, protocols: items.map(x => ({ version: x.item.version, protocol: x.protocol, provenance: x.provenance, warnings: x.warnings })) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
/** Source locks serialize first registration for one actual Shipment. */
export async function registerPackingListDraft(prisma: PrismaClient, params: { shipmentId: string; trustedActor: TokenPayload | null; actorId: string; expectedShipmentSourceFingerprint?: string }) {
  return prisma.$transaction(async (tx: any) => {
    const actor = await currentDocumentActor(tx, params.trustedActor, [...scopes, 'customs:write']);
    if (actor.userId !== params.actorId) throw businessError('UNAUTHORIZED', '装箱单登记身份不一致。');
    const [lockedSource] = await lockShipmentDocumentSourcesInTx(tx, [params.shipmentId], { trustedActor: params.trustedActor, expectedSourceFingerprint: params.expectedShipmentSourceFingerprint, extraScopes: ['customs:read','customs:write'] });
    const existing = await tx.tradeDocument.findFirst({ where: { shipmentId: params.shipmentId, type: 'PackingList', deletedAt: null } });
    if (existing) { const before = await currentSource(tx, existing, params.trustedActor, true); const after = await currentSource(tx, existing, params.trustedActor, true);
      if (before.fingerprint !== after.fingerprint || hash(before.actor) !== hash(after.actor)) conflict('当前原装箱单来源已变化。'); return { document: existing, created: false }; }
    const ts = BigInt(Date.now()), id = 'TD_PL_' + randomUUID(), commandId = randomUUID();
    const documentNumber = await generateTradeDocumentNumber(tx, 'PackingList');
    const stub = { id, type: 'PackingList', domain: 'customs', status: 'Draft', documentNumber, shipmentId: params.shipmentId, orderId: lockedSource.orderIds.length === 1 ? lockedSource.orderIds[0] : null,
      issueDate: todayLocalKey(), consignee: lockedSource.shipment.consigneeName ?? null, portOfLoading: lockedSource.shipment.portOfLoading ?? null, portOfDischarge: lockedSource.shipment.portOfDischarge ?? null, updatedAt: ts, deletedAt: null };
    const original = await currentSource(tx, stub, params.trustedActor, true);
    const document = await tx.tradeDocument.create({ data: { ...stub, createdAt: ts } });
    const versionId = 'DVER_PL_' + randomUUID(), auditId = 'AUD_PL_REGISTER_' + randomUUID(), versionAuditId = 'AUD_PL_VERSION_' + randomUUID();
    const content = { plDraftProtocol: 2, command: { commandId, actorId: actor.userId, versionId }, packingList: original.envelope };
    const receipt = { protocol: 2, commandId, actorId: actor.userId, documentId: id, documentNumber, shipmentId: params.shipmentId,
      version: 1, versionId, contentHash: hash(content), sourceFingerprint: original.fingerprint, auditIds: [auditId, versionAuditId] };
    await tx.documentVersion.create({ data: { id: versionId, documentId: id, version: 1, content: json(content), changedBy: actor.userId, changeReason: '原运单逐箱来源登记', createdAt: ts } });
    await tx.auditLog.create({ data: { id: versionAuditId, action: 'DOCUMENT_VERSION_CREATE', actorId: actor.userId, targetType: 'DocumentVersion', targetId: versionId,
      transactionId: 'PL-REGISTER:' + commandId, detail: { protocol: 2, documentId: id, version: 1, contentHash: receipt.contentHash, sourceFingerprint: original.fingerprint } } });
    await tx.auditLog.create({ data: { id: auditId, action: 'TRADE_DOCUMENT_CREATE', actorId: actor.userId, targetType: 'TradeDocument', targetId: id,
      transactionId: 'PL-REGISTER:' + commandId, detail: { documentNumber, type: 'PackingList', source: 'generate-from-shipment', shipmentId: params.shipmentId, packingListRegistration: receipt } } });
    const final = await target(tx, id, params.trustedActor, true, true);
    if (final.fingerprint !== original.fingerprint || hash(documentIdentity(final.document)) !== hash(documentIdentity(document))) conflict('装箱单登记时来源已变化。');
    await readPackingListVersionInTx(tx, { documentId: id, version: 1, trustedActor: params.trustedActor, write: true });
    return { document, created: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
/** Metadata callers retain the original status adjacency, but current native
 * all-parent authorization and the exact original status are checked in TX. */
export async function authorizePackingListMetadataInTx(tx: any, id: string, prior: TokenPayload | null) {
  if (await isMergedPackingListCandidateInTx(tx, await tx.tradeDocument.findFirst({ where: { id, deletedAt: null } }))) return authorizeMergedPackingListMetadataInTx(tx, id, prior);
  const initial = await readPackingListVersionInTx(tx, { documentId: id, trustedActor: prior, write: true });
  if (!initial.document.shipmentId) invisible();
  await lockReleaseSources(tx, initial.orderIds);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Shipment" WHERE "id"=${initial.document.shipmentId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${id} FOR UPDATE`);
  const current = await readPackingListVersionInTx(tx, { documentId: id, trustedActor: prior, write: true });
  if (hash(documentIdentity(current.document)) !== hash(documentIdentity(initial.document))) conflict('装箱单状态在取得锁时变化。');
  return current;
}
export async function finishPackingListMetadataInTx(tx: any, prior: TokenPayload | null, original: Awaited<ReturnType<typeof authorizePackingListMetadataInTx>>) {
  if ('kind' in original && original.kind === 'merged') return finishMergedPackingListMetadataInTx(tx, prior, original);
  if (original.authorityStamp !== await parentAuthority(tx, prior, original.orderIds, true)) conflict('装箱单操作期间当前父来源或授权已变化。');
}

async function currentParentAuthority(tx: any, document: any, prior: TokenPayload | null) {
  const [shipment, lines, allocations, physical] = await Promise.all([
    tx.shipment.findUnique({ where: { id: document.shipmentId }, select: { id: true, orderId: true } }),
    tx.shipmentLine.findMany({ where: { shipmentId: document.shipmentId }, select: { id: true, orderLineId: true }, orderBy: { id: 'asc' } }),
    tx.shipmentOrderAllocation.findMany({ where: { shipmentId: document.shipmentId }, select: { id: true, orderId: true, orderLineId: true }, orderBy: { id: 'asc' } }),
    tx.shipmentProductionAllocation.findMany({ where: { shipmentId: document.shipmentId }, select: { id: true, orderId: true, orderLineId: true }, orderBy: { id: 'asc' } }),
  ]);
  const lineIds = [...new Set<string>([...lines,...allocations,...physical].map((x: any) => x.orderLineId).filter((id: any): id is string => typeof id === 'string' && !!id))].sort();
  const originals = lineIds.length ? await tx.orderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, orderId: true }, orderBy: { id: 'asc' } }) : [];
  if (originals.length !== lineIds.length) conflict('当前原订单行来源无法完整核对。');
  const ids = [...new Set<string>([document.orderId,shipment?.orderId,...allocations.map((x: any) => x.orderId),...physical.map((x: any) => x.orderId),...originals.map((x: any) => x.orderId)].filter((id): id is string => typeof id === 'string' && !!id))].sort();
  return hash({ shipment, lines, allocations, physical, originals, authority: await parentAuthority(tx, prior, ids) });
}
/** Unknown ACK recovery is an explicit read of the initiating subject's actual
 * command. Missing means unknown, never permission to invent a replacement. */
export async function readOwnPackingListCommand(prisma: PrismaClient, params: { documentId: string; requestKey: string; trustedActor: TokenPayload | null }) {
  if (await isMergedPackingListCandidateInTx(prisma, await prisma.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } }))) return readOwnMergedPackingListCommand(prisma, params);
  if (!uuid(params.requestKey)) throw businessError('VALIDATION_FAILED', '原装箱单请求键无效。');
  return prisma.$transaction(async tx => {
    const actor = await currentDocumentActor(tx, params.trustedActor, scopes);
    const document = await tx.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } }); assertDocument(document);
    const currentBefore = await currentParentAuthority(tx, document, params.trustedActor);
    const auditId = 'AUD_PL_DRAFT_' + hash({ actorId: actor.userId, documentId: params.documentId, requestKey: params.requestKey });
    const audit = await tx.auditLog.findUnique({ where: { id: auditId } });
    if (!audit || audit.actorId !== actor.userId) invisible();
    const proof = await verifyReceipt(tx, audit, document);
    const history = await readPackingListVersionInTx(tx, { documentId: params.documentId, version: proof.version.version, trustedActor: params.trustedActor });
    const finalDoc = await tx.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } }); assertDocument(finalDoc);
    if (hash(documentIdentity(finalDoc)) !== hash(documentIdentity(document)) || currentBefore !== await currentParentAuthority(tx, finalDoc, params.trustedActor)) conflict('原装箱单命令读取期间当前来源或可见范围已变化。');
    const finalHistory = await readPackingListVersionInTx(tx, { documentId: params.documentId, version: proof.version.version, trustedActor: params.trustedActor });
    if (history.fingerprint !== finalHistory.fingerprint || hash(actor) !== hash(await currentDocumentActor(tx, params.trustedActor, scopes))) conflict('原装箱单命令读取期间当前权限已变化。');
    return { receipt: json(proof.receipt), version: json(proof.version), protocol: 2, provenance: 'native', warnings: finalHistory.warnings };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** File publication/read uses an exact, proved N plus both frozen and current
 * parent sets. This is a read projection; existing Draft commands are unchanged. */
export async function readPackingListArchiveSourceInTx(tx: any, params: { documentId: string; version?: number; trustedActor: TokenPayload | null; write?: boolean }) {
  if (await isMergedPackingListCandidateInTx(tx, await tx.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } }))) return readMergedPackingListArchiveSourceInTx(tx, params);
  if (params.version !== undefined && (!Number.isSafeInteger(params.version) || params.version < 1)) throw businessError('VALIDATION_FAILED', '请选择明确的装箱单版本。');
  const selected = await readPackingListVersionInTx(tx, params);
  if (selected.protocol !== 2 || !selected.envelope || !selected.receipt) conflict('此历史装箱单尚未具备原生版本证明；原内容与文件引用保留待核对。');
  const before = await currentParentAuthority(tx, selected.document, params.trustedActor);
  const final = await readPackingListVersionInTx(tx, { ...params, version: selected.version.version });
  const after = await currentParentAuthority(tx, final.document, params.trustedActor);
  const actor = await currentDocumentActor(tx, params.trustedActor, params.write ? [...scopes, 'customs:write'] : scopes);
  if (before !== after || selected.fingerprint !== final.fingerprint) conflict('原装箱单版本、当前父来源或权限在文件处理时变化。');
  return { ...final, actor, archiveStamp: hash({ selected: final.fingerprint, currentParents: after, actor }) };
}
