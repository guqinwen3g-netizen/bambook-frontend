/**
 * Billing Item API service（DR-053 收费决定层）
 * 对应后端 /api/v1/billing-items —— 此前整族 7 端点前端零消费，
 * 「免收 / 抵货款 / 承担方 / 确认 / 开票 / 取消」只能绕道场景化开票或改库。
 * 消费契约：listBillingItems / createBillingItem / updateBillingItem / confirm / invoice / cancel
 */
import { apiService } from './apiService';
import { canonicalDecimal18_4 } from '../lib/decimalInput';
import { getAuthState, hasPermission } from './authService';
import { beginBusinessRequest, readBusinessRequest, clearAcknowledgedBusinessRequest } from './businessRequestRecovery';

export type BillingSourceType = 'Sample' | 'SealSample' | 'SampleBatch' | 'DevelopmentCase' | 'OrderLine' | 'CostRecord';
export type BillingChargeType = 'sample_fee' | 'shipping_fee' | 'testing_fee' | 'development_fee' | 'other';
export type BillingStatus = 'draft' | 'confirmed' | 'invoiced' | 'cancelled';

export interface BillingItem {
  developmentWorkflowState?: string | null;
  developmentWorkflowVersion?: number;
  id: string;
  itemNo: string;
  sourceType: string;
  sourceId: string;
  costRecordId?: string | null;
  developmentExpenseReviewId?: string | null;
  chargeType: string;
  bearerType: string;
  bearerRelationId?: string | null;
  bearerName?: string | null;
  amount: number | string;
  currency: string;
  waivedAmount?: number | string;
  offsetAmount?: number | string;
  offsetOrderId?: string | null;
  offsetOrderNumber?: string | null;
  /** 净应收 = amount − waivedAmount − offsetAmount（服务端派生，不落库） */
  netAmount?: number | string;
  netAmountExact?: string;
  status: BillingStatus | string;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  confirmedAt?: number | null;
  confirmedBy?: string | null;
  notes?: string | null;
  /** Legacy lists may be numeric; exact creation ACK timestamps are strings. */
  createdAt: number | string;
  updatedAt: number | string;
}

export type BillingItemListParams = {
  sourceType?: string;
  sourceId?: string;
  status?: string;
  limit?: number;
  offset?: number;
};

export type BillingItemCreateInput = {
  sourceType: string;
  sourceId: string;
  chargeType?: string;
  amount?: number | string;
  currency?: string;
  bearerType?: string;
  bearerRelationId?: string;
  costRecordId?: string;
  waivedAmount?: number | string;
  offsetAmount?: number | string;
  offsetOrderId?: string;
  notes?: string;
  registerCost?: { costType?: string; amount: number | string; currency?: string; incurredAt?: string; bearerType?: string; bearerRelationId?: string; notes?: string };
};

export type BillingItemUpdateInput = Partial<Pick<BillingItemCreateInput,
  'amount' | 'currency' | 'bearerType' | 'bearerRelationId' | 'waivedAmount' | 'offsetAmount' | 'offsetOrderId' | 'notes' | 'chargeType'>>;

function base() {
  return apiService.getStoredConfig().cloudEndpoint;
}

async function parse(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data?.error?.message || data?.error?.code || data?.message || `HTTP ${res.status}`;
    throw new Error(reason);
  }
  return data;
}

const CREATE_OPERATION = 'billing-item:create';
const RETIRE_OPERATION = 'billing-item:create:retire';
export type PendingBillingCreate = { requestId: string; input: BillingItemCreateInput };
export const canonicalBillingCreate = (value:unknown):string => JSON.stringify(value, (_key,item) => item && typeof item==='object'&&!Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const billingDigest = async(value:unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalBillingCreate(value)))))
  .map(byte=>byte.toString(16).padStart(2,'0')).join('');
