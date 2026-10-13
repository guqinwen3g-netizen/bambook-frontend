import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDevelopmentClosureRouter } from '../developmentClosureRoute';
const m = vi.hoisted(() => ({ access: vi.fn(), preview: vi.fn(), lifecycle: vi.fn(), expenses: vi.fn(), confirm: vi.fn(), draft: vi.fn(), finance:vi.fn(),handoff:vi.fn(),workflow:vi.fn(),currentReview:vi.fn(),notification:vi.fn() }));
vi.mock('../developmentBillingWorkflowService',()=>({transitionDevelopmentBilling:m.workflow}));
vi.mock('../developmentFinanceHandoffService',()=>({confirmDevelopmentBillingAndHandoff:m.handoff}));
vi.mock('../developmentBillingDraftService',()=>({createDevelopmentBillingDraft:m.draft}));
vi.mock('../developmentExpenseAccess', () => ({ assertDevelopmentExpenseAccess: m.access,assertDevelopmentFinanceRecipient:m.finance,assertDevelopmentFinanceWriteAccess:(tx:any,actor:any,id:string)=>m.finance(tx,id,actor.userId) }));
vi.mock('../developmentClosureService', () => ({ previewDevelopmentClosure: m.preview, recordDevelopmentLifecycle: m.lifecycle, previewDevelopmentExpenseReview: m.expenses, confirmDevelopmentExpenseReview: m.confirm,assertDevelopmentExpenseReviewCurrentInTx:m.currentReview }));
vi.mock('../../realtime', () => ({ publishNotificationEvent: m.notification }));
function app(permissions = ['products:read', 'products:write'], source = 'user-session', authenticated = true, permissionCeiling?:string[]) {
 const db: any = { workAssignment:{findMany:vi.fn(async()=>[{id:'task',title:'客户秘密',status:'assigned',metadata:{kind:'finance_handoff',caseId:'d',billingItemId:'b'}}])},userAccount:{findMany:vi.fn(async()=>[{id:'recipient'}])},billingItem:{findMany:vi.fn(async()=>[]),findFirst:vi.fn(async()=>({id:'b',amount:'80'}))},$transaction:async(fn:any)=>fn(db) };
 const a = express(); a.use(express.json());
 a.use((req: any, _res, next) => { if (authenticated) req.actor = { userId: 'u', roles: [], permissions, departmentIds: [],permissionCeiling }; req.authSource = source; next(); });
 a.use(createDevelopmentClosureRouter({ prisma: db })); return { a, db };
}
beforeEach(() => {
 vi.clearAllMocks(); m.access.mockResolvedValue({ id: 'd' });m.finance.mockResolvedValue({id:'recipient',displayName:'财务'});m.handoff.mockImplementation(async(ctx,input)=>{await ctx.authorize(ctx.prisma,input.caseId,input.billingItemId);await ctx.authorizeRecipient(ctx.prisma,input.caseId,input.userId);return {assignment:{id:'t'}};});
 for (const fn of [m.preview,m.lifecycle,m.expenses,m.confirm,m.draft]) fn.mockImplementation(async (ctx, id) => { await ctx.authorize(ctx.prisma,id); return { id:'result',createdAt:1n }; });
});
describe('开发结案与核齐接口', () => {
 it.each(['/closure-preview','/expense-review-preview'])('读取%s只用本案读授权并序列化时间', async path => {
  const f=app(['products:read']); const r=await request(f.a).get('/d'+path);
  expect(r.status).toBe(200); expect(JSON.stringify(r.body)).toContain('"createdAt":"1"');
  expect(m.access).toHaveBeenCalledWith(f.db,expect.objectContaining({userId:'u'}),'d','read');
 });
 it.each(['/lifecycle','/expense-reviews'])('写入%s注入可信操作者、写范围和原请求版本',async path=>{
  const f=app(); const body={actorId:'spoof',requestKey:'same',expectedFingerprint:'hash',expectedRevision:2,note:'核实'};
  const r=await request(f.a).post('/d'+path).send(body);expect(r.status).toBe(200);
  const fn=path==='/lifecycle'?m.lifecycle:m.confirm;
  expect(fn).toHaveBeenCalledWith(expect.objectContaining({actorId:'u'}),'d',body);
  expect(m.access).toHaveBeenCalledWith(f.db,expect.anything(),'d','write');
 });
 it('匿名、非会话和只读用户不能修改',async()=>{
  expect((await request(app([], 'user-session',false).a).post('/d/lifecycle')).status).toBe(401);
  expect((await request(app(undefined,'api-key').a).post('/d/expense-reviews')).status).toBe(401);
  expect((await request(app(['products:read']).a).post('/d/lifecycle')).status).toBe(403);
  expect(m.lifecycle).not.toHaveBeenCalled();expect(m.confirm).not.toHaveBeenCalled();
 });
 it('不可见案拒绝、旧版本冲突原样返回、内部错误不泄漏',async()=>{
  m.access.mockRejectedValue(Object.assign(Error('不可访问'),{status:404,statusCode:404,code:'NOT_FOUND'}));
  expect((await request(app().a).get('/d/closure-preview')).status).toBe(404);
  m.lifecycle.mockRejectedValue(Object.assign(Error('请重新核对'),{status:409,statusCode:409,code:'STALE_VERSION'}));
  const conflict=await request(app().a).post('/d/lifecycle').send({});expect(conflict.status).toBe(409);expect(conflict.body.error.code).toBe('STALE_VERSION');
  m.confirm.mockRejectedValue(Error('secret SQL'));const failure=await request(app().a).post('/d/expense-reviews').send({});
  expect(failure.status).toBe(500);expect(JSON.stringify(failure.body)).not.toContain('secret');
 });
});

