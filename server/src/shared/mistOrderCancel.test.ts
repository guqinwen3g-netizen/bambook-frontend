import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,type MistContext,type MistState} from './mistWorkspace';
import {createOrderGovernance,applyOrderGovernanceCommand,getOrderGovernanceReviews,type OrderGovernanceInput,type OrderGovernanceCommand} from './mistOrderGovernance';
import {orderCancelBlockers} from './mistOrderGovernance';
function fixture(){let n=0;const c:MistContext={id:()=>`gov-${++n}`,now:'2026-10-13T08:00:00Z',actorName:'业务员',actorId:'sales',authority:{supplier:{},orderReviewerIds:{garment:['leader','sales'],fabric:['fabric-leader']}}};const state=createMistState(c,'empty');state.customers.push({id:'customer',name:'客户',code:'C',country:'CN',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});state.files.push({id:'contract-file',name:'confirmed.pdf',mimeType:'application/pdf',size:10,storageKey:'workspace/contract-file',createdAt:c.now});const contract:OrderGovernanceInput={kind:'external',poNumber:'PO-001',confirmationFileIds:['contract-file'],internalPurpose:'',receiver:'',paymentMethod:'TT',depositPercent:30,paymentNote:'30%定金，余款按合同',incoterm:'FOB',deliveryPlace:'上海'};const order={id:'order',code:'SO-1',type:'garment' as const,customerId:'customer',customer:'客户',season:'AW26',lines:1,qty:10,amount:100,currency:'USD',due:'2026-12-01',progress:0,state:'订单草稿',tone:'neutral' as const,owner:'业务员',img:'coat' as const,checklist:[],handoffAt:null,createdAt:c.now,updatedAt:c.now,governance:createOrderGovernance(c,contract)};state.orders.push(order);state.orderLines.push({id:'line',orderId:order.id,name:'外套',style:'A',img:'coat',qty:10,unit:'件',price:10,made:0,qc:0});const run=(command:OrderGovernanceCommand,actor=c)=>applyOrderGovernanceCommand(state,command,actor);return{state,c,contract,order,run};}
const leader=(f:ReturnType<typeof fixture>)=>({...f.c,actorId:'leader'});
function approved(){const f=fixture();f.run({type:'order.governance.submit',payload:{orderId:'order'}});f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'通过'}},leader(f));return f;}
const g=(f:ReturnType<typeof fixture>)=>f.order.governance as unknown as {status:string;cancellation?:{id:string;status:string;reviewerIds:string[]};termination?:{kind:string;reason:string}};
const requestCancel=(f:ReturnType<typeof fixture>,reason='客户撤单')=>f.run({type:'order.governance.requestCancel',payload:{orderId:'order',reason}} as OrderGovernanceCommand);
const cancelId=(f:ReturnType<typeof fixture>)=>'order#cancel:'+g(f).cancellation!.id;
const savePurchase=(f:ReturnType<typeof fixture>)=>applyMistCommand(f.state,{type:'fulfillment.procurement.save',payload:{orderId:'order',lineId:'line',kind:'material',supplierId:'supplier',supplier:'S',description:'面料',quantity:10,unit:'米',price:1,currency:'USD',due:'2026-11-01',terms:'月结',destination:'上海',note:'',fileIds:[]}} as never,f.c);

