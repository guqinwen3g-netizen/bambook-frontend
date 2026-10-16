import {describe,it,expect} from 'vitest';
import {seedIssuedClaimSource,testClaimNumberConsumer} from './mistClaimTestFixtures';
import {applyMistCommand,createMistState,type MistContext,type MistState} from './mistWorkspace';
import {calculatePlatformBom,calculatePlatformPricing,platformBusinessDate,getPlatformReviews,platformCommandPermission,platformCreditRemaining,type PlatformCommand} from './mistPlatform';
function fixture(){let i=0;const c:MistContext={id:()=>`platform-${++i}`,now:'2026-10-13T08:00:00.000Z',actorName:'业务员',actorId:'sales',consumeBusinessNumber:testClaimNumberConsumer('2026-10-13T08:00:00.000Z'),authority:{supplier:{},claimReviewerId:'leader',orderReviewerIds:{garment:['leader'],fabric:['leader']}}};let state=createMistState(c,'empty');state.customers.push({id:'customer',name:'真实客户',code:'C1',country:'CN',city:'',industry:'',owner:'业务员',grade:'A',currency:'USD',terms:'',incoterm:'FOB',categories:'',creditLimit:1000,since:'2026-01-01'});state=applyMistCommand(state,{type:'order.create',payload:{type:'garment',customerId:'customer',season:'AW',currency:'USD',due:'2026-11-10',owner:'业务员',lines:[{name:'成衣',style:'A',img:'coat',qty:10,unit:'件',price:10}]}},c).state;return{c,state,orderId:state.orders[0].id};}
const run=(state:MistState,command:PlatformCommand,c:MistContext)=>applyMistCommand(state,command,c);
function orderApprovalFixture(status:'draft'|'pending'|'approved'='approved'){
 const f=fixture();f.state.files.push({id:'written-po',name:'po.pdf',mimeType:'application/pdf',size:4,storageKey:'workspace/written-po',createdAt:f.c.now});
 let state=applyMistCommand(f.state,{type:'order.governance.saveDraft',payload:{orderId:f.orderId,input:{kind:'external',poNumber:'PLATFORM-PO',confirmationFileIds:['written-po'],internalPurpose:'',receiver:'',paymentMethod:'TT',depositPercent:30,paymentNote:'T/T 30/70',incoterm:'FOB',deliveryPlace:'上海'}}},f.c).state;
 if(status!=='draft')state=applyMistCommand(state,{type:'order.governance.submit',payload:{orderId:f.orderId}},f.c).state;
 if(status==='approved')state=applyMistCommand(state,{type:'order.governance.decide',payload:{id:f.orderId,decision:'approved',note:'核对PO与全部条目'}},{...f.c,actorId:'leader',actorName:'授权负责人'}).state;
 return{...f,state};
}
function invoiceFixture(){const f=orderApprovalFixture();let r=run(f.state,{type:'platform.invoice.save',payload:{orderId:f.orderId,due:'2026-11-11',amount:100,note:''}},f.c);r=run(r.state,{type:'platform.invoice.issue',payload:{id:r.result.id!}},f.c);seedIssuedClaimSource(r.state,r.result.invoiceId as string);const prepared=applyMistCommand(r.state,{type:'fulfillment.claimInventory.warehouse.save',payload:{code:'WAREHOUSE',name:'真实退回仓',address:'上海退回现场',active:true}},f.c);return{...f,state:prepared.state,invoiceId:r.result.invoiceId as string,warehouseId:prepared.result.id!};}
describe('platform order invoice issuance governance',()=>{
 it.each(['draft','pending'] as const)('permits preparation but atomically refuses issuing against a %s order',status=>{
  const f=orderApprovalFixture(status);
  const prepared=run(f.state,{type:'platform.invoice.save',payload:{orderId:f.orderId,due:'2026-11-11',amount:100,note:'预备票据'}},f.c);
  const before=structuredClone(prepared.state);
  expect(prepared.state.platform.invoiceDrafts[0].state).toBe('Draft');
  expect(()=>run(prepared.state,{type:'platform.invoice.issue',payload:{id:prepared.result.id!}},f.c)).toThrow(/主单尚未批准/);
  expect(prepared.state).toEqual(before);expect(prepared.state.invoices).toEqual([]);
 });
 it('refuses a historical order without a verified main approval',()=>{
  const f=fixture();delete f.state.orders[0].governance;
  const prepared=run(f.state,{type:'platform.invoice.save',payload:{orderId:f.orderId,due:'2026-11-11',amount:100,note:'历史订单票据草稿'}},f.c);
  expect(()=>run(prepared.state,{type:'platform.invoice.issue',payload:{id:prepared.result.id!}},f.c)).toThrow(/主单尚未批准/);
  expect(prepared.state.platform.invoiceDrafts[0].state).toBe('Draft');expect(prepared.state.invoices).toEqual([]);
 });
 it('refuses stale approved commercial facts without creating AR or consuming the invoice draft',()=>{
  const f=orderApprovalFixture();f.state.orderLines[0].price=11;
  const prepared=run(f.state,{type:'platform.invoice.save',payload:{orderId:f.orderId,due:'2026-11-11',amount:100,note:'已批准来源但商业事实过期'}},f.c);
  const before=structuredClone(prepared.state);
  expect(()=>run(prepared.state,{type:'platform.invoice.issue',payload:{id:prepared.result.id!}},f.c)).toThrow(/批准快照不一致/);
  expect(prepared.state).toEqual(before);expect(prepared.state.platform.invoiceDrafts[0].invoiceId).toBeUndefined();
 });
 it('issues AR for the canonically approved order exactly once, preserving actual currency and invoice due',()=>{
  const f=orderApprovalFixture();const prepared=run(f.state,{type:'platform.invoice.save',payload:{orderId:f.orderId,due:'2026-11-11',amount:100,note:'真实批准合同票据'}},f.c);
  const issued=run(prepared.state,{type:'platform.invoice.issue',payload:{id:prepared.result.id!}},f.c);
  expect(issued.state.invoices).toHaveLength(1);expect(issued.state.invoices[0]).toMatchObject({orderId:f.orderId,amount:100,open:100,currency:'USD',due:'2026-11-11'});
  expect(issued.state.platform.invoiceDrafts[0]).toMatchObject({state:'Issued',invoiceId:issued.result.invoiceId});
  expect(()=>run(issued.state,{type:'platform.invoice.issue',payload:{id:prepared.result.id!}},f.c)).toThrow(/重复/);
  expect(issued.state.invoices).toHaveLength(1);expect(issued.state.receipts).toEqual([]);
 });
});

