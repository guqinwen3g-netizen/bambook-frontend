import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { currentDocumentActor, authorizedDocumentOrders, shipmentDocumentSourceInTx } from '../shipping/shipmentDocumentSource';
import { readOrderLineProductionCompletion } from '../production/productionCompletionService';
import { orderMainSnapshotFingerprint } from '../orders/orderMainApprovalEvidence';
import { currentFabricCommissionSource, readFabricCommissionOriginal, commissionSettlementId } from './fabricCommissionSource';
import { documentSourceFingerprint as hash } from '../shipping/shipmentDocumentSource';

vi.mock('../shipping/shipmentDocumentSource', async importOriginal => ({ ...await importOriginal<typeof import('../shipping/shipmentDocumentSource')>(),
  currentDocumentActor: vi.fn(), authorizedDocumentOrders: vi.fn(), shipmentDocumentSourceInTx: vi.fn() }));
vi.mock('../production/productionCompletionService', () => ({ readOrderLineProductionCompletion: vi.fn() }));
const actor: TokenPayload = { userId: 'sales', roles: ['sales'], permissions: ['orders:read', 'orders:write', 'shipments:read'], departmentIds: [] };
const line = () => ({ id: 'line', orderId: 'order', description: 'Fabric', materialCode: 'FAB', quantity: '100', unit: 'M', unitPrice: '2.5',
  fabricSupplyMode: 'commission', fabricCommissionRate: '5', fabricCommissionSupplierId: 'supplier', confirmedSourceType: 'ManualOrderLine',
  confirmedSourceId: 'line', specSnapshot: { manual: 'accurate approved original' } });
