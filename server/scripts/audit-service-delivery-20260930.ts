/** Local PG integration; one rolled-back transaction. Adapter does NOT prove concurrency. */
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import {PrismaClient} from '@prisma/client';
import {createPurchaseServiceDeliveryService} from '../src/procurement/purchaseServiceDeliveryService';
dotenv.config({path:'.env.local'});dotenv.config();
const url=new URL(process.env.DATABASE_URL||'');
assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname==='/panda_hub_local','Local database only');
const db=new PrismaClient();const tag=`AUDIT-SERVICE-0930-${Date.now()}`;const rollback=new Error('ROLLBACK_FIXTURE');
async function main(){
 const identity:any[]=await db.$queryRaw`SELECT current_database() AS name, inet_server_addr()::text AS address`;
 assert.equal(identity[0].name,'panda_hub_local');assert(['127.0.0.1','::1'].includes(String(identity[0].address).split('/')[0]));
 const results:any[]=[];
 try {await db.$transaction(async tx=>{
  const now=BigInt(Date.now());
  await tx.userAccount.create({data:{id:tag,displayName:'服务交付隔离验收',status:'inactive'}});
  await tx.relation.create({data:{id:`${tag}-supplier`,name:'隔离加工厂',category:'Supplier',type:'Factory',isOrganization:true,tags:[],contactInfo:'{}',lastInteraction:now}});
  // Services use normal transactions; bind nested calls to this rollback-only transaction.
  const adapter=new Proxy(tx as any,{get(target,key){if(key==='$transaction') return async(fn:any)=>fn(target);return Reflect.get(target,key);}});
  const service=createPurchaseServiceDeliveryService(adapter);
  const beforeStock=await tx.stockMovement.count();const beforeReceipts=await tx.materialReceipt.count();
  for(const type of ['Fabric','Garment']){
   const orderId=`${tag}-${type}`,lineId=`${orderId}-line`,poId=`${orderId}-po`,purchaseLineId=`${poId}-line`;
   await tx.order.create({data:{id:orderId,customer:'隔离客户',product:type,type,quantity:1000,status:'Production',dueDate:'2026-12-01',quoteAmount:5000,currency:'CNY'}});
   await tx.orderLine.create({data:{id:lineId,orderId,lineNumber:1,quantity:1000,unitPrice:5,netValue:5000,description:'真实订单产品明细'}});
   await tx.purchaseOrder.create({data:{id:poId,poNumber:poId,orderId,status:'Confirmed',currency:'CNY',totalAmount:2000,orderDate:'2026-09-30',supplierRelationId:`${tag}-supplier`,supplierName:'隔离加工厂',createdAt:now,updatedAt:now,lines:{create:{id:purchaseLineId,orderLineId:lineId,kind:'ProcessingService',lineNumber:1,description:'加工服务',quantity:1000,unit:'PC',unitPrice:2,amount:2000,createdAt:now}}}});
   const firstInput={requestKey:`${poId}-req1`,purchaseLineId,deliveryNumber:`${poId}-D1`,deliveredAt:'2026-09-30',acceptedQuantity:300,rejectedQuantity:20,evidenceReference:`${orderId}-QC1`};
   const first=await service.create(poId,firstInput,tag,[orderId]);
   await service.create(poId,{...firstInput,requestKey:`${poId}-req2`,deliveryNumber:`${poId}-D2`,acceptedQuantity:180,rejectedQuantity:0},tag,[orderId]);
   const replay=await service.create(poId,firstInput,tag,[orderId]);assert.equal(replay.replayed,true);assert.equal(replay.delivery.id,first.delivery.id);
   await assert.rejects(()=>service.create(poId,{...firstInput,requestKey:`${poId}-excess`,acceptedQuantity:521,rejectedQuantity:0},tag,[orderId]),(e:any)=>e.code==='OVER_DELIVERY');
   await assert.rejects(()=>service.create(poId,firstInput,tag,[]),(e:any)=>e.status===404);
   const stored=await tx.purchaseLine.findUniqueOrThrow({where:{id:purchaseLineId}});assert.equal(Number(stored.receivedQuantity),480);assert.equal(Number(stored.rejectedQuantity),20);
   const facts=await tx.purchaseServiceDelivery.findMany({where:{purchaseOrderId:poId}});assert.equal(facts.length,2);assert.equal(facts.reduce((n,f)=>n+Number(f.acceptedAmount),0),960);
   const draft=await service.createPayableDraft(first.delivery.id,tag,[orderId]);const duplicate=await service.createPayableDraft(first.delivery.id,tag,[orderId]);
   assert.equal(duplicate.replayed,true);assert.equal(duplicate.invoice.id,draft.invoice.id);assert.equal(Number(draft.invoice.amount),600);assert.equal(draft.invoice.status,'Draft');
   assert.equal(await tx.invoice.count({where:{sourceType:'PurchaseServiceDelivery',sourceId:first.delivery.id}}),1);
   const refs=await tx.entityReference.findMany({where:{ownerType:'invoice',ownerId:draft.invoice.id,status:'active'}});
   assert(refs.some(r=>r.targetType==='order'&&r.targetId===orderId));assert(refs.some(r=>r.fieldKey==='customerName'&&r.targetId===`${tag}-supplier`));
   assert.equal((await service.list(poId,[orderId])).items.length,2);
   results.push({type,accepted:480,rejected:20,acceptedAmount:960,draftAmount:600,invoiceReferences:refs.length,replay:true,scopeRejected:true,excessRejected:true});
  }
  assert.equal(await tx.stockMovement.count(),beforeStock);assert.equal(await tx.materialReceipt.count(),beforeReceipts);
  throw rollback;
 },{timeout:60000});}catch(error){if(error!==rollback)throw error;}
 assert.equal(await db.order.count({where:{id:{startsWith:tag}}}),0);assert.equal(await db.purchaseServiceDelivery.count({where:{requestKey:{startsWith:tag}}}),0);assert.equal(await db.userAccount.count({where:{id:tag}}),0);
 console.log(JSON.stringify({result:'PASS',database:identity[0].name,results,noStockOrMaterialReceiptWrites:true,rollbackVerified:true,concurrencyProof:false}));
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>db.$disconnect());
