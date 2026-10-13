/**
 * sceneInvoiceRoute.ts — DR-054 阶段 F：场景化开票统一入口（财务域）
 *
 * 挂载：/api/v1/finance/scene-invoice
 * 守卫：读 invoices:read（preview）；写（create）invoices:write
 * 场景：dev_cost（开发费）| fabric（面料开发&大货）| sample（样品及邮寄）| order（大货货款）
 */
import { Router, Request, Response, NextFunction } from 'express';
import {assertDevelopmentBillingSourceAccess,developmentBillingReadWhere} from '../development/developmentBillingRouteAccess';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { safeRouteError, type SafeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { previewSceneInvoice, createSceneInvoice } from './sceneInvoiceService';
import { readBulkInvoiceSources } from './bulkInvoiceReadProjection';

export interface SceneInvoiceRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys?: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

function sendResult(res: Response, r: { ok: true; data: any } | { ok: false; error: { code: string; message: string; status: number } }, status = 200) {
  if (!r.ok) return res.status(r.error.status ?? 400).json({ ok: false, error: r.error });
  return res.status(status).json({ ok: true, ...r.data });
}

function sendFailure(res: Response, failure: SafeRouteError, error: unknown) {
  if (failure.status >= 500) logger.error('[scene-invoice] operation failed', { error });
  return res.status(failure.status).json({ ok: false, error: { code: failure.code, message: failure.message, ...(failure.details === undefined ? {} : { details: failure.details }) } });
}

export function createSceneInvoiceRouter(options: SceneInvoiceRouterOptions): Router {
  const { prisma, requireAuth, onDataChange } = options;
  const apiKeys = options.apiKeys ?? new Set<string>();
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const requireInvoiceRead = requirePermission('invoices:read');
  const requireInvoiceWrite = [requireWrite, requirePermission('invoices:write')];
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'invoices', action, ids });
  const sourceAccess=(mode:'read'|'write')=>async(req:Request,res:Response,next:NextFunction)=>{
    try {
      if((req as any).authSource!=='user-session')return res.status(401).json({ok:false,error:{code:'UNAUTHORIZED',message:'请登录后查看或办理费用'}});
      const {scene,sourceId}=req.body??{};
      if(!['dev_cost','fabric','sample','order'].includes(scene)||typeof sourceId!=='string'||!sourceId.trim())return res.status(400).json({ok:false,error:{code:'INVALID_SOURCE',message:'请选择场景并填写来源'}});
      const sourceType=scene==='sample'?'Sample':scene==='order'?'Order':'DevelopmentCase';
      await assertDevelopmentBillingSourceAccess(prisma,(req as any).actor,sourceType,sourceId,mode);
      res.locals.costAccessWhere=await developmentBillingReadWhere(prisma,(req as any).actor);
      let caseId=sourceType==='DevelopmentCase'?sourceId:null;
      if(sourceType==='Sample'){
        const sample=await prisma.sample.findFirst({where:{id:sourceId,deletedAt:null}});
        if(sample?.sourceCaseId&&['dev','seal'].includes(sample.type))caseId=sample.sourceCaseId;
      }
      res.locals.wholeCaseBilling=caseId?{caseId,message:'开发费用按整案核齐后确定收费或减免，请从开发案的结案与费用核对办理，再由财务接手。'}:null;
      if(mode==='write'&&caseId)return res.status(409).json({ok:false,error:{code:'WHOLE_CASE_BILLING_REQUIRED',message:res.locals.wholeCaseBilling.message}});
      next();
    }catch(error){
      const failure = safeRouteError(error, { fallbackCode: 'SCENE_ACCESS_FAILED' });
      sendFailure(res,failure,error);
    }
  };

  const bulkRead = [requireInvoiceRead, requirePermission('orders:read'), requirePermission('shipments:read')];
  router.get('/bulk-sources', ...bulkRead, async (req: Request, res: Response) => {
    try {
      const items = await readBulkInvoiceSources(prisma, (req as any).actor, { orderId: typeof req.query.orderId === 'string' ? req.query.orderId : undefined });
      res.json({ ok: true, items });
    } catch (error) { sendFailure(res, safeRouteError(error, { fallbackCode: 'SCENE_INVOICE_PREVIEW_FAILED' }), error); }
  });
  router.get('/bulk-sources/:batchId', ...bulkRead, async (req: Request, res: Response) => {
    try {
      const items = await readBulkInvoiceSources(prisma, (req as any).actor, { orderId: typeof req.query.orderId === 'string' ? req.query.orderId : undefined, batchId: req.params.batchId });
      res.json({ ok: true, source: items[0] });
    } catch (error) { sendFailure(res, safeRouteError(error, { fallbackCode: 'SCENE_INVOICE_PREVIEW_FAILED' }), error); }
  });

  // preview：候选费用行 + 汇总（只读）
  router.post('/preview', requireInvoiceRead, sourceAccess('read'), async (req: Request, res: Response) => {
    try {
    const { scene, sourceId } = req.body ?? {};
    if (!sourceId) { res.status(400).json({ ok: false, error: { code: 'SOURCE_REQUIRED', message: 'sourceId 必填' } }); return; }
    const r = await previewSceneInvoice({ prisma, scene: String(scene || ''), sourceId: String(sourceId), accessWhere:res.locals.costAccessWhere });
    if(r.ok)Object.assign(r.data,{wholeCaseBilling:res.locals.wholeCaseBilling});
    sendResult(res, r);
    } catch (error) {
      const failure = safeRouteError(error, { fallbackCode: 'SCENE_INVOICE_PREVIEW_FAILED' });
      sendFailure(res, failure, error);
    }
  });

  // create：选费用行子集 → 发票（行级开票）
  router.post('/create', ...requireInvoiceWrite, sourceAccess('write'), async (req: Request, res: Response) => {
    try {
    const { scene, sourceId, lineIds, ...input } = req.body ?? {};
    if (!sourceId) { res.status(400).json({ ok: false, error: { code: 'SOURCE_REQUIRED', message: 'sourceId 必填' } }); return; }
    if (!Array.isArray(lineIds) || lineIds.length === 0) { res.status(400).json({ ok: false, error: { code: 'LINES_REQUIRED', message: '请至少选择一条费用行' } }); return; }
    const r = await createSceneInvoice({
      prisma,
      accessWhere:res.locals.costAccessWhere,
      scene: String(scene || ''),
      sourceId: String(sourceId),
      lineIds: lineIds.map(String),
      input: input ?? {},
      actorId: actorIdFromRequest(req) || '',
      trustedActor: (req as any).actor,
      ip: req.ip ?? null,
    });
    if (r.ok) notify('scene-invoice-create', [r.data.invoice.id]);
    sendResult(res, r, 201);
    } catch (error) {
      const failure = safeRouteError(error, { fallbackCode: 'SCENE_INVOICE_CREATE_FAILED' });
      sendFailure(res, failure, error);
    }
  });

  return router;
}
