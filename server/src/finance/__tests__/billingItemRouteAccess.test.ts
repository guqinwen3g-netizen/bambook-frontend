import {describe,it,expect,vi,beforeEach} from 'vitest';
import express from 'express';
import request from 'supertest';
const m=vi.hoisted(()=>({where:vi.fn(),access:vi.fn(),list:vi.fn(),confirm:vi.fn(),invoice:vi.fn(),patch:vi.fn(),cancel:vi.fn(),get:vi.fn()}));
vi.mock('../../auth/moduleGuard',()=>({createModuleAuthGuard:()=> (req:any,_res:any,next:any)=>{req.actor={userId:'u'};req.authSource='user-session';next();},requireJwtForWrite:()=> (_req:any,_res:any,next:any)=>next()}));
vi.mock('../../auth/permissionGuard',()=>({requirePermission:()=> (_req:any,_res:any,next:any)=>next()}));
vi.mock('../../development/developmentBillingRouteAccess',()=>({developmentBillingReadWhere:m.where,assertDevelopmentBillingRouteAccess:m.access}));
vi.mock('../billingItemService',()=>({listBillingItems:m.list,getBillingItem:m.get,confirmBillingItem:m.confirm,invoiceBillingItem:m.invoice,updateBillingItem:m.patch,cancelBillingItem:m.cancel}));
import {createBillingItemRouter,type BillingRouterOptions} from '../billingItemRoute';
import {logger} from '../../lib/logger';
function app(onDataChange?:BillingRouterOptions['onDataChange']){const app=express();app.use(express.json());app.use(createBillingItemRouter({prisma:{} as any,requireAuth:true,onDataChange}));return app;}
beforeEach(()=>{vi.clearAllMocks();m.where.mockResolvedValue({sourceId:{in:['allowed']}});m.access.mockResolvedValue({id:'b',developmentExpenseReviewId:'review'});m.list.mockResolvedValue({ok:true,data:{billingItems:[],total:0}});});
describe('收费入口范围与交接门禁',()=>{
 it('分页与数量使用服务端范围，不接受请求覆盖',async()=>{const r=await request(app()).get('/?accessWhere=all&sourceId=hidden');expect(r.status).toBe(200);expect(m.list).toHaveBeenCalledWith(expect.objectContaining({accessWhere:{sourceId:{in:['allowed']}},query:expect.objectContaining({sourceId:'hidden'})}));});
 it('整案收费不能用旧确认动作绕过选财务接手人',async()=>{const r=await request(app()).post('/b/confirm');expect(r.status).toBe(409);expect(r.body.error.code).toBe('FINANCE_HANDOFF_REQUIRED');expect(m.confirm).not.toHaveBeenCalled();});
 it.each([['get','/b'],['patch','/b'],['post','/b/invoice'],['post','/b/cancel']] as const)('%s %s先检查范围',async(method,url)=>{m.access.mockRejectedValue(Object.assign(new Error('无权操作'),{status:404,statusCode:404,code:'BILLING_NOT_ACCESSIBLE'}));const r=await request(app())[method](url);expect(r.status).toBe(404);for(const fn of [m.get,m.patch,m.invoice,m.cancel])expect(fn).not.toHaveBeenCalled();});
 it('权限查询异常返回失败，不回空列表',async()=>{m.where.mockRejectedValue(Error('secret connection'));const r=await request(app()).get('/');expect(r.status).toBe(500);expect(JSON.stringify(r.body)).not.toContain('secret connection');expect(m.list).not.toHaveBeenCalled();});
 it.each([false,true])('实际应收成功或同源恢复均通知真实发票id（recovered=%s）',async recovered=>{
  const onDataChange=vi.fn();m.invoice.mockResolvedValue({ok:true,data:{billingItem:{id:'b',status:'invoiced'},invoice:{id:'actual-invoice'},recovered}});
  const r=await request(app(onDataChange)).post('/b/invoice');
  expect(r.status).toBe(recovered?200:201);expect(r.body).toMatchObject({ok:true,billingItem:{id:'b',status:'invoiced'},invoice:{id:'actual-invoice'},recovered});
  expect(onDataChange.mock.calls).toEqual([[{entity:'billing-items',action:'invoice',ids:['actual-invoice']}],[{entity:'invoices',action:'invoice',ids:['actual-invoice']}]]);
 });
 it('失败不会派发任何收费或发票成功事件',async()=>{
  const onDataChange=vi.fn();m.invoice.mockResolvedValue({ok:false,error:{code:'INVALID_STATE',message:'当前状态不可开票',status:409}});
  const r=await request(app(onDataChange)).post('/b/invoice');expect(r.status).toBe(409);expect(r.body.error.code).toBe('INVALID_STATE');expect(onDataChange).not.toHaveBeenCalled();
 });
 it('无应收闭环只保留收费事件，不虚构发票事件',async()=>{
  const onDataChange=vi.fn();m.invoice.mockResolvedValue({ok:true,data:{billingItem:{id:'b',status:'invoiced'},noReceivable:true}});
  const r=await request(app(onDataChange)).post('/b/invoice');expect(r.status).toBe(201);expect(r.body).toMatchObject({ok:true,noReceivable:true});
  expect(onDataChange.mock.calls).toEqual([[{entity:'billing-items',action:'invoice',ids:['b']}]]);
 });
 it('通知异常只记录日志，不反转已提交成功，第二个域仍尝试通知',async()=>{
  const onDataChange=vi.fn(()=>{throw Error('synthetic realtime outage');});
  const log=vi.spyOn(logger,'error').mockImplementation(()=>{});
  try{
   m.invoice.mockResolvedValue({ok:true,data:{billingItem:{id:'b',status:'invoiced'},invoice:{id:'actual-invoice'},recovered:false}});
   const r=await request(app(onDataChange)).post('/b/invoice');expect(r.status).toBe(201);expect(r.body).toMatchObject({ok:true,invoice:{id:'actual-invoice'}});
   expect(onDataChange.mock.calls).toEqual([[{entity:'billing-items',action:'invoice',ids:['actual-invoice']}],[{entity:'invoices',action:'invoice',ids:['actual-invoice']}]]);
   expect(log).toHaveBeenCalledTimes(2);expect(log).toHaveBeenCalledWith('[billing-items/notify] failed after commit',expect.objectContaining({error:expect.any(Error)}));
  }finally{log.mockRestore();}
 });
});

it('开票只传递服务端身份，请求 actorId 不能替换调用主体（route seam）',async()=>{
 m.invoice.mockResolvedValue({ok:true,data:{billingItem:{id:'b'},invoice:{id:'inv'},recovered:false}});
 const r=await request(app()).post('/b/invoice').send({actorId:'attacker',trustedActor:{userId:'attacker'}});
 expect(r.status).toBe(201);
 expect(m.invoice).toHaveBeenCalledWith(expect.objectContaining({actorId:'u',trustedActor:{userId:'u'}}));
});
