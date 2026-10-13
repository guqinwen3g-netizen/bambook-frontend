import { Router, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { serializeValue } from '../lib/serializeValue';
import { logger } from '../lib/logger';
import { safeRouteError } from '../shared/routeError';
import { SampleCustodyAuthorizationError } from './sampleCustodyAuthorization';
import { createSampleCardMoveService } from './sampleCardMoveService';

/** Mounted under /samples/room/items. Current custody grants remain in service. */
export function createSampleCardMoveRouter(options:{prisma:PrismaClient;apiKeys?:Set<string>;onDataChange?:(event:{entity:string;action:string;ids?:string[]})=>void}):Router {
  const router=Router(),auth={requireAuth:true,apiKeys:options.apiKeys??new Set<string>()};
  router.use((req,_res,next)=>{if(/^\/[^/]+\/(?:move-context|move(?:\/(?:recover|cancel))?)\/?$/.test(req.path))next();else next('router');});
  router.use((_req,res,next)=>{const json=res.json.bind(res);res.json=((body:any)=>json(typeof body?.error==='string'?{error:{code:body.error,message:body.message??'身份验证失败。'}}:body)) as typeof res.json;next();});
  router.use(createModuleAuthGuard(auth));
  const service=createSampleCardMoveService({prisma:options.prisma}),write=requireJwtForWrite(auth);
  async function send(res:Response,work:()=>Promise<any>,notify=false){
    try{const data=await work();if(notify)try{options.onDataChange?.({entity:'samples',action:'move_sample_card',ids:[data.cardId]});}catch(error){logger.error('[sample-card-move] committed notification failed',{error});}res.status(200).json({ok:true,data:serializeValue(data)});}
    catch(error){if(error instanceof SampleCustodyAuthorizationError){res.status(error.status).json({error:{code:error.code,message:error.message}});return;}const safe=safeRouteError(error,{fallbackCode:'INTERNAL_ERROR',fallbackMessage:'实物移位未能确认，请保留原请求并核对。'});res.status(safe.status).json({error:{code:safe.code,message:safe.message}});}
  }
  router.get('/:cardId/move-context',async(req,res)=>send(res,()=>service.context((req as any).actor,req.params.cardId)));
  router.post('/:cardId/move',write,async(req,res)=>send(res,()=>service.move((req as any).actor,req.params.cardId,req.body),true));
  router.post('/:cardId/move/recover',write,async(req,res)=>send(res,()=>service.recover((req as any).actor,req.params.cardId,req.body)));
  router.post('/:cardId/move/cancel',write,async(req,res)=>send(res,()=>service.cancel((req as any).actor,req.params.cardId,req.body)));
  return router;
}
