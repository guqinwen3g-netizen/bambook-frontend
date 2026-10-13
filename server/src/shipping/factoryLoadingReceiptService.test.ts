import { beforeEach, describe, expect, it, vi } from 'vitest';
import { qcReportSourceFingerprint as hash } from '../qc/qcReportAuthority';
import { exactJsonValue } from '../lib/exactJsonValue';
const shared = vi.hoisted(() => ({ actor: null as any, coverage: null as any }));
vi.mock('../auth/tokenHelpers', () => ({ loadUserWithRoles: vi.fn(async (_tx, id) => ({ id, status: 'active', deletedAt: null })),
  buildLoadedAuthTokenPayload: vi.fn(async () => shared.actor) }));
vi.mock('../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => ({})) }));
vi.mock('../qc/qcPhysicalCoverage', () => ({ resolveQcCoverage: vi.fn(async () => shared.coverage) }));
vi.mock('../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn(async (args: any) => args.prisma.auditLog.create({ data: {
  action: args.operation, targetType: args.targetType, targetId: args.targetId, actorId: args.actorId,
  detail: { source: args.source, after: JSON.parse(JSON.stringify(args.after)) } } })) }));
import { SYSTEM_ROLE_IDS } from '../_shared/rolePermissionMatrix';
import { createFactoryLoadingReceiptInTx, verifyFactoryLoadingReceiptInTx } from './factoryLoadingReceiptService';
const UUID = '4dc58690-9475-4af5-8a8b-f671f7021588';
const json = (value: any): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
function fixture() {
  const scope = { schemaVersion: 1, factory: 'F1', batch: 'PB1', revision: 2 };
  shared.coverage = { scopeFingerprint: hash(scope), scopeSnapshot: scope };
  const batch: any = { id: 'PB1', orderId: 'O1', orderLineId: 'OL1', revision: 2, state: 'active', factoryRelationId: 'F1', unit: 'pcs', quantity: '10' };
  const handoff: any = { id: 'H1', shipmentId: 'S1', status: 'Processing', updatedAt: BigInt('9007199254740999') };
  const allocation: any = { id: 'A1', shipmentId: 'S1', orderId: 'O1', orderLineId: 'OL1', status: 'Planned', unit: 'pcs' };
  const line: any = { handoffId: 'H1', allocationId: 'A1', productionBatchId: 'PB1', orderId: 'O1', orderLineId: 'OL1',
    productionBatchRevision: 2, factoryRelationId: 'F1', scopeFingerprint: hash(scope), unit: 'pcs' };
  const rows = new Map<string, any>(), audits: any[] = [];
  const tx: any = { factoryLoadingReceipt: { findUnique: vi.fn(async ({ where }: any) => rows.get(where.id) ?? null),
    create: vi.fn(async ({ data }: any) => { const persisted = { ...data }; rows.set(data.id, persisted); return persisted; }) },
    auditLog: { create: vi.fn(async ({ data }: any) => { audits.push(data); return data; }),
      findMany: vi.fn(async ({ where }: any) => audits.filter(row => row.action === where.action && row.targetId === where.targetId)) },
    shipmentHandoff: { findUnique: vi.fn(async () => handoff) }, shipmentHandoffLine: { findFirst: vi.fn(async () => line) },
    shipmentOrderAllocation: { findUnique: vi.fn(async () => allocation) }, productionBatch: { findUnique: vi.fn(async () => batch) },
    order: { findFirst: vi.fn(async () => ({ id: 'O1' })) } };
  const params = { handoffId: 'H1', allocationId: 'A1', batchId: 'PB1', actor: shared.actor, requestKey: UUID,
    expectedHandoffUpdatedAt: String(handoff.updatedAt), fact: { actualQty: '5', loadingDate: '2026-10-07', reference: '工厂装箱核实 PACK-17' }, previousFactoryLoadingReceiptIds: [] as string[] };
  return { tx, rows, audits, batch, handoff, allocation, line, params,
    create: (patch: any = {}) => createFactoryLoadingReceiptInTx(tx, { ...params, ...patch }),
    verify: (id: string, source = batch) => verifyFactoryLoadingReceiptInTx(tx, id, source, hash(scope), { shipmentId: 'S1', allocationId: 'A1', handoffId: 'H1' }) };
}
beforeEach(() => { shared.actor = { userId: 'L1', roleIds: [SYSTEM_ROLE_IDS.LOGISTICS], roles: [], permissions: ['orders:read', 'shipments:write'], authorizationLoaded: true }; });
describe('immutable factory loading facts', () => {
  it('creates exact source/date/quantity/actor and an immutable audited original receipt, without Warehouse or Inbound', async () => {
    const f = fixture(), receipt = await f.create();
    expect(json(receipt)).toMatchObject({ handoffId: 'H1', shipmentId: 'S1', allocationId: 'A1', productionBatchId: 'PB1', productionBatchRevision: 2,
      factoryRelationId: 'F1', quantity: '5', createdBy: 'L1', requestKey: UUID, loadingDate: '2026-10-07' });
    expect(receipt.commandSnapshot.expectedHandoffUpdatedAt).toBe('9007199254740999');
    const verified = await f.verify(receipt.id); expect(verified.identity).toMatchObject({ sourceKind: 'factory_direct', factoryLoadingReceiptId: receipt.id, loadedQuantity: '5' });
    expect(f.audits).toHaveLength(1); expect(f.tx.warehouse).toBeUndefined(); expect(f.tx.stockMovement).toBeUndefined(); expect(f.tx.inventoryItem).toBeUndefined();
    expect((await f.create()).id).toBe(receipt.id); expect(f.rows.size).toBe(1); expect(f.audits).toHaveLength(1);
  });
  it('preserves explicit zero and never substitutes planned quantity for an unknown amount', async () => {
    const f = fixture(); const receipt = await f.create({ fact: { ...f.params.fact, actualQty: '0' } });
    expect(String(receipt.quantity)).toBe('0'); expect((await f.verify(receipt.id)).identity.loadedQuantity).toBe('0');
    await expect(f.create({ requestKey: '8acbc510-1bfd-4b45-8d7c-fd0210683eaf', fact: { ...f.params.fact, actualQty: null } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('refuses the same original key with changed evidence and retains old receipt on a subsequent correction', async () => {
    const f = fixture(), old = await f.create();
    await expect(f.create({ fact: { ...f.params.fact, actualQty: '4' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    const corrected = await f.create({ requestKey: '8acbc510-1bfd-4b45-8d7c-fd0210683eaf', fact: { ...f.params.fact, actualQty: '4' }, previousFactoryLoadingReceiptIds: [old.id] });
    expect(corrected.id).not.toBe(old.id); expect(f.rows.size).toBe(2); expect(String(f.rows.get(old.id).quantity)).toBe('5');
    expect(corrected.commandSnapshot.previousFactoryLoadingReceiptIds).toEqual([old.id]);
  });
  it.each(['quantity', 'factory', 'scope', 'audit'])('refuses tampered %s proof', async kind => {
    const f = fixture(), receipt = await f.create();
    if (kind === 'quantity') receipt.quantity = '6';
    if (kind === 'factory') receipt.factoryRelationId = 'FOREIGN';
    if (kind === 'scope') receipt.scopeSnapshot = { changed: true };
    if (kind === 'audit') f.audits.length = 0;
    await expect(f.verify(receipt.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('keeps historical proof readable after cancellation and a later batch revision, and refuses cross-shipment reuse', async () => {
    const f = fixture(), historical = { ...f.batch }, receipt = await f.create();
    f.handoff.status = 'Cancelled'; f.batch.revision = 9; f.batch.factoryRelationId = 'F2';
    expect((await f.verify(receipt.id, historical)).receipt.id).toBe(receipt.id);
    await expect(f.verify(receipt.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(verifyFactoryLoadingReceiptInTx(f.tx, receipt.id, historical, f.line.scopeFingerprint, { shipmentId: 'S2', allocationId: 'A1' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.rows.size).toBe(1);
  });
  it.each(['role', 'source', 'stage', 'version', 'factory', 'revision'])('requires fresh authorized %s context', async kind => {
    const f = fixture();
    if (kind === 'role') shared.actor = { ...shared.actor, roleIds: [SYSTEM_ROLE_IDS.SALES] };
    if (kind === 'source') f.tx.order.findFirst.mockResolvedValue(null);
    if (kind === 'stage') f.handoff.status = 'PendingLogistics';
    if (kind === 'version') f.handoff.updatedAt += BigInt(1);
    if (kind === 'factory') f.batch.factoryRelationId = 'FOREIGN';
    if (kind === 'revision') f.batch.revision = 3;
    await expect(f.create()).rejects.toBeTruthy(); expect(f.rows.size).toBe(0); expect(f.audits).toHaveLength(0);
  });
});
