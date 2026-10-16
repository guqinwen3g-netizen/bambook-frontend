import {describe,it,expect} from 'vitest';
import {createMistState,type MistContext,type MistState} from './mistWorkspace';
import {createOrderGovernance,applyOrderGovernanceCommand,assertOrderApproved,getOrderGovernanceReviews,type OrderGovernanceInput,type OrderGovernanceCommand} from './mistOrderGovernance';
import {orderChangeImpact} from './mistOrderChangeImpact';
function fixture(){let n=0;const c:MistContext={id:()=>`gov-${++n}`,now:'2026-10-13T08:00:00Z',actorName:'业务员',actorId:'sales',authority:{supplier:{},orderReviewerIds:{garment:['leader','sales'],fabric:['fabric-leader']}}};const state=createMistState(c,'empty');state.customers.push({id:'customer',name:'客户',code:'C',country:'CN',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});state.files.push({id:'contract-file',name:'confirmed.pdf',mimeType:'application/pdf',size:10,storageKey:'workspace/contract-file',createdAt:c.now});const contract:OrderGovernanceInput={kind:'external',poNumber:'PO-001',confirmationFileIds:['contract-file'],internalPurpose:'',receiver:'',paymentMethod:'TT',depositPercent:30,paymentNote:'30%定金，余款按合同',incoterm:'FOB',deliveryPlace:'上海'};const order={id:'order',code:'SO-1',type:'garment' as const,customerId:'customer',customer:'客户',season:'AW26',lines:1,qty:10,amount:100,currency:'USD',due:'2026-12-01',progress:0,state:'订单草稿',tone:'neutral' as const,owner:'业务员',img:'coat' as const,checklist:[],handoffAt:null,createdAt:c.now,updatedAt:c.now,governance:createOrderGovernance(c,contract)};state.orders.push(order);state.orderLines.push({id:'line',orderId:order.id,name:'外套',style:'A',img:'coat',qty:10,unit:'件',price:10,made:0,qc:0});const run=(command:OrderGovernanceCommand,actor=c)=>applyOrderGovernanceCommand(state,command,actor);return{state,c,contract,order,run};}
const leader=(f:ReturnType<typeof fixture>)=>({...f.c,actorId:'leader'});
/** 已批准、已开工：采购 PO-1、生产 PR-1（分配 10，已完工 6，按尺码 S4/M2）、出运 SH-1（5 件）、发票 INV-1。 */
function started(withInvoice=false){
 const f=fixture();f.run({type:'order.governance.submit',payload:{orderId:'order'}});f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'通过'}},leader(f));
 const s=f.state as MistState;
 s.productions.push({id:'job',code:'PR-1',orderId:'order',lineId:'line',order:'SO-1',name:'外套',factory:'一厂',qty:10,due:'2026-11-20',pct:60,img:'coat',col:'sew'});
 s.fulfillment.productionFacts.push({productionId:'job',sizes:[{size:'S',quantity:5},{size:'M',quantity:5}],revision:1,completion:{id:'done-1',quantity:6,sizeQuantities:[{size:'S',quantity:4},{size:'M',quantity:2}],date:'2026-11-01',at:f.c.now,actor:'厂长',evidence:'完工单',fileIds:[]}});
 s.fulfillment.purchases.push({id:'po',code:'PO-1',orderId:'order',lineId:'line',kind:'material',domain:'garment',supplierId:'sup',supplier:'面料商',description:'面料',quantity:20,unit:'米',price:5,currency:'USD',due:'2026-11-01',terms:'月结',destination:'一厂',note:'',fileIds:[],state:'approved',requesterId:'buyer',createdBy:'采购',createdAt:f.c.now,reviewerIds:[],configVersions:{},received:0} as never);
 s.fulfillment.shipments.push({id:'sh',code:'SH-1',customerId:'customer',customer:'客户',domain:'garment',consignee:'客户',mode:'sea',portOfLoading:'上海',portOfDischarge:'汉堡',incoterm:'FOB',plannedDate:'2026-11-25',booking:'',lines:[{lineId:'line',orderId:'order',productionId:'job',quantity:5,factoryConfirmedAt:f.c.now}],note:'',fileIds:[],state:'preparing',requestedBy:'单证',requesterId:'docs',createdAt:f.c.now} as never);
 if(withInvoice)s.invoices.push({id:'inv',code:'INV-1',orderId:'order',order:'SO-1',customer:'客户',due:'2026-12-30',amount:30,open:30,currency:'USD'});
 return f;
}
const line=(qty:number,extra:Record<string,unknown>={})=>({id:'line',name:'外套',style:'A',img:'coat' as const,qty,unit:'件',price:10,...extra});
const change=(f:ReturnType<typeof fixture>,lines:unknown[],extra:Record<string,unknown>={})=>f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:f.contract,lines,reason:'客户书面变更',...extra}} as OrderGovernanceCommand);

