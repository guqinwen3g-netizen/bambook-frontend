import {apiService} from './apiService';
import {getAuthState,hasPermission} from './authService';
import {beginBusinessRequest,readBusinessRequest,listBusinessRequests,clearAcknowledgedBusinessRequest} from './businessRequestRecovery';
import {financeContextIdentity} from './financeContextIdentity';

export type FinanceCommandIntent = {kind:string;targetId?:string;path:string;method:'POST'|'PATCH'|'PUT'|'DELETE';permission:string;
  input:Record<string,unknown>;entity:'voucher'|'invoice'|'vatInvoice'|'account'|'paymentRequest'|'none';hashExtra?:Record<string,unknown>;
  references?:Array<{path:string;entity:string;id:string;versionField:string;inputField:string}>;
  readPath?:string;readEntity?:string;revisionField?:'expectedUpdatedAt'|'expectedRequestUpdatedAt'};
type StoredIntent={intent:FinanceCommandIntent};
export type PendingFinanceCommand={operation:string;record:{version:1;requestId:string;payload:StoredIntent}};
export class FinanceCommandError extends Error {constructor(message:string,readonly status:number,readonly code?:string){super(message);}}
const plain=(value:any)=>JSON.parse(JSON.stringify(value));
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=async(value:any)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(plain(value))))))]
  .map(v=>v.toString(16).padStart(2,'0')).join('');
function context(endpoint?:string){const auth=getAuthState(),base=endpoint??apiService.getStoredConfig().cloudEndpoint,headers=apiService.getAuthHeaders();
  if(!auth.isAuthenticated||!auth.user?.id)throw new FinanceCommandError('请使用当前登录账号核对财务操作。',401);
  return {base,headers,userId:auth.user.id,identity:JSON.stringify([base,apiService.getStoredConfig().cloudEndpoint,headers,auth.user.id,auth.user.roles,
    auth.user.roleIds,auth.user.permissions,auth.user.permissionCeiling??null,auth.user.departmentIds??[],financeContextIdentity()])};}
