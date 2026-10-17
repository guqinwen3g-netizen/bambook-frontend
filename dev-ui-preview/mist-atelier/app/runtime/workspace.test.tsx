import {createMistState as newModuleFixture} from '../../../../server/src/shared/mistWorkspace';
// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MistCommand, MistFile, MistRunReceipt, MistState, MistWorkspaceEnvelope } from '../../../../server/src/shared/mistWorkspace';

const auth = vi.hoisted(() => ({ session: { sessionKey: 'session-a', user: { id: 'actor-a' }, status: 'authenticated' } }));
vi.mock('./auth', () => ({ useMistSession: () => auth.session }));
vi.mock('../../../../services/apiService', () => ({ apiService: { getAuthHeaders: () => ({ 'Content-Type': 'application/json', 'X-Test-Actor': auth.session.user.id }) } }));
import { MistWorkspaceProvider, shareStructure, useMistWorkspace, workspaceAccessibleBy, type MistWorkspaceContext } from './workspace';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const BASE = '/api/mist/workspaces';
const A = 'workspace-a', B = 'workspace-b', C = 'workspace-c', D = 'workspace-d';
type ResponseData = { ok: boolean; status: number; json: () => Promise<any>; headers?: {get:(name:string)=>string|null}; blob?:()=>Promise<Blob> };
type Request = { url: string; method: string; init: RequestInit; actor: string };
let host: HTMLElement, root: Root, api: MistWorkspaceContext, strict = false;
let stores: Map<string, MistWorkspaceEnvelope>, receipts: Map<string, MistRunReceipt>, calls: Request[];
let creations: Map<string, { name: string; seed: string; id: string }>;
let renderedScopes: Array<{ workspace: string | undefined; workspaces: number; pending: unknown }>;
let intercept: ((request: Request) => Promise<ResponseData> | ResponseData | undefined) | undefined;

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const response = (data: any, status = 200): ResponseData => ({ ok: status >= 200 && status < 300, status, json: async () => clone(data) });
const command = (name: string): MistCommand => ({ type: 'settings.update', payload: { profileName: name } });
const failure = (status: number, code = 'ERROR') => response({ error: { code, message: '请求被拒绝' } }, status);
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function state(): MistState {
  return {
    ...newModuleFixture({actorName:'测试',now:'2026-10-13T00:00:00.000Z',id:()=>crypto.randomUUID()},'empty'),schemaVersion: 1, devs: [], versions: [], drafts: [], fabrics: [], orders: [], orderLines: [], productions: [], receipts: [], invoices: [], allocations: [], payments: [], customers: [], contacts: [], files: [], events: [], tasks: [], notifications: [], calendar: [],
    settings: { theme: 'light', density: 'default', reducedMotion: false, notifications: { qc: true, shipping: true, suggestions: true, digest: false }, workspaceName: '工作区', profileName: '初始姓名', profileEmail: '', locale: 'zh-CN' },
  };
}
function workspace(id: string, ownerId = 'actor-a'): MistWorkspaceEnvelope { return { id, ownerId, name: id, revision: 0, state: state() }; }
function commitMember(request: Request): ResponseData {
  const id = request.url.slice(BASE.length + 1).split('/')[0], value = clone(stores.get(id)!);
  const body = JSON.parse(request.init.body as string);
  if (value.ownerId !== request.actor) return failure(404);
  if (body.expectedRevision !== value.revision) return failure(409, 'REVISION_CONFLICT');
  value.revision++;
  value.state.memberIds = body.action === 'add' ? [...value.state.memberIds ?? [], body.account] : (value.state.memberIds ?? []).filter(id => id !== body.account);
  stores.set(id, value);
  const receipt = { requestId: body.requestId, revision: value.revision, result: { workspaceId: id, action: body.action, userId: body.account } };
  receipts.set(body.requestId, receipt);
  return response({ workspace: value, receipt });
}
function commit(request: Request): ResponseData {
  const id = request.url.slice(BASE.length + 1).split('/')[0], value = clone(stores.get(id)!);
  const body = JSON.parse(request.init.body as string);
  if (body.expectedRevision !== value.revision) return failure(409, 'REVISION_CONFLICT');
  value.revision++;
  if (body.command.type === 'settings.update') Object.assign(value.state.settings, body.command.payload);
  stores.set(id, value);
  const receipt = { requestId: body.requestId, revision: value.revision, result: {} };
  receipts.set(body.requestId, receipt);
  return response({ workspace: value, receipt });
}
function upload(request: Request): ResponseData {
  const id = request.url.slice(BASE.length + 1).split('/')[0], value = clone(stores.get(id)!);
  const body = request.init.body as FormData, file = body.get('file') as File;
  if (Number(body.get('expectedRevision')) !== value.revision) return failure(409, 'REVISION_CONFLICT');
  const saved: MistFile = { id: 'file-' + value.revision, name: file.name, size: file.size, mimeType: file.type, storageKey: id + '/file-' + value.revision, createdAt: '2026-10-13T00:00:00Z' };
  value.revision++; value.state.files.push(saved); stores.set(id, value);
  const receipt = { requestId: String(body.get('requestId')), revision: value.revision, result: { fileId: saved.id,...(body.has('claimId')?{claimId:String(body.get('claimId'))}:{}) } };
  receipts.set(receipt.requestId, receipt);
  return response({ workspace: value, receipt });
}
function create(request: Request): ResponseData {
  const body = JSON.parse(request.init.body as string), key = request.actor + ':' + body.slug, previous = creations.get(key);
  if (previous) return previous.name === body.name && previous.seed === body.seed ? response({ workspace: stores.get(previous.id) }) : failure(409, 'REQUEST_CONFLICT');
  const id = 'created-' + creations.size, value = workspace(id, request.actor); value.name = body.name; value.state.settings.workspaceName = body.name;
  stores.set(id, value); creations.set(key, { id, name: body.name, seed: body.seed });
  receipts.set('create:' + body.slug, { requestId: 'create:' + body.slug, revision: 0, result: { workspaceId: id } });
  return response({ workspace: value });
}
function lifecycle(request:Request):ResponseData{
  const id=request.url.slice(BASE.length+1).split('/')[0],action=request.url.endsWith('/restore')?'restore':'archive',value=clone(stores.get(id)!);const body=JSON.parse(request.init.body as string);
  const previous=receipts.get(body.requestId);if(previous){const active=[...stores.values()].find(item=>item.ownerId===request.actor&&!item.state.workspaceArchive)!;return response({workspace:active,receipt:previous,replayed:true});}
  if(value.ownerId!==request.actor)return failure(404);if(value.revision!==body.expectedRevision)return failure(409,'REVISION_CONFLICT');value.revision++;
  if(action==='archive')value.state.workspaceArchive={at:'2026-10-13T00:00:00Z',actorId:request.actor};else delete value.state.workspaceArchive;
  stores.set(id,value);const active=action==='restore'?value:[...stores.values()].find(item=>item.ownerId===request.actor&&!item.state.workspaceArchive)!;const receipt={requestId:body.requestId,revision:value.revision,result:{workspaceId:id,action,activeWorkspaceId:active.id}};receipts.set(body.requestId,receipt);return response({workspace:active,receipt});
}
function Probe() { api = useMistWorkspace(); renderedScopes.push({ workspace: api.workspace?.id, workspaces: api.workspaces.length, pending: api.pending }); return null; }
async function render() { await act(async () => root.render(strict ? <React.StrictMode><MistWorkspaceProvider><Probe /></MistWorkspaceProvider></React.StrictMode> : <MistWorkspaceProvider><Probe /></MistWorkspaceProvider>)); }
async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); });
  expect(predicate()).toBe(true);
}
async function mount() { await render(); await waitFor(() => !api.loading && !!api.workspace); }
async function resolve<T>(wait: ReturnType<typeof deferred<T>>, value: T) { await act(async () => wait.resolve(value)); }
const posts = () => calls.filter(call => call.method === 'POST');
const capture = <T,>(promise: Promise<T>): Promise<T | Error> => promise.catch(error => error as Error);

