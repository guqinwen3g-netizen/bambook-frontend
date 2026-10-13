import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { createBillingItemCommand, retireBillingItemCreateCommand } from '../billingItemCreateCommand';

// Pure storage delegates only: the production permission, source, numbering,
// BillingItem and mandatory audit helpers run unchanged. This is not evidence
// for PostgreSQL row/advisory locks, isolation, FK rollback or concurrent UAT.
function storage() {
  const scopes = ['invoices:read','invoices:write','invoices:reconcile','pricing:read','sensitive:cost'];
  const rows: Record<string, any[]> = { sample: [{id:'S1',deletedAt:null,customerRelationId:'C1',sourceCaseId:null,sourceOrderId:null,shippingFee:new Prisma.Decimal('12.9999')}],
    relation:[{id:'C1',deletedAt:null,name:'Synthetic customer'}], billingItem:[], auditLog:[], costRecord:[], billingItemCostCoverage:[], invoiceLine:[],
    shipment:[], shipmentOrderAllocation:[], order:[], orderLine:[], developmentCase:[], sampleBatch:[], sealSample:[], quotation:[],
    userAccount:[{id:'finance',status:'active',deletedAt:null,primaryDeptId:null,roles:[{role:{id:'role-finance',permissions:scopes.map(scope=>({permission:{scope}}))},departmentId:null}]}], userPermissionOverrides:[], teamMember:[], teamDataGrant:[] };
  function match(row:any,where:any):boolean {
    if(!where)return true;
    return Object.entries(where).every(([key,value]:any)=>key==='AND'?value.every((part:any)=>match(row,part)):key==='OR'?value.some((part:any)=>match(row,part)):
      value===null?row[key]==null:typeof value==='object'?(value.path?value.path.reduce((current:any,part:string)=>current?.[part],row[key])===value.equals:value.has!==undefined?Array.isArray(row[key])&&row[key].includes(value.has):value.in?value.in.includes(row[key]):value.notIn?!value.notIn.includes(row[key]):value.not!==undefined?row[key]!==value.not:true):row[key]===value);
  }
  const tx:any = { $queryRaw: async()=>[{id:'stored-parent'}], $queryRawUnsafe:async()=>[{id:'stored-parent'}], $executeRaw:async()=>1 };
  for(const [name,data] of Object.entries(rows))tx[name]={findFirst:async({where}:any={})=>data.find(row=>match(row,where))??null,
    findUnique:async({where}:any={})=>data.find(row=>match(row,where))??null,findMany:async({where}:any={})=>data.filter(row=>match(row,where)),
    create:async({data:row}:any)=>{if(data.some(r=>r.id===row.id))throw Error('duplicate storage id');data.push(row);return row;},
    update:async({where,data:update}:any)=>Object.assign(data.find(row=>match(row,where)),update)};
  let sequence=0;
  tx.businessSequence={upsert:async()=>({}),update:async()=>({seq:++sequence}),findUnique:async()=>null};
  const prisma:any={...tx,$transaction:async(fn:any)=>{const before=Object.fromEntries(Object.entries(rows).map(([name,data])=>[name,data.slice()]));try{return await fn(tx);}catch(error){for(const[name,data]of Object.entries(before))rows[name].splice(0,rows[name].length,...data);throw error;}}};
  return {prisma,tx,rows,scopes};
}
const actor:any={userId:'finance',roles:['finance'],permissions:['invoices:read','invoices:write','invoices:reconcile'],authorizationLoaded:true,permissionCeiling:['invoices:read','invoices:write','invoices:reconcile','pricing:read','sensitive:cost']};
const input=()=>({sourceType:'Sample',sourceId:'S1',chargeType:'sample_fee',amount:'12.9999',currency:'USD',notes:'Synthetic fee',requestKey:'create-one'});

