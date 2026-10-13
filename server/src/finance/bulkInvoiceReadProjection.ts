import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { physicalShipmentAllocationFingerprint, type ShipmentPhysicalContext } from '../shipping/shipmentPhysicalConsumerService';
import { verifyFinancialShipmentSource } from '../shipping/shipmentFinancialAuthority';
import { exactJsonValue } from '../lib/exactJsonValue';

export class BulkInvoiceReadError extends Error {
  constructor(public code: 'UNAUTHORIZED' | 'ACCOUNT_DISABLED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_FAILED' | 'AUTHORIZATION_UNAVAILABLE', message: string, public statusCode: number) { super(message); }
}
const unavailable = () => new BulkInvoiceReadError('AUTHORIZATION_UNAVAILABLE', '大货开票来源暂时无法核验，请重新读取。', 503);
const deny = () => new BulkInvoiceReadError('FORBIDDEN', '当前权限不能查看该订单的开票来源。', 403);
const missing = () => new BulkInvoiceReadError('NOT_FOUND', '来源批次或订单不存在或不可查看。', 404);
const canonical = (value: any, collection = false): any => {
  const normalized = exactJsonValue(value);
  if (Array.isArray(normalized)) {
    const result = normalized.map(row => canonical(row));
    return collection ? result.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : result;
  }
  if (normalized && typeof normalized === 'object') return Object.fromEntries(Object.keys(normalized).sort().map(key => [key, canonical(normalized[key], ['roles','permissions','departmentIds','roleIds'].includes(key))]));
  if (typeof normalized === 'number' && !Number.isFinite(normalized)) throw unavailable();
  return normalized;
};
const digest = (value: any, collection = false) => createHash('sha256').update(JSON.stringify(canonical(value, collection))).digest('hex');
/** Only real readonly methods can contribute observations; SQL, nested transactions
 * and writes are refused. A failed dependency cannot be swallowed into an empty plan. */
function observed(tx: any) {
  const reads: string[] = []; let fault: BulkInvoiceReadError | undefined;
  const client = new Proxy(tx, { get(raw, key) {
    if (typeof key !== 'string' || key.startsWith('$')) return () => { fault = unavailable(); throw fault; };
    const delegate = Reflect.get(raw,key);
    if (!delegate || typeof delegate !== 'object') return delegate;
    return new Proxy(delegate, { get(model, method) {
      const native = Reflect.get(model,method);
      if (typeof native !== 'function') return native;
      if (!['findFirst','findUnique','findMany','count'].includes(String(method))) return () => { fault = unavailable(); throw fault; };
      return async (...args: any[]) => {
        try { const result = await Reflect.apply(native,model,args); reads.push(`${key}.${String(method)}:${digest(result,method==='findMany')}`); return result; }
        catch { fault = unavailable(); throw fault; }
      };
    }});
  }});
  return { client, stamp: () => { if (fault) throw fault; return digest(reads.sort()); } };
}
async function actorNow(tx: any, prior: TokenPayload | null | undefined): Promise<TokenPayload> {
  if (!prior?.userId) throw new BulkInvoiceReadError('UNAUTHORIZED','请登录后查看大货开票来源。',401);
  const user = await loadUserWithRoles(tx,prior.userId);
  if (!user || user.status !== 'active' || user.deletedAt != null) throw new BulkInvoiceReadError('ACCOUNT_DISABLED','当前账号不可用。',401);
  const actor = await buildLoadedAuthTokenPayload(tx,user);
  if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  if (!['invoices:read','orders:read','shipments:read'].every(scope => hasScope({...actor,roles:[]},scope as any))) throw deny();
  return actor;
}
export interface BulkInvoiceSource {
  schemaVersion: 1;
  order: { id: string; code: string | null; poNumber: string | null; customer: string; product: string; customerRelationId: string | null };
  batch: { id: string; orderId: string; batchNo: number; status: 'planned' | 'shipped' | 'cancelled'; currency: string; plannedAmount: string | null; plannedQty: string | null; unit: string | null };
  shipment: { id: string; shipmentNumber: string; status: string } | null;
  actual: { evidence: 'planned' | 'confirmed' | 'unconfirmed'; quantity: string | null; unit: string | null };
  sourceFingerprint: string;
  disposition: 'first-invoice-review' | 'existing-invoices' | 'review-required';
  canStartInvoice: boolean; blockedReason: string | null;
  invoices: Array<{ invoiceId: string; invoiceNumber: string; type: string; status: string; target: { kind: 'invoice'; invoiceId: string; tab: 'invoices' } }>;
}
async function shipmentSnapshot(tx: any, id: string, actor: TokenPayload, scope: any): Promise<ShipmentPhysicalContext | null> {
  const shipment = await tx.shipment.findFirst({where:{id,deletedAt:null}});
  if (!shipment) return null;
  const allocations = await tx.shipmentOrderAllocation.findMany({where:{shipmentId:id},orderBy:{id:'asc'}});
  const orderIds = [...new Set<string>([shipment.orderId,...allocations.map((row:any)=>row.orderId)].filter(Boolean))].sort();
  for (const orderId of orderIds) if (!await tx.order.findFirst({where:{id:orderId,deletedAt:null,AND:[scope]},select:{id:true}})) return null;
  const claims = await tx.claimDisposition.findMany({where:{replacementShipmentId:id},select:{id:true}});
  const repairs = await tx.repairWorkOrder.findMany({where:{reshipmentId:id},select:{id:true}});
  const physical = await tx.shipmentProductionAllocation.findMany({where:{shipmentId:id},orderBy:{id:'asc'}});
  const batches = await tx.productionBatch.findMany({where:{orderId:{in:orderIds}},orderBy:{id:'asc'}});
  return {kind:claims.length||repairs.length?'claim':batches.length||physical.length?'physical':'legacy',shipment,actor,allocations,physical,batches,orderIds,allocationFingerprint:physicalShipmentAllocationFingerprint({shipment,orderIds,allocations,physical})};
}
/** Same source facts used by native invoice writers, read without their locks or
 * mutations. Historical/hidden/ambiguous finance links never establish first use. */
