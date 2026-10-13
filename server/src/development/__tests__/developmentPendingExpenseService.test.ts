import { describe, it, expect, vi } from 'vitest';
import { registerPendingDevelopmentExpense as register, completePendingDevelopmentExpense as complete } from '../developmentPendingExpenseService';
function fixture() {
  let pending: any[] = [], costs: any[] = [], audits: any[] = [];
  const tx: any = {
    $queryRaw: vi.fn(async () => [{ id: 'dev' }]),
    developmentCase: { findFirst: vi.fn(async () => ({ id: 'dev' })) },
    sampleBatch: { findFirst: vi.fn(async () => null) }, sample: { findFirst: vi.fn(async () => null) }, sealSample: { findFirst: vi.fn(async () => null) },
    developmentPendingExpense: {
      findUnique: async ({ where }: any) => pending.find(r => r.developmentCaseId === where.developmentCaseId_requestKey.developmentCaseId && r.requestKey === where.developmentCaseId_requestKey.requestKey) ?? null,
      findFirst: async ({ where }: any) => pending.find(r => r.id === where.id && r.developmentCaseId === where.developmentCaseId) ?? null,
      create: async ({ data }: any) => { pending.push(data); return data; },
      update: async ({ where, data }: any) => { const row = pending.find(r => r.id === where.id); Object.assign(row, data); return row; },
    },
    costRecord: { create: vi.fn(async ({ data }: any) => { costs.push(data); return data; }) },
    auditLog: { create: vi.fn(async ({ data }: any) => { audits.push(data); return data; }) },
  };
  const context = { actorId: 'sales', authorize: vi.fn(async () => ({})), authorizeAssignee: vi.fn(async () => ({})), prisma: {
    $transaction: vi.fn(async (fn: any) => {
      const before = { pending: pending.map(r => ({ ...r })), costs: [...costs], audits: [...audits] };
      try { return await fn(tx); } catch (e) { pending = before.pending; costs = before.costs; audits = before.audits; throw e; }
    }),
  } };
  return { context, tx, state: () => ({ pending, costs, audits }) };
}
const input = { requestKey: 'create-1', sourceType: 'DevelopmentCase', sourceId: 'dev', costType: 'shipping', description: '快递账单待到', ownerId: 'sales', expectedDate: '2026-10-01' };
const resolution = { requestKey: 'resolve-1', expectedVersion: 1, outcome: 'resolved' as const, note: '快递对账单已核实', amount: '12.3456', currency: 'CNY', incurredAt: '2026-09-30' };
describe('pending development expense transactions', () => {
  it('unknown cost creates no money and retry creates no duplicate', async () => {
    const f = fixture(); const a = await register(f.context, 'dev', input); const b = await register(f.context, 'dev', input);
    expect(a.id).toBe(b.id); expect(f.state().pending).toHaveLength(1); expect(f.state().costs).toHaveLength(0); expect(a).not.toHaveProperty('amount');
    expect(f.context.authorizeAssignee).toHaveBeenCalledWith(f.tx, 'dev', 'sales');
  });
  it('changed create payload conflicts', async () => {
    const f = fixture(); await register(f.context, 'dev', input);
    await expect(register(f.context, 'dev', { ...input, description: 'different' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  });
  it('resolves exact cost once and preserves internal cost separate from customer charge', async () => {
    const f = fixture(); const p = await register(f.context, 'dev', input);
    const row = await complete(f.context, 'dev', p.id, resolution); await complete(f.context, 'dev', p.id, resolution);
    expect(row).toMatchObject({ status: 'resolved', version: 2, completedBy: 'sales' });
    expect(f.state().costs).toHaveLength(1); expect(f.state().costs[0].amount.toFixed(4)).toBe('12.3456');
    expect(f.state().costs[0].bearerType).toBe('internal'); expect(f.state().audits).toHaveLength(3);
  });
  it('rejects stale version and changed completion', async () => {
    const f = fixture(); const p = await register(f.context, 'dev', input);
    await expect(complete(f.context, 'dev', p.id, { ...resolution, expectedVersion: 2 })).rejects.toMatchObject({ code: 'STALE_VERSION' });
    await complete(f.context, 'dev', p.id, resolution);
    await expect(complete(f.context, 'dev', p.id, { ...resolution, amount: '99' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  });
  it.each([undefined, '', -1, '0.00001'])('invalid amount %s leaves pending unchanged', async amount => {
    const f = fixture(); const p = await register(f.context, 'dev', input);
    await expect(complete(f.context, 'dev', p.id, { ...resolution, amount })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(f.state().costs).toHaveLength(0); expect(f.state().pending[0].status).toBe('pending');
  });
  it('audit failure rolls back cost and completion', async () => {
    const f = fixture(); const p = await register(f.context, 'dev', input);
    f.tx.auditLog.create.mockImplementationOnce(async () => ({})).mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(complete(f.context, 'dev', p.id, resolution)).rejects.toThrow('audit unavailable');
    expect(f.state().costs).toHaveLength(0); expect(f.state().pending[0].status).toBe('pending');
  });
  it('cancellation has evidence without fabricated cost', async () => {
    const f = fixture(); const p = await register(f.context, 'dev', input);
    const row = await complete(f.context, 'dev', p.id, { requestKey: 'cancel', expectedVersion: 1, outcome: 'cancelled', note: '供应商确认未产生费用' });
    expect(row.status).toBe('cancelled'); expect(f.state().costs).toHaveLength(0);
  });
  it('rejects cross-case source and pending item', async () => {
    const f = fixture(); await expect(register(f.context, 'dev', { ...input, sourceId: 'other' })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    const p = await register(f.context, 'dev', input);
    await expect(complete(f.context, 'other', p.id, resolution)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('allows explained cancellation after source deletion but forbids creating cost against it', async () => {
    const f = fixture(); f.tx.sampleBatch.findFirst.mockResolvedValueOnce({ id: 'batch' });
    const p = await register(f.context, 'dev', { ...input, sourceType: 'SampleBatch', sourceId: 'batch' });
    await expect(complete(f.context, 'dev', p.id, resolution)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    const row = await complete(f.context, 'dev', p.id, { requestKey: 'cancel-deleted', expectedVersion: 1, outcome: 'cancelled', note: '样品已取消，确认不再有账单' });
    expect(row.status).toBe('cancelled'); expect(f.state().costs).toHaveLength(0);
  });
  it('rechecks authorization after lock', async () => {
    const f = fixture(); f.context.authorize.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('revoked'));
    await expect(register(f.context, 'dev', input)).rejects.toThrow('revoked'); expect(f.state().pending).toHaveLength(0); expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
  });
  it('rejects invalid calendar date and unsupported new currency', async () => {
    const f = fixture(); await expect(register(f.context, 'dev', { ...input, expectedDate: '2026-02-30' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const p = await register(f.context, 'dev', input);
    await expect(complete(f.context, 'dev', p.id, { ...resolution, currency: 'EUR' })).rejects.toMatchObject({ code: 'INVALID_CURRENCY' });
  });
});
