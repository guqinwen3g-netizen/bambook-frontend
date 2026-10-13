// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const seam = vi.hoisted(() => ({ user: { id: 'me', roles: [], roleIds: ['role-qc'], permissions: ['qc:read'], permissionCeiling: undefined as string[] | undefined }, endpoint: 'http://private.invalid/api', token: 'original', listeners: new Set<() => void>() }));
vi.mock('./authService', () => ({ getAuthState: () => ({ isAuthenticated: true, user: seam.user }), subscribe: (fn: () => void) => { seam.listeners.add(fn); fn(); return () => seam.listeners.delete(fn); } }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: seam.endpoint }), getAuthHeaders: () => ({ Authorization: 'Bearer ' + seam.token }), buildApiUrl: (path: string, endpoint: string) => endpoint + path } }));
import { dashboardTaskService, parsePersonalWorkbench, isWorkbenchTarget } from './dashboardTaskService';
const dto = () => ({ schemaVersion: 1, subject: { userId: 'me', displayName: 'Worker', roleIds: ['role-qc'], roleLabels: ['QC'] }, businessDate: '2026-10-02', generatedAt: '2026-10-02T01:00:00Z', groups: [{ key: 'qc', label: '我的检验', status: 'ready', items: [], total: 0, hasMore: false, nextCursor: null, error: null }] });
const notify = () => seam.listeners.forEach(fn => fn());
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
beforeEach(() => { seam.user = { id: 'me', roles: [], roleIds: ['role-qc'], permissions: ['qc:read'], permissionCeiling: undefined }; seam.token = 'original'; seam.endpoint = 'http://private.invalid/api'; seam.listeners.clear(); });
afterEach(() => vi.unstubAllGlobals());
describe('Personal dashboard readonly DTO/client boundary', () => {
    it('keeps exact string amounts and source versions without Number conversion', () => { const d: any = dto(); d.groups[0].total = 1; d.groups[0].items = [{ id: 'Invoice:i1:balance', kind: 'balance', title: 'INV1', bucket: 'follow-up', source: { type: 'Invoice', id: 'i1', state: 'Issued', version: '9007199254740993' }, reference: null, responsibility: { kind: 'scope-visible', userId: null }, dueDate: null, timeBucket: 'undated', reason: 'Balance', amounts: [{ amount: '90071992547409.0001', currency: 'USD', meaning: '未核销金额', visibility: 'visible' }], target: { kind: 'invoice', invoiceId: 'i1', tab: 'invoices' }, blockedReason: null }]; expect(parsePersonalWorkbench(d, 'me').groups[0].items?.[0].amounts[0].amount).toBe('90071992547409.0001'); });
    it('rejects a response belonging to another account', () => { expect(() => parsePersonalWorkbench(dto(), 'other')).toThrow('响应不完整'); });
    it('unknown provider cannot claim a zero total', () => { const d: any = dto(); d.groups[0] = { ...d.groups[0], status: 'failed', items: null, error: { code: 'ERROR', message: 'Retry', retryable: true } }; expect(() => parsePersonalWorkbench(d, 'me')).toThrow('响应不完整'); });
    it('valid failed provider remains unknown', () => { const d: any = dto(); d.groups[0] = { ...d.groups[0], status: 'failed', items: null, total: null, hasMore: null, nextCursor: null, error: { code: 'ERROR', message: 'Retry', retryable: true } }; expect(parsePersonalWorkbench(d, 'me').groups[0].total).toBeNull(); });
    it('rejects numeric money instead of formatting already lost precision', () => { const d: any = dto(); d.groups[0].total = 1; d.groups[0].items = [{ id: 'i', title: 'Invoice', kind: 'balance', bucket: 'risk', source: { type: 'Invoice', id: 'i', state: 'Issued', version: null }, reference: null, responsibility: { kind: 'scope-visible', userId: null }, dueDate: null, timeBucket: 'undated', reason: 'Balance', amounts: [{ amount: 0.1, currency: 'USD', meaning: 'Balance', visibility: 'visible' }], target: null, blockedReason: null }]; expect(() => parsePersonalWorkbench(d, 'me')).toThrow('响应不完整'); });
    it('all 12 target kinds require their exact native ids and original tab', () => {
        const targets = [{ kind: 'order', orderId: 'o' }, { kind: 'development', caseId: 'd', section: 'fees' }, { kind: 'sample', sampleId: 's' }, { kind: 'quotation', quotationId: 'q' }, { kind: 'qc-assignment', assignmentId: 'a', orderId: 'o' }, { kind: 'shipment', shipmentId: 's', section: 'packing' }, { kind: 'inventory-item', inventoryItemId: 'i' }, { kind: 'invoice', invoiceId: 'i', tab: 'invoices' }, { kind: 'billing-item', billingItemId: 'b', tab: 'billingItems' }, { kind: 'claim', caseId: 'c' }, { kind: 'approval', approvalId: 'p' }, { kind: 'workflow', instanceId: 'w', stepId: 'step' }];
        expect(targets.every(isWorkbenchTarget)).toBe(true);
        expect(isWorkbenchTarget({ kind: 'workflow', instanceId: 'w' })).toBe(false);
        expect(isWorkbenchTarget({ kind: 'billing-item', billingItemId: 'b', tab: 'invoices' })).toBe(false);
    });
    it('development QC requires all three exact identities and rejects a fabricated order',()=>{const target={kind:'development-qc-review',reviewId:'r',caseId:'c',sampleVersionId:'v'};expect(isWorkbenchTarget(target)).toBe(true);expect(isWorkbenchTarget({...target,sampleVersionId:''})).toBe(false);expect(isWorkbenchTarget({...target,orderId:'fake'})).toBe(false);expect(isWorkbenchTarget({kind:'development',caseId:'c',section:'overview',sampleVersionId:'v'})).toBe(true);});
    it('GET uses only group pagination and preserves original source id response', async () => { const fetch = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => dto() })); vi.stubGlobal('fetch', fetch); expect((await dashboardTaskService.read({ group: 'qc', limit: 20 })).groups[0].total).toBe(0); expect(fetch.mock.calls[0][0]).toBe('http://private.invalid/api/v1/dashboard/workbench?group=qc&limit=20'); expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET' }); expect(seam.listeners.size).toBe(0); });
    it.each(['account', 'role', 'token', 'ceiling', 'endpoint'])('%s ABA in-flight read is latched invalid even after the original identity returns', async (kind) => {
        const response = deferred<any>();
        vi.stubGlobal('fetch', vi.fn(() => response.promise));
        const pending = dashboardTaskService.read();
        const original = { user: { ...seam.user }, token: seam.token, endpoint: seam.endpoint };
        if (kind === 'account')
            seam.user = { ...seam.user, id: 'other' };
        if (kind === 'role')
            seam.user = { ...seam.user, roleIds: ['role-finance'] };
        if (kind === 'token')
            seam.token = 'different';
        if (kind === 'ceiling')
            seam.user = { ...seam.user, permissionCeiling: [] };
        if (kind === 'endpoint')
            seam.endpoint = 'http://other.invalid/api';
        if (kind === 'endpoint')
            window.dispatchEvent(new StorageEvent('storage'));
        else
            notify();
        seam.user = original.user;
        seam.token = original.token;
        seam.endpoint = original.endpoint;
        notify();
        response.resolve({ ok: true, json: async () => dto() });
        await expect(pending).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
        expect(seam.listeners.size).toBe(0);
    });
    it('outbound server raw error text is never passed to the dashboard', async () => { vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL_ERROR', message: 'raw SQL password' } }) }))); await expect(dashboardTaskService.read()).rejects.toThrow('个人工作台暂时无法读取'); });
    it('JSON failure is a retryable invalid response, not ready empty', async () => { vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw Error('bad JSON'); } }))); await expect(dashboardTaskService.read()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); });
});
