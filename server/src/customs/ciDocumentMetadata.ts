/** CI metadata never owns Invoice cancellation, numbers or financial facts.
 * Native linked history is authorized under current account/grants/ceilings
 * and every original/current parent Order L2. The caller owns the one write TX. */
import { Prisma, PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { currentDocumentActor, documentSourceFingerprint } from '../shipping/shipmentDocumentSource';
import { FINAL_CI_INVOICE_STATUSES, readHistoricalCiDocumentInTx, type HistoricalCiDocumentSource } from './ciInvoiceSource';

export interface CiDocumentMetadataOptions { trustedActor: TokenPayload | null; trustedAuthSource: string | undefined; }
function identity(actorId: string, options: CiDocumentMetadataOptions | undefined): TokenPayload {
  if (options?.trustedAuthSource !== 'user-session' || !options.trustedActor?.userId || options.trustedActor.userId !== actorId)
    throw businessError('UNAUTHORIZED', '商业发票操作需要当前可信登录身份。');
  return options.trustedActor;
}

async function history(tx: any, id: string, actorId: string, options: CiDocumentMetadataOptions | undefined) {
  const trustedActor = identity(actorId, options);
  await currentDocumentActor(tx, trustedActor, ['customs:write']);
  const source = await readHistoricalCiDocumentInTx(tx, id, { trustedActor });
  await currentDocumentActor(tx, trustedActor, ['customs:write']);
  return source;
}

async function lockHistory(tx: any, id: string, actorId: string, options: CiDocumentMetadataOptions | undefined) {
  const before = await history(tx, id, actorId, options);
  // Metadata holds no Order/Shipment/Batch locks. Invoice -> TD is the suffix
  // of canonical Source -> Order -> ... -> Invoice -> TD, with no reverse edge.
  if (before.currentInvoice)
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "id"=${before.currentInvoice.id} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${id} FOR UPDATE`);
  const locked = await history(tx, id, actorId, options);
  if (locked.fingerprint !== before.fingerprint)
    throw businessError('CONFLICT', '原商业发票记录在取得锁时变化，请刷新后重试。');
  return locked;
}

/** Linked/native CI is the permanent canonical record. Removing this record
 * would make the original Invoice unusable without forging a replacement. */
export async function assertCiDocumentMetadataDelete(prisma: PrismaClient, id: string, actorId: string, options: CiDocumentMetadataOptions | undefined) {
  return prisma.$transaction(async tx => {
    const source = await lockHistory(tx, id, actorId, options);
    if (source.currentInvoice || source.document.sourceInvoiceId || source.document.sourceRef?.startsWith('invoice:')
      || source.originalVersion.content?.ciSourceProtocol || source.originalVersion.content?.ciSource)
      throw businessError('CONFLICT', '商业发票保留原财务来源及历史凭据，不能删除；请使用原单据允许的取消流程。');
    // Unlinked genuine legacy history retains its original delete lifecycle.
    // Native missing links/proofs have already failed the original history gate.
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }).catch(error => {
    if (isBusinessError(error)) throw error;
    throw businessError('INTERNAL_ERROR', '商业发票权限及历史凭据暂时无法核验，请刷新后重试。');
  });
}

function sourceStatus(source: HistoricalCiDocumentSource, toStatus: string) {
  const invoice = source.currentInvoice;
  if (invoice?.status === 'Cancelled' && toStatus !== 'Cancelled')
    throw businessError('CONFLICT', '原财务发票已取消，只能按原状态规则取消本单据。');
  if (['Issued', 'Submitted', 'Accepted'].includes(toStatus)
    && (!invoice || !(FINAL_CI_INVOICE_STATUSES as readonly string[]).includes(invoice.status)))
    throw businessError('CONFLICT', '正式商业发票状态需要原财务应收票已正式签发。');
}

/** Must execute inside the original metadata mutation's TX before its update. */
export async function authorizeCiDocumentMetadataTransitionInTx(tx: any, existing: any, toStatus: string,
  actorId: string, options: CiDocumentMetadataOptions | undefined) {
  const source = await lockHistory(tx, existing.id, actorId, options);
  if (documentSourceFingerprint(source.document) !== documentSourceFingerprint(existing))
    throw businessError('CONFLICT', '原商业发票元数据已变化，请刷新后重试。');
  sourceStatus(source, toStatus);
}

/** Runs after the original final mandatory audit INSERT, in the same TX.
 * Withdrawal/cancellation/proof failure therefore rolls back status AND audit. */
export async function finishCiDocumentMetadataTransitionInTx(tx: any, id: string, toStatus: string,
  actorId: string, options: CiDocumentMetadataOptions | undefined) {
  const source = await history(tx, id, actorId, options);
  if (source.document.status !== toStatus) throw businessError('CONFLICT', '商业发票状态在更新时变化，请刷新后重试。');
  sourceStatus(source, toStatus);
  await currentDocumentActor(tx, identity(actorId, options), ['customs:write']);
}
