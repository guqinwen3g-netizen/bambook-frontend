/** Local-only real PostgreSQL audit. Leaves isolated AUDIT fixtures for inspection. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createProcurementDemandService } from '../src/procurement/procurementDemandService';
const url = new URL(process.env.DATABASE_URL || '');
assert(['localhost','127.0.0.1'].includes(url.hostname) && url.pathname === '/panda_hub_local', 'Only local panda_hub_local allowed');
const db = new PrismaClient();
const tag = `AUDIT-CONCURRENCY-0930-${Date.now()}`;
const actor = `${tag}-buyer`;
const service = createProcurementDemandService(db);
const log = (name:string, data:unknown) => console.log(JSON.stringify({test:name,data}));
async function main() {
  const identity:any[] = await db.$queryRaw`SELECT current_database() AS name, inet_server_addr()::text AS address`;
  assert.equal(identity[0].name,'panda_hub_local'); log('database',identity);
  await db.userAccount.create({data:{id:actor,displayName:actor,status:'inactive',metadata:{audit:true}}});
  await db.order.create({data:{id:tag,poNumber:tag,customer:tag,product:'AUDIT concurrency fabric',type:'FABRIC',quantity:100,status:'Confirmed',dueDate:'2026-12-31',quoteAmount:100,updatedAt:Date.now()}});
  await db.orderLine.create({data:{id:`${tag}-line`,orderId:tag,lineNumber:1,description:'AUDIT fabric',quantity:100,unit:'M'}});
  const supplier=`${tag}-supplier`;
  await db.relation.create({data:{id:supplier,name:supplier,category:'Supplier',type:'Supplier',isOrganization:true,tags:['AUDIT'],contactInfo:'{}',lastInteraction:Date.now()}});
  await db.factoryProfile.create({data:{id:`${tag}-factory`,relationId:supplier,specialties:[],createdAt:Date.now(),updatedAt:Date.now()}});
  async function ready(suffix:string) {
    const created=await service.create({orderId:tag,orderLineId:`${tag}-line`,description:`AUDIT ${suffix}`,unit:'M',requestKey:`${tag}-${suffix}`},actor,null);
    const claimed=await service.claim(created.demand.id,created.demand.revision,actor,null);
    return (await service.confirm(created.demand.id,{revision:claimed.demand.revision,orderLineId:`${tag}-line`,requiredQuantity:'100'},actor,null)).demand;
  }
  const body=(revision:number,key:string,quantity='60')=>({revision,requestKey:`${tag}-${key}`,quantity,unitPrice:'1.25',currency:'CNY',supplierRelationId:supplier});
  for(let round=0;round<3;round++) {
    const demand=await ready(`over-${round}`);
    const inputs=[body(demand.revision,`over-${round}-a`),body(demand.revision,`over-${round}-b`)];
    const results=await Promise.allSettled(inputs.map(input=>service.allocate(demand.id,input,actor,null)));
    log(`concurrent-overallocation-${round}`,results.map(r=>r.status==='fulfilled'?{status:r.status,po:r.value.purchaseOrder?.id}:{status:r.status,code:r.reason.code,message:r.reason.message}));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const allocations=await db.purchaseDemandAllocation.findMany({where:{demandId:demand.id,status:'Active'}});
    assert.equal(allocations.length,1);assert.equal(allocations[0].quantity.toString(),'60');
    const refreshed=await db.procurementDemand.findUniqueOrThrow({where:{id:demand.id}});
    const loser=results.findIndex(r=>r.status==='rejected');
    await assert.rejects(service.allocate(demand.id,{...inputs[loser],revision:refreshed.revision},actor,null),(e:any)=>e.code==='OVER_ALLOCATION');
  }
  const demand=await ready('idempotent');
  const input=body(demand.revision,'same-key','40');
  const simultaneous=await Promise.allSettled([service.allocate(demand.id,input,actor,null),service.allocate(demand.id,input,actor,null)]);
  log('concurrent-same-key',simultaneous.map(r=>r.status==='fulfilled'?{status:r.status,po:r.value.purchaseOrder?.id}:{status:r.status,code:r.reason.code}));
  const retry=await service.allocate(demand.id,input,actor,null);
  const repeat=await service.allocate(demand.id,input,actor,null);
  assert.equal(retry.purchaseOrder?.id,repeat.purchaseOrder?.id);
  const allocations=await db.purchaseDemandAllocation.findMany({where:{demandId:demand.id}});
  assert.equal(allocations.length,1);assert.equal(allocations[0].quantity.toString(),'40');
  const pos=await db.purchaseOrder.findMany({where:{orderId:tag}});
  assert.equal(pos.length,4); // 3 successful competing allocations + 1 idempotent allocation; no orphan PO.
  log('PASS',{tag,orderId:tag,purchaseOrderIds:pos.map(p=>p.id),purchaseOrderCount:pos.length,verified:['three real concurrent oversubscription rounds','fresh-revision oversubscription refused','concurrent same key plus two retries creates one PO','no orphan purchase orders']});
}
main().catch(e=>{console.error('FAIL',e);process.exitCode=1;}).finally(()=>db.$disconnect());