describe('ordinary fee creation command — production core with storage delegates',()=>{
  it('a lost response retried with the same request creates only one fee and returns the original creation fact',async()=>{
    const db=storage();const first=await createBillingItemCommand({prisma:db.prisma,actor,input:input()});
    const replay=await createBillingItemCommand({prisma:db.prisma,actor,input:input()});
    expect(first).toMatchObject({ok:true});expect(replay).toMatchObject({ok:true});expect(db.rows.billingItem).toHaveLength(1);
    if(first.ok&&replay.ok)expect(replay.data.billingItem.id).toBe(first.data.billingItem.id);
  });
  it('returns the immutable creation ACK when the actual fee was later cancelled/edited',async()=>{
    const db=storage();const first=await createBillingItemCommand({prisma:db.prisma,actor,input:input()});expect(first.ok).toBe(true);
    Object.assign(db.rows.billingItem[0],{status:'cancelled',amount:new Prisma.Decimal('0'),notes:'Later legitimate edit'});
    const replay=await createBillingItemCommand({prisma:db.prisma,actor,input:input()});
    expect(replay.ok).toBe(true);expect(db.rows.billingItem).toHaveLength(1);
    if(first.ok&&replay.ok){expect(replay.data).toEqual({...first.data,replayed:true});expect(replay.data.billingItem.amount).toBe('12.9999');expect(replay.data.billingItem.status).toBe('draft');}
  });
  it('changed parameters with the same key conflict, while a distinct key remains a distinct decision',async()=>{
    const db=storage();expect((await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).ok).toBe(true);
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:{...input(),notes:'different intent'}})).toMatchObject({ok:false,error:{code:'CONFLICT',status:409}});
    expect(db.rows.billingItem).toHaveLength(1);
    expect((await createBillingItemCommand({prisma:db.prisma,actor,input:{...input(),requestKey:'separate-fee'}})).ok).toBe(true);expect(db.rows.billingItem).toHaveLength(2);
  });
  it.each([null,{...actor,permissionCeiling:[]}])('missing identity / signed empty ceiling creates nothing: %j',async supplied=>{
    const db=storage();expect(await createBillingItemCommand({prisma:db.prisma,actor:supplied,input:input()})).toMatchObject({ok:false,error:{status:supplied?403:401}});
    expect(db.rows.billingItem).toHaveLength(0);expect(db.rows.auditLog).toHaveLength(0);
  });
  it('storage authority revoked while waiting on a source lock is reread; the source is not written',async()=>{
    const db=storage();db.tx.$queryRaw=async(query:any)=>{if(query.strings.join('').includes('FOR UPDATE'))db.rows.userAccount[0].roles[0].role.permissions=[];return [{id:'source'}];};
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).toMatchObject({ok:false,error:{status:403}});
    expect(db.rows.billingItem).toHaveLength(0);expect(db.rows.auditLog).toHaveLength(0);
  });
  it('a real source binding changed after the lock causes a conflict, not a new fee',async()=>{
    const db=storage();db.rows.relation.push({id:'C2',deletedAt:null});db.tx.$queryRaw=async(query:any)=>{if(query.strings.join('').includes('FOR UPDATE'))db.rows.sample[0].customerRelationId='C2';return [{id:'source'}];};
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).toMatchObject({ok:false,error:{code:'CONFLICT',status:409}});expect(db.rows.billingItem).toHaveLength(0);
  });
  it('source read outages are explicit dependency failures and never descriptive orphan sources',async()=>{
    const db=storage();db.tx.sample.findFirst=async()=>{throw Error('SELECT secret_column FROM private_schema');};
    const result=await createBillingItemCommand({prisma:db.prisma,actor,input:input()});expect(result).toMatchObject({ok:false,error:{code:'DEPENDENCY_CHECK_FAILED',status:503}});
    expect(JSON.stringify(result)).not.toContain('secret_column');expect(db.rows.billingItem).toHaveLength(0);
  });
  it('mandatory receipt audit failure rolls back the fee and existing audit; same-key retry can succeed',async()=>{
    const db=storage();const create=db.tx.auditLog.create;db.tx.auditLog.create=async(args:any)=>{if(args.data.action==='billing_item_create_receipt')throw Error('FK secret SQL');return create(args);};
    const failed=await createBillingItemCommand({prisma:db.prisma,actor,input:input()});expect(failed).toMatchObject({ok:false,error:{code:'CREATE_FAILED',status:500}});
    expect(JSON.stringify(failed)).not.toContain('secret SQL');expect(db.rows.billingItem).toHaveLength(0);expect(db.rows.auditLog).toHaveLength(0);
    db.tx.auditLog.create=create;expect((await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).ok).toBe(true);expect(db.rows.billingItem).toHaveLength(1);
  });
  it('a damaged original mandatory audit blocks replay without creating a second fee',async()=>{
    const db=storage();expect((await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).ok).toBe(true);
    db.rows.auditLog.find(row=>row.action==='create_billing_item').detail.after.amount='900';
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).toMatchObject({ok:false,error:{code:'CONFLICT',status:409}});expect(db.rows.billingItem).toHaveLength(1);
  });
  it('a matching permanent fence blocks a late original create; identical retire replays and changed retire conflicts',async()=>{
    const db=storage();const {requestKey,...original}=input();const command={requestKey,input:original,retirementRequestKey:'retire-one',reason:'Correct source after software test'};
    const retired=await retireBillingItemCreateCommand({prisma:db.prisma,actor,input:command});expect(retired).toMatchObject({ok:true,data:{retired:true,replayed:false}});
    expect(db.rows.billingItem).toHaveLength(0);expect(db.rows.auditLog).toHaveLength(1);
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).toMatchObject({ok:false,error:{code:'CONFLICT',status:409}});expect(db.rows.billingItem).toHaveLength(0);
    const replay=await retireBillingItemCreateCommand({prisma:db.prisma,actor,input:command});expect(replay).toMatchObject({ok:true,data:{retired:true,replayed:true}});
    expect(await retireBillingItemCreateCommand({prisma:db.prisma,actor,input:{...command,reason:'different'}})).toMatchObject({ok:false,error:{code:'CONFLICT',status:409}});
    expect(db.rows.auditLog).toHaveLength(1);
  });
  it('retiring a committed creation returns its complete original ACK without any new fee or fence',async()=>{
    const db=storage();const first=await createBillingItemCommand({prisma:db.prisma,actor,input:input()});expect(first.ok).toBe(true);
    const {requestKey,...original}=input();const checked=await retireBillingItemCreateCommand({prisma:db.prisma,actor,input:{requestKey,input:original,retirementRequestKey:'check',reason:'Lost receipt'}});
    expect(checked.ok).toBe(true);if(first.ok&&checked.ok)expect(checked.data).toEqual({...first.data,replayed:true});
    expect(db.rows.billingItem).toHaveLength(1);expect(db.rows.auditLog.filter(row=>row.action==='billing_item_create_retired')).toHaveLength(0);
  });
  it('failed permanent fence audit creates no fact and the original key remains usable',async()=>{
    const db=storage();const write=db.tx.auditLog.create;db.tx.auditLog.create=async()=>{throw Error('real storage failure')};
    const {requestKey,...original}=input();expect(await retireBillingItemCreateCommand({prisma:db.prisma,actor,input:{requestKey,input:original,retirementRequestKey:'retire-one',reason:'Correction'}})).toMatchObject({ok:false,error:{status:500}});
    expect(db.rows.auditLog).toHaveLength(0);db.tx.auditLog.create=write;expect((await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).ok).toBe(true);
  });
  it('explicit zero and a real omitted default remain distinct supported fee decisions',async()=>{
    const db=storage();const omitted=input();delete (omitted as any).amount;
    const first=await createBillingItemCommand({prisma:db.prisma,actor,input:omitted});expect(first).toMatchObject({ok:true,data:{billingItem:{amount:'12.9999'}}});
    const zero=await createBillingItemCommand({prisma:db.prisma,actor,input:{...input(),requestKey:'zero',amount:'0'}});expect(zero).toMatchObject({ok:true,data:{billingItem:{amount:'0',netAmount:'0'}}});
    expect(db.rows.billingItem).toHaveLength(2);
  });
  it('Shipment creation resolves and locks its actual SOA Order/Line parents instead of unclassified scope',async()=>{
    const db=storage();db.rows.order.push({id:'O1',deletedAt:null,customerRelationId:'C1'});db.rows.orderLine.push({id:'L1',orderId:'O1'});
    db.rows.shipment.push({id:'SH1',deletedAt:null,customerRelationId:'C1',orderId:null,freightAmount:new Prisma.Decimal('3.0001')});db.rows.shipmentOrderAllocation.push({id:'SOA1',shipmentId:'SH1',orderId:'O1',orderLineId:'L1'});
    const calls:string[]=[];db.tx.$queryRaw=async(query:any)=>{calls.push(query.strings.join(''));return [{id:'stored'}];};
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:{sourceType:'Shipment',sourceId:'SH1',chargeType:'shipping_fee',requestKey:'shipment-fee'}})).toMatchObject({ok:true,data:{billingItem:{amount:'3.0001',bearerRelationId:'C1'}}});
    expect(calls.findIndex(q=>q.includes('"Order"'))).toBeLessThan(calls.findIndex(q=>q.includes('"Shipment"')));
    db.rows.orderLine[0].orderId='foreign';expect(await createBillingItemCommand({prisma:db.prisma,actor,input:{sourceType:'Shipment',sourceId:'SH1',chargeType:'shipping_fee',requestKey:'foreign'}})).toMatchObject({ok:false});expect(db.rows.billingItem).toHaveLength(1);
  });
  it('a current restricted finance grant checks standalone Sample customer scope and every actual Order parent',async()=>{
    const db=storage();db.rows.userAccount[0].roles[0].role.id='custom-fee-operator';db.rows.relation[0].ownerId='foreign';db.rows.relation[0].salesRepIds=[];
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).toMatchObject({ok:false,error:{status:404}});expect(db.rows.billingItem).toHaveLength(0);
    db.rows.relation[0].ownerId='finance';expect((await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).ok).toBe(true);
    db.rows.relation.push({id:'C2',deletedAt:null,ownerId:'foreign',salesRepIds:[]});db.rows.order.push({id:'O2',deletedAt:null,customerRelationId:'C2'});db.rows.sample[0].sourceOrderId='O2';
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:{...input(),requestKey:'hidden-parent'}})).toMatchObject({ok:false,error:{status:404}});expect(db.rows.billingItem).toHaveLength(1);
  });
  it('fresh actual shared-customer lookup refuses a share revoked at the source lock storage seam',async()=>{
    const db=storage();db.rows.userAccount[0].roles[0].role.id='custom-fee-operator';Object.assign(db.rows.relation[0],{ownerId:'foreign',salesRepIds:[]});
    db.rows.teamMember.push({userId:'finance',teamId:'T1',leftAt:null});db.rows.teamDataGrant.push({teamId:'T1',entityType:'relation',entityId:'C1',revokedAt:null,team:{deletedAt:null}});
    db.tx.$queryRaw=async(query:any)=>{if(query.strings.join('').includes('FOR UPDATE'))db.rows.teamDataGrant[0].revokedAt=new Date();return[{id:'S1'}];};
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).toMatchObject({ok:false,error:{status:404}});expect(db.rows.billingItem).toHaveLength(0);expect(db.rows.auditLog).toHaveLength(0);
  });
  it('the existing actual CostRecord occupancy remains exclusive; its original command still replays',async()=>{
    const db=storage();db.rows.costRecord.push({id:'CR1',deletedAt:null,sourceType:'Sample',sourceId:'S1',amount:new Prisma.Decimal('3.0001'),costType:'shipping',bearerType:'customer',bearerRelationId:'C1'});
    const command={sourceType:'CostRecord',sourceId:'CR1',requestKey:'cost-one'};
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:command})).toMatchObject({ok:true,data:{billingItem:{amount:'3.0001',costRecordId:'CR1'}}});
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:{...command,requestKey:'cost-two'}})).toMatchObject({ok:false,error:{code:'COST_ALREADY_BILLED',status:409}});
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:command})).toMatchObject({ok:true,data:{replayed:true}});expect(db.rows.billingItem).toHaveLength(1);
  });
  it.each(['disabled','deleted'])('a %s actual account cannot write or fence a command',async status=>{
    const db=storage();if(status==='disabled')db.rows.userAccount[0].status='disabled';else db.rows.userAccount[0].deletedAt=BigInt(1);
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).toMatchObject({ok:false,error:{status:401}});expect(db.rows.billingItem).toHaveLength(0);expect(db.rows.auditLog).toHaveLength(0);
  });

  it.each(['amount','waivedAmount','offsetAmount'])('ordinary %s cannot silently round a fifth decimal digit',async field=>{
    const db=storage();expect(await createBillingItemCommand({prisma:db.prisma,actor,input:{...input(),[field]:'1.12345'}})).toMatchObject({ok:false,error:{code:'INVALID_AMOUNT',status:400}});expect(db.rows.billingItem).toHaveLength(0);expect(db.rows.auditLog).toHaveLength(0);
  });
  it('the exact Decimal(18,4) maximum is preserved, while its first out-of-range value is zero-write',async()=>{
    const db=storage();expect(await createBillingItemCommand({prisma:db.prisma,actor,input:{...input(),amount:'100000000000000'}})).toMatchObject({ok:false,error:{code:'INVALID_AMOUNT',status:400}});expect(db.rows.billingItem).toHaveLength(0);
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:{...input(),amount:'99999999999999.9999'}})).toMatchObject({ok:true,data:{billingItem:{amount:'99999999999999.9999'}}});expect(db.rows.billingItem).toHaveLength(1);
  });
  it('invalid locked-source defaults reject new commands but never recalculate a committed original receipt',async()=>{
    const db=storage();const command=input();delete (command as any).amount;const first=await createBillingItemCommand({prisma:db.prisma,actor,input:command});expect(first.ok).toBe(true);
    db.rows.sample[0].shippingFee=new Prisma.Decimal('1.12345');expect(await createBillingItemCommand({prisma:db.prisma,actor,input:{...command,requestKey:'new-invalid-default'}})).toMatchObject({ok:false,error:{code:'INVALID_AMOUNT',status:400}});
    const replay=await createBillingItemCommand({prisma:db.prisma,actor,input:command});expect(replay.ok).toBe(true);if(first.ok&&replay.ok)expect(replay.data).toEqual({...first.data,replayed:true});expect(db.rows.billingItem).toHaveLength(1);
  });

  it.each(['deleted','displaced','corrupt','native-anchor-hash','deleted-receipt-corrupt-actor','native-audit-metadata'])('a %s create receipt/history can neither recreate the fee nor claim retirement',async fault=>{
    const db=storage();expect((await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).ok).toBe(true);
    const receipt=db.rows.auditLog.find(row=>row.action==='billing_item_create_receipt');
    if(fault==='deleted')db.rows.auditLog.splice(db.rows.auditLog.indexOf(receipt),1);
    if(fault==='displaced')receipt.id='displaced-receipt';
    if(fault==='corrupt')receipt.detail.after.commandHash='0'.repeat(64);
    if(fault==='native-anchor-hash')db.rows.auditLog.find(row=>row.action==='create_billing_item').detail.ordinaryCreateRequest.commandHash='0'.repeat(64);
    if(fault==='deleted-receipt-corrupt-actor'){db.rows.auditLog.splice(db.rows.auditLog.indexOf(receipt),1);db.rows.auditLog.find(row=>row.action==='create_billing_item').actorId='foreign-corrupt-actor';}
    if(fault==='native-audit-metadata')db.rows.auditLog.find(row=>row.action==='create_billing_item').ip='changed-actual-audit-metadata';
    const {requestKey,...original}=input();
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).toMatchObject({ok:false,error:{code:'CONFLICT',status:409}});
    expect(await retireBillingItemCreateCommand({prisma:db.prisma,actor,input:{requestKey,input:original,retirementRequestKey:'retire-damaged',reason:'Cannot erase damaged history'}})).toMatchObject({ok:false,error:{code:'CONFLICT',status:409}});
    expect(db.rows.billingItem).toHaveLength(1);expect(db.rows.auditLog.filter(row=>row.action==='billing_item_create_retired')).toHaveLength(0);
  });

});


