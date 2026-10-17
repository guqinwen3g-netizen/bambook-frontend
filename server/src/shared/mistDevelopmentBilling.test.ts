import {describe,it,expect} from 'vitest';
import { withTestFactories } from './__tests__/utils/devFactories';
import {applyMistCommand,createMistState,mistCommandPermission,type DevelopmentValues,type MistContext,type MistCommand} from './mistWorkspace';
import {emptyFabricRequirements} from './mistDevelopmentDomain';
import {developmentVersionSamples} from './mistDevelopmentSamples';
import {developmentClosure} from './mistDevelopmentRounds';
import {developmentBillingStage,developmentFeeSummary} from './mistDevelopmentBilling';

/** BB-DEV-9 开发费用 → 财务开票 → 收款核销 → 最终结案。 */
function fixture(charged:boolean){
 let n=0;const ctx:MistContext={id:()=>`bl-${++n}`,now:'2026-10-16T09:00:00Z',actorName:'测试业务员',actorId:'test-sales'};let state=withTestFactories(createMistState(ctx,'empty'));
 state.customers.push({id:'c',name:'测试客户',code:'C',country:'',city:'',industry:'',owner:'',grade:'',currency:'EUR',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
 state.market.suppliers.push({id:'f',code:'F',name:'测试面料厂',type:'面料工厂',capabilities:'织造',status:'active',country:'',address:'',capacity:0,capacityUnit:'米',leadDays:0,blockReason:'',contacts:[],fileIds:[],note:'',createdAt:ctx.now,updatedAt:ctx.now});
 const values:DevelopmentValues={domain:'fabric',name:'测试斜纹',customer:'c',style:'',season:'AW',category:'斜纹',kind:'new',fabric:'目标',color:'蓝灰',target:'2.50',targetCurrency:'EUR',targetUnit:'米',sizeBase:'',goal:'手感',factories:['测试面料厂'],due:'2026-11-01',collaborators:[],sampleQuantity:3,sampleForm:'色样',sampleUnit:'份',charged,fabricRequirements:{...emptyFabricRequirements(),composition:'羊毛:100'}} as DevelopmentValues;
 const run=(command:MistCommand)=>{const r=applyMistCommand(state,command,ctx);state=r.state;return r.result as any;};
 const ids=run({type:'development.submit',payload:{values,fileIds:[]}}) as {devId:string;versionId:string};
 const at={devId:ids.devId,versionId:ids.versionId};
 run({type:'development.recordSample',payload:{...at,sample:'R1-A-实物',quantity:5,form:'米样',unit:'米',location:'架A',returnedAt:ctx.now}});
 run({type:'development.recordQc',payload:{...at,domain:'fabric',qc:{result:'pass',reviewer:'QC',reviewedAt:ctx.now,report:'QC-1',opinion:'通过'}}});
 const dev=()=>state.devs.find(d=>d.id===at.devId)!;
 const samples=()=>developmentVersionSamples(state,state.versions.find(v=>v.id===at.versionId)!);
 const unchanged=(fn:()=>unknown,pattern:RegExp)=>{const before=JSON.stringify(state);expect(fn).toThrow(pattern);expect(JSON.stringify(state)).toBe(before);};
 return{ctx,run,at,dev,samples,unchanged,get state(){return state;}};
}
const confirm=(f:ReturnType<typeof fixture>)=>f.run({type:'development.confirm',payload:{...f.at,result:'approved',confirmer:'客户',organization:'测试客户',confirmedAt:f.ctx.now,basis:'邮件',originalText:'OK'}});

describe('BB-DEV-9 charged development: fees → invoice → settlement → final closure',()=>{
 it('walks from fee registration to write-off and final closure, and reopens on reversal',()=>{
  const f=fixture(true);confirm(f);
  expect(f.dev().state).toBe('已认可 · 待发起开票');expect(developmentClosure(f.state,f.dev())).toBeNull();
  const [metre]=f.samples();
  const {id:dispatchId}=f.run({type:'development.sample.dispatch',payload:{...f.at,sampleId:metre.id,quantity:2,recipient:'测试客户 Anna',fee:{amount:28.5,currency:'CNY'}}});
  f.run({type:'development.sample.dispatch',payload:{...f.at,sampleId:metre.id,quantity:1,recipient:'测试客户 Ben'}});
  // 制作费和后补寄样费都未齐 → 拒绝发起开票且不写入。
  f.unchanged(()=>f.run({type:'development.billing.request',payload:{devId:f.at.devId}}),/费用尚未补齐.*制作费.*寄样费/);
  f.unchanged(()=>f.run({type:'development.fee.recordMaking',payload:{devId:f.at.devId,sampleId:metre.id,amount:12.345,currency:'EUR'}}),/两位小数/);
  f.unchanged(()=>f.run({type:'development.fee.recordMaking',payload:{devId:f.at.devId,sampleId:'nope',amount:10,currency:'EUR'}}),/准确实物/);
  f.run({type:'development.fee.recordMaking',payload:{devId:f.at.devId,sampleId:metre.id,amount:120,currency:'eur'}});
  f.unchanged(()=>f.run({type:'development.fee.recordMaking',payload:{devId:f.at.devId,sampleId:metre.id,amount:130,currency:'EUR'}}),/不能覆盖/);
  const second=f.state.versions.find(v=>v.id===f.at.versionId)!.dispatches!.find(d=>d.id!==dispatchId)!;
  f.run({type:'development.sample.dispatchFee',payload:{...f.at,dispatchId:second.id,fee:{amount:15,currency:'CNY'}}});
  const summary=developmentFeeSummary(f.state,f.dev());
  expect(summary.missing).toEqual([]);
  expect(summary.lines.map(l=>[l.kind,l.amount,l.currency])).toEqual([['making',120,'EUR'],['dispatch',28.5,'CNY'],['dispatch',15,'CNY']]);
  expect(summary.totals).toEqual([{currency:'CNY',amount:43.5},{currency:'EUR',amount:120}]);

  const {id:requestId}=f.run({type:'development.billing.request',payload:{devId:f.at.devId}});
  expect(f.dev().billing!.request).toMatchObject({id:requestId,state:'pending',billTo:f.dev().customer,totals:summary.totals,invoiceIds:[]});
  expect(f.dev().state).toBe('待财务开票');expect(developmentBillingStage(f.state,f.dev())?.label).toBe('待财务开票');
  expect(f.state.tasks.find(t=>t.id===f.dev().billing!.request!.taskId)).toMatchObject({done:false,kind:'finance',target:{view:'payment-vouchers'}});
  f.unchanged(()=>f.run({type:'development.billing.request',payload:{devId:f.at.devId}}),/已发起开票/);
  // 费用锁定：发起后不能再登记。
  f.unchanged(()=>f.run({type:'development.fee.recordMaking',payload:{devId:f.at.devId,sampleId:metre.id,amount:1,currency:'EUR'}}),/已发起开票|不能覆盖/);

  f.unchanged(()=>f.run({type:'finance.developmentInvoice.issue',payload:{devId:f.at.devId,requestId,due:'bad'}}),/到期日/);
  f.run({type:'finance.developmentInvoice.issue',payload:{devId:f.at.devId,requestId,due:'2026-11-15'}});
  const invoices=f.state.invoices.filter(i=>i.devId===f.at.devId);
  expect(invoices.map(i=>[i.code,i.amount,i.open,i.currency,i.orderId,i.order,i.customer])).toEqual([
   ['DI-2026-0001',43.5,43.5,'CNY','',f.dev().code,f.dev().customer],['DI-2026-0002',120,120,'EUR','',f.dev().code,f.dev().customer]]);
  expect(f.dev().billing!.request).toMatchObject({state:'invoiced',invoiceIds:invoices.map(i=>i.id),invoicedBy:'测试业务员'});
  expect(f.dev().state).toBe('已开票 · 待收款');
  expect(f.state.tasks.find(t=>t.id===f.dev().billing!.request!.taskId)?.done).toBe(true);
  f.unchanged(()=>f.run({type:'finance.developmentInvoice.issue',payload:{devId:f.at.devId,requestId,due:'2026-11-15'}}),/重复开票/);

  const payer=invoices[0].customer;
  f.run({type:'finance.importReceipts',payload:{receipts:[{date:'2026-10-20',payer,amount:43.5,currency:'CNY',ref:'DEV-CNY'},{date:'2026-10-20',payer,amount:200,currency:'EUR',ref:'DEV-EUR'}]}});
  const [cny,eur]=f.state.receipts;
  f.run({type:'finance.reconcile',payload:{receiptId:cny.id,invoiceId:invoices[0].id}});
  expect(f.dev().state).toBe('已开票 · 待收款');expect(f.dev().billing!.settledAt).toBeUndefined();
  f.run({type:'finance.reconcile',payload:{receiptId:eur.id,invoiceId:invoices[1].id}});
  expect(f.state.invoices.filter(i=>i.devId===f.at.devId).map(i=>i.open)).toEqual([0,0]);
  expect(f.state.receipts.find(r=>r.id===eur.id)!.remaining).toBe(80);
  expect(f.dev().state).toBe('已最终结案');expect(f.dev().billing!.settledAt).toBe(f.ctx.now);
  expect(developmentClosure(f.state,f.dev())).toEqual({kind:'closed',label:'已最终结案'});
  expect(f.state.events.some(e=>e.text.includes('已最终结案'))).toBe(true);

  const allocation=f.state.allocations.find(a=>a.invoiceId===invoices[1].id)!;
  f.run({type:'finance.allocation.reverse',payload:{allocationId:allocation.id,reason:'误核销'}});
  expect(f.dev().state).toBe('已开票 · 待收款');expect(f.dev().billing!.settledAt).toBeUndefined();expect(developmentClosure(f.state,f.dev())).toBeNull();
 });
 it('cannot reuse one receipt beyond its amount across development and order invoices',()=>{
  const f=fixture(true);confirm(f);const [metre]=f.samples();
  f.run({type:'development.fee.recordMaking',payload:{devId:f.at.devId,sampleId:metre.id,amount:50,currency:'EUR'}});
  const {id:requestId}=f.run({type:'development.billing.request',payload:{devId:f.at.devId}});
  f.run({type:'finance.developmentInvoice.issue',payload:{devId:f.at.devId,requestId,due:'2026-11-15'}});
  const invoice=f.state.invoices.find(i=>i.devId===f.at.devId)!;
  f.run({type:'finance.importReceipts',payload:{receipts:[{date:'2026-10-20',payer:invoice.customer,amount:30,currency:'EUR',ref:'P1'}]}});
  f.run({type:'finance.reconcile',payload:{receiptId:f.state.receipts[0].id,invoiceId:invoice.id}});
  expect(f.state.invoices.find(i=>i.id===invoice.id)!.open).toBe(20);expect(f.dev().state).toBe('已开票 · 待收款');
  f.unchanged(()=>f.run({type:'finance.reconcile',payload:{receiptId:f.state.receipts[0].id,invoiceId:invoice.id}}),/超出|余额/);
 });
 it('bills internal requests to the internal requester',()=>{
  const f=fixture(true);const dev=f.dev();(dev.values as any).initiator='internal';(dev.values as any).requester='面料企划部';
  const [metre]=f.samples();f.run({type:'development.fee.recordMaking',payload:{devId:f.at.devId,sampleId:metre.id,amount:80,currency:'CNY'}});
  f.run({type:'development.billing.request',payload:{devId:f.at.devId}});
  expect(f.dev().billing!.request!.billTo).toBe('面料企划部');
 });
 it('requires at least one fee line',()=>{
  const f=fixture(true);f.state.fulfillment.samples.splice(0);
  f.unchanged(()=>f.run({type:'development.billing.request',payload:{devId:f.at.devId}}),/尚无可开票费用/);
 });
});

describe('BB-DEV-9 non-charged development',()=>{
 it('closes on approval with no billing entry',()=>{
  const f=fixture(false);confirm(f);
  expect(f.dev().state).toBe('已认可 · 已结案');expect(developmentClosure(f.state,f.dev())).toEqual({kind:'closed',label:'已结案'});
  expect(developmentBillingStage(f.state,f.dev())).toBeNull();
  const [metre]=f.samples();
  f.unchanged(()=>f.run({type:'development.fee.recordMaking',payload:{devId:f.at.devId,sampleId:metre.id,amount:10,currency:'EUR'}}),/不收费/);
  f.unchanged(()=>f.run({type:'development.billing.request',payload:{devId:f.at.devId}}),/不收费/);
  expect(f.state.invoices.filter(i=>i.devId)).toEqual([]);
 });
});

describe('BB-DEV-9 permissions',()=>{
 it('maps fee/billing to development write and invoicing to finance invoice scope',()=>{
  expect(mistCommandPermission({type:'development.fee.recordMaking',payload:{} as any})).toBe('products:write');
  expect(mistCommandPermission({type:'development.billing.request',payload:{} as any})).toBe('products:write');
  expect(mistCommandPermission({type:'finance.developmentInvoice.issue',payload:{} as any})).toBe('invoices:write');
 });
});

describe('frozen development billing',()=>{
 it.each(['dispatch','form','warehouse'] as const)('rejects adding unbillable %s activity after requesting invoicing',kind=>{
  const f=fixture(true);confirm(f);const sample=f.samples()[0];
  f.run({type:'development.fee.recordMaking',payload:{devId:f.at.devId,sampleId:sample.id,amount:10,currency:'EUR'}});
  f.run({type:'development.billing.request',payload:{devId:f.at.devId}});
  const command:MistCommand=kind==='dispatch'?{type:'development.sample.dispatch',payload:{...f.at,sampleId:sample.id,quantity:1,recipient:'新寄样',fee:{amount:5,currency:'EUR'}}}:kind==='form'?{type:'development.version.addSampleForm',payload:{...f.at,form:'色样',quantity:1,unit:'份'}}:{type:'fulfillment.samples.create',payload:{name:'仓库追加',category:'面料',form:'米样',quantity:1,unit:'米',size:'',color:'',location:'架B',source:{kind:'version',...f.at},fileIds:[],note:''}};
  f.unchanged(()=>f.run(command),/已发起开票|费用已锁定/);
 });
});
