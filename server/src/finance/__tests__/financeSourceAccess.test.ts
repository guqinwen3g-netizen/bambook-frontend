import { beforeEach, describe, expect, it, vi } from 'vitest';
const authority = vi.hoisted(() => ({ active: true, scopes: ['invoices:read', 'invoices:reconcile', 'vouchers:read'], kind: 'team',
  access: { own: 'owner', team: 'team-read', hidden: 'none', payer: 'none' } as Record<string, string> }));
vi.mock('../../auth/tokenHelpers', () => ({ loadUserWithRoles: async (_tx: any, id: string) => authority.active ? { id, status: 'active', deletedAt: null } : null,
  buildLoadedAuthTokenPayload: async (_tx: any, user: any) => ({ userId: user.id, roles: [], roleIds: [], permissions: [...authority.scopes], authorizationLoaded: true }) }));
vi.mock('../../auth/permissionService', () => ({ createPermissionService: () => ({ getDataScopeResolver: async () => ({ rule: { kind: authority.kind }, allowedUserIds: ['sales', 'colleague'] }) }),
  hasScope: (actor: any, scope: string) => actor.permissions.includes(scope) && (actor.permissionCeiling === undefined || actor.permissionCeiling.includes(scope)) }));
vi.mock('../../teams/teamShareService', () => ({ createTeamShareService: () => ({ getActiveGrantedRelationIds: async () => Object.keys(authority.access).filter(id => authority.access[id].startsWith('team-')) }) }));
vi.mock('../../orders/orderService', () => ({ buildOrderListScopeWhere: async () => ({}) }));
import { createFinanceSourceAccess, visibleFinanceInvoiceWhere, requireFinanceInvoiceAccess, requireFinanceAllocationAccess, listVisibleFinanceAllocations } from '../financeSourceAccess';

const actor: any = { userId: 'sales', roles: ['FINANCE'], permissionCeiling: ['invoices:read', 'invoices:reconcile', 'vouchers:read'] };
const inv = (id = 'one', extra: any = {}) => ({ id, type: 'Receivable', status: 'Issued', ownerId: 'finance',
  sourceType: null, sourceId: null, customerRelationId: 'own', deletedAt: null, ...extra });
function fixture() {
  const facts: Record<string, any[]> = { invoice: [inv()], relation: ['own', 'team', 'hidden', 'payer'].map(id => ({ id, ownerId: id === 'own' ? 'sales' : 'unrelated', salesRepIds: [] })),
    developmentCase: [{ id: 'dev', customerRelationId: 'own' }, { id: 'hidden-dev', customerRelationId: 'hidden' }],
    order: [{ id: 'order', customerRelationId: 'own' }, { id: 'hidden-order', customerRelationId: 'hidden' }],
    invoiceLine: [], invoiceOrderAllocation: [], invoiceAllocation: [], paymentVoucher: [{ id: 'cash', ownerId: 'finance', customerRelationId: 'payer' }],
    costRecord: [], billingItem: [], sample: [], sampleBatch: [], sealSample: [], shipment: [], shipmentOrderAllocation: [],
    orderLine: [], quotation: [], purchaseOrder: [], purchaseServiceDelivery: [], materialReturn: [] };
  const tx: any = {};
  for (const [model, rows] of Object.entries(facts)) {
    const matches = (row: any, where: any): boolean => Object.entries(where).every(([key, value]) => {
      if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
      if (key === 'OR') return (value as any[]).some(part => matches(row, part));
      if (value && typeof value === 'object') return (value as any).in ? (value as any).in.includes(row[key]) : true;
      return value === null ? row[key] == null : row[key] === value;
    });
    tx[model] = { findFirst: vi.fn(async ({ where }: any) => rows.find(row => matches(row, where)) || null),
      findMany: vi.fn(async ({ where }: any) => rows.filter(row => matches(row, where || {}))),
      count: vi.fn(async ({ where }: any) => rows.filter(row => matches(row, where || {})).length) };
  }
  return { facts, tx };
}
beforeEach(() => { authority.active = true; authority.scopes = ['invoices:read', 'invoices:reconcile', 'vouchers:read']; authority.kind = 'team';
  authority.access = { own: 'owner', team: 'team-read', hidden: 'none', payer: 'none' }; });

