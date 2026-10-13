import {registerDevelopmentCost,listDevelopmentShippingCostSources} from './developmentCostRegistration';
import {Router,Request,Response,NextFunction} from 'express';
import type {PrismaClient} from '@prisma/client';
import {requirePermission} from '../auth/permissionGuard';
import {safeRouteError} from '../shared/routeError';
import {logger} from '../lib/logger';
import {assertDevelopmentExpenseAccess,assertDevelopmentExpenseAssignee} from './developmentExpenseAccess';
import {registerPendingDevelopmentExpense,completePendingDevelopmentExpense} from './developmentPendingExpenseService';
const jsonSafe=(value:unknown)=>JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='bigint'?item.toString():item));
function failure(res:Response,error:unknown){
 const failure=safeRouteError(error,{fallbackCode:'PENDING_EXPENSE_FAILED',fallbackMessage:'待到费用处理失败，请稍后重试'});
 if(failure.status>=500)logger.error('[development-pending-expense] operation failed',{error});
 return res.status(failure.status).json({error:{code:failure.code,message:failure.message,...(failure.details===undefined?{}:{details:failure.details})}});
}
export function createDevelopmentPendingExpenseRouter({prisma}:{prisma:PrismaClient}) {
 const router=Router();
 const session=(req:Request,res:Response,next:NextFunction)=>{if(!(req as any).actor?.userId||(req as any).authSource!=='user-session')return res.status(401).json({error:{code:'UNAUTHORIZED',message:'请登录后处理待到费用'}});next();};
 const context=(req:Request)=>({prisma,actorId:(req as any).actor.userId,trustedActor:(req as any).actor,
  authorize:(tx:any,id:string)=>assertDevelopmentExpenseAccess(tx,(req as any).actor,id,'write'),
  authorizeAssignee:(tx:any,id:string,userId:string)=>assertDevelopmentExpenseAssignee(tx,(req as any).actor,id,userId)});
 router.post('/:id/costs',session,requirePermission('products:write'),async(req,res)=>{try{
  const costRecord=await registerDevelopmentCost(context(req),req.params.id,req.body??{});res.json(jsonSafe({costRecord}));
 }catch(error){failure(res,error);}});
 router.get('/:id/shipping-cost-sources',session,requirePermission('products:read'),async(req,res)=>{try{
  const sources=await listDevelopmentShippingCostSources(context(req),req.params.id,typeof req.query.batchId==='string'?req.query.batchId:'');
  res.json(jsonSafe({sources}));
 }catch(error){failure(res,error);}});
 router.get('/:id/pending-expenses',(req,res,next)=>{if(!(req as any).actor?.userId)return res.status(401).json({error:{code:'UNAUTHORIZED',message:'请登录后查看待到费用'}});next();},requirePermission('products:read'),async(req,res)=>{try{
  const pendingExpenses=await prisma.$transaction(async(tx)=>{await assertDevelopmentExpenseAccess(tx,(req as any).actor,req.params.id,'read');return tx.developmentPendingExpense.findMany({where:{developmentCaseId:req.params.id},orderBy:[{createdAt:'desc'},{id:'asc'}]});});
  res.json(jsonSafe({pendingExpenses}));
 }catch(error){failure(res,error);}});
 router.post('/:id/pending-expenses',session,requirePermission('products:write'),async(req,res)=>{try{
  const pendingExpense=await registerPendingDevelopmentExpense(context(req),req.params.id,req.body??{});res.json(jsonSafe({pendingExpense}));
 }catch(error){failure(res,error);}});
 router.post('/:id/pending-expenses/:pendingId/complete',session,requirePermission('products:write'),async(req,res)=>{try{
  const pendingExpense=await completePendingDevelopmentExpense(context(req),req.params.id,req.params.pendingId,req.body??{});res.json(jsonSafe({pendingExpense}));
 }catch(error){failure(res,error);}});
 return router;
}
