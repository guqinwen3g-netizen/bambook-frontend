import {it,expect,vi,beforeEach} from 'vitest';import express from 'express';import request from 'supertest';
import {createDevelopmentCostEvidenceRouter} from '../developmentCostEvidenceRoute';
const m=vi.hoisted(()=>({add:vi.fn(),read:vi.fn(),list:vi.fn(),revoke:vi.fn(),business:vi.fn(),finance:vi.fn()}));
vi.mock('../developmentCostEvidenceService',()=>({addDevelopmentCostEvidence:m.add,readDevelopmentCostEvidence:m.read,listDevelopmentCostEvidence:m.list,revokeDevelopmentCostEvidence:m.revoke}));
vi.mock('../developmentExpenseAccess',()=>({assertDevelopmentExpenseAccess:m.business,assertDevelopmentFinanceRecipient:m.finance}));
function app(scopes:string[],source='user-session'){
 const a=express();a.use(express.json());a.use((req,_res,next)=>{Object.assign(req,{actor:{userId:'u',permissions:scopes,roles:[]},authSource:source});next();});
 const db:any={$transaction:async(fn:any)=>fn(db),workAssignment:{findFirst:vi.fn(async()=>({metadata:{managedBy:'development_cost_closure',kind:'finance_review',caseId:'d',reviewId:'r'}}))},developmentExpenseReview:{findFirst:vi.fn(async()=>({snapshot:{costs:{records:[{id:'c',evidence:[{id:'e'}]}]}}}))}};
 a.use(createDevelopmentCostEvidenceRouter({prisma:db}));return {a,db};
}
beforeEach(()=>{vi.clearAllMocks();m.business.mockResolvedValue({});m.finance.mockResolvedValue({});m.add.mockResolvedValue({id:'e'});m.list.mockResolvedValue([]);m.read.mockImplementation(async(ctx,c)=>{await ctx.authorize(ctx.prisma,c);return {bytes:Buffer.from('private'),evidence:{originalName:'bill.pdf'}};});});
it('匿名与无写权限拒绝上传，授权业务会话才调用服务',async()=>{
 const path='/d/costs/c/evidence';
 expect((await request(app(['products:write'],'api-key').a).post(path)).status).toBe(401);
 expect((await request(app(['products:read']).a).post(path)).status).toBe(403);
 const f=app(['products:write']);const r=await request(f.a).post(path).field('requestKey','k').field('note','账单').attach('file',Buffer.from('%PDF-1.7'),'bill.pdf');
 expect(r.status).toBe(200);expect(m.add).toHaveBeenCalledWith(expect.objectContaining({actorId:'u'}),'d','c',expect.objectContaining({requestKey:'k',note:'账单'}));
 m.business.mockRejectedValueOnce(Object.assign(Error('denied'),{status:403,code:'FORBIDDEN'}));m.add.mockClear();
 expect((await request(f.a).post(path).attach('file',Buffer.from('%PDF-1.7'),'bill.pdf')).status).toBe(403);expect(m.add).not.toHaveBeenCalled();
});
it('财务下载入口不要求开发权限，仍复核当轮任务和接手资格',async()=>{
 const f=app(['invoices:read']);const r=await request(f.a).get('/finance-tasks/t/costs/c/evidence/e/download');
 expect(r.status).toBe(200);expect(r.headers['content-disposition']).toContain('attachment');expect(r.headers['cache-control']).toBe('private, no-store');expect(r.headers['x-content-type-options']).toBe('nosniff');
 expect(f.db.workAssignment.findFirst).toHaveBeenCalledWith({where:{id:'t',userId:'u',deletedAt:null}});expect(m.finance).toHaveBeenCalledWith(f.db,'d','u');
});
it('其他轮次或别人的任务不能读取文件，当前权限撤销立即拒绝',async()=>{
 const f=app(['invoices:read']);const url='/finance-tasks/t/costs/c/evidence/other/download';expect((await request(f.a).get(url)).status).toBe(404);expect(m.read).not.toHaveBeenCalled();
 f.db.workAssignment.findFirst.mockResolvedValueOnce(null);expect((await request(f.a).get('/finance-tasks/t/costs/c/evidence/e/download')).status).toBe(404);
 m.finance.mockRejectedValueOnce(Object.assign(Error('失权'),{status:400,code:'INVALID_FINANCE_RECIPIENT'}));expect((await request(f.a).get('/finance-tasks/t/costs/c/evidence/e/download')).status).toBe(400);expect(m.read).not.toHaveBeenCalled();
});
