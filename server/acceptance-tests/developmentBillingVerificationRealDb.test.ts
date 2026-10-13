/** Real financial segment on stopped synthetic development cases. Both source types,
 * current DB grants/session ceiling, native locks/audit rollback, and receivable
 * creation are covered. This fixture does not qualify sample production or UI. */
import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {PrismaClient,Prisma} from '@prisma/client';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {createCostRecordInTx,invoiceBillingItem} from '../src/finance/billingItemService';
import {previewDevelopmentClosure,recordDevelopmentLifecycle,previewDevelopmentExpenseReview,confirmDevelopmentExpenseReview} from '../src/development/developmentClosureService';
import {createDevelopmentBillingDraft} from '../src/development/developmentBillingDraftService';
import {transitionDevelopmentBilling,developmentBillingReviewTaskId} from '../src/development/developmentBillingWorkflowService';
import {assertDevelopmentExpenseAccess,assertDevelopmentFinanceRecipient,assertDevelopmentFinanceWriteAccess} from '../src/development/developmentExpenseAccess';
import {buildLoadedAuthTokenPayload,loadUserWithRoles} from '../src/auth/tokenHelpers';
import {developmentFinanceTaskId} from '../src/development/developmentFinanceTask';
let prisma:PrismaClient;
beforeAll(async()=>{
 const {DATABASE_URL,sandbox=process.env.BAMBOOK_ACCEPTANCE_SANDBOX}=process.env;
 const name=process.env.BAMBOOK_ACCEPTANCE_DB_NAME,directory=process.env.BAMBOOK_ACCEPTANCE_DB_DIR,port=process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
 if(!DATABASE_URL||!sandbox||!name||!directory||!port)throw Error('Reviewed private acceptance PG required');
 const url=new URL(DATABASE_URL);expect(url.protocol).toBe('postgresql:');expect(['localhost','127.0.0.1']).toContain(url.hostname);expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);expect(url.pathname).toBe('/'+name);expect(url.port).toBe(port);
 expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox),'postgres'));expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
 prisma=new PrismaClient({datasources:{db:{url:DATABASE_URL}}});
 expect(await prisma.$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`).toEqual([{name,directory,port:Number(port)}]);
});
afterAll(async()=>{await prisma?.$disconnect();});
async function fixture(type='garment',waivedAmount='0',amount='80.0001'){
 const id='acceptance-billing-verify-'+randomUUID(),salesId=id+'-sales',financeId=id+'-finance';
 for(const [userId,scopes] of [[salesId,['products:read','products:write']],[financeId,['invoices:read','invoices:write']]] as const){
  await prisma.userAccount.create({data:{id:userId,displayName:'Synthetic '+userId.split('-').at(-1),status:'active'}});
  for(const scope of scopes)await prisma.userPermissionOverrides.create({data:{id:randomUUID(),userId,scope,grantedBy:salesId,isActive:true,reason:'Explicit private acceptance scope'}});
 }
 const customerId=id+'-customer';
 await prisma.relation.create({data:{id:customerId,name:'Private development billing customer',category:'customer',type:'company',isOrganization:true,ownerId:salesId,salesRepIds:[financeId],tags:[],contactInfo:'{}',lastInteraction:BigInt(Date.now())}});
 await prisma.developmentCase.create({data:{id,code:id,name:'Private stopped development financial segment',type,stage:'developing',customerRelationId:customerId,tags:[],createdAt:BigInt(Date.now()),updatedAt:BigInt(Date.now())}});
 const sales=await buildLoadedAuthTokenPayload(prisma,await loadUserWithRoles(prisma,salesId));
 const finance=await buildLoadedAuthTokenPayload(prisma,await loadUserWithRoles(prisma,financeId));
 finance.permissionCeiling=['invoices:read','invoices:write'];
 const business={prisma,actorId:salesId,authorize:(tx:any,caseId:string)=>assertDevelopmentExpenseAccess(tx,sales,caseId,'write')};
 const context=(actor=finance)=>({prisma,actorId:actor.userId,authorizeBusiness:(tx:any,caseId:string)=>assertDevelopmentExpenseAccess(tx,actor,caseId,'write'),authorizeFinance:(tx:any,caseId:string)=>assertDevelopmentFinanceWriteAccess(tx,actor,caseId),authorizeRecipient:assertDevelopmentFinanceRecipient});
 await prisma.$transaction(tx=>createCostRecordInTx(tx,{actorId:salesId,input:{sourceType:'DevelopmentCase',sourceId:id,costType:'testing',amount:'17.2501',currency:'USD',incurredAt:'2026-10-01',notes:'Synthetic stopped-case test cost, no customer payment'}}));
 const close=await previewDevelopmentClosure(business,id);
 await recordDevelopmentLifecycle(business,id,{action:'close',outcome:'stopped',reason:'Explicit synthetic development stopped; cost still requires actual billing',disposition:'Finance handles the independent customer charge',expectedRevision:close.revision,expectedFingerprint:close.fingerprint,requestKey:'close'});
 const preview=await previewDevelopmentExpenseReview(business,id);
 const review=await confirmDevelopmentExpenseReview(business,id,{expectedFingerprint:preview.fingerprint,requestKey:'review',note:'One exact synthetic cost received and checked'});
 const draft=await createDevelopmentBillingDraft(business,id,{requestKey:'draft',amount,waivedAmount,currency:'USD',note:'Independent customer charge; actual cost remains USD17.2501'});
 await transitionDevelopmentBilling({...context(sales)},id,draft.billingItem.id,{action:'submit',requestKey:'submit',expectedVersion:0,note:'Financial source checked',reviewId:review.id,userId:financeId});
 const command={action:'verify' as const,requestKey:'verify',expectedVersion:1,note:'Actual source, customer charge and expense evidence agree'};
 return {id,salesId,financeId,sales,finance,customerId,review,billId:draft.billingItem.id,context,command};
}
async function unchanged(f:Awaited<ReturnType<typeof fixture>>){
 expect(await prisma.billingItem.findUniqueOrThrow({where:{id:f.billId}})).toMatchObject({status:'draft',developmentWorkflowState:'submitted',developmentWorkflowVersion:1});
 expect(await prisma.developmentBillingWorkflowEvent.count({where:{billingItemId:f.billId,action:'verify'}})).toBe(0);
 expect(await prisma.workAssignment.findUnique({where:{id:developmentFinanceTaskId(f.billId)}})).toBeNull();
 expect((await prisma.workAssignment.findUniqueOrThrow({where:{id:developmentBillingReviewTaskId(f.billId,1)}})).status).toBe('assigned');
}
describe('Development billing verification in actual PostgreSQL',()=>{
 it.each(['fabric','garment'])('%s: concurrent verification commits once, preserves cost and produces one real receivable',async type=>{
  const f=await fixture(type);expect(await prisma.invoice.count({where:{sourceId:f.billId}})).toBe(0);
  const results=await Promise.all([transitionDevelopmentBilling(f.context(),f.id,f.billId,f.command),transitionDevelopmentBilling(f.context(),f.id,f.billId,f.command)]);
  expect(results.filter(r=>r.recovered)).toHaveLength(1);
  const row=await prisma.billingItem.findUniqueOrThrow({where:{id:f.billId}});
  expect(row).toMatchObject({status:'confirmed',developmentWorkflowState:'ready',developmentWorkflowVersion:2,confirmedBy:f.financeId});
  expect(row.amount.toString()).toBe('80.0001');expect(row.waivedAmount.toString()).toBe('0');expect(row.offsetAmount.toString()).toBe('0');
  expect(await prisma.developmentBillingWorkflowEvent.count({where:{billingItemId:f.billId,action:'verify'}})).toBe(1);
  expect((await prisma.workAssignment.findUniqueOrThrow({where:{id:developmentBillingReviewTaskId(f.billId,1)}})).metadata).toMatchObject({result:{outcome:'verified',actorId:f.financeId,version:2}});
  expect(await prisma.workAssignment.findUniqueOrThrow({where:{id:developmentFinanceTaskId(f.billId)}})).toMatchObject({status:'assigned',userId:f.financeId});
  expect(await prisma.invoice.count({where:{sourceId:f.billId}})).toBe(0);
  await expect(transitionDevelopmentBilling(f.context(),f.id,f.billId,{...f.command,note:'Changed original command'})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
  const billed=await invoiceBillingItem({prisma,id:f.billId,actorId:f.financeId});expect(billed.ok).toBe(true);if(!billed.ok)throw Error('Native receivable creation refused');
  expect(billed.data.invoice.amount.toString()).toBe('80.0001');expect(billed.data.invoice.type).toBe('Receivable');
  const retried=await invoiceBillingItem({prisma,id:f.billId,actorId:f.financeId});expect(retried.ok).toBe(true);if(!retried.ok)throw Error('Native invoice recovery refused');expect(retried.data.invoice.id).toBe(billed.data.invoice.id);
  const verifyRecovery=await transitionDevelopmentBilling(f.context(),f.id,f.billId,f.command);
  expect(verifyRecovery.recovered).toBe(true);expect(verifyRecovery.billingItem.status).toBe('invoiced');expect(verifyRecovery.assignment.status).toBe('completed');
  expect(verifyRecovery.event.snapshot).toMatchObject({after:{state:'ready',version:2,status:'confirmed',confirmedBy:f.financeId},financeTaskId:developmentFinanceTaskId(f.billId)});
  expect((await prisma.workAssignment.findUniqueOrThrow({where:{id:developmentFinanceTaskId(f.billId)}})).status).toBe('completed');
  const cost=await prisma.costRecord.findFirstOrThrow({where:{sourceType:'DevelopmentCase',sourceId:f.id}});expect(cost.amount.toString()).toBe('17.2501');
 });
 it('denies business, wrong assignee, revoked DB grants, and expansion beyond the signed session ceiling',async()=>{
  const f=await fixture();
  await expect(transitionDevelopmentBilling(f.context(f.sales),f.id,f.billId,f.command)).rejects.toMatchObject({code:'FORBIDDEN',status:403});
  await expect(transitionDevelopmentBilling(f.context({...f.finance,permissionCeiling:['invoices:read']}),f.id,f.billId,f.command)).rejects.toMatchObject({code:'FORBIDDEN',status:403});
  await prisma.billingItem.update({where:{id:f.billId},data:{developmentAssigneeId:f.salesId}});
  await expect(transitionDevelopmentBilling(f.context(),f.id,f.billId,f.command)).rejects.toMatchObject({code:'FORBIDDEN',status:403});
  await prisma.billingItem.update({where:{id:f.billId},data:{developmentAssigneeId:f.financeId}});
  await prisma.userPermissionOverrides.updateMany({where:{userId:f.financeId,scope:'invoices:write'},data:{isActive:false}});
  await expect(transitionDevelopmentBilling(f.context(),f.id,f.billId,f.command)).rejects.toMatchObject({code:'FORBIDDEN',status:403});
  await unchanged(f);
 });
 it('refuses stale versions, changed task snapshots, and stale actual cost evidence without confirming',async()=>{
  const f=await fixture();
  await expect(transitionDevelopmentBilling(f.context(),f.id,f.billId,{...f.command,expectedVersion:0})).rejects.toMatchObject({code:'BILLING_CHANGED'});
  const taskId=developmentBillingReviewTaskId(f.billId,1),task=await prisma.workAssignment.findUniqueOrThrow({where:{id:taskId}}),metadata=task.metadata as any;
  await prisma.workAssignment.update({where:{id:taskId},data:{metadata:{...metadata,decision:{...metadata.decision,amount:'90'}}}});
  await expect(transitionDevelopmentBilling(f.context(),f.id,f.billId,f.command)).rejects.toMatchObject({code:'TASK_CHANGED'});
  await prisma.workAssignment.update({where:{id:taskId},data:{metadata}});
  await prisma.$transaction(tx=>createCostRecordInTx(tx,{actorId:f.salesId,input:{sourceType:'DevelopmentCase',sourceId:f.id,costType:'testing',amount:'1',currency:'USD',incurredAt:'2026-10-01'}}));
  await expect(transitionDevelopmentBilling(f.context(),f.id,f.billId,f.command)).rejects.toMatchObject({code:'REVIEW_STALE'});
  await unchanged(f);
 });
 it.each([{amount:'80.0001',waived:'10'},{amount:'0',waived:'0'}])('invoice scope and caller approval fields cannot approve a waiver or zero charge %o',async({amount,waived})=>{
  const f=await fixture('garment',waived,amount);
  await expect(transitionDevelopmentBilling(f.context(),f.id,f.billId,{...f.command,skipApproval:true,approvalId:'fake',waiverApproved:true} as any)).rejects.toMatchObject({code:'INVALID_STATE'});
  await unchanged(f);expect((await prisma.billingItem.findUniqueOrThrow({where:{id:f.billId}})).waivedAmount.toString()).toBe(waived);
 });
 it('a real mandatory audit outage rolls back ready/confirmation/tasks/event together and the same key can recover',async()=>{
  const f=await fixture(),suffix=randomUUID().replaceAll('-',''),fn='acceptance_verify_audit_'+suffix;
  await prisma.$executeRawUnsafe(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='development_billing_verify' AND NEW."targetId"='${f.billId}' THEN RAISE EXCEPTION 'synthetic verification audit outage'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
  try{await expect(transitionDevelopmentBilling(f.context(),f.id,f.billId,f.command)).rejects.toThrow();await unchanged(f);}
  finally{await prisma.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "AuditLog"`);await prisma.$executeRawUnsafe(`DROP FUNCTION public.${fn}()`);}
  const retried=await transitionDevelopmentBilling(f.context(),f.id,f.billId,f.command);expect(retried.billingItem.status).toBe('confirmed');expect(retried.recovered).toBe(false);
 });
});