describe('case fact files and frozen review evidence',()=>{
 function evidenceFixture(){
  const f=invoiceFixture();f.state.files.push({id:'refund-proof',name:'refund-proof.pdf',mimeType:'application/pdf',size:8,storageKey:'fixture/refund-proof',createdAt:f.c.now},{id:'later-proof',name:'later-proof.pdf',mimeType:'application/pdf',size:8,storageKey:'fixture/later-proof',createdAt:f.c.now});
  const created=run(f.state,{type:'platform.claim.create',payload:{orderId:f.orderId,invoiceId:f.invoiceId,problem:'实物退货事实',fileIds:['written-po']}},f.c);
  return{...f,state:created.state,claimId:created.result.id!};
 }
 it('appends existing workspace files once, preserves the old facts and records only actual additions',()=>{
  const f=evidenceFixture(),command:PlatformCommand={type:'platform.claim.attachFiles',payload:{id:f.claimId,fileIds:['refund-proof','refund-proof','written-po']}};
  const added=run(f.state,command,f.c),repeated=run(added.state,command,f.c);
  expect(added.result.added).toBe(1);expect(repeated.result.added).toBe(0);expect(repeated.state.platform.claims[0].fileIds).toEqual(['written-po','refund-proof']);
  const events=repeated.state.events.filter(event=>event.entityId===f.claimId&&event.text.startsWith('补充 '));expect(events).toHaveLength(1);expect(events[0].fileIds).toEqual(['refund-proof']);
  expect(platformCommandPermission(command)).toBe('aftersales:write');
 });
 it.each(['Closed','Cancelled'] as const)('refuses new attachments for a %s case and missing files without partial append',state=>{
  const f=evidenceFixture();f.state.platform.claims[0].state=state;const before=structuredClone(f.state);
  expect(()=>run(f.state,{type:'platform.claim.attachFiles',payload:{id:f.claimId,fileIds:['refund-proof']}},f.c)).toThrow(/已结束/);expect(f.state).toEqual(before);
  f.state.platform.claims[0].state='Registered';expect(()=>run(f.state,{type:'platform.claim.attachFiles',payload:{id:f.claimId,fileIds:['refund-proof','foreign-file']}},f.c)).toThrow(/附件不存在/);
  expect(f.state.platform.claims[0].fileIds).toEqual(['written-po']);
 });
 it('freezes case plus disposition evidence at submit and excludes later case additions from the pending review',()=>{
  const f=evidenceFixture();let next=run(f.state,{type:'platform.claim.attachFiles',payload:{id:f.claimId,fileIds:['refund-proof']}},f.c);
  next=run(next.state,{type:'platform.claim.disposition',payload:{claimId:f.claimId,kind:'ReturnRefund',amount:15,quantity:1,unit:'件',returnDisposition:'Scrap',basis:'客户已核实退款1件',fileIds:['written-po']}},f.c);const id=next.result.id!;
  next=run(next.state,{type:'platform.claim.submit',payload:{id}},f.c);const submitted=structuredClone(next.state.platform.claims[0].dispositions[0]);
  expect(submitted.fileIds).toEqual(['written-po']);expect(submitted.reviewFileIds).toEqual(['written-po','refund-proof']);expect(JSON.parse(submitted.snapshot!).attachments).toEqual(['po.pdf','refund-proof.pdf']);
  next=run(next.state,{type:'platform.claim.attachFiles',payload:{id:f.claimId,fileIds:['later-proof']}},f.c);
  expect(next.state.platform.claims[0].dispositions[0]).toEqual(submitted);expect(getPlatformReviews(next.state)[0].fileIds).toEqual(['written-po','refund-proof']);
  next=run(next.state,{type:'platform.claim.decide',payload:{id,decision:'approved',note:'仅依据提交时冻结的事实'}},{...f.c,actorId:'leader'});
  expect(next.state.platform.claims[0].dispositions[0].basis).toBe(submitted.basis);expect(next.state.platform.claims[0].dispositions[0].snapshot).toBe(submitted.snapshot);
 });
});