it('业务草稿使用开发写权限，不能指定其他操作者或绕过案范围',async()=>{
 const f=app(['products:write']);const body={reviewId:'r',requestKey:'k',amount:'80',waivedAmount:'20',currency:'USD',note:'逐案减免',actorId:'other'};
 const result=await request(f.a).post('/d/billing-drafts').send(body);expect(result.status).toBe(200);
 expect(m.draft).toHaveBeenCalledWith(expect.objectContaining({actorId:'u'}),'d',body);
 expect(m.access).toHaveBeenCalledWith(f.db,expect.anything(),'d','write');
 m.access.mockRejectedValue(Object.assign(Error('不可见'),{status:404,statusCode:404,code:'NOT_FOUND'}));
 expect((await request(f.a).post('/other/billing-drafts').send(body)).status).toBe(404);
});
it('收费列表仅限有读取权的当前案，不能带出其他案',async()=>{
 const f=app(['products:read']);expect((await request(f.a).get('/d/billing-drafts')).status).toBe(200);
 expect(f.db.billingItem.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({sourceType:'DevelopmentCase',sourceId:'d',chargeType:'development_fee'})}));
 expect((await request(f.a).post('/d/billing-drafts').send({})).status).toBe(403);
});

it('确认派发必须财务权限，复核操作者与接收人而非信任提交scope',async()=>{
 const body={userId:'recipient',expectedUpdatedAt:'123',actorId:'spoof'};
 expect((await request(app(['products:write']).a).post('/d/billing-drafts/b/confirm-handoff').send(body)).status).toBe(403);
 const f=app(['invoices:write']);expect((await request(f.a).post('/d/billing-drafts/b/confirm-handoff').send(body)).status).toBe(200);
 expect(m.finance).toHaveBeenCalledWith(f.db,'d','u');expect(m.finance).toHaveBeenCalledWith(f.db,'d','recipient');
 expect(m.handoff).toHaveBeenCalledWith(expect.objectContaining({actorId:'u'}),{caseId:'d',billingItemId:'b',userId:'recipient',expectedUpdatedAt:'123'});
});
it('候选列表先校验查看人，筛掉失权接收人，查询异常不冒充空列表',async()=>{
 const f=app(['invoices:write']);m.finance.mockImplementation(async(_tx,id,user)=>{if(user==='recipient')throw Object.assign(Error('无权限'),{code:'INVALID_FINANCE_RECIPIENT',status:400,statusCode:400});return {id:user};});
 const response=await request(f.a).get('/d/finance-recipients');expect(response.status).toBe(200);expect(response.body.recipients).toEqual([]);
 m.finance.mockRejectedValue(Error('DB'));expect((await request(f.a).get('/d/finance-recipients')).status).toBe(500);
});

