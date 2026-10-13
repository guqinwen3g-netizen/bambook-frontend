/** Local-only PostgreSQL receipt integrity verification; keeps isolated AUDIT fixtures. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createProcurementService, type MaterialReceiptInput } from '../src/procurement/procurementService';
const url = new URL(process.env.DATABASE_URL || '');
assert(['localhost','127.0.0.1'].includes(url.hostname) && url.pathname === '/panda_hub_local', 'Only local panda_hub_local allowed');
const db = new PrismaClient();
const tag = `AUDIT-RECEIPTS-0930-${Date.now()}`;
const actor = `${tag}-inactive-buyer`;
const warehouseId = `${tag}-warehouse`;
const service = createProcurementService(db);
const log = (test: string, data: unknown) => console.log(JSON.stringify({test,data}));
async function main() {
  const identity:any[] = await db.$queryRaw`SELECT current_database() AS name, inet_server_addr()::text AS address`;
  assert.equal(identity[0].name,'panda_hub_local');
  // inet_server_addr()::text includes an IPv6 prefix (for example ::1/128).
  assert(['127.0.0.1','::1'].includes(String(identity[0].address).split('/')[0]), 'Database server must report loopback');
  log('database',identity);
  await db.userAccount.create({data:{id:actor,displayName:'隔离收料验收账号',status:'inactive',metadata:{audit:true,tag}}});
  await db.warehouse.create({data:{id:warehouseId,code:warehouseId,name:`${tag} 验收仓`,type:'Other',isActive:true,sortOrder:99999,createdAt:Date.now(),updatedAt:Date.now()}});
  async function po(suffix:string, twoLines=false) {
    const created=await service.createPurchaseOrder({poNumber:`${tag}-${suffix}`,currency:'CNY',orderDate:'2026-09-30',notes:'Isolated local receipt acceptance; never use for production',lines:[{materialCode:`${tag}-fabric`,description:'验收面料',quantity:100,unit:'M',unitPrice:2},...(twoLines?[{materialCode:`${tag}-buttons`,description:'验收纽扣',quantity:10,unit:'PC',unitPrice:1}]:[])]},actor);
    await service.sendPurchaseOrder(created.id,actor);return service.confirmPurchaseOrder(created.id,actor);
  }
  function input(number:string,accepted:number,rejected=0):MaterialReceiptInput {
    return {receiptNumber:`${tag}-${number}`,receivedDate:'2026-09-30',warehouseId,warehouseName:`${tag} 验收仓`,totalReceived:accepted+rejected,totalAccepted:accepted,totalRejected:rejected};
  }
  const mixed=await po('MIXED',true);
  const a=mixed.lines.find(l=>l.unit==='M')!,b=mixed.lines.find(l=>l.unit==='PC')!;
  const firstInput={...input('MIXED-1',120,3),lineReceipts:[{lineId:a.id,accepted:120,rejected:0},{lineId:b.id,accepted:0,rejected:3}]};
  const first=await service.createMaterialReceipt(mixed.id,firstInput,actor);
  const after=await db.purchaseOrder.findUniqueOrThrow({where:{id:mixed.id},include:{lines:true}});
  assert.equal(after.status,'PartiallyReceived');
  assert.equal(after.lines.find(l=>l.id===a.id)?.receivedQuantity.toString(),'120');
  assert.equal(after.lines.find(l=>l.id===b.id)?.receivedQuantity.toString(),'0');
  assert.equal(after.lines.find(l=>l.id===b.id)?.rejectedQuantity.toString(),'3');
  const audit=await db.auditLog.findFirstOrThrow({where:{action:'create_material_receipt',targetId:mixed.id,detail:{path:['after','receiptId'],equals:first.id}}});
  const detail=(audit.detail as any).after;
  assert.deepEqual(detail.lineReceipts.find((l:any)=>l.lineId===b.id),{lineId:b.id,materialCode:`${tag}-buttons`,description:'验收纽扣',unit:'PC',accepted:0,rejected:3});
  const event=await db.agentJob.findUniqueOrThrow({where:{id:`bev_material_received_${first.id}`}});
  assert.equal(event.jobType,'bev:MaterialReceived');
  assert.deepEqual((event.payload as any).payload.stockInLines.map((l:any)=>({lineId:l.lineId,quantity:l.quantity})),[{lineId:a.id,quantity:120}]);
  log('mixed-units-no-cross-line-offset',{poId:mixed.id,status:after.status,rejected:3,receiptId:first.id,outboxId:event.id,outboxStatus:event.status});
  await service.createMaterialReceipt(mixed.id,{...input('MIXED-2',10),lineReceipts:[{lineId:b.id,accepted:10,rejected:0}]},actor);
  assert.equal((await db.purchaseOrder.findUniqueOrThrow({where:{id:mixed.id}})).status,'Received');
  await service.closePurchaseOrder(mixed.id,actor);
  const replay=await service.createMaterialReceipt(mixed.id,firstInput,actor);
  assert.equal(replay.id,first.id);
  await assert.rejects(service.createMaterialReceipt(mixed.id,{...firstInput,notes:'changed'},actor),(e:any)=>e.status===409);
  assert.equal(await db.materialReceipt.count({where:{purchaseOrderId:mixed.id}}),2);
  assert.equal(await db.agentJob.count({where:{id:`bev_material_received_${first.id}`}}),1);
  log('closed-replay',{sameReceiptId:replay.id,changedPayloadRejected:409,receiptCount:2});
  const concurrent=await po('CONCURRENT');
  const concurrentInput=input('SAME-NUMBER',40,2);
  const both=await Promise.allSettled([service.createMaterialReceipt(concurrent.id,concurrentInput,actor),service.createMaterialReceipt(concurrent.id,concurrentInput,actor)]);
  log('simultaneous-results',both.map(r=>r.status==='fulfilled'?{status:r.status,receiptId:r.value.id}:{status:r.status,message:r.reason.message}));
  assert.equal(both.filter(r=>r.status==='fulfilled').length,2,'Identical concurrent requests should both recover the same receipt');
  const receiptIds=both.filter((r):r is PromiseFulfilledResult<any>=>r.status==='fulfilled').map(r=>r.value.id);
  assert.equal(new Set(receiptIds).size,1);
  assert.equal(await db.materialReceipt.count({where:{purchaseOrderId:concurrent.id}}),1);
  const concurrentLines=await db.purchaseLine.findMany({where:{purchaseOrderId:concurrent.id}});
  assert.equal(concurrentLines[0].receivedQuantity.toString(),'40');assert.equal(concurrentLines[0].rejectedQuantity.toString(),'2');
  assert.equal(await db.agentJob.count({where:{id:`bev_material_received_${receiptIds[0]}`}}),1);
  const allReceipts=await db.materialReceipt.findMany({where:{purchaseOrderId:{in:[mixed.id,concurrent.id]}},select:{id:true}});
  const outbox=await db.agentJob.findMany({where:{id:{in:allReceipts.map(r=>`bev_material_received_${r.id}`)}},select:{id:true,status:true}});
  assert.equal(outbox.length,3);
  log('PASS',{tag,actor,actorStatus:'inactive',warehouseId,purchaseOrderIds:[mixed.id,concurrent.id],receiptCount:allReceipts.length,outbox,verified:['mixed units and cross-line shortfall','exact rejected line and audit snapshot','closed same-content replay','changed payload rejected','simultaneous same number one receipt and event','persisted real PostgreSQL outbox']});
}
main().catch(e=>{console.error('FAIL',e);process.exitCode=1;}).finally(()=>db.$disconnect());
