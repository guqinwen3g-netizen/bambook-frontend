import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID,webcrypto} from 'node:crypto';
const auth=vi.hoisted(()=>({getAuthState:vi.fn(),hasPermission:vi.fn(),subscribe:vi.fn(),listeners:new Set<()=>void>()}));
const api=vi.hoisted(()=>({getStoredConfig:vi.fn(),getAuthHeaders:vi.fn(),buildApiUrl:vi.fn()}));
vi.mock('./authService',()=>auth); vi.mock('./apiService',()=>({apiService:api}));
import {runFinanceCommand,listPendingFinanceCommands,retryPendingFinanceCommand} from './financeCommandRecovery';
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=(v:any)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const endpoint='https://finance.invalid/api'; let user:any;
function storage():Storage {const m=new Map<string,string>();return {get length(){return m.size;},getItem:k=>m.get(k)??null,setItem:(k,v)=>{m.set(k,v);},removeItem:k=>{m.delete(k);},clear:()=>m.clear(),key:i=>[...m.keys()][i]??null};}
function ack(body:any,changes:any={}) {const voucher={id:'PV1',amount:'40',currency:'USD',type:'Receipt',paymentDate:'2026-10-07',paymentMethod:'TT',updatedAt:'2',createdAt:'1',deletedAt:null};
  const resultSnapshot={voucher,auditId:'AUDIT'};return {...voucher,financeCommand:{protocolVersion:1,actorId:'U1',kind:'voucher.update',requestKey:body.requestKey,
    commandHash:hash({kind:'voucher.update',input:{...body,voucherId:'PV1'}}),auditId:'AUDIT',targetId:'PV1',resultSnapshot,resultHash:hash(resultSnapshot)},...changes};}
