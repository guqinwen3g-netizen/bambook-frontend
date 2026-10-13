import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { createHash,webcrypto } from 'node:crypto';

// Independent HTTP/technical-storage seam. No production hash helper, server
// producer or native authorization is mocked into a success assertion here.
const api=vi.hoisted(()=>({getStoredConfig:vi.fn(),getAuthHeaders:vi.fn(),buildApiUrl:vi.fn()}));
const auth=vi.hoisted(()=>({getAuthState:vi.fn(),hasPermission:vi.fn()}));
vi.mock('./apiService',()=>({apiService:api}));
vi.mock('./authService',()=>auth);
const BASE='http://fees.invalid/api';const OTHER='http://other.invalid/api';
let state:any,endpoint:string,service:typeof import('./billingItemService')['billingItemService'];
let calls:Array<{url:string;body:any}>;
let reply:(request:{url:string;body:any})=>Promise<Response>|Response;
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function store():Storage{const values=new Map<string,string>();return{get length(){return values.size;},key:index=>[...values.keys()][index]??null,
 getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,String(value));},removeItem:key=>{values.delete(key);},clear:()=>values.clear()};}
function session(id='finance-a'){return{isAuthenticated:true,user:{id,roles:['finance'],permissions:['invoices:read','invoices:write'],permissionCeiling:['invoices:read','invoices:write']}};}
const input=()=>({sourceType:'Sample',sourceId:'S1',chargeType:'sample_fee',amount:'12.9999',currency:'USD',waivedAmount:'0',notes:'Synthetic full original intent'});
function ack(body:any,actorId='finance-a',replayed=false){
 const {requestKey,...original}=body;
 const item={id:'BI1',itemNo:'BI-2026-0001',sourceType:original.sourceType,sourceId:original.sourceId,chargeType:original.chargeType,amount:original.amount??'12.9999',currency:original.currency??'CNY',waivedAmount:original.waivedAmount??'0',offsetAmount:'0',netAmountExact:'12.9999',status:'draft',notes:original.notes};
 return{ok:true,billingItem:item,replayed,acknowledgement:{schemaVersion:1,operation:'create_billing_item',actorId,requestKey,commandSnapshot:original,
  commandHash:hash({schemaVersion:1,operation:'create_billing_item',actorId,requestKey,input:original}),billingItemId:item.id,
  receiptAuditId:'receipt:'+requestKey,billingItemHash:hash(item),originalAuditId:'native-audit:'+requestKey,originalAuditHash:hash({requestKey,actorId,nativeAudit:'Synthetic independent frozen audit'})}};
}
function fence(body:any){const {requestKey,input:original,retirementRequestKey,reason}=body;
 return{ok:true,retired:true,replayed:false,acknowledgement:{schemaVersion:1,operation:'retire_billing_item_create',actorId:'finance-a',requestKey,commandSnapshot:original,
  commandHash:hash({schemaVersion:1,operation:'create_billing_item',actorId:'finance-a',requestKey,input:original}),receiptAuditId:'receipt:'+requestKey,retirementRequestKey,reason,
  retirementHash:hash({schemaVersion:1,operation:'retire_billing_item_create',actorId:'finance-a',requestKey,input:original,retirementRequestKey,reason})}};
}
const response=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
beforeEach(async()=>{
 vi.resetModules();state=session();endpoint=BASE;calls=[];
 vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('localStorage',store());
 api.getStoredConfig.mockImplementation(()=>({cloudEndpoint:endpoint}));api.getAuthHeaders.mockReturnValue({'content-type':'application/json',Authorization:'Bearer synthetic-storage-seam'});
 api.buildApiUrl.mockImplementation((path:string,base?:string)=>(base??endpoint)+path);
 auth.getAuthState.mockImplementation(()=>state);auth.hasPermission.mockImplementation((scope:string)=>state.isAuthenticated&&state.user.permissions.includes(scope)&&state.user.permissionCeiling.includes(scope));
 reply=request=>response(ack(request.body));
 vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{const request={url:String(url),body:JSON.parse(init.body)};calls.push(request);return reply(request);}));
 service=(await import('./billingItemService')).billingItemService;
});
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});

