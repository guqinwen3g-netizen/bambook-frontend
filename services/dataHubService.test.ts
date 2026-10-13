// @vitest-environment jsdom
// Actual snapshot loader/boundary; API storage/HTTP adapters are substituted.
// This proves frontend authorization selection and lifecycle, not server L2/PG.
import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  listOrdersPage: vi.fn(), listRelationsPage: vi.fn(), listProductAssetsPage: vi.fn(),
  listInvoicesPage: vi.fn(), listPaymentVouchersPage: vi.fn(), listShipmentsPage: vi.fn(),
  listDevelopmentCasesPage: vi.fn(), fetchCloudData: vi.fn(), listProducts: vi.fn(),
  listOrders: vi.fn(), listRelations: vi.fn(), postCloudData: vi.fn(), subscribeToDataChanges: vi.fn(),
}));
vi.mock('./apiService', () => ({ apiService: api }));
import { canReadDataHubDomain, createDataHubBoundary, dataHubContextKey, dataHubService } from './dataHubService';
import type { AuthState } from './authService';
const actor = (permissions: string[], extra = {}) => ({ id: 'qc', permissions, ...extra });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  vi.resetAllMocks();
  for (const name of ['listOrdersPage', 'listRelationsPage', 'listInvoicesPage', 'listPaymentVouchersPage', 'listShipmentsPage', 'listDevelopmentCasesPage'] as const) api[name].mockResolvedValue({ items: [], total: 0 });
  api.listProductAssetsPage.mockResolvedValue({ assets: [], total: 0 });
  api.fetchCloudData.mockResolvedValue([]);
});
describe('snapshot action scopes and failure meaning', () => {
  it('QC orders/products snapshot does not request invoices/vouchers or restore owner scopes', async () => {
    api.listOrdersPage.mockResolvedValue({ items: [{ id: 'qc-order' }], total: 1 });
    const snapshot = await dataHubService.pullSnapshot('dc', actor(['orders:read', 'products:read'], { roles: ['owner'] }));
    expect(snapshot.orders).toEqual([{ id: 'qc-order' }]);
    expect(snapshot.domains.orders.status).toBe('loaded');
    expect(snapshot.domains.invoices.status).toBe('not_requested');
    expect(snapshot.domains['payment-vouchers'].status).toBe('not_requested');
    expect(api.listInvoicesPage).not.toHaveBeenCalled(); expect(api.listPaymentVouchersPage).not.toHaveBeenCalled();
    expect(api.listRelationsPage).not.toHaveBeenCalled();
    expect(api.fetchCloudData.mock.calls).toEqual([['/api/product-categories', 'dc']]);
    expect(api.listProducts).not.toHaveBeenCalled();
  });
  it('explicit empty grants are authoritative; a ceiling also limits wildcard grants', async () => {
    const snapshot = await dataHubService.pullSnapshot('dc', actor([]));
    expect(Object.values(snapshot.domains).every(item => item.status === 'not_requested')).toBe(true);
    expect(api.listOrdersPage).not.toHaveBeenCalled();
    expect(canReadDataHubDomain(actor(['*'], { permissionCeiling: ['orders:read'] }), 'invoices')).toBe(false);
    expect(canReadDataHubDomain(actor(['*'], { permissionCeiling: ['orders:read'] }), 'orders')).toBe(true);
    expect(canReadDataHubDomain(actor(['*'], { permissionCeiling: [] }), 'orders')).toBe(false);
  });
  it('successful zero is loaded zero, while authorized 403 is failed with other successes preserved', async () => {
    api.listInvoicesPage.mockRejectedValue(Object.assign(new Error('internal forbidden detail'), { status: 403 }));
    api.listOrdersPage.mockResolvedValue({ items: [{ id: 'legitimate' }], total: 1 });
    const snapshot = await dataHubService.pullSnapshot('dc', actor(['orders:read', 'invoices:read', 'vouchers:read']));
    expect(snapshot.orders).toEqual([{ id: 'legitimate' }]); expect(snapshot.meta?.ordersTotal).toBe(1);
    expect(snapshot.invoices).toEqual([]); expect(snapshot.domains.invoices).toEqual({ status: 'failed', httpStatus: 403 });
    expect(snapshot.paymentVouchers).toEqual([]); expect(snapshot.domains['payment-vouchers']).toEqual({ status: 'loaded' });
    expect(JSON.stringify(snapshot)).not.toContain('internal forbidden detail');
  });
  it('formal empty products remain empty without legacy fallback', async () => {
    api.listProducts.mockResolvedValue([{ id: 'old-global-product' }]);
    const snapshot = await dataHubService.pullSnapshot('dc', actor(['products:read']));
    expect(snapshot.products).toEqual([]); expect(snapshot.domains.products.status).toBe('loaded');
    expect(api.listProducts).not.toHaveBeenCalled();
  });
  it('legacy null/invalid response is failed, not a loaded empty collection', async () => {
    api.fetchCloudData.mockResolvedValue(null);
    const snapshot = await dataHubService.pullSnapshot('dc', actor(['knowledge:read']));
    expect(snapshot.knowledge).toEqual([]); expect(snapshot.domains.knowledge.status).toBe('failed');
    expect(snapshot.domains.insights.status).toBe('failed');
  });
  it('relations and products page fully and retain authoritative order zero', async () => {
    api.listRelationsPage.mockImplementation(async (_endpoint, params) => ({ items: params.offset === 0 ? [{ id: 'r1' }] : [{ id: 'r2' }], total: 2 }));
    api.listProductAssetsPage.mockImplementation(async (_endpoint, params) => ({ assets: params.offset === 0 ? [{ id: 'p1' }] : [{ id: 'p2' }], total: 2 }));
    const snapshot = await dataHubService.pullSnapshot('dc', actor(['orders:read', 'relations:read', 'products:read']));
    expect(snapshot.meta?.ordersTotal).toBe(0); expect(snapshot.relations.map(row => row.id)).toEqual(['r1', 'r2']);
    expect(snapshot.products.map(row => row.id)).toEqual(['p1', 'p2']);
    expect(api.listRelationsPage).toHaveBeenLastCalledWith('dc', { limit: 200, offset: 1 });
  });
  it('an incomplete second page does not publish a partial list as complete', async () => {
    api.listOrdersPage.mockResolvedValueOnce({ items: [{ id: 'partial' }], total: 2 }).mockResolvedValueOnce({ items: [], total: 2 });
    const snapshot = await dataHubService.pullSnapshot('dc', actor(['orders:read']));
    expect(snapshot.orders).toEqual([]); expect(snapshot.domains.orders.status).toBe('failed');
    expect(snapshot.meta?.ordersTotal).toBeUndefined();
  });
});
describe('identity/permission/endpoint response and cache boundary', () => {
  const state = (permissions = ['orders:read']): AuthState => ({ isAuthenticated: true, isLoading: false, user: { id: 'same-user', displayName: 'User', email: 'u@example.test', roles: ['viewer'], permissions, departmentIds: ['dept-a'], department: 'A' } });
  it('keys change on identity, scope, department, endpoint, credential or logout, never array ordering', () => {
    const first = dataHubContextKey(state(['orders:read', 'products:read']), 'a', { Authorization: 'private-token-a' });
    expect(dataHubContextKey(state(['products:read', 'orders:read']), 'a', { Authorization: 'private-token-a' })).toBe(first);
    const variations = [state([]), { ...state(), user: { ...state().user!, id: 'other' } }, { ...state(), user: { ...state().user!, departmentIds: ['b'] } }, { ...state(), isAuthenticated: false, user: null }];
    for (const next of variations) expect(dataHubContextKey(next, 'a', { Authorization: 'private-token-a' })).not.toBe(first);
    expect(dataHubContextKey(state(), 'b', {})).not.toBe(dataHubContextKey(state(), 'a', {}));
    expect(dataHubContextKey(state(), 'a', { Authorization: 'new' })).not.toBe(dataHubContextKey(state(), 'a', { Authorization: 'old' }));
  });
  it('same-account permission withdrawal and out-of-order refreshes invalidate responses', () => {
    const boundary = createDataHubBoundary(); const old = boundary.capture('full');
    expect(boundary.isCurrent(old, 'full')).toBe(true); boundary.change('restricted');
    expect(boundary.isCurrent(old, 'restricted')).toBe(false);
    const first = boundary.capture('restricted'); const newer = boundary.capture('restricted');
    expect(boundary.isCurrent(first, 'restricted')).toBe(false); expect(boundary.isCurrent(newer, 'restricted')).toBe(true);
  });
  it('actual DTO roleIds or ceiling changes invalidate the same account even with unchanged legacy roles and scopes', () => {
    const withRoles = (roleIds: string[]): AuthState => ({ ...state(), user: { ...state().user!, roleIds } });
    const key = dataHubContextKey(withRoles(['role-a', 'role-b']), 'dc', {});
    expect(dataHubContextKey(withRoles(['role-b', 'role-a']), 'dc', {})).toBe(key);
    const changed = dataHubContextKey(withRoles(['role-c']), 'dc', {});
    expect(changed).not.toBe(key);
    const boundary = createDataHubBoundary(), old = boundary.capture(key);
    boundary.change(changed); expect(boundary.isCurrent(old, changed)).toBe(false);
    expect(dataHubContextKey({ ...withRoles(['role-a', 'role-b']), user: { ...withRoles(['role-a', 'role-b']).user!, permissionCeiling: [] } }, 'dc', {})).not.toBe(key);
  });
  it('old persistence already in flight is followed by clear before new persistence', async () => {
    const boundary = createDataHubBoundary(); let key = 'old'; const events: string[] = []; const gate = deferred<void>();
    const old = boundary.capture(key);
    const oldWrite = boundary.persist(old, () => key, async () => { events.push('old-start'); await gate.promise; events.push('old-end'); });
    await Promise.resolve(); key = 'new'; boundary.change(key);
    const clear = boundary.clearCache(async () => { events.push('clear'); }); const fresh = boundary.capture(key);
    const newWrite = boundary.persist(fresh, () => key, async () => { events.push('new'); });
    gate.resolve(); await Promise.all([oldWrite, clear, newWrite]);
    expect(events).toEqual(['old-start', 'old-end', 'clear', 'new']);
  });
  it('old queued persistence is skipped, even before the new response arrives', async () => {
    const boundary = createDataHubBoundary(); let key = 'old'; const old = boundary.capture(key); const write = vi.fn(async () => undefined);
    const pending = boundary.persist(old, () => key, write); key = 'logged-out'; boundary.change(key);
    await pending; expect(write).not.toHaveBeenCalled();
  });
});
