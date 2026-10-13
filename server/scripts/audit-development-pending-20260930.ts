/** Local PostgreSQL rollback and concurrent same-case retry proof; not a role-UI proof. */
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { registerPendingDevelopmentExpense as register, completePendingDevelopmentExpense as complete } from '../src/development/developmentPendingExpenseService';
dotenv.config({ path: '.env.local' }); dotenv.config();
const url = new URL(process.env.DATABASE_URL || '');
assert(['localhost','127.0.0.1'].includes(url.hostname) && url.pathname === '/panda_hub_local' && (!url.port || url.port === '5432'));
const db = new PrismaClient(); const tag = `pending-audit-${Date.now()}`; const rollback = new Error('ROLLBACK_FIXTURE');
async function main() {
  const [identity]: any[] = await db.$queryRaw`SELECT current_database() AS name, inet_server_addr()::text AS address`;
  assert.equal(identity.name, 'panda_hub_local'); assert(['127.0.0.1','::1'].includes(String(identity.address).split('/')[0]));
  const results: any[] = [];
  try {
    await db.$transaction(async tx => {
      await tx.userAccount.create({ data: { id: tag, displayName: '费用隔离验证', status: 'inactive' } });
      const adapter = new Proxy(tx as any, { get(target, key) { if (key === '$transaction') return async (fn: any) => fn(target); return Reflect.get(target, key); } });
      for (const type of ['fabric', 'garment']) {
        const id = `${tag}-${type}`, now = BigInt(Date.now());
        await tx.developmentCase.create({ data: { id, code: id, name: '本地费用验证', type, stage: 'developing', tags: [], createdAt: now, updatedAt: now } });
        const context = { prisma: adapter, actorId: tag,
          authorize: async (inner: any, caseId: string) => { assert.equal(caseId, id); return inner.developmentCase.findUniqueOrThrow({ where: { id } }); },
          authorizeAssignee: async (_inner: any, caseId: string, userId: string) => { assert.equal(caseId,id); assert.equal(userId,tag); },
        };
        const input = { requestKey: 'register', sourceType: 'DevelopmentCase', sourceId: id, costType: 'shipping', description: '快递账单待到', ownerId: tag };
        const pending = await register(context, id, input);
        const retry = await register(context, id, input); assert.equal(retry.id,pending.id);
        assert.equal(await tx.costRecord.count({ where: { sourceId: id } }),0);
        const resolution = { requestKey: 'complete', expectedVersion: 1, outcome: 'resolved' as const, note: '已取得账单', amount: '123.4567', currency: 'CNY', incurredAt: '2026-09-30' };
        const row = await complete(context,id,pending.id,resolution);
        await complete(context,id,pending.id,resolution);
        assert.equal(row.status,'resolved');
        const costs = await tx.costRecord.findMany({ where: { sourceId: id } });
        assert.equal(costs.length,1); assert.equal(costs[0].amount.toFixed(4),'123.4567'); assert.equal(costs[0].bearerType,'internal');
        const cancelled = await register(context,id,{...input,requestKey:'not-incurred'});
        await complete(context,id,cancelled.id,{requestKey:'cancel',expectedVersion:1,outcome:'cancelled',note:'确认未发生费用'});
        assert.equal(await tx.costRecord.count({where:{sourceId:id}}),1);
        results.push({type,unknownCreatesNoCost:true,replayCreatesOneCost:true,exactAmount:costs[0].amount.toFixed(4),cancelPreservesNoCost:true});
      }
      throw rollback;
    }, { timeout: 30000 });
  } catch(e) { if(e!==rollback) throw e; }
  assert.equal(await db.developmentCase.count({where:{id:{startsWith:tag}}}),0);
  assert.equal(await db.developmentPendingExpense.count({where:{developmentCaseId:{startsWith:tag}}}),0);
  assert.equal(await db.costRecord.count({where:{sourceId:{startsWith:tag}}}),0);
  assert.equal(await db.userAccount.count({where:{id:tag}}),0);
  const concurrentTag = `${tag}-concurrent`;
  try {
    await db.userAccount.create({data:{id:concurrentTag,displayName:'本地并发费用验证',status:'inactive'}});
    for (const type of ['fabric','garment']) {
      const id = `${concurrentTag}-${type}`, now = BigInt(Date.now());
      await db.developmentCase.create({data:{id,code:id,name:'本地并发费用验证',type,stage:'developing',tags:[],createdAt:now,updatedAt:now}});
      const context = {prisma:db,actorId:concurrentTag,
        authorize:async(inner:any,caseId:string)=>{assert.equal(caseId,id);return inner.developmentCase.findUniqueOrThrow({where:{id}});},
        authorizeAssignee:async(_inner:any,caseId:string,userId:string)=>{assert.equal(caseId,id);assert.equal(userId,concurrentTag);},
      };
      const input={requestKey:'concurrent-register',sourceType:'DevelopmentCase',sourceId:id,costType:'shipping',description:'并发补账验证',ownerId:concurrentTag};
      const registered=await Promise.all([register(context,id,input),register(context,id,input)]);
      assert.equal(registered[0].id,registered[1].id);
      const resolution={requestKey:'concurrent-resolve',expectedVersion:1,outcome:'resolved' as const,note:'隔离验证账单',amount:'10.0001',currency:'USD',incurredAt:'2026-09-30'};
      const completed=await Promise.all([complete(context,id,registered[0].id,resolution),complete(context,id,registered[0].id,resolution)]);
      assert.equal(completed[0].costRecordId,completed[1].costRecordId);
      assert.equal(await db.costRecord.count({where:{sourceId:id}}),1);
      assert.equal(await db.developmentPendingExpense.count({where:{developmentCaseId:id}}),1);
      results.push({type,concurrentSameKeyCreateAndComplete:true,costCount:1});
    }
  } finally {
    await db.$transaction(async tx=>{
      await tx.developmentPendingExpense.deleteMany({where:{developmentCaseId:{startsWith:concurrentTag}}});
      await tx.costRecord.deleteMany({where:{sourceId:{startsWith:concurrentTag}}});
      await tx.auditLog.deleteMany({where:{actorId:concurrentTag}});
      await tx.developmentCase.deleteMany({where:{id:{startsWith:concurrentTag}}});
      await tx.userAccount.deleteMany({where:{id:concurrentTag}});
    });
  }
  assert.equal(await db.developmentCase.count({where:{id:{startsWith:tag}}}),0);
  assert.equal(await db.costRecord.count({where:{sourceId:{startsWith:tag}}}),0);
  console.log(JSON.stringify({result:'PASS',database:identity.name,results,rollbackVerified:true,concurrentFixturesRemoved:true,permissionProof:false,concurrencyProof:'same-case same-key create and complete only'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>db.$disconnect());
