import {Router,Request,Response,NextFunction} from 'express';
import multer from 'multer';
import {requirePermission} from '../auth/permissionGuard';
import {assertDevelopmentExpenseAccess,assertDevelopmentFinanceRecipient} from './developmentExpenseAccess';
import {addDevelopmentCostEvidence,listDevelopmentCostEvidence,readDevelopmentCostEvidence,revokeDevelopmentCostEvidence} from './developmentCostEvidenceService';
import {COST_EVIDENCE_MAX_BYTES} from './developmentCostEvidenceFiles';
const safe=(v:any)=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='bigint'?String(x):x));
function notFound():never{throw Object.assign(Error('凭据或核对任务不存在'),{status:404,code:'NOT_FOUND'});}
export function createDevelopmentCostEvidenceRouter({prisma}:{prisma:any}){
 const router=Router();
 const session=(req:Request,res:Response,next:NextFunction)=>{if(!(req as any).actor?.userId||(req as any).authSource!=='user-session'){res.status(401).json({error:{code:'UNAUTHORIZED',message:'请先登录'}});return;}next();};
 const error=(res:Response,e:any)=>{const status=Number(e.status??e.httpStatus);const publicStatus=status>=400&&status<500?status:500;res.status(publicStatus).json({error:{code:publicStatus===500?'EVIDENCE_FAILED':e.code,message:publicStatus===500?'凭据处理未完成，请重试原请求':e.message}});};
 const run=(fn:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response)=>{void fn(req,res).catch(e=>error(res,e));};
 const ctx=(req:Request,mode:'read'|'write')=>({prisma,actorId:(req as any).actor.userId,authorize:(tx:any,id:string)=>assertDevelopmentExpenseAccess(tx,(req as any).actor,id,mode)});
 const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:COST_EVIDENCE_MAX_BYTES,files:1,fields:3,fieldSize:8000}}).single('file');
 const base='/:id/costs/:costId/evidence';
 router.get(base,session,requirePermission('products:read'),run(async(req,res)=>{res.json(safe({evidence:await listDevelopmentCostEvidence(ctx(req,'read'),req.params.id,req.params.costId)}));}));
 router.post(base,session,requirePermission('products:write'),(req,res,next)=>{
  void prisma.$transaction((tx:any)=>assertDevelopmentExpenseAccess(tx,(req as any).actor,req.params.id,'write')).then(()=>upload(req,res,(e:any)=>{
   if(e){res.status(400).json({error:{code:'INVALID_UPLOAD',message:e.code==='LIMIT_FILE_SIZE'?'凭据文件不能超过10MiB':'请上传单个凭据文件及有效说明'}});return;}next();
  })).catch((e:any)=>error(res,e));
 },run(async(req,res)=>{
  if(!req.file)throw Object.assign(Error('请选择凭据文件'),{status:400,code:'FILE_REQUIRED'});
  const evidence=await addDevelopmentCostEvidence(ctx(req,'write'),req.params.id,req.params.costId,{bytes:req.file.buffer,originalName:typeof req.body.originalName==='string'?req.body.originalName:req.file.originalname,requestKey:req.body.requestKey,note:req.body.note});res.json(safe({evidence}));
 }));
 router.post(`${base}/:evidenceId/revoke`,session,requirePermission('products:write'),run(async(req,res)=>{res.json(safe({evidence:await revokeDevelopmentCostEvidence(ctx(req,'write'),req.params.id,req.params.costId,req.params.evidenceId,req.body?.reason)}));}));
 const send=(res:Response,result:Awaited<ReturnType<typeof readDevelopmentCostEvidence>>)=>{res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.attachment(result.evidence.originalName);res.type('application/octet-stream');res.send(result.bytes);};
 router.get(`${base}/:evidenceId/download`,session,requirePermission('products:read'),run(async(req,res)=>{send(res,await readDevelopmentCostEvidence(ctx(req,'read'),req.params.id,req.params.costId,req.params.evidenceId));}));
 router.get('/finance-tasks/:taskId/costs/:costId/evidence/:evidenceId/download',session,requirePermission('invoices:read'),run(async(req,res)=>{
  const actorId=(req as any).actor.userId;
  async function authorize(tx:any,caseId?:string){
   const task=await tx.workAssignment.findFirst({where:{id:req.params.taskId,userId:actorId,deletedAt:null}});const meta=task?.metadata;
   if(meta?.managedBy!=='development_cost_closure'||meta?.kind!=='finance_review'||typeof meta.caseId!=='string'||typeof meta.reviewId!=='string'||(caseId&&meta.caseId!==caseId))notFound();
   await assertDevelopmentFinanceRecipient(tx,meta.caseId,actorId);
   const review=await tx.developmentExpenseReview.findFirst({where:{id:meta.reviewId,developmentCaseId:meta.caseId}});
   const costs=(review?.snapshot as any)?.costs?.records;
   if(!Array.isArray(costs)||!costs.some((c:any)=>c.id===req.params.costId&&Array.isArray(c.evidence)&&c.evidence.some((e:any)=>e.id===req.params.evidenceId)))notFound();
   return meta.caseId as string;
  }
  const caseId=await prisma.$transaction((tx:any)=>authorize(tx));
  send(res,await readDevelopmentCostEvidence({prisma,actorId,authorize},caseId,req.params.costId,req.params.evidenceId));
 }));
 return router;
}