// v2 controls run the production command/auth/source/audit helpers. Only the
// storage await hooks are substituted; no result implies native PG proof.
function sharedCustomer(db:ReturnType<typeof storage>){
  db.rows.userAccount[0].roles[0].role.id='custom-fee-operator';
  Object.assign(db.rows.relation[0],{ownerId:'foreign',salesRepIds:[]});
  db.rows.teamMember.push({userId:'finance',teamId:'T1',leftAt:null});
  db.rows.teamDataGrant.push({teamId:'T1',entityType:'relation',entityId:'C1',revokedAt:null,team:{deletedAt:null}});
}
function lateAuthorityChange(db:ReturnType<typeof storage>,fault:string){
  if(fault==='disabled')db.rows.userAccount[0].status='disabled';
  else if(fault==='deleted')db.rows.userAccount[0].deletedAt=BigInt(1);
  else if(fault==='shared')db.rows.teamDataGrant[0].revokedAt=new Date();
  else if(fault==='personal-grant')db.rows.userPermissionOverrides[0].isActive=false;
  else if(fault==='unavailable')db.tx.userAccount.findUnique=async()=>{throw Error('stored authority unavailable after receipt');};
  else db.rows.userAccount[0].roles[0].role.permissions=db.rows.userAccount[0].roles[0].role.permissions.filter((row:any)=>row.permission.scope!=='invoices:write');
}
describe('v2 final stored authority and canonical native lock order',()=>{
  it.each(['role-grant','personal-grant','disabled','deleted','shared','unavailable'])('late %s change after receipt insertion rolls back fee, optional cost and all audits',async fault=>{
    const db=storage();
    if(fault==='shared')sharedCustomer(db);
    if(fault==='personal-grant'){
      lateAuthorityChange(db,'role-grant');
      db.rows.userPermissionOverrides.push({userId:'finance',scope:'invoices:write',isActive:true,deletedAt:null,expiresAt:null});
    }
    const create=db.tx.auditLog.create;
    db.tx.auditLog.create=async(args:any)=>{const result=await create(args);if(args.data.action==='billing_item_create_receipt')lateAuthorityChange(db,fault);return result;};
    const result=await createBillingItemCommand({prisma:db.prisma,actor,input:{...input(),registerCost:{costType:'shipping',amount:'5.0001',currency:'USD'}}});
    const status=fault==='shared'?404:fault==='disabled'||fault==='deleted'?401:fault==='unavailable'?503:403;
    expect(result).toMatchObject({ok:false,error:{status}});
    expect(db.rows.billingItem).toHaveLength(0);expect(db.rows.costRecord).toHaveLength(0);expect(db.rows.auditLog).toHaveLength(0);
  });
  it.each(['create-replay','retire-created'])('%s rereads current authority after the original fee/ACK read and preserves committed history on refusal',async operation=>{
    const db=storage();expect((await createBillingItemCommand({prisma:db.prisma,actor,input:input()})).ok).toBe(true);
    const native=db.rows.auditLog.map(row=>row.id),read=db.tx.billingItem.findUnique;
    db.tx.billingItem.findUnique=async(args:any)=>{const result=await read(args);lateAuthorityChange(db,'role-grant');return result;};
    const {requestKey,...original}=input();
    const result=operation==='create-replay'?await createBillingItemCommand({prisma:db.prisma,actor,input:input()}):await retireBillingItemCreateCommand({prisma:db.prisma,actor,input:{requestKey,input:original,retirementRequestKey:'reconcile-late',reason:'Reconcile original fee'}});
    expect(result).toMatchObject({ok:false,error:{status:403}});expect(db.rows.billingItem).toHaveLength(1);expect(db.rows.auditLog.map(row=>row.id)).toEqual(native);
  });
  it.each(['role-grant','shared'])('late %s change after permanent fence insertion rolls back the new fence',async fault=>{
    const db=storage();if(fault==='shared')sharedCustomer(db);
    const create=db.tx.auditLog.create;
    db.tx.auditLog.create=async(args:any)=>{const result=await create(args);if(args.data.action==='billing_item_create_retired')lateAuthorityChange(db,fault);return result;};
    const {requestKey,...original}=input();
    expect(await retireBillingItemCreateCommand({prisma:db.prisma,actor,input:{requestKey,input:original,retirementRequestKey:'retire-final',reason:'Correct source'}})).toMatchObject({ok:false,error:{status:fault==='shared'?404:403}});
    expect(db.rows.billingItem).toHaveLength(0);expect(db.rows.auditLog).toHaveLength(0);
  });
  it('reading an old permanent fence rechecks a grant revoked during its storage await without replacing that fact',async()=>{
    const db=storage(),{requestKey,...original}=input();
    const command={requestKey,input:original,retirementRequestKey:'retire-original',reason:'Correct source'};
    expect(await retireBillingItemCreateCommand({prisma:db.prisma,actor,input:command})).toMatchObject({ok:true,data:{retired:true}});
    const native=db.rows.auditLog[0],read=db.tx.auditLog.findUnique;
    db.tx.auditLog.findUnique=async(args:any)=>{const result=await read(args);if(result?.action==='billing_item_create_retired')lateAuthorityChange(db,'role-grant');return result;};
    expect(await retireBillingItemCreateCommand({prisma:db.prisma,actor,input:command})).toMatchObject({ok:false,error:{status:403}});
    expect(db.rows.auditLog).toEqual([native]);expect(db.rows.billingItem).toHaveLength(0);
  });
  it('a native ship Sample source locks Case then Sample then Order then existing Cost then command key',async()=>{
    const db=storage();Object.assign(db.rows.sample[0],{type:'ship',sourceCaseId:'D1',sourceOrderId:'O1'});
    db.rows.developmentCase.push({id:'D1',deletedAt:null,customerRelationId:'C1'});db.rows.order.push({id:'O1',deletedAt:null,customerRelationId:'C1'});
    db.rows.costRecord.push({id:'CR1',deletedAt:null,sourceType:'Sample',sourceId:'S1',amount:new Prisma.Decimal('5.0001'),costType:'shipping',bearerType:'customer',bearerRelationId:'C1'});
    const calls:string[]=[];db.tx.$queryRaw=async(query:any)=>{calls.push(query.strings.join(''));return[{id:'stored'}];};
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:{...input(),costRecordId:'CR1'}})).toMatchObject({ok:true});
    const first=(table:string)=>calls.findIndex(q=>q.includes('FROM "'+table+'"'));
    expect(first('DevelopmentCase')).toBeLessThan(first('Sample'));expect(first('Sample')).toBeLessThan(first('Order'));expect(first('Order')).toBeLessThan(first('CostRecord'));
    expect(first('CostRecord')).toBeLessThan(calls.findIndex(q=>q.includes('pg_advisory_xact_lock')));
  });
  it.each(['SealSample','SampleBatch'])('native %s sources precede an actual offset Order and Cost/key locks after their Case',async type=>{
    const db=storage();db.rows.developmentCase.push({id:'D1',deletedAt:null,customerRelationId:'C1'});db.rows.order.push({id:'O1',deletedAt:null,customerRelationId:'C1'});
    db.rows[type==='SealSample'?'sealSample':'sampleBatch'].push({id:'SRC1',deletedAt:null,developmentCaseId:'D1',customerRelationId:'C1'});
    const calls:string[]=[];db.tx.$queryRaw=async(query:any)=>{calls.push(query.strings.join(''));return[{id:'stored'}];};
    expect(await createBillingItemCommand({prisma:db.prisma,actor,input:{...input(),sourceType:type,sourceId:'SRC1',offsetOrderId:'O1'}})).toMatchObject({ok:true});
    const first=(table:string)=>calls.findIndex(q=>q.includes('FROM "'+table+'"'));
    expect(first('DevelopmentCase')).toBeLessThan(first(type));expect(first(type)).toBeLessThan(first('Order'));
    expect(first('Order')).toBeLessThan(calls.findIndex(q=>q.includes('pg_advisory_xact_lock')));
  });
});
