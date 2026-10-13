/** Pure trusted-automation controls against actual verifier code. Only the
 * persisted AgentJob and AuditLog reads are explicit storage seams. No human
 * authority, token minting, source-lock or verifier implementation is mocked. */
import { describe, expect, it, vi } from 'vitest';
import { authenticateShipmentInvoiceAutomation, assertShipmentInvoiceAutomation } from '../shipmentInvoiceAutomationSource';

const eventId = 'bev-ShipmentCompleted-native-source';
const shipmentId = 'Shipment-native-source';
const auditId = 'audit-native-delivered-transition';
function fixture() {
  const event: any = { id: eventId, type: 'ShipmentCompleted', sourceEntityType: 'Shipment', sourceEntityId: shipmentId,
    actorId: 'actual-shipper-without-invoice-grant', transactionId: auditId, orderId: 'event-order-hint',
    payload: { shipmentNumber: 'SH-2026-0020' }, occurredAt: 1790899200000 };
  const job: any = { id: eventId, jobType: 'bev:ShipmentCompleted', status: 'queued', payload: event };
  const audit: any = { id: auditId, action: 'update_shipment', actorId: event.actorId, targetType: 'Shipment', targetId: shipmentId,
    detail: { source: 'route:shipping:update', before: { status: 'Cleared' }, after: { status: 'Delivered' } } };
  const noHumanAuthority = vi.fn(async () => { throw Error('L3 cannot invent or borrow a human invoice grant'); });
  const tx = { agentJob: { findUnique: vi.fn().mockResolvedValue(job) }, auditLog: { findUnique: vi.fn().mockResolvedValue(audit) },
    userAccount: { findUnique: noHumanAuthority }, userPermissionOverrides: { findMany: noHumanAuthority } };
  return { tx, event, job, audit, noHumanAuthority };
}
const refuses = (work: () => unknown) => expect(Promise.resolve().then(work)).rejects.toMatchObject({ code: 'CONFLICT' });

