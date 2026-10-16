import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,type MistContext,type MistState} from './mistWorkspace';
import {createOrderGovernance,applyOrderGovernanceCommand,getOrderGovernanceReviews,type OrderGovernanceInput,type OrderGovernanceCommand} from './mistOrderGovernance';
import {lineToleranceStatus,toleranceText,TOLERANCE_NONE,assertOrderLineOpen} from './mistOrderClosure';
function fixture(){let n=0;const c:MistContext={id:()=>`gov-${++n}`,now:'2026-10-13T08:00:00Z',actorName:'业务员',actorId:'sales',authority:{supplier:{},orderReviewerIds:{garment:['leader','sales'],fabric:['fabric-leader']}}};const state=createMistState(c,'empty');state.customers.push({id:'customer',name:'客户',code:'C',country:'CN',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});state.files.push({id:'contract-file',name:'confirmed.pdf',mimeType:'application/pdf',size:10,storageKey:'workspace/contract-file',createdAt:c.now});const contract:OrderGovernanceInput={kind:'external',poNumber:'PO-001',confirmationFileIds:['contract-file'],internalPurpose:'',receiver:'',paymentMethod:'TT',depositPercent:30,paymentNote:'30%定金，余款按合同',incoterm:'FOB',deliveryPlace:'上海'};const order={id:'order',code:'SO-1',type:'garment' as const,customerId:'customer',customer:'客户',season:'AW26',lines:1,qty:10,amount:100,currency:'USD',due:'2026-12-01',progress:0,state:'订单草稿',tone:'neutral' as const,owner:'业务员',img:'coat' as const,checklist:[],handoffAt:null,createdAt:c.now,updatedAt:c.now,governance:createOrderGovernance(c,contract)};state.orders.push(order);state.orderLines.push({id:'line',orderId:order.id,name:'外套',style:'A',img:'coat',qty:10,unit:'件',price:10,made:0,qc:0});const run=(command:OrderGovernanceCommand,actor=c)=>applyOrderGovernanceCommand(state,command,actor);return{state,c,contract,order,run};}
const leader=(f:ReturnType<typeof fixture>)=>({...f.c,actorId:'leader'});
/** ±3% 的 1000 件条目，已批准。 */
function thousand(tolerance:Partial<OrderGovernanceInput>={overPercent:3,shortPercent:3}){
 const f=fixture();f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:{...f.contract,...tolerance},lines:[{id:'line',name:'外套',style:'A',img:'coat',qty:1000,unit:'件',price:10}]}});
 f.run({type:'order.governance.submit',payload:{orderId:'order'}});f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'通过'}},leader(f));return f;
}
function ship(f:ReturnType<typeof fixture>,quantity:number,state:'departed'|'preparing'='departed',id='sh'+(f.state.fulfillment.shipments.length+1)){
 f.state.fulfillment.shipments.push({id,code:id.toUpperCase(),customerId:'customer',customer:'客户',domain:'garment',consignee:'客户',mode:'sea',portOfLoading:'上海',portOfDischarge:'汉堡',incoterm:'FOB',plannedDate:'2026-11-25',booking:'',lines:[{lineId:'line',orderId:'order',quantity,factoryConfirmedAt:f.c.now}],note:'',fileIds:[],state,requestedBy:'单证',requesterId:'docs',createdAt:f.c.now} as never);
}
const close=(f:ReturnType<typeof fixture>,reason='客户接受实际数量',actor=f.c)=>f.run({type:'order.governance.closeLine',payload:{orderId:'order',lineId:'line',reason}} as OrderGovernanceCommand,actor);
const closure=(f:ReturnType<typeof fixture>)=>(f.state.orderLines[0] as unknown as {closure?:Record<string,unknown>}).closure;

