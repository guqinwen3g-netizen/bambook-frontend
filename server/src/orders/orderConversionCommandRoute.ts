import {createQuotationConversionCommandService,parseQuotationConversionSelection} from '../quotations/quotationConversionCommandService';
import{Router,type Request}from'express';
import type{PrismaClient}from'@prisma/client';
import{createAuthService,type TokenPayload}from'../auth/service';
import{pickRequestToken}from'../auth/middleware';
import{businessError,isBusinessError,lookupErrorCode}from'../shared/errorCodes';
import{safeRouteError}from'../shared/routeError';
import{createDevelopmentConversionCommandService,parseDevelopmentConversionSelection}from'../development/developmentConversionCommandService';
/** Mounted after the existing module guard. Every command including recovery
 * requires its original company JWT; transport API keys/body actor are not identity. */
export function createDevelopmentConversionCommandRouter(options:{prisma:PrismaClient;onDataChange?:(event:{entity:string;action:string;ids?:string[]})=>void}){
 return createConversionCommandRouter(options,'development');
}
export function createQuotationConversionCommandRouter(options:{prisma:PrismaClient;onDataChange?:(event:{entity:string;action:string;ids?:string[]})=>void}){return createConversionCommandRouter(options,'quotation');}
function createConversionCommandRouter(options:{prisma:PrismaClient;onDataChange?:(event:{entity:string;action:string;ids?:string[]})=>void},sourceType:'development'|'quotation'){
 const router=Router(),service=sourceType==='development'?createDevelopmentConversionCommandService(options.prisma):createQuotationConversionCommandService(options.prisma);
 function actor(req:Request):TokenPayload{
  let original:TokenPayload;try{original=createAuthService().verifyToken(pickRequestToken(req));}catch{throw businessError('UNAUTHORIZED','请登录后核对开发转单。');}
  if(!original?.userId||!Array.isArray(original.roles)||(original as any).kind==='customer'||original.userId!==(req as any).actor?.userId)throw businessError('UNAUTHORIZED','原凭据与当前主体不一致。');return original;
 }
 for(const action of ['context','execute','recover','cancel'] as const){
  router.post('/:id/convert-command/'+action,async(req,res)=>{
   try{
    const principal=actor(req);let result:any;
    if(action==='context')result=await service.context(principal,req.params.id,(sourceType==='development'?parseDevelopmentConversionSelection:parseQuotationConversionSelection)(req.body),true);
    else{
     if(req.body?.source?.type!==sourceType||req.body?.source?.id!==req.params.id)throw businessError('INVALID_INPUT','转单命令与当前开发来源不一致。');
     result=action==='execute'?await service.execute(principal,req.body,orderId=>options.onDataChange?.({entity:'orders',action:'created',ids:[orderId]})):await service[action](principal,req.body);
    }
    return res.json({ok:true,result});
   }catch(error){const safe=safeRouteError(error,{fallbackCode:'INTERNAL_ERROR'});return res.status(safe.status).json({ok:false,error:{code:safe.code,message:safe.message,...(isBusinessError(error)&&typeof (error as any)?.approvalRequestId==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test((error as any).approvalRequestId)?{approvalRequestId:(error as any).approvalRequestId}:{}),...(isBusinessError(error)&&typeof (error as any)?.blockCode==='string'&&lookupErrorCode((error as any).blockCode)?{blockCode:(error as any).blockCode}:{})}});}
  });
 }
 return router;
}
