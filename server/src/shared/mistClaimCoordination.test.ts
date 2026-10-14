import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,mistCommandPermission,type MistContext,type MistCommand} from './mistWorkspace';
import {testClaimNumberConsumer,seedIssuedClaimSource} from './mistClaimTestFixtures';
import {claimLedger,currentClaimVerification} from './mistClaimCoordination';

function fixture(){
 let id=0;const ctx:MistContext={id:()=>`coord-${++id}`,now:'2026-10-14T08:00:00Z',actorId:'business',actorName:'业务员顾言',consumeBusinessNumber:testClaimNumberConsumer('2026-10-14T08:00:00Z'),authority:{supplier:{},claimReviewerId:'reviewer',orderReviewerIds:{garment:['reviewer'],fabric:['reviewer']}}};let state=createMistState(ctx,'empty');
 const run=(command:MistCommand,actor=ctx)=>{const result=applyMistCommand(state,command,actor);state=result.state;return result.result as Record<string,any>;};
 const qc={...ctx,actorId:'qc',actorName:'质检许言'},leader={...ctx,actorId:'reviewer',actorName:'负责人周敏'},finance={...ctx,actorId:'finance',actorName:'财务'};
 run({type:'market.customer.create',payload:{input:{name:'实际客户',country:'FR',city:'巴黎',industry:'成衣',owner:'业务员顾言',grade:'A',currency:'USD',terms:'OA 30天',incoterm:'FOB',categories:'成衣',creditLimit:0,since:'2026-10-13'}}});
 run({type:'files.add',payload:{file:{id:'photo',name:'客户照片.jpg',mimeType:'image/jpeg',size:10,storageKey:'fixture/photo',createdAt:ctx.now}}});
 const supplierId=run({type:'market.supplier.save',payload:{input:{code:'F1',name:'江南成衣',type:'成衣加工',country:'CN',address:'嘉兴',capabilities:'成衣',capacity:1,capacityUnit:'件',leadDays:10}}} as MistCommand).id;
 const orderId=run({type:'order.create',payload:{type:'garment',customerId:state.customers[0].id,season:'AW',currency:'USD',due:'2026-12-01',owner:'业务员顾言',governance:{kind:'external',poNumber:'PO-1',confirmationFileIds:['photo'],internalPurpose:'',receiver:'',paymentMethod:'OA',depositPercent:null,paymentNote:'发票后30天',incoterm:'FOB',deliveryPlace:'上海'},lines:[{name:'外套',style:'A',img:'coat',qty:4,unit:'件',price:15}]}} as MistCommand).id;
 run({type:'order.governance.submit',payload:{orderId}} as MistCommand);run({type:'order.governance.decide',payload:{id:orderId,decision:'approved',note:'核对合同'}} as MistCommand,leader);
 const draft=run({type:'platform.invoice.save',payload:{orderId,due:'2026-12-31',amount:60,note:'原票'}}).id;const invoiceId=run({type:'platform.invoice.issue',payload:{id:draft}}).invoiceId;seedIssuedClaimSource(state,invoiceId);
 const claimId=run({type:'platform.claim.create',payload:{orderId,invoiceId,problem:'客户反映色差',fileIds:['photo']}}).id;
 return{ctx,qc,leader,finance,run,supplierId,claimId,get state(){return state;},claim(){return state.platform!.claims.find(c=>c.id===claimId)!;}};
}
const notify=(f:ReturnType<typeof fixture>)=>f.run({type:'platform.claim.notify',payload:{id:f.claimId,supplierId:f.supplierId,factoryChannel:'微信群',note:'客户要求赔 10000'}});
const allowance=(f:ReturnType<typeof fixture>,amount:number)=>{const id=f.run({type:'platform.claim.disposition',payload:{claimId:f.claimId,kind:'Allowance',amount,quantity:0,unit:'',returnDisposition:'',basis:'客户书面同意减款',fileIds:[]}}).id;f.run({type:'platform.claim.submit',payload:{id}});f.run({type:'platform.claim.decide',payload:{id,decision:'approved',note:'批准'}},f.leader);f.run({type:'platform.claim.execute',payload:{id}});return id;};