it('我的财务待办强制使用会话用户并复查权限',async()=>{
 const f=app(['invoices:read']);const response=await request(f.a).get('/finance-tasks/mine?userId=someone');expect(response.status).toBe(200);
 expect(f.db.workAssignment.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({userId:'u',status:'assigned',metadata:{path:['managedBy'],equals:'development_cost_closure'}})}));
 expect(response.body.tasks[0]).toMatchObject({id:'task',caseId:'d',billingItem:{id:'b'}});
 m.finance.mockRejectedValue(Object.assign(Error('失权'),{code:'INVALID_FINANCE_RECIPIENT',status:400,statusCode:400}));f.db.billingItem.findFirst.mockClear();
 const restricted=await request(f.a).get('/finance-tasks/mine');expect(restricted.status).toBe(200);expect(restricted.body.tasks[0].restricted).toBe(true);
 expect(JSON.stringify(restricted.body)).not.toContain('客户秘密');expect(f.db.billingItem.findFirst).not.toHaveBeenCalled();
 expect((await request(f.a).get('/finance-tasks/mine?status=anything')).status).toBe(400);
});

it('业务提交和财务退回分别授权，操作者来自会话',async()=>{
 m.workflow.mockImplementation(async(ctx,id,_bill,body)=>{await (body.action==='return'?ctx.authorizeFinance:ctx.authorizeBusiness)(ctx.prisma,id);return {event:{id:'event'}};});
 const f=app(['products:write']);
 expect((await request(f.a).post('/d/billing-drafts/b/workflow').send({action:'submit',actorId:'spoof'})).status).toBe(200);
 expect(m.workflow).toHaveBeenCalledWith(expect.objectContaining({actorId:'u'}),'d','b',expect.objectContaining({action:'submit'}));
 expect((await request(f.a).post('/d/billing-drafts/b/workflow').send({action:'return'})).status).toBe(403);
 expect((await request(app(['invoices:write']).a).post('/d/billing-drafts/b/workflow').send({action:'return'})).status).toBe(200);
 expect((await request(f.a).post('/d/billing-drafts/b/workflow').send({action:'confirm'})).status).toBe(400);
 expect((await request(app([], 'api-key').a).post('/d/billing-drafts/b/workflow').send({action:'submit'})).status).toBe(401);
});
it('客户减免审批通知在原子提交后只投递给指定领导',async()=>{
 m.workflow.mockResolvedValue({event:{snapshot:{approvalId:'approval-1'}},billingItem:{id:'b',itemNo:'B1'},
  approvalNotification:{id:'ntf_dev_fee_approval_approval-1',userId:'leader'}});
 const response=await request(app(['products:write']).a).post('/d/billing-drafts/b/workflow').send({action:'submit'});
 expect(response.status).toBe(200);
 expect(m.notification).toHaveBeenCalledWith(expect.objectContaining({type:'development_fee_approval_requested',
  eventId:'ntf_dev_fee_approval_approval-1',recipientIds:['leader'],metadata:expect.objectContaining({approvalId:'approval-1',billingItemId:'b',caseId:'d'})}));
});
it('业务员能查本案财务接收人，财务队列包含待核对且带回真实处理结果',async()=>{
 const f=app(['products:write']);expect((await request(f.a).get('/d/billing-review-recipients')).status).toBe(200);
 expect(m.access).toHaveBeenCalledWith(f.db,expect.anything(),'d','write');
 const g=app(['invoices:read']);g.db.workAssignment.findMany.mockResolvedValue([{id:'review',status:'completed',metadata:{kind:'finance_review',caseId:'d',billingItemId:'b',decision:{amount:'80',waivedAmount:'10',currency:'USD',note:'当轮方案'},result:{outcome:'returned'}}}]);
 const r=await request(g.a).get('/finance-tasks/mine?status=completed');expect(r.status).toBe(200);
 expect(r.body.tasks[0]).toMatchObject({kind:'finance_review',submittedDecision:{amount:'80',note:'当轮方案'},result:{outcome:'returned'}});
});
it('业务补充队列只取本人任务，失去案权限后不泄露退回内容',async()=>{
 const f=app(['products:read']);f.db.workAssignment.findMany.mockResolvedValue([{id:'t',title:'敏感客户',status:'assigned',metadata:{caseId:'d',billingItemId:'b',kind:'billing_supplement',reason:'秘密',requiredItems:['客户文件']}}]);
 const r=await request(f.a).get('/business-tasks/mine?userId=other');expect(r.status).toBe(200);
 expect(f.db.workAssignment.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({userId:'u',status:'assigned'})}));
 expect(r.body.tasks[0]).toMatchObject({caseId:'d',requiredItems:['客户文件']});
 m.access.mockRejectedValue(Object.assign(Error('无权限'),{status:404,statusCode:404,code:'DEVELOPMENT_NOT_ACCESSIBLE'}));
 const hidden=await request(f.a).get('/business-tasks/mine');expect(hidden.status).toBe(200);expect(hidden.body.tasks[0].restricted).toBe(true);expect(JSON.stringify(hidden.body)).not.toContain('秘密');
});

