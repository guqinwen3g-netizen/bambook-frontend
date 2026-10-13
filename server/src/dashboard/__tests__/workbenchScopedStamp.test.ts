import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import { getPersonalWorkbench, WORKBENCH_GROUPS } from '../workbenchService';
import { WorkflowEngine } from '../../workflow/workflowEngine';

/** Readonly row storage seam, not an authority substitute. The real permission,
 * TeamShare, QC, finance, claim and WorkflowEngine policies execute unchanged.
 * Clone each read as a native DB result would: later stored changes cannot mutate
 * a previously returned row. This suite cannot establish PG isolation or cost. */
function clone(value: any): any {
  if (Prisma.Decimal.isDecimal(value)) return new Prisma.Decimal(value.toString());
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clone(v)])) : value;
}
function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key,w]: [string,any])=>{
    if (key==='AND') return (Array.isArray(w)?w:[w]).every(v=>matches(row,v));
    if (key==='OR') return w.some((v:any)=>matches(row,v));
    if (key==='NOT') return !(Array.isArray(w)?w:[w]).some(v=>matches(row,v));
    const value=row?.[key]??null;
    if (w&&typeof w==='object'&&!(w instanceof Date)) {
      if ('path' in w) return w.path.reduce((v:any,k:string)=>v?.[k],value)===w.equals;
      if ('in' in w) return w.in.includes(value);
      if ('notIn' in w) return !w.notIn.includes(value);
      if ('has' in w) return Array.isArray(value)&&value.includes(w.has);
      if ('not' in w) return typeof w.not==='object'&&w.not!==null?!matches({[key]:value},{[key]:w.not}):value!==w.not;
      if ('startsWith' in w) return typeof value==='string'&&value.startsWith(w.startsWith);
      if ('gt' in w) return value>w.gt;
      return matches(value??{},w);
    }
    return value===(w??null);
  });
}
const actor={userId:'me',roles:[] as any[],permissions:[] as string[],departmentIds:[] as string[]};
const allGrants=['products:read','products:write','orders:read','orders:write','invoices:read','invoices:write','shipments:read','quotations:read','quotations:write','qc:read','qc:write','aftersales:read'];
function storage(grants:string[]=allGrants,roleIds=['role-sales-manager','role-qc','role-finance','role-logistics']) {
  const data:Record<string,any[]>={userAccount:[{id:'me',displayName:'Worker',status:'active',deletedAt:null,primaryDeptId:null,roles:roleIds.map(roleId=>({roleId,departmentId:null,role:{id:roleId,name:roleId,permissions:grants.map(scope=>({permission:{scope}}))}}))}],userPermissionOverrides:[],teamMember:[],teamDataGrant:[],department:[],relation:[],fabricSearchTask:[],developmentSampleQualityReview:[],developmentSampleVersion:[],developmentCase:[],developmentLifecycleEvent:[],workAssignment:[],sample:[],sampleBatch:[],sealSample:[],costRecord:[],order:[],orderLine:[],qCAssignment:[],productionStage:[],shipment:[],shipmentOrderAllocation:[],quotation:[],inventoryItem:[],inventoryTransfer:[],invoice:[],invoiceAllocation:[],creditNoteAllocation:[],approvalRequest:[],claimCase:[],workflowInstance:[],workflowDefinition:[],workflowStep:[],auditLog:[],role:[],billingItem:[],userRole:[]};
  const counts:Record<string,number>={}; const calls:{method:string,args:any}[]=[];
  let hook:((method:string,args:any,n:number)=>void)|undefined;
  const writes=vi.fn(()=>{throw Error('Unexpected business write');}); const db:any={};
  const decorate=(row:any,include:any)=>row&&include?.steps?{...row,steps:data.workflowStep.filter(s=>s.instanceId===row.id),definition:data.workflowDefinition.find(d=>d.id===row.definitionId),initiator:data.userAccount.find(u=>u.id===row.initiatedById)}:row??null;
  const read=(key:string,method:string,args:any={})=>{
    const label=key+'.'+method; counts[label]=(counts[label]??0)+1; calls.push({method:label,args:clone(args)});
    let rows=data[key].filter(r=>matches(r,args.where));
    if(args.orderBy){const orders=Array.isArray(args.orderBy)?args.orderBy:[args.orderBy];rows=[...rows].sort((a,b)=>{for(const order of orders)for(const [field,direction] of Object.entries(order)){const c=String(a[field]??'').localeCompare(String(b[field]??''),undefined,{numeric:true});if(c)return direction==='desc'?-c:c;}return 0;});}
    rows=rows.slice(args.skip??0,args.take===undefined?undefined:(args.skip??0)+args.take);
    const project=(r:any)=>{r=decorate(r,args.include);return r&&args.select?Object.fromEntries(Object.entries(args.select).filter(([,v])=>v).map(([k])=>[k,r[k]])):r;};
    const result=clone(method==='count'?rows.length:method==='findMany'?rows.map(project):project(rows[0]));
    hook?.(label,args,counts[label]); return result;
  };
  for(const key of Object.keys(data)) db[key]={findFirst:vi.fn(async(args:any)=>read(key,'findFirst',args)),findUnique:vi.fn(async(args:any)=>read(key,'findUnique',args)),findMany:vi.fn(async(args:any)=>read(key,'findMany',args)),count:vi.fn(async(args:any)=>read(key,'count',args)),create:writes,createMany:writes,update:writes,updateMany:writes,delete:writes,deleteMany:writes,upsert:writes};
  db.$transaction=vi.fn(async(run:any)=>run(db)); db.$queryRaw=writes; db.$executeRaw=writes;
  return {db,data,writes,counts,calls,onRead(fn:typeof hook){hook=fn;}};
}
/** Explicit live appointment, separate from role grants; never global/owner bypass. */
function assignDepartment(s:ReturnType<typeof storage>, attribute:string) {
  const department={id:`dept-${attribute}`,parentId:'company',status:'active',metadata:{businessAttributes:[attribute]}};
  s.data.department.push(department);
  s.data.userAccount[0].primaryDeptId=department.id;
  s.data.userAccount[0].primaryDepartment=department;
}
const customer={id:'c1',ownerId:'me',salesRepIds:[],deletedAt:null};
const development={id:'d1',code:'D-1',name:'Private case',stage:'developing',customerRelationId:'c1',updatedAt:BigInt(12),deletedAt:null,targetDate:null};
function addDevelopment(s:ReturnType<typeof storage>){s.data.relation.push(clone(customer));s.data.developmentCase.push(clone(development));}
const readGroup=async(s:ReturnType<typeof storage>,key:string,extra:any={})=>(await getPersonalWorkbench(s.db,actor,{group:key,...extra})).groups[0];
const failed={status:'failed',items:null,total:null,hasMore:null,nextCursor:null,error:{code:'WORKBENCH_SOURCE_UNAVAILABLE',retryable:true}};
async function nativeWorkflowFixture(){
  const s=storage(['orders:read','orders:write'],['role-sales-manager']);
  assignDepartment(s,'fabric_business');
  const initiator={...clone(s.data.userAccount[0]),id:'initiator',displayName:'Initiator',roles:[{roleId:'role-sales',departmentId:null,role:{id:'role-sales',name:'Sales',permissions:['orders:read','orders:write'].map(scope=>({permission:{scope}}))}}]};
  s.data.userAccount.push(initiator);s.data.relation.push({...clone(customer),salesRepIds:['initiator']});
  s.data.order.push({id:'o1',ownerId:'initiator',customerRelationId:'c1',status:'Pending',quantity:10,currency:'USD',quoteAmount:'100.0000',deletedAt:null});
  s.data.workflowDefinition.push({id:'wf-def',name:'Native review',entityType:'Order',isActive:true,version:1,steps:[{name:'Original step',approverUserId:'me'}]});
  s.db.$queryRaw=async()=>[{id:'o1'}];
  s.db.workflowInstance.create=async({data}:any)=>{const row={...data,createdAt:new Date(),updatedAt:new Date()};s.data.workflowInstance.push(row);for(const step of data.steps.create)s.data.workflowStep.push({...step,instanceId:row.id});return clone({...row,steps:s.data.workflowStep.filter(step=>step.instanceId===row.id),definition:s.data.workflowDefinition[0],initiator});};
  s.db.auditLog.create=async({data}:any)=>{s.data.auditLog.push(clone(data));return clone(data);};
  const created=await new WorkflowEngine(s.db).createInstance({definitionId:'wf-def',entityType:'Order',entityId:'o1',actor:{...actor,userId:'initiator'},clientRequestId:'native-stamp-workflow'});
  s.db.workflowInstance.create=s.writes;s.db.auditLog.create=s.writes;s.db.$queryRaw=s.writes;s.writes.mockClear();
  for(const key of Object.keys(s.counts))delete s.counts[key];s.calls.splice(0);
  return {...s,created};
}
describe('Dashboard full actual-source final verification (storage behavior, not browser/native proof)',()=>{
  it('customer ownership transfer after initial development read is failed, never an old visible page',async()=>{const s=storage(['products:read'],['role-sales']);addDevelopment(s);s.onRead((m,_a,n)=>{if(m==='developmentLifecycleEvent.findMany'&&n===1)s.data.relation[0].ownerId='other';});expect(await readGroup(s,'development')).toMatchObject(failed);expect(s.writes).not.toHaveBeenCalled();});
  it('TeamDataGrant withdrawal changes final L2 even while current roles and scopes stay identical',async()=>{const s=storage(['products:read'],['role-sales']);addDevelopment(s);s.data.relation[0].ownerId='other';s.data.teamMember.push({userId:'me',teamId:'t1',leftAt:null});s.data.teamDataGrant.push({teamId:'t1',entityType:'relation',entityId:'c1',revokedAt:null,team:{deletedAt:null}});s.onRead((m,_a,n)=>{if(m==='developmentLifecycleEvent.findMany'&&n===1)s.data.teamDataGrant[0].revokedAt=BigInt(44);});expect(await readGroup(s,'development')).toMatchObject(failed);});
  it('a redundant share withdrawal still changes the real policy result stamp although the item stays visible',async()=>{const s=storage(['products:read'],['role-sales']);addDevelopment(s);s.data.teamMember.push({userId:'me',teamId:'t1',leftAt:null});s.data.teamDataGrant.push({teamId:'t1',entityType:'relation',entityId:'c1',revokedAt:null,team:{deletedAt:null}});s.onRead((m,_a,n)=>{if(m==='developmentLifecycleEvent.findMany'&&n===1)s.data.teamDataGrant[0].revokedAt=BigInt(44);});expect(await readGroup(s,'development')).toMatchObject(failed);});
  it('the entire unpaginated collection is stamped, including an off-page source version',async()=>{const s=storage(['products:read'],['role-sales']);addDevelopment(s);s.data.developmentCase.push({...development,id:'d2'});s.onRead((m,_a,n)=>{if(m==='developmentLifecycleEvent.findMany'&&n===1)s.data.developmentCase[1].updatedAt=BigInt(13);});expect(await readGroup(s,'development',{limit:1})).toMatchObject(failed);});
  it('a source version change with unchanged text and target is not published as the old item',async()=>{const s=storage(['products:read'],['role-sales']);addDevelopment(s);s.onRead((m,_a,n)=>{if(m==='developmentLifecycleEvent.findMany'&&n===1)s.data.developmentCase[0].updatedAt=BigInt(13);});expect(await readGroup(s,'development')).toMatchObject(failed);});
  it('even an empty projection requires stable actual L2 rather than treating zero as proof',async()=>{const s=storage(['products:read'],['role-sales']);s.data.relation.push(clone(customer));s.onRead((m,_a,n)=>{if(m==='developmentLifecycleEvent.findMany'&&n===1)s.data.relation[0].ownerId='other';});expect(await readGroup(s,'development')).toMatchObject(failed);});
  it('an original assigned expense source moving away loses its old actionable target',async()=>{const s=storage(['products:read'],['role-sales']);addDevelopment(s);s.data.workAssignment.push({id:'wa',userId:'me',title:'Private expense',status:'assigned',deletedAt:null,metadata:{managedBy:'development_cost_closure',kind:'billing_supplement',caseId:'d1'}});s.onRead((m,a,n)=>{if(m==='developmentCase.findFirst'&&a.where.id==='d1'&&n===1)s.data.developmentCase[0].customerRelationId='foreign';});expect(await readGroup(s,'development-expenses')).toMatchObject(failed);});
  it('finance handoff verifies its actual billing source instead of merely retaining an assignment id',async()=>{const s=storage(['invoices:read','invoices:write'],['role-finance']); assignDepartment(s,'finance');addDevelopment(s);s.data.billingItem.push({id:'b1',sourceType:'DevelopmentCase',sourceId:'d1',deletedAt:null});s.data.workAssignment.push({id:'wa',userId:'me',title:'Review',status:'assigned',deletedAt:null,metadata:{managedBy:'development_cost_closure',kind:'finance_review',caseId:'d1',billingItemId:'b1'}});s.onRead((m,_a,n)=>{if(m==='billingItem.findFirst'&&n===1)s.data.billingItem[0].sourceId='foreign-case';});expect(await readGroup(s,'finance-handoffs')).toMatchObject(failed);});
  it('QC final projection honors a real assignment transfer',async()=>{const s=storage(['qc:read'],['custom-qc']);s.data.order.push({id:'o1',deletedAt:null});s.data.qCAssignment.push({id:'a1',qcUserId:'me',orderId:'o1',status:'Assigned',deletedAt:null});s.onRead((m,a)=>{if(m==='qCAssignment.findMany'&&a.where.AND)s.data.qCAssignment[0].qcUserId='other';});expect(await readGroup(s,'qc')).toMatchObject(failed);});
  it('QC assigned-parent disappearance is checked using its genuine source policy',async()=>{const s=storage(['qc:read'],['custom-qc']);s.data.order.push({id:'o1',deletedAt:null});s.data.qCAssignment.push({id:'a1',qcUserId:'me',orderId:'o1',status:'Assigned',deletedAt:null});s.onRead((m,a)=>{if(m==='qCAssignment.findMany'&&a.where.AND)s.data.order[0].deletedAt=BigInt(99);});expect(await readGroup(s,'qc')).toMatchObject(failed);});
  it('approval inbox final check uses the stored reviewer, never a stale review target',async()=>{const s=storage([],['role-sales-manager']);s.data.approvalRequest.push({id:'p1',reviewerId:'me',requesterId:'other',actionType:'order',status:'pending'});s.onRead((m,_a,n)=>{if(m==='approvalRequest.findMany'&&n===1)s.data.approvalRequest[0].reviewerId='other';});expect(await readGroup(s,'approvals')).toMatchObject(failed);});
  it('samples recheck every actual source anchor',async()=>{const s=storage(['products:read','orders:read'],['role-sales']);addDevelopment(s);s.data.sample.push({id:'s1',sourceCaseId:'d1',sourceOrderId:null,customerRelationId:'c1',status:'making',deletedAt:null,code:'SMP1'});s.onRead((m,_a,n)=>{if(m==='sample.findMany'&&n===1)s.data.sample[0].sourceCaseId='foreign-case';});expect(await readGroup(s,'samples')).toMatchObject(failed);});
  it('quotation ownership remains insufficient after actual customer sharing is withdrawn',async()=>{const s=storage(['quotations:read'],['role-sales']);s.data.relation.push(clone(customer));s.data.quotation.push({id:'q1',ownerId:'me',customerRelationId:'c1',status:'Draft',quotationNumber:'Q1',deletedAt:null});s.onRead((m,_a,n)=>{if(m==='quotation.findMany'&&n===1)s.data.relation[0].ownerId='other';});expect(await readGroup(s,'quotations')).toMatchObject(failed);});
  it('orders reread actual fresh parent L2 before returning production risk rows',async()=>{const s=storage(['orders:read'],['role-sales']);s.data.relation.push(clone(customer));s.data.order.push({id:'o1',ownerId:'me',customerRelationId:'c1',deletedAt:null,status:'Confirmed',dueDate:'2000-01-01'});s.onRead((m,_a,n)=>{if(m==='productionStage.findMany'&&n===1)s.data.relation[0].ownerId='other';});expect(await readGroup(s,'orders')).toMatchObject(failed);});
  it('shipments recheck the actual non-primary SOA visibility link',async()=>{const s=storage(['shipments:read'],['role-sales']);s.data.relation.push(clone(customer));s.data.order.push({id:'o1',customerRelationId:'c1',deletedAt:null});s.data.shipment.push({id:'sh1',orderId:'foreign',status:'Booked',shipmentNumber:'SHP1',deletedAt:null});s.data.shipmentOrderAllocation.push({shipmentId:'sh1',orderId:'o1'});s.onRead((m,_a,n)=>{if(m==='shipment.findMany'&&n===1)s.data.shipmentOrderAllocation.splice(0);});expect(await readGroup(s,'shipments')).toMatchObject(failed);});
  it('inventory preserves the original actual parent order scope during final verification',async()=>{const s=storage(['orders:read'],['role-sales']);s.data.relation.push(clone(customer));s.data.order.push({id:'o1',customerRelationId:'c1',deletedAt:null});s.data.inventoryItem.push({id:'stock',orderId:'o1',quantity:new Prisma.Decimal('1'),minStock:new Prisma.Decimal('2'),unit:'M',deletedAt:null});s.onRead((m,_a,n)=>{if(m==='inventoryItem.findMany'&&n===1)s.data.relation[0].ownerId='other';});expect(await readGroup(s,'inventory')).toMatchObject(failed);});
  it('invoice final verification digests exact current allocations and the resulting amount',async()=>{const s=storage(['invoices:read'],['role-finance']);s.data.invoice.push({id:'i1',status:'Issued',amount:new Prisma.Decimal('90071992547409.0003'),currency:'USD',invoiceNumber:'INV1',type:'Receivable',deletedAt:null});s.data.invoiceAllocation.push({invoiceId:'i1',appliedAmount:new Prisma.Decimal('90071992547409.0001')});s.onRead((m,_a,n)=>{if(m==='creditNoteAllocation.findMany'&&n===1)s.data.invoiceAllocation[0].appliedAmount=new Prisma.Decimal('90071992547409.0002');});expect(await readGroup(s,'invoices')).toMatchObject(failed);});
  it('a vanished credit note reader at final verification cannot fabricate a zero application',async()=>{const s=storage(['invoices:read'],['role-finance']);s.data.invoice.push({id:'i1',status:'Issued',amount:new Prisma.Decimal('100.0001'),currency:'USD',invoiceNumber:'INV1',type:'Receivable',deletedAt:null});s.onRead((m,_a,n)=>{if(m==='creditNoteAllocation.findMany'&&n===1)delete s.db.creditNoteAllocation;});expect(await readGroup(s,'invoices')).toMatchObject(failed);});
  it('claim final projection checks its true multi-domain source visibility',async()=>{const s=storage(['aftersales:read'],['role-sales']);s.data.relation.push(clone(customer));s.data.claimCase.push({id:'cl1',caseNumber:'CL1',customerRelationId:'c1',sourceOrderId:null,sourceInvoiceId:null,status:'Open',deletedAt:null});s.onRead((m,_a,n)=>{if(m==='claimCase.findMany'&&n===1)s.data.relation[0].ownerId='other';});expect(await readGroup(s,'claims')).toMatchObject(failed);});
  it('native WorkflowEngine repeats its durable source audit/current-step contract',async()=>{const s=await nativeWorkflowFixture();s.onRead((m,a,n)=>{if(m==='auditLog.findUnique'&&String(a.where.id).startsWith('WFC_')&&n===1)s.data.auditLog.splice(0);});expect(await readGroup(s,'workflow')).toMatchObject(failed);expect(s.writes).not.toHaveBeenCalled();});
  it('unchanged native WorkflowEngine uses its real current step and is actually projected twice',async()=>{const s=await nativeWorkflowFixture();const r=await readGroup(s,'workflow');expect(r).toMatchObject({status:'ready',total:1,items:[{target:{kind:'workflow',instanceId:s.created.id,stepId:s.created.currentStepId}}]});expect(s.counts['workflowInstance.findMany']).toBe(2);expect(s.writes).not.toHaveBeenCalled();});
  it('source failure during final verification is failed/null rather than a ready zero or first-pass page',async()=>{const s=storage(['products:read'],['role-sales']);addDevelopment(s);s.onRead((m,_a,n)=>{if(m==='developmentLifecycleEvent.findMany'&&n===1)s.db.relation.findMany.mockRejectedValue(Error('secret source failure'));});expect(await readGroup(s,'development')).toMatchObject(failed);});
  it('team query compatibility fallback remains unknown during final verification',async()=>{const s=storage(['orders:read'],['role-sales']);s.data.relation.push(clone(customer));s.data.order.push({id:'o1',customerRelationId:'c1',status:'Confirmed',dueDate:'2000-01-01',deletedAt:null});s.onRead((m,_a,n)=>{if(m==='productionStage.findMany'&&n===1)s.db.teamMember.findMany.mockRejectedValue(Error('private scope outage'));});expect(await readGroup(s,'orders')).toMatchObject(failed);});
  it('groups are withheld until late other-group source changes are checked',async()=>{const s=storage(['products:read','quotations:read'],['role-sales']);addDevelopment(s);s.onRead((m,_a,n)=>{if(m==='quotation.findMany'&&n===1)s.data.relation[0].ownerId='other';});const r=await getPersonalWorkbench(s.db,actor);expect(r.groups.find(g=>g.key==='development')).toMatchObject(failed);});
  it('actor/grant withdrawal still rejects the whole response, not merely one failed group',async()=>{const s=storage(['products:read'],['role-sales']);addDevelopment(s);s.onRead((m,_a,n)=>{if(m==='developmentLifecycleEvent.findMany'&&n===1)s.data.userAccount[0].roles[0].role.permissions=[];});await expect(getPersonalWorkbench(s.db,actor,{group:'development'})).rejects.toMatchObject({code:'AUTHORIZATION_UNAVAILABLE'});});
  it('full projection order is canonical across unordered native collection order',async()=>{const s=storage(['products:read'],['role-sales']);addDevelopment(s);s.data.developmentCase.push({...development,id:'d2'});s.onRead((m,_a,n)=>{if(m==='developmentLifecycleEvent.findMany'&&n===1)s.data.developmentCase.reverse();});expect(await readGroup(s,'development',{limit:1})).toMatchObject({status:'ready',total:2,items:[{source:{id:'d1'}}]});});
  it('rolling clocks in actual grant queries are not mistaken for changing policy',async()=>{const s=storage(['products:read'],['role-sales']);addDevelopment(s);const r=await readGroup(s,'development');expect(r).toMatchObject({status:'ready',total:1});const grantReads=s.calls.filter(c=>c.method==='userPermissionOverrides.findMany');expect(grantReads.length).toBeGreaterThanOrEqual(4);expect(grantReads.every(c=>c.args.where.OR[1].expiresAt.gt instanceof Date)).toBe(true);});
  it('actual technical SuperAdmin uses shared hasScope with no invented explicit-grant requirement',async()=>{const s=storage([],['role-super-admin']);expect(await readGroup(s,'invoices')).toMatchObject({status:'ready',total:0});});
  it('signed empty ceiling still denies the genuine technical SuperAdmin shortcut',async()=>{const s=storage([],['role-super-admin']);const r=await getPersonalWorkbench(s.db,{...actor,permissionCeiling:[]},{group:'invoices'});expect(r.groups[0]).toMatchObject({status:'forbidden',items:null,total:null});expect(s.counts['invoice.findMany']).toBeUndefined();});
  it('business manager without a current source grant receives no implicit finance queue',async()=>{const s=storage([],['role-sales-manager']);expect(await readGroup(s,'invoices')).toMatchObject({status:'forbidden',total:null});expect(s.counts['invoice.findMany']).toBeUndefined();});
  it('custom role named owner cannot acquire a technical shortcut',async()=>{const s=storage([],['custom-role']);s.data.userAccount[0].roles[0].role.name='owner';expect(await readGroup(s,'invoices')).toMatchObject({status:'forbidden',total:null});});
  it('all thirteen unchanged groups keep truthful empty totals and each permitted source is read twice',async()=>{const s=storage();const start=performance.now();const r=await getPersonalWorkbench(s.db,actor);const elapsedMs=performance.now()-start;expect(r.groups).toHaveLength(13);expect(r.groups.every(g=>g.status==='ready'&&g.total===0&&g.items?.length===0)).toBe(true);for(const method of ['workAssignment.findMany','qCAssignment.findMany','workflowInstance.findMany','approvalRequest.findMany','developmentLifecycleEvent.findMany','sample.findMany','quotation.findMany','productionStage.findMany','shipment.findMany','inventoryItem.findMany','claimCase.findMany'])expect(s.counts[method]).toBeGreaterThanOrEqual(2);expect(s.writes).not.toHaveBeenCalled();console.info('WORKBENCH_STORAGE_COST',JSON.stringify({groups:WORKBENCH_GROUPS.length,readonlyQueries:s.calls.length,transactions:s.db.$transaction.mock.calls.length,elapsedMs,counts:s.counts,nativeCost:'not measured; root PG follow-up'}));});
});
