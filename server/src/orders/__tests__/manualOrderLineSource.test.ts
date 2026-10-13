import { describe, expect, it, vi } from 'vitest';
import { assertManualOrderLineSource, parseManualSpecification, produceManualOrderLineSource } from '../manualOrderLineSource';

const input = { factoryRelationId: 'factory', specification: 'Twill 200 gsm, finished width 150 cm, navy shade per attached swatch', agreementBasis: 'Customer PO product sheet confirmed for this manually entered row', evidence: ['manual-po-spec.pdf'] };
function fixture() {
  const order = { id: 'O', type: 'fabric', businessLine: 'fabric', status: 'Pending', deletedAt: null, customerRelationId: 'customer', millRelationId: 'factory', sourceCaseId: null };
  const line: any = { id: 'L', orderId: 'O', description: 'Manual twill', quantity: '1000', unit: 'm', materialCode: 'MANUAL-TWILL', confirmedSourceType: null, confirmedSourceId: null, specSnapshot: null };
  const audits = new Map<string, any>(); let approvals: any[] = [];
  const db = { relation: { findUnique: vi.fn(async () => ({ id: 'factory', name: 'Real factory', category: 'Supplier', type: 'company', isOrganization: true, deletedAt: null })) },
    factoryProfile: { findUnique: vi.fn(async () => ({ relationId: 'factory', deletedAt: null, blacklistedAt: null })) },
    order: { findFirst: vi.fn(async () => order) }, orderLine: { findUnique: vi.fn(async () => line) },
    auditLog: { create: vi.fn(async ({ data }: any) => { audits.set(data.id, data); return data; }), findUnique: vi.fn(async ({ where }: any) => audits.get(where.id) ?? null), findFirst: vi.fn(async () => audits.get('approvalAudit') ?? null) },
    approvalRequest: { findMany: vi.fn(async () => approvals) } };
  const approve = () => { order.status = 'Confirmed'; approvals = [{ id: 'A', status: 'approved', reviewerId: 'leader', decidedAt: '100', payload: { snapshot: { order: { id: order.id, lines: [JSON.parse(JSON.stringify(line))] } } } }];
    audits.set('approvalAudit', { id: 'approvalAudit', action: 'approve_order_main_approval', actorId: 'leader', detail: { source: 'api:order-main-approval', after: { orderId: 'O', decision: 'approved' } } }); };
  return { db, order, line, audits, approve, setApprovals: (value: any[]) => { approvals = value; } };
}
describe('manual order source is real specification plus exact native approval, never invented QC', () => {
  it('records a draft manual source and only consumes it after its own snapshot and approval audit exist', async () => {
    const f = fixture(); Object.assign(f.line, await produceManualOrderLineSource(f.db, f.order, f.line, input, 'sales'));
    expect(f.line).toMatchObject({ confirmedSourceType: 'ManualOrderLine', confirmedSourceId: 'L', specSnapshot: { manualOrderLine: { recordedBy: 'sales', revision: 1, specification: input.specification } } });
    expect([...f.audits.values()].map(row => row.action)).toEqual(['record_manual_order_line_specification']);
    await expect(assertManualOrderLineSource(f.db, 'L')).rejects.toMatchObject({ code: 'CONFLICT' });
    f.approve(); expect(await assertManualOrderLineSource(f.db, 'L', 'O')).toMatchObject({ factoryRelationId: 'factory', approval: { id: 'A' } });
    expect(f.db.auditLog.create).toHaveBeenCalledTimes(1);
    await expect(assertManualOrderLineSource(f.db, 'L', 'different-order')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('does not let old status, another row approval, source tampering or a missing audit manufacture eligibility', async () => {
    const f = fixture(); Object.assign(f.line, await produceManualOrderLineSource(f.db, f.order, f.line, input, 'sales')); f.order.status = 'Confirmed';
    await expect(assertManualOrderLineSource(f.db, 'L')).rejects.toMatchObject({ code: 'CONFLICT' });
    f.approve(); f.line.quantity = '1001'; await expect(assertManualOrderLineSource(f.db, 'L')).rejects.toMatchObject({ code: 'CONFLICT' }); f.line.quantity = '1000';
    f.line.confirmedSourceId = 'other-row'; await expect(assertManualOrderLineSource(f.db, 'L')).rejects.toMatchObject({ code: 'CONFLICT' }); f.line.confirmedSourceId = 'L';
    f.audits.delete('approvalAudit'); await expect(assertManualOrderLineSource(f.db, 'L')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('preserves identical draft specification on retry and rejects post-approval edits, fake identity and inactive factories', async () => {
    const f = fixture(); Object.assign(f.line, await produceManualOrderLineSource(f.db, f.order, f.line, input, 'sales'));
    expect((await produceManualOrderLineSource(f.db, f.order, f.line, input, 'sales')).specSnapshot).toEqual(f.line.specSnapshot);
    expect(f.db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(() => parseManualSpecification({ ...input, approvedBy: 'leader' })).toThrow();
    f.approve(); await expect(produceManualOrderLineSource(f.db, f.order, f.line, input, 'sales')).rejects.toMatchObject({ code: 'CONFLICT' });
    f.db.factoryProfile.findUnique.mockResolvedValueOnce(null); await expect(assertManualOrderLineSource(f.db, 'L')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
