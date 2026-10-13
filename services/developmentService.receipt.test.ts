// @vitest-environment jsdom
/** Actual frontend client serialization; injected fetch is a transport seam,
 * not a browser-to-running-server or real database claim.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { developmentService, readDevelopmentConversionMoq, developmentConversionNotice } from './developmentService';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';
const context = vi.hoisted(() => ({ listeners: new Set<() => void>(), endpoint: 'http://localhost:3001', token: 'synthetic-token', auth: { isAuthenticated: true, isLoading: false, user: { id: 'operator', permissions: ['products:read', 'sample:room:write'], permissionCeiling: null as string[] | null } } }));
vi.mock('./authService', () => ({ getAuthState: () => context.auth, subscribe: (listener: () => void) => { context.listeners.add(listener); listener(); return () => context.listeners.delete(listener); } }));
vi.mock('./apiService', () => ({ apiService: {
  getStoredConfig: () => ({ cloudEndpoint: context.endpoint }),
  buildApiUrl: (pathname: string, base: string) => base + '/api' + pathname,
  getAuthHeaders: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + context.token }),
} }));
afterEach(() => { vi.unstubAllGlobals(); context.endpoint = 'http://localhost:3001'; context.token = 'synthetic-token'; context.auth.user.id = 'operator'; context.auth.user.permissions = ['products:read', 'sample:room:write']; });
const capability = { ok: true, receiptVersion: 2, custodyMode: 'independent-exact-receipt', autoSampleProjection: false };
const source = { receiptVersion: 2 as const, cardType: 'fabric' as const, expectedSourceRound: 7, expectedCaseId: 'D1', expectedFactoryId: 'F1', expectedBatchUpdatedAt: '42' };
const resultOf = (batchId: string, input: any) => ({ item: { id: 'C1', receiptSnapshot: { version: 2, batchId, sourceRound: input.expectedSourceRound, factoryId: input.expectedFactoryId,
  developmentCaseId: input.expectedCaseId, cardType: input.cardType, initialPhysicalCardCount: input.physicalCardCount, physicalUnit: 'PC' } }, batch: { id: batchId, actualQuantity: input.actualQuantity }, created: true, receiptStatus: 'verified' });
const response = (value: any) => ({ ok: true, json: async () => value });
it('register-received sends explicit count, canonical length and source version in one actual client request', async () => {
  const input = { ...source, physicalCardCount: 3, actualQuantity: '12345678901234.1234', actualUnit: 'M' };
  const result = resultOf('SB/source id', input);
  const fetcher = vi.fn().mockResolvedValueOnce(response(capability)).mockResolvedValueOnce(response(result)); vi.stubGlobal('fetch', fetcher);
  expect(await developmentService.registerReceivedBatchCards('SB/source id', input)).toEqual(result);
  expect(fetcher).toHaveBeenCalledTimes(2); const [url, options] = fetcher.mock.calls[1];
  expect(fetcher.mock.calls[0][0]).toBe('http://localhost:3001/api/v1/development/sample-room/receipt-contract');
  expect(url).toBe('http://localhost:3001/api/v1/development/batches/SB%2Fsource%20id/register-received');
  expect(options).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } }); expect(JSON.parse(options.body)).toEqual(input);
});
it('zero cards/null length and an explicit endpoint retain their independent values', async () => {
  const input = { ...source, physicalCardCount: 0, actualQuantity: null, actualUnit: null };
  const fetcher = vi.fn().mockResolvedValueOnce(response(capability)).mockResolvedValueOnce(response(resultOf('B1', input))); vi.stubGlobal('fetch', fetcher);
  await developmentService.registerReceivedBatchCards('B1', input, 'http://localhost:3011');
  expect(fetcher.mock.calls[0][0]).toBe('http://localhost:3011/api/v1/development/sample-room/receipt-contract');
  expect(fetcher.mock.calls[1][0]).toBe('http://localhost:3011/api/v1/development/batches/B1/register-received'); expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(input);
});
it('unverified legacy receipt rejection carries its server explanation to the actual form caller', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(capability)).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: { code: 'BATCH_CARDS_LEGACY_UNVERIFIED', message: '旧登记数量来源未核实，请核实盘点' } }) }));
  await expect(developmentService.registerReceivedBatchCards('B1', { ...source, physicalCardCount: 1 })).rejects.toThrow('旧登记数量来源未核实');
});
it.each([404, 401, 403])('capability HTTP %s prevents a POST to a legacy or unauthorized backend', async status => {
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) }); vi.stubGlobal('fetch', fetcher);
  await expect(developmentService.registerReceivedBatchCards('B1', { ...source, physicalCardCount: 2 })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1].method).toBeUndefined();
});
it.each([{}, { ...capability, receiptVersion: 1 }, { ...capability, autoSampleProjection: true }])('an unknown capability %j is not evidence for a safe write', async value => {
  const fetcher = vi.fn().mockResolvedValue(response(value)); vi.stubGlobal('fetch', fetcher);
  await expect(developmentService.registerReceivedBatchCards('B1', { ...source, physicalCardCount: 2 })).rejects.toThrow('尚未提交'); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('a network error in compatibility reading performs no POST', async () => {
  const fetcher = vi.fn().mockRejectedValue(Error('synthetic network failure')); vi.stubGlobal('fetch', fetcher);
  await expect(developmentService.registerReceivedBatchCards('B1', { ...source, physicalCardCount: 2 })).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['account', 'permissions', 'endpoint', 'token'])('%s changed during compatibility reading cancels the original POST', async changed => {
  const fetcher = vi.fn().mockImplementation(async () => {
    if (changed === 'account') context.auth.user.id = 'other';
    if (changed === 'permissions') context.auth.user.permissions = [];
    if (changed === 'endpoint') context.endpoint = 'http://other.invalid';
    if (changed === 'token') context.token = 'different-synthetic-token';
    return response(capability);
  }); vi.stubGlobal('fetch', fetcher);
  await expect(developmentService.registerReceivedBatchCards('B1', { ...source, physicalCardCount: 2 })).rejects.toThrow('尚未提交'); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('a POST response without V2 proof is never reported as successful receipt', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response(capability)).mockResolvedValueOnce(response({ receiptStatus: 'verified', item: { receiptSnapshot: { version: 1 } } })); vi.stubGlobal('fetch', fetcher);
  await expect(developmentService.registerReceivedBatchCards('B1', { ...source, physicalCardCount: 2 })).rejects.toThrow('未返回准确收样证明');
});
it.each(['source-page', 'account-return', 'endpoint-return'])('a deferred capability cannot submit after %s became invalid, even if identity later returns', async change => {
  let resolve!: (value: any) => void; let current = true;
  const fetcher = vi.fn().mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue(response(resultOf('B1', { ...source, physicalCardCount: 2 })));
  vi.stubGlobal('fetch', fetcher);
  const request = developmentService.registerReceivedBatchCards('B1', { ...source, physicalCardCount: 2 }, undefined, () => current);
  if (change === 'source-page') current = false;
  if (change === 'account-return') {
    context.auth.user.id = 'other'; context.listeners.forEach(listener => listener());
    context.auth.user.id = 'operator'; context.listeners.forEach(listener => listener());
  }
  if (change === 'endpoint-return') {
    context.endpoint = 'http://other.invalid'; window.dispatchEvent(new Event(EMAIL_CONTEXT_EVENT));
    context.endpoint = 'http://localhost:3001'; window.dispatchEvent(new Event(EMAIL_CONTEXT_EVENT));
  }
  resolve(response(capability));
  await expect(request).rejects.toThrow('尚未提交'); expect(fetcher).toHaveBeenCalledTimes(1); expect(context.listeners.size).toBe(0);
});
it('caller invalidation while the capability JSON is pending also performs zero POST', async () => {
  let resolve!: (value: any) => void; let current = true;
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: () => new Promise(done => { resolve = done; }) }).mockResolvedValue(response(resultOf('B1', { ...source, physicalCardCount: 2 })));
  vi.stubGlobal('fetch', fetcher);
  const request = developmentService.registerReceivedBatchCards('B1', { ...source, physicalCardCount: 2 }, undefined, () => current);
  await Promise.resolve(); current = false; resolve(capability);
  await expect(request).rejects.toThrow('尚未提交'); expect(fetcher).toHaveBeenCalledTimes(1); expect(context.listeners.size).toBe(0);
});
it('a caller invalidated after POST gets a result-to-check message, never a rollback claim or success', async () => {
  let resolve!: (value: any) => void; let current = true;
  const fetcher = vi.fn().mockResolvedValueOnce(response(capability)).mockReturnValueOnce(new Promise(done => { resolve = done; })); vi.stubGlobal('fetch', fetcher);
  const request = developmentService.registerReceivedBatchCards('B1', { ...source, physicalCardCount: 2 }, undefined, () => current);
  while (fetcher.mock.calls.length < 2) await Promise.resolve(); current = false;
  resolve(response(resultOf('B1', { ...source, physicalCardCount: 2 })));
  await expect(request).rejects.toThrow('核对本次收样结果'); expect(fetcher).toHaveBeenCalledTimes(2); expect(context.listeners.size).toBe(0);
});


const conversionMoq=(quantity=50)=>({ok:quantity>=100,capsuleActive:false,lines:[{lineIndex:0,quantity,unit:'M',effectiveMoq:100,source:'moq_config',compliant:quantity>=100}],blockedLineIndexes:quantity>=100?[]:[0],snapshot:{source:'moq_config',configId:'MOQ-REAL',snapshotAt:'2026-10-04T00:00:00.000Z',fabricDefaultMoq:100,garmentDefaultMoq:200,capsuleMoq:20}});
it('conversion transports original body and projects a finite low MOQ warning',async()=>{
  const body={autoCreate:true,quantity:50,dueDate:'2026-10-15',clientRequestId:'original-key'};
  const fetcher=vi.fn().mockResolvedValue(response({case:{id:'D1'},order:{id:'O1',poNumber:'PO-1'},moqCheck:conversionMoq()}));vi.stubGlobal('fetch',fetcher);
  const result=await developmentService.convertToOrder('D1',body);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(body);
  expect(result.moqCheck).toEqual({state:'below',belowLineCount:1,basis:'configured_or_specific'});
  const notice=developmentConversionNotice(result.moqCheck,'PO-1');expect(notice.kind).toBe('warning');expect(notice.message).toContain('已建为待确认状态');expect(notice.message).toContain('有效豁免');
});
it.each([null,undefined,{}, {...conversionMoq(),ok:true}, {...conversionMoq(),blockedLineIndexes:[]}, {...conversionMoq(),lines:[{...conversionMoq().lines[0],quantity:'50'}]}, {...conversionMoq(),snapshot:{...conversionMoq().snapshot,configId:null}}])('unknown or contradictory MOQ %j is not compliance',value=>{
  const summary=readDevelopmentConversionMoq(value);expect(summary.state).toBe('unverified');expect(developmentConversionNotice(summary,'PO-1')).toMatchObject({kind:'warning'});expect(developmentConversionNotice(summary,'PO-1').message).toContain('核验未完成');
});
it('coherent successful MOQ retains the explicit default-threshold basis',()=>{
  expect(developmentConversionNotice(readDevelopmentConversionMoq(conversionMoq(100)),'PO-1').kind).toBe('success');
  const fallback={...conversionMoq(100),lines:[{...conversionMoq(100).lines[0],source:'fallback_constant'}],snapshot:{...conversionMoq().snapshot,source:'fallback_constant',configId:null}};
  expect(readDevelopmentConversionMoq(fallback)).toMatchObject({state:'compliant',basis:'fallback'});expect(developmentConversionNotice(readDevelopmentConversionMoq(fallback),'PO-1')).toMatchObject({kind:'warning'});expect(developmentConversionNotice(readDevelopmentConversionMoq(fallback),'PO-1').message).toContain('按系统默认起订量核验');
});
it('conversion failure retains only a real returned approval identifier',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:409,json:async()=>({error:{code:'CREDIT_BLOCKED',message:'信用阻断',approvalRequestId:'APP-REAL'}})}));
  await expect(developmentService.convertToOrder('D1',{autoCreate:true})).rejects.toMatchObject({code:'CREDIT_BLOCKED',approvalRequestId:'APP-REAL',message:'信用阻断'});
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:409,json:async()=>({error:{code:'CREDIT_BLOCKED',message:'信用阻断'}})}));
  const error=await developmentService.convertToOrder('D1',{autoCreate:true}).catch(error=>error);expect(error.approvalRequestId).toBeUndefined();
});

it('below-default MOQ is disclosed as default basis, not failed verification',()=>{
  const r=conversionMoq();r.lines[0].source='fallback_constant';const value={...r,snapshot:{...r.snapshot,source:'fallback_constant',configId:null}};
  const summary=readDevelopmentConversionMoq(value);expect(summary).toEqual({state:'below',belowLineCount:1,basis:'fallback'});expect(developmentConversionNotice(summary,'PO-1').message).toContain('系统默认 MOQ');
});