export function billingCreateSessionIdentity(endpoint?:string):string {
  const auth=getAuthState(), configured=base(), target=apiService.buildApiUrl('/v1',endpoint??configured);
  if(!auth.isAuthenticated||!auth.user?.id)throw new Error('请重新登录后核对收费请求。');
  // Durable intent uses actor+endpoint. Rotating transport tokens cannot change
  // the original command; current action grants/cap are checked before writes.
  return canonicalBillingCreate([auth.user.id,target,configured,auth.user.roles??[],auth.user.permissions??[],auth.user.permissionCeiling??null]);
}
function createSession(endpoint:string){
  const identity=billingCreateSessionIdentity(endpoint),actorId=getAuthState().user!.id;
  if(!hasPermission('invoices:write'))throw new Error('当前账号无权创建收费决定。');
  return {identity,actorId,headers:apiService.getAuthHeaders()};
}
function sameSession(session:ReturnType<typeof createSession>,endpoint:string){
  if(billingCreateSessionIdentity(endpoint)!==session.identity||!hasPermission('invoices:write'))throw new Error('账号、权限或服务地址已变化，请保留原请求核对。');
}
function unconfirmed():never{throw new Error('收费创建结果尚未确认，请保留原请求并核对原创建请求。');}
function originalInput(input:BillingItemCreateInput):BillingItemCreateInput {
  const copy=JSON.parse(JSON.stringify(input));
  const allowed=['sourceType','sourceId','chargeType','amount','currency','bearerType','bearerRelationId','costRecordId','waivedAmount','offsetAmount','offsetOrderId','notes','registerCost'];
  if(!copy||typeof copy!=='object'||Array.isArray(copy)||Object.keys(copy).some(key=>!allowed.includes(key))
    ||typeof copy.sourceType!=='string'||!copy.sourceType.trim()||typeof copy.sourceId!=='string'||!copy.sourceId.trim())throw new Error('收费创建字段无效。');
  // Do not turn an invalid nonfinite JS amount into a JSON null/default.
  for(const key of ['amount','waivedAmount','offsetAmount'])if(typeof (input as any)[key]==='number'&&!Number.isFinite((input as any)[key]))throw new Error('收费金额无效。');
  if(typeof input.registerCost?.amount==='number'&&!Number.isFinite(input.registerCost.amount))throw new Error('登记成本金额无效。');
  return copy;
}
async function verifyCreateAck(data:any,record:PendingBillingCreate,actorId:string):Promise<BillingItem>{
  const ack=data?.acknowledgement,item=data?.billingItem,input=record.input;
  const command={schemaVersion:1,operation:'create_billing_item',actorId,requestKey:record.requestId,input};
  if(data?.ok!==true||typeof item?.id!=='string'||!item.id||typeof item.itemNo!=='string'||!item.itemNo||item.sourceType!==input.sourceType||item.sourceId!==input.sourceId
    ||ack?.schemaVersion!==1||ack.operation!=='create_billing_item'||ack.actorId!==actorId||ack.requestKey!==record.requestId
    ||ack.billingItemId!==item.id||typeof ack.receiptAuditId!=='string'||!ack.receiptAuditId
    ||typeof ack.originalAuditId!=='string'||!ack.originalAuditId||typeof ack.originalAuditHash!=='string'||!/^([a-f0-9]{64})$/.test(ack.originalAuditHash)
    ||canonicalBillingCreate(ack.commandSnapshot)!==canonicalBillingCreate(input)||ack.commandHash!==await billingDigest(command)
    ||ack.billingItemHash!==await billingDigest(item))unconfirmed();
  for(const field of ['amount','waivedAmount','offsetAmount'] as const){
    // Verify explicit financial intent against the actual frozen fee, in
    // addition to independent command/row hashes. An omitted default stays
    // server-derived; no browser recomputation invents a missing amount.
    try{
      const actual=canonicalDecimal18_4(item[field],field,true);
      if(input[field]!=null&&actual!==canonicalDecimal18_4(input[field],field,true))unconfirmed();
    }catch{unconfirmed();}
  }
  if(typeof item.currency!=='string'||!item.currency||input.currency!=null&&item.currency!==(input.currency.trim()||'CNY'))unconfirmed();
  return item;
}
async function postCreate(record:PendingBillingCreate,endpoint:string,original?:ReturnType<typeof createSession>):Promise<BillingItem>{
  const session=original??createSession(endpoint);sameSession(session,endpoint);
  const res=await fetch(apiService.buildApiUrl('/v1/billing-items',endpoint),{method:'POST',headers:session.headers,
    body:JSON.stringify({...record.input,requestKey:record.requestId})});
  const data=await res.json().catch(()=>null);sameSession(session,endpoint);
  if(!res.ok)throw new Error(data?.error?.message||'收费请求暂时未能确认，请保留原请求。');
  const item=await verifyCreateAck(data,record,session.actorId);sameSession(session,endpoint);
  clearAcknowledgedBusinessRequest(CREATE_OPERATION,record.requestId,endpoint);
  const retirement=readBusinessRequest<{requestKey:string}>(RETIRE_OPERATION,endpoint);
  if(retirement?.payload.requestKey===record.requestId)clearAcknowledgedBusinessRequest(RETIRE_OPERATION,retirement.requestId,endpoint);
  return item;
}

