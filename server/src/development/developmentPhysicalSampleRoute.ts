import { Router, type Request, type Response, type NextFunction } from 'express';
import { requirePermission } from '../auth/permissionGuard';
import { safeRouteError } from '../shared/routeError';
import { registerDevelopmentIncomingSample, shipDevelopmentSampleToFactory, readDevelopmentPhysicalCommand, listDevelopmentPhysicalCommands, resolveDevelopmentPhysicalCommand, readDevelopmentPhysicalResolution } from './developmentPhysicalSampleService';
export function createDevelopmentPhysicalSampleRouter({prisma,onDataChange}:{prisma:any;onDataChange?:(event:{entity:string;action:string;ids?:string[]})=>void}) {
  const router=Router();
  const session=(req:Request,res:Response,next:NextFunction)=>{
    if(!(req as any).actor?.userId||(req as any).authSource!=='user-session')return res.status(401).json({error:{code:'UNAUTHORIZED',message:'请登录后办理开发实物'}});
    next();
  };
  const context=(req:Request)=>({prisma,actorId:(req as any).actor.userId,trustedActor:(req as any).actor,ip:req.ip});
  const handle=(run:(req:Request)=>Promise<any>)=>async(req:Request,res:Response)=>{
    try{const item=await run(req);if(req.method==='POST'&&item.itemId&&!item.replayed){onDataChange?.({entity:'development',action:'physical-sample-command',ids:[req.params.id,item.itemId]});onDataChange?.({entity:'samples',action:'physical-sample-command',ids:[item.itemId]});}res.json({item});}catch(error){const failure=safeRouteError(error,{fallbackCode:'DEVELOPMENT_PHYSICAL_COMMAND_FAILED',fallbackMessage:'开发实物命令结果未确认，请读取原回执后重试'});res.status(failure.status).json({error:{code:failure.code,message:failure.message}});}
  };
  router.post('/:id/incoming-samples',session,requirePermission('products:write'),requirePermission('sample:room:write'),handle(req=>registerDevelopmentIncomingSample(context(req),req.params.id,req.body??{})));
  router.post('/:id/factory-sample-shipments',session,requirePermission('products:write'),requirePermission('sample:room:write'),handle(req=>shipDevelopmentSampleToFactory(context(req),req.params.id,req.body??{})));
  router.post('/:id/physical-sample-commands/:kind/:requestKey/resolve',session,requirePermission('products:write'),requirePermission('sample:room:write'),handle(req=>resolveDevelopmentPhysicalCommand(context(req),req.params.id,req.params.kind as any,req.params.requestKey,req.body?.input)));
  router.get('/:id/physical-sample-commands',session,requirePermission('products:read'),handle(req=>listDevelopmentPhysicalCommands(context(req),req.params.id,{kind:req.query.kind as any,limit:req.query.limit===undefined?undefined:Number(req.query.limit),offset:req.query.offset===undefined?undefined:Number(req.query.offset)})));
  router.get('/:id/physical-sample-commands/:kind/:requestKey/resolution',session,requirePermission('products:read'),handle(req=>readDevelopmentPhysicalResolution(context(req),req.params.id,req.params.kind as any,req.params.requestKey)));
  router.get('/:id/physical-sample-commands/:kind/:requestKey',session,requirePermission('products:read'),handle(req=>readDevelopmentPhysicalCommand(context(req),req.params.id,req.params.kind as any,req.params.requestKey)));
  return router;
}
