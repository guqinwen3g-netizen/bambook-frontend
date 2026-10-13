import { isValidLocalDateKey, todayLocalKey } from '../shared/localDate';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { syncInvoiceReferences } from '../entities/sync';
import { legacySupplierMutation } from './supplierContractPolicy';

export class PurchaseServiceDeliveryError extends Error {
  constructor(public code:string,message:string,public status=409){super(message);this.statusCode=status;}
  readonly statusCode:number;
}
const fail=(code:string,message:string,status=409):never=>{throw new PurchaseServiceDeliveryError(code,message,status);};
export interface ServiceDeliveryInput {
 requestKey:string;purchaseLineId:string;deliveryNumber:string;deliveredAt:string;
 acceptedQuantity:number|string;rejectedQuantity:number|string;evidenceReference:string;notes?:string;
}
function decimal(value:unknown,label:string){
 if(!['string','number'].includes(typeof value)||String(value).trim()==='') return fail('INVALID_INPUT',`${label}须为有效数量`,400);
 let d:Prisma.Decimal;try{d=new Prisma.Decimal(value as string|number);}catch{return fail('INVALID_INPUT',`${label}无效`,400);}
 if(!d.isFinite()||d.lt(0)||d.decimalPlaces()>4||d.gte('100000000000000')) return fail('INVALID_INPUT',`${label}须为非负、最多4位小数`,400);
 return d;
}
export function createPurchaseServiceDeliveryService(prisma:PrismaClient){
 const db=prisma as any;
 async function scopedPO(tx:any,poId:string,visible:string[]|null){
  const po=await tx.purchaseOrder.findUnique({where:{id:poId},include:{lines:true}});
  if(!po||po.deletedAt||!po.orderId||(visible!==null&&!visible.includes(po.orderId))) return fail('NOT_FOUND','采购单不存在或不可见',404);
  const order=await tx.order.findUnique({where:{id:po.orderId}});
  if(!order||order.deletedAt) return fail('NOT_FOUND','来源订单不存在',404);
  return po;
 }
 async function create(poId:string,input:ServiceDeliveryInput,actorId:string,visibleOrderIds:string[]|null){
  const fields=['requestKey','purchaseLineId','deliveryNumber','deliveredAt','evidenceReference'] as const;
  for(const key of fields) if(typeof input[key]!=='string'||!input[key].trim()) fail('INVALID_INPUT',`${key}必填`,400);
  if(input.requestKey.length>128) fail('INVALID_INPUT','requestKey过长',400);
  const deliveredAt=input.deliveredAt.trim();
  if(!isValidLocalDateKey(deliveredAt)) fail('INVALID_INPUT','交付日期无效',400);
  const accepted=decimal(input.acceptedQuantity,'合格数量'),rejected=decimal(input.rejectedQuantity,'拒收数量');
  if(accepted.plus(rejected).lte(0)) fail('INVALID_INPUT','交付总量必须大于零',400);
  const normalized={purchaseOrderId:poId,purchaseLineId:input.purchaseLineId.trim(),deliveryNumber:input.deliveryNumber.trim(),deliveredAt,acceptedQuantity:accepted.toString(),rejectedQuantity:rejected.toString(),evidenceReference:input.evidenceReference.trim(),notes:input.notes?.trim()||null};
  const requestKey=input.requestKey.trim(),requestFingerprint=createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return db.$transaction(async(tx:any)=>{
   await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${poId} FOR UPDATE`);
   const po=await scopedPO(tx,poId,visibleOrderIds);
   const prior=await tx.purchaseServiceDelivery.findUnique({where:{requestKey}});
   if(prior){if(prior.purchaseOrderId!==poId||prior.requestFingerprint!==requestFingerprint) fail('IDEMPOTENCY_CONFLICT','同一请求已用于不同交付内容');return {delivery:prior,replayed:true};}
   const line=po.lines.find((l:any)=>l.id===normalized.purchaseLineId);
   if(!line||line.kind!=='ProcessingService') fail('INVALID_LINE','只能对加工服务行登记服务交付');
   const orderLine=line.orderLineId?await tx.orderLine.findUnique({where:{id:line.orderLineId}}):null;
   if(!orderLine||orderLine.orderId!==po.orderId||orderLine.deletedAt) fail('INVALID_SOURCE','服务行未关联当前订单的真实产品明细');
   if(!['Confirmed','PartiallyReceived'].includes(po.status)) fail('INVALID_STATE','当前采购状态不能登记新的服务交付');
   const planned=new Prisma.Decimal(line.quantity),received=new Prisma.Decimal(line.receivedQuantity);
   if(accepted.plus(rejected).gt(planned.minus(received))) fail('OVER_DELIVERY','本次交付超过剩余未验收数量');
   const price=decimal(line.unitPrice.toString(),'服务单价');if(price.lte(0)) fail('INVALID_PRICE','服务单价必须大于零');
   if(!line.unit||!po.currency) fail('INVALID_SOURCE','采购单位或币种缺失');
   const amount=accepted.mul(price).toDecimalPlaces(4);
   if(amount.gte('100000000000000')) fail('INVALID_AMOUNT','交付金额超出精度范围',400);
   const now=BigInt(Date.now());
   const delivery=await tx.purchaseServiceDelivery.create({data:{id:`PSD_${randomUUID()}`,...normalized,orderId:po.orderId,orderLineId:line.orderLineId,requestKey,requestFingerprint,acceptedQuantity:accepted,rejectedQuantity:rejected,unit:line.unit,unitPriceSnapshot:price,currencySnapshot:po.currency,acceptedAmount:amount,createdBy:actorId,createdAt:now}});
   const complete=po.lines.every((l:any)=>new Prisma.Decimal(l.receivedQuantity).plus(l.id===line.id?accepted:0).gte(l.quantity));
   await tx.purchaseLine.update({where:{id:line.id},data:{receivedQuantity:{increment:accepted},rejectedQuantity:{increment:rejected}}});
   await tx.purchaseOrder.update({where:{id:poId},data:{status:complete?'Received':'PartiallyReceived',updatedAt:now}});
   await tx.auditLog.create({data:{id:`AUD_${randomUUID()}`,actorId,action:'create_purchase_service_delivery',targetType:'PurchaseOrder',targetId:poId,detail:{after:{deliveryId:delivery.id,purchaseLineId:line.id,acceptedQuantity:accepted.toString(),rejectedQuantity:rejected.toString(),acceptedAmount:amount.toString(),evidenceReference:normalized.evidenceReference}},createdAt:new Date()}});
   return {delivery,replayed:false};
  }).catch(async(error:any)=>{
   if(error?.code==='P2002') {
    const prior=await db.purchaseServiceDelivery.findUnique({where:{requestKey}});
    if(prior) fail('IDEMPOTENCY_CONFLICT','同一请求已用于其他交付内容');
   }
   throw error;
  });
 }
 async function list(poId:string,visibleOrderIds:string[]|null){await scopedPO(db,poId,visibleOrderIds);const items=await db.purchaseServiceDelivery.findMany({where:{purchaseOrderId:poId},orderBy:{createdAt:'desc'}});return {items:await Promise.all(items.map(async(delivery:any)=>({...delivery,invoice:await db.invoice.findFirst({where:{sourceType:'PurchaseServiceDelivery',sourceId:delivery.id},select:{id:true,invoiceNumber:true,status:true,deletedAt:true}})})))};}
 async function createPayableDraft(deliveryId:string,actorId:string,visibleOrderIds:string[]|null){
  return db.$transaction(async(tx:any)=>{
   await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseServiceDelivery" WHERE "id" = ${deliveryId} FOR UPDATE`);
   const delivery=await tx.purchaseServiceDelivery.findUnique({where:{id:deliveryId}});
   if(!delivery) fail('NOT_FOUND','服务交付不存在',404);
   await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${delivery.purchaseOrderId} FOR UPDATE`);
   const po=await scopedPO(tx,delivery.purchaseOrderId,visibleOrderIds);
   if(delivery.orderId!==po.orderId) fail('SCOPE_CHANGED','采购来源已变化，请核对');
   const source={sourceType:'PurchaseServiceDelivery',sourceId:delivery.id};
   const prior=await tx.invoice.findFirst({where:source});
   if(prior){if(prior.deletedAt||prior.status==='Cancelled') fail('SOURCE_INVOICE_VOIDED','来源应付已作废，请经财务调整处理');return {invoice:prior,replayed:true};}
   if(new Prisma.Decimal(delivery.acceptedAmount).lte(0)) fail('NO_PAYABLE_AMOUNT','零合格金额不生成应付');
   if(!po.supplierRelationId) fail('SUPPLIER_REQUIRED','采购单缺少结算供应商');
   const now=BigInt(Date.now());
   const invoiceNumber=await nextBusinessNumber(tx,'INV',undefined,{occupied:async(n:string)=>!!await tx.invoice.findFirst({where:{invoiceNumber:n},select:{id:true}})});
   const invoice=await tx.invoice.create({data:{id:`INV_${randomUUID()}`,invoiceNumber,...source,type:'Payable',status:'Draft',amount:delivery.acceptedAmount,currency:delivery.currencySnapshot,issueDate:todayLocalKey(),orderId:delivery.orderId,customerRelationId:po.supplierRelationId,customerName:po.supplierName,notes:`服务交付 ${delivery.deliveryNumber}；待财务审核，不代表付款批准`,createdAt:now,updatedAt:now,ownerId:actorId}});
   await syncInvoiceReferences(prisma,invoice,{source:'procurement:service-delivery'},tx);
   await tx.auditLog.create({data:{id:`AUD_${randomUUID()}`,actorId,action:'create_service_delivery_payable_draft',targetType:'PurchaseServiceDelivery',targetId:delivery.id,detail:{after:{invoiceId:invoice.id}},createdAt:new Date()}});
   return {invoice,replayed:false};
  });
 }
 return {create:legacySupplierMutation(create),list,createPayableDraft};
}
