import { businessError } from '../../shared/errorCodes';

declare const trustedAutomation: unique symbol;
export type ShipmentInvoiceAutomationSource = Readonly<{
  eventId: string; shipmentId: string; auditId: string; triggerActorId: string;
  [trustedAutomation]: true;
}>;
const transactions = new WeakMap<object, object>();
const validId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 1024 && value.trim() === value;
const refusal = (): never => { throw businessError('CONFLICT', '自动开票缺少可核验的原交付事件，请核对原发货记录。'); };

/** An internal selector is not authority. Only this persisted event paired
 * with its actual native transition can mint a non-serializable, tx-bound source.
 * The triggering shipper need not borrow a human Finance permission. */
export async function authenticateShipmentInvoiceAutomation(tx: any, eventId: string): Promise<ShipmentInvoiceAutomationSource> {
  if (!validId(eventId)) return refusal();
  const job = await tx.agentJob.findUnique({ where: { id: eventId } });
  const event = job?.payload;
  if (!job || job.id !== eventId || job.jobType !== 'bev:ShipmentCompleted'
    || !['queued', 'completed'].includes(job.status) || !event || event.id !== eventId
    || event.type !== 'ShipmentCompleted' || event.sourceEntityType !== 'Shipment'
    || !validId(event.sourceEntityId) || !validId(event.actorId) || !validId(event.transactionId)) return refusal();
  const audit = await tx.auditLog.findUnique({ where: { id: event.transactionId } });
  if (!audit || audit.id !== event.transactionId || audit.action !== 'update_shipment'
    || audit.targetType !== 'Shipment' || audit.targetId !== event.sourceEntityId || audit.actorId !== event.actorId
    || typeof audit.detail?.before?.status !== 'string' || !audit.detail.before.status
    || audit.detail.before.status === 'Delivered' || audit.detail.before.status === 'Cancelled'
    || audit.detail?.after?.status !== 'Delivered') return refusal();
  const source = Object.freeze({ eventId, shipmentId: event.sourceEntityId,
    auditId: audit.id, triggerActorId: event.actorId }) as ShipmentInvoiceAutomationSource;
  transactions.set(source, tx);
  return source;
}
export function assertShipmentInvoiceAutomation(tx: any, source: ShipmentInvoiceAutomationSource, shipmentId: string): void {
  if (!source || transactions.get(source) !== tx || source.shipmentId !== shipmentId) return refusal();
}