it('财务核对资料按本人任务与原案校验，旧核齐明确标为失效',async()=>{
 const f=app(['invoices:read']);f.db.workAssignment.findFirst=vi.fn(async()=>({metadata:{managedBy:'development_cost_closure',kind:'finance_review',caseId:'d',reviewId:'r'}}));
 f.db.$queryRaw=vi.fn(async()=>[{id:'d'}]);
 f.db.developmentExpenseReview={findFirst:vi.fn(async()=>({id:'r',note:'费用齐全',snapshot:{costs:{totals:[{currency:'USD',amount:'40'}],records:[]}}}))};
 m.currentReview.mockRejectedValue(Object.assign(Error('已变化'),{code:'REVIEW_STALE'}));
 const r=await request(f.a).get('/finance-tasks/task/expense-evidence');expect(r.status).toBe(200);expect(r.body.current).toBe(false);expect(r.body.review.snapshot.costs.totals[0].amount).toBe('40');
 expect(f.db.workAssignment.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:'task',userId:'u'})}));
 m.finance.mockRejectedValue(Object.assign(Error('无权限'),{code:'INVALID_FINANCE_RECIPIENT',status:400,statusCode:400}));f.db.developmentExpenseReview.findFirst.mockClear();
 expect((await request(f.a).get('/finance-tasks/task/expense-evidence')).status).toBe(400);expect(f.db.developmentExpenseReview.findFirst).not.toHaveBeenCalled();
});

it('只有带正式业务状态的拒绝可透传，底层 status 别名不泄漏内部信息',async()=>{
 const f=app();
 m.lifecycle.mockRejectedValue(Object.assign(Error('password secret SQL'),{status:409,code:'DATABASE_ERROR'}));
 const failure=await request(f.a).post('/d/lifecycle').send({});
 expect(failure.status).toBe(500);expect(failure.body.error.code).toBe('DEVELOPMENT_CLOSURE_FAILED');expect(JSON.stringify(failure.body)).not.toContain('secret');
 m.lifecycle.mockRejectedValue(Object.assign(Error('费用资料已变化，请重新核对'),{statusCode:409,code:'REVIEW_STALE',details:{reviewId:'original'}}));
 const refusal=await request(f.a).post('/d/lifecycle').send({});
 expect(refusal.status).toBe(409);expect(refusal.body.error).toEqual({code:'REVIEW_STALE',message:'费用资料已变化，请重新核对',details:{reviewId:'original'}});
});

it('收费核对通过只允许真实财务会话，不能从业务权限或超出签名上限进入',async()=>{
 const body={action:'verify',requestKey:'verify-once',expectedVersion:4,note:'核齐凭据与客户收费一致',actorId:'spoof',skipApproval:true};
 m.workflow.mockImplementation(async(ctx,id)=>{await ctx.authorizeFinance(ctx.prisma,id);return {billingItem:{status:'confirmed',developmentWorkflowState:'ready'}};});
 expect((await request(app(['products:write']).a).post('/d/billing-drafts/b/workflow').send(body)).status).toBe(403);
 expect((await request(app(['invoices:read','invoices:write'],'user-session',true,['invoices:read']).a).post('/d/billing-drafts/b/workflow').send(body)).status).toBe(403);
 expect((await request(app(['invoices:read','invoices:write'],'api-key').a).post('/d/billing-drafts/b/workflow').send(body)).status).toBe(401);
 expect(m.workflow).not.toHaveBeenCalled();
 const response=await request(app(['invoices:read','invoices:write']).a).post('/d/billing-drafts/b/workflow').send(body);
 expect(response.status).toBe(200);expect(response.body.billingItem.status).toBe('confirmed');
 expect(m.workflow).toHaveBeenCalledWith(expect.objectContaining({actorId:'u'}),'d','b',body);
});
