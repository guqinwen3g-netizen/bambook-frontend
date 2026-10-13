import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { currentDocumentActor, authorizedDocumentOrders, documentSourceFingerprint } from '../shipping/shipmentDocumentSource';
import { isBusinessShipmentCi, readBusinessShipmentCiVersionInTx } from '../customs/businessShipmentCiSnapshot';
import { readPackingListVersionInTx } from '../customs/shipmentPackingListCommand';
import { readPackingListArchive } from '../customs/packingListArchiveService';
import { assertCiTradeDocumentArchive } from '../customs/tradeDocumentLifecycleService';

const SENT_ACTION = 'BUSINESS_SHIPMENT_DOCUMENT_SENT';
const SENT_PROTOCOL = 1;
const SENT_SOURCE = 'orders:shipment-document-send';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invisible = (): never => { throw businessError('NOT_FOUND', '订单或出运单据不存在或不可查看。'); };
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
const requiredReadScopes = ['orders:read', 'shipments:read', 'customs:read'] as const;

export type ShipmentDocumentSendInput = {
  requestKey: string;
  shipmentId: string;
  documentId: string;
  versionId: string;
  version: number;
  recipient: string;
};

function parseSendInput(value: unknown): ShipmentDocumentSendInput {
  const input: any = value;
  const keys = ['requestKey', 'shipmentId', 'documentId', 'versionId', 'version', 'recipient'];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))
    || typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.length > 128
    || typeof input.shipmentId !== 'string' || !input.shipmentId.trim()
    || typeof input.documentId !== 'string' || !input.documentId.trim()
    || typeof input.versionId !== 'string' || !input.versionId.trim()
    || !Number.isSafeInteger(input.version) || input.version < 1
    || typeof input.recipient !== 'string' || !input.recipient.trim() || input.recipient.trim().length > 254) {
    throw businessError('INVALID_INPUT', '请提供请求键、订单关联出运、单据及当前版本，并填写客户收件人/联系人。');
  }
  return { requestKey: input.requestKey.trim(), shipmentId: input.shipmentId.trim(), documentId: input.documentId.trim(),
    versionId: input.versionId.trim(), version: input.version, recipient: input.recipient.trim() };
}

function auditId(actorId: string, requestKey: string): string {
  return `AUD_OSD_SENT_${hash({ operation: SENT_ACTION, actorId, requestKey })}`;
}

function payloadHash(actorId: string, orderId: string, input: ShipmentDocumentSendInput): string {
  return hash({ operation: SENT_ACTION, protocol: SENT_PROTOCOL, actorId, orderId, ...input });
}

