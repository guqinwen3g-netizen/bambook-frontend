import {Prisma} from '@prisma/client';
import { transitionDevelopmentBilling } from './developmentBillingWorkflowService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { Router, Request, Response, NextFunction } from 'express';
import type { PrismaClient } from '@prisma/client';
import { confirmDevelopmentBillingAndHandoff } from './developmentFinanceHandoffService';
import { createDevelopmentBillingDraft } from './developmentBillingDraftService';
import { requirePermission } from '../auth/permissionGuard';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { publishNotificationEvent } from '../realtime';
import { assertDevelopmentExpenseAccess, assertDevelopmentFinanceRecipient, assertDevelopmentFinanceWriteAccess } from './developmentExpenseAccess';
import { assertDevelopmentExpenseReviewCurrentInTx, previewDevelopmentClosure, recordDevelopmentLifecycle, previewDevelopmentExpenseReview, confirmDevelopmentExpenseReview } from './developmentClosureService';

const jsonSafe = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v));
export function createDevelopmentClosureRouter({ prisma }: { prisma: PrismaClient }) {
  const router = Router();
  const approvalCreateService=createApprovalCreateService({prisma,routingService:createApprovalRoutingService({prisma})});
  const session = (req: Request, res: Response, next: NextFunction) => {
    if (!(req as any).actor?.userId || (req as any).authSource !== 'user-session') return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请登录后处理开发结案与费用核对' } });
    next();
  };
  const context = (req: Request, mode: 'read' | 'write') => ({ prisma, actorId: (req as any).actor.userId,
    authorize: (tx: any, id: string) => assertDevelopmentExpenseAccess(tx, (req as any).actor, id, mode) });
  const handle = (run: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { res.json(jsonSafe(await run(req))); }
    catch (error: any) {
      const failure = safeRouteError(error, { fallbackCode: 'DEVELOPMENT_CLOSURE_FAILED', fallbackMessage: '结案与费用核对未完成，请刷新后重试' });
      if (failure.status >= 500) logger.error('[development-closure] operation failed', { error });
      res.status(failure.status).json({ error: { code: failure.code, message: failure.message, ...(failure.details === undefined ? {} : { details: failure.details }) } });
    }
  };
  router.get('/:id/closure-preview', session, requirePermission('products:read'), handle(async req => ({ closure: await previewDevelopmentClosure(context(req, 'read'), req.params.id) })));
  router.post('/:id/lifecycle', session, requirePermission('products:write'), handle(async req => ({ event: await recordDevelopmentLifecycle(context(req, 'write'), req.params.id, req.body ?? {}) })));
  router.get('/:id/expense-review-preview', session, requirePermission('products:read'), handle(async req => ({ review: await previewDevelopmentExpenseReview(context(req, 'read'), req.params.id) })));
  router.post('/:id/expense-reviews', session, requirePermission('products:write'), handle(async req => ({ review: await confirmDevelopmentExpenseReview(context(req, 'write'), req.params.id, req.body ?? {}) })));
  router.post('/:id/billing-drafts', session, requirePermission('products:write'), handle(async req => createDevelopmentBillingDraft(context(req, 'write'), req.params.id, req.body ?? {})));
  router.get('/:id/billing-drafts', session, requirePermission('products:read'), handle(async req => {
    const billingItems = await prisma.$transaction(async tx => {
      await assertDevelopmentExpenseAccess(tx, (req as any).actor, req.params.id, 'read');
      return tx.billingItem.findMany({ where: { sourceType: 'DevelopmentCase', sourceId: req.params.id, deletedAt: null, chargeType:'development_fee' },
        include: {developmentWorkflowEvents:{orderBy:{version:'desc'},take:50}},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 });
    });
    return { billingItems };
  }));
  router.get('/business-tasks/mine',session,requirePermission('products:read'),handle(async req=>prisma.$transaction(async tx=>{
    const actor=(req as any).actor;
    const cursor=typeof req.query.cursor==='string'?req.query.cursor:undefined;
    const rows=await tx.workAssignment.findMany({where:{userId:actor.userId,deletedAt:null,status:'assigned',AND:[{metadata:{path:['managedBy'],equals:'development_cost_closure'}},{metadata:{path:['kind'],equals:'billing_supplement'}}],...(cursor?{id:{gt:cursor}}:{})},orderBy:{id:'asc'},take:21});
    const tasks=[];
    for(const row of rows.slice(0,20)){
      const meta=row.metadata as any;
      if(typeof meta?.caseId!=='string')continue;
      try{await assertDevelopmentExpenseAccess(tx,actor,meta.caseId,'read');}
      catch(error:any){if(!['DEVELOPMENT_NOT_ACCESSIBLE','FORBIDDEN'].includes(error?.code))throw error;tasks.push({id:row.id,restricted:true,message:'原案权限已变化，请联系负责人处理交接'});continue;}
      tasks.push({id:row.id,title:row.title,caseId:meta.caseId,billingItemId:meta.billingItemId,reason:meta.reason,requiredItems:meta.requiredItems??[],restricted:false});
    }
    return {tasks,nextCursor:rows.length>20?rows[19].id:null};
  })));
  router.get('/finance-tasks/:taskId/expense-evidence',session,requirePermission('invoices:read'),handle(async req=>prisma.$transaction(async tx=>{
    const actorId=(req as any).actor.userId;
    const task=await tx.workAssignment.findFirst({where:{id:req.params.taskId,userId:actorId,deletedAt:null}});
    const meta=task?.metadata as any;
    if(meta?.managedBy!=='development_cost_closure'||meta?.kind!=='finance_review'||typeof meta.caseId!=='string'||typeof meta.reviewId!=='string')throw Object.assign(Error('核对任务不存在'),{status:404,statusCode:404,code:'NOT_FOUND'});
    await assertDevelopmentFinanceRecipient(tx,meta.caseId,actorId);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${meta.caseId} FOR UPDATE`);
    await assertDevelopmentFinanceRecipient(tx,meta.caseId,actorId);
    const review=await tx.developmentExpenseReview.findFirst({where:{id:meta.reviewId,developmentCaseId:meta.caseId},select:{id:true,note:true,snapshot:true,createdAt:true,createdBy:true}});
    if(!review)throw Object.assign(Error('本轮费用核齐资料缺失'),{status:409,statusCode:409,code:'REVIEW_REQUIRED'});
    let current=true;
    try{await assertDevelopmentExpenseReviewCurrentInTx(tx,meta.caseId,meta.reviewId);}
    catch(error:any){if(error?.code!=='REVIEW_STALE')throw error;current=false;}
    return {review,current};
  })));
  router.get('/finance-tasks/mine', session, requirePermission('invoices:read'), handle(async req => {
    const actorId=(req as any).actor.userId;
    const cursor=typeof req.query.cursor==='string'?req.query.cursor:undefined;
    const status=req.query.status??'assigned';
    if(!['assigned','completed','cancelled'].includes(String(status))) throw Object.assign(new Error('待办状态无效'),{code:'INVALID_INPUT',status:400,statusCode:400});
    return prisma.$transaction(async tx=>{
      const rows=await tx.workAssignment.findMany({where:{userId:actorId,deletedAt:null,status:String(status),metadata:{path:['managedBy'],equals:'development_cost_closure'},...(cursor?{id:{gt:cursor}}:{})},orderBy:{id:'asc'},take:51});
      const tasks=[];
      for(const row of rows.slice(0,50)) {
        const meta=row.metadata as any;
        if(!['finance_handoff','finance_review'].includes(meta?.kind)||typeof meta.caseId!=='string'||typeof meta.billingItemId!=='string')continue;
        try { await assertDevelopmentFinanceRecipient(tx,meta.caseId,actorId); }
        catch(error:any) {
          if(error?.code!=='INVALID_FINANCE_RECIPIENT')throw error;
          tasks.push({id:row.id,status:row.status,restricted:true,message:'业务权限已变化，请联系负责人处理交接'});continue;
        }
        const billingItem=await tx.billingItem.findFirst({where:{id:meta.billingItemId,sourceType:'DevelopmentCase',sourceId:meta.caseId,deletedAt:null}});
        tasks.push({id:row.id,title:row.title,status:row.status,caseId:meta.caseId,kind:meta.kind,submittedDecision:meta.kind==='finance_review'?meta.decision??null:null,result:meta.result??null,billingItem,createdAt:row.createdAt,completedAt:row.completedAt,restricted:false});
      }
      return {tasks,nextCursor:rows.length>50?rows[49].id:null};
    });
  }));
  router.post('/:id/billing-drafts/:billingId/workflow', session, (req,res,next)=>{
    const action=req.body?.action;
    if(!['submit','edit','return','cancel','verify'].includes(action))return res.status(400).json({error:{code:'INVALID_INPUT',message:'收费流转操作无效'}});
    return requirePermission(['return','verify'].includes(action)?'invoices:write':'products:write')(req,res,next);
  }, handle(async req=>{
    const actorId=(req as any).actor.userId;
    const result:any=await transitionDevelopmentBilling({prisma,actorId,
      approvalCreateService,
      authorizeBusiness:(tx,id)=>assertDevelopmentExpenseAccess(tx,(req as any).actor,id,'write'),
      authorizeFinance:(tx,id)=>assertDevelopmentFinanceWriteAccess(tx,(req as any).actor,id),
      authorizeRecipient:(tx,id,userId)=>assertDevelopmentFinanceRecipient(tx,id,userId),
    },req.params.id,req.params.billingId,req.body);
    if(result.approvalNotification){
      try{publishNotificationEvent({type:'development_fee_approval_requested',title:'开发收费待领导审批',
        body:`${result.billingItem.itemNo} 的客户收费方案包含减免或免收，等待审核并最终确定。`,level:'warning',
        eventId:result.approvalNotification.id,eventType:'development_fee_approval_requested',
        recipientIds:[result.approvalNotification.userId],metadata:{approvalId:result.event.snapshot.approvalId,
          billingItemId:result.billingItem.id,caseId:req.params.id}});}
      catch(error:any){logger.warn('[development-closure] committed approval notification SSE failed',{error:error?.message});}
    }
    return result;
  }));
  router.get('/:id/billing-review-recipients', session, requirePermission('products:write'), handle(async req=>prisma.$transaction(async tx=>{
    await assertDevelopmentExpenseAccess(tx,(req as any).actor,req.params.id,'write');
    const cursor=typeof req.query.cursor==='string'?req.query.cursor:undefined;
    const users=await tx.userAccount.findMany({where:{status:'active',deletedAt:null,...(cursor?{id:{gt:cursor}}:{})},orderBy:{id:'asc'},take:51,select:{id:true}});
    const recipients=[];
    for(const user of users.slice(0,50)){
      try{recipients.push(await assertDevelopmentFinanceRecipient(tx,req.params.id,user.id));}
      catch(error:any){if(error?.code!=='INVALID_FINANCE_RECIPIENT')throw error;}
    }
    return {recipients,nextCursor:users.length>50?users[49].id:null};
  })));
  router.get('/:id/finance-recipients', session, requirePermission('invoices:write'), handle(async req => {
    return prisma.$transaction(async tx => {
      await assertDevelopmentFinanceRecipient(tx, req.params.id, (req as any).actor.userId);
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const users = await tx.userAccount.findMany({ where: { status: 'active', deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: 51, select: { id: true } });
      const recipients = [];
      for (const user of users.slice(0, 50)) {
        try { recipients.push(await assertDevelopmentFinanceRecipient(tx, req.params.id, user.id)); }
        catch (error: any) { if (error?.code !== 'INVALID_FINANCE_RECIPIENT') throw error; }
      }
      return { recipients, nextCursor: users.length > 50 ? users[49].id : null };
    });
  }));
  router.post('/:id/billing-drafts/:billingId/confirm-handoff', session, requirePermission('invoices:write'), handle(async req => {
    const actorId = (req as any).actor.userId;
    return confirmDevelopmentBillingAndHandoff({ prisma, actorId,
      authorize: (tx: any, caseId: string) => assertDevelopmentFinanceWriteAccess(tx, (req as any).actor, caseId),
      authorizeRecipient: (tx: any, caseId: string, userId: string) => assertDevelopmentFinanceRecipient(tx, caseId, userId),
    }, { caseId: req.params.id, billingItemId: req.params.billingId, userId: req.body?.userId, expectedUpdatedAt: req.body?.expectedUpdatedAt });
  }));
  return router;
}