const response=(body:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const intent:any={kind:'voucher.update',targetId:'PV1',path:'/v1/finance/vouchers/PV1',method:'PATCH',permission:'vouchers:write',
  input:{amount:'40',currency:'USD'},readPath:'/v1/finance/vouchers/PV1',entity:'voucher',hashExtra:{voucherId:'PV1'}};
beforeEach(()=>{vi.resetAllMocks();user={isAuthenticated:true,user:{id:'U1',roles:['finance'],permissions:['vouchers:read','vouchers:write']}};
  auth.getAuthState.mockImplementation(()=>user);auth.hasPermission.mockImplementation(s=>user.user.permissions.includes(s));api.getStoredConfig.mockReturnValue({cloudEndpoint:endpoint});
  auth.subscribe.mockImplementation(listener=>{auth.listeners.add(listener);return()=>auth.listeners.delete(listener);});
  api.getAuthHeaders.mockImplementation(()=>({Authorization:`Bearer ${user.user.id}`}));api.buildApiUrl.mockImplementation((path,base)=>base+path);
  vi.stubGlobal('localStorage',storage());vi.stubGlobal('crypto',{randomUUID,subtle:webcrypto.subtle});});
afterEach(()=>vi.unstubAllGlobals());
it('keeps the exact original key/version across a lost acknowledgement without a second source read',async()=>{
  const writes:any[]=[];let reads=0;const committed=new Map();
  vi.stubGlobal('fetch',vi.fn(async(_url:any,init:any={})=>{if(!init.method){reads++;return response({id:'PV1',updatedAt:'1'});}
    const body=JSON.parse(init.body);writes.push(body);if(!committed.has(body.requestKey)){committed.set(body.requestKey,ack(body));throw Error('lost after commit');}return response(committed.get(body.requestKey));}));
  await expect(runFinanceCommand(intent)).rejects.toThrow('lost');expect(listPendingFinanceCommands()).toHaveLength(1);
  const result=await retryPendingFinanceCommand(listPendingFinanceCommands()[0]);expect(result.id).toBe('PV1');
  expect(writes[1]).toEqual(writes[0]);expect(writes[0].expectedUpdatedAt).toBe('1');expect(reads).toBe(1);expect(committed.size).toBe(1);expect(listPendingFinanceCommands()).toEqual([]);
});

it('retains unknown acknowledgements and refuses a changed amount before reading or writing again',async()=>{
  let writes=0,reads=0;
  vi.stubGlobal('fetch',vi.fn(async(_url:any,init:any={})=>{if(!init.method){reads++;return response({id:'PV1',updatedAt:'1'});}
    writes++;return response({...ack(JSON.parse(init.body)),amount:'41'});}));
  await expect(runFinanceCommand(intent)).rejects.toThrow('尚未核对');expect(listPendingFinanceCommands()).toHaveLength(1);
  await expect(runFinanceCommand({...intent,input:{amount:'41',currency:'USD'}})).rejects.toThrow('原请求');
  expect(reads).toBe(1);expect(writes).toBe(1);expect(listPendingFinanceCommands()).toHaveLength(1);
});
it('preserves a committed unknown command when the current account loses permission during acknowledgement',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(_url:any,init:any={})=>{if(!init.method)return response({id:'PV1',updatedAt:'1'});
    const body=JSON.parse(init.body);user.user.permissions=[];return response(ack(body));}));
  await expect(runFinanceCommand(intent)).rejects.toThrow('权限');expect(listPendingFinanceCommands()).toHaveLength(1);
  const fetchCount=(fetch as any).mock.calls.length;await expect(retryPendingFinanceCommand(listPendingFinanceCommands()[0])).rejects.toThrow('权限');
  expect((fetch as any).mock.calls).toHaveLength(fetchCount);
});
it('clears a definitive initial rejection while preserving every already-unknown replay rejection',async()=>{
  let mode='definitive';vi.stubGlobal('fetch',vi.fn(async(_url:any,init:any={})=>{if(!init.method)return response({id:'PV1',updatedAt:'1'});
    if(mode==='unknown')throw Error('lost');return response({error:{code:'CONFLICT',message:'current version changed'}},409);}));
  await expect(runFinanceCommand(intent)).rejects.toThrow('changed');expect(listPendingFinanceCommands()).toHaveLength(0);
  mode='unknown';await expect(runFinanceCommand(intent)).rejects.toThrow('lost');expect(listPendingFinanceCommands()).toHaveLength(1);
  mode='definitive';await expect(retryPendingFinanceCommand(listPendingFinanceCommands()[0])).rejects.toThrow('changed');expect(listPendingFinanceCommands()).toHaveLength(1);
});
it('retains a committed original command after A -> B -> A even when final permission and account match',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(_url:any,init:any={})=>{
    if(!init.method)return response({id:'PV1',updatedAt:'1'});
    const body=JSON.parse(init.body),original=user;
    user={...user,user:{...user.user,id:'OTHER'}};auth.listeners.forEach(listener=>listener());
    user=original;auth.listeners.forEach(listener=>listener());return response(ack(body));
  }));
  await expect(runFinanceCommand(intent)).rejects.toThrow('账号');expect(listPendingFinanceCommands()).toHaveLength(1);
});
it('pins the actual account revision and restores an Opening receipt without replacing that revision on an unknown retry',async()=>{
  const writes:any[]=[];let reads=0,lose=true;
  const accountIntent:any={kind:'cash_account.opening',targetId:'ACCOUNT',path:'/v1/finance/cash-accounts/ACCOUNT/commands',method:'POST',permission:'vouchers:write',entity:'account',
    input:{action:'opening',amount:'0',currency:'USD',occurredDate:'2026-10-07',bankReference:'VERIFIED-OPENING'},hashExtra:{accountId:'ACCOUNT'},
    references:[{path:'/v1/finance/cash-accounts/ACCOUNT',entity:'account',id:'ACCOUNT',versionField:'revision',inputField:'expectedRevision'}]};
  vi.stubGlobal('fetch',vi.fn(async(_url:any,init:any={})=>{
    if(!init.method){reads++;return response({account:{id:'ACCOUNT',revision:4}});}
    const body=JSON.parse(init.body);writes.push(body);if(lose){lose=false;throw Error('Opening committed, ACK lost');}
    const account={id:'ACCOUNT',revision:5,currency:'USD',allowedUserIds:['U1'],updatedAt:'2'},entry={id:'ENTRY',kind:'Opening',amount:'0'},resultSnapshot={account,entry,auditId:'AUDIT'};
    return response({account,entry,auditId:'AUDIT',financeCommand:{protocolVersion:1,actorId:'U1',kind:'cash_account.opening',requestKey:body.requestKey,
      commandHash:hash({kind:'cash_account.opening',input:{...body,accountId:'ACCOUNT'}}),auditId:'AUDIT',targetId:'ACCOUNT',resultSnapshot,resultHash:hash(resultSnapshot)}});
  }));
  await expect(runFinanceCommand(accountIntent)).rejects.toThrow('ACK lost');
  await expect(runFinanceCommand({...accountIntent,input:{...accountIntent.input,amount:'1'}})).rejects.toThrow('原请求');
  expect(await retryPendingFinanceCommand(listPendingFinanceCommands()[0])).toMatchObject({id:'ACCOUNT',revision:5});
  expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);expect(writes[0].expectedRevision).toBe(4);expect(reads).toBe(1);
  expect(listPendingFinanceCommands()).toEqual([]);
});
