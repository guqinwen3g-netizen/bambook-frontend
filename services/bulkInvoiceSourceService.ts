import { apiService } from './apiService';
import { getAuthState, hasPermission, subscribe } from './authService';
import { dashboardReadIdentity } from './dashboardTaskService';
export interface BulkInvoiceSource {
 schemaVersion: 1;
 order: {id:string;code:string|null;poNumber:string|null;customer:string;product:string;customerRelationId:string|null};
 batch: {id:string;orderId:string;batchNo:number;status:'planned'|'shipped'|'cancelled';currency:string;plannedAmount:string|null;plannedQty:string|null;unit:string|null};
 shipment: {id:string;shipmentNumber:string;status:string}|null;
 actual: {evidence:'planned'|'confirmed'|'unconfirmed';quantity:string|null;unit:string|null};
 sourceFingerprint:string;disposition:'first-invoice-review'|'existing-invoices'|'review-required';canStartInvoice:boolean;blockedReason:string|null;
 invoices:Array<{invoiceId:string;invoiceNumber:string;type:string;status:string;target:{kind:'invoice';invoiceId:string;tab:'invoices'}}>;
}
const id=(value:any):value is string=>typeof value==='string'&&!!value&&value.trim()===value;
const nullable=(value:any)=>value===null||typeof value==='string';
const decimal=(value:any)=>value===null||typeof value==='string'&&/^-?\d{1,14}(?:\.\d{1,4})?$/.test(value);
const positive=(value:any)=>decimal(value)&&value!==null&&!value.startsWith('-')&&/[1-9]/.test(value);
export function checkedBulkInvoiceSource(source:any,orderId:string,batchId?:string):BulkInvoiceSource {
 const invalid=()=>{throw Error('大货开票来源资料不完整，请重新读取核对。');};
 if (source?.schemaVersion!==1||source.order?.id!==orderId||!id(orderId)||!nullable(source.order.code)||!nullable(source.order.poNumber)
  ||typeof source.order.customer!=='string'||typeof source.order.product!=='string'||!nullable(source.order.customerRelationId)
  ||!id(source.batch?.id)||batchId!==undefined&&source.batch.id!==batchId||source.batch.orderId!==orderId
  ||!Number.isSafeInteger(source.batch.batchNo)||source.batch.batchNo<1||!['planned','shipped','cancelled'].includes(source.batch.status)
  ||!id(source.batch.currency)||!decimal(source.batch.plannedAmount)||!decimal(source.batch.plannedQty)||!nullable(source.batch.unit)
  ||!(source.shipment===null||id(source.shipment?.id)&&id(source.shipment.shipmentNumber)&&id(source.shipment.status))
  ||!['planned','confirmed','unconfirmed'].includes(source.actual?.evidence)||!decimal(source.actual.quantity)||!nullable(source.actual.unit)
  ||typeof source.sourceFingerprint!=='string'||! /^[a-f0-9]{64}$/.test(source.sourceFingerprint)
  ||!['first-invoice-review','existing-invoices','review-required'].includes(source.disposition)||typeof source.canStartInvoice!=='boolean'
  ||!nullable(source.blockedReason)||!Array.isArray(source.invoices)) invalid();
 const seen=new Set<string>();
 for (const invoice of source.invoices) {
  if(!id(invoice?.invoiceId)||seen.has(invoice.invoiceId)||!id(invoice.invoiceNumber)||!['Receivable','Proforma'].includes(invoice.type)
   ||!['Draft','Issued','PartiallyPaid','Paid'].includes(invoice.status)||invoice.target?.kind!=='invoice'||invoice.target.invoiceId!==invoice.invoiceId||invoice.target.tab!=='invoices'
   ||Object.keys(invoice.target).length!==3) invalid();
  seen.add(invoice.invoiceId);
 }
 if(source.actual.evidence==='confirmed'&&(!positive(source.actual.quantity)||!id(source.actual.unit)||!source.shipment||source.batch.status!=='shipped')
  ||source.actual.evidence!=='confirmed'&&(source.actual.quantity!==null||source.actual.unit!==null)
  ||source.batch.status==='planned'&&source.actual.evidence!=='planned'
  ||source.disposition==='first-invoice-review'&&(source.invoices.length!==0||source.blockedReason!==null||source.batch.status==='cancelled'||source.batch.status==='shipped'&&source.actual.evidence!=='confirmed')
  ||source.disposition==='existing-invoices'&&source.invoices.length===0
  ||source.disposition!=='first-invoice-review'&&source.canStartInvoice
  ||source.disposition==='review-required'&&!id(source.blockedReason)) invalid();
 return source;
}
async function read(orderId:string,batchId?:string,signal?:AbortSignal):Promise<any> {
 const auth=getAuthState();
 if(!auth.isAuthenticated||auth.isLoading||!id(auth.user?.id)||!['orders:read','shipments:read','invoices:read'].every(scope=>hasPermission(scope as any))) throw Error('当前权限不能查看大货开票来源。');
 if(!id(orderId)||batchId!==undefined&&!id(batchId)) throw Error('请重新选择原订单与批次。');
 const identity=dashboardReadIdentity();let stale=false;
 const controller=new AbortController();
 const watch=()=>{if(identity!==dashboardReadIdentity()){stale=true;controller.abort();}};
 const stop=subscribe(watch);const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
 window.addEventListener('storage',watch);window.addEventListener('focus',watch);
 const current=()=>{watch();if(stale||controller.signal.aborted||signal?.aborted)throw Error('账号、权限或服务地址已变化，请重新读取大货开票来源。');};
 try {
  current();const response=await fetch(apiService.buildApiUrl(`/v1/finance/scene-invoice/bulk-sources${batchId?'/'+encodeURIComponent(batchId):''}?orderId=${encodeURIComponent(orderId)}`),{headers:apiService.getAuthHeaders(),signal:controller.signal});current();
  const data=await response.json();current();
  if(!response.ok||data?.ok!==true)throw Error(data?.error?.message||`大货来源读取未确认（HTTP ${response.status}）。`);
  if(batchId)return checkedBulkInvoiceSource(data.source,orderId,batchId);
  if(!Array.isArray(data.items))throw Error('大货来源列表未确认，请重新读取。');
  const items=data.items.map((source:any)=>checkedBulkInvoiceSource(source,orderId));
  if(new Set(items.map((source:BulkInvoiceSource)=>source.batch.id)).size!==items.length)throw Error('大货来源列表重复，请重新读取。');return items;
 } finally {stop();signal?.removeEventListener('abort',abort);window.removeEventListener('storage',watch);window.removeEventListener('focus',watch);}
}
export const bulkInvoiceSourceService={
 getSource:(orderId:string,batchId:string,signal?:AbortSignal):Promise<BulkInvoiceSource>=>read(orderId,batchId,signal),
 listByOrder:(orderId:string,signal?:AbortSignal):Promise<BulkInvoiceSource[]>=>read(orderId,undefined,signal),
};