describe('Financial common current grants and actual source access', () => {
  it('business reads a finance-created invoice for its actual customer', async () => {
    const f = fixture(); expect((await requireFinanceInvoiceAccess(f.tx, actor, 'one')).invoice.id).toBe('one');
  });
  it('does not treat directory visibility, stale role names or financial ownership as L2 access', async () => {
    const f = fixture(); f.facts.invoice[0].customerRelationId = 'hidden'; f.facts.invoice[0].ownerId = 'sales';
    await expect(requireFinanceInvoiceAccess(f.tx, actor, 'one')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('honors actual self vs team financial scope', async () => {
    const f = fixture(); f.facts.invoice[0].customerRelationId = 'team';
    expect((await requireFinanceInvoiceAccess(f.tx, actor, 'one')).invoice.id).toBe('one'); authority.kind = 'self';
    await expect(requireFinanceInvoiceAccess(f.tx, actor, 'one')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('filters before pagination/count and ignores cancelled query tricks', async () => {
    const f = fixture(); f.facts.invoice.push(inv('secret', { customerRelationId: 'hidden' }), inv('unknown', { sourceType: 'UnregisteredProducer', sourceId: 'dev' }));
    const result = await visibleFinanceInvoiceWhere(f.tx, actor, { deletedAt: null });
    expect(result.where).toEqual({ AND: [{ deletedAt: null }, { id: { in: ['one'] } }] });
    expect(f.tx.invoice.findMany).toHaveBeenCalledWith({ where: { deletedAt: null } });
  });
  it('all-finance actual scope includes historical unknown producers', async () => {
    const f = fixture(); authority.kind = 'all'; f.facts.invoice[0].sourceType = 'LegacyProducer'; f.facts.invoice[0].sourceId = 'legacy';
    expect((await requireFinanceInvoiceAccess(f.tx, actor, 'one')).invoice.id).toBe('one');
  });
  it('fails closed on unknown sources even with an accessible customer', async () => {
    const f = fixture(); f.facts.invoice[0].sourceType = 'Unknown'; f.facts.invoice[0].sourceId = 'dev';
    await expect(requireFinanceInvoiceAccess(f.tx, actor, 'one')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('follows exact Scene, billing and nested cost parents, rejecting hidden parents and cycles', async () => {
    const f = fixture(); Object.assign(f.facts.invoice[0], { sourceType: 'Scene', sourceId: 'dev_cost:dev' });
    f.facts.invoiceLine.push({ invoiceId: 'one', sourceType: 'CostRecord', sourceId: 'c1' });
    f.facts.costRecord.push({ id: 'c1', sourceType: 'CostRecord', sourceId: 'c2' }, { id: 'c2', sourceType: 'DevelopmentCase', sourceId: 'dev' });
    await requireFinanceInvoiceAccess(f.tx, actor, 'one');
    f.facts.costRecord[1].sourceId = 'hidden-dev';
    await expect(requireFinanceInvoiceAccess(f.tx, actor, 'one')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    Object.assign(f.facts.costRecord[1], { sourceType: 'CostRecord', sourceId: 'c1' });
    await expect(requireFinanceInvoiceAccess(f.tx, actor, 'one')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('authorizes every real order in a multi-order invoice', async () => {
    const f = fixture(); f.facts.invoiceOrderAllocation.push({ invoiceId: 'one', orderId: 'order' }, { invoiceId: 'one', orderId: 'hidden-order' });
    await expect(requireFinanceInvoiceAccess(f.tx, actor, 'one')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    f.facts.invoiceOrderAllocation.pop(); await requireFinanceInvoiceAccess(f.tx, actor, 'one');
  });
  it('checks current stored scopes, ceiling and disabled account', async () => {
    const f = fixture(); authority.scopes = []; await expect(requireFinanceInvoiceAccess(f.tx, actor, 'one')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    authority.scopes = ['invoices:read']; await expect(requireFinanceInvoiceAccess(f.tx, { ...actor, permissionCeiling: [] }, 'one')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    authority.active = false; await expect(requireFinanceInvoiceAccess(f.tx, actor, 'one')).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });
  it('rejects a mid-read scope change before disclosure', async () => {
    const f = fixture(), access = await createFinanceSourceAccess(f.tx, actor); authority.kind = 'all';
    await expect(access.finish()).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('permits a legitimate third-party receipt with actual financial scope', async () => {
    const f = fixture(); authority.kind = 'all';
    expect((await requireFinanceAllocationAccess(f.tx, actor, 'one', 'cash')).voucher.customerRelationId).toBe('payer');
  });
  it('denies an inaccessible receipt even when the invoice is visible', async () => {
    const f = fixture(); await expect(requireFinanceAllocationAccess(f.tx, actor, 'one', 'cash')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    f.facts.paymentVoucher[0].ownerId = 'colleague';
    await expect(requireFinanceAllocationAccess(f.tx, actor, 'one', 'cash')).rejects.toMatchObject({code: 'NOT_FOUND'});
    f.facts.paymentVoucher[0].customerRelationId = 'own'; await requireFinanceAllocationAccess(f.tx, actor, 'one', 'cash');
  });
  it('allocation queries expose only visible invoices even when a receipt pays several customers', async () => {
    const f = fixture(); f.facts.invoice.push(inv('secret', { customerRelationId: 'hidden' }));
    f.facts.invoiceAllocation.push({ id: 'visible-allocation', invoiceId: 'one', voucherId: 'cash' }, { id: 'secret-allocation', invoiceId: 'secret', voucherId: 'cash' });
    await expect(listVisibleFinanceAllocations(f.tx, actor, {voucherId: 'cash'})).rejects.toMatchObject({code: 'NOT_FOUND'});
    const result = await listVisibleFinanceAllocations(f.tx, actor, { invoiceId: 'one', limit: 1 });
    expect(result.items.map((row: any) => row.id)).toEqual(['visible-allocation']); expect(result.total).toBe(1);
    await expect(listVisibleFinanceAllocations(f.tx, actor, { invoiceId: 'secret' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('a current read grant never substitutes for reconcile permission', async () => {
    const f = fixture(); authority.scopes = ['invoices:read'];
    await expect(requireFinanceAllocationAccess(f.tx, actor, 'one', 'cash')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('does not turn failed L2 dependencies into access', async () => {
    const f = fixture(); f.tx.relation.findFirst.mockRejectedValue(new Error('database unavailable'));
    await expect(requireFinanceInvoiceAccess(f.tx, actor, 'one')).rejects.toThrow('database unavailable');
  });
});
