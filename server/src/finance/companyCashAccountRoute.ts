import {Router} from 'express';
import {extractActorFromRequest} from '../auth/middleware';
import {safeRouteError} from '../shared/routeError';
import {ciJson} from '../development/developmentCiSource';
import {listCompanyCashAccounts,getCompanyCashAccount,createCompanyCashAccount,commandCompanyCashAccount} from './companyCashAccountService';
/** Mounted before generic /finance/:id, under the normal finance auth guard. */
export function createCompanyCashAccountRouter({prisma}:{prisma:any}){const router=Router();
  const reply=(label:string,run:(req:any)=>Promise<any>,status=200)=>(req:any,res:any)=>Promise.resolve().then(()=>run(req)).then(value=>res.status(value.replayed?200:status).json(ciJson({ok:true,...value})))
    .catch(error=>{const safe=safeRouteError(error,{fallbackCode:'INTERNAL_ERROR',fallbackMessage:`${label}暂不可确认，请保留原请求核对。`});res.status(safe.status).json({ok:false,error:{code:safe.code,message:safe.message}});});
  router.get('/',reply('账户读取',req=>listCompanyCashAccounts({prisma,actor:extractActorFromRequest(req)})));
  router.get('/:id',reply('账户读取',req=>getCompanyCashAccount({prisma,actor:extractActorFromRequest(req),accountId:req.params.id})));
  router.post('/',reply('账户配置',req=>createCompanyCashAccount({prisma,actor:extractActorFromRequest(req),input:req.body}),201));
  router.post('/:id/commands',reply('真实资金登记',req=>commandCompanyCashAccount({prisma,actor:extractActorFromRequest(req),accountId:req.params.id,input:req.body}),201));
  return router;}