describe('claim approval return notifications and business work',()=>{
 function pending(){
  const f=invoiceFixture();let next=run(f.state,{type:'platform.claim.create',payload:{orderId:f.orderId,invoiceId:f.invoiceId,problem:'审批回程验收',fileIds:['written-po']}},f.c);const claimId=next.result.id!;
  next=run(next.state,{type:'platform.claim.disposition',payload:{claimId,kind:'ReturnRefund',amount:15,quantity:1,unit:'件',returnDisposition:'Scrap',basis:'客户确认退货退款',fileIds:['written-po']}},f.c);const dispositionId=next.result.id!;
  next=run(next.state,{type:'platform.claim.submit',payload:{id:dispositionId}},f.c);
  return{...f,state:next.state,claimId,dispositionId,reviewer:{...f.c,actorId:'leader',actorName:'实际售后负责人'}};
 }
 it('emits one exact approval return and an undated execution task without creating financial facts',()=>{
  const f=pending(),before=structuredClone(f.state.platform.claims[0].dispositions[0]),result=run(f.state,{type:'platform.claim.decide',payload:{id:f.dispositionId,decision:'approved',note:'核对退货事实通过'}},f.reviewer);
  const notifications=result.state.notifications.filter(row=>row.target.view==='claims'&&row.target.id===f.claimId),tasks=result.state.tasks.filter(row=>row.kind==='claim-execution:'+f.dispositionId);
  expect(notifications).toHaveLength(1);expect(notifications[0]).toMatchObject({category:'general',readAt:null,at:f.c.now,target:{view:'claims',id:f.claimId}});expect(notifications[0].detail).toContain('实际售后负责人');expect(notifications[0].detail).toContain('核对退货事实通过');
  expect(tasks).toHaveLength(1);expect(tasks[0]).toMatchObject({due:'',done:false,target:{view:'claims',id:f.claimId}});expect(tasks[0].title).toContain('生成售后履行单据');
  expect(result.state.platform.credits).toEqual([]);expect(result.state.payments).toEqual([]);expect(result.state.platform.claims[0].dispositions[0].snapshot).toBe(before.snapshot);
  expect(()=>run(result.state,{type:'platform.claim.decide',payload:{id:f.dispositionId,decision:'approved',note:'重复决定'}},f.reviewer)).toThrow(/不在待审批/);
  expect(result.state.tasks.filter(row=>row.kind==='claim-execution:'+f.dispositionId)).toHaveLength(1);
 });
 it('keeps rejection work until the actual rejected disposition is revised, not merely another draft added',()=>{
  const f=pending();let result=run(f.state,{type:'platform.claim.decide',payload:{id:f.dispositionId,decision:'rejected',note:'请修订退货依据'}},f.reviewer);
  const revisionKind='claim-revision:'+f.dispositionId;expect(result.state.tasks.find(task=>task.kind===revisionKind)?.done).toBe(false);expect(result.state.notifications[0].detail).toContain('请修订退货依据');
  const input={claimId:f.claimId,kind:'ReturnRefund' as const,amount:15,quantity:1,unit:'件',returnDisposition:'Scrap' as const,basis:'补全的退货事实',fileIds:['written-po']};
  result=run(result.state,{type:'platform.claim.disposition',payload:input},f.c);expect(result.state.tasks.find(task=>task.kind===revisionKind)?.done).toBe(false);
  result=run(result.state,{type:'platform.claim.disposition',payload:{...input,revisesId:f.dispositionId}},f.c);expect(result.state.tasks.find(task=>task.kind===revisionKind)?.done).toBe(true);expect(result.state.platform.claims[0].dispositions[0].supersededById).toBe(result.result.id);
 });
 it('completes execution work only after successful fulfillment creation',()=>{
  const f=pending();let result=run(f.state,{type:'platform.claim.decide',payload:{id:f.dispositionId,decision:'approved',note:'通过'}},f.reviewer);
  result=run(result.state,{type:'platform.claim.execute',payload:{id:f.dispositionId,warehouseId:f.warehouseId}},f.c);expect(result.state.tasks.find(task=>task.kind==='claim-execution:'+f.dispositionId)?.done).toBe(true);expect(result.state.platform.credits[0].amount).toBe(15);expect(result.state.payments).toEqual([]);
 });
 it('cancels approved unexecuted work without creating a credit or refund',()=>{
  const f=pending();let result=run(f.state,{type:'platform.claim.decide',payload:{id:f.dispositionId,decision:'approved',note:'仅审批回程验收'}},f.reviewer);
  result=run(result.state,{type:'platform.claim.cancel',payload:{id:f.claimId,reason:'验收后撤销未执行案件'}},f.c);expect(result.state.tasks.filter(task=>task.target.id===f.claimId).every(task=>task.done)).toBe(true);expect(result.state.platform.credits).toEqual([]);expect(result.state.payments).toEqual([]);
 });
 it('completes the remaining revision work when a rejected-only case is legally closed',()=>{
  const f=pending();let result=run(f.state,{type:'platform.claim.decide',payload:{id:f.dispositionId,decision:'rejected',note:'不采纳该处置'}},f.reviewer);
  result=run(result.state,{type:'platform.claim.close',payload:{id:f.claimId}},f.c);expect(result.state.platform.claims[0].state).toBe('Closed');expect(result.state.tasks.find(task=>task.kind==='claim-revision:'+f.dispositionId)?.done).toBe(true);
 });
 it('does not synthesize historical approval notifications or work during an unrelated command',()=>{
  const f=pending();let result=run(f.state,{type:'platform.claim.decide',payload:{id:f.dispositionId,decision:'approved',note:'历史已批准'}},f.reviewer);result.state.notifications=[];result.state.tasks=[];
  result=run(result.state,{type:'platform.claim.attachFiles',payload:{id:f.claimId,fileIds:['written-po']}},f.c);expect(result.state.notifications).toEqual([]);expect(result.state.tasks).toEqual([]);
 });
});
function approvedClaim(kind:'Allowance'|'ReturnRefund'|'Replace'|'Repair'='Allowance'){const f=invoiceFixture();let r=run(f.state,{type:'platform.claim.create',payload:{orderId:f.orderId,invoiceId:f.invoiceId,problem:'实物缺陷',fileIds:[]}},f.c),claimId=r.result.id!;r=run(r.state,{type:'platform.claim.disposition',payload:{claimId,kind,amount:kind==='Allowance'||kind==='ReturnRefund'?20:0,quantity:kind==='Allowance'?0:2,unit:kind==='Allowance'?'':'件',returnDisposition:kind==='Allowance'?'':kind==='Repair'?'Repair':kind==='Replace'?'Replace':'Scrap',basis:'双方确认凭据',fileIds:[]}},f.c);const dispositionId=r.result.id!;r=run(r.state,{type:'platform.claim.submit',payload:{id:dispositionId}},f.c);r=run(r.state,{type:'platform.claim.decide',payload:{id:dispositionId,decision:'approved',note:'核实同意'}},{...f.c,actorId:'leader'});return{...f,state:r.state,claimId,dispositionId};}
describe('Mist platform business evidence',()=>{
 it('links a revised rejected disposition and prevents resubmitting the superseded proposal',()=>{const f=approvedClaim();let state=structuredClone(f.state);const old=state.platform.claims[0].dispositions[0];old.state='rejected';old.reviewDecision='rejected';old.decisionNote='调整折让金额';const revised=run(state,{type:'platform.claim.disposition',payload:{claimId:f.claimId,revisesId:old.id,kind:'Allowance',amount:10,quantity:0,unit:'',returnDisposition:'',basis:'按退回意见修订',fileIds:[]}} as any,f.c);state=revised.state;const previous=state.platform.claims[0].dispositions[0];expect(previous.supersededById).toBe(revised.result.id);expect(state.platform.claims[0].dispositions[1].supersedesId).toBe(old.id);expect(()=>run(state,{type:'platform.claim.submit',payload:{id:old.id}},f.c)).toThrow(/修订/);const submitted=run(state,{type:'platform.claim.submit',payload:{id:revised.result.id!}},f.c);expect(submitted.state.platform.claims[0].dispositions[1].state).toBe('pending');expect(getPlatformReviews(submitted.state).find(t=>t.entityId===old.id)?.status).toBe('rejected');});
 it('cancels all unexecuted child dispositions and retains their approval evidence',()=>{const f=approvedClaim();let r:ReturnType<typeof run>={state:f.state,result:{id:f.dispositionId}};const add=()=>run(r.state,{type:'platform.claim.disposition',payload:{claimId:f.claimId,kind:'Allowance',amount:5,quantity:0,unit:'',returnDisposition:'',basis:'后续处置依据',fileIds:[]}},f.c);r=add();const draft=r.result.id!;r=add();const pending=r.result.id!;r=run(r.state,{type:'platform.claim.submit',payload:{id:pending}},f.c);const before=f.state.platform.claims[0].dispositions[0];r=run(r.state,{type:'platform.claim.cancel',payload:{id:f.claimId,reason:'客户撤销诉求'}},f.c);const claim=r.state.platform.claims[0];expect(claim.state).toBe('Cancelled');expect(claim.dispositions.map(d=>d.state)).toEqual(['Cancelled','Cancelled','Cancelled']);expect(claim.dispositions[0]).toMatchObject({snapshot:before.snapshot,decisionNote:before.decisionNote});expect(getPlatformReviews(r.state).some(t=>t.status==='pending')).toBe(false);expect(getPlatformReviews(r.state).find(t=>t.entityId===f.dispositionId)?.status).toBe('approved');expect(getPlatformReviews(r.state).find(t=>t.entityId===pending)).toBeUndefined();for(const id of [f.dispositionId,draft,pending]){expect(()=>run(r.state,{type:'platform.claim.execute',payload:{id}},f.c)).toThrow();expect(()=>run(r.state,{type:'platform.claim.submit',payload:{id}},f.c)).toThrow();}expect(()=>run(r.state,{type:'platform.claim.disposition',payload:{claimId:f.claimId,kind:'Allowance',amount:1,quantity:0,unit:'',returnDisposition:'',basis:'不可新增',fileIds:[]}},f.c)).toThrow();expect(r.state.platform.credits).toHaveLength(0);});
 it.each(['Cancelled','Closed'] as const)('refuses legacy approved or pending children of a %s case',state=>{const f=approvedClaim();f.state.platform.claims[0].state=state;expect(()=>run(f.state,{type:'platform.claim.execute',payload:{id:f.dispositionId,warehouseId:f.warehouseId}},f.c)).toThrow();expect(f.state.platform.credits).toHaveLength(0);f.state.platform.claims[0].dispositions[0].state='pending';expect(()=>run(f.state,{type:'platform.claim.decide',payload:{id:f.dispositionId,decision:'approved',note:'不可审批'}},{...f.c,actorId:'leader'})).toThrow();});
 it('does not erase executed credit facts through case cancellation',()=>{const f=approvedClaim();const r=run(f.state,{type:'platform.claim.execute',payload:{id:f.dispositionId,warehouseId:f.warehouseId}},f.c);const before=JSON.stringify(r.state.platform);expect(()=>run(r.state,{type:'platform.claim.cancel',payload:{id:f.claimId,reason:'撤销已执行案件'}},f.c)).toThrow(/已执行/);expect(JSON.stringify(r.state.platform)).toBe(before);expect(r.state.platform.credits[0].amount).toBe(20);expect(r.state.platform.claims[0].dispositions[0].state).toBe('Executed');});
 it('uses the Shanghai business day across UTC midnight',()=>{expect(platformBusinessDate('2026-10-12T20:00:00Z')).toBe('2026-10-13');});
 it('uses deterministic four-decimal BOM and cost-markup pricing without binary drift',()=>{expect(calculatePlatformBom([{description:'面料',quantity:0.1,unit:'m',wastagePercent:0,unitCost:0.2}],0.1,0.2)).toBe(0.32);expect(calculatePlatformPricing({purchaseCostCny:100,refundRate:13,exchangeRate:7.2,profitMargin:20,commissionRate:5})).toEqual({netUsdCost:12.0833,profitAmount:2.4167,commissionAmount:0.6042,finalUnitPrice:15.1042});expect(()=>calculatePlatformPricing({purchaseCostCny:100,refundRate:17,exchangeRate:7,profitMargin:20,commissionRate:0})).toThrow(/退税/);expect(()=>calculatePlatformBom([{description:'坏值',quantity:1,unit:'m',wastagePercent:101,unitCost:1}],0,0)).toThrow(/损耗/);});
 it('issues only against a real order and prevents duplicate or excess invoicing atomically',()=>{const f=invoiceFixture();expect(f.state.invoices).toHaveLength(1);expect(()=>run(f.state,{type:'platform.invoice.issue',payload:{id:f.state.platform.invoiceDrafts[0].id}},f.c)).toThrow(/重复/);const d=run(f.state,{type:'platform.invoice.save',payload:{orderId:f.orderId,due:'2026-11-11',amount:0.01,note:''}},f.c);expect(()=>run(d.state,{type:'platform.invoice.issue',payload:{id:d.result.id!}},f.c)).toThrow(/超过/);expect(d.state.invoices).toHaveLength(1);expect(()=>run(f.state,{type:'platform.invoice.save',payload:{orderId:'missing',due:'2026-11-11',amount:10,note:''}},f.c)).toThrow(/不存在/);});
 it('rejects foreign invoice and missing attachment identities',()=>{const f=invoiceFixture();expect(()=>run(f.state,{type:'platform.claim.create',payload:{orderId:f.orderId,invoiceId:f.invoiceId,problem:'test',fileIds:['missing']}},f.c)).toThrow(/附件/);expect(()=>run(f.state,{type:'platform.claim.create',payload:{orderId:f.orderId,invoiceId:'missing',problem:'test',fileIds:[]}},f.c)).toThrow(/发票/);});
 it('freezes a review snapshot and rejects forged or outdated approval authority',()=>{const f=approvedClaim();const task=getPlatformReviews(f.state)[0];expect(task.reviewerIds).toEqual(['leader']);expect(task.details[0].value).toContain('双方确认凭据');expect(task.status).toBe('approved');const mutable=JSON.parse(JSON.stringify(f.state));mutable.platform.claims[0].dispositions[0].state='pending';for(const c of [{...f.c,actorId:'intruder'},{...f.c,actorId:'leader',authority:{supplier:{},claimReviewerId:'new-leader'}}])expect(()=>run(mutable,{type:'platform.claim.decide',payload:{id:f.dispositionId,decision:'approved',note:'伪审批'}},c)).toThrow(/指定审批人/);});
 it('refuses submission without an actual server-resolved reviewer',()=>{const f=approvedClaim();const s=JSON.parse(JSON.stringify(f.state));s.platform.claims[0].dispositions[0].state='Draft';expect(()=>run(s,{type:'platform.claim.submit',payload:{id:f.dispositionId}},{...f.c,authority:{supplier:{}}})).toThrow(/未配置/);});
 it('creates independent credit and allocates it without manufacturing a cash receipt',()=>{const f=approvedClaim();let r=run(f.state,{type:'platform.claim.execute',payload:{id:f.dispositionId,warehouseId:f.warehouseId}},f.c);const credit=r.state.platform.credits[0];expect(r.state.receipts).toHaveLength(0);expect(()=>run(r.state,{type:'platform.claim.execute',payload:{id:f.dispositionId,warehouseId:f.warehouseId}},f.c)).toThrow(/重复/);r=run(r.state,{type:'platform.credit.apply',payload:{creditId:credit.id,invoiceId:f.invoiceId,amount:20}},f.c);expect(r.state.invoices[0].open).toBe(80);expect(platformCreditRemaining(r.state,credit.id)).toBe(0);expect(r.state.receipts).toHaveLength(0);expect(()=>run(r.state,{type:'platform.credit.refund',payload:{creditId:credit.id,amount:0.01,date:'2026-10-13',reference:'bank'}},f.c)).toThrow(/超过/);expect(run(r.state,{type:'platform.claim.close',payload:{id:f.claimId}},f.c).state.platform.claims[0].state).toBe('Closed');});
 it('requires complete physical return through the real isolated stock ledger before refund',()=>{
  const f=approvedClaim('ReturnRefund');let r=run(f.state,{type:'platform.claim.execute',payload:{id:f.dispositionId,warehouseId:f.warehouseId}},f.c);const credit=r.state.platform.credits[0],goods=r.state.platform.claimGoods[0];
  expect(()=>run(r.state,{type:'platform.credit.refund',payload:{creditId:credit.id,amount:20,date:'2026-10-13',reference:'bank'}},f.c)).toThrow(/收货/);
  expect(()=>run(r.state,{type:'platform.goods.transition',payload:{id:goods.id,state:'Dispatched',basis:'skip',fileIds:[]}},f.c)).toThrow(/实际库存/);
  const received=applyMistCommand(r.state,{type:'fulfillment.claimInventory.receive',payload:{goodsId:goods.id,quantity:2,unit:'件',warehouseId:f.warehouseId,location:'退回隔离区',batchNumber:'RT-BATCH',ownership:'Owned',ownershipDate:'2026-10-13',ownershipEvidence:'客户确认我方货权',receivedAt:'2026-10-13',basis:'退货点数与签收凭据',fileIds:['written-po']}},f.c);
  r=run(received.state,{type:'platform.credit.refund',payload:{creditId:credit.id,amount:20,date:'2026-10-13',reference:'真实银行回单'}},f.c);expect(r.state.payments[0].ref).toContain('真实银行回单');expect(r.state.payments[0].code).toMatch(/^PV-2026-\d{4}$/);expect(r.state.allocations).toEqual([]);
  expect(()=>run(r.state,{type:'platform.claim.close',payload:{id:f.claimId}},f.c)).toThrow(/隔离货物/);
  const scrapped=applyMistCommand(r.state,{type:'fulfillment.claimInventory.scrap',payload:{goodsId:goods.id,receivedEventId:received.result.receivedEventId as string,basis:'已批准报废执行凭证',fileIds:['written-po']}},f.c);
  expect(scrapped.state.fulfillment.stock[0]).toMatchObject({available:0,onHand:0,locked:0});expect(run(scrapped.state,{type:'platform.claim.close',payload:{id:f.claimId}},f.c).state.platform.claims[0].state).toBe('Closed');
 });
 it.each(['Replace','Repair'] as const)('refuses fake %s release states without actual professional fulfillment',kind=>{
  const f=approvedClaim(kind),r=run(f.state,{type:'platform.claim.execute',payload:{id:f.dispositionId,warehouseId:f.warehouseId}},f.c);expect(r.state.platform.credits).toHaveLength(0);const id=r.state.platform.claimGoods[0].id;
  for(const state of ['Received','Ready','Dispatched'] as const)expect(()=>run(r.state,{type:'platform.goods.transition',payload:{id,state,basis:'不能以备注制造履行事实',fileIds:[]}},f.c)).toThrow(/实际库存/);
  expect(r.state.platform.claimGoods[0].state).toBe('AwaitingReturn');expect(()=>run(r.state,{type:'platform.claim.close',payload:{id:f.claimId}},f.c)).toThrow();
 });
 it('preserves business archive events without modifying authentication identity',()=>{const f=fixture();const r=run(f.state,{type:'platform.employee.save',payload:{name:'林',department:'业务',position:'跟单',contact:'',startDate:'2026-10-01',note:'入组记录',active:true}},f.c);expect(r.state.platform.employees[0].history[0].actor).toBe('业务员');expect(r.state.platform.employees[0]).not.toHaveProperty('permissions');expect(platformCommandPermission({type:'platform.employee.save',payload:{} as any})).toBe('hr:write');expect(platformCommandPermission({type:'platform.credit.refund',payload:{} as any})).toBe('invoices:reconcile');});
 it('does not resolve risk without first acknowledging it and providing evidence',()=>{const f=fixture();const rc={...f.c,authority:{...f.c.authority!,risk:{all:true,orders:true,customers:true}}};const r=run(f.state,{type:'platform.risk.save',payload:{orderId:f.orderId,title:'交期风险',level:'warning',basis:'厂方回复',owner:'业务员'}},rc);expect(()=>run(r.state,{type:'platform.risk.transition',payload:{id:r.result.id!,state:'Resolved',resolution:'done'}},rc)).toThrow(/先确认/);});
});
