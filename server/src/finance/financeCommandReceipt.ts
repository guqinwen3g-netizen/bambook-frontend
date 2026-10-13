import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { ciHash, ciJson } from '../development/developmentCiSource';
import { businessError } from '../shared/errorCodes';

export type FinanceCommandReceipt = { protocolVersion: 1; actorId: string; kind: string; requestKey: string;
  commandHash: string; auditId: string; targetId: string | null; resultHash: string; resultSnapshot: any };

/** Rehydrate only known entity scalar types, so the original and replayed
 * command have the same API contract without losing Decimal precision. */
function restoreReceipt(value: any) {
  const result = { ...value };
  for (const name of ['voucher', 'invoice', 'vatInvoice']) if (result[name]) {
    const row = { ...result[name] };
    for (const field of ['createdAt', 'updatedAt', 'deletedAt'])
      if (typeof row[field] === 'string' && /^-?\d+$/.test(row[field])) row[field] = BigInt(row[field]);
    for (const field of ['amount','bankFee','exchangeRate','appliedAmount','netAmount','taxRate','taxAmount','totalAmount'])
      if (row[field] != null) row[field] = new Prisma.Decimal(row[field]);
    result[name] = row;
  }
  if (result.paymentRequest) {
    const row = { ...result.paymentRequest };
    // PaymentRequest uses DateTime, unlike the financial entities' bigint
    // millisecond fields above. Preserve its native service contract.
    for (const field of ['createdAt', 'updatedAt', 'deletedAt'])
      if (typeof row[field] === 'string') row[field] = new Date(row[field]);
    if (row.totalAmount != null) row.totalAmount = new Prisma.Decimal(row.totalAmount);
    result.paymentRequest = row;
  }
  return result;
}

/** An existing unique audit identity is the receipt until the cash-account
 * ledger is introduced. The advisory lock serializes this exact user intent. */
export async function beginFinanceCommand(tx: any, actor: TokenPayload, kind: string, input: any) {
  const requestKey = input?.requestKey;
  if (typeof requestKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestKey))
    throw businessError('INVALID_INPUT', '请保留本次财务操作的 UUID 原请求键，并在结果未知时重试原请求。');
  const id = `finance_command_${ciHash({ actorId: actor.userId, kind, requestKey })}`;
  const commandHash = ciHash({ kind, input });
  const acknowledged = (value: any) => {
    if (typeof value?.auditId !== 'string') return value;
    const {financeCommand: _priorMetadata, ...nativeResult} = value;
    const resultSnapshot = ciJson(nativeResult);
    const targetId = value.voucher?.id ?? value.invoice?.id ?? value.vatInvoice?.id ?? value.paymentRequest?.id
      ?? input.targetId ?? input.voucherId ?? input.vatInvoiceId ?? null;
    const financeCommand: FinanceCommandReceipt = { protocolVersion: 1, actorId: actor.userId, kind, requestKey, commandHash,
      auditId: value.auditId, targetId, resultSnapshot, resultHash:ciHash(resultSnapshot) };
    return { ...nativeResult, financeCommand };
  };
  // PostgreSQL's advisory function returns void. Prisma cannot deserialize
  // void result columns, even though the lock itself has succeeded.
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text AS "lock"`);
  const prior = await tx.auditLog.findUnique({ where: { id } });
  if (prior) {
    if (prior.actorId !== actor.userId || prior.action !== 'finance_command_committed' || prior.detail?.commandHash !== commandHash)
      throw businessError('CONFLICT', '该原请求键已绑定另一项财务操作，请核对原结果。');
    return { replayed: true as const, receipt: restoreReceipt(acknowledged(prior.detail.receipt)), commit: async (_value: any) => { throw businessError('CONFLICT', '原请求已经完成。'); } };
  }
  return { replayed: false as const, receipt: undefined, commit: async (value: any) => {
    const receipt = ciJson(acknowledged(value));
    await tx.auditLog.create({ data: { id, actorId: actor.userId, action: 'finance_command_committed',
      targetType: 'FinanceCommand', targetId: kind, transactionId: requestKey,
      detail: { protocolVersion: 1, kind, requestKey, commandHash, receipt } } });
    return restoreReceipt(receipt);
  } };
}

export function assertFinanceRevision(row: any, expected: unknown) {
  if (typeof expected !== 'string' || !/^(?:0|[1-9]\d*)$/.test(expected) || String(row.updatedAt) !== expected)
    throw businessError('CONFLICT', '财务记录已变化，请刷新当前版本并核对后再提交。');
}
