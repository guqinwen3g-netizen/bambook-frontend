/** Run from server: npx tsx src/events/linkages/__tests__/L8AtomicStockIn.pg.ts */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { businessEventBus } from '../../businessEventBus';
import { registerL8AutoStockIn } from '../L8AutoStockIn';
import { createInventoryService } from '../../../inventory/inventoryService';
const url=new URL(process.env.DATABASE_URL!);assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname==='/panda_hub_local');
const db=new PrismaClient();const tag=`AUDIT-L8-ATOMIC-${Date.now()}`;const now=Date.now();let execute:any;
businessEventBus.registerLinkage=((handler:any)=>{execute=handler.execute;}) as any;registerL8AutoStockIn();
async function main(){
 await db.userAccount.create({data:{id:tag,displayName:tag,status:'inactive'}});
 await db.warehouse.create({data:{id:tag,code:tag,name:tag,type:'Temporary',createdAt:now,updatedAt:now}});
 await db.purchaseOrder.create({data:{id:tag,poNumber:tag,status:'Received',currency:'CNY',totalAmount:30,orderDate:'2026-09-30',createdAt:now,updatedAt:now,lines:{create:[1,2].map(i=>({id:`${tag}-line${i}`,lineNumber:i,description:`AUDIT ${i}`,materialCode:`${tag}-mat${i}`,quantity:i*10,unit:'PC',unitPrice:1,amount:i*10,createdAt:now}))}}});
 await db.materialReceipt.create({data:{id:tag,receiptNumber:tag,purchaseOrderId:tag,status:'Accepted',receivedDate:'2026-09-30',totalReceived:30,totalAccepted:30,totalRejected:0,warehouseId:tag,createdAt:now}});
 const item=await createInventoryService(db).createInventoryItem({warehouseId:tag,materialCode:`${tag}-mat2`,description:'AUDIT intentional unit mismatch',unit:'KG',quantity:0,unitCost:1},tag);
 const event:any={id:tag,type:'MaterialReceived',sourceEntityId:tag,actorId:tag,payload:{purchaseOrderId:tag,receiptId:tag,warehouseId:tag,stockInLines:[1,2].map(i=>({lineId:`${tag}-line${i}`,description:`AUDIT ${i}`,materialCode:`${tag}-mat${i}`,unit:'PC',quantity:i*10,unitPrice:1}))}};
 const failed=await execute(db,event);assert.equal(failed.ok,false);assert.match(failed.error,/单位不可换算/);
 assert.equal(await db.stockMovement.count({where:{referenceId:tag}}),0);
 assert.equal(await db.inventoryItem.count({where:{warehouseId:tag}}),1); // first auto-created item rolled back
 await db.inventoryItem.update({where:{id:item.id},data:{unit:'PC'}}); // repair only this isolated fixture
 const results=await Promise.all([execute(db,event),execute(db,event)]);assert(results.every(r=>r.ok));
 assert.equal(await db.stockMovement.count({where:{referenceId:tag}}),2);
 const items=await db.inventoryItem.findMany({where:{warehouseId:tag},orderBy:{materialCode:'asc'}});assert.deepEqual(items.map(i=>Number(i.quantity)),[10,20]);
 const badWarehouse=await execute(db,{...event,payload:{...event.payload,warehouseId:`${tag}-missing`}});assert.equal(badWarehouse.ok,false);
 assert.equal(await db.stockMovement.count({where:{referenceId:tag}}),2);
 console.log(JSON.stringify({PASS:true,tag,checks:['second-line error rolls back first item and movement','two concurrent retries create exactly two line movements','balances 10 and 20','explicit missing warehouse fails'],results}));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>db.$disconnect());
