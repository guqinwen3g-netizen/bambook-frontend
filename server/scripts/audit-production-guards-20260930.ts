import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import {PrismaClient} from '@prisma/client';
import {createInventoryService} from '../src/inventory/inventoryService';
import {createMesService} from '../src/mes/mesService';
dotenv.config({path:'.env.local'});dotenv.config();
const u=new URL(process.env.DATABASE_URL!);assert(['localhost','127.0.0.1'].includes(u.hostname)&&u.pathname==='/panda_hub_local');
const db=new PrismaClient(),tag=`AUDIT-PRODUCTION-${Date.now()}`,rollback=new Error('ROLLBACK');
async function main(){
 const identity:any[]=await db.$queryRaw`SELECT current_database() AS name, inet_server_addr()::text AS address`;
 assert.equal(identity[0].name,'panda_hub_local');assert(['127.0.0.1','::1'].includes(String(identity[0].address).split('/')[0]));
 try{await db.$transaction(async tx=>{
  const now=BigInt(Date.now());
  await tx.userAccount.create({data:{id:tag,displayName:'生产隔离验证',status:'inactive'}});
  for(const suffix of ['from','to'])await tx.warehouse.create({data:{id:`${tag}-${suffix}`,code:`${tag}-${suffix}`,name:suffix,type:'Temporary',createdAt:now,updatedAt:now}});
  const source=await tx.inventoryItem.create({data:{id:tag,warehouseId:`${tag}-from`,materialCode:tag,description:'归属验证',quantity:600,unit:'M',unitCost:10,currency:'CNY',ownership:'Transferred',orderId:'AUDIT-SOURCE-ORDER',stockPrep:true,createdAt:now,updatedAt:now}});
  await tx.inventoryItem.create({data:{id:`${tag}-other`,warehouseId:`${tag}-to`,materialCode:tag,description:'不得混合',quantity:100,unit:'M',unitCost:20,currency:'CNY',ownership:'Owned',createdAt:now,updatedAt:now}});
  await createInventoryService(tx as any).createStockMovement({itemId:source.id,type:'Transfer',quantity:200,targetWarehouseId:`${tag}-to`,unitCost:999},tag,{tx});
  const target=await tx.inventoryItem.findFirstOrThrow({where:{warehouseId:`${tag}-to`,id:{not:`${tag}-other`}}});
  assert.equal(target.ownership,'Transferred');assert.equal(target.orderId,'AUDIT-SOURCE-ORDER');assert.equal(target.stockPrep,true);assert.equal(Number(target.quantity),200);assert.equal(Number(target.unitCost),10);
  assert.equal(Number((await tx.inventoryItem.findUniqueOrThrow({where:{id:source.id}})).quantity),400);
  assert.equal(Number((await tx.inventoryItem.findUniqueOrThrow({where:{id:`${tag}-other`}})).quantity),100);
  const movements=await tx.stockMovement.findMany({where:{itemId:{in:[source.id,target.id]}}});assert.equal(movements.length,2);assert(movements.every(m=>Number(m.unitCost)===10));
  await tx.outsourcingOrder.create({data:{id:tag,orderNumber:tag,status:'InProduction',processType:'Sewing',quantity:100,unit:'PC',unitPrice:2,totalAmount:200,createdAt:now,updatedAt:now}});
  const mes=createMesService(tx as any);
  await assert.rejects(mes.transitionOutsourcingStatus(tag,'Received',tag),/到货验收/);
  await assert.rejects(mes.receiveOutsourcing(tag,{qualityAcceptedQty:40},tag),/分批/);
  await assert.rejects(mes.receiveOutsourcing(tag,{qualityAcceptedQty:100,qualityRejectedQty:-1},tag),/非负/);
  assert.equal((await tx.outsourcingOrder.findUniqueOrThrow({where:{id:tag}})).status,'InProduction');
  console.log(JSON.stringify({result:'PASS',tag,verified:['transfer preserves ownership order stockPrep and source price','different-cost target unchanged','two movement costs fixed at 10','direct Received blocked','partial receipt not falsely completed','invalid quantity rejected'],fixturePolicy:'rollback'}));throw rollback;
 },{timeout:30000});}catch(e){if(e!==rollback)throw e;}
 assert.equal(await db.inventoryItem.count({where:{id:tag}}),0);console.log('ROLLBACK_VERIFIED');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