describe('manual fee create client — unresolved intent and independently hashed native receipt',()=>{
 it('returns a compatible BillingItem only after a complete exact original ACK',async()=>{
  const made=await service.create(input());expect(made.id).toBe('BI1');expect(made.amount).toBe('12.9999');expect(service.pendingCreate()).toBeNull();
  expect(calls[0].body).toEqual({...input(),requestKey:expect.any(String)});expect(typeof calls[0].body.amount).toBe('string');
 });
 it('lost response reloads the original key/full parameters and changes nothing on the server request',async()=>{
  reply=()=>{throw Error('response lost')};await expect(service.create(input())).rejects.toThrow('response lost');const original=calls[0].body;
  vi.resetModules();service=(await import('./billingItemService')).billingItemService;const pending=service.pendingCreate()!;
  expect(pending.input).toEqual(input());reply=request=>response(ack(request.body,'finance-a',true));
  expect((await service.retryCreate(pending)).id).toBe('BI1');expect(calls[1].body).toEqual(original);expect(service.pendingCreate()).toBeNull();
 });
 it.each([400,403,409,500,503])('HTTP %s never proves the original create absent and does not clear its key',async status=>{
  reply=()=>response({ok:false,error:{code:'FORBIDDEN',message:'Explicit rejection'}},status);await expect(service.create(input())).rejects.toThrow();
  const pending=service.pendingCreate()!;expect(pending.requestId).toBe(calls[0].body.requestKey);
  await expect(service.create({...input(),notes:'changed'})).rejects.toThrow('原内容');expect(calls).toHaveLength(1);expect(service.pendingCreate()).toEqual(pending);
 });
 it.each(['missing','wrong-actor','wrong-key','wrong-id','wrong-command','wrong-hash','wrong-item','failure-200','missing-original-audit','malformed-original-audit-hash'])('bad ACK %s keeps the exact pending input',async fault=>{
  reply=request=>{const data=ack(request.body);if(fault==='missing')delete (data as any).acknowledgement;
   if(fault==='wrong-actor')data.acknowledgement.actorId='foreign';if(fault==='wrong-key')data.acknowledgement.requestKey='other';
   if(fault==='wrong-id')data.acknowledgement.billingItemId='other';if(fault==='wrong-command')data.acknowledgement.commandSnapshot={...input(),notes:'wrong'};
   if(fault==='wrong-hash')data.acknowledgement.commandHash='0'.repeat(64);if(fault==='wrong-item')data.billingItem.amount='900';if(fault==='failure-200')data.ok=false;
   if(fault==='missing-original-audit')delete (data.acknowledgement as any).originalAuditId;if(fault==='malformed-original-audit-hash')data.acknowledgement.originalAuditHash='not-a-sha256';
   return response(data);};
  await expect(service.create(input())).rejects.toThrow('尚未确认');expect(service.pendingCreate()?.input).toEqual(input());
 });
 it('current actor and endpoint journal boundaries never borrow another request',async()=>{
  reply=()=>{throw Error('unknown')};await expect(service.create(input())).rejects.toThrow();const first=service.pendingCreate()!;
  state=session('finance-b');expect(service.pendingCreate()).toBeNull();state=session();endpoint=OTHER;expect(service.pendingCreate()).toBeNull();
  endpoint=BASE;expect(service.pendingCreate()).toEqual(first);expect(calls).toHaveLength(1);
 });
 it.each(['actor','endpoint','cap'])('late %s change cannot clear the old request or accept its receipt',async changed=>{
  reply=request=>{if(changed==='actor')state=session('finance-b');if(changed==='endpoint')endpoint=OTHER;if(changed==='cap')state.user.permissionCeiling=[];return response(ack(request.body));};
  await expect(service.create(input())).rejects.toThrow('变化');state=session();endpoint=BASE;expect(service.pendingCreate()?.input).toEqual(input());
 });
 it('revoked local write authority sends no retry and retains the unresolved original key',async()=>{
  reply=()=>{throw Error('unknown')};await expect(service.create(input())).rejects.toThrow();const pending=service.pendingCreate()!;state.user.permissions=['invoices:read'];
  await expect(service.retryCreate(pending)).rejects.toThrow('无权');expect(calls).toHaveLength(1);expect(service.pendingCreate()).toEqual(pending);
 });
 it('a server 403 on a previously unknown replay keeps its original request',async()=>{
  reply=()=>{throw Error('unknown')};await expect(service.create(input())).rejects.toThrow();const pending=service.pendingCreate()!;
  reply=()=>response({ok:false,error:{code:'FORBIDDEN'}},403);await expect(service.retryCreate(pending)).rejects.toThrow();expect(service.pendingCreate()).toEqual(pending);expect(calls[1].body).toEqual(calls[0].body);
 });
 it('only matching permanent retirement allows new corrected parameters/new key',async()=>{
  reply=()=>{throw Error('unknown')};await expect(service.create(input())).rejects.toThrow();const original=calls[0].body;
  reply=request=>response(fence(request.body));expect(await service.retireCreate('Correct source')).toEqual({retired:true});expect(service.pendingCreate()).toBeNull();
  expect(calls[1].body.input).toEqual(input());expect(calls[1].body.requestKey).toBe(original.requestKey);
  reply=request=>response(ack(request.body));await service.create({...input(),notes:'corrected after fence'});expect(calls[2].body.requestKey).not.toBe(original.requestKey);
 });
 it('retirement can discover the original creation ACK without creating or falsely retiring it',async()=>{
  reply=()=>{throw Error('unknown')};await expect(service.create(input())).rejects.toThrow();
  reply=request=>response(ack({...request.body.input,requestKey:request.body.requestKey}));
  expect(await service.retireCreate('Lost response')).toMatchObject({billingItem:{id:'BI1'}});expect(service.pendingCreate()).toBeNull();expect(calls).toHaveLength(2);
 });
 it('unknown retirement survives reload with its original retirement key/reason; a bad fence cannot clear creation',async()=>{
  reply=()=>{throw Error('unknown')};await expect(service.create(input())).rejects.toThrow();await expect(service.retireCreate('Correct source')).rejects.toThrow();const original=calls[1].body;
  vi.resetModules();service=(await import('./billingItemService')).billingItemService;
  reply=request=>{const data=fence(request.body);data.acknowledgement.reason='different';return response(data);};
  await expect(service.retireCreate('Correct source')).rejects.toThrow('尚未确认');expect(calls[2].body).toEqual(original);expect(service.pendingCreate()).not.toBeNull();
  reply=request=>response(fence(request.body));await service.retireCreate('Correct source');expect(calls[3].body).toEqual(original);expect(service.pendingCreate()).toBeNull();
 });
 it.each([Number.NaN,Infinity])('nonfinite amount %s never becomes a null default or an HTTP write',async amount=>{
  await expect(service.create({...input(),amount})).rejects.toThrow('金额');expect(calls).toHaveLength(0);expect(service.pendingCreate()).toBeNull();
 });
 it.each([{ok:true},{ok:false,billingItems:[],total:0},{ok:true,billingItems:{},total:0},{ok:true,billingItems:[],total:null}])('malformed list DTO never presents a false empty refresh: %j',async data=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response(data)));await expect(service.list()).rejects.toThrow('列表响应不完整');
 });
 it('an actual empty list remains a valid known empty response',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response({ok:true,billingItems:[],total:0})));expect(await service.list()).toEqual({billingItems:[],total:0});
 });
 it('a structurally damaged technical journal is preserved as an explicit recovery error',async()=>{
  reply=()=>{throw Error('unknown')};await expect(service.create(input())).rejects.toThrow();const key=localStorage.key(0)!;const record=JSON.parse(localStorage.getItem(key)!);record.payload={};localStorage.setItem(key,JSON.stringify(record));
  expect(()=>service.pendingCreate()).toThrow('记录损坏');await expect(service.create(input())).rejects.toThrow('原内容');expect(localStorage.getItem(key)).toBe(JSON.stringify(record));expect(calls).toHaveLength(1);
 });

 it('a self-consistently hashed ACK with a different explicit amount never clears the original command',async()=>{
  reply=request=>{const data=ack(request.body);data.billingItem.amount='12.9998';data.acknowledgement.billingItemHash=hash(data.billingItem);return response(data);};
  await expect(service.create(input())).rejects.toThrow('尚未确认');expect(service.pendingCreate()?.input).toEqual(input());expect(calls).toHaveLength(1);
 });

});
