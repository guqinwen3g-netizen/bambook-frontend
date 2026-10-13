/** Real registered dispatch, loaders, L2 builder and domain read services.
 * Storage alone is substituted. No claim of real PG or complete Agent/UAT. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { registerNewDomainQueryTools } from '../newDomainQueryTools';
import { dispatchFromRegistry, type ToolExecutionContext } from '../toolDispatchRegistry';
import { resolveVisibleOrderIds } from '../../auth/orderVisibility';
import { __clearTeamShareCacheForTests } from '../../teams/teamShareService';

const userId = 'query-current-user';
const scopes = ['procurement:read', 'bom:read', 'customs:read'];
function account(grants = scopes, roleId = 'role-sales') {
  return { id: userId, status: 'active', deletedAt: null,
    roles: [{ roleId, role: { permissions: grants.map(scope => ({ permission: { scope } })) } }] };
}
function context(extra: any = {}): ToolExecutionContext {
  return { actor: { userId, roles: ['owner'], departmentIds: [], permissionScopes: ['*'],
    permissionsAuthoritative: true, memoryScopes: [], knowledgeScopes: [], toolScopes: [], ...extra } };
}
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (value == null) return row[key] == null;
    if (typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('has' in value) return (row[key] ?? []).includes(value.has);
      if ('contains' in value) return String(row[key] ?? '').includes(value.contains);
      return row[key] != null && matches(row[key], value);
    }
    return row[key] === value;
  });
}
function fixture() {
  __clearTeamShareCacheForTests();
  let current: any = account(), overrides: any[] = [], grants: any[] = [];
  const relations = [{ id: 'own', ownerId: userId, salesRepIds: [], deletedAt: null },
    { id: 'other', ownerId: 'someone', salesRepIds: [], deletedAt: null },
    { id: 'shared', ownerId: 'someone', salesRepIds: [], deletedAt: null }];
  const orders = ['own', 'other', 'shared'].map(name => ({ id: `order-${name}`, customerRelationId: name,
    ownerId: name === 'other' ? userId : 'someone', deletedAt: null }));
  const purchases = orders.map(order => ({ id: `po-${order.customerRelationId}`, poNumber: `PO-${order.customerRelationId}`,
    orderId: order.id, status: 'Confirmed', supplierName: 'Synthetic supplier', totalAmount: 987.4321,
    currency: 'CNY', deletedAt: null, lines: [], receipts: [] }));
  const boms = [...orders.map(order => ({ id: `bom-${order.customerRelationId}`, orderId: order.id })),
    { id: 'bom-library', orderId: null }].map(item => ({ ...item, bomNumber: item.id, description: 'Synthetic BOM',
      status: 'Confirmed', version: 2, deletedAt: null, currency: 'CNY', totalCost: 987.4321,
      totalMaterialCost: 900, totalLaborCost: 80, totalOverheadCost: 7.4321, profitAmount: 200, profitMargin: 20,
      lines: [{ id: 'line', unitCost: 900, amount: 900 }], costEstimates: [{ amount: 80 }] }));
  const allocations = [{ shipmentId: 'shipment-multi', orderId: 'order-own' }, { shipmentId: 'shipment-multi', orderId: 'order-other' },
    { shipmentId: 'shipment-hidden', orderId: 'order-other' }];
  const declarations = [
    { id: 'declaration-own', orderId: 'order-own', shipmentId: null },
    { id: 'declaration-other', orderId: 'order-other', shipmentId: null },
    { id: 'declaration-multi', orderId: null, shipmentId: 'shipment-multi' },
    { id: 'declaration-projection', orderId: 'order-other', shipmentId: 'shipment-multi' },
    { id: 'declaration-hidden', orderId: null, shipmentId: 'shipment-hidden' },
  ].map(item => ({ ...item, declarationNumber: item.id, type: 'Export', status: 'Draft', lines: [], deletedAt: null }));
  const storage = (rows: () => any[]) => vi.fn(async ({ where }: any) => rows().filter(row => matches(row, where)));
  const domain = (rows: any[]) => ({
    findMany: vi.fn(async ({ where, skip = 0, take }: any) => rows.filter(row => matches(row, where)).slice(skip, take == null ? undefined : skip + take)),
    count: vi.fn(async ({ where }: any) => rows.filter(row => matches(row, where)).length),
    findUnique: vi.fn(async ({ where }: any) => rows.find(row => row.id === where.id) ?? null),
    findFirst: vi.fn(async ({ where }: any) => rows.find(row => matches(row, where)) ?? null),
    create: vi.fn(), update: vi.fn(), delete: vi.fn(),
  });
  const prisma: any = {
    userAccount: { findFirst: vi.fn(async () => current) }, userPermissionOverrides: { findMany: storage(() => overrides) },
    relation: { findMany: storage(() => relations) }, teamMember: { findMany: vi.fn(async () => [{ teamId: 'team' }]) },
    teamDataGrant: { findMany: storage(() => grants) }, order: { findMany: storage(() => orders) },
    purchaseOrder: domain(purchases), bOM: domain(boms), customsDeclaration: domain(declarations),
    sample: domain([{ id: 'sample-pioneer', type: 'pioneer', sourceOrderId: 'order-own', deletedAt: null },
      { id: 'sample-ship', type: 'ship', sourceOrderId: 'order-own', deletedAt: null }]),
    taxRefund: domain([{ id: 'refund-own', refundNumber: 'TR-own', status: 'Draft', deletedAt: null }]),
    developmentCase: { findFirst: vi.fn(async () => null) },
    shipmentOrderAllocation: { findMany: storage(() => allocations) }, auditLog: { create: vi.fn() },
  };
  return { prisma, current: (value: any) => { current = value; }, override: (value: any[]) => { overrides = value; },
    share: () => { grants = [{ teamId: 'team', entityType: 'relation', entityId: 'shared', revokedAt: null, team: { deletedAt: null } }]; },
    revokeShare: () => { grants = []; } };
}
beforeAll(() => registerNewDomainQueryTools());
async function query(f: ReturnType<typeof fixture>, toolId: string, input: any = {}, serverContext: ToolExecutionContext | undefined = context()) {
  const dispatched = await dispatchFromRegistry(f.prisma, { toolId, input }, serverContext);
  expect(dispatched.hit).toBe(true);
  if (!dispatched.hit) throw Error('Actual handler not registered');
  return dispatched.result as any;
}
function noWrites(f: ReturnType<typeof fixture>) {
  for (const model of [f.prisma.purchaseOrder, f.prisma.bOM, f.prisma.customsDeclaration, f.prisma.sample, f.prisma.taxRefund]) {
    expect(model.create).not.toHaveBeenCalled(); expect(model.update).not.toHaveBeenCalled(); expect(model.delete).not.toHaveBeenCalled();
  }
  expect(f.prisma.auditLog.create).not.toHaveBeenCalled();
}

describe.each(['purchase_orders.query', 'bom.query'])('registered %s current authority', toolId => {
  const prefix = toolId === 'bom.query' ? 'bom' : 'po';
  it('missing server context cannot be supplied by forged input actor', async () => {
    const f = fixture();
    await expect(dispatchFromRegistry(f.prisma, { toolId, input: { actor: context().actor } }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.prisma.userAccount.findFirst).not.toHaveBeenCalled(); noWrites(f);
  });
  it('real callback propagates server actor, ignores forged owner input and scopes count/page/detail', async () => {
    const f = fixture(), forged = { actor: { userId: 'someone', roles: ['owner'], permissions: ['*'] } };
    const list = await query(f, toolId, { ...forged, limit: 1, offset: 0 });
    expect(list.items.map((item: any) => item.id)).toEqual([`${prefix}-own`]);
    expect(list.total).toBe(toolId === 'bom.query' ? 2 : 1);
    expect(f.prisma.userAccount.findFirst.mock.calls[0][0].where.id).toBe(userId);
    expect((await query(f, toolId, { ...forged, id: `${prefix}-other` })).errorCode).toBe('NOT_FOUND');
    expect((await query(f, toolId, { id: `${prefix}-own` })).ok).toBe(true); noWrites(f);
  });
  it('current role scope removal cannot be restored by stale server owner/scopes', async () => {
    const f = fixture(); f.current(account([], 'role-super-admin'));
    await expect(query(f, toolId)).rejects.toMatchObject({ code: 'FORBIDDEN' }); noWrites(f);
  });
  it('current loaded owner grants cannot exceed signed credential ceiling', async () => {
    const f = fixture(); f.current(account(scopes, 'role-super-admin'));
    await expect(query(f, toolId, {}, context({ permissionCeiling: ['orders:read'] }))).rejects.toMatchObject({ code: 'FORBIDDEN' }); noWrites(f);
  });
  it('current actual personal grant is usable, inactivity remains refused', async () => {
    const f = fixture(); f.current(account([]));
    f.override([{ userId, scope: toolId === 'bom.query' ? 'bom:read' : 'procurement:read', isActive: true, deletedAt: null, expiresAt: null }]);
    expect((await query(f, toolId)).ok).toBe(true);
    f.current({ ...account(), status: 'disabled' });
    await expect(query(f, toolId)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' }); noWrites(f);
  });
  it('fresh team share is usable and revocation cannot survive process read cache', async () => {
    const f = fixture(); f.share();
    expect((await query(f, toolId, { id: `${prefix}-shared` })).ok).toBe(true);
    f.revokeShare();
    expect((await query(f, toolId, { id: `${prefix}-shared` })).errorCode).toBe('NOT_FOUND'); noWrites(f);
  });
  it.each(['userAccount', 'userPermissionOverrides', 'teamMember', 'teamDataGrant', 'relation', 'order'])('%s failure is explicit unavailable, never success empty', async model => {
    const f = fixture();
    f.prisma[model][model === 'userAccount' ? 'findFirst' : 'findMany'].mockRejectedValue(new Error('private SQL credential fixture'));
    await expect(query(f, toolId)).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' }); noWrites(f);
  });
});

describe('BOM current sensitive cost contract', () => {
  it('detail preserves structure while masking costs/profit and removes amount from summary', async () => {
    const f = fixture(), result = await query(f, 'bom.query', { id: 'bom-own' });
    expect(result.item).toMatchObject({ id: 'bom-own', totalCost: null, totalMaterialCost: null, totalLaborCost: null,
      totalOverheadCost: null, profitAmount: null, profitMargin: null, lines: [{ id: 'line', unitCost: null, amount: null }], costEstimates: [{ amount: null }] });
    expect(result.summary).not.toContain('987.4321'); expect(result.summary).not.toContain('总成本');
    noWrites(f);
  });
  it('explicit current cost permission exposes actual detail but ceiling/withdrawal masks it', async () => {
    const f = fixture(); f.current(account([...scopes, 'sensitive:cost']));
    expect((await query(f, 'bom.query', { id: 'bom-own' })).item.lines[0].unitCost).toBe(900);
    const limited = await query(f, 'bom.query', { id: 'bom-own' }, context({ permissionCeiling: scopes }));
    expect(limited.item.totalCost).toBeNull(); expect(limited.summary).not.toContain('987.4321');
    f.current(account(scopes)); expect((await query(f, 'bom.query', { id: 'bom-own' })).item.profitAmount).toBeNull(); noWrites(f);
  });
  it('unlinked library BOM stays available under the existing human contract', async () => {
    const f = fixture(); expect((await query(f, 'bom.query', { id: 'bom-library' })).ok).toBe(true); noWrites(f);
  });
  it('default human resolver fail-closed compatibility is preserved while strict rejects', async () => {
    const f = fixture(); f.prisma.order.findMany.mockRejectedValue(new Error('private SQL'));
    const actor: any = { userId, roles: ['sales'], permissions: scopes, authorizationLoaded: true };
    expect(await resolveVisibleOrderIds(f.prisma, actor)).toEqual([]);
    await expect(resolveVisibleOrderIds(f.prisma, actor, { strict: true, fresh: true })).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  });
});


describe('registered customs declaration Order/ShipmentAllocation parity', () => {
  it('list/count/page and guessed detail use both actual order and multi-order allocation anchors', async () => {
    const f = fixture(), result = await query(f, 'customs.query_declarations', { limit: 2, offset: 1 });
    expect(result.total).toBe(3); expect(result.items.map((item: any) => item.id)).toEqual(['declaration-multi', 'declaration-projection']);
    for (const id of ['declaration-own', 'declaration-multi', 'declaration-projection']) expect((await query(f, 'customs.query_declarations', { id })).ok).toBe(true);
    for (const id of ['declaration-other', 'declaration-hidden', 'declaration-missing']) expect((await query(f, 'customs.query_declarations', { id })).errorCode).toBe('NOT_FOUND');
    noWrites(f);
  });
  it('missing trusted context or revoked/capped current module grants cannot be restored by input', async () => {
    const f = fixture();
    await expect(dispatchFromRegistry(f.prisma, { toolId: 'customs.query_declarations', input: { actor: context().actor } })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    f.current(account(scopes.filter(scope => scope !== 'customs:read')));
    await expect(query(f, 'customs.query_declarations')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.current(account(scopes, 'role-super-admin'));
    await expect(query(f, 'customs.query_declarations', {}, context({ permissionCeiling: ['bom:read'] }))).rejects.toMatchObject({ code: 'FORBIDDEN' }); noWrites(f);
  });
  it('legitimate current all-scope personnel may read all declarations under the existing human contract', async () => {
    const f = fixture(); f.current(account(scopes, 'role-finance'));
    expect((await query(f, 'customs.query_declarations')).total).toBe(5); noWrites(f);
  });
  it('allocation query fault is unavailable rather than partial/empty success', async () => {
    const f = fixture(); f.prisma.shipmentOrderAllocation.findMany.mockRejectedValue(new Error('private SQL'));
    await expect(query(f, 'customs.query_declarations')).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' }); noWrites(f);
  });
  it.each(['list', 'detail'])('unexpected declaration %s source error is safe500, never NOT_FOUND', async mode => {
    const f = fixture(); f.prisma.customsDeclaration[mode === 'detail' ? 'findFirst' : 'findMany'].mockRejectedValue(new Error('private SQL table name'));
    await expect(query(f, 'customs.query_declarations', mode === 'detail' ? { id: 'declaration-own' } : {}))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500, message: '服务器内部错误，请稍后重试。' }); noWrites(f);
  });
});


describe('registered sample/tax-refund query result truth', () => {
  it.each(['fabric_shipment', 'early_production'])('%s real source rows or real empty remain usable', async mode => {
    const f = fixture(), result = await query(f, 'samples.query', { mode, orderId: 'order-own' });
    expect(result.ok).toBe(true); expect(result.items).toHaveLength(1);
    const empty = await query(f, 'samples.query', { mode, orderId: 'order-empty' });
    expect(empty).toMatchObject({ ok: true, items: [] }); noWrites(f);
  });
  it.each(['fabric_shipment', 'early_production', 'garment_rounds'])('%s storage rejection cannot become empty success', async mode => {
    const f = fixture();
    if (mode === 'garment_rounds') f.prisma.developmentCase.findFirst.mockRejectedValue(new Error('private SQL'));
    else f.prisma.sample.findMany.mockRejectedValue(new Error('private SQL'));
    await expect(query(f, 'samples.query', { mode, orderId: 'order-own', caseId: 'case' }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500, message: '服务器内部错误，请稍后重试。' }); noWrites(f);
  });
  it('native missing garment case remains a real missing result', async () => {
    const f = fixture(); expect((await query(f, 'samples.query', { mode: 'garment_rounds', caseId: 'missing-case' })).errorCode).toBe('NOT_FOUND'); noWrites(f);
  });
  it('native refund success/empty/missing are distinguished from storage failure', async () => {
    const f = fixture(); expect((await query(f, 'customs.query_tax_refunds', { id: 'refund-own' })).ok).toBe(true);
    expect((await query(f, 'customs.query_tax_refunds', { id: 'refund-missing' })).errorCode).toBe('NOT_FOUND');
    expect(await query(f, 'customs.query_tax_refunds', { search: 'absent' })).toMatchObject({ ok: true, total: 0, items: [] }); noWrites(f);
  });
  it.each(['findFirst', 'findMany'])('refund %s storage failure is safe500, never missing/empty', async method => {
    const f = fixture(); f.prisma.taxRefund[method].mockRejectedValue(new Error('private SQL refund column'));
    await expect(query(f, 'customs.query_tax_refunds', method === 'findFirst' ? { id: 'refund-own' } : {}))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500, message: '服务器内部错误，请稍后重试。' }); noWrites(f);
  });
});