describe('BB-ORD-7 void drafts and cancel approved orders',()=>{
 it('voids a draft with a required reason; the voided order is read-only and cannot be submitted',()=>{
  const f=fixture();
  expect(()=>f.run({type:'order.governance.void',payload:{orderId:'order',reason:' '}} as OrderGovernanceCommand)).toThrow('作废原因未填写');
  expect(()=>f.run({type:'order.governance.void',payload:{orderId:'order',reason:'客户未下单'}} as OrderGovernanceCommand,{...f.c,actorName:'别人',actorId:'other'})).toThrow('仅订单负责人可作废');
  f.run({type:'order.governance.void',payload:{orderId:'order',reason:'客户未下单'}} as OrderGovernanceCommand);
  expect(g(f)).toMatchObject({status:'void',termination:{kind:'void',reason:'客户未下单'}});expect(f.order.state).toBe('已作废');
  expect(f.state.orders.length).toBe(1);
  expect(()=>f.run({type:'order.governance.submit',payload:{orderId:'order'}})).toThrow('订单已作废');
  expect(()=>f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:f.contract}})).toThrow('订单已作废');
  expect(()=>savePurchase(f)).toThrow('已作废');
 });
 it('requires a pending order to be withdrawn or decided before voiding; approved orders must be cancelled instead',()=>{
  const f=fixture();f.run({type:'order.governance.submit',payload:{orderId:'order'}});
  expect(()=>f.run({type:'order.governance.void',payload:{orderId:'order',reason:'x'}} as OrderGovernanceCommand)).toThrow('请先撤回或等待审批决定');
  f.run({type:'order.governance.decide',payload:{id:'order',decision:'rejected',note:'补资料'}},leader(f));
  f.run({type:'order.governance.void',payload:{orderId:'order',reason:'放弃'}} as OrderGovernanceCommand);expect(g(f).status).toBe('void');
  const a=approved();expect(()=>a.run({type:'order.governance.void',payload:{orderId:'order',reason:'x'}} as OrderGovernanceCommand)).toThrow('请发起取消订单申请');
 });
 it('sends cancellation to the order reviewer, locks the order, refuses self-approval and blocks new purchases after approval',()=>{
  const f=approved();
  expect(()=>requestCancel(f,'')).toThrow('取消原因未填写');
  requestCancel(f);expect(g(f).cancellation).toMatchObject({status:'pending',reviewerIds:['leader']});
  const review=getOrderGovernanceReviews(f.state).find(r=>r.id.startsWith('order-cancel:'))!;
  expect(review).toMatchObject({status:'pending',requesterId:'sales',reviewerIds:['leader'],entityId:cancelId(f)});
  expect(()=>requestCancel(f)).toThrow('已有待审批的取消申请');
  expect(()=>f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:f.contract}})).toThrow('取消审批中');
  expect(()=>savePurchase(f)).toThrow('取消审批中');
  expect(()=>f.run({type:'order.governance.decide',payload:{id:cancelId(f),decision:'approved',note:'自批'}})).toThrow('申请人不能审批自己的取消订单申请');
  f.run({type:'order.governance.decide',payload:{id:cancelId(f),decision:'approved',note:'客户书面撤单'}},leader(f));
  expect(g(f)).toMatchObject({status:'cancelled',cancellation:{status:'approved'}});expect(f.order.state).toBe('已取消');
  expect(f.state.tasks.filter(t=>t.kind?.startsWith('order-cancel:')).every(t=>t.done)).toBe(true);
  expect(f.state.notifications[0].title).toContain('取消订单审批通过');
  expect(()=>savePurchase(f)).toThrow('已取消，不能再进行采购');
  expect(()=>f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:f.contract}})).toThrow('订单已取消');
 });
 it('restores the order when cancellation is rejected',()=>{
  const f=approved();requestCancel(f);
  f.run({type:'order.governance.decide',payload:{id:cancelId(f),decision:'rejected',note:'继续履约'}},leader(f));
  expect(g(f)).toMatchObject({status:'approved',cancellation:{status:'rejected'}});
  const next=applyMistCommand(f.state,{type:'order.governance.discardChange',payload:{orderId:'order'}},f.c).state;expect(next.orders[0].state).not.toMatch(/取消/);
 });
 it('refuses whole-order cancellation after departure or invoicing and points to line closure',()=>{
  const f=approved();
  f.state.fulfillment.shipments.push({id:'sh',code:'SH-1',lines:[{lineId:'line',orderId:'order',quantity:5}],state:'departed'} as never);
  expect(orderCancelBlockers(f.state,f.order)).toEqual(['已有离港出运（SH-1）']);
  expect(()=>requestCancel(f)).toThrow('不能整单取消，请改用条目结案');
 });
});