async function project(tx: any, actor: TokenPayload, order: any, batch: any, scope: any, financeWhere: any): Promise<BulkInvoiceSource> {
  if (!['planned','shipped','cancelled'].includes(batch.status)) throw unavailable();
  const orderLinks = await tx.invoiceOrderAllocation.findMany({where:{orderId:order.id},orderBy:{id:'asc'}});
  const relevant = orderLinks.filter((row:any)=>row.batchId===batch.id || row.batchId==null);
  const headers = await tx.invoice.findMany({where:{OR:[{orderId:order.id},...(relevant.length?[{id:{in:relevant.map((row:any)=>row.invoiceId)}}]:[])]},orderBy:{id:'asc'}});
  const candidates = headers.filter((row:any) => relevant.some((link:any)=>link.invoiceId===row.id) || !orderLinks.some((link:any)=>link.invoiceId===row.id && link.deletedAt==null && link.batchId!=null && link.batchId!==batch.id));
  let ambiguous = relevant.some((row:any)=>row.deletedAt!=null || row.batchId==null)
    || candidates.length===0 && (batch.settleStatus!=='unsettled'
      || [batch.invoicedAmount,batch.paidAmount].some(value=>value!=null&&!new Prisma.Decimal(value).isZero()));
  const invoices: BulkInvoiceSource['invoices'] = [];
  const allLinks = candidates.length ? await tx.invoiceOrderAllocation.findMany({where:{invoiceId:{in:candidates.map((row:any)=>row.id)}},orderBy:{id:'asc'}}) : [];
  for (const invoice of candidates) {
    const links = allLinks.filter((row:any)=>row.invoiceId===invoice.id && row.deletedAt==null);
    const parents = [...new Set<string>([invoice.orderId,...links.map((row:any)=>row.orderId)].filter(Boolean))].sort();
    let visible = !!await tx.invoice.findFirst({where:{id:invoice.id,deletedAt:null,AND:[financeWhere]},select:{id:true}});
    for (const id of parents) if (!await tx.order.findFirst({where:{id,deletedAt:null,AND:[scope]},select:{id:true}})) visible=false;
    const exact = links.some((link:any)=>link.orderId===order.id && link.batchId===batch.id);
    if (!visible || invoice.deletedAt!=null || !exact || !['Receivable','Proforma'].includes(invoice.type) || !['Draft','Issued','PartiallyPaid','Paid'].includes(invoice.status)) { ambiguous=true; continue; }
    invoices.push({invoiceId:invoice.id,invoiceNumber:invoice.invoiceNumber,type:invoice.type,status:invoice.status,target:{kind:'invoice',invoiceId:invoice.id,tab:'invoices'}});
  }
  const result: BulkInvoiceSource = {schemaVersion:1,
    order:{id:order.id,code:order.code??null,poNumber:order.poNumber??null,customer:order.customer,product:order.product,customerRelationId:order.customerRelationId??null},
    batch:{id:batch.id,orderId:batch.orderId,batchNo:batch.batchNo,status:batch.status,currency:batch.currency,plannedAmount:batch.amount==null?null:batch.amount.toString(),plannedQty:batch.plannedQty==null?null:batch.plannedQty.toString(),unit:batch.unit??null},
    shipment:null,actual:{evidence:batch.status==='planned'?'planned':'unconfirmed',quantity:null,unit:null},sourceFingerprint:'',disposition:'first-invoice-review',canStartInvoice:false,blockedReason:null,invoices};
  let sourceEligible = batch.status!=='cancelled';
  if (batch.shipmentId) {
    const context = await shipmentSnapshot(tx,batch.shipmentId,actor,scope);
    if (!context || context.kind==='claim' || context.shipment.status==='Cancelled' || !context.orderIds.includes(order.id)) sourceEligible=false;
    else {
      result.shipment={id:context.shipment.id,shipmentNumber:context.shipment.shipmentNumber,status:context.shipment.status};
      if (batch.status==='shipped') {
        try {
          await verifyFinancialShipmentSource(tx,context,order.id);
          const allocations=context.allocations.filter((row:any)=>row.orderId===order.id&&row.status!=='Cancelled'&&row.actualQty!=null&&new Prisma.Decimal(row.actualQty).gt(0));
          const units=[...new Set(allocations.map((row:any)=>row.unit).filter(Boolean))];
          if (units.length!==1) sourceEligible=false;
          else result.actual={evidence:'confirmed',quantity:allocations.reduce((sum:Prisma.Decimal,row:any)=>sum.plus(row.actualQty),new Prisma.Decimal(0)).toString(),unit:units[0] as string};
        } catch(error) { if (error instanceof BulkInvoiceReadError) throw error; sourceEligible=false; }
      }
    }
  } else if (batch.status==='shipped') sourceEligible=false;
  if (!sourceEligible || ambiguous || candidates.length && invoices.length===0) {
    result.disposition='review-required'; result.blockedReason='原批次来源、历史开票或当前可见范围须先核对，不能据此再次开票。';
  } else if (invoices.length) result.disposition='existing-invoices';
  result.canStartInvoice=result.disposition==='first-invoice-review'&&hasScope({...actor,roles:[]},'invoices:write');
  result.sourceFingerprint=digest({result,batch,order,orderLinks,headers,allLinks});
  return result;
}
export async function bulkInvoiceSourcesInTx(tx: any, prior: TokenPayload | null | undefined, query: {orderId?:string;batchId?:string} = {}): Promise<BulkInvoiceSource[]> {
  const observation=observed(tx), db=observation.client;
  try {
    const actor=await actorNow(db,prior), scope=await freshOrderLineScope(db,actor);
    const orders=await db.order.findMany({where:{deletedAt:null,...(query.orderId?{id:query.orderId}:{}),AND:[scope]},orderBy:{id:'asc'}});
    if (query.orderId&&!orders.length) throw missing(); // No child reads before parent authority.
    const financeWhere=buildScopeWhereFromResolver(await createPermissionService({prisma:db}).getDataScopeResolver(actor,'finance'),actor.userId);
    const batches=orders.length ? await db.orderShipmentBatch.findMany({where:{orderId:{in:orders.map((row:any)=>row.id)},deletedAt:null,...(query.batchId?{id:query.batchId}:{status:{in:['planned','shipped']}})},orderBy:{id:'asc'}}) : [];
    if (query.batchId&&!batches.length) throw missing();
    const items:BulkInvoiceSource[]=[];
    for (const batch of batches) items.push(await project(db,actor,orders.find((row:any)=>row.id===batch.orderId),batch,scope,financeWhere));
    const stamp=observation.stamp();
    return items.map(source=>({...source,sourceFingerprint:digest({source,stamp,actor})}));
  } catch(error) {
    observation.stamp(); // Raises a dependency fault even if an existing policy reader swallowed it.
    if (error instanceof BulkInvoiceReadError) throw error;
    throw unavailable();
  }
}
/** Separate native snapshots prove the full authority/source projection stayed
 * current before publishing. This is a read proof, never a create reservation. */
export async function readBulkInvoiceSources(prisma: PrismaClient, prior: TokenPayload | null | undefined, query:{orderId?:string;batchId?:string}) {
  if (!query.orderId || query.orderId.trim()!==query.orderId || query.batchId!==undefined&&(!query.batchId||query.batchId.trim()!==query.batchId)) throw new BulkInvoiceReadError('VALIDATION_FAILED','请选择原订单和出运结算批次。',400);
  const run=()=>prisma.$transaction(tx=>bulkInvoiceSourcesInTx(tx,prior,query),{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  const before=await run(), after=await run();
  if (digest(before)!==digest(after)) throw new BulkInvoiceReadError('CONFLICT','开票来源或当前权限在读取时变化，请重新核对。',409);
  return after;
}
