/** Read and authorize immutable versions of the logistics-owned shipment CI. */
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { authorizedDocumentOrders, currentDocumentActor, documentSourceFingerprint, documentSourceJson } from '../shipping/shipmentDocumentSource';

export const BUSINESS_SHIPMENT_CI_PREFIX = 'business-ci:v1:shipment:';

export function isBusinessShipmentCi(doc: { type?: string; sourceRef?: string | null; sourceInvoiceId?: string | null } | null | undefined): boolean {
  return doc?.type === 'CommercialInvoice' && doc.sourceInvoiceId == null && doc.sourceRef?.startsWith(BUSINESS_SHIPMENT_CI_PREFIX) === true;
}

export async function readBusinessShipmentCiVersionInTx(tx: any, documentId: string, actor: TokenPayload | null | undefined,
  options: { version?: number; requiredScopes?: readonly any[] } = {}) {
  const actual = await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
  if (!isBusinessShipmentCi(actual) || actual.domain !== 'customs' || !actual.shipmentId) {
    throw businessError('NOT_FOUND', '业务商业发票不存在或不可查看。');
  }
  const latest = await tx.documentVersion.findFirst({ where: { documentId }, orderBy: { version: 'desc' } });
  const version = options.version === undefined ? latest : await tx.documentVersion.findFirst({ where: { documentId, version: options.version } });
  if (!latest || !version) throw businessError('CONFLICT', '商业发票版本不存在，不能重建历史。');
  const snapshot = version.content?.commercialInvoiceSnapshot;
  if (!snapshot || snapshot.protocolVersion !== 1 || snapshot.sourceKind !== 'shipment'
    || snapshot.shipmentId !== actual.shipmentId || !Array.isArray(snapshot.orderIds) || !Array.isArray(snapshot.lines)
    || !snapshot.lines.length || snapshot.lines.some((line: any) => !snapshot.orderIds.includes(line.orderId))) {
    throw businessError('CONFLICT', '商业发票的不可变来源快照缺失或与原出运不一致。');
  }
  if (actual.status === 'Issued' && !snapshot.issuedAt && version.version === latest.version) {
    throw businessError('CONFLICT', '已签发商业发票缺少签发版本凭据。');
  }
  if (actual.status !== 'Issued' && snapshot.issuedAt) throw businessError('CONFLICT', '草稿单据含有已签发版本凭据。');
  const scopes = [...(options.requiredScopes ?? []), 'shipments:read', 'orders:read'];
  const authorized = await currentDocumentActor(tx, actor, scopes);
  await authorizedDocumentOrders(tx, authorized, snapshot.orderIds);
  const finalDoc = await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
  const finalVersion = await tx.documentVersion.findFirst({ where: { documentId, version: version.version } });
  if (!finalDoc || documentSourceFingerprint(finalDoc) !== documentSourceFingerprint(actual)
    || !finalVersion || documentSourceFingerprint(finalVersion) !== documentSourceFingerprint(version)) {
    throw businessError('CONFLICT', '商业发票或选定版本在读取过程中发生变化，请重新读取。');
  }
  await currentDocumentActor(tx, actor, scopes);
  return { document: documentSourceJson(actual), version: documentSourceJson(version), latestVersion: documentSourceJson(latest),
    snapshot: documentSourceJson(snapshot), fingerprint: documentSourceFingerprint({ document: actual, version, snapshot }) };
}

export async function readBusinessShipmentCiVersion(prisma: any, documentId: string, actor: TokenPayload | null | undefined,
  options: { version?: number; requiredScopes?: readonly any[] } = {}) {
  return prisma.$transaction((tx: any) => readBusinessShipmentCiVersionInTx(tx, documentId, actor, options), { isolationLevel: 'ReadCommitted' });
}
