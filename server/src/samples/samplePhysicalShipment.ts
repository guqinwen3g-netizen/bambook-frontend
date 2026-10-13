/** Business shipment and physical custody share the caller's transaction. */
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { authorizeSampleCustody, lockSampleCustodyGraph, assertSampleCustodyGuardStable, type SampleCustodyGuard } from './sampleCustodyAuthorization';
import { isMeterCard } from './sampleMeterStock';

export interface PhysicalShipmentInput { itemId: string; quantity: number | string; recipientName: string; relationId?: string }
export class PhysicalShipmentError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); }
}
const reject = (code: string, message: string, status = 409): never => { throw new PhysicalShipmentError(code, message, status); };

/** Parents/source must be locked and verified by the caller before invoking this
 * helper. Business request replay must run first. A deterministic loan identity
 * additionally prevents accidental duplicate inventory writes. */
export async function shipPhysicalSampleInTransaction(tx: any, actor: TokenPayload, input: PhysicalShipmentInput,
  context: { source: { sampleId?: string; devCaseId?: string; batchId?: string }; eventId: string; occurredAt?: number;
    expectedGuard?: SampleCustodyGuard; assertSource?: (item: any) => void | Promise<void> }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['itemId', 'quantity', 'recipientName', 'relationId'].includes(key))
    || typeof input.itemId !== 'string' || !input.itemId.trim() || input.itemId.trim() !== input.itemId || input.itemId.length > 200
    || typeof input.quantity !== 'number' && typeof input.quantity !== 'string' || !Number.isFinite(Number(input.quantity)) || Number(input.quantity) <= 0 || Number(input.quantity) > 2147483647
    || typeof input.recipientName !== 'string' || !input.recipientName.trim() || input.recipientName.length > 200
    || input.relationId !== undefined && (typeof input.relationId !== 'string' || !input.relationId.trim() || input.relationId.trim() !== input.relationId))
    reject('INVALID_INPUT', '请明确寄出的实物、正数量和收件人。', 400);
  if (!context.eventId || !Object.values(context.source).some(Boolean)) reject('INVALID_INPUT', '寄样必须绑定准确业务来源和操作编号。', 400);
  const before = await authorizeSampleCustody({ db: tx, actor, subject: { kind: 'card', id: input.itemId }, mode: 'write' });
  if (context.expectedGuard) assertSampleCustodyGuardStable(context.expectedGuard, before.guard);
  if (input.relationId && !before.lockRefs.some(ref => ref.kind === 'relation' && ref.id === input.relationId))
    reject('PHYSICAL_SOURCE_MISMATCH', '收件客户须属于当前样品业务来源。');
  await lockSampleCustodyGraph(tx, before);
  const after = await authorizeSampleCustody({ db: tx, actor, subject: { kind: 'card', id: input.itemId }, mode: 'write' });
  assertSampleCustodyGuardStable(before.guard, after.guard);
  const item = await tx.sampleCardItem.findFirst({ where: { id: input.itemId, deletedAt: null } });
  if (!item) reject('NOT_FOUND', '所选实物不存在或不可见。', 404);
  for (const [key, value] of Object.entries(context.source)) if (value && item[key] !== value)
    reject('PHYSICAL_SOURCE_MISMATCH', '所选实物与本次寄样业务来源不一致。');
  await context.assertSource?.(item);
  if (item.sealedStatus === 'sealed') reject('SEALED_SAMPLE_SHIP_FORBIDDEN', '封样留存件不能寄出，请选择可寄实物。');
  if (item.status === 'retired' || item.status === 'shipped') reject('ITEM_UNAVAILABLE', '该实物已退役或全部寄出。');
  if (isMeterCard(item)) {
    const raw = String(input.quantity);
    if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(raw)) reject('INVALID_INPUT', '米样寄出数量最多 4 位小数。', 400);
    if (item.physicalLengthQty == null || item.availableLengthQty == null) reject('PHYSICAL_STOCK_CONFLICT', '米样长度账缺失或不一致，请先核对原实物。');
    const parsedLengths = (() => {
      try {
        return [new Prisma.Decimal(String(item.physicalLengthQty)), new Prisma.Decimal(String(item.availableLengthQty))] as const;
      } catch {
        return null;
      }
    })();
    if (parsedLengths === null) throw new PhysicalShipmentError('PHYSICAL_STOCK_CONFLICT', '米样长度账缺失或不一致，请先核对原实物。');
    const [totalDecimal, availableDecimal] = parsedLengths;
    const loans = await tx.sampleCardLoan.findMany({ where: { itemId: item.id, loanType: 'borrow', returnedAt: null }, select: { loanQuantity: true, loanLength: true, returnedLengthQty: true } });
    let outstanding = new Prisma.Decimal(0);
    for (const loan of loans) {
      if (loan.loanLength == null || Number(loan.loanQuantity) !== 0) reject('PHYSICAL_STOCK_CONFLICT', '米样存在无法核对的借用流水，请先核对原实物。');
      const original = new Prisma.Decimal(String(loan.loanLength));
      const returned = new Prisma.Decimal(String(loan.returnedLengthQty ?? '0'));
      if (!original.isFinite() || original.lte(0) || !returned.isFinite() || returned.lt(0) || returned.gt(original)) reject('PHYSICAL_STOCK_CONFLICT', '米样借出长度账不合法，请先核对原实物。');
      outstanding = outstanding.plus(original.minus(returned));
    }
    if (!totalDecimal.isFinite() || !availableDecimal.isFinite() || totalDecimal.lt(0) || availableDecimal.lt(0)
      || !totalDecimal.eq(availableDecimal.plus(outstanding))) reject('PHYSICAL_STOCK_CONFLICT', '总米数、可用米数与未还米数不一致，请先核对原实物。');
    const decimal = new Prisma.Decimal(raw);
    if (availableDecimal.lt(decimal)) reject('INSUFFICIENT_QTY', `可用长度不足（剩余 ${availableDecimal.toString()} 米，寄出 ${input.quantity} 米）。`);
    const occurredAt = context.occurredAt ?? Date.now();
    const loanId = `SCLSHIP_${createHash('sha256').update(context.eventId).digest('hex')}`;
    if (await tx.sampleCardLoan.findUnique({ where: { id: loanId } })) reject('PHYSICAL_SHIPMENT_ALREADY_RECORDED', '本次实物寄出已有记录，请读取原业务回执。');
    const remainingAvailable = availableDecimal.minus(decimal), remainingTotal = totalDecimal.minus(decimal);
    await tx.sampleCardLoan.create({ data: { id: loanId, itemId: item.id, loanType: 'ship', loanQuantity: 0, loanLength: raw,
      borrowerName: input.recipientName.trim(), borrowerUserId: null, relationId: input.relationId ?? null, relationName: null,
      loanedAt: occurredAt, returnedAt: occurredAt, dueAt: null, operatorId: after.actor.userId, createdAt: occurredAt } });
    await tx.sampleCardItem.update({ where: { id: item.id }, data: { physicalLengthQty: remainingTotal.toString(), availableLengthQty: remainingAvailable.toString(),
      quantity: remainingTotal.isZero() ? 0 : item.quantity, availableQty: remainingAvailable.isZero() ? 0 : item.availableQty,
      status: remainingTotal.isZero() && outstanding.isZero() ? 'shipped' : remainingAvailable.isZero() ? 'borrowed' : 'in_stock', updatedAt: occurredAt } });
    const result = { itemId: item.id, loanId, quantity: input.quantity, unit: '米', quantityAfter: remainingTotal.toString(), availableAfter: remainingAvailable.toString(), archived: remainingTotal.isZero() && outstanding.isZero(), eventId: context.eventId };
    await writeRouteAuditLog({ prisma: tx, actorId: after.actor.userId, source: 'business:physical-shipment',
      operation: 'sample_card_ship', targetType: 'SampleCardItem', targetId: item.id,
      before: { physicalLengthQty: String(item.physicalLengthQty), availableLengthQty: String(item.availableLengthQty) },
      after: { ...result, recipientName: input.recipientName.trim(), relationId: input.relationId ?? null, source: context.source }, operationType: 'link' });
    return result;
  }
  const countQuantity = Number(input.quantity);
  if (!Number.isSafeInteger(countQuantity)) reject('INVALID_INPUT', '件数实物寄出数量须为正整数。', 400);
  const loans = await tx.sampleCardLoan.findMany({ where: { itemId: item.id, loanType: 'borrow', returnedAt: null }, select: { loanQuantity: true } });
  const borrowed = loans.reduce((sum: number, loan: any) => sum + Number(loan.loanQuantity), 0);
  if (!Number.isSafeInteger(item.quantity) || !Number.isSafeInteger(item.availableQty) || !Number.isSafeInteger(borrowed)
    || item.quantity !== item.availableQty + borrowed) reject('PHYSICAL_STOCK_CONFLICT', '实物数量与借用记录不一致，系统不提供盘点修正；请线下核对后再登记。');
  if (item.availableQty < countQuantity) reject('INSUFFICIENT_QTY', '可用实物数量不足，不能确认寄出。');
  const loanId = `SCLSHIP_${createHash('sha256').update(context.eventId).digest('hex')}`;
  if (await tx.sampleCardLoan.findUnique({ where: { id: loanId } })) reject('PHYSICAL_SHIPMENT_ALREADY_RECORDED', '本次实物寄出已有记录，请读取原业务回执。');
  const occurredAt = context.occurredAt ?? Date.now();
  await tx.sampleCardLoan.create({ data: { id: loanId, itemId: item.id, loanType: 'ship', loanQuantity: countQuantity,
    borrowerName: input.recipientName.trim(), borrowerUserId: null, relationId: input.relationId ?? null, relationName: null,
    loanedAt: occurredAt, returnedAt: occurredAt, dueAt: null, operatorId: after.actor.userId, createdAt: occurredAt } });
  const quantityAfter = item.quantity - countQuantity, availableAfter = item.availableQty - countQuantity;
  const archived = quantityAfter === 0 && borrowed === 0;
  await tx.sampleCardItem.update({ where: { id: item.id }, data: { quantity: quantityAfter, availableQty: availableAfter,
    status: archived ? 'shipped' : availableAfter === 0 ? 'borrowed' : 'in_stock', updatedAt: occurredAt } });
  const result = { itemId: item.id, loanId, quantity: countQuantity, quantityAfter, availableAfter, archived, eventId: context.eventId };
  await writeRouteAuditLog({ prisma: tx, actorId: after.actor.userId, source: 'business:physical-shipment',
    operation: 'sample_card_ship', targetType: 'SampleCardItem', targetId: item.id,
    before: { quantity: item.quantity, availableQty: item.availableQty },
    after: { ...result, recipientName: input.recipientName.trim(), relationId: input.relationId ?? null, source: context.source }, operationType: 'link' });
  return result;
}
