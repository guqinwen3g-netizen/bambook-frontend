import {describe,it,expect,vi,beforeEach} from 'vitest';
import express from 'express';
import request from 'supertest';
const m=vi.hoisted(()=>({access:vi.fn(),where:vi.fn(),preview:vi.fn(),create:vi.fn()}));
vi.mock('../../auth/moduleGuard',()=>({createModuleAuthGuard:()=> (req:any,_res:any,next:any)=>{req.actor={userId:'u'};req.authSource='user-session';next();},requireJwtForWrite:()=> (_req:any,_res:any,next:any)=>next()}));
vi.mock('../../auth/permissionGuard',()=>({requirePermission:()=> (_req:any,_res:any,next:any)=>next()}));
vi.mock('../../development/developmentBillingRouteAccess',()=>({assertDevelopmentBillingSourceAccess:m.access,developmentBillingReadWhere:m.where}));
vi.mock('../sceneInvoiceService',()=>({previewSceneInvoice:m.preview,createSceneInvoice:m.create}));
import {createSceneInvoiceRouter} from '../sceneInvoiceRoute';
function app(sample:any=null){const app=express();app.use(express.json());app.use(createSceneInvoiceRouter({prisma:{sample:{findFirst:async()=>sample}} as any,requireAuth:true}));return app;}
beforeEach(()=>{vi.clearAllMocks();m.access.mockResolvedValue(undefined);m.where.mockResolvedValue({sourceId:{in:['allowed']}});m.preview.mockResolvedValue({ok:true,data:{rows:[],total:0}});});
describe('场景费用权限及整案收费边界',()=>{
 it('无权来源在读取标题和费用前拒绝',async()=>{m.access.mockRejectedValue(Object.assign(Error('无权'),{status:404,statusCode:404,code:'BILLING_NOT_ACCESSIBLE'}));expect((await request(app()).post('/preview').send({scene:'dev_cost',sourceId:'hidden'})).status).toBe(404);expect(m.preview).not.toHaveBeenCalled();});
 it('预览提供整案办理提示且传递服务端范围',async()=>{const r=await request(app()).post('/preview').send({scene:'dev_cost',sourceId:'c'});expect(r.status).toBe(200);expect(r.body.wholeCaseBilling.caseId).toBe('c');expect(m.preview).toHaveBeenCalledWith(expect.objectContaining({accessWhere:{sourceId:{in:['allowed']}}}));});
 it.each(['dev_cost','fabric'])('%s不能通过成本行直接开票',async scene=>{const r=await request(app()).post('/create').send({scene,sourceId:'c',lineIds:['cost']});expect(r.status).toBe(409);expect(r.body.error.code).toBe('WHOLE_CASE_BILLING_REQUIRED');expect(m.create).not.toHaveBeenCalled();});
 it('开发样品也不能绕过整案',async()=>{const r=await request(app({type:'dev',sourceCaseId:'c'})).post('/create').send({scene:'sample',sourceId:'s',lineIds:['cost']});expect(r.status).toBe(409);expect(m.create).not.toHaveBeenCalled();});
 it('权限查询失败不返回空预览',async()=>{m.access.mockRejectedValue(Error('DB private'));const r=await request(app()).post('/preview').send({scene:'sample',sourceId:'s'});expect(r.status).toBe(500);expect(JSON.stringify(r.body)).not.toContain('DB private');});
 it.each(['/preview','/create'])('%s 的服务异常有明确响应且不泄漏数据库信息',async path=>{
  m.preview.mockRejectedValue(Error('private SQL password'));
  m.create.mockRejectedValue(Error('private SQL password'));
  const r=await request(app()).post(path).send({scene:'order',sourceId:'o',lineIds:['cost']});
  expect(r.status).toBe(500);expect(r.body.ok).toBe(false);expect(r.body.error.code).toBe(path==='/preview'?'SCENE_INVOICE_PREVIEW_FAILED':'SCENE_INVOICE_CREATE_FAILED');expect(JSON.stringify(r.body)).not.toContain('private');
 });
});

it('场景开票传递真实服务端身份，body 身份不是 trustedActor（route seam）',async()=>{
 m.create.mockResolvedValue({ok:true,data:{invoice:{id:'inv'},lines:[]}});
 const r=await request(app()).post('/create').send({scene:'order',sourceId:'o',lineIds:['cost'],actorId:'attacker',trustedActor:{userId:'attacker'}});
 expect(r.status).toBe(201);
 expect(m.create).toHaveBeenCalledWith(expect.objectContaining({actorId:'u',trustedActor:{userId:'u'}}));
});
