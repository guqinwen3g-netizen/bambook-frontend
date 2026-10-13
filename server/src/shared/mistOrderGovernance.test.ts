import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,type MistContext,type MistState} from './mistWorkspace';
import {createOrderGovernance,applyOrderGovernanceCommand,assertOrderApproved,getOrderGovernanceReviews,type OrderGovernanceFields,type OrderGovernanceInput,type OrderGovernanceCommand} from './mistOrderGovernance';
import {assertOrderFundingIntegrity,orderFundingCoveredAmount} from './mistOrderFunding';
function fixture(){let n=0;const c:MistContext={id:()=>`gov-${++n}`,now:'2026-10-13T08:00:00Z',actorName:'业务员',actorId:'sales',authority:{supplier:{},orderReviewerIds:{garment:['leader','sales'],fabric:['fabric-leader']}}};const state=createMistState(c,'empty');state.customers.push({id:'customer',name:'客户',code:'C',country:'CN',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});state.files.push({id:'contract-file',name:'confirmed.pdf',mimeType:'application/pdf',size:10,storageKey:'workspace/contract-file',createdAt:c.now});const contract:OrderGovernanceInput={kind:'external',poNumber:'PO-001',confirmationFileIds:['contract-file'],internalPurpose:'',receiver:'',paymentMethod:'TT',depositPercent:30,paymentNote:'30%定金，余款按合同',incoterm:'FOB',deliveryPlace:'上海'};const order={id:'order',code:'SO-1',type:'garment' as const,customerId:'customer',customer:'客户',season:'AW26',lines:1,qty:10,amount:100,currency:'USD',due:'2026-12-01',progress:0,state:'订单草稿',tone:'neutral' as const,owner:'业务员',img:'coat' as const,checklist:[],handoffAt:null,createdAt:c.now,updatedAt:c.now,governance:createOrderGovernance(c,contract)};state.orders.push(order);state.orderLines.push({id:'line',orderId:order.id,name:'外套',style:'A',img:'coat',qty:10,unit:'件',price:10,made:0,qc:0});const run=(command:OrderGovernanceCommand,actor=c)=>applyOrderGovernanceCommand(state,command,actor);return{state,c,contract,order,run};}
describe('formal order governance',()=>{
 it('summarizes the submitted internal purpose and receiver rather than retained external customer and PO fields',()=>{
  const f=fixture();f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:{...f.contract,internalPurpose:'旧内部用途',receiver:'旧内部团队'}}});f.run({type:'order.governance.submit',payload:{orderId:'order'}});f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'核对原外部合同'}},{...f.c,actorId:'leader'});
  const original=structuredClone(f.order.governance.approvedSnapshot),internal={...f.contract,kind:'internal' as const,internalPurpose:'展厅试穿',receiver:'样品团队 / 负责人乙'};
  f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:internal,reason:'改为内部展厅试穿'}});f.run({type:'order.governance.submit',payload:{orderId:'order'}});
  const reviews=getOrderGovernanceReviews(f.state),oldDetails=Object.fromEntries(reviews[0].details.map(item=>[item.label,item.value])),newDetails=Object.fromEntries(reviews[1].details.map(item=>[item.label,item.value]));
  expect(oldDetails).toMatchObject({'订单用途':'外部客户订单','客户/接收方':'客户','合同':'PO-001'});
  expect(newDetails).toMatchObject({'订单用途':'内部用途订单','客户/接收方':'样品团队 / 负责人乙','合同':'展厅试穿'});
  expect(f.order.customerId).toBe('customer');expect(f.order.customer).toBe('客户');expect(f.order.governance.approvedSnapshot).toEqual(original);
  f.run({type:'order.governance.decide',payload:{id:'order',decision:'rejected',note:'请更正接收团队'}},{...f.c,actorId:'leader'});
  f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:{...internal,internalPurpose:'修订试穿用途',receiver:'修订团队 / 负责人丙'},reason:'更正内部交接资料'}});f.run({type:'order.governance.submit',payload:{orderId:'order'}});
  const resubmitted=getOrderGovernanceReviews(f.state),retained=Object.fromEntries(resubmitted[1].details.map(item=>[item.label,item.value])),current=Object.fromEntries(resubmitted[2].details.map(item=>[item.label,item.value]));
  expect(retained).toMatchObject({'客户/接收方':'样品团队 / 负责人乙','合同':'展厅试穿'});expect(current).toMatchObject({'客户/接收方':'修订团队 / 负责人丙','合同':'修订试穿用途'});
  expect(resubmitted.map(review=>review.status)).toEqual(['approved','rejected','pending']);
 });
 it('blocks downstream fulfillment until the order main approval is complete',()=>{const f=fixture();expect(()=>assertOrderApproved(f.state,'order')).toThrow(/尚未批准/);f.run({type:'order.governance.submit',payload:{orderId:'order'}});expect(()=>assertOrderApproved(f.state,'order')).toThrow(/尚未批准/);f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'核对PO通过'}},{...f.c,actorId:'leader'});expect(assertOrderApproved(f.state,'order').id).toBe('order');});
 it('requires external written evidence and the current domain approval list',()=>{const f=fixture();f.order.governance.contract.confirmationFileIds=[];expect(()=>f.run({type:'order.governance.submit',payload:{orderId:'order'}})).toThrow(/书面/);f.order.governance.contract=f.contract;expect(()=>f.run({type:'order.governance.submit',payload:{orderId:'order'}},{...f.c,authority:{supplier:{}}})).toThrow(/审批负责人/);});
 it('allows an explicitly authorized requester to review their own order and resolves only once',()=>{const f=fixture();f.run({type:'order.governance.submit',payload:{orderId:'order'}});f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'本人授权范围内核对'}});expect(f.order.governance.approvedBy).toBe('sales');expect(()=>f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'重复'}},{...f.c,actorId:'leader'})).toThrow(/没有待决定/);});
 it('locks pending content and preserves a rejected round when edited and resubmitted',()=>{const f=fixture();f.run({type:'order.governance.submit',payload:{orderId:'order'}});expect(()=>f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:f.contract}})).toThrow(/锁定/);f.run({type:'order.governance.decide',payload:{id:'order',decision:'rejected',note:'修改交期'}},{...f.c,actorId:'leader'});f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:f.contract,orderPatch:{due:'2026-12-03'}}});f.run({type:'order.governance.submit',payload:{orderId:'order'}});const reviews=getOrderGovernanceReviews(f.state);expect(reviews.map(r=>r.status)).toEqual(['rejected','pending']);expect(f.order.governance.rounds[0].snapshot.due).toBe('2026-12-01');});
 it('keeps approved content active while a change is drafted, and applies it only after approval',()=>{const f=fixture();f.run({type:'order.governance.submit',payload:{orderId:'order'}});f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'通过'}},{...f.c,actorId:'leader'});f.run({type:'order.governance.saveDraft',payload:{orderId:'order',input:f.contract,orderPatch:{due:'2026-12-10'},reason:'客户书面调整交期'}});expect(f.order.due).toBe('2026-12-01');f.run({type:'order.governance.submit',payload:{orderId:'order'}});expect(assertOrderApproved(f.state,'order').due).toBe('2026-12-01');f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'变更批准'}},{...f.c,actorId:'leader'});expect(f.order.due).toBe('2026-12-10');expect(f.order.governance.effectiveVersion).toBe(2);});
 it('does not accept a forged reviewer or material mutation after submission',()=>{const f=fixture();f.run({type:'order.governance.submit',payload:{orderId:'order'}});expect(()=>f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'越权'}},{...f.c,actorId:'stranger'})).toThrow(/名单/);f.state.orderLines[0].price=11;expect(()=>f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'已核对'}},{...f.c,actorId:'leader'})).toThrow(/快照不一致/);});
});