describe('L3 shipment Invoice automation source proof', () => {
  it('mints a transaction-bound source from real persisted delivery without requiring the shipper to hold Invoice grants', async () => {
    const f = fixture();
    const token = await authenticateShipmentInvoiceAutomation(f.tx, eventId);
    await assertShipmentInvoiceAutomation(f.tx, token, shipmentId);
    f.job.status = 'completed';
    const recovered = await authenticateShipmentInvoiceAutomation(f.tx, eventId);
    await assertShipmentInvoiceAutomation(f.tx, recovered, shipmentId);
    expect(f.tx.agentJob.findUnique).toHaveBeenCalledWith({ where: { id: eventId } });
    expect(f.tx.auditLog.findUnique).toHaveBeenCalledWith({ where: { id: auditId } });
    expect(f.noHumanAuthority).not.toHaveBeenCalled();
  });
  it('rejects missing durable jobs, even when an actual-looking delivery audit is available', async () => {
    const f = fixture(); f.tx.agentJob.findUnique.mockResolvedValue(null);
    await refuses(() => authenticateShipmentInvoiceAutomation(f.tx, eventId));
    expect(f.tx.auditLog.findUnique).not.toHaveBeenCalled();
  });
  it('rejects malformed event selectors before trusting a durable event', async () => {
    for (const badId of ['', '   ', undefined, 42]) {
      const f = fixture();
      await refuses(() => authenticateShipmentInvoiceAutomation(f.tx, badId as any));
    }
  });
  it('rejects durable payload identity/type or jobType mismatches', async () => {
    for (const corrupt of [
      (f: ReturnType<typeof fixture>) => { f.event.id = 'different-event'; },
      (f: ReturnType<typeof fixture>) => { f.event.type = 'ShipmentCreated'; },
      (f: ReturnType<typeof fixture>) => { f.job.jobType = 'bev:OrderConfirmed'; },
      (f: ReturnType<typeof fixture>) => { f.job.status = 'running'; },
    ]) {
      const f = fixture(); corrupt(f);
      await refuses(() => authenticateShipmentInvoiceAutomation(f.tx, eventId));
    }
  });
  it('rejects a non-Shipment source or missing source, actor and native transaction identity', async () => {
    for (const corrupt of [
      (f: ReturnType<typeof fixture>) => { f.event.sourceEntityType = 'Order'; },
      (f: ReturnType<typeof fixture>) => { f.event.sourceEntityId = ''; },
      (f: ReturnType<typeof fixture>) => { f.event.actorId = ''; },
      (f: ReturnType<typeof fixture>) => { f.event.transactionId = ''; },
    ]) {
      const f = fixture(); corrupt(f);
      await refuses(() => authenticateShipmentInvoiceAutomation(f.tx, eventId));
    }
  });
  it('rejects an event whose native delivery audit does not exist', async () => {
    const f = fixture(); f.tx.auditLog.findUnique.mockResolvedValue(null);
    await refuses(() => authenticateShipmentInvoiceAutomation(f.tx, eventId));
  });
  it('rejects audits with mismatched native action, target type, Shipment or actor', async () => {
    for (const corrupt of [
      (f: ReturnType<typeof fixture>) => { f.audit.action = 'create_shipment'; },
      (f: ReturnType<typeof fixture>) => { f.audit.targetType = 'Invoice'; },
      (f: ReturnType<typeof fixture>) => { f.audit.targetId = 'another-Shipment'; },
      (f: ReturnType<typeof fixture>) => { f.audit.actorId = 'a-different-actor'; },
    ]) {
      const f = fixture(); corrupt(f);
      await refuses(() => authenticateShipmentInvoiceAutomation(f.tx, eventId));
    }
  });
  it('rejects an audit that does not prove a real transition into Delivered', async () => {
    for (const corrupt of [
      (f: ReturnType<typeof fixture>) => { f.audit.detail.before.status = 'Delivered'; },
      (f: ReturnType<typeof fixture>) => { f.audit.detail.before.status = 'Cancelled'; },
      (f: ReturnType<typeof fixture>) => { f.audit.detail.after.status = 'Shipped'; },
      (f: ReturnType<typeof fixture>) => { delete f.audit.detail.before; },
    ]) {
      const f = fixture(); corrupt(f);
      await refuses(() => authenticateShipmentInvoiceAutomation(f.tx, eventId));
    }
  });
  it('rejects fabricated proof objects, even with matching system actor and event/source identities', async () => {
    const f = fixture();
    await refuses(() => assertShipmentInvoiceAutomation(f.tx, { eventId, shipmentId, actorId: 'system', event: f.event, audit: f.audit } as any, shipmentId));
    expect(f.noHumanAuthority).not.toHaveBeenCalled();
  });
  it('rejects copying or JSON-serializing a genuine token', async () => {
    const f = fixture(), token = await authenticateShipmentInvoiceAutomation(f.tx, eventId);
    await refuses(() => assertShipmentInvoiceAutomation(f.tx, { ...token } as any, shipmentId));
    await refuses(() => assertShipmentInvoiceAutomation(f.tx, JSON.parse(JSON.stringify(token)), shipmentId));
    await assertShipmentInvoiceAutomation(f.tx, token, shipmentId);
  });
  it('rejects cross-transaction reuse and a different Shipment within the same transaction', async () => {
    const f = fixture(), token = await authenticateShipmentInvoiceAutomation(f.tx, eventId), other = fixture();
    await refuses(() => assertShipmentInvoiceAutomation(other.tx, token, shipmentId));
    await refuses(() => assertShipmentInvoiceAutomation(f.tx, token, 'another-Shipment'));
    await assertShipmentInvoiceAutomation(f.tx, token, shipmentId);
  });
  it('does not turn payload order hints or asserted roles into authority to consume a different Shipment', async () => {
    const f = fixture();
    f.event.orderId = 'spoofed-order-hint';
    f.event.payload = { orderId: 'spoofed-order', orderIds: ['another-order'], roles: ['owner'], actorId: 'system', amount: '999.0000' };
    const token = await authenticateShipmentInvoiceAutomation(f.tx, eventId);
    await assertShipmentInvoiceAutomation(f.tx, token, shipmentId);
    await refuses(() => assertShipmentInvoiceAutomation(f.tx, token, 'spoofed-order'));
    expect(f.noHumanAuthority).not.toHaveBeenCalled();
  });
});