describe('售后索赔协同',()=>{
 it('maps permissions to the people who actually do each step',()=>{
  const p=(type:string)=>mistCommandPermission({type,payload:{}} as unknown as MistCommand);
  expect(p('platform.claim.notify')).toBe('aftersales:write');expect(p('platform.claim.verify')).toBe('qc:inspect');expect(p('platform.claim.recovery.open')).toBe('aftersales:write');
  expect(p('platform.claim.recovery.settle')).toBe('invoices:reconcile');expect(p('platform.claim.recovery.waive')).toBe('aftersales:approve');
 });
 it('records notification of internal parties and factory without sending anything externally, and creates follow-up work',()=>{
  const f=fixture();notify(f);const n=f.claim().coordination!.notices[0];
  expect(n).toMatchObject({supplierName:'江南成衣',factoryChannel:'微信群',note:'客户要求赔 10000',byId:'business'});
  const tasks=f.state.tasks.filter(t=>t.target.id===f.claimId&&!t.done).map(t=>t.kind);expect(tasks).toEqual(expect.arrayContaining(['claim-verify:'+f.claimId,'claim-factory:'+f.claimId]));
  expect(f.state.notifications[0].detail).toContain('不代表认定责任');
  expect(()=>f.run({type:'platform.claim.notify',payload:{id:f.claimId,supplierId:'nope',factoryChannel:'电话',note:''}})).toThrow('准确工厂');
 });
 it('lets QC record facts, closes the QC task and flags safety issues',()=>{
  const f=fixture();notify(f);
  f.run({type:'platform.claim.verify',payload:{id:f.claimId,result:'partial',scope:'A款 第2批',affectedQuantity:120,unit:'件',goodsLocation:'customer',mitigation:'挑选后可降级销售',factoryResponse:'工厂确认染缸批次有偏差',safety:true,fileIds:['photo']}},f.qc);
  expect(currentClaimVerification(f.claim())).toMatchObject({result:'partial',affectedQuantity:120,goodsLocation:'customer',safety:true,byId:'qc'});
  expect(f.state.tasks.filter(t=>t.target.id===f.claimId&&!t.done)).toHaveLength(0);
  expect(f.state.notifications[0].detail).toContain('停售或召回');
  expect(()=>f.run({type:'platform.claim.verify',payload:{id:f.claimId,result:'maybe' as any,scope:'x',affectedQuantity:1,unit:'件',goodsLocation:'customer',mitigation:'',factoryResponse:'',safety:false,fileIds:[]}},f.qc)).toThrow('核实结论');
 });
 it('keeps customer settlement and factory recovery as two separate ledgers and blocks closing until the factory side is settled',()=>{
  const f=fixture();notify(f);allowance(f,50);
  const rid=f.run({type:'platform.claim.recovery.open',payload:{claimId:f.claimId,supplierId:f.supplierId,currency:'usd',requested:50,basis:'染色批次偏差，工厂责任'}}).id;
  expect(()=>f.run({type:'platform.claim.recovery.open',payload:{claimId:f.claimId,supplierId:f.supplierId,currency:'USD',requested:1,basis:'重复'}})).toThrow('未落实的追偿');
  expect(()=>f.run({type:'platform.claim.recovery.settle',payload:{id:rid,amount:1,reference:'x',date:'2026-10-14'}},f.finance)).toThrow('须先记录工厂同意');
  f.run({type:'platform.claim.recovery.agree',payload:{id:rid,agreed:30,method:'payment',note:'工厂邮件确认承担 30'}});
  let ledger=claimLedger(f.state,f.claim() as any);expect(ledger).toMatchObject({currency:'USD',customer:50,recoveryAgreed:30,recoverySettled:0,companyLoss:20,customerSettled:true,recoveryOpen:true});
  f.state.platform!.credits.forEach(n=>{f.run({type:'platform.credit.refund',payload:{creditId:n.id,amount:50,date:'2026-10-14',reference:'TT-1'}},f.finance);});
  expect(()=>f.run({type:'platform.claim.close',payload:{id:f.claimId}})).toThrow('工厂补偿未落实');
  expect(()=>f.run({type:'platform.claim.recovery.settle',payload:{id:rid,amount:35,reference:'x',date:'2026-10-14'}},f.finance)).toThrow('不能超过');
  expect(()=>f.run({type:'platform.claim.recovery.settle',payload:{id:rid,amount:30,reference:'x',date:'2026-12-01'}},f.finance)).toThrow('未来');
  f.run({type:'platform.claim.recovery.settle',payload:{id:rid,amount:30,reference:'工厂电汇 30 · 银行回单 TT-9',date:'2026-10-14'}},f.finance);
  ledger=claimLedger(f.state,f.claim() as any);expect(ledger).toMatchObject({recoverySettled:30,companyLoss:20,recoveryOpen:false});
  f.run({type:'platform.claim.close',payload:{id:f.claimId}});expect(f.claim().state).toBe('Closed');
  expect(f.state.tasks.filter(t=>t.target.id===f.claimId&&!t.done)).toHaveLength(0);
 });
 it('requires a different person to approve giving up recovery and does not compute loss across currencies',()=>{
  const f=fixture();allowance(f,10);const rid=f.run({type:'platform.claim.recovery.open',payload:{claimId:f.claimId,supplierId:f.supplierId,currency:'CNY',requested:500,basis:'工厂责任'}}).id;
  expect(claimLedger(f.state,f.claim() as any)).toMatchObject({sameCurrency:false,companyLoss:null});
  expect(()=>f.run({type:'platform.claim.recovery.waive',payload:{id:rid,reason:'长期合作'}})).toThrow('不能自己批准');
  f.run({type:'platform.claim.recovery.waive',payload:{id:rid,reason:'工厂已停业，追偿成本过高'}},f.leader);
  expect(f.claim().coordination!.recoveries[0]).toMatchObject({state:'Waived',waiveReason:'工厂已停业，追偿成本过高'});
 });
 it('withdraws open recoveries with the case but refuses to cancel once factory money was settled',()=>{
  const f=fixture();const rid=f.run({type:'platform.claim.recovery.open',payload:{claimId:f.claimId,supplierId:f.supplierId,currency:'USD',requested:50,basis:'先行登记'}}).id;
  f.run({type:'platform.claim.cancel',payload:{id:f.claimId,reason:'客户撤回投诉'}});expect(f.claim().coordination!.recoveries[0].state).toBe('Withdrawn');
  const g=fixture();const r2=g.run({type:'platform.claim.recovery.open',payload:{claimId:g.claimId,supplierId:g.supplierId,currency:'USD',requested:50,basis:'x'}}).id;g.run({type:'platform.claim.recovery.agree',payload:{id:r2,agreed:50,method:'payment',note:'工厂确认'}});g.run({type:'platform.claim.recovery.settle',payload:{id:r2,amount:50,reference:'收款 R-1',date:'2026-10-14'}},g.finance);
  expect(()=>g.run({type:'platform.claim.cancel',payload:{id:g.claimId,reason:'撤回'}})).toThrow('已落实');expect(rid).toBeTruthy();
 });
});