describe.each(['customer.update','market.customer.update'] as const)('%s preserves contractual customer identity',type=>{
 it('does not invalidate approval when the existing customer is renamed',()=>{
  const f=fixture();f.run({type:'order.governance.submit',payload:{orderId:'order'}});
  f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'通过'}},{...f.c,actorId:'leader'});
  const next=applyMistCommand(f.state,{type,payload:{id:'customer',patch:{name:'客户新名称'}}},f.c).state;
  expect(assertOrderApproved(next,'order').customer).toBe('客户新名称');
  expect(next.orders[0].governance?.approvedSnapshot?.customer).toBe('客户');
  expect(next.orders[0].governance?.rounds[0].snapshot.customer).toBe('客户');
 });
 it.each(['approved','rejected'] as const)('allows a pending round to be %s after a customer rename',decision=>{
  const f=fixture();f.run({type:'order.governance.submit',payload:{orderId:'order'}});
  const renamed=applyMistCommand(f.state,{type,payload:{id:'customer',patch:{name:'客户新名称'}}},f.c).state;
  const next=applyMistCommand(renamed,{type:'order.governance.decide',payload:{id:'order',decision,note:'核对相同客户身份'}},{...f.c,actorId:'leader'}).state;
  expect(next.orders[0].governance?.status).toBe(decision);
  expect(next.orders[0].governance?.rounds[0].snapshot.customer).toBe('客户');
  if(decision==='approved')expect(assertOrderApproved(next,'order').customerId).toBe('customer');
 });
});

