/** Explicit local-only additive migration with backup and Prisma journal in the same transaction. */
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
dotenv.config({path:'.env.local'});dotenv.config();
const url=new URL(process.env.DATABASE_URL||'');
assert(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/panda_hub_local'&&(!url.port||url.port==='5432'));
const db=new PrismaClient();
const migration='20260930220000_development_billing_coverage';
async function main(){
 const [identity]:any[]=await db.$queryRaw`SELECT current_database() AS name,inet_server_addr()::text AS address`;
 assert.equal(identity.name,'panda_hub_local');assert(['127.0.0.1','::1'].includes(String(identity.address).split('/')[0]));
 const sql=readFileSync(`prisma/migrations/${migration}/migration.sql`,'utf8');
 const checksum=createHash('sha256').update(sql).digest('hex');
 const journal:any[]=await db.$queryRaw`SELECT checksum,finished_at FROM "_prisma_migrations" WHERE migration_name=${migration} AND rolled_back_at IS NULL`;
 if(journal.length){assert.equal(journal.length,1);assert.equal(journal[0].checksum,checksum);assert(journal[0].finished_at);console.log('Migration already applied; checksum verified');return;}
 const [prior]:any[]=await db.$queryRaw`SELECT to_regclass('public."BillingItemCostCoverage"')::text AS name`;
 assert.equal(prior.name,null,'Unjournaled table exists; inspect before proceeding');
 mkdirSync('/tmp/bambook-audit-0930',{recursive:true});
 const backup=`/tmp/bambook-audit-0930/billing-coverage-before-${Date.now()}.dump`;
 execFileSync('/opt/homebrew/bin/pg_dump',['-h',url.hostname,'-p','5432','-U',decodeURIComponent(url.username),'-d','panda_hub_local','-Fc','-f',backup],{env:{...process.env,PGPASSWORD:decodeURIComponent(url.password)},stdio:['ignore','ignore','pipe']});
 assert(statSync(backup).size>0);
 await db.$transaction(async tx=>{
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await tx.$executeRawUnsafe(statement);
  await tx.$executeRaw`INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES (${randomUUID()},${checksum},NOW(),${migration},NOW(),1)`;
 },{timeout:30000});
 const indexes:any[]=await db.$queryRaw`SELECT indexdef FROM pg_indexes WHERE tablename='BillingItemCostCoverage'`;
 assert(indexes.some(r=>r.indexdef.includes('UNIQUE')&&r.indexdef.includes('releasedAt')&&r.indexdef.includes('IS NULL')));
 const [counts]:any[]=await db.$queryRaw`SELECT (SELECT count(*)::int FROM "BillingItemCostCoverage") AS coverage,(SELECT count(*)::int FROM "BillingItem" WHERE "developmentExpenseReviewId" IS NOT NULL) AS bound`;
 assert.equal(counts.coverage,0);assert.equal(counts.bound,0);
 console.log(JSON.stringify({result:'PASS',database:identity.name,migration,backup,emptyCoverage:true,oldDecisionsUnchanged:true}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>db.$disconnect());