beforeEach(() => {
  localStorage.clear(); strict = false; intercept = undefined;
  auth.session = { sessionKey: 'session-a', user: { id: 'actor-a' }, status: 'authenticated' };
  stores = new Map([[A, workspace(A)], [B, workspace(B)], [C, workspace(C)], [D, workspace(D, 'actor-b')]]); receipts = new Map(); calls = []; creations = new Map(); renderedScopes = [];
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const request: Request = { url: String(url), method: init.method ?? 'GET', init, actor: (init.headers as Record<string, string>)['X-Test-Actor'] };
    calls.push(request);
    const redirected = intercept?.(request); if (redirected) return redirected;
    if (request.method === 'POST' && request.url.endsWith('/commands')) return commit(request);
    if (request.method === 'POST' && request.url.endsWith('/members')) return commitMember(request);
    if (request.method === 'POST' && request.url.endsWith('/files')) return upload(request);
    if(request.method==='POST'&&(request.url.endsWith('/archive')||request.url.endsWith('/restore')))return lifecycle(request);
    if (request.method === 'POST' && request.url === BASE) return create(request);
    if(request.url===BASE+'/archived')return response({workspaces:[...stores.values()].filter(item=>item.ownerId===request.actor&&item.state.workspaceArchive).map(item=>({id:item.id,name:item.name,revision:item.revision,archivedAt:item.state.workspaceArchive!.at}))});
    if (request.url === BASE) return response({ workspaces: [...stores.values()].filter(item => (item.ownerId === request.actor || item.state.memberIds?.includes(request.actor))&&!item.state.workspaceArchive).map(({ id, name, ownerId, access }) => ({ id, name, ownerId, access })) });
    if (request.url.endsWith('/revision')) { const value = stores.get(request.url.slice(BASE.length + 1).split('/')[0]); return value && (value.ownerId === request.actor || value.state.memberIds?.includes(request.actor)) && !value.state.workspaceArchive ? response({ id: value.id, revision: value.revision }) : failure(404); }
    if (request.url.includes('/receipts/')) { const receipt = receipts.get(decodeURIComponent(request.url.split('/').at(-1)!)); return receipt ? response({ receipt }) : failure(404); }
    const id = request.url === BASE + '/default' ? [...stores.values()].find(item=>item.ownerId===request.actor&&!item.state.workspaceArchive)?.id : request.url.slice(BASE.length + 1);
    const value = id?stores.get(id):undefined; return value && (value.ownerId === request.actor || value.state.memberIds?.includes(request.actor))&&!value.state.workspaceArchive ? response({ workspace: value }) : failure(404);
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('accepts a shared envelope only when the server marks membership and the exact account is listed', () => {
  const shared = workspace(D, 'actor-b');
  shared.state.memberIds = ['actor-a'];
  shared.access = { role: 'member', canManageMembers: false, hidden: [] };
  expect(workspaceAccessibleBy(shared, 'actor-a')).toBe(true);
  expect(workspaceAccessibleBy(shared, 'actor-c')).toBe(false);
  shared.access = undefined; expect(workspaceAccessibleBy(shared, 'actor-a')).toBe(false);
  expect(workspaceAccessibleBy(shared, 'actor-b')).toBe(true);
});

it('opens the authorized shared workspace, refuses member management, and clears data when access is revoked', async () => {
  const shared = stores.get(D)!;
  shared.state.memberIds = ['actor-a']; shared.access = { role: 'member', canManageMembers: false, hidden: [] };
  localStorage.setItem('bambook.mist.selected-workspace:actor-a', D);
  await mount();
  expect(api.workspace?.id).toBe(D);
  expect(api.workspaces.find(item => item.id === D)?.shared).toBe(true);
  await expect(api.changeMember!('add', 'actor-c')).rejects.toThrow('只有工作空间所有者');
  expect(posts()).toHaveLength(0);
  shared.state.memberIds = [];
  await act(async () => api.refresh());
  expect(api.workspace).toBeNull();
  expect(api.workspaces.some(item => item.id === D)).toBe(false);
});

it('adds and revokes a member using exact receipts without changing business permissions', async () => {
  stores.get(A)!.access = { role: 'owner', canManageMembers: true, hidden: [] };
  await mount();
  await act(async () => api.changeMember!('add', ' actor-b '));
  expect(api.state?.memberIds).toEqual(['actor-b']);
  expect(api.pending).toBeNull();
  expect(JSON.parse(posts()[0].init.body as string)).toMatchObject({ expectedRevision: 0, action: 'add', account: 'actor-b' });
  expect(posts()[0].url).toBe(BASE + '/' + A + '/members');
  await act(async () => api.changeMember!('remove', 'actor-b'));
  expect(api.state?.memberIds).toEqual([]);
  expect(api.workspace?.revision).toBe(2);
});

it('keeps an uncertain grant for exact receipt recovery instead of sending a new grant', async () => {
  stores.get(A)!.access = { role: 'owner', canManageMembers: true, hidden: [] };
  await mount();
  intercept = request => { if (request.url.endsWith('/members')) { commitMember(request); throw new TypeError('连接中断'); } };
  let outcome!: Promise<void | Error>;
  await act(async () => { outcome = capture(api.changeMember!('add', 'actor-b')); });
  expect(await outcome).toBeInstanceOf(Error);
  expect(api.pending?.kind).toBe('member');
  await expect(api.switchWorkspace(B)).rejects.toThrow('请先核对未完成操作');
  intercept = undefined;
  await act(async () => api.recover());
  expect(api.state?.memberIds).toEqual(['actor-b']);
  expect(api.pending).toBeNull();
  expect(posts().filter(request => request.url.endsWith('/members'))).toHaveLength(1);
});

it('does not accept an unrelated member receipt and recovers the original durable receipt', async () => {
  stores.get(A)!.access = { role: 'owner', canManageMembers: true, hidden: [] };
  await mount();
  intercept = async request => {
    if (!request.url.endsWith('/members')) return undefined;
    const body = await commitMember(request).json();
    body.receipt.result.action = 'remove';
    return response(body);
  };
  let outcome!: Promise<void | Error>;
  await act(async () => { outcome = capture(api.changeMember!('add', 'actor-b')); });
  expect((await outcome as Error).message).toContain('授权回执与原操作不一致');
  expect(api.pending?.kind).toBe('member');
  expect(api.workspace?.revision).toBe(0);
  intercept = undefined; await act(async () => api.recover());
  expect(api.workspace?.revision).toBe(1);
  expect(api.pending).toBeNull();
});

it('reuses the exact stored member request when its receipt is not yet committed', async () => {
  stores.get(A)!.access = { role: 'owner', canManageMembers: true, hidden: [] };
  localStorage.setItem('bambook.mist.pending:actor-a', JSON.stringify({ workspaceId: A, actorId: 'actor-a', requestId: 'exact-member-grant', expectedRevision: 0, kind: 'member', action: 'add', account: 'actor-b' }));
  await mount(); await act(async () => api.recover());
  expect(JSON.parse(posts()[0].init.body as string).requestId).toBe('exact-member-grant');
  expect(api.state?.memberIds).toEqual(['actor-b']);
  expect(api.pending).toBeNull();
});

it('remains usable through StrictMode effect replay and applies an acknowledged command', async () => {
  strict = true; await mount();
  let result!: MistRunReceipt; await act(async () => { result = await api.run(command('保存姓名')); });
  expect(api.workspace?.id).toBe(A); expect(api.workspace?.revision).toBe(1); expect(api.state?.settings.profileName).toBe('保存姓名');
  expect(result.revision).toBe(1); expect(api.pending).toBeNull(); expect(api.saving).toBe(false); expect(posts()).toHaveLength(1);
});
it('archives the current workspace, selects an active replacement and restores the original',async()=>{await mount();await act(async()=>api.archiveWorkspace!());expect(api.workspace?.id).toBe(B);expect(api.workspaces.some(row=>row.id===A)).toBe(false);expect(api.archivedWorkspaces?.some(row=>row.id===A)).toBe(true);await act(async()=>api.restoreWorkspace!(A));expect(api.workspace?.id).toBe(A);expect(api.archivedWorkspaces).toEqual([]);expect(api.pending).toBeNull();expect(stores.get(A)?.state.workspaceArchive).toBeUndefined();});
it('recovers a committed archive after a lost response and page reload',async()=>{await mount();intercept=request=>{if(request.method==='POST'&&request.url.endsWith('/archive')){lifecycle(request);return Promise.reject(new Error('response lost'));}return undefined;};await act(async()=>{await capture(api.archiveWorkspace!());});expect(api.pending?.kind).toBe('archive');expect(stores.get(A)?.state.workspaceArchive).toBeTruthy();intercept=undefined;await act(async()=>root.unmount());root=createRoot(host);await mount();expect(api.workspace?.id).toBe(B);expect(api.pending?.kind).toBe('archive');await act(async()=>api.recover());expect(api.pending).toBeNull();expect(api.workspace?.id).toBe(B);expect(posts().filter(call=>call.url.endsWith('/archive'))).toHaveLength(1);});
it('retains the original lifecycle intent on failure and refuses competing writes',async()=>{await mount();intercept=request=>request.method==='POST'&&request.url.endsWith('/archive')?Promise.reject(new Error('network unavailable')):undefined;await act(async()=>{await capture(api.archiveWorkspace!());});expect(api.pending?.kind).toBe('archive');await expect(api.run(command('must not write'))).rejects.toThrow('待核对');await expect(api.switchWorkspace(B)).rejects.toThrow('未完成');expect(api.workspace?.id).toBe(A);});

it('ignores the older navigation response when a newer workspace wins', async () => {
  await mount(); const delayed = deferred<ResponseData>();
  intercept = request => request.url === BASE + '/' + B ? delayed.promise : undefined;
  let first!: Promise<void>; await act(async () => { first = api.switchWorkspace(B); });
  await act(async () => { await api.switchWorkspace(C); });
  expect(api.workspace?.id).toBe(C);
  await resolve(delayed, response({ workspace: stores.get(B) })); await first;
  expect(api.workspace?.id).toBe(C); expect(api.loading).toBe(false); expect(localStorage.getItem('bambook.mist.selected-workspace:actor-a')).toBe(C);
});

it('does not roll a successful command back when an older refresh resolves late', async () => {
  await mount(); const delayed = deferred<ResponseData>(), old = clone(stores.get(A)!);
  intercept = request => request.url === BASE + '/' + A && request.method === 'GET' ? delayed.promise : undefined;
  let refresh!: Promise<void>; await act(async () => { refresh = api.refresh(); });
  await act(async () => { await api.run(command('新版本')); });
  await resolve(delayed, response({ workspace: old })); await refresh;
  expect(api.workspace?.revision).toBe(1); expect(api.state?.settings.profileName).toBe('新版本');
});

it('rejects callbacks retained before a switch, including while the next workspace is loading', async () => {
  await mount(); const retired = api.run, delayed = deferred<ResponseData>();
  intercept = request => request.url === BASE + '/' + B ? delayed.promise : undefined;
  let switching!: Promise<void>; await act(async () => { switching = api.switchWorkspace(B); });
  await expect(retired(command('旧页'))).rejects.toThrow('工作区');
  await resolve(delayed, response({ workspace: stores.get(B) })); await switching;
  await expect(retired(command('旧页'))).rejects.toThrow('工作区');
  await act(async () => { await api.run(command('当前页')); });
  expect(posts()).toHaveLength(1); expect(posts()[0].url).toBe(BASE + '/' + B + '/commands');
});

function creditResponse(name:string,options:{mime?:string;blob?:Blob;pendingBlob?:Promise<Blob>;status?:number;error?:string;badJson?:boolean}={}):ResponseData{
 const mime=options.mime??'application/pdf',status=options.status??200;
 return {ok:status>=200&&status<300,status,headers:{get:key=>({'content-type':mime,'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(name)}[key.toLowerCase()]??null)},json:async()=>{if(options.badJson)throw new Error('non-JSON upstream response');return{error:{message:options.error||'文档生成失败'}};},blob:()=>options.pendingBlob??Promise.resolve(options.blob??new Blob(['%PDF-1.4\nLocal provider document fixture\n%%EOF'],{type:mime}))};
}
function captureCreditDelivery(){
 const deliveries:Array<{name:string;href:string}>=[],create=vi.fn((_blob:Blob)=>'blob:local-credit-contract'),revoke=vi.fn(),NativeURL=URL;
 vi.stubGlobal('URL',class extends NativeURL{static createObjectURL=create;static revokeObjectURL=revoke;});
 vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(){deliveries.push({name:this.download,href:this.href});});return{deliveries,create,revoke};
}

it('reads a DRAFT PDF by source version and an issued PDF by print version with exact filenames and no business command',async()=>{
 await mount();const delivery=captureCreditDelivery(),before=clone(api.state),draft=new Blob(['%PDF-1.4\nDraft provider fixture\n%%EOF'],{type:'application/pdf'}),issued=new Blob(['%PDF-1.4\nIssued provider fixture\n%%EOF'],{type:'application/pdf'});
 intercept=request=>request.url.endsWith('/preview.pdf')?creditResponse('CLM-2026-00002-v1-DRAFT.pdf',{blob:draft}):request.url.endsWith('/document.pdf')?creditResponse('正式CN-V1.pdf',{blob:issued}):undefined;
 await act(async()=>{await api.prepareCreditDocument('credit-one','source-version-one');await api.downloadCreditDocument('credit-one','print-version-one');});
 const reads=calls.filter(request=>request.url.includes('/credits/'));expect(reads.map(request=>request.url)).toEqual([BASE+'/'+A+'/credits/credit-one/versions/source-version-one/preview.pdf',BASE+'/'+A+'/credits/credit-one/versions/print-version-one/document.pdf']);expect(reads.every(request=>request.method==='GET'&&request.init.credentials==='include')).toBe(true);expect(delivery.deliveries.map(row=>row.name)).toEqual(['CLM-2026-00002-v1-DRAFT.pdf','正式CN-V1.pdf']);expect(delivery.create.mock.calls.map(call=>call[0])).toEqual([draft,issued]);expect(posts()).toHaveLength(0);expect(api.pending).toBeNull();expect(api.state).toEqual(before);expect(api.workspace?.revision).toBe(0);
});

it.each(['application/json','text/html','application/octet-stream',''])('refuses a successful non-PDF response with MIME %j without pretending to download',async mime=>{
 await mount();const delivery=captureCreditDelivery(),blob=vi.fn(async()=>new Blob(['{"error":"not a PDF"}'],{type:'application/json'}));intercept=request=>request.url.endsWith('/preview.pdf')?{...creditResponse('wrong.pdf',{mime}),blob}:undefined;
 await act(async()=>{const result=await capture(api.prepareCreditDocument('credit-one','source-version-one'));expect(result).toBeInstanceOf(Error);expect((result as Error).message).toContain('PDF');});expect(blob).not.toHaveBeenCalled();expect(delivery.create).not.toHaveBeenCalled();expect(delivery.deliveries).toEqual([]);expect(posts()).toHaveLength(0);
});

it('does not download a JSON error body mislabeled as a successful PDF',async()=>{
 await mount();const delivery=captureCreditDelivery();intercept=request=>request.url.endsWith('/document.pdf')?creditResponse('wrong.pdf',{mime:'application/pdf',blob:new Blob(['{"error":"document unavailable"}'],{type:'application/pdf'})}):undefined;
 await act(async()=>{expect(await capture(api.downloadCreditDocument('credit-one','print-version-one'))).toBeInstanceOf(Error);});expect(delivery.create).not.toHaveBeenCalled();expect(delivery.deliveries).toEqual([]);
});

it('accepts a valid PDF through a foreign-realm FileReader ArrayBuffer fallback',async()=>{
 await mount();const delivery=captureCreditDelivery(),frame=document.createElement('iframe');document.body.append(frame);
 try{const foreign=frame.contentWindow as Window&typeof globalThis,blob=new foreign.Blob(['%PDF-1.4\nForeign-realm fixture\n%%EOF'],{type:'application/pdf'});Object.defineProperty(blob,'arrayBuffer',{value:undefined});expect(typeof blob.arrayBuffer).toBe('undefined');vi.stubGlobal('FileReader',foreign.FileReader);
  const probe=await new Promise<ArrayBuffer>(resolve=>{const reader=new foreign.FileReader();reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.readAsArrayBuffer(blob);});expect(Object.prototype.toString.call(probe)).toBe('[object ArrayBuffer]');expect(probe instanceof ArrayBuffer).toBe(false);
  intercept=request=>request.url.endsWith('/preview.pdf')?creditResponse('foreign-realm-DRAFT.pdf',{blob}):undefined;await act(async()=>{await api.prepareCreditDocument('credit-one','source-version-one');});expect(delivery.deliveries.map(row=>row.name)).toEqual(['foreign-realm-DRAFT.pdf']);expect(posts()).toHaveLength(0);
 }finally{frame.remove();}
});

it.each(['workspace','actor'] as const)('does not deliver a PDF after a %s switch during native PDF byte validation',async change=>{
 await mount();const delivery=captureCreditDelivery(),bytes=deferred<ArrayBuffer>(),blob=new Blob(['%PDF-1.4\nNative reader fixture\n%%EOF'],{type:'application/pdf'});Object.defineProperty(blob,'arrayBuffer',{value:()=>bytes.promise});intercept=request=>request.url.endsWith('/document.pdf')?creditResponse('old-native.pdf',{blob}):undefined;let reading!:Promise<void|Error>;
 await act(async()=>{reading=capture(api.downloadCreditDocument('credit-one','print-version-one'));});if(change==='workspace')await act(async()=>{await api.switchWorkspace(B);});else{auth.session={sessionKey:'changed-actor',user:{id:'actor-b'},status:'authenticated'};await render();await waitFor(()=>api.workspace?.id===D);}
 const content='%PDF-1.4\nNative reader fixture\n%%EOF',buffer=new ArrayBuffer(content.length);new Uint8Array(buffer).set(Array.from(content,char=>char.charCodeAt(0)));await resolve(bytes,buffer);expect(await reading).toBeInstanceOf(Error);expect(delivery.create).not.toHaveBeenCalled();expect(delivery.deliveries).toEqual([]);
});

it.each([false,true])('preserves a useful document failure for invalid/upstream JSON (%s) without making a download',async badJson=>{
 await mount();const delivery=captureCreditDelivery();intercept=request=>request.url.endsWith('/document.pdf')?creditResponse('not-issued.pdf',{status:502,error:'正式原件当前不可读取',badJson}):undefined;
 await act(async()=>{const result=await capture(api.downloadCreditDocument('credit-one','print-version-one'));expect(result).toBeInstanceOf(Error);expect((result as Error).message).toContain(badJson?'正式 CN 原件读取失败':'正式原件当前不可读取');});expect(delivery.create).not.toHaveBeenCalled();expect(posts()).toHaveLength(0);
});

it.each([{method:'prepareCreditDocument',change:'workspace'},{method:'downloadCreditDocument',change:'workspace'},{method:'prepareCreditDocument',change:'actor'},{method:'downloadCreditDocument',change:'actor'}] as const)('does not deliver a late $method PDF after a $change switch',async({method,change})=>{
 await mount();const delivery=captureCreditDelivery(),body=deferred<Blob>();intercept=request=>request.url.includes('/credits/')?creditResponse('old-private.pdf',{pendingBlob:body.promise}):undefined;let reading!:Promise<void|Error>;
 await act(async()=>{reading=capture(api[method]('credit-one',method==='prepareCreditDocument'?'source-version-one':'print-version-one'));});
 if(change==='workspace')await act(async()=>{await api.switchWorkspace(B);});else{auth.session={sessionKey:'session-b',user:{id:'actor-b'},status:'authenticated'};await render();await waitFor(()=>api.workspace?.id===D);}
 await resolve(body,new Blob(['%PDF-1.4\nOld private PDF\n%%EOF'],{type:'application/pdf'}));expect(await reading).toBeInstanceOf(Error);expect(delivery.create).not.toHaveBeenCalled();expect(delivery.deliveries).toEqual([]);expect(posts()).toHaveLength(0);
});

it.each(['committed','not-committed'] as const)('recovers a %s credit issue using the exact original request and blocks another issue while its result is unknown',async mode=>{
 await mount();let attempted=false,signatures=0;const committed=(request:Request)=>{const responseData=commit(request),body=JSON.parse(request.init.body as string),saved=receipts.get(body.requestId)!;saved.result={creditId:'credit-one',versionId:'issued-print-one',fileId:'issued-file-one'};signatures++;return response({workspace:stores.get(A),receipt:saved});};
 intercept=request=>{if(!request.url.endsWith('/commands'))return;if(!attempted){attempted=true;if(mode==='committed')committed(request);return Promise.reject(new TypeError('签发响应未知'));}return committed(request);};
 await act(async()=>{expect(await capture(api.issueCreditDocument('credit-one','source-version-one'))).toBeInstanceOf(Error);});const pending=clone(api.pending!);expect(pending.command).toEqual({type:'platform.credit.issue',payload:{creditId:'credit-one',versionId:'source-version-one'}});expect(pending.kind).toBe('command');
 await act(async()=>{expect(await capture(api.issueCreditDocument('credit-one','source-version-one'))).toBeInstanceOf(Error);expect(await capture(api.issueCreditDocument('credit-one','another-source-version'))).toBeInstanceOf(Error);expect(await capture(api.run(command('新保存不能抢占原签发')))).toBeInstanceOf(Error);});expect(posts()).toHaveLength(1);
 let recovered!:MistRunReceipt|undefined;await act(async()=>{recovered=await api.recover();});expect(recovered?.requestId).toBe(pending.requestId);expect(recovered?.result).toEqual({creditId:'credit-one',versionId:'issued-print-one',fileId:'issued-file-one'});expect(signatures).toBe(1);expect(posts()).toHaveLength(mode==='committed'?1:2);if(mode==='not-committed')expect(JSON.parse(posts()[1].init.body as string)).toEqual(JSON.parse(posts()[0].init.body as string));expect(calls.some(request=>request.url.endsWith('/receipts/'+pending.requestId))).toBe(true);expect(api.pending).toBeNull();expect(localStorage.getItem('bambook.mist.pending:actor-a')).toBeNull();expect(api.workspace?.revision).toBe(1);
});

it('retires account-bound callbacks and never publishes a previous account response', async () => {
  await mount(); const retired = api.run, delayed = deferred<ResponseData>();
  intercept = request => request.url.endsWith('/commands') ? delayed.promise : undefined;
  let writing!: Promise<MistRunReceipt | Error>; await act(async () => { writing = capture(retired(command('账号甲'))); });
  const previousRequest = posts()[0];
  auth.session = { sessionKey: 'session-b', user: { id: 'actor-b' }, status: 'authenticated' }; await render(); await waitFor(() => api.workspace?.id === D);
  await expect(retired(command('误写乙'))).rejects.toThrow('会话');
  await resolve(delayed, commit(previousRequest)); expect(await writing).toBeInstanceOf(Error);
  expect(api.workspace?.id).toBe(D); expect(api.workspace?.revision).toBe(0); expect(api.pending).toBeNull(); expect(posts()).toHaveLength(1);
  expect(localStorage.getItem('bambook.mist.pending:actor-a')).not.toBeNull();
});

it('excludes a second mutation in the same render before pending state can rerender', async () => {
  await mount(); const delayed = deferred<ResponseData>(); intercept = request => request.url.endsWith('/commands') ? delayed.promise : undefined;
  let first!: Promise<MistRunReceipt>, second!: Promise<MistRunReceipt | Error>;
  await act(async () => { first = api.run(command('第一笔')); second = capture(api.run(command('第二笔'))); });
  expect(await second).toBeInstanceOf(Error); expect(posts()).toHaveLength(1); expect(api.saving).toBe(true);
  await resolve(delayed, commit(posts()[0])); await first; expect(api.saving).toBe(false);
});

it('persists unknown results and replays the exact immutable request only after receipt lookup', async () => {
  await mount(); let attempted = false;
  intercept = request => { if (request.url.endsWith('/commands') && !attempted) { attempted = true; return Promise.reject(new TypeError('连接断开')); } };
  const original = command('原始姓名'); await act(async () => { expect(await capture(api.run(original))).toBeInstanceOf(Error); });
  (original.payload as any).profileName = '提交后修改';
  const pending = clone(api.pending!); expect(pending.command?.payload).toEqual({ profileName: '原始姓名' });
  await expect(api.run(command('新请求'))).rejects.toThrow('待核对');
  await expect(api.switchWorkspace(B)).rejects.toThrow('未完成');
  let recovered!: MistRunReceipt | undefined; await act(async () => { recovered = await api.recover(); });
  expect(posts()).toHaveLength(2);
  expect(JSON.parse(posts()[1].init.body as string)).toEqual(JSON.parse(posts()[0].init.body as string));
  expect(calls.findIndex(call => call.url.endsWith('/receipts/' + pending.requestId))).toBeLessThan(calls.indexOf(posts()[1]));
  expect(recovered?.requestId).toBe(pending.requestId); expect(api.state?.settings.profileName).toBe('原始姓名');
  expect(api.pending).toBeNull(); expect(localStorage.getItem('bambook.mist.pending:actor-a')).toBeNull();
});

it('recovers a committed request by receipt and newer snapshot without posting it twice', async () => {
  await mount(); intercept = request => { if (request.url.endsWith('/commands')) { commit(request); return Promise.reject(new TypeError('响应丢失')); } };
  await act(async () => { await capture(api.run(command('已经保存'))); }); const pending = clone(api.pending!);
  stores.get(A)!.revision = 2; stores.get(A)!.state.settings.workspaceName = '后续更新';
  let recovered!: MistRunReceipt | undefined; await act(async () => { recovered = await api.recover(); });
  expect(recovered).toEqual(receipts.get(pending.requestId)); expect(posts()).toHaveLength(1); expect(api.workspace?.revision).toBe(2);
  expect(api.state?.settings.profileName).toBe('已经保存'); expect(api.state?.settings.workspaceName).toBe('后续更新'); expect(api.pending).toBeNull();
});

it('retains the original intent when replay conflicts or receipt identity is invalid', async () => {
  await mount(); intercept = request => request.url.endsWith('/commands') ? Promise.reject(new TypeError('断开')) : undefined;
  await act(async () => { await capture(api.run(command('待核对'))); }); const original = clone(api.pending!);
  intercept = request => request.url.endsWith('/commands') ? failure(409, 'REVISION_CONFLICT') : undefined;
  const exactReads=calls.filter(call=>call.method==='GET'&&call.url===BASE+'/'+A).length;
  await act(async () => { expect(await capture(api.recover())).toBeInstanceOf(Error); }); expect(api.pending).toEqual(original);
  expect(calls.filter(call=>call.method==='GET'&&call.url===BASE+'/'+A)).toHaveLength(exactReads);
  intercept = request => request.url.includes('/receipts/') ? response({ receipt: { requestId: 'other', revision: 1, result: {} } }) : undefined;
  await act(async () => { expect(await capture(api.recover())).toBeInstanceOf(Error); }); expect(api.pending).toEqual(original); expect(api.workspace?.revision).toBe(0);
});

it('refreshes a definitively conflicted command without remounting the draft or replaying it',async()=>{
  function Draft(){const [value,setValue]=React.useState('');return <input aria-label="未保存确认依据" value={value} onChange={event=>setValue(event.target.value)}/>;}
  function CurrentForm(){const value=useMistWorkspace();return value.workspace?<Draft key={value.workspace.id}/>:null;}
  await mount();await act(async()=>root.render(<MistWorkspaceProvider><Probe/><CurrentForm/></MistWorkspaceProvider>));
  const control=host.querySelector<HTMLInputElement>('[aria-label="未保存确认依据"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(control,'用户填写的客户确认');control.dispatchEvent(new Event('input',{bubbles:true}));});
  const updated=clone(stores.get(A)!);updated.revision=3;updated.state.settings.theme='dark';stores.set(A,updated);
  let rejected:unknown;await act(async()=>{rejected=await capture(api.run(command(control.value)));});
  expect(rejected).toMatchObject({code:'REVISION_CONFLICT'});expect(api.workspace?.revision).toBe(3);expect(api.state?.settings.theme).toBe('dark');expect(api.error).toBe('请求被拒绝');expect(api.pending).toBeNull();expect(api.saving).toBe(false);
  expect(host.querySelector('[aria-label="未保存确认依据"]')).toBe(control);expect(control.value).toBe('用户填写的客户确认');expect(posts()).toHaveLength(1);expect(JSON.parse(posts()[0].init.body as string).expectedRevision).toBe(0);
  await act(async()=>{await api.run(command(control.value));});expect(posts()).toHaveLength(2);expect(JSON.parse(posts()[1].init.body as string).expectedRevision).toBe(3);expect(api.workspace?.revision).toBe(4);expect(api.state?.settings.profileName).toBe('用户填写的客户确认');
});

it('shares unchanged records by reference and replaces only what changed',()=>{
  const before={a:{id:'x',n:1},list:[{id:'1',v:1},{id:'2',v:2}],tags:['t']};
  const after=shareStructure(before,clone({...before,list:[{id:'2',v:3},{id:'1',v:1}]}));
  expect(after.a).toBe(before.a);expect(after.tags).toBe(before.tags);expect(after.list[1]).toBe(before.list[0]);expect(after.list[0]).not.toBe(before.list[1]);expect(after.list[0]).toEqual({id:'2',v:3});
  expect(shareStructure(before,clone(before))).toBe(before);
});

it('quietly syncs others\' saves when the window regains focus, keeping drafts and unchanged records',async()=>{
  function Draft(){const [value,setValue]=React.useState('');return <input aria-label="编辑中" value={value} onChange={event=>setValue(event.target.value)}/>;}
  function CurrentForm(){const value=useMistWorkspace();return value.workspace?<Draft key={value.workspace.id}/>:null;}
  await mount();await act(async()=>root.render(<MistWorkspaceProvider><Probe/><CurrentForm/></MistWorkspaceProvider>));
  const control=host.querySelector<HTMLInputElement>('[aria-label="编辑中"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(control,'还没保存');control.dispatchEvent(new Event('input',{bubbles:true}));});
  const orders=api.state!.orders,heads=()=>calls.filter(item=>item.url.endsWith('/revision')).length;
  await act(async()=>{window.dispatchEvent(new Event('focus'));await new Promise(r=>setTimeout(r,0));});
  expect(heads()).toBe(1);expect(api.workspace?.revision).toBe(0); // 版本没变：不读取完整内容
  const updated=clone(stores.get(A)!);updated.revision=5;updated.state.settings.theme='dark';stores.set(A,updated);
  await act(async()=>{window.dispatchEvent(new Event('focus'));await new Promise(r=>setTimeout(r,0));});
  expect(api.workspace?.revision).toBe(5);expect(api.state?.settings.theme).toBe('dark');expect(api.state!.orders).toBe(orders);expect(api.error).toBe('');
  expect(host.querySelector('[aria-label="编辑中"]')).toBe(control);expect(control.value).toBe('还没保存');expect(posts()).toHaveLength(0);
});

it('does not refresh on other definitive validation or permission rejections',async()=>{
  await mount();const initial=calls.filter(call=>call.method==='GET').length;
  for(const [status,code] of [[409,'PRECONDITION'],[403,'FORBIDDEN']] as const){intercept=request=>request.url.endsWith('/commands')?failure(status,code):undefined;await act(async()=>{await capture(api.run(command('保留原输入')));});expect(api.pending).toBeNull();}
  expect(calls.filter(call=>call.method==='GET')).toHaveLength(initial);expect(posts()).toHaveLength(2);expect(api.workspace?.revision).toBe(0);
});

it('does not publish a conflict refresh after the account has changed',async()=>{
  await mount();const delayed=deferred<ResponseData>();intercept=request=>request.url.endsWith('/commands')?failure(409,'REVISION_CONFLICT'):request.method==='GET'&&request.url===BASE+'/'+A?delayed.promise:undefined;
  let writing!:Promise<MistRunReceipt|Error>;await act(async()=>{writing=capture(api.run(command('旧身份输入')));});await waitFor(()=>calls.some(call=>call.url===BASE+'/'+A));
  auth.session={sessionKey:'session-b',user:{id:'actor-b'},status:'authenticated'};await render();await waitFor(()=>api.workspace?.id===D);
  const old=clone(stores.get(A)!);old.revision=3;await resolve(delayed,response({workspace:old}));expect(await writing).toMatchObject({code:'REVISION_CONFLICT'});expect(api.workspace?.id).toBe(D);expect(api.workspace?.revision).toBe(0);expect(api.error).toBe('');expect(posts()).toHaveLength(1);
});

it('does not let an older conflict refresh replace a newer workspace read',async()=>{
  await mount();const delayed=deferred<ResponseData>();let reads=0;const newer=clone(stores.get(A)!);newer.revision=4;newer.state.settings.profileName='另一个页面的最新资料';stores.set(A,newer);
  intercept=request=>request.url.endsWith('/commands')?failure(409,'REVISION_CONFLICT'):request.method==='GET'&&request.url===BASE+'/'+A&&++reads===1?delayed.promise:undefined;
  let writing!:Promise<MistRunReceipt|Error>;await act(async()=>{writing=capture(api.run(command('冲突输入')));});await waitFor(()=>reads===1);await act(async()=>api.refresh());expect(api.workspace?.revision).toBe(4);
  const older=clone(newer);older.revision=2;older.state.settings.profileName='旧返回';await resolve(delayed,response({workspace:older}));expect(await writing).toMatchObject({code:'REVISION_CONFLICT'});expect(api.workspace?.revision).toBe(4);expect(api.state?.settings.profileName).toBe('另一个页面的最新资料');expect(api.pending).toBeNull();expect(posts()).toHaveLength(1);
});

it('rejects inconsistent acknowledgement snapshots before clearing the saved intent', async () => {
  await mount(); intercept = request => {
    if (!request.url.endsWith('/commands')) return;
    const body = JSON.parse(request.init.body as string);
    return response({ receipt: { requestId: body.requestId, revision: 1, result: {} }, workspace: stores.get(B) });
  };
  await act(async () => { expect(await capture(api.run(command('不能写错对象')))).toBeInstanceOf(Error); });
  expect(api.pending).not.toBeNull(); expect(api.workspace?.id).toBe(A); expect(api.workspace?.revision).toBe(0);
});

it('restores a persisted operation into its exact workspace before recovery', async () => {
  const saved = { actorId: 'actor-a', workspaceId: B, requestId: 'request-restored', expectedRevision: 0, kind: 'command', command: command('恢复到乙') };
  localStorage.setItem('bambook.mist.pending:actor-a', JSON.stringify(saved)); await mount();
  expect(api.workspace?.id).toBe(B); expect(calls.some(call => call.url === BASE + '/default')).toBe(false);
  await act(async () => { await api.recover(); }); expect(api.workspace?.id).toBe(B); expect(api.state?.settings.profileName).toBe('恢复到乙');
  expect(JSON.parse(posts()[0].init.body as string).requestId).toBe(saved.requestId);
});

it('verifies upload bytes before retry and keeps the original request id for identical bytes', async () => {
  await mount(); let failed = false;
  intercept = request => { if (request.url.endsWith('/files') && !failed) { failed = true; return Promise.reject(new TypeError('上传结果未知')); } };
  const file = new File(['first bytes'], 'sample.pdf', { type: 'application/pdf' });
  await act(async () => { expect(await capture(api.uploadFile(file))).toBeInstanceOf(Error); }); const pending = clone(api.pending!);
  await act(async () => { expect(await capture(api.uploadFile(new File(['other bytes'], 'sample.pdf', { type: 'application/pdf' })))).toBeInstanceOf(Error); });
  expect(posts()).toHaveLength(1); expect(api.pending).toEqual(pending);
  let saved!: MistFile; await act(async () => { saved = await api.uploadFile(file); });
  expect((posts()[1].init.body as FormData).get('requestId')).toBe(pending.requestId); expect(saved.storageKey).toBe(A + '/' + saved.id);
  expect(api.pending).toBeNull(); expect(api.fileUrl(saved)).toBe(BASE + '/' + A + '/files/' + saved.id);
  const retiredUrl = api.fileUrl; await act(async () => { await api.switchWorkspace(B); });
  expect(() => retiredUrl(saved)).toThrow('工作区'); expect(() => api.fileUrl(saved)).toThrow('不属于');
});

it('freezes the claim upload target in pending recovery and refuses changing cases or using general upload for the same file',async()=>{
  await mount();let failed=false;intercept=request=>{if(request.url.endsWith('/files')&&!failed){failed=true;return Promise.reject(new TypeError('上传结果未知'));}};
  const file=new File(['claim evidence'],'claim-proof.pdf',{type:'application/pdf'});
  await act(async()=>{expect(await capture(api.uploadFile(file,{claimId:'claim-one'}))).toBeInstanceOf(Error);});const pending=clone(api.pending!);
  expect(pending).toMatchObject({kind:'upload',claimId:'claim-one'});expect(JSON.parse(localStorage.getItem('bambook.mist.pending:actor-a')!)).toMatchObject({claimId:'claim-one'});
  await act(async()=>{expect(await capture(api.uploadFile(file,{claimId:'claim-two'}))).toBeInstanceOf(Error);expect(await capture(api.uploadFile(file))).toBeInstanceOf(Error);});
  expect(posts()).toHaveLength(1);expect((posts()[0].init.body as FormData).get('claimId')).toBe('claim-one');
  let saved!:MistFile;await act(async()=>{saved=await api.uploadFile(file,{claimId:'claim-one'});});
  expect((posts()[1].init.body as FormData).get('claimId')).toBe('claim-one');expect((posts()[1].init.body as FormData).get('requestId')).toBe(pending.requestId);expect(api.pending).toBeNull();expect(saved.storageKey).toBe(A+'/'+saved.id);
});

it('rejects an upload receipt for another claim while retaining the original target for receipt recovery',async()=>{
  await mount();intercept=request=>{if(!request.url.endsWith('/files'))return;const result=upload(request);return response({workspace:stores.get(A),receipt:{...receipts.get(String((request.init.body as FormData).get('requestId'))),result:{fileId:'file-0',claimId:'claim-other'}}});};
  await act(async()=>{expect(await capture(api.uploadFile(new File(['evidence'],'claim.pdf'),{claimId:'claim-one'}))).toBeInstanceOf(Error);});
  expect(api.state?.files).toHaveLength(0);expect(api.pending).toMatchObject({kind:'upload',claimId:'claim-one'});
  intercept=undefined;await act(async()=>{await api.recover();});expect(api.pending).toBeNull();expect(api.state?.files).toHaveLength(1);
});

it.each([{claimId:''},{claimId:' claim-one'},{claimId:'../claim-one'},{claimId:null},{},{claimId:'claim-one',permission:'products:write'}])('rejects invalid explicit upload options %j without making a request',async options=>{
  await mount();await act(async()=>{expect(await capture(api.uploadFile(new File(['evidence'],'claim.pdf'),options as any))).toBeInstanceOf(Error);});expect(posts()).toHaveLength(0);expect(api.pending).toBeNull();
});

it('blocks oversized uploads and parallel uploads while file bytes are still being read', async () => {
  await mount(); const over = new File(['x'], 'large.pdf'); Object.defineProperty(over, 'size', { value: 50 * 1024 * 1024 + 1 });
  await expect(api.uploadFile(over)).rejects.toThrow('50MiB'); expect(posts()).toHaveLength(0);
  const wait = deferred<ArrayBuffer>(), file = new File(['x'], 'pending.pdf'); Object.defineProperty(file, 'arrayBuffer', { value: () => wait.promise });
  let first!: Promise<MistFile>, second!: Promise<MistFile | Error>;
  await act(async () => { first = api.uploadFile(file); second = capture(api.uploadFile(file)); });
  expect(await second).toBeInstanceOf(Error); expect(posts()).toHaveLength(0);
  await resolve(wait, new Uint8Array([120]).buffer); await act(async () => { await first; }); expect(posts()).toHaveLength(1);
});

it('does not send a mutation without a durable recovery record', async () => {
  await mount(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('存储不可用'); });
  await act(async () => { expect(await capture(api.run(command('不可提交')))).toBeInstanceOf(Error); });
  expect(posts()).toHaveLength(0); expect(api.saving).toBe(false); expect(api.pending).toBeNull();
});

it('shows a malformed recovery record warning without silently reviving it', async () => {
  localStorage.setItem('bambook.mist.pending:actor-a', '{invalid'); await mount();
  expect(api.error).toBeTruthy(); expect(api.pending).toBeNull();
  await act(async () => { await api.run(command('新的有效命令')); }); expect(api.workspace?.revision).toBe(1);
});

it('hides the former account workspace, list and pending command in the first changed-identity render', async () => {
  await mount(); intercept = request => request.url.endsWith('/commands') ? Promise.reject(new TypeError('断开')) : undefined;
  await act(async () => { await capture(api.run(command('私有修改'))); }); expect(api.pending).not.toBeNull();
  const start = renderedScopes.length;
  auth.session = { sessionKey: 'session-a', user: { id: 'actor-b' }, status: 'authenticated' }; await render();
  expect(renderedScopes[start]).toEqual({ workspace: undefined, workspaces: 0, pending: null });
  await waitFor(() => api.workspace?.id === D); expect(api.pending).toBeNull();
});

it('retains an upload with a foreign storage scope and can recover the correct file receipt', async () => {
  await mount(); let requestId = '';
  intercept = request => {
    if (!request.url.endsWith('/files')) return;
    const result = upload(request); requestId = String((request.init.body as FormData).get('requestId'));
    const wrong = clone(stores.get(A)!); wrong.state.files[0].storageKey = B + '/' + wrong.state.files[0].id;
    return response({ workspace: wrong, receipt: receipts.get(requestId) });
  };
  await act(async () => { expect(await capture(api.uploadFile(new File(['original'], 'scope.pdf')))).toBeInstanceOf(Error); });
  expect(api.pending?.requestId).toBe(requestId); expect(api.state?.files).toHaveLength(0);
  let recovered!: MistRunReceipt | undefined; await act(async () => { recovered = await api.recover(); });
  expect(recovered?.requestId).toBe(requestId); expect(api.state?.files[0].storageKey).toBe(A + '/' + api.state?.files[0].id);
  expect(api.pending).toBeNull(); expect(posts()).toHaveLength(1);
});

it('clears a new definitively rejected request but keeps an uncertain replay after permission rejection', async () => {
  await mount(); intercept = request => request.url.endsWith('/commands') ? failure(403, 'FORBIDDEN') : undefined;
  await act(async () => { expect(await capture(api.run(command('拒绝')))).toBeInstanceOf(Error); }); expect(api.pending).toBeNull();
  intercept = request => request.url.endsWith('/commands') ? Promise.reject(new TypeError('断开')) : undefined;
  await act(async () => { await capture(api.run(command('未知'))); }); const pending = clone(api.pending);
  intercept = request => request.url.endsWith('/commands') ? failure(403, 'FORBIDDEN') : undefined;
  await act(async () => { expect(await capture(api.recover())).toBeInstanceOf(Error); }); expect(api.pending).toEqual(pending);
});

it('does not finish a download after its account is replaced', async () => {
  const file: MistFile = { id: 'private-file', name: 'private.pdf', size: 4, mimeType: 'application/pdf', storageKey: A + '/private-file', createdAt: '2026-10-13' };
  stores.get(A)!.state.files.push(file); await mount(); const bytes = deferred<Blob>();
  intercept = request => request.url.endsWith('/files/private-file') ? { ok: true, status: 200, json: async () => ({}), blob: () => bytes.promise } as ResponseData : undefined;
  const create = vi.fn(); vi.stubGlobal('URL', class extends URL { static createObjectURL = create; });
  let downloading!: Promise<void | Error>; await act(async () => { downloading = capture(api.downloadFile(file)); });
  auth.session = { sessionKey: 'session-b', user: { id: 'actor-b' }, status: 'authenticated' }; await render(); await waitFor(() => api.workspace?.id === D);
  await resolve(bytes, new Blob(['data'])); expect(await downloading).toBeInstanceOf(Error); expect(create).not.toHaveBeenCalled();
});

it('rejects a callback retained after the provider unmounts', async () => {
  await mount(); const retired = api.run; act(() => root.unmount()); root = createRoot(host);
  await expect(retired(command('卸载后'))).rejects.toThrow('会话'); expect(posts()).toHaveLength(0);
});

it('does not treat a legacy upload with no content digest as proof of identical bytes', async () => {
  localStorage.setItem('bambook.mist.pending:actor-a', JSON.stringify({ actorId: 'actor-a', workspaceId: A, requestId: 'old-upload', expectedRevision: 0, kind: 'upload', file: { name: 'same.pdf', size: 4 } }));
  await mount();
  await act(async () => { const result = await capture(api.uploadFile(new File(['data'], 'same.pdf'))); expect(result).toBeInstanceOf(Error); expect((result as Error).message).toContain('内容摘要'); });
  expect(api.pending?.requestId).toBe('old-upload'); expect(posts()).toHaveLength(0);
});

it('durably records creation before posting and switches only after its matching creation receipt', async () => {
  strict = true; await mount(); let storedBeforeRequest: any;
  intercept = request => { if (request.url === BASE && request.method === 'POST') storedBeforeRequest = JSON.parse(localStorage.getItem('bambook.mist.pending-create:actor-a')!); return undefined; };
  await act(async () => { await api.createWorkspace('新工作区', 'empty'); });
  expect(storedBeforeRequest).toMatchObject({ actorId: 'actor-a', name: '新工作区', seed: 'empty' });
  expect(JSON.parse(posts()[0].init.body as string).slug).toBe(storedBeforeRequest.slug);
  expect(api.workspace?.name).toBe('新工作区'); expect(api.workspace?.id).toBe('created-0'); expect(api.pendingCreate).toBeNull(); expect(api.error).toBe('');
  expect(localStorage.getItem('bambook.mist.pending-create:actor-a')).toBeNull();
});

it('replays an unknown committed creation with the same slug and blocks replacement parameters', async () => {
  await mount(); let lost = false;
  intercept = request => { if (request.url === BASE && request.method === 'POST' && !lost) { lost = true; create(request); return Promise.reject(new TypeError('创建响应丢失')); } };
  await act(async () => { expect(await capture(api.createWorkspace('只创建一次', 'demo'))).toBeInstanceOf(Error); });
  const pending = clone(api.pendingCreate!); expect(api.workspace?.id).toBe(A); expect(api.error).toContain('相同名称');
  await expect(api.createWorkspace('不同名称', 'demo')).rejects.toThrow('原创建请求');
  await expect(api.createWorkspace('只创建一次', 'empty')).rejects.toThrow('原创建请求');
  await expect(api.run(command('未解决前不可另写'))).rejects.toThrow('原创建请求'); await expect(api.switchWorkspace(B)).rejects.toThrow('未完成');
  await act(async () => { await api.createWorkspace('只创建一次', 'demo'); });
  expect(posts()).toHaveLength(2); expect(JSON.parse(posts()[1].init.body as string)).toEqual(JSON.parse(posts()[0].init.body as string));
  expect(creations.size).toBe(1); expect(api.workspace?.id).toBe('created-0'); expect(api.pendingCreate).toBeNull(); expect(api.error).toBe('');
  expect(pending.slug).toBe(JSON.parse(posts()[1].init.body as string).slug);
});

it('restores a lost creation after remount and preserves its retry instruction across refresh', async () => {
  await mount(); let lost = false;
  intercept = request => { if (request.url === BASE && request.method === 'POST' && !lost) { lost = true; return Promise.reject(new TypeError('断开')); } };
  await act(async () => { await capture(api.createWorkspace('刷新后恢复', 'empty')); }); const pending = clone(api.pendingCreate!);
  act(() => root.unmount()); root = createRoot(host); await mount();
  expect(api.pendingCreate).toEqual(pending); expect(api.error).toContain('刷新后恢复'); expect(posts()).toHaveLength(1);
  await act(async () => { await api.refresh(); }); expect(api.error).toContain('相同名称');
  await act(async () => { await api.createWorkspace(pending.name, pending.seed); });
  expect(creations.size).toBe(1); expect(JSON.parse(posts()[1].init.body as string).slug).toBe(pending.slug); expect(api.workspace?.id).toBe('created-0');
});

it('locks simultaneous create attempts before rerender and keeps writes out of the pending creation', async () => {
  await mount(); const waiting = deferred<ResponseData>(); intercept = request => request.url === BASE && request.method === 'POST' ? waiting.promise : undefined;
  let first!: Promise<void>, second!: Promise<void | Error>; await act(async () => { first = api.createWorkspace('双击'); second = capture(api.createWorkspace('双击')); });
  expect(await second).toBeInstanceOf(Error); expect(posts()).toHaveLength(1); expect(api.saving).toBe(true);
  await expect(api.uploadFile(new File(['x'], 'x.pdf'))).rejects.toThrow('原创建请求');
  await resolve(waiting, create(posts()[0])); await first; expect(api.saving).toBe(false); expect(creations.size).toBe(1);
});

it('does not publish or clear a creation belonging to a retired account', async () => {
  await mount(); const retired = api.createWorkspace, waiting = deferred<ResponseData>(); intercept = request => request.url === BASE && request.method === 'POST' ? waiting.promise : undefined;
  let pending!: Promise<void | Error>; await act(async () => { pending = capture(retired('账号甲的工作区')); });
  auth.session = { sessionKey: 'session-b', user: { id: 'actor-b' }, status: 'authenticated' }; await render(); await waitFor(() => api.workspace?.id === D);
  await expect(retired('旧回调')).rejects.toThrow('会话'); await resolve(waiting, create(posts()[0])); expect(await pending).toBeInstanceOf(Error);
  expect(api.workspace?.id).toBe(D); expect(api.pendingCreate).toBeNull(); expect(localStorage.getItem('bambook.mist.pending-create:actor-a')).not.toBeNull();
  expect(localStorage.getItem('bambook.mist.pending-create:actor-b')).toBeNull();
});

it('retains creation intent when its returned receipt identifies a different workspace', async () => {
  await mount(); intercept = request => request.url.includes('/receipts/create%3A') ? response({ receipt: { requestId: decodeURIComponent(request.url.split('/').at(-1)!), revision: 0, result: { workspaceId: B } } }) : undefined;
  await act(async () => { expect(await capture(api.createWorkspace('核对来源'))).toBeInstanceOf(Error); });
  expect(api.workspace?.id).toBe(A); expect(api.pendingCreate?.name).toBe('核对来源'); expect(api.error).toContain('创建回执');
  intercept = undefined; await act(async () => { await api.createWorkspace('核对来源'); }); expect(creations.size).toBe(1); expect(api.workspace?.id).toBe('created-0');
});

it('prevents a creation without local recovery storage and clears only a definitively rejected new request', async () => {
  await mount(); const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('本机存储不可用'); });
  await act(async () => { expect(await capture(api.createWorkspace('未提交'))).toBeInstanceOf(Error); }); expect(posts()).toHaveLength(0); expect(api.pendingCreate).toBeNull(); storage.mockRestore();
  intercept = request => request.url === BASE && request.method === 'POST' ? failure(403, 'FORBIDDEN') : undefined;
  await act(async () => { expect(await capture(api.createWorkspace('被拒绝'))).toBeInstanceOf(Error); });
  expect(api.pendingCreate).toBeNull(); expect(localStorage.getItem('bambook.mist.pending-create:actor-a')).toBeNull(); expect(api.saving).toBe(false);
});

it('does not clear an earlier uncertain creation when retry permission is later rejected', async () => {
  await mount(); intercept = request => request.url === BASE && request.method === 'POST' ? Promise.reject(new TypeError('断网')) : undefined;
  await act(async () => { await capture(api.createWorkspace('待确认')); }); const pending = clone(api.pendingCreate!);
  intercept = request => request.url === BASE && request.method === 'POST' ? failure(403, 'FORBIDDEN') : undefined;
  await act(async () => { await capture(api.createWorkspace('待确认')); }); expect(api.pendingCreate).toEqual(pending); expect(JSON.parse(localStorage.getItem('bambook.mist.pending-create:actor-a')!)).toEqual(pending);
});

it('retires creation callbacks after a workspace switch and after unmount', async () => {
  await mount(); const retired = api.createWorkspace; await act(async () => { await api.switchWorkspace(B); });
  await expect(retired('旧页面创建')).rejects.toThrow('当前工作区');
  const unmounted = api.createWorkspace; act(() => root.unmount()); root = createRoot(host);
  await expect(unmounted('卸载后创建')).rejects.toThrow('会话'); expect(posts()).toHaveLength(0);
});

it('retains the acknowledged new workspace when its follow-up refresh fails', async () => {
  await mount(); intercept = request => request.url === BASE + '/created-0' ? failure(503) : undefined;
  await act(async () => { await api.createWorkspace('创建已确认'); });
  expect(api.workspace?.id).toBe('created-0'); expect(api.workspace?.name).toBe('创建已确认'); expect(api.pendingCreate).toBeNull();
  expect(api.error).toBe('请求被拒绝'); expect(creations.size).toBe(1);
  expect(localStorage.getItem('bambook.mist.selected-workspace:actor-a')).toBe('created-0');
});

it('reopens the selected workspace after remount without fetching the default workspace', async () => {
  await mount(); await act(async () => { await api.switchWorkspace(B); });
  expect(localStorage.getItem('bambook.mist.selected-workspace:actor-a')).toBe(B);
  act(() => root.unmount()); root = createRoot(host); calls = []; await mount();
  expect(api.workspace?.id).toBe(B); expect(calls[0].url).toBe(BASE + '/' + B); expect(calls.some(call => call.url === BASE + '/default')).toBe(false);
});

it('keeps selected IDs isolated between actors and restores each actor selection', async () => {
  localStorage.setItem('bambook.mist.selected-workspace:actor-a', B); localStorage.setItem('bambook.mist.selected-workspace:actor-b', D);
  await mount(); expect(api.workspace?.id).toBe(B); const retired = api.switchWorkspace;
  auth.session = { sessionKey: 'session-b', user: { id: 'actor-b' }, status: 'authenticated' }; await render(); await waitFor(() => api.workspace?.id === D);
  await expect(retired(C)).rejects.toThrow('会话'); expect(localStorage.getItem('bambook.mist.selected-workspace:actor-a')).toBe(B); expect(localStorage.getItem('bambook.mist.selected-workspace:actor-b')).toBe(D);
  auth.session = { sessionKey: 'session-a-again', user: { id: 'actor-a' }, status: 'authenticated' }; await render(); await waitFor(() => api.workspace?.id === B);
});

it('clears a missing remembered ID on 404 and selects the verified default workspace', async () => {
  localStorage.setItem('bambook.mist.selected-workspace:actor-a', 'deleted-workspace'); await mount();
  expect(calls[0].url).toBe(BASE + '/deleted-workspace'); expect(calls.some(call => call.url === BASE + '/default')).toBe(true);
  expect(api.workspace?.id).toBe(A); expect(localStorage.getItem('bambook.mist.selected-workspace:actor-a')).toBe(A); expect(api.error).toBe('');
});

it.each(['forbidden', 'server-error', 'network'])('preserves a remembered workspace on %s without silently loading another workspace', async mode => {
  localStorage.setItem('bambook.mist.selected-workspace:actor-a', B);
  intercept = request => request.url === BASE + '/' + B ? mode === 'network' ? Promise.reject(new TypeError('断网')) : failure(mode === 'forbidden' ? 403 : 503) : undefined;
  await render(); await waitFor(() => !api.loading); expect(api.workspace).toBeNull(); expect(api.error).toBeTruthy();
  expect(localStorage.getItem('bambook.mist.selected-workspace:actor-a')).toBe(B); expect(calls.some(call => call.url === BASE + '/default')).toBe(false);
  intercept = undefined; await act(async () => { await api.refresh(); }); expect(api.workspace?.id).toBe(B);
});

it('does not replace a successful selection after a failed switch or unknown creation', async () => {
  await mount(); await act(async () => { await api.switchWorkspace(B); });
  intercept = request => request.url === BASE + '/' + C ? failure(403) : request.url === BASE && request.method === 'POST' ? Promise.reject(new TypeError('创建结果未知')) : undefined;
  await act(async () => { await api.switchWorkspace(C); }); expect(localStorage.getItem('bambook.mist.selected-workspace:actor-a')).toBe(B);
  intercept = undefined; await act(async () => { await api.switchWorkspace(B); });
  intercept = request => request.url === BASE && request.method === 'POST' ? Promise.reject(new TypeError('创建结果未知')) : undefined;
  await act(async () => { await capture(api.createWorkspace('尚未确认')); }); expect(localStorage.getItem('bambook.mist.selected-workspace:actor-a')).toBe(B);
});

it('persists a receipt-confirmed creation and reopens it after refresh', async () => {
  await mount(); await act(async () => { await api.createWorkspace('刷新仍在此处'); });
  const createdId = api.workspace!.id; expect(localStorage.getItem('bambook.mist.selected-workspace:actor-a')).toBe(createdId);
  act(() => root.unmount()); root = createRoot(host); calls = []; await mount();
  expect(api.workspace?.id).toBe(createdId); expect(calls[0].url).toBe(BASE + '/' + createdId); expect(calls.some(call => call.url === BASE + '/default')).toBe(false);
});

it('keeps unknown command recovery attached to its precise missing workspace instead of falling back', async () => {
  localStorage.setItem('bambook.mist.selected-workspace:actor-a', A);
  localStorage.setItem('bambook.mist.pending:actor-a', JSON.stringify({ actorId: 'actor-a', workspaceId: B, requestId: 'exact-pending', expectedRevision: 0, kind: 'command', command: command('原对象') }));
  intercept = request => request.url === BASE + '/' + B ? failure(404) : undefined;
  await render(); await waitFor(() => !api.loading);
  expect(api.workspace).toBeNull(); expect(api.pending?.workspaceId).toBe(B); expect(calls.some(call => call.url === BASE + '/default')).toBe(false);
  expect(localStorage.getItem('bambook.mist.selected-workspace:actor-a')).toBe(A);
});

it('routes mail actions to the server mail endpoints and adopts the returned workspace; failures reload instead of guessing', async () => {
  await mount();
  intercept = request => {
    if (!request.url.includes('/email/')) return undefined;
    const value = clone(stores.get(A)!); value.revision++; value.state.settings.profileName = 'after-mail'; stores.set(A, value);
    if (request.url.endsWith('/sends')) { (value.state as any).email.sends.unshift({ id: 'send-1', requestKey: 'abcdefgh12', accountId: 'acc', createdById: 'actor-a' }); stores.set(A, value); }
    if (request.url.endsWith('/sends')) return response({ workspace: value, receipt: { requestId: 'mail-1', revision: value.revision, result: {} }, send: { id: 'send-1', status: 'unknown', message: '连接中断' } });
    if (request.url.endsWith('/credential') && request.method === 'PUT') return failure(422, 'MAIL_AUTH_FAILED');
    return response({ workspace: value, receipt: { requestId: 'mail-2', revision: value.revision, result: {} }, sync: { remaining: 0 } });
  };
  let result: any;
  await act(async () => { result = await api.mail!({ kind: 'send', requestKey: 'abcdefgh12', input: { accountId: 'acc' } }); });
  const sent = calls.filter(call => call.url.includes('/email/')).at(-1)!;
  expect(sent.url).toBe(BASE + '/' + A + '/email/sends');
  expect(JSON.parse(sent.init.body as string)).toEqual({ requestKey: 'abcdefgh12', input: { accountId: 'acc' } });
  expect(result).toEqual({ send: { id: 'send-1', status: 'unknown', message: '连接中断' } });
  expect(api.state?.settings.profileName).toBe('after-mail');
  await act(async () => { await api.mail!({ kind: 'retry', sendId: 'send 1', confirmUnknown: true }); });
  const retry = calls.filter(call => call.url.includes('/email/')).at(-1)!;
  expect(retry.url).toBe(BASE + '/' + A + '/email/sends/send%201/retry');
  expect(JSON.parse(retry.init.body as string)).toEqual({ confirmUnknown: true });
  const before = calls.length;
  await act(async () => { await expect(api.mail!({ kind: 'bind', accountId: 'acc', password: 'pw' })).rejects.toThrow('请求被拒绝'); });
  expect(calls.slice(before).some(call => call.method === 'GET' && call.url.startsWith(BASE + '/' + A))).toBe(true);
  expect(api.saving).toBe(false);
});

/** 合成发送服务：同一 requestKey 只登记、只投递一次；可选在登记后丢失响应、篡改回执字段，或像服务端“同内容未决记录”那样回到已有记录。 */
function mailServer(options: { dropAfterCommit?: number; dropBeforeCommit?: number; dropOn?: number[]; foreignKey?: boolean; reject?: { status: number; code: string }; tamper?: Record<string, string>; sameContent?: boolean; alias?: boolean; status?: string } = {}) {
  const deliveries: string[] = []; let posts = 0;
  intercept = request => {
    if (!(request.method === 'POST' && request.url.endsWith('/email/sends'))) return undefined;
    posts++;
    if (options.reject) return failure(options.reject.status, options.reject.code);
    if (options.dropBeforeCommit && posts <= options.dropBeforeCommit) return Promise.reject(new TypeError('连接断开'));
    const body = JSON.parse(request.init.body as string), value = clone(stores.get(A)!), sends = (value.state as any).email.sends as any[];
    const same = (item: any) => item.accountId === body.input.accountId && item.subject === body.input.subject && item.to === body.input.to && item.body === (body.input.body || '');
    let row = sends.find(item => item.requestKey === body.requestKey || (item.aliasKeys || []).includes(body.requestKey)), replayed = !!row, recoveredFor: string | undefined;
    // 合成服务端的意图冲突：同一 key（含别名）内容不同则 409，不投递。
    if (row && !options.foreignKey && !options.tamper && !same(row)) return failure(409, 'SEND_INTENT_CONFLICT');
    if (row && row.requestKey !== body.requestKey) recoveredFor = body.requestKey;
    if (!row && options.sameContent) { row = sends.find(same); replayed = !!row; }
    // 合成服务端的别名登记：同内容未决记录（unknown / sending）回到原记录，并持久登记新 key。
    if (!row && options.alias) { row = sends.find(item => same(item) && ['unknown', 'sending'].includes(item.status)); if (row) { row.aliasKeys = [...(row.aliasKeys || []), body.requestKey]; recoveredFor = body.requestKey; replayed = true; value.revision++; stores.set(A, value); } }
    if (!row) { row = { id: 'send-' + (sends.length + 1), requestKey: options.foreignKey ? 'otherkey123' : body.requestKey, accountId: body.input.accountId, createdById: 'actor-a', to: body.input.to || '', cc: body.input.cc || '', bcc: body.input.bcc || '', subject: body.input.subject, body: body.input.body || '', status: options.status || 'sent', ...options.tamper }; sends.unshift(row); deliveries.push(body.requestKey); value.revision++; stores.set(A, value); }
    if (options.dropAfterCommit && posts <= options.dropAfterCommit || options.dropOn?.includes(posts)) return Promise.reject(new TypeError('响应丢失'));
    return response({ workspace: value, send: { id: row.id, status: row.status, ...(replayed ? { replayed: true } : {}), ...(recoveredFor ? { recovered: true, recoveredFor } : {}) } });
  };
  return { deliveries, posts: () => posts };
}
const sendAction = (requestKey = 'compose-key-0001', extra: Record<string, unknown> = {}) => ({ kind: 'send' as const, requestKey, input: { accountId: 'acc', to: 'buyer@preview.test', subject: '样品确认', body: '正文' }, ...extra });
const stored = () => localStorage.getItem('bambook.mist.pending:actor-a');
const claims = () => JSON.parse(localStorage.getItem('bambook.mist.mail-receipts:actor-a') || '[]').map((row: any) => [row.requestKey, row.sendId]);
const sendPosts = () => calls.filter(call => call.method === 'POST' && call.url.endsWith('/email/sends')).length;
const setSend = (id: string, patch: Record<string, unknown>) => { const value = clone(stores.get(A)!); Object.assign((value.state as any).email.sends.find((row: any) => row.id === id), patch); value.revision++; stores.set(A, value); };
const remount = async () => { await act(async () => root.unmount()); root = createRoot(host); await mount(); };

it('persists a send intent before posting and recovers a lost receipt after remount with the original key, delivering once', async () => {
  await mount(); const server = mailServer({ dropAfterCommit: 1 }); let seen = '';
  const inner = intercept!; intercept = request => { if (request.url.endsWith('/email/sends')) seen = stored() || ''; return inner(request); };
  await act(async () => { const error = await capture(api.mail!(sendAction('compose-key-0001', { forwardOfId: 'msg-1' }))); expect(String(error)).toContain('发送结果尚未确认'); });
  expect(JSON.parse(seen)).toMatchObject({ kind: 'mail-send', requestId: 'compose-key-0001', workspaceId: A, mail: { requestKey: 'compose-key-0001', forwardOfId: 'msg-1', input: { subject: '样品确认' } } });
  expect(api.pending?.kind).toBe('mail-send'); expect(server.deliveries).toHaveLength(1);
  await expect(api.mail!(sendAction('compose-key-0002'))).rejects.toThrow('待核对');
  await expect(api.mail!({ kind: 'sync', accountId: 'acc' })).rejects.toThrow('待核对');
  await act(async () => root.unmount()); root = createRoot(host); await mount();
  expect(api.workspace?.id).toBe(A); expect(api.pending?.mail?.requestKey).toBe('compose-key-0001');
  let recovered: any; await act(async () => { recovered = await api.recover(); });
  expect(recovered.result.send).toMatchObject({ id: 'send-1', replayed: true });
  const bodies = calls.filter(call => call.method === 'POST' && call.url.endsWith('/email/sends')).map(call => JSON.parse(call.init.body as string));
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  expect(server.deliveries).toEqual(['compose-key-0001']); expect((api.state as any).email.sends.filter((row: any) => row.requestKey === 'compose-key-0001')).toHaveLength(1);
  expect(api.pending).toBeNull(); expect(stored()).toBeNull();
});

it('sends a never-received draft intent exactly once on recovery and then allows a new explicit send', async () => {
  await mount(); const server = mailServer({ dropBeforeCommit: 1 });
  await act(async () => { await capture(api.mail!(sendAction('draft-d1-1700000000000', { draftId: 'd1' }))); });
  expect(server.deliveries).toHaveLength(0); expect(api.pending?.mail?.draftId).toBe('d1');
  await act(async () => { await api.recover(); });
  expect(server.deliveries).toEqual(['draft-d1-1700000000000']); expect(api.pending).toBeNull();
  let again: any; await act(async () => { again = await api.mail!(sendAction('compose-key-0003')); });
  expect(again.send.status).toBe('sent'); expect(server.deliveries).toHaveLength(2);
});

it('keeps the intent when the receipt names another request, clears definitive rejections and keeps busy or uncertain ones', async () => {
  await mount(); mailServer({ foreignKey: true });
  await act(async () => { await expect(api.mail!(sendAction())).rejects.toThrow('与原请求不符'); });
  expect(api.pending?.kind).toBe('mail-send'); expect(stored()).not.toBeNull();
  localStorage.clear(); await act(async () => root.unmount()); root = createRoot(host); await mount();
  mailServer({ reject: { status: 409, code: 'MAIL_BUSY' } });
  await act(async () => { await capture(api.mail!(sendAction())); }); expect(api.pending?.kind).toBe('mail-send');
  mailServer({ reject: { status: 409, code: 'SEND_INTENT_CONFLICT' } });
  await act(async () => { await capture(api.recover()); }); expect(api.pending).toBeNull(); expect(stored()).toBeNull();
});

it('never stores credentials, refuses sends without durable storage, and hides a send intent from another account', async () => {
  await mount(); let during: string | null = 'unset';
  intercept = request => { if (request.url.endsWith('/credential')) { during = stored(); return response({ workspace: stores.get(A) }); } return undefined; };
  await act(async () => { await api.mail!({ kind: 'bind', accountId: 'acc', password: 'secret-pw' }); });
  expect(during).toBeNull(); expect(JSON.stringify({ ...localStorage })).not.toContain('secret-pw');
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('存储不可用'); });
  const server = mailServer(); await act(async () => { await expect(api.mail!(sendAction())).rejects.toThrow('本次尚未提交'); });
  expect(server.posts()).toBe(0); spy.mockRestore();
  mailServer({ dropAfterCommit: 1 }); await act(async () => { await capture(api.mail!(sendAction())); }); expect(api.pending?.kind).toBe('mail-send');
  auth.session = { sessionKey: 'session-b', user: { id: 'actor-b' }, status: 'authenticated' }; await render(); await waitFor(() => api.workspace?.id === D);
  expect(api.pending).toBeNull(); expect(localStorage.getItem('bambook.mist.pending:actor-b')).toBeNull();
});

it('closes each lost-receipt intent against its own receipt: A then B each deliver once and stay closed after restart', async () => {
  await mount(); const server = mailServer({ dropOn: [1, 3] });
  await act(async () => { await capture(api.mail!(sendAction('intent-a-0001'))); }); expect(api.pending?.mail?.requestKey).toBe('intent-a-0001');
  await remount(); let first: any; await act(async () => { first = await api.recover(); });
  expect(first.result.send).toMatchObject({ id: 'send-1', replayed: true }); expect(api.pending).toBeNull(); expect(claims()).toEqual([['intent-a-0001', 'send-1']]);
  // 新意图 B：内容不同的新邮件，同样丢失回执。
  await act(async () => { await capture(api.mail!(sendAction('intent-b-0001', { input: { accountId: 'acc', to: 'ops@preview.test', subject: '第二封确认', body: '正文二' } }))); });
  const intentB = stored(); expect(api.pending?.mail?.requestKey).toBe('intent-b-0001');
  await remount(); let second: any; await act(async () => { second = await api.recover(); });
  expect(second.result.send).toMatchObject({ id: 'send-2', replayed: true }); expect(api.pending).toBeNull();
  expect(claims()).toEqual([['intent-a-0001', 'send-1'], ['intent-b-0001', 'send-2']]);
  expect(server.deliveries).toEqual(['intent-a-0001', 'intent-b-0001']);
  // 重启后（结案已登记、待核对记录尚在）再核对：只读取原回执，不再提交发送。
  localStorage.setItem('bambook.mist.pending:actor-a', intentB!); const before = sendPosts();
  await remount(); expect(api.pending?.mail?.requestKey).toBe('intent-b-0001');
  let again: any; await act(async () => { again = await api.recover(); });
  expect(again.result.send).toMatchObject({ id: 'send-2' }); expect(sendPosts()).toBe(before); expect(api.pending).toBeNull();
  expect(server.deliveries).toEqual(['intent-a-0001', 'intent-b-0001']);
});

it.each([
  { name: 'wrong account', tamper: { accountId: 'other-acc' }, reason: '发件账号不一致' },
  { name: 'wrong subject', tamper: { subject: '别的主题' }, reason: '主题不一致' },
  { name: 'wrong recipients', tamper: { to: 'stranger@preview.test' }, reason: '收件人不一致' },
])('stops at manual review for a receipt with the $name, without counting it sent or resending, also after restart', async ({ tamper, reason }) => {
  await mount(); const server = mailServer({ dropAfterCommit: 1, tamper });
  await act(async () => { await capture(api.mail!(sendAction())); }); expect(server.deliveries).toHaveLength(1);
  await act(async () => { const error = await capture(api.recover()); expect(String(error)).toContain(reason); expect(String(error)).toContain('待人工核对'); });
  expect(api.pending?.mail?.review).toContain(reason); expect(claims()).toEqual([]);
  const posts = server.posts();
  await act(async () => { expect(String(await capture(api.recover()))).toContain('待人工核对'); }); expect(server.posts()).toBe(posts);
  await remount(); expect(api.pending?.mail?.review).toContain(reason);
  await act(async () => { expect(String(await capture(api.recover()))).toContain('不会自动重发'); });
  expect(server.posts()).toBe(posts); expect(server.deliveries).toHaveLength(1); expect(claims()).toEqual([]);
  await act(async () => { await api.closeMailReview!(); }); expect(api.pending).toBeNull(); expect(stored()).toBeNull(); expect(server.posts()).toBe(posts);
});

it('refuses a receipt already claimed by another intent: not sent, not resent, same after restart', async () => {
  await mount(); const server = mailServer({ dropAfterCommit: 1, sameContent: true });
  await act(async () => { await capture(api.mail!(sendAction('intent-a-0001'))); });
  await act(async () => { await api.recover(); }); expect(claims()).toEqual([['intent-a-0001', 'send-1']]);
  // 新意图 B 与 A 内容相同，服务端回到 A 的记录：不能被 B 认领。
  await act(async () => { const error = await capture(api.mail!(sendAction('intent-b-0001'))); expect(String(error)).toContain('已被其他发送意图认领'); });
  expect(api.pending?.mail).toMatchObject({ requestKey: 'intent-b-0001' }); expect(api.pending?.mail?.review).toContain('已被其他发送意图认领');
  const posts = server.posts();
  await act(async () => { expect(String(await capture(api.recover()))).toContain('待人工核对'); });
  await remount(); await act(async () => { expect(String(await capture(api.recover()))).toContain('待人工核对'); });
  expect(server.posts()).toBe(posts); expect(server.deliveries).toEqual(['intent-a-0001']); expect(claims()).toEqual([['intent-a-0001', 'send-1']]);
});

it('stops at manual review instead of resending when the local closing ledger is unreadable', async () => {
  await mount(); const server = mailServer({ dropAfterCommit: 1 });
  await act(async () => { await capture(api.mail!(sendAction())); });
  localStorage.setItem('bambook.mist.mail-receipts:actor-a', '{broken');
  await act(async () => { expect(String(await capture(api.recover()))).toContain('结案记录格式无效'); });
  expect(api.pending?.mail?.review).toContain('待人工核对'); expect(server.deliveries).toHaveLength(1);
  expect(JSON.stringify({ ...localStorage })).not.toContain('password');
});

it.each([
  { name: 'sent', patch: { status: 'sent' } },
  { name: 'failed and superseded', patch: { status: 'failed', supersededById: 'send-9' } },
])('closes a lost recovered B against server-confirmed A after A became $name, delivering once even after restart', async ({ patch }) => {
  await mount(); const server = mailServer({ alias: true, status: 'unknown', dropOn: [2] });
  let a: any; await act(async () => { a = await api.mail!(sendAction('intent-a-0001')); });
  expect(a.send).toMatchObject({ id: 'send-1', status: 'unknown' }); expect(claims()).toEqual([['intent-a-0001', 'send-1']]); expect(server.deliveries).toHaveLength(1);
  // B 与 A 同内容：服务端回到 A 并登记别名，但 B 的响应丢失
  await act(async () => { await capture(api.mail!(sendAction('intent-b-0001'))); });
  expect(api.pending?.mail?.requestKey).toBe('intent-b-0001'); expect(api.pending?.mail?.review).toBeUndefined(); expect(server.deliveries).toHaveLength(1);
  const intentB = stored(); setSend('send-1', patch);
  await remount(); let checked: any; await act(async () => { checked = await api.recover(); });
  expect(checked.result.send).toMatchObject({ id: 'send-1', status: patch.status, recoveredFor: 'intent-b-0001' });
  expect(api.pending).toBeNull(); expect(claims()).toEqual([['intent-a-0001', 'send-1'], ['intent-b-0001', 'send-1']]); expect(server.deliveries).toEqual(['intent-a-0001']);
  // 重启后再核对：只读原回执，不提交发送
  localStorage.setItem('bambook.mist.pending:actor-a', intentB!); const before = sendPosts();
  await remount(); let again: any; await act(async () => { again = await api.recover(); });
  expect(again.result.send).toMatchObject({ id: 'send-1', recoveredFor: 'intent-b-0001' }); expect(sendPosts()).toBe(before);
  expect(api.pending).toBeNull(); expect(server.deliveries).toEqual(['intent-a-0001']);
});

it('accepts a directly received server-confirmed recovered A for B without manual review; a changed B replay is a conflict and not delivered', async () => {
  await mount(); const server = mailServer({ alias: true, status: 'unknown' });
  await act(async () => { await api.mail!(sendAction('intent-a-0001')); });
  let b: any; await act(async () => { b = await api.mail!(sendAction('intent-b-0001')); });
  expect(b.send).toMatchObject({ id: 'send-1', replayed: true, recovered: true, recoveredFor: 'intent-b-0001' });
  expect(api.pending).toBeNull(); expect(stored()).toBeNull(); expect(claims()).toEqual([['intent-a-0001', 'send-1'], ['intent-b-0001', 'send-1']]);
  await act(async () => { const error: any = await capture(api.mail!(sendAction('intent-b-0001', { input: { accountId: 'acc', to: 'buyer@preview.test', subject: '样品确认', body: '改过的正文' } }))); expect(error.code).toBe('SEND_INTENT_CONFLICT'); });
  expect(api.pending).toBeNull(); expect(server.deliveries).toEqual(['intent-a-0001']);
});

it('stops at manual review when the receipt was created by another person: kept, not cleared, not resent', async () => {
  await mount(); const server = mailServer({ dropAfterCommit: 1, tamper: { createdById: 'actor-z' } });
  await act(async () => { await capture(api.mail!(sendAction())); });
  await act(async () => { expect(String(await capture(api.recover()))).toContain('发送人不一致'); });
  expect(api.pending?.mail?.review).toContain('发送人不一致'); expect(stored()).not.toBeNull(); expect(claims()).toEqual([]);
  const posts = server.posts(); await remount();
  await act(async () => { expect(String(await capture(api.recover()))).toContain('待人工核对'); });
  expect(server.posts()).toBe(posts); expect(server.deliveries).toHaveLength(1); expect(stored()).not.toBeNull();
});