it('continues to reject an actual customer identity change before or after approval',()=>{
 const pending=fixture();pending.run({type:'order.governance.submit',payload:{orderId:'order'}});
 pending.order.customerId='different-customer';
 expect(()=>pending.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'不得绕过重审'}},{...pending.c,actorId:'leader'})).toThrow(/快照不一致/);
 const approved=fixture();approved.run({type:'order.governance.submit',payload:{orderId:'order'}});
 approved.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'通过'}},{...approved.c,actorId:'leader'});
 approved.order.customerId='different-customer';
 expect(()=>assertOrderApproved(approved.state,'order')).toThrow(/快照不一致/);
});

it.each(['amount','currency'] as const)('atomically refuses a funded order %s change until the original funds become customer balance',mode=>{
 const f=fixture();f.run({type:'order.governance.submit',payload:{orderId:'order'}});
 f.run({type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'原合同批准'}},{...f.c,actorId:'leader'});
 let state=applyMistCommand(f.state,{type:'finance.importReceipts',payload:{receipts:[{date:'2026-10-13',payer:'客户',amount:80,currency:'USD',ref:'REAL-BANK-REF'}]}},f.c).state;
 const receiptId=state.receipts[0].id;
 const funded=applyMistCommand(state,{type:'funding.assign',payload:{receiptId,customerId:'customer',orderId:'order',amount:80,note:'客户确认原合同归属'}},f.c);state=funded.state;
 const assignmentId=funded.result.id!;
 state=applyMistCommand(state,{type:'order.governance.saveDraft',payload:{orderId:'order',input:f.contract,reason:'客户书面修订',...(mode==='amount'?{lines:[{id:'line',name:'外套',style:'A',img:'coat' as const,qty:10,unit:'件',price:5}]}:{orderPatch:{currency:'EUR'}})}},f.c).state;
 state=applyMistCommand(state,{type:'order.governance.submit',payload:{orderId:'order'}},f.c).state;
 const before=structuredClone(state),decide:OrderGovernanceCommand={type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'批准修订合同'}};
 expect(()=>applyMistCommand(state,decide,{...f.c,actorId:'leader'})).toThrow(mode==='amount'?/超过合同金额/:/币种不一致/);
 expect(state).toEqual(before);expect(state.orders[0].amount).toBe(100);expect(state.orders[0].currency).toBe('USD');
 expect(state.orders[0].governance?.changeDraft?.status).toBe('pending');
 state=applyMistCommand(state,{type:'funding.release',payload:{id:assignmentId,note:'客户确认解除原订单归属'}},f.c).state;
 state=applyMistCommand(state,{type:'funding.assign',payload:{receiptId,customerId:'customer',orderId:null,amount:80,note:'暂列客户USD余额'}},f.c).state;
 state=applyMistCommand(state,decide,{...f.c,actorId:'leader'}).state;
 expect(state.orders[0]).toMatchObject(mode==='amount'?{amount:50,currency:'USD'}:{amount:100,currency:'EUR'});
 expect(state.orders[0].governance?.changeDraft).toBeUndefined();expect(orderFundingCoveredAmount(state,'order')).toBe(0);
 expect(state.receipts[0].remaining).toBe(80);expect(state.allocations).toEqual([]);expect(()=>assertOrderFundingIntegrity(state)).not.toThrow();
});

