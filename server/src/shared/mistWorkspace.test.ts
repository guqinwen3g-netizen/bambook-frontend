import {describe,expect,it} from 'vitest';
import {applyMistCommand,createMistState,MistCommandError,mistMoneyMinor,type MistCommand,type MistContext} from './mistWorkspace';
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