function parseIso(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

type SendReceipt = {
  protocol: 1;
  actorId: string;
  orderId: string;
  shipmentId: string;
  documentId: string;
  documentType: 'CommercialInvoice' | 'PackingList';
  documentNumber: string;
  versionId: string;
  version: number;
  requestKey: string;
  payloadHash: string;
  recipient: string;
  sentAt: string;
};

function receiptFromAudit(audit: any, expected?: { actorId?: string; orderId?: string; input?: ShipmentDocumentSendInput }): SendReceipt {
  const receipt = audit?.detail?.shipmentDocumentSent as SendReceipt | undefined;
  const receiptPayload = receipt && payloadHash(receipt.actorId, receipt.orderId, { requestKey: receipt.requestKey, shipmentId: receipt.shipmentId,
    documentId: receipt.documentId, versionId: receipt.versionId, version: receipt.version, recipient: receipt.recipient });
  if (!receipt || Object.keys(receipt).length !== 13 || Object.keys(audit?.detail ?? {}).length !== 2 || audit?.detail?.source !== SENT_SOURCE
    || audit.action !== SENT_ACTION || audit.targetType !== 'TradeDocument' || audit.targetId !== receipt.documentId
    || receipt.protocol !== SENT_PROTOCOL || !receipt.actorId || audit.actorId !== receipt.actorId
    || !receipt.orderId || !receipt.shipmentId || !receipt.documentId || !['CommercialInvoice', 'PackingList'].includes(receipt.documentType)
    || !receipt.documentNumber || !receipt.versionId || !Number.isSafeInteger(receipt.version) || receipt.version < 1
    || !receipt.requestKey || audit.id !== auditId(receipt.actorId, receipt.requestKey)
    || !/^[a-f0-9]{64}$/.test(receipt.payloadHash) || receipt.payloadHash !== receiptPayload
    || !receipt.recipient || receipt.recipient !== receipt.recipient.trim() || !parseIso(receipt.sentAt)
    || audit.transactionId !== `ORDER-SHIPMENT-DOCUMENT-SENT:${receipt.orderId}:${receipt.requestKey}`
    || expected?.actorId && receipt.actorId !== expected.actorId
    || expected?.orderId && receipt.orderId !== expected.orderId
    || expected?.input && receipt.payloadHash !== payloadHash(receipt.actorId, receipt.orderId, expected.input)) {
    throw conflict('原发送记录或请求键与本次内容不一致，不能覆盖或重建。');
  }
  return receipt;
}

async function requireOrder(tx: any, orderId: string, actor: TokenPayload, write: boolean) {
  const scopes = write ? [...requiredReadScopes, 'orders:write' as const] : requiredReadScopes;
  const fresh = await currentDocumentActor(tx, actor, scopes);
  const [order] = await authorizedDocumentOrders(tx, fresh, [orderId]);
  if (!order) invisible();
  return { actor: fresh, order };
}

async function shipmentForOrder(tx: any, orderId: string, shipmentId: string) {
  const shipment = await tx.shipment.findFirst({ where: { id: shipmentId, deletedAt: null } });
  if (!shipment) invisible();
  if (shipment.orderId === orderId) return shipment;
  const allocation = await tx.shipmentOrderAllocation.findFirst({ where: { shipmentId, orderId, status: { not: 'Cancelled' } } });
  if (!allocation) invisible();
  return shipment;
}

async function documentSource(tx: any, orderId: string, shipment: any, document: any, actor: TokenPayload,
  exact?: { version: number; versionId: string }) {
  if (!document || document.deletedAt != null || document.domain !== 'customs' || document.shipmentId !== shipment.id
    || !['CommercialInvoice', 'PackingList'].includes(document.type) || document.status === 'Cancelled') invisible();
  let selected: any;
  if (document.type === 'CommercialInvoice') {
    if (!isBusinessShipmentCi(document)) invisible();
    selected = await readBusinessShipmentCiVersionInTx(tx, document.id, actor,
      { ...(exact ? { version: exact.version } : {}), requiredScopes: ['customs:read'] });
    if (selected.document.shipmentId !== shipment.id || !selected.snapshot.orderIds.includes(orderId)) invisible();
    if (exact && (selected.version.id !== exact.versionId || selected.version.version !== exact.version)) conflict('所选商业发票版本不是当前订单中的准确版本。');
    return { selected, issued: document.status === 'Issued' && !!selected.snapshot.issuedAt,
      latest: selected.latestVersion, version: selected.version, snapshot: selected.snapshot, orderIds: selected.snapshot.orderIds };
  }
  selected = await readPackingListVersionInTx(tx, { documentId: document.id, ...(exact ? { version: exact.version } : {}), trustedActor: actor });
  const selectedDocument = selected.document ?? document;
  const version = selected.version ?? selected.item;
  const latest = exact ? await tx.documentVersion.findFirst({ where: { documentId: document.id }, orderBy: { version: 'desc' } }) : version;
  if (selectedDocument.shipmentId !== shipment.id || !Array.isArray(selected.orderIds) || !selected.orderIds.includes(orderId)) invisible();
  if (exact && (version.id !== exact.versionId || version.version !== exact.version)) conflict('所选装箱单版本不是当前订单中的准确版本。');
  return { selected, issued: document.status === 'Issued', latest, version, orderIds: selected.orderIds,
    snapshot: selected.envelope ?? selected.item?.content?.packingList ?? selected.item?.content?.documentSet ?? null };
}

async function latestVersion(tx: any, documentId: string) {
  const version = await tx.documentVersion.findFirst({ where: { documentId }, orderBy: { version: 'desc' } });
  if (!version || !Number.isSafeInteger(version.version) || version.version < 1) conflict('单据没有可核验的当前版本。');
  return version;
}

async function archiveState(prisma: any, actor: TokenPayload, doc: any, version: any, issued: boolean): Promise<{ archived: boolean; archiveId: string | null }> {
  if (doc.type === 'CommercialInvoice') {
    if (!issued) return { archived: false, archiveId: null };
    if (!doc.filePath) return { archived: false, archiveId: null };
    await assertCiTradeDocumentArchive(prisma, doc, actor);
    const audits = await prisma.auditLog.findMany({ where: { action: 'TRADE_DOCUMENT_FILE_GENERATED', targetType: 'TradeDocument', targetId: doc.id } });
    const matching = audits.filter((row: any) => row.detail?.filePath === doc.filePath
      && row.detail?.businessCiVersionId === version.id && row.detail?.businessCiVersion === version.version);
    if (matching.length > 1) conflict('商业发票当前版本存在重复归档凭据。');
    return { archived: matching.length === 1, archiveId: matching[0]?.id ?? null };
  }
  const archive = await readPackingListArchive(prisma, { documentId: doc.id, version: version.version, trustedActor: actor, allowMissing: true });
  if (!archive) return { archived: false, archiveId: null };
  if (archive.proof?.documentId !== doc.id || archive.proof?.versionId !== version.id || archive.proof?.version !== version.version) {
    conflict('装箱单归档凭据不属于当前准确版本。');
  }
  return { archived: true, archiveId: archive.proof.auditId };
}

async function verifyArchiveReceiptInTx(tx: any, doc: any, version: any, archived: { archived: boolean; archiveId: string | null }) {
  if (!archived.archived || !archived.archiveId) conflict('当前 CI/PL 版本尚未完成签发和归档，不能记录已发送。');
  const receipt = await tx.auditLog.findUnique({ where: { id: archived.archiveId } });
  if (!receipt || receipt.targetType !== 'TradeDocument' || receipt.targetId !== doc.id) conflict('单据归档凭据已变化，请刷新后重试。');
  if (doc.type === 'CommercialInvoice') {
    if (receipt.action !== 'TRADE_DOCUMENT_FILE_GENERATED' || receipt.detail?.businessCiVersionId !== version.id
      || receipt.detail?.businessCiVersion !== version.version || receipt.detail?.filePath !== doc.filePath) conflict('商业发票归档版本已变化，请刷新后重试。');
  } else {
    const p = receipt.detail?.packingListArchive;
    if (receipt.action !== 'TRADE_DOCUMENT_FILE_GENERATED' || p?.versionId !== version.id || p?.version !== version.version
      || p?.documentId !== doc.id) conflict('装箱单归档版本已变化，请刷新后重试。');
  }
}

async function candidateInTx(tx: any, orderId: string, input: ShipmentDocumentSendInput, prior: TokenPayload, lock = false) {
  const { actor, order } = await requireOrder(tx, orderId, prior, true);
  if (lock) {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Shipment" WHERE "id" = ${input.shipmentId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "TradeDocument" WHERE "id" = ${input.documentId} FOR UPDATE`;
  }
  const shipment = await shipmentForOrder(tx, orderId, input.shipmentId);
  const document = await tx.tradeDocument.findFirst({ where: { id: input.documentId, deletedAt: null } });
  const latest = await latestVersion(tx, input.documentId);
  if (latest.id !== input.versionId || latest.version !== input.version) conflict('CI/PL 已更新；请刷新并发送当前最新版本。');
  const source = await documentSource(tx, orderId, shipment, document, actor, { version: input.version, versionId: input.versionId });
  if (source.version.id !== latest.id || source.version.version !== latest.version) conflict('单据来源版本与最新版本不一致。');
  if (document.type === 'CommercialInvoice' && !source.issued) conflict('商业发票尚未签发，不能记录已发送。');
  return { actor, order, shipment, document, latest, source };
}

function eventDto(audit: any, receipt = receiptFromAudit(audit)) {
  // Send history is shared at the TradeDocument + version level across every
  // source order. Keep the originating order and idempotency material in the
  // immutable audit receipt, but do not expose another source order's id when
  // a user is reading this shared event from a different authorized order.
  return { eventId: audit.id, actorId: receipt.actorId, shipmentId: receipt.shipmentId, documentId: receipt.documentId,
    documentType: receipt.documentType, documentNumber: receipt.documentNumber, versionId: receipt.versionId,
    version: receipt.version, recipient: receipt.recipient, sentAt: receipt.sentAt };
}

/** Server-side departure gate: every current business CI and Packing List on
 * this shipment must already have an immutable business-send receipt for that
 * exact current document version. Reuse the existing send audit; do not create
 * a second shipment-document history. */
export async function assertCurrentShipmentDocumentsSentInTx(tx: any, shipmentId: string): Promise<void> {
  const documents = await tx.tradeDocument.findMany({ where: { shipmentId, deletedAt: null, domain: 'customs',
    type: { in: ['CommercialInvoice', 'PackingList'] }, status: 'Issued' }, orderBy: [{ id: 'asc' }] });
  const candidates = documents.filter((doc: any) => doc.type === 'PackingList' || isBusinessShipmentCi(doc));
  if (!candidates.some((doc: any) => doc.type === 'CommercialInvoice') || !candidates.some((doc: any) => doc.type === 'PackingList'))
    conflict('当前已签发 CI 和 Packing List 尚未齐全，不能确认实际出运。');
  const audits = await tx.auditLog.findMany({ where: { action: SENT_ACTION, targetType: 'TradeDocument',
    targetId: { in: candidates.map((doc: any) => doc.id) } }, orderBy: { createdAt: 'asc' } });
  for (const doc of candidates) {
    const latest = await latestVersion(tx, doc.id);
    const sentCurrent = audits.some((audit: any) => {
      if (audit.targetId !== doc.id) return false;
      try {
        const receipt = receiptFromAudit(audit);
        return receipt.shipmentId === shipmentId && receipt.documentId === doc.id
          && receipt.documentType === doc.type && receipt.versionId === latest.id && receipt.version === latest.version;
      } catch { return false; }
    });
    if (!sentCurrent) conflict(`当前 ${doc.type === 'CommercialInvoice' ? 'CI' : 'Packing List'} 版本尚未由业务登记发送给客户。`);
  }
}

async function replayFrom(prisma: any, actorId: string, orderId: string, input: ShipmentDocumentSendInput) {
  const existing = await prisma.auditLog.findUnique({ where: { id: auditId(actorId, input.requestKey) } });
  if (!existing) return null;
  const receipt = receiptFromAudit(existing, { actorId, orderId, input });
  return { event: eventDto(existing, receipt), replayed: true };
}

export async function listOrderShipmentDocuments(prisma: PrismaClient, orderId: string, prior: TokenPayload | null) {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '需要当前登录身份查看订单单据。');
  const read = async (tx: any) => {
    const { actor, order } = await requireOrder(tx, orderId, prior, false);
    const [allocations, directShipments] = await Promise.all([
      tx.shipmentOrderAllocation.findMany({ where: { orderId }, select: { shipmentId: true }, orderBy: { shipmentId: 'asc' } }),
      tx.shipment.findMany({ where: { orderId, deletedAt: null }, select: { id: true } }),
    ]);
    const shipmentIds = [...new Set<string>([...allocations.map((row: any) => row.shipmentId), ...directShipments.map((row: any) => row.id)])].sort();
    if (!shipmentIds.length) {
      const finalActor = await currentDocumentActor(tx, prior, requiredReadScopes);
      if (documentSourceFingerprint(finalActor) !== documentSourceFingerprint(actor)) conflict('订单权限在读取期间变化。');
      return { actor, order, shipments: [], documents: [], audits: [] };
    }
    const shipments = await tx.shipment.findMany({ where: { id: { in: shipmentIds }, deletedAt: null }, orderBy: { shipmentNumber: 'asc' } });
    const documents = await tx.tradeDocument.findMany({ where: { shipmentId: { in: shipmentIds }, deletedAt: null,
      domain: 'customs', type: { in: ['CommercialInvoice', 'PackingList'] } }, orderBy: [{ shipmentId: 'asc' }, { createdAt: 'asc' }] });
    const eligibleDocuments = documents.filter((doc: any) => doc.type === 'PackingList' || isBusinessShipmentCi(doc));
    const audits = eligibleDocuments.length ? await tx.auditLog.findMany({ where: { action: SENT_ACTION, targetType: 'TradeDocument', targetId: { in: eligibleDocuments.map((doc: any) => doc.id) } }, orderBy: { createdAt: 'asc' } }) : [];
    const items = [];
    for (const document of eligibleDocuments) {
      const shipment = shipments.find((row: any) => row.id === document.shipmentId);
      if (!shipment) continue;
      // A document in a shipment with several orders is visible only when its frozen source contains this exact order.
      const latest = await latestVersion(tx, document.id);
      let source: any;
      try { source = await documentSource(tx, orderId, shipment, document, actor); }
      catch (error: any) { if (error?.code === 'NOT_FOUND') continue; throw error; }
      if (source.latest?.id && source.latest.id !== latest.id) conflict('单据版本集合在读取时变化，请刷新。');
      const docAudits = audits.filter((audit: any) => audit.targetId === document.id);
      const history = [];
      for (const audit of docAudits) {
        const receipt = receiptFromAudit(audit);
        if (receipt.shipmentId !== shipment.id || receipt.documentId !== document.id || receipt.documentType !== document.type
          || receipt.documentNumber !== document.documentNumber || !source.orderIds?.includes(receipt.orderId)) conflict('发送记录与当前单据归属不一致。');
        const eventVersion = await tx.documentVersion.findUnique({ where: { id: receipt.versionId } });
        if (!eventVersion || eventVersion.documentId !== document.id || eventVersion.version !== receipt.version) conflict('发送记录引用了失效单据版本。');
        history.push(eventDto(audit, receipt));
      }
      items.push({ shipment: { id: shipment.id, shipmentNumber: shipment.shipmentNumber, status: shipment.status },
        document: { id: document.id, type: document.type, documentNumber: document.documentNumber, status: document.status },
        latestVersion: { id: latest.id, version: latest.version, issued: source.issued },
        _archiveCheck: { document, version: latest, issued: source.issued }, currentSent: history.some((event: any) => event.versionId === latest.id), sendHistory: history });
    }
    const finalActor = await currentDocumentActor(tx, prior, requiredReadScopes);
    if (documentSourceFingerprint(finalActor) !== documentSourceFingerprint(actor)) conflict('订单或单据权限在读取期间变化。');
    return { actor, order, shipments, documents: items, audits };
  };
  const selected = await prisma.$transaction(read, { isolationLevel: 'ReadCommitted' });
  const documents = [];
  for (const item of selected.documents) {
    const archive = await archiveState(prisma, selected.actor, item._archiveCheck.document, item._archiveCheck.version, item._archiveCheck.issued);
    const { _archiveCheck, ...publicItem } = item;
    const archived = archive.archived;
    documents.push({ ...publicItem, latestVersion: { ...publicItem.latestVersion, archived,
      eligible: archived && (publicItem.document.type !== 'CommercialInvoice' || publicItem.latestVersion.issued) },
      currentSent: publicItem.currentSent && archived });
  }
  return { orderId, documents };
}