it('allows preparation of a procurement draft but blocks commitment and production until the main order is approved',()=>{
 const f=fixture();f.state.market.suppliers.push({id:'supplier',code:'S1',name:'真实供应商',type:'成衣加工',country:'CN',address:'上海',capabilities:'成衣加工',capacity:10,capacityUnit:'件',leadDays:3,status:'active',blockReason:'',contacts:[],fileIds:[],note:'',createdAt:f.c.now,updatedAt:f.c.now});
 const command={type:'fulfillment.procurement.save',payload:{orderId:'order',lineId:'line',kind:'finished',supplierId:'supplier',supplier:'真实供应商',description:'成衣采购',quantity:10,unit:'件',price:5,currency:'USD',due:'2026-11-01',terms:'按合同',destination:'上海',note:'',fileIds:[]}} as const;
 const prepared=applyMistCommand(f.state,command as any,f.c);let state=prepared.state;const purchaseId=prepared.result.id!;
 const context={...f.c,authority:{...f.c.authority!,supplier:{'supplierCommitment.approvers.purchase.garment':{version:1,userIds:['leader']}}}};
 expect(state.fulfillment.purchases[0].state).toBe('draft');
 expect(()=>applyMistCommand(state,{type:'fulfillment.procurement.submit',payload:{id:purchaseId}},context)).toThrow(/主单|批准/);
 expect(()=>applyMistCommand(state,{type:'fulfillment.procurement.decide',payload:{id:purchaseId,decision:'approved',note:'不应通过'}},context)).toThrow(/主单|批准/);
 expect(()=>applyMistCommand(state,{type:'fulfillment.procurement.send',payload:{id:purchaseId,at:f.c.now,evidence:'不得发送未批准合同',fileIds:[]}},context)).toThrow(/已批准/);
 expect(()=>applyMistCommand(state,{type:'order.handoff',payload:{orderId:'order'}},context)).toThrow(/主单|批准/);
 expect(state.fulfillment.purchases[0].state).toBe('draft');expect(state.productions).toHaveLength(0);
 state=applyMistCommand(state,{type:'order.governance.submit',payload:{orderId:'order'}},context).state;
 expect(()=>applyMistCommand(state,{type:'fulfillment.procurement.submit',payload:{id:purchaseId}},context)).toThrow(/主单|批准/);
 expect(state.fulfillment.purchases[0].state).toBe('draft');
 state=applyMistCommand(state,{type:'order.governance.decide',payload:{id:'order',decision:'approved',note:'已核对原件'}},{...context,actorId:'leader'}).state;
 state=applyMistCommand(state,{type:'fulfillment.procurement.submit',payload:{id:purchaseId}},context).state;
 expect(state.fulfillment.purchases[0].state).toBe('pending');expect(state.receipts).toHaveLength(0);
});
