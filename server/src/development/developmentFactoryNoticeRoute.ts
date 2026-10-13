import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { requirePermission } from '../auth/permissionGuard';
import { authorizeDevelopmentSource } from './developmentConversionAuthority';
import { FACTORY_FILE_LIMIT, noticeFailure } from './developmentFactoryFiles';
import { factoryNoticeContext, saveFactoryNotice, uploadFactoryFile, readFactoryNotice, readFactoryOriginal } from './developmentFactoryNoticeService';
export function createDevelopmentFactoryNoticeRouter({prisma}:{prisma:any}) {
 const router=Router(),upload=multer({storage:multer.memoryStorage(),limits:{fileSize:FACTORY_FILE_LIMIT,files:1,fields:6,fieldSize:2048}}).single('file');
 const session=(req:Request,res:Response,next:NextFunction)=>{if(!(req as any).actor?.userId||(req as any).authSource!=='user-session'){res.status(401).json({error:{code:'UNAUTHORIZED',message:'请先登录'}});return;}next();};
 const context=(req:Request)=>({prisma,actorId:(req as any).actor.userId,trustedActor:(req as any).actor});
 const target=(req:Request)=>({kind:(req.method==='GET'?req.query.kind:req.body.kind) as 'version'|'trim',targetId:String(req.method==='GET'?req.query.targetId??'':req.body.targetId??'')});
 const error=(res:Response,e:any)=>{const status=Number(e.status??e.httpStatus),publicStatus=status>=400&&status<500?status:500;res.status(publicStatus).json({error:{code:publicStatus===500?'FACTORY_NOTICE_FAILED':e.code,message:publicStatus===500?'工厂资料处理未完成，请重试原请求':e.message}});};
 const run=(fn:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response)=>{void fn(req,res).catch((e:any)=>error(res,e));};
 const download=(res:Response,result:{bytes:Buffer;name:string;mimeType:string})=>{res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.attachment(result.name);res.type(result.mimeType);res.send(result.bytes);};
 router.get('/:id/factory-notices',session,requirePermission('products:read'),run(async(req,res)=>{res.json(await factoryNoticeContext(context(req),req.params.id,target(req)));}));
 router.post('/:id/factory-notices',session,requirePermission('products:write'),run(async(req,res)=>{res.json(await saveFactoryNotice(context(req),req.params.id,target(req),req.body));}));
 router.get('/:id/factory-notices/:noticeId/notice',session,requirePermission('products:read'),run(async(req,res)=>download(res,await readFactoryNotice(context(req),req.params.id,req.params.noticeId))));
 router.get('/:id/factory-notices/:noticeId/attachments.zip',session,requirePermission('products:read'),run(async(req,res)=>download(res,await readFactoryNotice(context(req),req.params.id,req.params.noticeId,true))));
 router.post('/:id/factory-notice-files',session,requirePermission('products:write'),(req,res,next)=>{
  void prisma.$transaction((tx:any)=>authorizeDevelopmentSource(tx,(req as any).actor.userId,(req as any).actor,req.params.id,{write:true})).then(()=>upload(req,res,(e:any)=>{if(e){res.status(400).json({error:{code:'INVALID_UPLOAD',message:'请选择单个不超过20MiB的原文件'}});return;}next();})).catch((e:any)=>error(res,e));
 },run(async(req,res)=>{if(!req.file)noticeFailure('FILE_REQUIRED','请选择原文件',400);res.json(await uploadFactoryFile(context(req),req.params.id,target(req),{...req.body,bytes:req.file!.buffer,originalName:req.file!.originalname}));}));
 router.get('/:id/factory-notice-files/:fileId',session,requirePermission('products:read'),run(async(req,res)=>{
  const result=await readFactoryOriginal(context(req),req.params.id,target(req),req.params.fileId),preview=req.query.preview==='1';
  if(preview&&!result.file.previewSupported)noticeFailure('PREVIEW_UNSUPPORTED','该格式请下载原文件查看',400);
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Disposition',`${preview?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(result.file.originalName)}`);res.type(preview?result.file.mimeType:'application/octet-stream');res.send(result.bytes);
 }));
 return router;
}
