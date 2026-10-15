import {describe,expect,it} from 'vitest';
import {applyMistCommand,createMistState,MistCommandError,mistCommandPermission,mistMoneyMinor,mistBankAccountBalances,type MistCommand,type MistContext} from './mistWorkspace';
const context=()=>{let id=0;return {now:'2026-10-13T08:00:00.000Z',actorName:'验证员',id:()=>`test-${++id}`} satisfies MistContext;};
function approvedOrderFixture(amount=100){
 const ctx:MistContext={...context(),actorId:'business',authority:{supplier:{},orderReviewerIds:{garment:['reviewer'],fabric:['reviewer']}}};let state=createMistState(ctx,'empty');
 state.customers.push({id:'customer',name:'客户公司',code:'C',country:'CN',city:'',industry:'',owner:'业务',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
 state.files.push({id:'contract',name:'confirmed-contract.pdf',mimeType:'application/pdf',size:1,storageKey:'fixture/contract',createdAt:ctx.now});
 const run=(command:MistCommand,actor=ctx)=>{const result=applyMistCommand(state,command,actor);state=result.state;return result.result;};
 const orderId=run({type:'order.create',payload:{type:'garment',customerId:'customer',season:'AW',currency:'USD',due:'2026-12-01',owner:'业务',governance:{kind:'external',poNumber:'TEST-PO',confirmationFileIds:['contract'],internalPurpose:'',receiver:'',paymentMethod:'TT',depositPercent:30,paymentNote:'30%定金，余款按合同',incoterm:'FOB',deliveryPlace:'上海'},lines:[{name:'实际商品',style:'A',qty:1,unit:'件',price:amount,img:'coat'}]}}).orderId!;
 run({type:'order.governance.submit',payload:{orderId}});run({type:'order.governance.decide',payload:{id:orderId,decision:'approved',note:'核对已签合同主单'}},{...ctx,actorId:'reviewer'});
 return{ctx,orderId,run,get state(){return state;}};
}
describe('Mist workspace domain integrity',()=>{
  it('retains factory identity when a B version is revised',()=>{
    const ctx=context(),s=createMistState(ctx),v=s.versions.find(v=>v.label.includes('-B-'))!;
    const result=applyMistCommand(s,{type:'development.revise',payload:{devId:v.devId,versionId:v.id,note:'新一轮比样'}},ctx);
    const next=result.state.versions.find(v=>v.id===result.result.versionId)!;
    expect(next.factory).toBe(v.factory);expect(next.label).toMatch(/^R\d+-B-1$/);expect(next.returnedAt).toBeNull();expect(next.qc).toBeNull();expect(next.confirmations).toEqual([]);
  });
  it('locks archived physical and QC facts while allowing a new revision',()=>{
    const ctx=context(),s=createMistState(ctx),v=s.versions.find(v=>v.qc?.result==='pass')!;
    const {state}=applyMistCommand(s,{type:'development.archive',payload:{devId:v.devId,versionId:v.id}},ctx);
    const commands:MistCommand[]=[
      {type:'development.recordSample',payload:{devId:v.devId,versionId:v.id,sample:'replacement',quantity:1,returnedAt:ctx.now}},
      {type:'development.recordQc',payload:{devId:v.devId,versionId:v.id,qc:{result:'reject',reviewer:'QC',reviewedAt:ctx.now,report:'new',opinion:'changed'}}},
      {type:'development.confirm',payload:{devId:v.devId,versionId:v.id,result:'rejected',confirmer:'client',organization:'customer',confirmedAt:ctx.now,basis:'later',originalText:''}},
    ];
    for(const command of commands)expect(()=>applyMistCommand(state,command,ctx)).toThrow(MistCommandError);
    expect(state.versions.find(x=>x.id===v.id)?.qc?.result).toBe('pass');
    expect(applyMistCommand(state,{type:'development.revise',payload:{devId:v.devId,versionId:v.id,note:'继续开发'}},ctx).state.versions.length).toBe(state.versions.length+1);
  });
  it('does not replace a sample whose professional evidence already exists',()=>{
    const ctx=context(),s=createMistState(ctx),v=s.versions.find(v=>v.qc)!;
    expect(()=>applyMistCommand(s,{type:'development.recordSample',payload:{devId:v.devId,versionId:v.id,sample:'new sample',quantity:2,returnedAt:ctx.now}},ctx)).toThrow(/新版本/);
  });
  it('invalid dates return domain validation rather than an uncaught RangeError',()=>{
    const ctx=context(),s=createMistState(ctx);
    for(const date of ['2026-99-99','2026-02-30','tomorrow'])expect(()=>applyMistCommand(s,{type:'calendar.save',payload:{title:'测试',date,time:'10:00',note:''}},ctx)).toThrow(MistCommandError);
  });
  it('rejects invalid minute values',()=>{
    const ctx=context(),s=createMistState(ctx);
    for(const time of ['10:99','24:00','9:01'])expect(()=>applyMistCommand(s,{type:'calendar.save',payload:{title:'测试',date:'2026-10-13',time,note:''}},ctx)).toThrow(MistCommandError);
  });
  it('reconciles exact minor units once and rejects over-allocation without changing source',()=>{
    const ctx=context();let s=createMistState(ctx);const invoice=s.invoices.find(x=>x.open>0)!;
    s=applyMistCommand(s,{type:'finance.importReceipts',payload:{receipts:[{date:'2026-10-13',payer:invoice.customer,amount:0.3,currency:invoice.currency,ref:'precision'}]}},ctx).state;
    const receipt=s.receipts.find(x=>x.ref==='precision')!;
    const a=applyMistCommand(s,{type:'finance.reconcile',payload:{receiptId:receipt.id,invoiceId:invoice.id,amount:0.1}},ctx).state;
    const b=applyMistCommand(a,{type:'finance.reconcile',payload:{receiptId:receipt.id,invoiceId:invoice.id,amount:0.2}},ctx).state;
    expect(b.receipts.find(x=>x.id===receipt.id)?.remaining).toBe(0);
    expect(mistMoneyMinor(invoice.open)-mistMoneyMinor(b.invoices.find(x=>x.id===invoice.id)!.open)).toBe(30);
    expect(()=>applyMistCommand(b,{type:'finance.reconcile',payload:{receiptId:receipt.id,invoiceId:invoice.id,amount:0.01}},ctx)).toThrow(MistCommandError);
    expect(s.receipts.find(x=>x.id===receipt.id)?.remaining).toBe(0.3);
  });
  it('keeps demand confirmation separate from archive and revision creation',()=>{
    const ctx=context(),s=createMistState(ctx),v=s.versions.find(v=>v.returnedAt)!;
    const result=applyMistCommand(s,{type:'development.confirm',payload:{devId:v.devId,versionId:v.id,result:'approved',confirmer:'实际客户',organization:'客户',confirmedAt:ctx.now,basis:'签样单',originalText:'同意此版本'}},ctx);
    expect(result.state.versions.length).toBe(s.versions.length);expect(result.state.versions.find(x=>x.id===v.id)?.archivedAt).toBeNull();expect(s.versions.find(x=>x.id===v.id)?.confirmations).toHaveLength(0);
  });
  it('rolls partial and complete physical shipment facts back to the source order',()=>{
    const ctx=context(),s=createMistState(ctx),order=s.orders.find(o=>o.code==='SO-G-2026-018')!,lines=s.orderLines.filter(l=>l.orderId===order.id);
    s.fulfillment.shipments.push({id:'physical-shipment',state:'departed',lines:[{orderId:order.id,lineId:lines[0].id,quantity:lines[0].qty/2}]} as any);
    let result=applyMistCommand(s,{type:'settings.update',payload:{density:'compact'}},ctx).state;
    expect(result.orders.find(o=>o.id===order.id)?.state).toBe('部分出运');
    result.fulfillment.shipments.find(x=>x.id==='physical-shipment')!.lines=lines.map(l=>({orderId:order.id,lineId:l.id,quantity:l.qty,factoryConfirmedAt:'2026-10-13'}));
    result=applyMistCommand(result,{type:'settings.update',payload:{density:'default'}},ctx).state;
    expect(result.orders.find(o=>o.id===order.id)?.state).toBe('待收尾款');
    expect(order.state).not.toBe('部分出运');
  });
});

describe('core action audit',()=>{
  it('clears an existing calendar association when the saved replacement omits it',()=>{const ctx=context(),state=createMistState(ctx,'empty');state.calendar.push({id:'event',title:'原日程',date:'2026-10-13',time:'09:00',note:'',target:{view:'development/detail',id:'development',versionId:'version'}});const result=applyMistCommand(state,{type:'calendar.save',payload:{id:'event',title:'去掉关联',date:'2026-10-13',time:'09:00',note:''}},ctx);expect(result.state.calendar[0]).not.toHaveProperty('target');expect(state.calendar[0].target?.versionId).toBe('version');});
  it('reports imported and skipped rows rather than claiming duplicates were all imported',()=>{const ctx=context(),state=createMistState(ctx,'empty'),row={date:'2026-10-13',payer:'真实付款人',amount:1,currency:'USD',ref:'唯一银行参考'};const first=applyMistCommand(state,{type:'finance.importReceipts',payload:{receipts:[row,row]}},ctx);expect(first.result).toEqual({imported:1,skipped:1});const second=applyMistCommand(first.state,{type:'finance.importReceipts',payload:{receipts:[row]}},ctx);expect(second.result).toEqual({imported:0,skipped:1});expect(second.state.receipts).toHaveLength(1);});
  it('rejects invalid payment currency before publishing a voucher',()=>{const ctx=context(),state=createMistState(ctx,'empty');expect(()=>applyMistCommand(state,{type:'finance.payment.save',payload:{date:'2026-10-13',payee:'供应商',amount:1,currency:'12#',ref:''}},ctx)).toThrow('币种');expect(state.payments).toHaveLength(0);});
  it('does not allocate a bank receipt to an invoice of another currency',()=>{const ctx=context(),state=createMistState(ctx,'empty');state.invoices.push({id:'invoice',code:'INV',orderId:'order',order:'ORDER',customer:'客户',due:'2026-10-13',amount:10,open:10,currency:'USD'});const imported=applyMistCommand(state,{type:'finance.importReceipts',payload:{receipts:[{date:'2026-10-13',payer:'客户',amount:10,currency:'EUR',ref:'EUR-REF'}]}},ctx).state;expect(()=>applyMistCommand(imported,{type:'finance.reconcile',payload:{receiptId:imported.receipts[0].id,invoiceId:'invoice'}},ctx)).toThrow('币种不同');expect(imported.allocations).toHaveLength(0);});
  it('keeps logistics handoff separate from a physical shipment and formal documents',()=>{
    const f=approvedOrderFixture(),order=f.state.orders[0];
    expect(()=>f.run({type:'order.handoff',payload:{orderId:f.orderId}})).toThrow('拟发范围');
    for(const item of order.checklist.filter(item=>['拟发范围确认','收货与贸易条款确认','收款条件核对'].includes(item.label)))f.run({type:'order.checklist',payload:{orderId:f.orderId,itemId:item.id,done:true}});
    const shipCount=f.state.fulfillment.shipments.length,docCount=f.state.fulfillment.documents.length;
    f.run({type:'order.handoff',payload:{orderId:f.orderId,note:'仅资料交接'}});const count=f.state.tasks.length;f.run({type:'order.handoff',payload:{orderId:f.orderId}});
    expect(f.state.tasks).toHaveLength(count);expect(f.state.orders.find(row=>row.id===f.orderId)?.handoffAt).toBe(f.ctx.now);expect(f.state.fulfillment.shipments).toHaveLength(shipCount);expect(f.state.fulfillment.documents).toHaveLength(docCount);
  });
});
it('requires explicit payer relationship evidence for a different customer name',()=>{
 const f=approvedOrderFixture(10),draft=f.run({type:'platform.invoice.save',payload:{orderId:f.orderId,due:'2026-10-13',amount:10,note:'实际合同票据'}}).id!;
 const invoiceId=f.run({type:'platform.invoice.issue',payload:{id:draft}}).invoiceId!;
 f.run({type:'finance.importReceipts',payload:{receipts:[{date:'2026-10-13',payer:'实际代付方',amount:10,currency:'USD',ref:'THIRD-PARTY'}]}});const receiptId=f.state.receipts[0].id;
 expect(()=>f.run({type:'finance.reconcile',payload:{receiptId,invoiceId}})).toThrow('付款方关系依据');
 f.run({type:'finance.reconcile',payload:{receiptId,invoiceId,payerBasis:'客户书面确认由母公司代付'}});expect(f.state.allocations[0].payerBasis).toBe('客户书面确认由母公司代付');
});
it('does not silently discard identical amounts when no bank reference exists',()=>{const ctx=context(),state=createMistState(ctx,'empty'),row={date:'2026-10-13',payer:'客户',amount:10,currency:'USD',ref:''};const result=applyMistCommand(state,{type:'finance.importReceipts',payload:{receipts:[row,row]}},ctx);expect(result.result).toEqual({imported:2,skipped:0});expect(result.state.receipts).toHaveLength(2);});
describe('finance reversals keep the original fact and recompute balances',()=>{
 const setup=()=>{const f=approvedOrderFixture(10),draft=f.run({type:'platform.invoice.save',payload:{orderId:f.orderId,due:'2026-10-13',amount:10,note:'实际合同票据'}}).id!;
  const invoiceId=f.run({type:'platform.invoice.issue',payload:{id:draft}}).invoiceId as string;
  f.run({type:'finance.importReceipts',payload:{receipts:[{date:'2026-10-13',payer:'客户公司',amount:10,currency:'USD',ref:'R-1'}]}});const receiptId=f.state.receipts[0].id;
  f.run({type:'finance.reconcile',payload:{receiptId,invoiceId,amount:10}});return{ctx:f.ctx,s:f.state,receiptId,invoiceId};};
 it('reverses an allocation with a reason, preserves the original record and restores both balances',()=>{
  const {ctx,s,receiptId,invoiceId}=setup(),allocation=s.allocations[0];expect(s.receipts[0].state).toBe('matched');
  expect(()=>applyMistCommand(s,{type:'finance.allocation.reverse',payload:{allocationId:allocation.id,reason:'  '}},ctx)).toThrow('冲回原因');
  const next=applyMistCommand(s,{type:'finance.allocation.reverse',payload:{allocationId:allocation.id,reason:'核错发票'}},ctx).state;
  expect(next.allocations).toHaveLength(0);expect(next.financeReversals).toHaveLength(1);
  expect(next.financeReversals![0]).toMatchObject({kind:'allocation',targetId:allocation.id,reason:'核错发票',allocation});
  expect(next.receipts.find(r=>r.id===receiptId)).toMatchObject({remaining:10,state:'unmatched'});expect(next.invoices.find(i=>i.id===invoiceId)!.open).toBe(10);
  expect(next.events[0].text).toContain('核错发票');expect(s.allocations).toHaveLength(1);
  expect(()=>applyMistCommand(next,{type:'finance.allocation.reverse',payload:{allocationId:allocation.id,reason:'再次'}},ctx)).toThrow('不存在');
  const again=applyMistCommand(next,{type:'finance.reconcile',payload:{receiptId,invoiceId,amount:4}},ctx).state;
  expect(again.receipts.find(r=>r.id===receiptId)!.remaining).toBe(6);expect(again.invoices.find(i=>i.id===invoiceId)!.open).toBe(6);expect(again.financeReversals).toHaveLength(1);
 });
 it('reverses a finance voucher once with a negative counter voucher and leaves the original untouched',()=>{
  const ctx=context();let s=createMistState(ctx,'empty');s=applyMistCommand(s,{type:'finance.payment.save',payload:{date:'2026-10-13',payee:'物流商',amount:88.5,currency:'USD',ref:'P-1'}},ctx).state;const original=s.payments[0];
  expect(original.origin).toBe('finance');
  const result=applyMistCommand(s,{type:'finance.payment.reverse',payload:{paymentId:original.id,reason:'重复登记'}},ctx);const next=result.state;
  expect(next.payments).toHaveLength(2);expect(next.payments[0]).toEqual(original);
  expect(next.payments[1]).toMatchObject({amount:-88.5,currency:'USD',payee:'物流商',reversalOf:original.id});expect(next.payments[1].ref).toContain('重复登记');
  expect(next.financeReversals![0]).toMatchObject({kind:'payment',targetId:original.id,voucherId:next.payments[1].id});
  expect(()=>applyMistCommand(next,{type:'finance.payment.reverse',payload:{paymentId:original.id,reason:'再冲'}},ctx)).toThrow('已冲回');
  expect(()=>applyMistCommand(next,{type:'finance.payment.reverse',payload:{paymentId:next.payments[1].id,reason:'再冲'}},ctx)).toThrow('反向');
 });
 it('leaves supplier payment vouchers to the payables reversal flow',()=>{
  const ctx=context(),s=createMistState(ctx,'empty');s.payments.push({id:'voucher',code:'PAY-1',date:'2026-10-13',payee:'工厂',amount:5,currency:'CNY',ref:'X'});
  s.payables={...(s.payables||{bills:[],payments:[],allocations:[]}),payments:[{id:'sp',paymentId:'voucher'} as any]};
  expect(()=>applyMistCommand(s,{type:'finance.payment.reverse',payload:{paymentId:'voucher',reason:'错'}},ctx)).toThrow('应付页');
 });
 it('keeps bank accounts with opening balances and per-flow attribution; balance = opening + receipts - payments',()=>{
  const ctx=context();let s=createMistState(ctx,'empty');const run=(c:any)=>{const r=applyMistCommand(s,c,ctx);s=r.state;return r.result;};
  const today=ctx.now.slice(0,10);
  expect(mistBankAccountBalances(s)).toEqual({accounts:[],unassigned:{receipts:0,payments:0}});
  expect(()=>run({type:'finance.account.save',payload:{name:'美元户',bankName:'中行',accountNo:'12 34',currency:'USD',openingDate:today,openingBalance:1}})).not.toThrow();
  const usd=s.bankAccounts![0];expect(usd).toMatchObject({code:'BA-001',accountNo:'1234',currency:'USD',openingBalance:1});
  expect(()=>run({type:'finance.account.save',payload:{name:'重复',bankName:'中行',accountNo:'1234',currency:'USD',openingDate:today,openingBalance:0}})).toThrow('已登记');
  expect(()=>run({type:'finance.account.save',payload:{name:'坏',bankName:'中行',accountNo:'99999',currency:'USD',openingDate:today,openingBalance:1.234}})).toThrow('两位小数');
  run({type:'finance.account.save',payload:{id:usd.id,name:'美元户',bankName:'中行',accountNo:'1234',currency:'USD',openingDate:'2026-01-01',openingBalance:-100.5}});
  expect(s.bankAccounts![0]).toMatchObject({openingBalance:-100.5,openingDate:'2026-01-01'});
  run({type:'finance.account.save',payload:{name:'人民币户',bankName:'工行',accountNo:'5678',currency:'CNY',openingDate:'2026-01-01',openingBalance:0}});
  run({type:'finance.importReceipts',payload:{receipts:[{date:'2026-02-01',payer:'客户',amount:1000,currency:'USD',ref:'R1'},{date:'2025-12-31',payer:'客户',amount:5,currency:'USD',ref:'R0'}]}});
  run({type:'finance.payment.save',payload:{date:'2026-02-02',payee:'物流',amount:200.25,currency:'USD',ref:'P1'}});
  const [r1,r0]=s.receipts,p1=s.payments[0],cny=s.bankAccounts![1];
  expect(()=>run({type:'finance.account.assign',payload:{kind:'receipt',id:r1.id,accountId:cny.id}})).toThrow('币种');
  expect(()=>run({type:'finance.account.assign',payload:{kind:'receipt',id:r0.id,accountId:usd.id}})).toThrow('期初');
  run({type:'finance.account.assign',payload:{kind:'receipt',id:r1.id,accountId:usd.id}});run({type:'finance.account.assign',payload:{kind:'payment',id:p1.id,accountId:usd.id}});
  let b=mistBankAccountBalances(s);expect(b.accounts[0]).toMatchObject({balance:699.25,receipts:1000,payments:200.25,receiptCount:1,paymentCount:1});expect(b.unassigned).toEqual({receipts:1,payments:0});
  expect(()=>run({type:'finance.account.save',payload:{id:usd.id,name:'美元户',bankName:'中行',accountNo:'1234',currency:'USD',openingDate:'2026-01-01',openingBalance:0}})).toThrow('期初不能修改');
  run({type:'finance.account.save',payload:{id:usd.id,name:'美元收款户',bankName:'中国银行',accountNo:'1234',currency:'USD',openingDate:'2026-01-01',openingBalance:-100.5}});expect(s.bankAccounts![0].name).toBe('美元收款户');
  run({type:'finance.payment.reverse',payload:{paymentId:p1.id,reason:'重复'}});expect(s.payments[1].accountId).toBe(usd.id);
  b=mistBankAccountBalances(s);expect(b.accounts[0].balance).toBe(899.5);
  expect(()=>run({type:'finance.account.assign',payload:{kind:'receipt',id:r1.id,accountId:null}})).toThrow('调整原因');
  run({type:'finance.account.assign',payload:{kind:'receipt',id:r1.id,accountId:null,reason:'归错账户'}});expect(s.receipts[0].accountId).toBeUndefined();expect(s.events[0].text).toContain('归错账户');
  expect(mistBankAccountBalances(s).accounts[0].balance).toBe(-100.5);
  expect(mistCommandPermission({type:'finance.account.save',payload:{} as any})).toBe('vouchers:write');
  expect(mistCommandPermission({type:'finance.account.assign',payload:{} as any})).toBe('vouchers:write');
 });
 it('maps reversal permissions to the existing finance scopes',()=>{
  expect(mistCommandPermission({type:'finance.allocation.reverse',payload:{allocationId:'a',reason:'r'}})).toBe('invoices:reconcile');
  expect(mistCommandPermission({type:'finance.payment.reverse',payload:{paymentId:'p',reason:'r'}})).toBe('vouchers:write');
 });
});