describe('BB-ORD-4 quantity change after work has started',()=>{
 it('lets a started order increase quantity through change approval and creates review to-dos for purchase and production',()=>{
  const f=started();change(f,[line(14)]);
  expect(f.state.orderLines[0].qty).toBe(10);
  f.run({type:'order.governance.submit',payload:{orderId:'order'}});
  expect(()=>change(f,[line(15)])).toThrow('审批中订单内容已锁定');
  expect(assertOrderApproved(f.state,'order').qty).toBe(10);
  f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'变更通过'}},leader(f));
  expect(f.state.orderLines[0].qty).toBe(14);expect(f.order.governance.effectiveVersion).toBe(2);expect(assertOrderApproved(f.state,'order').qty).toBe(14);
  const todo=f.state.tasks.filter(t=>t.kind.startsWith('order-change-review:'));
  expect(todo.map(t=>t.title)).toEqual(expect.arrayContaining(['订单 SO-1 数量已变更，请核对采购 PO-1（A 10 → 14 件）','订单 SO-1 数量已变更，请核对生产 PR-1（A 10 → 14 件）']));
  expect(todo.find(t=>t.kind.includes(':purchase:'))!.target).toMatchObject({view:'procurement',id:'po'});
  expect(todo.find(t=>t.kind.includes(':production:'))!.target).toMatchObject({view:'production-board',productionId:'job'});
  expect(f.state.fulfillment.purchases[0].quantity).toBe(20);expect(f.state.productions[0].qty).toBe(10);
 });
 it('allows a decrease down to max(completed, shipped) and rejects anything lower',()=>{
  const f=started();
  expect(()=>change(f,[line(5)])).toThrow('条目「A · 外套」新数量 5 件 低于下限 6 件（已完工 6、已排出运 5）');
  change(f,[line(6)]);f.run({type:'order.governance.submit',payload:{orderId:'order'}});f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'减量通过'}},leader(f));
  expect(f.state.orderLines[0].qty).toBe(6);
 });
 it('re-checks the floor on submit and on approval because work may continue meanwhile',()=>{
  const f=started();change(f,[line(7)]);
  f.state.fulfillment.productionFacts[0].completion!.quantity=8;
  expect(()=>f.run({type:'order.governance.submit',payload:{orderId:'order'}})).toThrow('低于下限 8 件');
  f.state.fulfillment.productionFacts[0].completion!.quantity=6;f.run({type:'order.governance.submit',payload:{orderId:'order'}});
  f.state.fulfillment.shipments[0].lines[0].quantity=9;
  expect(()=>f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'通过'}},leader(f))).toThrow('低于下限 9 件（已完工 6、已排出运 9）');
  expect(f.state.orderLines[0].qty).toBe(10);
  f.state.fulfillment.shipments[0].state='cancelled';
  f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'通过'}},leader(f));expect(f.state.orderLines[0].qty).toBe(7);
 });
 it('does not let a line with purchase/production/shipment be deleted, but lets new lines and unit price/due change',()=>{
  const f=started();
  expect(()=>change(f,[{id:'new',name:'马甲',style:'B',img:'coat',qty:3,unit:'件',price:8}])).toThrow('条目「A · 外套」已有采购 PO-1；生产 PR-1；出运 SH-1，不能删除，只能减量');
  change(f,[line(10,{price:11}),{id:'new',name:'马甲',style:'B',img:'coat',qty:3,unit:'件',price:8}],{orderPatch:{due:'2026-12-20'}});
  f.run({type:'order.governance.submit',payload:{orderId:'order'}});f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'通过'}},leader(f));
  expect(f.state.orderLines.filter(l=>l.orderId==='order').map(l=>[l.style,l.qty,l.price])).toEqual([['A',10,11],['B',3,8]]);expect(f.order.due).toBe('2026-12-20');
  // 数量未变：不生成核对待办
  expect(f.state.tasks.some(t=>t.kind.startsWith('order-change-review:'))).toBe(false);
 });
 it('still forbids a currency change once an invoice exists, but allows it with only production facts',()=>{
  const f=started(true);
  expect(()=>change(f,[line(10)],{orderPatch:{currency:'EUR'}})).toThrow('已有发票（INV-1），不能变更币种');
  const g=started();change(g,[line(10)],{orderPatch:{currency:'EUR'}});expect(g.order.governance.changeDraft?.orderPatch.currency).toBe('EUR');
 });
 it('enforces the per-size floor when the line has a colour × size breakdown',()=>{
  const f=started();
  const grid=(m:number)=>({kind:'garment',sizes:['S','M'],rows:[{color:'藏青',quantities:[3,m]},{color:'黑',quantities:[2,0]}]});
  expect(()=>change(f,[line(6,{breakdown:grid(1)})])).toThrow('M 码各色合计 1 低于已完工 2');
  change(f,[line(7,{breakdown:grid(2)})]);expect(f.order.governance.changeDraft?.lines[0].qty).toBe(7);
 });
 it('lists affected purchase, production, shipment and invoice in the impact list and on the approval page',()=>{
  const f=started(true);change(f,[line(8)]);
  const impact=orderChangeImpact(f.state,f.order,f.order.governance.changeDraft!.lines);
  expect(impact.lines[0]).toMatchObject({before:10,after:8,completed:6,shipped:5,allocated:10,floor:6,purchases:[{code:'PO-1',state:'approved',quantity:20}],productions:[{code:'PR-1',factory:'一厂',qty:10,completed:6}],shipments:[{code:'SH-1',quantity:5}]});
  expect(impact.lines[0].warning).toBe('新数量低于生产分配总量 10 件，需同步调整生产分配');
  expect(impact.invoices).toEqual([expect.objectContaining({code:'INV-1',voided:false})]);
  f.run({type:'order.governance.submit',payload:{orderId:'order'}});
  const review=getOrderGovernanceReviews(f.state).find(r=>r.status==='pending')!;
  const row=review.details.find(d=>d.label==='影响清单 · A · 外套')!;
  expect(row.value).toContain('采购 PO-1（已批准，20 米）');expect(row.value).toContain('生产 PR-1（一厂，车缝，分配 10，已完工 6）');expect(row.value).toContain('出运 SH-1（准备中，5 件）');expect(row.value).toContain('需同步调整生产分配');
  expect(review.details.find(d=>d.label==='影响清单 · 发票')!.value).toContain('INV-1');
 });
});
