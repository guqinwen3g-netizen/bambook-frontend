import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const pdf = vi.hoisted(() => ({ fault: undefined as unknown, calls: 0 }));
vi.mock('playwright', () => ({ chromium: { launch: async () => {
  pdf.calls++; if (pdf.fault !== undefined) throw pdf.fault;
  return { close: async () => {}, newContext: async () => ({ close: async () => {}, newPage: async () => ({ setContent: async () => {}, close: async () => {}, pdf: async () => Buffer.from('Synthetic PDF boundary bytes') }) }) };
} } }));
const loggers: Array<{ close: () => unknown }> = [];
afterEach(() => { vi.restoreAllMocks(); pdf.fault = undefined; pdf.calls = 0; for (const log of loggers.splice(0)) log.close(); });
const secret='SQL /private/consumer-boundary';
async function modules() {
  vi.resetModules();
  const [finance, mutation, templates, render, auth, log] = await Promise.all([
    import('../route'), import('../allocationMutationService'), import('../../templates/route'),
    import('../../templates/render'), import('../../auth/service'), import('../../lib/logger'),
  ]);
  loggers.push(log.logger); return { ...finance, ...mutation, ...templates, ...render, ...auth, ...log };
}
type M = Awaited<ReturnType<typeof modules>>;
const token=(m:M)=>m.createAuthService().signToken({userId:'synthetic-consumer-operator',roles:['finance'],departmentIds:[],permissions:['invoices:reconcile'],authorizationLoaded:true});
const fixed='核销未能保存，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对发票与凭证数据。';
function unknownPrisma(fault:unknown) { return { $transaction: vi.fn(async()=>{throw fault;}) } as any; }
function app(m:M,db:any,kind:'finance'|'templates') {
  const application=express();application.use(express.json());
  // Actual router/module/scope guards and signed synthetic credential. This
  // is a consumer error test, not index/current-DB/L2 authority acceptance.
  application.use(kind==='finance'?'/api/v1/finance':'/api/templates',kind==='finance'?m.createFinanceRouter({prisma:db,requireAuth:true,apiKeys:new Set()}):m.createTemplatesRouter({prisma:db,requireAuth:true,apiKeys:new Set()}));
  return application;
}
const input={invoiceId:'own-invoice',voucherId:'own-voucher',appliedAmount:'20'};
function actualFacts(kind:'missing'|'currency'|'supplier'|'refund'|'local-missing'|'local-changed') {
  let allocationReads=0;
  const tx:any={ $queryRawUnsafe:vi.fn(async(sql:string)=>kind==='supplier'&&sql.includes('SELECT *')?[{id:'one',type:'purchase'},{id:'two',type:'claim'}]:[]),
    creditNoteRefundReturn:{findUnique:vi.fn(async()=>null)},creditNoteRefund:{findUnique:vi.fn(async()=>kind==='refund'?{id:'actual-refund-source'}:null)},
    invoice:{findUnique:vi.fn(async()=>kind==='missing'?null:{id:'own-invoice',deletedAt:null,status:'Issued',type:'Receivable',currency:'USD',amount:'100',customerRelationId:'own-customer',customerName:'Synthetic customer'})},
    paymentVoucher:{findUnique:vi.fn(async()=>({id:'own-voucher',deletedAt:null,status:'pending',type:'Receipt',currency:'EUR',amount:'100',customerRelationId:'own-customer',customerName:'Synthetic customer'}))},
    invoiceAllocation:{findUnique:vi.fn(async()=>kind==='local-missing'?null:++allocationReads===1?{id:'own-allocation',invoiceId:'own-invoice',voucherId:'own-voucher',appliedAmount:'20'}:{id:'own-allocation',invoiceId:'changed',voucherId:'own-voucher',appliedAmount:'20'})},
  };
  return {db:{$transaction:vi.fn(async(work:any)=>work(tx))} as any,tx};
}
describe('Read-only actual consumer error boundary evidence',()=>{
  it('actual allocation HTTP must reject forged known-code SQL as safe500 rather than publish its claimed business refusal',async()=>{
    const m=await modules(),fault=Object.assign(new Error(secret),{code:'CURRENCY_MISMATCH',statusCode:400});
    const res=await request(app(m,unknownPrisma(fault),'finance')).post('/api/v1/finance/allocations').set('Authorization',`Bearer ${token(m)}`).send(input);
    expect(res.status).toBe(500);expect(res.body).toEqual({error:{code:'CREATE_FAILED',message:fixed}});expect(JSON.stringify(res.body)).not.toContain(secret);
  });
  it.each(['getter','proxy','logger'] as const)('actual allocation consumer keeps a fixed failure when unknown %s or diagnostic logging throws',async kind=>{
    const m=await modules();let fault:unknown=new Error(secret);
    if(kind==='getter')fault=Object.defineProperty(new Error(secret),'code',{get(){throw new Error('SQL getter');}});
    if(kind==='proxy')fault=new Proxy({}, {get(){throw new Error('SQL Proxy');}});
    if(kind==='logger')vi.spyOn(m.logger,'error').mockImplementation(()=>{throw new Error('SQL logger');});
    await expect(m.createAllocation({prisma:unknownPrisma(fault),input,actorId:'synthetic-consumer-operator'})).resolves.toEqual({ok:false,error:{code:'CREATE_FAILED',message:fixed}});
  });
  it.each([
    ['missing',404,'INVOICE_NOT_FOUND','发票不存在或已删除，请重新选择来源单据。'],
    ['currency',400,'CURRENCY_MISMATCH','currency mismatch: invoice USD vs voucher EUR'],
    ['supplier',409,'SOURCE_CLAIM_CONFLICT','索赔贷项的退料来源不唯一或类型不一致，请先核对来源。'],
    ['refund',409,'INVALID_STATE','客户实付退款凭证不可独立改写、核销、作废或删除；实际银行返款须走后续专用返款流程'],
  ] as const)('actual %s producer keeps its original tuple in allocation HTTP',async(kind,status,code,message)=>{
    const m=await modules(),{db,tx}=actualFacts(kind);const res=await request(app(m,db,'finance')).post('/api/v1/finance/allocations').set('Authorization',`Bearer ${token(m)}`).send(input);
    expect(res.status).toBe(status);expect(res.body).toEqual({error:{code,message}});expect(tx.$queryRawUnsafe).toHaveBeenCalled();
  });
  it.each(['update','delete'] as const)('local real %s NOT_FOUND and current-row conflict retain their original tuples',async operation=>{
    const m=await modules();
    for(const kind of ['local-missing','local-changed'] as const){const {db}=actualFacts(kind);const result=operation==='update'?await m.updateAllocation({prisma:db,allocationId:'own-allocation',input:{appliedAmount:'20'}}):await m.deleteAllocation({prisma:db,allocationId:'own-allocation'});
      expect(result).toEqual({ok:false,error:kind==='local-missing'?{code:'NOT_FOUND',message:'allocation not found'}:{code:'CONFLICT',message:'核销记录已变化，请刷新后重试。'}});
    }
  });
  it.each(['plain','forged-render'] as const)('actual PDF HTTP unknown %s must stay safe500 without class-shaped authority',async kind=>{
    const m=await modules();pdf.fault=kind==='plain'?new Error(secret):Object.setPrototypeOf(new Error(secret),m.TemplateRenderError.prototype);
    const res=await request(app(m,{},'templates')).post('/api/templates/invoice.sample.pdas/render.pdf').set('Authorization',`Bearer ${token(m)}`).send({data:{invoiceNumber:'own',items:[]}});
    expect(res.status).toBe(500);expect(res.body).toEqual({error:'InternalError',message:'服务器内部错误，请稍后重试。'});expect(JSON.stringify(res.body)).not.toContain(secret);expect(pdf.calls).toBe(1);
  });
  it('actual PDF main diagnostic failure must not replace its fixed HTTP failure',async()=>{
    const m=await modules();pdf.fault=new Error(secret);vi.spyOn(m.logger,'error').mockImplementation(()=>{throw new Error('SQL logger');});
    const res=await request(app(m,{},'templates')).post('/api/templates/invoice.sample.pdas/render.pdf').set('Authorization',`Bearer ${token(m)}`).send({data:{invoiceNumber:'own',items:[]}}).timeout({deadline:500});
    expect(res.status).toBe(500);expect(res.body).toEqual({error:'InternalError',message:'服务器内部错误，请稍后重试。'});
  });
  it('actual render factory failure remains safe422 and unknown template remains404',async()=>{
    const m=await modules();const a=app(m,{},'templates');
    const bad=await request(a).post('/api/templates/invoice.sample.pdas/render.pdf').set('Authorization',`Bearer ${token(m)}`).send({data:{items:{}}});
    expect(bad.status).toBe(422);expect(bad.body).toEqual({error:'TemplateRenderFailed',message:'服务器内部错误，请稍后重试。'});
    const missing=await request(a).post('/api/templates/own-missing/render.pdf').set('Authorization',`Bearer ${token(m)}`).send({data:{items:[]}});expect(missing.status).toBe(404);expect(missing.body).toEqual({error:'TemplateNotFound',id:'own-missing'});
  });
});
