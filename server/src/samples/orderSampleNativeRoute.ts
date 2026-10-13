import { Router, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { serializeValue } from '../lib/serializeValue';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { getOrderSampleContext, previewOrderSampleParents } from './orderSampleContextService';
import { createOrderSampleCommandService } from './orderSampleCommandService';
import {createOrderSampleCancellationService} from './orderSampleCancellationService';
import { createOrderSamplePhysicalReceiptService } from './orderSamplePhysicalReceiptService';
import { createOrderSampleReadService } from './orderSampleReadService';

/** Mount at /samples/order-native before the legacy /:id catch-all. */
export function createOrderSampleNativeRouter(options:{prisma:PrismaClient;requireAuth?:boolean;apiKeys?:Set<string>;onDataChange?:(event:{entity:string;action:string;ids?:string[]})=>void}):Router {
  const router=Router(),auth={requireAuth:true,apiKeys:options.apiKeys??new Set<string>()};
  // The shared authentication guard's legacy flat failures are normalized into
  // this protocol's same error envelope, including unauthenticated failures.
  router.use((_req,res,next)=>{const json=res.json.bind(res);res.json=((body:any)=>json(typeof body?.error==='string'?{error:{code:body.error,message:body.message??'身份验证失败。'}}:body)) as typeof res.json;next();});
  router.use(createModuleAuthGuard(auth));
  const physical=createOrderSamplePhysicalReceiptService({prisma:options.prisma});
  const write=requireJwtForWrite(auth),commands=createOrderSampleCommandService({prisma:options.prisma}),reads=createOrderSampleReadService({prisma:options.prisma}),cancellations=createOrderSampleCancellationService({prisma:options.prisma});
  async function send(res:Response,work:()=>Promise<any>,action?:string) {
    try{let data=await work();
      if(data?.ok===false&&data.error){res.status(data.error.status).json({error:{code:data.error.code,message:data.error.message}});return;}
      if(data?.ok===true&&Object.prototype.hasOwnProperty.call(data,'data'))data=data.data;
      if(action&&(action!=='cancel_order_sample_command'||data.outcome==='cancelled'))try{const itemCardIds=action==='receive_order_sample_physical'&&Array.isArray(data.items)?data.items.map((item:any)=>item?.cardId).filter((id:any):id is string=>typeof id==='string'):[];options.onDataChange?.({entity:'samples',action,ids:[data.sourceId,data.sampleId,data.cancellationId,...(itemCardIds.length?itemCardIds:[data.cardId])].filter((id):id is string=>typeof id==='string')});}catch(error){logger.error('[order-native] committed notification failed',{error});}
      res.status(200).json({ok:true,data:serializeValue(data)});
    }catch(error){const safe=safeRouteError(error,{fallbackCode:'INTERNAL_ERROR',fallbackMessage:'订单样品操作未能完成，请稍后重试。'});res.status(safe.status).json({error:{code:safe.code,message:safe.message}});}
  }
  router.get('/physical/context/:sourceId',async(req,res)=>send(res,()=>physical.context((req as any).actor,req.params.sourceId)));
  router.post('/physical/receive',write,async(req,res)=>send(res,()=>physical.receive((req as any).actor,req.body),'receive_order_sample_physical'));
  router.post('/physical/recover',write,async(req,res)=>send(res,()=>physical.recover((req as any).actor,req.body)));
  router.post('/physical/cancel',write,async(req,res)=>send(res,()=>physical.cancel((req as any).actor,req.body)));
  router.get('/protocol',async(req,res)=>send(res,()=>reads.protocol((req as any).actor)));
  router.get('/context',async(req,res)=>send(res,()=>{
    if(Object.keys(req.query).some(k=>!['orderId','family'].includes(k)))throw new DevelopmentDomainError('INVALID_INPUT','样品来源只接受订单与业务族。');
    return getOrderSampleContext({prisma:options.prisma,actor:(req as any).actor,orderId:req.query.orderId as string,family:req.query.family as any});
  }));
  router.post('/preview',async(req,res)=>send(res,()=>previewOrderSampleParents({prisma:options.prisma,actor:(req as any).actor,request:req.body})));
  router.post('/cancel',write,async(req,res)=>send(res,()=>cancellations.cancel((req as any).actor,req.body),'cancel_order_sample_command'));
  router.post('/register',write,async(req,res)=>send(res,()=>commands.register((req as any).actor,req.body),'register_order_sample'));
  router.post('/events',write,async(req,res)=>send(res,()=>commands.append((req as any).actor,req.body),'append_order_sample_event'));
  router.get('/source/:sourceId',async(req,res)=>send(res,()=>reads.bySource((req as any).actor,req.params.sourceId)));
  router.get('/sample/:sampleId',async(req,res)=>send(res,()=>reads.bySample((req as any).actor,req.params.sampleId)));
  return router;
}
