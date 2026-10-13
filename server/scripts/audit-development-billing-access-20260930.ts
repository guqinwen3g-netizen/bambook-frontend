/** Local PostgreSQL authorization adapter proof. Fixtures are always rolled back. */
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import {PrismaClient} from '@prisma/client';
import {developmentBillingReadWhere,assertDevelopmentBillingRouteAccess,assertDevelopmentBillingSourceAccess} from '../src/development/developmentBillingRouteAccess';
import {assertDevelopmentExpenseAccess} from '../src/development/developmentExpenseAccess';
import {listBillingItems,listCostRecords,listCostCandidateRows} from '../src/finance/billingItemService';
dotenv.config({path:'.env.local'});dotenv.config();
const url=new URL(process.env.DATABASE_URL||'');
assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname==='/panda_hub_local'&&(!url.port||url.port==='5432'));
const db=new PrismaClient(),tag=`billing-access-${Date.now()}`,rollback=new Error('AUDIT_ROLLBACK');
async function main(){
 const [identity]:any[]=await db.$queryRaw`SELECT current_database() AS name,inet_server_addr()::text AS address`;
 assert.equal(identity.name,'panda_hub_local');assert(['127.0.0.1','::1'].includes(String(identity.address).split('/')[0]));
 try {await db.$transaction(async tx=>{
  const now=BigInt(Date.now());
  for(const who of ['owner','other']) {
   const userId=`${tag}-${who}`,customerId=`${userId}-customer`,caseId=`${userId}-case`;
   await tx.userAccount.create({data:{id:userId,displayName:'本地范围测试',status:'active'}});
   await tx.relation.create({data:{id:customerId,name:'本地范围客户',category:'customer',type:'company',isOrganization:true,tags:[],contactInfo:'{}',lastInteraction:now,ownerId:userId}});
   await tx.developmentCase.create({data:{id:caseId,code:caseId,name:'本地范围开发案',type:who==='owner'?'fabric':'garment',stage:'approved',customerRelationId:customerId,tags:[],createdAt:now,updatedAt:now}});
   await tx.billingItem.create({data:{id:`${userId}-billing`,itemNo:`${userId}-billing`,sourceType:'DevelopmentCase',sourceId:caseId,chargeType:'development_fee',amount:80,currency:'USD',bearerRelationId:customerId,createdAt:now,updatedAt:now}});
   await tx.sample.create({data:{id:`${userId}-sample`,code:`${userId}-sample`,type:'dev',status:'draft',sourceCaseId:caseId,createdAt:now,updatedAt:now}});
   await tx.sampleBatch.create({data:{id:`${userId}-batch`,batchCode:`${userId}-batch`,developmentCaseId:caseId,supplierRelationId:customerId,sampleType:'lab-dip',createdAt:now,updatedAt:now}});
   await tx.sealSample.create({data:{id:`${userId}-seal`,sealCode:`${userId}-seal`,developmentCaseId:caseId,supplierRelationId:customerId,createdAt:now,updatedAt:now}});
   for(const depth of [0,1]) {
    const costId=`${userId}-cost-${depth}`;
    await tx.costRecord.create({data:{id:costId,recordNo:costId,sourceType:depth?'CostRecord':'Sample',sourceId:depth?`${userId}-cost-0`:`${userId}-sample`,costType:'shipping',amount:3,incurredAt:'2026-09-30',createdAt:now,updatedAt:now}});
    await tx.billingItem.create({data:{id:`${costId}-billing`,itemNo:`${costId}-billing`,sourceType:'CostRecord',sourceId:costId,chargeType:'shipping_fee',amount:3,createdAt:now,updatedAt:now}});
   }
  }
  const userId=`${tag}-owner`;
  for(const scope of ['invoices:read','invoices:write'])await tx.userPermissionOverrides.create({data:{id:`${userId}-${scope}`,userId,scope,grantedBy:userId,reason:'隔离事务测试，必回滚'}});
  const actor:any={userId,roles:['owner'],permissions:['invoices:read','invoices:write'],displayName:'伪造旧全权角色'};
  const where=await developmentBillingReadWhere(tx,actor);
  const listed=await listBillingItems({prisma:tx as any,query:{sourceType:'DevelopmentCase'},accessWhere:where});
  assert(listed.ok);assert.equal(listed.data.total,1);assert.equal(listed.data.billingItems[0].id,`${userId}-billing`);
  await assertDevelopmentBillingRouteAccess(tx,actor,`${userId}-billing`,'write');
  for(const depth of [0,1]) {
   await assertDevelopmentBillingRouteAccess(tx,actor,`${userId}-cost-${depth}-billing`,'write');
   await assert.rejects(()=>assertDevelopmentBillingRouteAccess(tx,actor,`${tag}-other-cost-${depth}-billing`,'write'),(e:any)=>e.status===404);
  }
  await assert.rejects(()=>assertDevelopmentBillingSourceAccess(tx,actor,'Sample',`${tag}-other-sample`,'write'),(e:any)=>e.status===404);
  for(const [type,suffix] of [['SampleBatch','batch'],['SealSample','seal']]){
   await assertDevelopmentBillingSourceAccess(tx,actor,type,`${userId}-${suffix}`,'write');
   await assert.rejects(()=>assertDevelopmentBillingSourceAccess(tx,actor,type,`${tag}-other-${suffix}`,'write'),(e:any)=>e.status===404);
  }
  const costs=await listCostRecords({prisma:tx as any,query:{sourceType:'Sample'},accessWhere:where});
  assert(costs.ok);assert.equal(costs.data.total,1);assert.equal(costs.data.costRecords[0].id,`${userId}-cost-0`);
  const hiddenCandidates=await listCostCandidateRows({prisma:tx as any,query:{caseId:`${tag}-other-case`},accessWhere:where});
  assert(hiddenCandidates.ok);assert.equal(hiddenCandidates.data.total,0);assert.equal(hiddenCandidates.data.rows.length,0);
  for(const mode of ['read','write'] as const)await assert.rejects(()=>assertDevelopmentBillingRouteAccess(tx,actor,`${tag}-other-billing`,mode),(e:any)=>e.status===404);
  await tx.userPermissionOverrides.updateMany({where:{userId,scope:'invoices:write'},data:{isActive:false}});
  await assert.rejects(()=>assertDevelopmentBillingRouteAccess(tx,actor,`${userId}-billing`,'write'),(e:any)=>e.status===403);
  await assertDevelopmentBillingRouteAccess(tx,actor,`${userId}-billing`,'read');
  await tx.userPermissionOverrides.updateMany({where:{userId},data:{isActive:false}});
  await assert.rejects(()=>developmentBillingReadWhere(tx,actor),(e:any)=>e.status===403);
  for(const scope of ['products:read','products:write'])await tx.userPermissionOverrides.create({data:{id:`${userId}-${scope}`,userId,scope,grantedBy:userId,reason:'测试后回滚'}});
  const businessActor={...actor,permissions:['products:read','products:write']};
  await assertDevelopmentExpenseAccess(tx,businessActor,`${userId}-case`,'write');
  await assert.rejects(()=>assertDevelopmentExpenseAccess(tx,businessActor,`${tag}-other-case`,'write'),(e:any)=>e.status===404);
  await tx.userPermissionOverrides.updateMany({where:{userId,scope:'products:write'},data:{isActive:false}});
  await assert.rejects(()=>assertDevelopmentExpenseAccess(tx,businessActor,`${userId}-case`,'write'),(e:any)=>e.status===403);
  await assertDevelopmentExpenseAccess(tx,businessActor,`${userId}-case`,'read');
  await tx.userAccount.update({where:{id:userId},data:{status:'inactive'}});
  await assert.rejects(()=>assertDevelopmentExpenseAccess(tx,businessActor,`${userId}-case`,'read'),(e:any)=>e.status===403);
  throw rollback;
 },{maxWait:10000,timeout:20000});}catch(error){if(error!==rollback)throw error;}
 assert.equal(await db.userAccount.count({where:{id:{startsWith:tag}}}),0);
 console.log(JSON.stringify({result:'PASS',database:identity.name,listAndCountScoped:true,foreignCaseReadWriteDenied:true,sampleBatchSealAndNestedCostScope:true,hiddenCostCandidatesExcluded:true,staleAdminTokenIgnored:true,revokedWriteDenied:true,revokedReadDenied:true,businessRevokedWriteDenied:true,inactiveBusinessAccountDenied:true,fixturesRolledBack:true,browserProof:false}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.$disconnect());