export const billingItemService = {
  async list(params?: BillingItemListParams, endpoint?: string): Promise<{ billingItems: BillingItem[]; total: number }> {
    const url = apiService.buildApiUrl('/v1/billing-items', endpoint || base());
    const query = new URLSearchParams();
    if (params?.sourceType) query.set('sourceType', params.sourceType);
    if (params?.sourceId) query.set('sourceId', params.sourceId);
    if (params?.status) query.set('status', params.status);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, { headers: apiService.getAuthHeaders() });
    const data = await parse(res);
    if(data?.ok!==true||!Array.isArray(data.billingItems)||typeof data.total!=='number'||!Number.isSafeInteger(data.total)||data.total<0)
      throw new Error('收费列表响应不完整，请重新读取；此结果不代表已没有收费记录。');
    return { billingItems: data.billingItems, total: data.total };
  },

  async get(id: string, endpoint?: string): Promise<{ billingItem: BillingItem; flow: any }> {
    const url = apiService.buildApiUrl(`/v1/billing-items/${encodeURIComponent(id)}`, endpoint || base());
    const res = await fetch(url, { headers: apiService.getAuthHeaders() });
    return parse(res);
  },

  async create(input: BillingItemCreateInput, endpoint?: string): Promise<BillingItem> {
    const target=endpoint??base(),session=createSession(target);
    const record=beginBusinessRequest(CREATE_OPERATION,{input:originalInput(input)},target);
    return postCreate({requestId:record.requestId,input:record.payload.input},target,session);
  },

  pendingCreate(endpoint?:string):PendingBillingCreate|null {
    const target=endpoint??base();billingCreateSessionIdentity(target);
    const record=readBusinessRequest<{input:BillingItemCreateInput}>(CREATE_OPERATION,target);
    if(!record)return null;
    if(!record.payload.input||typeof record.payload.input!=='object'||Array.isArray(record.payload.input))throw new Error('原收费请求记录损坏，请保留原记录核对。');
    const input=originalInput(record.payload.input);
    return {requestId:record.requestId,input};
  },

  async retryCreate(pending:PendingBillingCreate,endpoint?:string):Promise<BillingItem>{
    const target=endpoint??base(),session=createSession(target),current=billingItemService.pendingCreate(target);
    if(!current||canonicalBillingCreate(current)!==canonicalBillingCreate(pending))throw new Error('原收费请求已变化，请重新核对。');
    return postCreate(current,target,session);
  },

  async retireCreate(reason:string,endpoint?:string):Promise<{retired:true}|{billingItem:BillingItem}>{
    const target=endpoint??base(),session=createSession(target),current=billingItemService.pendingCreate(target);
    if(!current)throw new Error('当前没有待核对的原收费请求。');
    if(!reason.trim())throw new Error('请填写结束原请求的原因。');
    const retirement=beginBusinessRequest(RETIRE_OPERATION,{requestKey:current.requestId,input:current.input,reason},target);
    const body={...retirement.payload,retirementRequestKey:retirement.requestId};sameSession(session,target);
    const res=await fetch(apiService.buildApiUrl('/v1/billing-items/create-requests/retire',target),{method:'POST',headers:session.headers,body:JSON.stringify(body)});
    const data=await res.json().catch(()=>null);sameSession(session,target);
    if(!res.ok)throw new Error(data?.error?.message||'原收费请求暂时无法核对，请保留原内容。');
    if(data?.retired===true){
      const ack=data.acknowledgement,command={schemaVersion:1,operation:'create_billing_item',actorId:session.actorId,requestKey:current.requestId,input:current.input};
      const retired={schemaVersion:1,operation:'retire_billing_item_create',actorId:session.actorId,requestKey:current.requestId,input:current.input,
        retirementRequestKey:retirement.requestId,reason};
      if(data.ok!==true||ack?.schemaVersion!==1||ack.operation!=='retire_billing_item_create'||ack.actorId!==session.actorId||ack.requestKey!==current.requestId
        ||ack.retirementRequestKey!==retirement.requestId||ack.reason!==reason||typeof ack.receiptAuditId!=='string'||!ack.receiptAuditId
        ||canonicalBillingCreate(ack.commandSnapshot)!==canonicalBillingCreate(current.input)||ack.commandHash!==await billingDigest(command)
        ||ack.retirementHash!==await billingDigest(retired))unconfirmed();
      sameSession(session,target);clearAcknowledgedBusinessRequest(CREATE_OPERATION,current.requestId,target);clearAcknowledgedBusinessRequest(RETIRE_OPERATION,retirement.requestId,target);
      return {retired:true};
    }
    const item=await verifyCreateAck(data,current,session.actorId);sameSession(session,target);
    clearAcknowledgedBusinessRequest(CREATE_OPERATION,current.requestId,target);clearAcknowledgedBusinessRequest(RETIRE_OPERATION,retirement.requestId,target);
    return {billingItem:item};
  },

  async update(id: string, input: BillingItemUpdateInput, endpoint?: string): Promise<BillingItem> {
    const url = apiService.buildApiUrl(`/v1/billing-items/${encodeURIComponent(id)}`, endpoint || base());
    const res = await fetch(url, {
      method: 'PATCH',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    const data = await parse(res);
    return data?.billingItem;
  },

  async confirm(id: string, endpoint?: string): Promise<BillingItem> {
    const url = apiService.buildApiUrl(`/v1/billing-items/${encodeURIComponent(id)}/confirm`, endpoint || base());
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders() });
    const data = await parse(res);
    return data?.billingItem;
  },

  async invoice(id: string, input?: { invoiceDate?: string; dueDate?: string; notes?: string }, endpoint?: string): Promise<{ invoice: any; recovered?: boolean }> {
    const url = apiService.buildApiUrl(`/v1/billing-items/${encodeURIComponent(id)}/invoice`, endpoint || base());
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input ?? {}),
    });
    return parse(res);
  },

  async cancel(id: string, reason?: string, endpoint?: string): Promise<BillingItem> {
    const url = apiService.buildApiUrl(`/v1/billing-items/${encodeURIComponent(id)}/cancel`, endpoint || base());
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ reason: reason || null }),
    });
    const data = await parse(res);
    return data?.billingItem;
  },
};
