import dotenv from 'dotenv';dotenv.config({path:'.env.local',override:true});import {PrismaClient} from '@prisma/client';
const db=new PrismaClient();
async function main(){const url=new URL(process.env.DATABASE_URL!);if(url.pathname!=='/panda_hub_dev'||url.hostname!=='localhost')throw Error('WRONG_TARGET');
console.log(JSON.stringify(await db.$queryRaw`SELECT conname, pg_get_constraintdef(oid, true) AS definition FROM pg_catalog.pg_constraint WHERE conrelid = 'public."BillingItem"'::regclass AND contype='c'`));
const cases=await db.developmentCase.findMany({where:{code:{in:['dev-oct08-dev-fabric-12','dev-oct08-dev-garment-12']},deletedAt:null},select:{id:true,code:true}});
for(const c of cases){const batches=await db.sampleBatch.findMany({where:{developmentCaseId:c.id},select:{id:true}});const costs=await db.costRecord.findMany({where:{sourceId:{in:[c.id,...batches.map(b=>b.id)]},deletedAt:null}});const billing=await db.billingItem.findMany({where:{sourceId:c.id,deletedAt:null}});const audits=await db.auditLog.findMany({where:{targetId:{in:[...costs.map(c=>c.id),...billing.map(b=>b.id)]}}});console.log(JSON.stringify({case:c.code,costs,billing,audits},(_,v)=>typeof v==='bigint'?String(v):v));}}
main().finally(()=>db.$disconnect());
