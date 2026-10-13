import {Prisma} from '@prisma/client';
function reject(code:string,message:string):never {throw Object.assign(new Error(message),{__billingFail:true,code,status:409,httpStatus:409,statusCode:409});}
/** Real Order/OrderLine sources share the order lock with the immutable cost review. */
export async function resolveOrderCostSource(tx:any,sourceType:string,sourceId:string):Promise<string|null>{
 if(sourceType!=='Order'&&sourceType!=='OrderLine')return null;
 const line=sourceType==='OrderLine'?await tx.orderLine.findUnique({where:{id:sourceId},select:{id:true,orderId:true}}):null;
 const orderId=sourceType==='Order'?sourceId:line?.orderId;
 if(!orderId||!await tx.order.findFirst({where:{id:orderId,deletedAt:null},select:{id:true}}))reject('INVALID_COST_SOURCE','费用来源订单或订单行不存在或已删除');
 return orderId;
}
/** Known sources must exist; development returns its existing case ID. */
export async function resolveDevelopmentCostSource(tx:any,sourceType:string,sourceId:string):Promise<string|null>{
 if(sourceType==='Order'||sourceType==='OrderLine'){await resolveOrderCostSource(tx,sourceType,sourceId);return null;}
 const model=({DevelopmentCase:'developmentCase',Sample:'sample',SampleBatch:'sampleBatch',SealSample:'sealSample'} as Record<string,string>)[sourceType];
 if(!model)return null;
 const row=await tx[model].findFirst({where:{id:sourceId,deletedAt:null}});
 if(!row)reject('INVALID_COST_SOURCE','费用来源不存在或已删除');
 return sourceType==='DevelopmentCase'?row.id:sourceType==='Sample'?(row.sourceCaseId??null):(row.developmentCaseId??null);
}
export async function lockDevelopmentCostSource(tx:any,sourceType:string,sourceId:string):Promise<string|null>{
 const orderId=await resolveOrderCostSource(tx,sourceType,sourceId);
 if(orderId){
  const rows=await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} AND "deletedAt" IS NULL FOR UPDATE`);
  if(!rows.length||await resolveOrderCostSource(tx,sourceType,sourceId)!==orderId)reject('COST_SOURCE_CHANGED','费用来源订单已变化，请刷新后重试');
  if(!await tx.order.findFirst({where:{id:orderId,deletedAt:null,status:{not:'Cancelled'}},select:{id:true}}))reject('INVALID_COST_SOURCE','已取消订单不能新增实际费用');
  return null;
 }
 const caseId=await resolveDevelopmentCostSource(tx,sourceType,sourceId);
 if(caseId){
  const rows=await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
  if(!rows.length)reject('INVALID_COST_SOURCE','费用所属开发案不存在或已删除');
 }
 const current=await resolveDevelopmentCostSource(tx,sourceType,sourceId);
 if(current!==caseId)reject('COST_SOURCE_CHANGED','费用来源所属案已变化，请刷新后重试');
 return caseId;
}