function fixture() {
  const order = { id: 'order', code: 'ORD-1', poNumber: null, customerRelationId: 'customer', currency: 'USD', status: 'Confirmed', businessLine: 'fabric', lines: [line()] };
  const frozen = { order: structuredClone(order), businessLine: 'fabric' };
  const approval = { id: 'approval', targetId: 'order', targetType: 'Order', actionType: 'order:main_approval', status: 'approved', reviewerId: 'manager', decidedAt: new Date(),
    payload: { snapshot: frozen, businessLine: 'fabric', contentFingerprintAlgorithm: 'canonical_v1', contentFingerprint: orderMainSnapshotFingerprint(frozen) } };
  const approveAudit = { id: 'approved-audit', action: 'approve_order_main_approval', targetType: 'ApprovalRequest', targetId: 'approval', actorId: 'manager',
    detail: { source: 'api:order-main-approval', after: { orderId: 'order', decision: 'approved' } } };
  const departure = { id: 'departure', decision: 'actual_departure', commandHash: 'hash', requestKey: 'key', payload: {
    action: 'confirm-departure', shipmentId: 'shipment', atd: '2026-10-08', shipmentStatus: 'Shipped', commandHash: 'hash', requestKey: 'key' } };
  const physical = { productionBatchId: 'batch', productionBatchRevision: 1, orderId: 'order', orderLineId: 'line', unit: 'M', state: 'shipped', actualQty: '100' };
  const ship = { kind: 'physical', cartonCoverageComplete: true, shipment: { status: 'Shipped', atd: '2026-10-08' },
    physical: [physical], lines: [{ id: 'shipment-line', orderId: 'order', orderLineId: 'line', quantity: '100', unit: 'M' }] };
  const completion = { productionComplete: true, status: 'complete', branches: [{ productionBatchId: 'batch', productionBatchRevision: 1, actualQty: '100', unit: 'M' }] };
  const db = { approvalRequest: { findMany: vi.fn(async () => [approval]), findUnique: vi.fn(async () => approval) },
    auditLog: { findFirst: vi.fn(async () => approveAudit), findUnique: vi.fn(async (_input: { where: { id: string } }) => approveAudit as unknown) },
    shipmentOrderAllocation: { findMany: vi.fn(async () => [{ shipmentId: 'shipment' }]) },
    shipmentProductionAllocation: { findMany: vi.fn(async () => [{ shipmentId: 'shipment' }]) },
    shipment: { findMany: vi.fn(async () => [{ id: 'shipment' }]) },
    shipmentHandoffEvent: { findMany: vi.fn(async () => [departure]), findUnique: vi.fn(async () => departure) },
    relation: { findFirst: vi.fn(async () => ({ id: 'supplier', name: 'Real supplier', officialAddress: null, taxId: 'VAT' })) },
    tradeDocument: { findFirst: vi.fn(async () => null as unknown) }, documentVersion: { findFirst: vi.fn(async () => null as unknown) } };
  vi.mocked(currentDocumentActor).mockResolvedValue(actor);
  vi.mocked(authorizedDocumentOrders).mockResolvedValue([order]);
  vi.mocked(shipmentDocumentSourceInTx).mockResolvedValue(ship as unknown as Awaited<ReturnType<typeof shipmentDocumentSourceInTx>>);
  vi.mocked(readOrderLineProductionCompletion).mockResolvedValue(completion as Awaited<ReturnType<typeof readOrderLineProductionCompletion>>);
  return { db, tx: db as unknown as Prisma.TransactionClient, order, approval, approveAudit, departure, ship, completion, physical };
}
beforeEach(() => vi.clearAllMocks());
describe('native whole-order commission source (pure canonical producer boundaries)', () => {
  it('derives supplier commission from frozen approved price and all actual shipped quantities, without any writes', async () => {
    const f = fixture(), source = await currentFabricCommissionSource(f.tx, actor, 'order');
    expect(source.groups[0]).toMatchObject({ supplierId: 'supplier', commissionAmount: '12.5000', goodsAmount: '250.0000' });
    expect(source).toMatchObject({ approvalId: 'approval', approvalAuditId: 'approved-audit', departureEvents: [{ id: 'departure' }] });
    expect(vi.mocked(currentDocumentActor).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it.each(['fabricCommissionRate', 'fabricCommissionSupplierId', 'unitPrice', 'confirmedSourceId'] as const)('rejects stale approved %s', async key => {
    const f = fixture(); Object.assign(f.order.lines[0], { [key]: key === 'fabricCommissionRate' ? '6' : key === 'unitPrice' ? '3' : 'changed' });
    await expect(currentFabricCommissionSource(f.tx, actor, 'order')).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
  });
  it('rejects a pending reapproval, fabricated old status, missing audit, and unverifiable legacy fingerprint', async () => {
    const f = fixture(); f.approval.status = 'pending';
    await expect(currentFabricCommissionSource(f.tx, actor, 'order')).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
    f.approval.status = 'approved'; f.db.auditLog.findFirst.mockResolvedValue(null as unknown as typeof f.approveAudit);
    await expect(currentFabricCommissionSource(f.tx, actor, 'order')).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
    f.approval.payload.contentFingerprint = 'a'.repeat(64);
    await expect(currentFabricCommissionSource(f.tx, actor, 'order')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it.each(['uncompleted', 'booked', 'legacy', 'unpacked', 'no-native-departure', 'quantity-remainder'])('refuses %s physical source', async kind => {
    const f = fixture();
    if (kind === 'uncompleted') f.completion.productionComplete = false;
    if (kind === 'booked') f.ship.shipment.status = 'Booked';
    if (kind === 'legacy') f.ship.kind = 'legacy';
    if (kind === 'unpacked') f.ship.cartonCoverageComplete = false;
    if (kind === 'no-native-departure') f.db.shipmentHandoffEvent.findMany.mockResolvedValue([]);
    if (kind === 'quantity-remainder') { f.physical.actualQty = '40'; f.ship.lines[0].quantity = '40'; }
    await expect(currentFabricCommissionSource(f.tx, actor, 'order')).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
  });
  it('propagates current authorization and token-ceiling refusal instead of falling back to role names', async () => {
    const f = fixture(); vi.mocked(currentDocumentActor).mockRejectedValue(Object.assign(Error('ceiling revoked'), { code: 'FORBIDDEN' }));
    await expect(currentFabricCommissionSource(f.tx, { ...actor, permissionCeiling: ['orders:read'] }, 'order')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.approvalRequest.findMany).not.toHaveBeenCalled();
  });
  it('keeps the original readable when current quantities later change, but rejects overwritten original terms', async () => {
    const f = fixture(), source = await currentFabricCommissionSource(f.tx, actor, 'order'), group = source.groups[0], settlementId = commissionSettlementId('order');
    const document = { id: 'doc', documentNumber: 'CI-1', domain: 'finance', type: 'CommercialInvoice', status: 'Issued', orderId: 'order',
      relationId: 'supplier', sourceRef: 'fabric-commission:v1:order:supplier', sourceInvoiceId: null, currency: 'USD', issueDate: '2026-10-08', totalAmount: new Prisma.Decimal('12.5') };
    const snapshot = { schemaVersion: 1, sourceType: 'FabricCommissionCI', settlementId, source, supplierId: 'supplier', issueDate: '2026-10-08',
      dueDate: null, issuedAt: '1791418680000', issuedBy: 'sales', exporterSnapshot: {} };
    const version = { id: 'version', documentId: 'doc', version: 1, content: { fabricCommissionSnapshot: snapshot } };
    const audit = { id: settlementId, action: 'settle_fabric_order_commission', targetType: 'Order', targetId: 'order', actorId: 'sales',
      detail: { source, receipt: { settlementId, orderId: 'order', sourceFingerprint: source.sourceFingerprint,
        documents: [{ supplierId: 'supplier', documentId: 'doc', versionId: 'version', documentNumber: 'CI-1', amount: group.commissionAmount, currency: 'USD' }] } } };
    f.db.tradeDocument.findFirst.mockResolvedValue(document); f.db.documentVersion.findFirst.mockResolvedValue(version);
    f.db.auditLog.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => where.id === settlementId ? audit : f.approveAudit);
    f.order.lines[0].unitPrice = '999'; // Current order is deliberately not used to rewrite an issued original.
    expect((await readFabricCommissionOriginal(f.tx, 'doc')).group.commissionAmount).toBe('12.5000');
    snapshot.source = { ...source, groups: [{ ...group, commissionAmount: '250' }] };
    const { sourceFingerprint: _fp, ...changed } = snapshot.source; snapshot.source.sourceFingerprint = hash(changed);
    audit.detail.source = snapshot.source; audit.detail.receipt.sourceFingerprint = snapshot.source.sourceFingerprint;
    await expect(readFabricCommissionOriginal(f.tx, 'doc')).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
  });
});