describe('BB-ORD-5 over/short tolerance and closing a line at actual quantity',()=>{
 it('stores ±3% as contract terms, shows the allowed range and predicts the verdict before departure',()=>{
  const f=thousand();expect(f.order.governance.contract).toMatchObject({overPercent:3,shortPercent:3});expect(toleranceText(f.order.governance.contract)).toBe('溢装 +3% / 短装 −3%');
  ship(f,950,'preparing');
  expect(lineToleranceStatus(f.state,f.order,f.state.orderLines[0])).toMatchObject({min:970,max:1030,planned:950,departed:0,remaining:50,verdict:'short'});
  expect(()=>f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:{...f.contract,overPercent:12}}})).toThrow('溢装上限须为 0 至 10 之间的百分数');
 });
 it('treats a legacy order without tolerance as "未约定，按足量"',()=>{
  const f=thousand({});expect('overPercent' in f.order.governance.contract).toBe(false);expect(toleranceText(f.order.governance.contract)).toBe(TOLERANCE_NONE);
  expect(lineToleranceStatus(f.state,f.order,f.state.orderLines[0])).toMatchObject({min:1000,max:1000,agreed:false});
 });
 it('lets the salesperson close 980 of 1000 directly and marks the order 履约完成',()=>{
  const f=thousand();ship(f,980);
  expect(()=>close(f,'  ')).toThrow('结案原因未填写');
  const result=close(f);expect(result).toMatchObject({closure:'closed'});
  expect(closure(f)).toMatchObject({status:'closed',quantity:980,ordered:1000,min:970,max:1030,reason:'客户接受实际数量'});
  expect(f.state.events[0].text).toContain('请到发票/收款核对结算金额');
  expect(f.state.orderLines[0].qty).toBe(1000);expect(f.state.invoices.length).toBe(0);
  const next=applyMistCommand(f.state,{type:'order.governance.discardChange',payload:{orderId:'order'}},f.c).state;
  expect(next.orders[0].state).toBe('履约完成');
 });
 it('sends 950 of 1000 to the order reviewer; the requester cannot approve it; approval closes the line',()=>{
  const f=thousand();ship(f,950);
  expect(close(f)).toMatchObject({closure:'pending'});expect(closure(f)).toMatchObject({status:'pending',reviewerIds:['leader']});
  const review=getOrderGovernanceReviews(f.state).find(r=>r.id.startsWith('order-close:'))!;
  expect(review).toMatchObject({kind:'order',status:'pending',requesterId:'sales',reviewerIds:['leader'],entityId:'order#close:line'});
  expect(review.details).toEqual(expect.arrayContaining([{label:'允许范围',value:'970–1030 件'},{label:'实际离港（结案数量）',value:'950 件'},{label:'差异',value:'-50 件'}]));
  expect(()=>f.run({type:'order.governance.decide',payload:{id:review.entityId,decision:'approved',note:'自批'}})).toThrow('申请人不能审批自己的结案申请');
  expect(()=>close(f)).toThrow('条目已有待审批的结案申请');
  f.run({type:'order.governance.decide',payload:{id:review.entityId,decision:'approved',note:'客户书面同意短装'}},leader(f));
  expect(closure(f)).toMatchObject({status:'closed',decidedBy:'leader',note:'客户书面同意短装'});
  expect(getOrderGovernanceReviews(f.state).find(r=>r.id===review.id)!.status).toBe('approved');
  expect(f.state.tasks.filter(t=>t.kind==='order-line-close:line').every(t=>t.done)).toBe(true);
 });
 it('lets a rejected closure be re-applied and refuses to close while a shipment has not departed',()=>{
  const f=thousand();ship(f,900);close(f);
  f.run({type:'order.governance.decide',payload:{id:'order#close:line',decision:'rejected',note:'先补出 50 件'}},leader(f));expect(closure(f)).toMatchObject({status:'rejected'});
  ship(f,80,'preparing','open');
  expect(()=>close(f)).toThrow('该条目还有未离港的有效出运（OPEN），须先离港或取消后再结案');
  f.state.fulfillment.shipments.find(s=>s.id==='open')!.state='departed';expect(close(f)).toMatchObject({closure:'closed'});
 });
 it('blocks further shipments and quantity changes once the line is closed',()=>{
  const f=thousand();ship(f,1000);close(f);
  expect(()=>assertOrderLineOpen(f.state.orderLines[0])).toThrow('已结案，不能再建出运');
  expect(()=>f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:f.contract,lines:[{id:'line',name:'外套',style:'A',img:'coat',qty:1010,unit:'件',price:10}],reason:'追加'}})).toThrow('已结案，不能再改数量');
  f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:f.contract,orderPatch:{due:'2026-12-20'},reason:'改交期'}});expect(f.order.governance.changeDraft?.orderPatch.due).toBe('2026-12-20');
 });
 it('treats a tolerance change after approval as a contract change through the change draft',()=>{
  const f=thousand();f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:{...f.contract,overPercent:5,shortPercent:3},reason:'客户放宽溢装'}});
  expect(f.order.governance.contract.overPercent).toBe(3);expect(f.order.governance.changeDraft?.contract.overPercent).toBe(5);
  f.run({type:'order.governance.submit',payload:{orderId:'order'}});
  expect(getOrderGovernanceReviews(f.state).find(r=>r.status==='pending')!.details).toContainEqual({label:'溢短装',value:'溢装 +5% / 短装 −3%'});
  f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'通过'}},leader(f));expect(f.order.governance.contract.overPercent).toBe(5);
 });
});
