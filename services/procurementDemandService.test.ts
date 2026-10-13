// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ actorId: 'BUYER', endpoint: 'https://synthetic.invalid/api', permissions: ['procurement:read', 'procurement:write'], ceiling: undefined as string[] | undefined }));
vi.mock('./authService', () => ({ getAuthState: () => ({ isAuthenticated: true, user: { id: state.actorId, roles: ['sales'], permissions: state.permissions, permissionCeiling: state.ceiling } }) }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: state.endpoint }), getAuthHeaders: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.actorId }),
  buildApiUrl: (path: string, endpoint = state.endpoint) => endpoint + path } }));
import { procurementDemandService, type ProcurementDemand } from './procurementDemandService';
const demand: ProcurementDemand = { id: 'D1', kind: 'ProcessingService', orderId: 'O1', orderLineId: 'L1', bomId: null, bomLineId: null, description: 'Exact processing requirement', unit: 'M',
  requiredQuantity: '100', allocatedQuantity: '30.125', remainingQuantity: '69.875', assigneeId: 'BUYER', status: 'Ready', revision: 4,
  allocations: [{ id: 'A1', purchaseOrderId: null, purchaseLineId: null, outsourcingOrderId: 'OS1', outsourcingLineId: 'OL1', contractKind: 'processing', contractNumber: 'OS-EXACT', nativeContract: true,
    supplierName: 'Actual processor', quantity: '30.125', status: 'Active' }] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { state.actorId = 'BUYER'; state.endpoint = 'https://synthetic.invalid/api'; state.permissions = ['procurement:read', 'procurement:write']; state.ceiling = undefined; });
afterEach(() => vi.unstubAllGlobals());
describe('current procurement demand transport', () => {
  it('reads the real legacy envelope and retains separate nullable purchase and exact processing identities', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ items: [demand], total: 2, hasMore: true })); vi.stubGlobal('fetch', fetcher);
    expect(await procurementDemandService.list(1)).toEqual({ items: [demand], total: 2, hasMore: true });
    expect(fetcher.mock.calls[0][0]).toBe('https://synthetic.invalid/api/v1/procurement/demands?offset=1&limit=100');
  });
  it('uses the original explicit source and request key without manufacturing a total or allocation', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ demand: { ...demand, sourceKey: 'manual:BUYER:ORIGINAL' } }, 201)); vi.stubGlobal('fetch', fetcher);
    const body = { kind: 'ProcessingService' as const, orderId: 'O1', orderLineId: 'L1', description: 'Explicit requirement', unit: 'M', requestKey: 'ORIGINAL' };
    await procurementDemandService.create(body);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(body); expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer BUYER');
  });
  it.each(['missing', 'source', 'key'] as const)('does not acknowledge a %s creation receipt as the original successful requirement', async problem => {
    const value = { ...demand, sourceKey: 'manual:BUYER:ORIGINAL', ...(problem === 'source' ? { orderId: 'FOREIGN' } : problem === 'key' ? { sourceKey: 'manual:OTHER:FOREIGN' } : {}) };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(problem === 'missing' ? {} : { demand: value }, 201)));
    await expect(procurementDemandService.create({ kind: 'ProcessingService', orderId: 'O1', orderLineId: 'L1', description: 'Explicit requirement', unit: 'M', requestKey: 'ORIGINAL' })).rejects.toThrow('原请求');
  });
  it('preserves a structured business refusal for recovery without treating it as a success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'SOURCE_APPROVAL_PENDING', message: '来源主单审批处理中' } }, 409)));
    await expect(procurementDemandService.claim('D1', 4)).rejects.toMatchObject({ status: 409, code: 'SOURCE_APPROVAL_PENDING', message: '来源主单审批处理中' });
  });
  it.each(['actor', 'endpoint', 'ceiling'] as const)('discards a late response after the current %s changes', async field => {
    let finish!: (value: Response) => void; vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const pending = procurementDemandService.list();
    if (field === 'actor') state.actorId = 'OTHER'; else if (field === 'endpoint') state.endpoint = 'https://other.invalid/api'; else state.ceiling = ['procurement:read'];
    finish(response({ items: [demand] })); await expect(pending).rejects.toThrow('已变化');
  });
  it('also discards old-account private data if identity changes while JSON is being read', async () => {
    const value = response({ items: [demand] }); vi.spyOn(value, 'json').mockImplementation(async () => { state.actorId = 'OTHER'; return { items: [demand] }; });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(value)); await expect(procurementDemandService.list()).rejects.toThrow('已变化');
  });
  it('never sends a stored old allocator intent to any HTTP writer', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(procurementDemandService.allocate('D1', { revision: 4, requestKey: 'OLD', supplierRelationId: 'SUP', quantity: '1', unitPrice: '2', currency: 'CNY' }))
      .rejects.toMatchObject({ status: 409, code: 'NATIVE_SUPPLIER_CONTRACT_REQUIRED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
