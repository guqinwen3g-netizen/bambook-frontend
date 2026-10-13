/** Actual manual services, canonical Invoice, current authority and source guards.
 * Only storage and post-commit dispatch are explicit seams. The rollback adapter
 * proves callback composition; it does not prove native PG locks or role UAT. */
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../../auth/service';
vi.mock('../../lib/logger', () => ({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}}));
vi.mock('../../events/businessEventBus', () => ({publishBusinessEvent:vi.fn().mockResolvedValue(undefined)}));
import { publishBusinessEvent } from '../../events/businessEventBus';
import { invoiceBillingItem } from '../billingItemService';
import { createSceneInvoice } from '../sceneInvoiceService';
const USER='synthetic-manual-finance';
const SCOPES=['invoices:read','invoices:write','invoices:reconcile','pricing:read','sensitive:cost'];
const actor:TokenPayload={userId:USER,roles:[],permissions:SCOPES,authorizationLoaded:true,departmentIds:[],permissionCeiling:SCOPES};
function clone<T>(value:T):T {
 if(Prisma.Decimal.isDecimal(value))return new Prisma.Decimal(value.toString()) as T;
 if(Array.isArray(value))return value.map(clone) as T;
 if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clone(item)])) as T;
 return value;
}
function matches(row:any,where:any):boolean {
 if(!where)return true;
 return Object.entries(where).every(([key,c]:[string,any])=>{
  if(key==='AND')return (Array.isArray(c)?c:[c]).every((w:any)=>matches(row,w));
  if(key==='OR')return c.some((w:any)=>matches(row,w));
  const value=row[key];
  if(c===null)return value==null;
  if(c && typeof c==='object'){
   if('in' in c && !c.in.includes(value))return false;
   if('notIn' in c && c.notIn.includes(value))return false;
   if('not' in c && value===c.not)return false;
   if('has' in c && !value?.includes(c.has))return false;
   return true;
  }
  return value===c;
 });
}
function storage(options:{faultAudit?:string;faultBackfill?:boolean;revokeOnLock?:boolean;moveSourceOnLock?:boolean;hiddenParent?:boolean;noReceivable?:boolean;selfScope?:boolean;revokeAfterCreate?:boolean}={}) {
 const state:Record<string,any>={
  invoice:[],invoiceLine:[],auditLog:[],invoiceOrderAllocation:[],entityReference:[],entityLink:[],creditLimit:[],
  billingItem:[{id:'BI',itemNo:'BI-native-seam',status:'confirmed',sourceType:'Sample',sourceId:'S',bearerType:'customer',bearerRelationId:'C',amount:'100',waivedAmount:options.noReceivable?'100':'10',offsetAmount:'0',currency:'USD',invoiceId:null,deletedAt:null,updatedAt:BigInt(1)}],
  sample:[{id:'S',code:'S-real-source-seam',sourceCaseId:'D',customerRelationId:'C',invoiceId:null,deletedAt:null}],
  developmentCase:[{id:'D',code:'D-real-parent-seam',customerRelationId:'C',deletedAt:null},{id:'OTHER',code:'OTHER-real-parent-seam',customerRelationId:'C',deletedAt:null}],
  costRecord:[{id:'COST',recordNo:'CR-source',sourceType:'Sample',sourceId:'S',amount:'100',currency:'USD',costType:'shipping',deletedAt:null,createdAt:BigInt(1)}],
  billingItemCostCoverage:[],sampleBatch:[],sealSample:[],order:[],orderLine:[],quotation:[],shipment:[],teamMember:[],teamDataGrant:[],businessSequence:[],workAssignment:[],
  relation:[{id:'C',name:'Synthetic Customer',ownerId:options.hiddenParent?'other':USER,salesRepIds:[],deletedAt:null}],
 };
 const authority={status:'active',scopes:[...SCOPES]};
 const boundary={committed:false,rollbacks:0,locks:[] as string[]};
 const db:any={};
 for(const name of Object.keys(state))db[name]={
  findFirst:vi.fn(async({where}:any={})=>clone(state[name].find((r:any)=>matches(r,where))??null)),
  findUnique:vi.fn(async({where}:any={})=>clone(state[name].find((r:any)=>matches(r,where))??null)),
  findMany:vi.fn(async({where}:any={})=>clone(state[name].filter((r:any)=>matches(r,where)))),
  count:vi.fn(async({where}:any={})=>state[name].filter((r:any)=>matches(r,where)).length),
  create:vi.fn(async({data}:any)=>{
   if(name==='auditLog' && data.action===options.faultAudit)throw Error('private SQL mandatory audit unavailable');
   if(name==='auditLog')JSON.stringify(data.detail);
   state[name].push(clone(data));if(name==='invoice' && options.revokeAfterCreate)authority.scopes=[];return clone(data);
  }),
  createMany:vi.fn(async({data}:any)=>{state[name].push(...clone(data));return {count:data.length};}),
  update:vi.fn(async({where,data}:any)=>{
   if(name==='billingItem' && data.status==='invoiced' && options.faultBackfill)throw Error('private SQL handoff update unavailable');
   const row=state[name].find((r:any)=>matches(r,where));if(!row)throw Error('Synthetic storage target missing');
   Object.assign(row,clone(data));return clone(row);
  }),
  upsert:vi.fn(async({where,create,update}:any)=>{const row=state[name].find((r:any)=>matches(r,where));if(row){Object.assign(row,clone(update));return clone(row);}state[name].push(clone(create));return clone(create);}),
 };
 db.userAccount={findUnique:vi.fn(async({where}:any)=>where.id===USER?{id:USER,status:authority.status,primaryDeptId:null,roles:[{departmentId:null,role:{id:options.selfScope||options.hiddenParent?'synthetic-self-finance':'role-super-admin',permissions:authority.scopes.map(scope=>({permission:{scope}}))}}]}:null),findFirst:vi.fn(async({where}:any)=>where.id===USER&&authority.status==='active'?{id:USER,status:'active'}:null)};
 db.userPermissionOverrides={findMany:vi.fn(async()=>[])};
 db.$queryRaw=vi.fn(async(sql:any)=>{
  const table=/FROM "([A-Za-z]+)"/.exec(sql.strings.join(''))?.[1];
  const id=sql.values[0];boundary.locks.push(`${table}:${id}`);
  if(options.revokeOnLock)authority.scopes=[];
  if(options.moveSourceOnLock && table==='DevelopmentCase')state.sample[0].sourceCaseId='OTHER';
  const model=table?table[0].toLowerCase()+table.slice(1):'';
  return state[model]?.some((row:any)=>row.id===id)?[{id}]:[];
 });
 db.$transaction=vi.fn(async(work:any)=>{
  const before=clone(state);boundary.committed=false;
  try {const result=await work(db);boundary.committed=true;return result;}
  catch(error){Object.assign(state,before);boundary.rollbacks++;throw error;}
 });
 return {db,state,authority,boundary};
}
const invoice=(f:ReturnType<typeof storage>,trustedActor:TokenPayload|null|undefined=actor)=>invoiceBillingItem({prisma:f.db,id:'BI',actorId:USER,trustedActor});
const scene=(f:ReturnType<typeof storage>)=>createSceneInvoice({prisma:f.db,scene:'sample',sourceId:'S',lineIds:['COST'],input:{invoiceNumber:'INV-explicit-synthetic',status:'Issued'},actorId:USER,trustedActor:actor});
beforeEach(()=>vi.clearAllMocks());
describe('Manual invoice transaction composition',()=>{
 it('ordinary billing commits canonical Invoice/Lines, sample projection and all mandatory audits in one outer transaction, then source replay creates nothing',async()=>{
  const f=storage();const result=await invoice(f);expect(result).toMatchObject({ok:true,data:{recovered:false,invoice:{status:'Draft',sourceType:'BillingItem',sourceId:'BI'}}});
  expect(f.db.$transaction).toHaveBeenCalledOnce();expect(f.boundary.committed).toBe(true);
  expect(f.state.invoice).toHaveLength(1);expect(f.state.invoiceLine).toHaveLength(1);expect(f.state.invoice[0].amount.toFixed(4)).toBe('90.0000');
  expect(f.state.billingItem[0].invoiceId).toBe(f.state.invoice[0].id);expect(f.state.sample[0].invoiceId).toBe(f.state.invoice[0].id);
  expect(f.state.auditLog.map((r:any)=>r.action)).toEqual(['create_invoice','invoice_sample_link_backfill','invoice_billing_item_link_backfill']);
  expect(f.boundary.locks.slice(0,3)).toEqual(['DevelopmentCase:D','Sample:S','BillingItem:BI']);
  expect((await invoice(f))).toMatchObject({ok:true,data:{recovered:true}});expect(f.state.invoice).toHaveLength(1);expect(f.state.invoiceLine).toHaveLength(1);expect(f.state.auditLog).toHaveLength(3);
 });
 it.each(['invoice_sample_link_backfill','invoice_billing_item_link_backfill'])('mandatory %s failure rolls back canonical writes and both projections',async action=>{
  const f=storage({faultAudit:action});const result=await invoice(f);
  expect(result).toMatchObject({ok:false,error:{code:'BACKFILL_FAILED',status:500}});expect(JSON.stringify(result)).not.toContain('private SQL');
  expect(f.boundary.rollbacks).toBe(1);expect(f.state.invoice).toHaveLength(0);expect(f.state.invoiceLine).toHaveLength(0);expect(f.state.auditLog).toHaveLength(0);
  expect(f.state.billingItem[0]).toMatchObject({status:'confirmed',invoiceId:null});expect(f.state.sample[0].invoiceId).toBeNull();
 });
 it('backfill storage failure leaves no partial Invoice, lines or canonical audit',async()=>{
  const f=storage({faultBackfill:true});expect(await invoice(f)).toMatchObject({ok:false,error:{code:'BACKFILL_FAILED'}});
  expect(f.state.invoice).toHaveLength(0);expect(f.state.invoiceLine).toHaveLength(0);expect(f.state.auditLog).toHaveLength(0);expect(f.state.billingItem[0].status).toBe('confirmed');
 });
 it('canonical failed Result after its audit fault throws across the outer boundary rather than committing its Invoice/Lines',async()=>{
  const f=storage({faultAudit:'create_invoice'});const result=await invoice(f);expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('private SQL');
  expect(f.boundary.rollbacks).toBe(1);expect(f.state.invoice).toHaveLength(0);expect(f.state.invoiceLine).toHaveLength(0);expect(f.state.billingItem[0].status).toBe('confirmed');
 });
 it('noReceivable mandatory audit failure rolls back only the existing decision projection and creates no Invoice',async()=>{
  const f=storage({noReceivable:true,faultAudit:'invoice_billing_item_no_receivable'});expect(await invoice(f)).toMatchObject({ok:false,error:{code:'NO_RECEIVABLE_FAILED',status:500}});
  expect(f.state.billingItem[0].status).toBe('confirmed');expect(f.state.invoice).toHaveLength(0);expect(f.state.auditLog).toHaveLength(0);
 });
 it('current grants withdrawn while waiting on a parent lock reject before canonical and projection writes',async()=>{
  const f=storage({revokeOnLock:true});expect(await invoice(f)).toMatchObject({ok:false,error:{code:'FORBIDDEN',status:403}});
  expect(f.state.invoice).toHaveLength(0);expect(f.db.invoice.create).not.toHaveBeenCalled();expect(f.state.billingItem[0].status).toBe('confirmed');
 });
 it.each([null,{...actor,permissionCeiling:[]},{...actor,userId:'body-spoof'}])('missing/mismatched identity or signed empty ceiling cannot open the real canonical write (%j)',async supplied=>{
  const f=storage();const result=await invoice(f,supplied);expect(result.ok).toBe(false);expect(f.db.invoice.create).not.toHaveBeenCalled();expect(f.state.auditLog).toHaveLength(0);
 });
 it('internal compatibility with explicit actorId still reloads current DB grants, rather than skipping authority',async()=>{
  const f=storage();f.authority.scopes=[];expect(await invoiceBillingItem({prisma:f.db,id:'BI',actorId:USER})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
  expect(f.db.userAccount.findUnique).toHaveBeenCalled();expect(f.db.invoice.create).not.toHaveBeenCalled();
 });
 it('a guessed hidden parent is denied by the actual original L2 helper before writes',async()=>{
  const f=storage({hiddenParent:true});expect(await invoice(f)).toMatchObject({ok:false,error:{code:'NOT_FOUND',status:404}});expect(f.db.invoice.create).not.toHaveBeenCalled();expect(f.state.auditLog).toHaveLength(0);
 });
 it('a source moved while acquiring its parent locks cannot be consumed through its prior case',async()=>{
  const f=storage({moveSourceOnLock:true});expect(await invoice(f)).toMatchObject({ok:false,error:{code:'CONFLICT',status:409}});expect(f.db.invoice.create).not.toHaveBeenCalled();expect(f.state.billingItem[0].status).toBe('confirmed');
 });
 it('an OrderLine fee reads its actual schema identity and locks the owning Order without inventing shipment allocations',async()=>{
  const f=storage();f.state.billingItem[0].sourceType='OrderLine';f.state.billingItem[0].sourceId='OL';
  f.state.order.push({id:'O',code:'SO-real-source',status:'Confirmed',customerRelationId:'C',deletedAt:null});f.state.orderLine.push({id:'OL',orderId:'O',lineNumber:1});
  expect(await invoice(f)).toMatchObject({ok:true,data:{invoice:{sourceType:'BillingItem',status:'Draft'}}});
  expect(f.db.orderLine.findUnique).toHaveBeenCalledWith({where:{id:'OL'}});expect(f.boundary.locks.slice(0,3)).toEqual(['Order:O','OrderLine:OL','BillingItem:BI']);
  expect(f.state.invoiceOrderAllocation).toHaveLength(0);expect(f.state.invoiceLine).toHaveLength(1);
 });
 it('a production Sample fee locks its real sourceOrderId and preserves the original fee rule for an incurred source',async()=>{
  const f=storage();f.state.sample[0].sourceCaseId=null;f.state.sample[0].sourceOrderId='O';f.state.order.push({id:'O',status:'Cancelled',deletedAt:null});
  expect(await invoice(f)).toMatchObject({ok:true,data:{invoice:{status:'Draft'}}});expect(f.boundary.locks.slice(0,3)).toEqual(['Order:O','Sample:S','BillingItem:BI']);
 });
 it('authority revoked after the canonical create is caught before ACK and rolls back its partial facts',async()=>{
  const f=storage({revokeAfterCreate:true});expect(await invoice(f)).toMatchObject({ok:false,error:{code:'FORBIDDEN',status:403}});
  expect(f.db.invoice.create).toHaveBeenCalledOnce();expect(f.state.invoice).toHaveLength(0);expect(f.state.invoiceLine).toHaveLength(0);expect(f.state.auditLog).toHaveLength(0);
 });
 it('successful Scene dispatch occurs after the real outer commit and uses actual canonical audit identity',async()=>{
  const f=storage();vi.mocked(publishBusinessEvent).mockImplementationOnce(async()=>{expect(f.boundary.committed).toBe(true);});
  expect(await scene(f)).toMatchObject({ok:true,data:{invoice:{status:'Issued'}}});expect(f.db.$transaction).toHaveBeenCalledOnce();
  expect(f.state.invoice).toHaveLength(1);expect(f.state.invoiceLine).toHaveLength(1);expect(f.state.auditLog.map((r:any)=>r.action)).toEqual(['create_invoice','create_scene_invoice']);
  expect(publishBusinessEvent).toHaveBeenCalledWith(expect.objectContaining({sourceEntityId:f.state.invoice[0].id,actorId:USER,transactionId:f.state.auditLog[0].id}));
 });
 it('a post-commit dispatch outage cannot misreport the committed Scene as an invoice failure',async()=>{
  const f=storage();vi.mocked(publishBusinessEvent).mockRejectedValueOnce(Error('synthetic event dispatcher offline'));
  expect(await scene(f)).toMatchObject({ok:true,data:{invoice:{status:'Issued'}}});expect(f.boundary.committed).toBe(true);expect(f.state.invoice).toHaveLength(1);expect(f.state.auditLog).toHaveLength(2);
 });
 it('Scene mandatory audit failure rolls back actual canonical Invoice/Lines and does not dispatch a precommit issued event',async()=>{
  const f=storage({faultAudit:'create_scene_invoice'});expect(await scene(f)).toMatchObject({ok:false,error:{code:'SCENE_INVOICE_CREATE_FAILED',status:500}});
  expect(f.boundary.rollbacks).toBe(1);expect(f.state.invoice).toHaveLength(0);expect(f.state.invoiceLine).toHaveLength(0);expect(f.state.auditLog).toHaveLength(0);expect(publishBusinessEvent).not.toHaveBeenCalled();
 });
});


describe('Manual invoice exact amount and local business date',()=>{
 it.each(['BillingItem','CostRecord'])('high four-place billing net and %s line reach actual canonical storage without Number',async lineSource=>{
  const f=storage();Object.assign(f.state.billingItem[0],{amount:'90071992547409.1234',waivedAmount:'0.0001',offsetAmount:'0.0002'});
  if(lineSource==='CostRecord')f.state.billingItem[0].costRecordId='COST';
  const result=await invoice(f);expect(result.ok).toBe(true);
  expect(f.state.invoice[0].amount.toFixed(4)).toBe('90071992547409.1231');
  expect(f.state.invoiceLine[0].amount.toFixed(4)).toBe('90071992547409.1231');expect(f.state.invoiceLine[0].sourceType).toBe(lineSource);
  expect((result as any).data.billingItem.netAmountExact).toBe('90071992547409.1231');
 });
 it('Scene consumes the exact locked two-row amounts, rather than reconstructing them from numeric candidate DTOs',async()=>{
  const f=storage();f.state.costRecord[0].amount='90071992547409.1234';
  f.state.costRecord.push({...f.state.costRecord[0],id:'COST-2',recordNo:'CR-source-2',amount:'0.8765'});
  const result=await createSceneInvoice({prisma:f.db,scene:'sample',sourceId:'S',lineIds:['COST','COST-2'],input:{invoiceNumber:'INV-exact-sum',status:'Draft'},actorId:USER,trustedActor:actor});
  expect(result.ok).toBe(true);expect(f.state.invoice[0].amount.toFixed(4)).toBe('90071992547409.9999');
  expect(f.state.invoiceLine.map((row:any)=>row.amount.toFixed(4))).toEqual(['90071992547409.1234','0.8765']);
  expect(f.state.auditLog.find((row:any)=>row.action==='create_scene_invoice').detail.after.amount).toBe('90071992547409.9999');
  expect(f.db.costRecord.findMany).toHaveBeenCalledWith({where:{id:{in:['COST','COST-2']},deletedAt:null},orderBy:{id:'asc'}});
  // The existing successful DTO stays display-compatible; it is never the write source.
  expect((result as any).data.lines[0].amount).toBe(Number('90071992547409.1234'));
 });
 it('Scene default issueDate at China midnight uses local business day, retaining an explicitly chosen date',async()=>{
  vi.useFakeTimers({toFake:['Date']});
  try {
   vi.setSystemTime(new Date('2026-10-02T16:30:00.000Z'));
   // The runner deliberately fixes the deployed business timezone for this control.
   expect(new Date().getTimezoneOffset()).toBe(-480);
   const f=storage();expect((await scene(f)).ok).toBe(true);expect(f.state.invoice[0].issueDate).toBe('2026-10-03');
   const explicit=storage();expect((await createSceneInvoice({prisma:explicit.db,scene:'sample',sourceId:'S',lineIds:['COST'],input:{invoiceNumber:'INV-explicit-day',status:'Draft',issueDate:'2026-09-25'},actorId:USER,trustedActor:actor})).ok).toBe(true);
   expect(explicit.state.invoice[0].issueDate).toBe('2026-09-25');
  } finally {vi.useRealTimers();}
 });
});