export async function recordOrderShipmentDocumentSent(prisma: PrismaClient, orderId: string, prior: TokenPayload | null, rawInput: unknown): Promise<{ event: any; replayed: boolean }> {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '需要当前登录身份记录客户发送。');
  const input = parseSendInput(rawInput);
  const existing = await prisma.$transaction(async tx => {
    await requireOrder(tx, orderId, prior, true);
    return tx.auditLog.findUnique({ where: { id: auditId(prior.userId!, input.requestKey) } });
  });
  if (existing) {
    const { actor } = await prisma.$transaction(tx => requireOrder(tx, orderId, prior, true));
    const replay = await replayFrom(prisma, actor.userId, orderId, input);
    if (!replay) conflict('原请求回执暂不可读取，请使用原请求键重试。');
    return replay!;
  }

  const first = await prisma.$transaction(tx => candidateInTx(tx, orderId, input, prior), { isolationLevel: 'ReadCommitted' });
  const firstArchive = await archiveState(prisma, first.actor, first.document, first.latest, first.source.issued);
  if (!firstArchive.archived) conflict('当前 CI/PL 版本尚未完成归档，不能记录已发送。');

  try {
    return await prisma.$transaction(async tx => {
      const current = await candidateInTx(tx, orderId, input, prior, true);
      if (documentSourceFingerprint({ document: current.document, version: current.latest, source: current.source.selected })
        !== documentSourceFingerprint({ document: first.document, version: first.latest, source: first.source.selected })) conflict('单据或订单来源在发送登记期间变化，请刷新后重试。');
      await verifyArchiveReceiptInTx(tx, current.document, current.latest, firstArchive);
      const id = auditId(current.actor.userId, input.requestKey);
      const already = await tx.auditLog.findUnique({ where: { id } });
      if (already) {
        const receipt = receiptFromAudit(already, { actorId: current.actor.userId, orderId, input });
        return { event: eventDto(already, receipt), replayed: true };
      }
      const sentAt = new Date().toISOString();
      const receipt: SendReceipt = { protocol: SENT_PROTOCOL, actorId: current.actor.userId, orderId, shipmentId: current.shipment.id,
        documentId: current.document.id, documentType: current.document.type, documentNumber: current.document.documentNumber,
        versionId: current.latest.id, version: current.latest.version, requestKey: input.requestKey,
        payloadHash: payloadHash(current.actor.userId, orderId, input), recipient: input.recipient, sentAt };
      const audit = await tx.auditLog.create({ data: { id, actorId: current.actor.userId, action: SENT_ACTION,
        targetType: 'TradeDocument', targetId: current.document.id, transactionId: `ORDER-SHIPMENT-DOCUMENT-SENT:${orderId}:${input.requestKey}`,
        operationType: 'create', detail: { source: SENT_SOURCE, shipmentDocumentSent: receipt }, createdAt: new Date(sentAt) } });
      const finalActor = await currentDocumentActor(tx, prior, [...requiredReadScopes, 'orders:write']);
      if (documentSourceFingerprint(finalActor) !== documentSourceFingerprint(current.actor)) conflict('订单权限在保存发送记录时变化，请重试。');
      return { event: eventDto(audit, receipt), replayed: false };
    }, { isolationLevel: 'Serializable' });
  } catch (error: any) {
    if (error?.code === 'P2002' || error?.code === 'P2034') {
      const replay = await replayFrom(prisma, prior.userId, orderId, input);
      if (replay) return replay;
    }
    throw error;
  }
}