function current(session:ReturnType<typeof context>,permission:string,endpoint?:string){
  if(!hasPermission(permission as any)||context(endpoint).identity!==session.identity)
    throw new FinanceCommandError('账号、权限或服务地址已变化，请保留原请求并重新核对。',403);
}
function operation(intent:FinanceCommandIntent){return `finance-command:${intent.kind}:${intent.targetId??'new'}`;}
function notifyPending(){if(typeof window!=='undefined')window.dispatchEvent(new Event('finance-command-pending'));}
const moneyFields=new Set(['amount','bankFee','exchangeRate','appliedAmount','netAmount','taxRate','taxAmount','totalAmount']);
const decimal=(value:any)=>String(value).replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1');
function sameEntity(actual:any,expected:any){
  if(!actual||!expected)return false;
  const observed={...actual};delete observed.financeCommand;
  const normalized=(row:any)=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,
    value==null?value:moneyFields.has(key)?decimal(value):['createdAt','updatedAt','deletedAt'].includes(key)?String(value):value]));
  return JSON.stringify(canonical(normalized(observed)))===JSON.stringify(canonical(normalized(expected)));
}
function commandEntity(data:any,kind:FinanceCommandIntent['entity']){
  return kind==='none'?null:data?.[kind]??(kind==='voucher'?data?.payment:undefined)??data;
}
async function execute(stored:PendingFinanceCommand,endpoint?:string){
  const session=context(endpoint),intent=stored.record.payload.intent;current(session,intent.permission,endpoint);
  const body={...intent.input,requestKey:typeof intent.input.requestKey==='string'?intent.input.requestKey:stored.record.requestId};
  const expectedHash=await hash({kind:intent.kind,input:{...body,...intent.hashExtra}});current(session,intent.permission,endpoint);
  const response=await fetch(apiService.buildApiUrl(intent.path,session.base),{method:intent.method,headers:{...session.headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
  current(session,intent.permission,endpoint);const data=await response.json().catch(()=>null);current(session,intent.permission,endpoint);
  if(!response.ok){const code=typeof data?.error?.code==='string'?data.error.code:typeof data?.error==='string'?data.error:undefined;
    throw new FinanceCommandError(data?.error?.message||data?.message||'操作结果尚未确认，请保留原请求核对。',response.status,code);}
  const entity=commandEntity(data,intent.entity),receipt=entity?.financeCommand??data?.financeCommand??data?.payment?.financeCommand;
  const snapshot=receipt?.resultSnapshot;
  if(receipt?.protocolVersion!==1||receipt.actorId!==session.userId||receipt.kind!==intent.kind||receipt.requestKey!==body.requestKey
    ||receipt.commandHash!==expectedHash||!receipt.auditId||snapshot?.auditId!==receipt.auditId
    ||receipt.resultHash!==await hash(snapshot??null)
    ||(intent.entity==='none'?receipt.targetId!==intent.targetId:!entity?.id||receipt.targetId!==entity.id||!sameEntity(entity,snapshot?.[intent.entity])))
    throw new FinanceCommandError('财务原请求回执与实际结果尚未核对，请保留原内容重试。',0);
  current(session,intent.permission,endpoint);clearAcknowledgedBusinessRequest(stored.operation,stored.record.requestId,session.base);notifyPending();
  return intent.entity==='none'?data:entity;
}

/** Local storage contains only unresolved commands, never a financial balance.
 * A retry never reads a newer version and silently substitutes that version. */
export async function runFinanceCommand<T=any>(original:FinanceCommandIntent,endpoint?:string):Promise<T>{
  const session=context(endpoint);current(session,original.permission,endpoint);
  const name=operation(original),prior=readBusinessRequest<StoredIntent>(name,session.base);
  if(prior){
    const old=prior.payload.intent;
    const comparable=(intent:FinanceCommandIntent)=>{const input={...intent.input};delete input.expectedUpdatedAt;delete input.expectedRequestUpdatedAt;delete input.expectedAccountRevision;
      for(const ref of intent.references??[])delete input[ref.inputField];
      return {...intent,input};};
    if(JSON.stringify(canonical(comparable(old)))!==JSON.stringify(canonical(comparable(plain(original)))))
      throw new FinanceCommandError('上次财务请求结果尚未确认，请重试原请求后再编辑新内容。',0);
    return execute({operation:name,record:prior},endpoint);
  }
  const intent:FinanceCommandIntent=plain(original),revisionField=intent.revisionField??'expectedUpdatedAt';
  if(intent.readPath&&intent.input[revisionField]==null){
    const response=await fetch(apiService.buildApiUrl(intent.readPath,session.base),{headers:session.headers});current(session,intent.permission,endpoint);
    const data=await response.json().catch(()=>null);current(session,intent.permission,endpoint);
    if(!response.ok)throw new FinanceCommandError(data?.error?.message||data?.message||'当前财务版本暂不可读取。',response.status);
    const row=intent.readEntity?data?.[intent.readEntity]:data;
    const version=row?.updatedAt;
    if(row?.id!==intent.targetId||!(typeof version==='string'&&version.trim()||typeof version==='number'&&Number.isSafeInteger(version)))
      throw new FinanceCommandError('原财务记录版本尚未读实，请重新核对。',0);
    intent.input[revisionField]=String(version);
  }
  for(const reference of intent.references??[])if(intent.input[reference.inputField]==null){
    const response=await fetch(apiService.buildApiUrl(reference.path,session.base),{headers:session.headers});current(session,intent.permission,endpoint);
    const data=await response.json().catch(()=>null);current(session,intent.permission,endpoint);
    const row=data?.[reference.entity],version=row?.[reference.versionField];
    if(!response.ok||row?.id!==reference.id||!Number.isSafeInteger(version))
      throw new FinanceCommandError(data?.error?.message||'实际资金账户或当前版本暂不可核实。',response.status);
    intent.input[reference.inputField]=version;
  }
  current(session,intent.permission,endpoint);
  const record=beginBusinessRequest(name,{intent},session.base);
  notifyPending();
  try{return await execute({operation:name,record},endpoint);}catch(error){
    current(session,intent.permission,endpoint);
    // Only a definitive first-attempt business rejection ends an unsent fact.
    // Unknown failures and every replay retain the exact original command.
    if(error instanceof FinanceCommandError&&error.status>=400&&error.status<500&&error.code){
      clearAcknowledgedBusinessRequest(name,record.requestId,session.base);
      notifyPending();
    }
    throw error;
  }
}
export function listPendingFinanceCommands(endpoint?:string):PendingFinanceCommand[]{return listBusinessRequests<StoredIntent>('finance-command:',endpoint);}
export async function retryPendingFinanceCommand<T=any>(pending:PendingFinanceCommand,endpoint?:string):Promise<T>{
  const currentRecord=readBusinessRequest<StoredIntent>(pending.operation,endpoint);
  if(!currentRecord||currentRecord.requestId!==pending.record.requestId||JSON.stringify(canonical(currentRecord.payload))!==JSON.stringify(canonical(pending.record.payload)))
    throw new FinanceCommandError('原财务请求记录已变化，请重新读取待确认请求。',0);
  return execute({operation:pending.operation,record:currentRecord},endpoint);
}
