import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { supplierContractMemoryFixture } from './supplierContractMemoryFixture';
import { createSupplierCommitmentService, decideSupplierCommitmentApproval } from './supplierCommitmentService';
import { setSupplierApprovalAuthority } from './supplierCommitmentAuthority';
import { createSupplierFulfillmentService } from './supplierFulfillmentService';
import { approvalReviewContentVersion } from '../approvals/approvalReviewContent';
import { supplierObject } from './supplierContractPolicy';

const auth = vi.hoisted(() => ({ permissions: ['procurement:read', 'procurement:write'], deniedOrderId: '' }));
vi.mock('../auth/tokenHelpers', () => ({ loadUserWithRoles: vi.fn(async (_tx, id) => ({ id, status: 'active', deletedAt: null })),
  buildLoadedAuthTokenPayload: vi.fn(async (_tx, user) => ({ userId: user.id, roles: user.id === 'admin' ? ['admin'] : ['sales'], departmentIds: [], authorizationLoaded: true,
    permissions: user.id === 'reviewer' ? ['procurement:read', 'procurement:approve'] : user.id === 'admin' ? ['dictionary:write'] : [...auth.permissions] })) }));
vi.mock('../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => auth.deniedOrderId ? { id: { not: auth.deniedOrderId } } : { ownerId: 'business' }) }));
// Reference graph projection is orthogonal to the actual stock primitive. No
// service authorization, stock balance, movement or transaction is mocked.
vi.mock('../entities/sync', () => ({ syncStockMovementReferences: vi.fn(async () => undefined) }));
const actor = (userId = 'business'): TokenPayload => ({ userId, permissions: [], roles: [], departmentIds: [] });
beforeEach(() => { auth.permissions = ['procurement:read', 'procurement:write']; auth.deniedOrderId = ''; });
async function setup() {
  const f = supplierContractMemoryFixture(), prisma = f.db as unknown as PrismaClient, contracts = createSupplierCommitmentService(prisma), fulfillment = createSupplierFulfillmentService(prisma);
  for (const kind of ['purchase', 'processing'] as const) await setSupplierApprovalAuthority({ prisma, actor: actor('admin'), kind, family: 'fabric', requestKey: `configure-${kind}`, userIds: ['reviewer'], expectedConfigVersion: 0, reason: 'Explicit supplier authority' });
  const raw = await contracts.create('purchase', { requestKey: 'raw-create', contractNumber: 'PO-actual', supplierRelationId: 'supplier-1', currency: 'CNY', paymentTerms: 'T/T 30',
    mainDeliveryLocation: { kind: 'supplier', relationId: 'processor-1', address: 'Actual processor' }, orderDate: '2026-10-07',
    lines: [{ orderLineId: 'line-1', kind: 'Material', category: 'Fabric', materialCode: 'RAW-1', description: 'Raw cotton', quantity: '100', unit: 'M', unitPrice: '2', requestedDeliveryDate: '2026-11-01' }] }, actor());
  const rawId = raw.commandAck.contractId, rawLineId = f.all('purchaseLine')[0].id;
  const processing = await contracts.create('processing', { requestKey: 'processing-create', contractNumber: 'OSO-actual', supplierRelationId: 'processor-1', currency: 'CNY', paymentTerms: 'T/T 30',
    mainDeliveryLocation: { kind: 'external', name: 'Actual receiving party', address: 'Actual delivery address' }, orderDate: '2026-10-07',
    lines: [{ orderLineId: 'line-1', processType: 'Dyeing', materialCode: 'DYED-1', description: 'Dye cotton', quantity: '100', unit: 'M', unitPrice: '1', requestedDeliveryDate: '2026-11-10', inputSource: { kind: 'purchase_contract', contractId: rawId, lineId: rawLineId } }] }, actor());
  for (const [kind, created] of [['purchase', raw], ['processing', processing]] as const) {
    const submit = await contracts.submit(kind, created.commandAck.contractId, { requestKey: `${kind}-submit`, expectedRevision: 1 }, actor());
    const approval = f.all('approvalRequest').find(row => row.id === submit.commandAck.approvalId)!;
    await decideSupplierCommitmentApproval({ prisma, approvalId: approval.id, actor: actor('reviewer'), decision: 'approved', reviewContentVersion: approvalReviewContentVersion(approval), confirmedReviewedContent: true });
    await contracts.recordOfflineSend(kind, created.commandAck.contractId, { requestKey: `${kind}-offline`, approvedRevisionId: created.commandAck.revisionId, sentAt: '2026-10-07' }, actor());
    const lineId = kind === 'purchase' ? rawLineId : f.all('outsourcingLine')[0].id;
    await contracts.recordSupplierFeedback(kind, created.commandAck.contractId, { requestKey: `${kind}-feedback`, approvedRevisionId: created.commandAck.revisionId, feedbackAt: '2026-10-08', lines: [{ lineId, supplierCommittedDeliveryDate: kind === 'purchase' ? '2026-11-01' : '2026-11-10' }] }, actor());
  }
  return { f, prisma, contracts, fulfillment, raw, processing, rawLineId, processingLineId: f.all('outsourcingLine')[0].id,
    direct: { requestKey: 'direct-actual-first', approvedRevisionId: raw.commandAck.revisionId, lines: [{ kind: 'purchase_delivery', lineId: rawLineId, quantity: '60.125', unit: 'M', occurredAt: '2026-11-01',
      destination: { kind: 'supplier', relationId: 'processor-1', address: 'Actual processor' }, processingContractId: processing.commandAck.contractId,
      processingRevisionId: processing.commandAck.revisionId, processingLineId: f.all('outsourcingLine')[0].id, evidence: ['signed actual handover'] }] } };
}
describe('native supplier actual fulfillment', () => {
  it('atomically links direct supplier-to-processor delivery and input without any own inventory, and replays only the original actual facts', async () => {
    const s = await setup(), first = await s.fulfillment.record('purchase', s.raw.commandAck.contractId, s.direct, actor());
    expect(first.commandAck.factIds).toHaveLength(2);
    const facts = s.f.all('supplierFulfillmentFact');
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({ kind: 'purchase_delivery', purchaseLineId: s.rawLineId, orderLineId: 'line-1', unit: 'M', toRelationId: 'processor-1' });
    expect(facts[1]).toMatchObject({ kind: 'processing_input', outsourcingLineId: s.processingLineId, sourceFactId: facts[0].id, orderLineId: 'line-1' });
    expect(facts.map(row => row.quantity.toString())).toEqual(['60.125', '60.125']);
    expect(s.f.all('inventoryItem')).toHaveLength(0); expect(s.f.all('stockMovement')).toHaveLength(0); expect(s.f.all('materialReceipt')).toHaveLength(0);
    expect(await s.fulfillment.record('purchase', s.raw.commandAck.contractId, s.direct, actor())).toEqual(first);
    expect(s.f.all('supplierFulfillmentFact')).toHaveLength(2);
    await expect(s.fulfillment.record('purchase', s.raw.commandAck.contractId, { ...s.direct, lines: [{ ...s.direct.lines[0], quantity: '61' }] }, actor())).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
  });
  it('appends two partial returns and keeps planned variance pending without creating QC, invoices or automatic close', async () => {
    const s = await setup(); await s.fulfillment.record('purchase', s.raw.commandAck.contractId, s.direct, actor());
    for (const [index, quantity] of ['20.125', '42'].entries()) await s.fulfillment.record('processing', s.processing.commandAck.contractId, { requestKey: `actual-return-${index}`, approvedRevisionId: s.processing.commandAck.revisionId,
      lines: [{ kind: 'processing_return', lineId: s.processingLineId, quantity, unit: 'M', occurredAt: '2026-11-10', destination: { kind: 'external', name: 'Actual receiving party', address: 'Actual delivery address' }, evidence: ['actual return receipt'] }] }, actor());
    const view = supplierObject(await s.fulfillment.get('processing', s.processing.commandAck.contractId, actor()));
    expect(view.lines).toEqual([expect.objectContaining({ lineId: s.processingLineId, returnedQuantity: '62.125', plannedQuantity: '100', varianceStatus: 'pending' })]);
    expect(s.f.all('supplierFulfillmentFact').filter(row => row.kind === 'processing_return')).toHaveLength(2);
    expect(s.f.all('outsourcingOrder')[0]).toMatchObject({ status: 'Confirmed' });
    expect(s.f.all('outsourcingOrder')[0].qualityAcceptedQty ?? 0).toBe(0);
  });
  it('checks current scopes and exact receiver source even for replay and rolls back both sides when any accurate contract source is forbidden', async () => {
    const s = await setup(); await s.fulfillment.record('purchase', s.raw.commandAck.contractId, s.direct, actor());
    auth.permissions = ['procurement:read'];
    await expect(s.fulfillment.record('purchase', s.raw.commandAck.contractId, s.direct, actor())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    auth.permissions = ['procurement:read', 'procurement:write'];
    const count = s.f.all('supplierFulfillmentFact').length;
    await expect(s.fulfillment.record('purchase', s.raw.commandAck.contractId, { ...s.direct, requestKey: 'wrong-processor', lines: [{ ...s.direct.lines[0], destination: { kind: 'supplier', relationId: 'supplier-1', address: 'Wrong receiver' } }] }, actor())).rejects.toMatchObject({ code: 'PROCESSOR_MISMATCH' });
    expect(s.f.all('supplierFulfillmentFact')).toHaveLength(count);
    auth.deniedOrderId = 'order-1';
    await expect(s.fulfillment.record('purchase', s.raw.commandAck.contractId, s.direct, actor())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('posts an actual warehouse lot and exact outbound handover, retaining pending quality and rejecting unavailable stock', async () => {
    const s = await setup();
    s.f.put('warehouse', { id: 'WH', name: 'Actual raw material warehouse', isActive: true, deletedAt: null });
    const delivered = await s.fulfillment.record('purchase', s.raw.commandAck.contractId, { ...s.direct, requestKey: 'actual-warehouse-delivery',
      lines: [{ kind: 'purchase_delivery', lineId: s.rawLineId, quantity: '60.125', unit: 'M', occurredAt: '2026-11-01', destination: { kind: 'warehouse', warehouseId: 'WH', address: 'Actual warehouse' } }] }, actor());
    expect(delivered.commandAck.factIds).toHaveLength(1);
    const item = s.f.all('inventoryItem')[0], receipt = s.f.all('materialReceipt')[0], movement = s.f.all('stockMovement')[0];
    expect(item.quantity.toString()).toBe('60.125'); expect(receipt.totalReceived.toString()).toBe('60.125'); expect(receipt.totalAccepted.toString()).toBe('0');
    expect(receipt.status).toBe('Pending'); expect(movement).toMatchObject({ referenceType: 'SupplierFulfillmentFact', referenceId: delivered.commandAck.factIds![0], unit: 'M' });
    const current = supplierObject(await s.contracts.get('processing', s.processing.commandAck.contractId, actor())), draft = supplierObject(current.draft);
    const amended = await s.contracts.amend('processing', s.processing.commandAck.contractId, { ...draft, lines: (draft.lines as Record<string, unknown>[]).map(line => ({ ...line, inputSource: { kind: 'warehouse', inventoryItemId: item.id } })),
      requestKey: 'actual-warehouse-input-amendment', expectedRevision: current.latestRevision, basedOnRevisionId: s.processing.commandAck.revisionId, reason: 'Actual raw material will pass through the warehouse' }, actor());
    const submit = await s.contracts.submit('processing', s.processing.commandAck.contractId, { requestKey: 'warehouse-input-submit', expectedRevision: 2 }, actor());
    const approval = s.f.all('approvalRequest').find(row => row.id === submit.commandAck.approvalId)!;
    await decideSupplierCommitmentApproval({ prisma: s.prisma, approvalId: approval.id, actor: actor('reviewer'), decision: 'approved', reviewContentVersion: approvalReviewContentVersion(approval), confirmedReviewedContent: true });
    const input = { requestKey: 'actual-warehouse-outbound', approvedRevisionId: amended.commandAck.revisionId, lines: [{ kind: 'processing_input', lineId: s.processingLineId,
      quantity: '20.125', unit: 'M', occurredAt: '2026-11-02', destination: { kind: 'supplier', relationId: 'processor-1', address: 'Actual processor' }, inventoryItemId: item.id, evidence: ['actual signed handover'] }] };
    const handed = await s.fulfillment.record('processing', s.processing.commandAck.contractId, input, actor());
    expect(s.f.all('inventoryItem')[0].quantity.toString()).toBe('40'); expect(s.f.all('stockMovement')).toHaveLength(2);
    expect(s.f.all('supplierFulfillmentFact').find(row => row.id === handed.commandAck.factIds![0])).toMatchObject({ fromKind: 'warehouse', fromWarehouseId: 'WH', sourceStockMovementId: s.f.all('stockMovement')[1].id });
    expect(await s.fulfillment.record('processing', s.processing.commandAck.contractId, input, actor())).toEqual(handed);
    s.f.all('inventoryItem')[0].lockedQuantity = new Prisma.Decimal('10');
    await expect(s.fulfillment.record('processing', s.processing.commandAck.contractId, { ...input, requestKey: 'over-available', lines: [{ ...input.lines[0], quantity: '30.0001' }] }, actor())).rejects.toThrow('可用数量不足');
    expect(s.f.all('stockMovement')).toHaveLength(2); expect(s.f.all('inventoryItem')[0].quantity.toString()).toBe('40');
  });
});
