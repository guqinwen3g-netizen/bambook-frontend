import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import multer from 'multer';
import path from 'node:path';
import { requireAuth } from '../auth/middleware';
import type { TokenPayload } from '../auth/service';
import { MistRepository, type MistContract } from './repository';
import { MistPrivateFiles, MIST_FILE_MAX_BYTES } from './files';
import { MistApiError, fail } from './errors';
import {getMistAssistantStatus,runMistAssistant} from './assistant';
import {runQuoteCostAdvisor} from './quoteCostAdvisor';
function exactBody(body: unknown, allowed: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail('INVALID_INPUT', '请求字段无效；身份只能来自登录会话', 400);
  return body as Record<string, any>;
}
function publicError(res: Response, error: any) {
  const known = error instanceof MistApiError || (typeof error?.code === 'string' && Number(error?.status) >= 400 && Number(error?.status) < 500);
  res.status(known ? Number(error.status) : 500).json({ ok: false, error: { code: known ? error.code : 'MIST_REQUEST_FAILED', message: known ? error.message : '工作区操作未完成，请查询原请求回执或稍后重试' } });
}
export function createMistRouter(options: { prisma?: any; filesRoot?: string; repository?: MistRepository; contract?: MistContract; authenticate?: RequestHandler }) {
  const repository = options.repository ?? new MistRepository(options.prisma, options.contract ?? require('../shared/mistWorkspace') as MistContract, new MistPrivateFiles(options.filesRoot ?? path.resolve(__dirname, '../../private/mist-files')));
  const router = Router();
  router.use(options.authenticate ?? requireAuth);
  const actor = (req: Request) => (req as Request & { actor: TokenPayload }).actor;
  const run = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res) => { void handler(req, res).catch(error => publicError(res, error)); };
  router.get('/reviews', run(async (req,res)=>{res.json({reviews:await repository.listReviews(actor(req))});}));
  router.get('/reviews/:workspaceId/receipts/:requestId', run(async (req,res)=>{res.json({receipt:await repository.reviewReceipt(actor(req),req.params.workspaceId,req.params.requestId)});}));
  router.get('/reviews/:workspaceId/:reviewId/files/:fileId',run(async(req,res)=>{const {file,bytes}=await repository.reviewFile(actor(req),req.params.workspaceId,req.params.reviewId,req.params.fileId);res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);res.type('application/octet-stream').send(Buffer.from(bytes));}));
  router.post('/reviews/:workspaceId/:reviewId', run(async (req,res)=>{const body=exactBody(req.body,['requestId','expectedRevision','decision','note']);res.json(await repository.decideReview(actor(req),req.params.workspaceId,req.params.reviewId,body as any));}));
  router.get('/workspaces/default', run(async (req, res) => { res.json({ workspace: await repository.create(actor(req), { name: 'Mist 工作区', seed: 'demo' }, true) }); }));
  router.get('/workspaces', run(async (req, res) => { res.json({ workspaces: await repository.list(actor(req)) }); }));
  router.get('/workspaces/archived',run(async(req,res)=>{res.json({workspaces:await repository.listArchived(actor(req))});}));
  router.post('/workspaces', run(async (req, res) => {
    const body = exactBody(req.body, ['name', 'slug', 'seed']);
    res.status(201).json({ workspace: await repository.create(actor(req), body as any) });
  }));
  router.get('/workspaces/:id', run(async (req, res) => { res.json({ workspace: await repository.get(actor(req), req.params.id) }); }));
  router.post('/workspaces/:id/archive',run(async(req,res)=>{const body=exactBody(req.body,['requestId','expectedRevision']);res.json(await repository.changeArchive(actor(req),req.params.id,body as any,'archive'));}));
  router.post('/workspaces/:id/restore',run(async(req,res)=>{const body=exactBody(req.body,['requestId','expectedRevision']);res.json(await repository.changeArchive(actor(req),req.params.id,body as any,'restore'));}));
  router.post('/workspaces/:id/members',run(async(req,res)=>{const body=exactBody(req.body,['requestId','expectedRevision','action','account']);res.json(await repository.changeMember(actor(req),req.params.id,body as any));}));
  router.get('/workspaces/:id/assistant/status',run(async(req,res)=>{await repository.getForAssistant(actor(req),req.params.id);res.json(getMistAssistantStatus());}));
  router.post('/workspaces/:id/assistant',run(async(req,res)=>{const context=await repository.getForAssistant(actor(req),req.params.id);const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});res.json(await runMistAssistant({...context,body:req.body,signal:controller.signal}));}));
  router.post('/workspaces/:id/quotation-cost-advisor',run(async(req,res)=>{const context=await repository.getForAssistant(actor(req),req.params.id);const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});res.setHeader('Cache-Control','private, no-store');res.json(await runQuoteCostAdvisor({...context,body:req.body,signal:controller.signal}));}));
  router.post('/workspaces/:id/commands', run(async (req, res) => {
    const body = exactBody(req.body, ['requestId', 'expectedRevision', 'command']);
    exactBody(body.command, ['type', 'payload']);
    res.json(await repository.execute(actor(req), req.params.id, body as any));
  }));
  router.get('/workspaces/:id/receipts/:requestId', run(async (req, res) => { res.json({ receipt: await repository.receipt(actor(req), req.params.id, req.params.requestId) }); }));
  router.get('/workspaces/:id/credits/:creditId/versions/:versionId/preview.pdf', run(async (req, res) => {
    const document = await repository.previewCreditDocument(actor(req), req.params.id, req.params.creditId, req.params.versionId);
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(document.name)}`);
    res.setHeader('X-Document-SHA256', document.sha256); res.type('application/pdf').send(Buffer.from(document.bytes));
  }));
  router.get('/workspaces/:id/credits/:creditId/versions/:versionId/document.pdf', run(async (req, res) => {
    const document = await repository.downloadCreditDocument(actor(req), req.params.id, req.params.creditId, req.params.versionId);
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(document.name)}`);
    res.setHeader('X-Document-SHA256', document.sha256); res.type('application/pdf').send(Buffer.from(document.bytes));
  }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MIST_FILE_MAX_BYTES, files: 1, fields: 3, fieldSize: 200 } }).single('file');
  router.post('/workspaces/:id/files', (req: Request, res: Response, next: NextFunction) => {
    // Check owner/account before allocating an uploaded body.
    void repository.get(actor(req), req.params.id).then(() => upload(req, res, error => {
      if (error) { publicError(res, new MistApiError('INVALID_UPLOAD', '请上传单个不超过50MiB的文件', 400)); return; }
      next();
    })).catch(error => publicError(res, error));
  }, run(async (req, res) => {
    const body = exactBody(req.body, ['requestId', 'expectedRevision', 'claimId']);
    if (!req.file) fail('FILE_REQUIRED', '请选择实际文件', 400);
    if (typeof body.expectedRevision !== 'string' || !/^\d+$/.test(body.expectedRevision)) fail('INVALID_INPUT', '工作区版本无效', 400);
    res.status(201).json(await repository.upload(actor(req), req.params.id, { requestId: body.requestId, expectedRevision: Number(body.expectedRevision),...(Object.prototype.hasOwnProperty.call(body,'claimId')?{claimId:body.claimId}:{}) }, { bytes: req.file!.buffer, name: req.file!.originalname, mimeType: req.file!.mimetype }));
  }));
  router.get('/workspaces/:id/files/:fileId', run(async (req, res) => {
    const { file, bytes } = await repository.download(actor(req), req.params.id, req.params.fileId);
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.type('application/octet-stream').send(Buffer.from(bytes));
  }));
  return router;
}
