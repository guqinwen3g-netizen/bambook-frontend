import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { isValidLocalDateKey } from '../shared/localDate';
export async function registerInventoryOwner(db: PrismaClient, id:string, input:any, actorId:string){
 if(!['Owned','Transferred'].includes(input.ownership)||!isValidLocalDateKey(input.date)||!String(input.evidence||'').trim())throw new Error('请填写货权、实际日期和依据');
 const ownerId=input.ownership==='Transferred'?String(input.ownerRelationId||'').trim():null;
 if(input.ownership==='Transferred'&&!ownerId)throw new Error('请选择真实的货权所属组织');
 return db.$transaction(async tx=>{
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InventoryItem" WHERE "id"=${id} FOR UPDATE`);
  const item=await tx.inventoryItem.findUnique({where:{id}});if(!item||item.deletedAt)throw new Error('库存不存在');
  const native=await tx.productionStockReceipt.findFirst({where:{inventoryItemId:id},select:{id:true}});if(native&&item.ownership!==input.ownership)throw new Error('该库存关联受控生产收货，货权变更须先核对原订单与出运凭据');
  if(ownerId){const owner=await tx.relation.findFirst({where:{id:ownerId,isOrganization:true,deletedAt:null}});if(!owner)throw new Error('货权组织不存在');}
  const moving=await tx.inventoryTransfer.count({where:{sourceItemId:id,status:{in:['pending','in_transit']}}});if(moving)throw new Error('该批次正在调拨，请完成或取消调拨后再登记货权');
  if(item.ownership===input.ownership&&item.ownerRelationId===ownerId&&item.ownershipDate===input.date&&item.ownershipEvidence===input.evidence.trim())return item;
  const updated=await tx.inventoryItem.update({where:{id},data:{ownership:input.ownership,ownerRelationId:ownerId,ownershipDate:input.date,ownershipEvidence:input.evidence.trim(),updatedAt:Date.now()}});
  await tx.auditLog.create({data:{id:'alog_'+randomUUID(),actorId,action:'register_inventory_owner',targetType:'InventoryItem',targetId:id,operationType:'update',detail:{before:{ownership:item.ownership,ownerRelationId:item.ownerRelationId},after:{ownership:updated.ownership,ownerRelationId:ownerId,date:input.date,evidence:input.evidence.trim()}}}});return updated;
 });
}
