// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { isWorkbenchTarget } from './dashboardTaskService';
import { releaseService } from './releaseService';
const originalFetch = globalThis.fetch;
const s = vi.hoisted(() => ({ endpoint: 'http://exact-context.invalid/api' }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: s.endpoint }), buildApiUrl: (path: string, base: string) => base + path, getAuthHeaders: () => ({ Authorization: 'Bearer synthetic-context' }) } }));
const target = { kind: 'release-request', requestId: 'REQUEST-A', scopeId: 'SCOPE-A', orderId: 'ORDER-A', orderLineId: 'LINE-A' };
const context = (): any => ({ request: { id: 'REQUEST-A', scopeId: 'SCOPE-A', scopeRevision: 1, requestRevision: 1, state: 'pending', createdAt: '1790873426000', updatedAt: '1790873426000' }, scope: { id: 'SCOPE-A', orderId: 'ORDER-A', orderLineId: 'LINE-A', scopeRevision: 1, state: 'no_release', classification: 'current', quantity: '100.0001', unit: 'PC', productionBatchId: 'PB-A', productionBatchRevision: 1 }, line: { id: 'LINE-A', orderId: 'ORDER-A', label: null, quantity: '100.0001', unit: 'PC' }, allowedRoles: ['business'], canSign: true, blockedReasons: [] });
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, item: context() }), { status: 200 }))); });
afterEach(() => vi.unstubAllGlobals());
it('NEW strict release and QC targets accept only their precise ID objects', () => {
 expect(isWorkbenchTarget(target)).toBe(true); expect(isWorkbenchTarget({ kind: 'qc-report', reportId: 'REPORT-A', orderId: 'ORDER-A' })).toBe(true);
 for (const key of ['requestId', 'scopeId', 'orderId', 'orderLineId']) { expect(isWorkbenchTarget({ ...target, [key]: ' ' })).toBe(false); expect(isWorkbenchTarget({ ...target, [key]: ' bad' })).toBe(false); const missing = { ...target }; delete (missing as any)[key]; expect(isWorkbenchTarget(missing)).toBe(false); }
 expect(isWorkbenchTarget({ ...target, actorId: 'other' })).toBe(false); expect(isWorkbenchTarget({ kind: 'qc-report', reportId: 'REPORT-A', orderId: 'ORDER-A', section: 'reports' })).toBe(false);
});
it('NEW actual minimal context HTTP preserves exact decimal and relationships and uses only JWT GET', async () => {
 const item = await (releaseService as any).getRequestActionContext('REQUEST-A'); expect(item).toEqual(context());
 expect(fetch).toHaveBeenCalledWith('http://exact-context.invalid/api/v1/releases/release-requests/REQUEST-A/action-context', expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer synthetic-context' } }));
 expect(item.scope.quantity).toBe('100.0001');
});
it.each([
 ['request identity', (row: any) => row.request.id = 'OTHER'],
 ['scope relationship', (row: any) => row.request.scopeId = 'OTHER'],
 ['line relationship', (row: any) => row.line.id = 'OTHER'],
 ['order relationship', (row: any) => row.line.orderId = 'OTHER'],
 ['numeric quantity', (row: any) => row.scope.quantity = 100.0001],
 ['unsafe revision', (row: any) => row.request.requestRevision = Number.MAX_SAFE_INTEGER + 1],
 ['string revision', (row: any) => row.scope.scopeRevision = '1'],
 ['foreign role', (row: any) => row.allowedRoles = ['admin']],
 ['duplicate role', (row: any) => row.allowedRoles = ['business','business']],
 ['contradictory sign state', (row: any) => row.request.state = 'granted'],
 ['missing native batch revision', (row: any) => row.scope.productionBatchRevision = null],
 ['extra HR property', (row: any) => row.hr = { email: 'other@invalid' }],
] as Array<[string,(row:any)=>void]>)('NEW malformed %s context rejects without a partial entity', async (_name, change) => {
 const item = context(); change(item); vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true, item }),{status:200})); await expect((releaseService as any).getRequestActionContext('REQUEST-A')).rejects.toThrow('无法核验');
});
it.each([404, 500, 503])('NEW HTTP %s denial preserves explicit backend contract without a success entity', async status => {
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ok:false,error:{code:'CONTEXT_UNAVAILABLE',message:'原申请当前无法读取',status}}),{status})); await expect((releaseService as any).getRequestActionContext('REQUEST-A')).rejects.toThrow('原申请当前无法读取');
});
it('NEW minimal reader uses actual local HTTP server with original JWT and no order-summary request', async () => {
 const { createServer } = await import('node:http'); const nativeFetch = originalFetch;
 const requests: any[] = []; const server = createServer((req, res) => { requests.push({method:req.method,path:req.url,authorization:req.headers.authorization}); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ok:true,item:context()})); });
 await new Promise<void>((resolve,reject)=>{ server.once('error',reject); server.listen(0,'127.0.0.1',resolve); }); const address = server.address() as import('node:net').AddressInfo; const old = s.endpoint; s.endpoint = `http://127.0.0.1:${address.port}/api`; vi.stubGlobal('fetch',nativeFetch);
 try { const item = await (releaseService as any).getRequestActionContext('REQUEST-A'); expect(item.scope.quantity).toBe('100.0001'); expect(requests).toEqual([{method:'GET',path:'/api/v1/releases/release-requests/REQUEST-A/action-context',authorization:'Bearer synthetic-context'}]); }
 finally { s.endpoint = old; server.closeAllConnections(); await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});

it('NEW historical legacy context preserves empty native unit and null revision without making it executable', async () => { const item = context(); item.scope.classification='historical'; item.scope.unit=''; item.line.unit=''; item.scope.productionBatchRevision=null; item.canSign=false; item.blockedReasons=['历史来源']; vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ok:true,item}),{status:200})); const loaded=await (releaseService as any).getRequestActionContext('REQUEST-A'); expect(loaded.scope.unit).toBe(''); expect(loaded.scope.productionBatchRevision).toBeNull(); expect(loaded.canSign).toBe(false); });

it('NEW current legacy empty unit preserves original server signing classification without inventing a unit policy',async()=>{const item=context();item.scope.unit='';item.line.unit='';vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ok:true,item}),{status:200}));const loaded=await (releaseService as any).getRequestActionContext('REQUEST-A');expect(loaded.scope.unit).toBe('');expect(loaded.canSign).toBe(true);});
