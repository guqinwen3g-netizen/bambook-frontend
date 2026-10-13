import { createBillingItemCommand, retireBillingItemCreateCommand } from './billingItemCreateCommand';
/**
 * billingItemRoute.ts — DR-053 阶段 3：收费事项与成本记录 API
 *
 * 挂载点：
 *   /api/v1/billing-items（createBillingItemRouter）——收费事项（收费决定层）
 *   /api/v1/cost-records（createCostRecordRouter）——成本记录（费用发生层）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品管理域设计.md §12.5/§15
 * 守卫：
 *   - 读 invoices:read（销售只读应收/收费情况，财务可读）
 *   - 写（创建/编辑/确认/开票/取消 + 成本登记）invoices:write（对齐"业务员不登账"原则）
 */
import { Router, Request, Response, NextFunction } from 'express';
import {developmentBillingReadWhere,assertDevelopmentBillingRouteAccess,assertDevelopmentBillingSourceAccess} from '../development/developmentBillingRouteAccess';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { serializeValue } from '../lib/serializeValue';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import {
  createCostRecord, listCostRecords, listCostCandidateRows,
  createBillingItem, listBillingItems, getBillingItem, updateBillingItem,
  confirmBillingItem, invoiceBillingItem, cancelBillingItem,
} from './billingItemService';

export interface BillingRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys?: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

function sendResult(res: Response, r: { ok: true; data: any } | { ok: false; error: { code: string; message: string; status: number } }, status = 200) {
  if (!r.ok) return res.status(r.error.status ?? 400).json({ ok: false, error: r.error });
  return res.status(status).json(serializeValue({ ok: true, ...r.data }));
}

/** /api/v1/billing-items — 收费事项（收费决定层） */
export function createBillingItemRouter(options: BillingRouterOptions): Router {
  const { prisma, requireAuth, onDataChange } = options;
  const apiKeys = options.apiKeys ?? new Set<string>();
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const requireBillingRead = requirePermission('invoices:read');
  const requireBillingWrite = [requireWrite, requirePermission('invoices:write')];
  const notify = (action: string, ids?: string[], entity = 'billing-items') => {
    try { onDataChange?.({ entity, action, ids }); }
    catch (error) { logger.error('[billing-items/notify] failed after commit', { error }); }
  };
  const accessError=(res:Response,error:unknown)=>{
    const safe = safeRouteError(error, { fallbackCode: 'BILLING_ACCESS_FAILED' });
    if (safe.status >= 500) logger.error('[billing-items/access] failed', { error });
    return res.status(safe.status).json({ok:false,error:{code:safe.code,message:safe.message}});
  };
  const scoped=(mode:'read'|'write')=>async(req:Request,res:Response,next:NextFunction)=>{
    try {
      if((req as any).authSource!=='user-session')return res.status(401).json({ok:false,error:{code:'UNAUTHORIZED',message:'请登录后操作收费记录'}});
      (res.locals as any).billingSource=await assertDevelopmentBillingRouteAccess(prisma,(req as any).actor,req.params.id,mode);next();
    }catch(error){accessError(res,error);}
  };

  // 列表（来源/状态筛选）
  router.get('/', requireBillingRead, async (req: Request, res: Response) => {
    try {
      if((req as any).authSource!=='user-session')return res.status(401).json({ok:false,error:{code:'UNAUTHORIZED',message:'请登录后查看收费记录'}});
      const accessWhere=await developmentBillingReadWhere(prisma,(req as any).actor);
      const r = await listBillingItems({ prisma, query: req.query as any, accessWhere });
      sendResult(res, r);
    }catch(error){accessError(res,error);}
  });

  // 创建收费事项（可选 registerCost 登记成本记录）
  router.post('/', ...requireBillingWrite, async (req: Request, res: Response) => {
    const r = await createBillingItemCommand({ prisma, input: req.body ?? {}, actor: (req as any).actor ?? null, ip: req.ip });
    if (r.ok && !r.data.replayed) notify('create', [r.data.billingItem.id]);
    sendResult(res, r, r.ok && r.data.replayed ? 200 : 201);
  });

  // Explicit current-scope reconciliation: only a matching permanent fence
  // releases an unresolved request; a created request returns its original ACK.
  router.post('/create-requests/retire', ...requireBillingWrite, async (req: Request, res: Response) => {
    const r = await retireBillingItemCreateCommand({ prisma, input: req.body ?? {}, actor: (req as any).actor ?? null, ip: req.ip });
    sendResult(res, r);
  });

  // 详情（含四层 flow：costRecords + invoice）
  router.get('/:id', requireBillingRead, scoped('read'), async (req: Request, res: Response) => {
    const r = await getBillingItem({ prisma, id: req.params.id });
    sendResult(res, r);
  });

  // 编辑（draft 态可改金额/免收/抵扣/承担方）
  router.patch('/:id', ...requireBillingWrite, scoped('write'), async (req: Request, res: Response) => {
    const r = await updateBillingItem({ prisma, id: req.params.id, input: req.body ?? {}, actorId: actorIdFromRequest(req) || '' });
    if (r.ok) notify('update', [r.data.billingItem.id]);
    sendResult(res, r);
  });

  // 确认收费决定（锁定金额/免收/抵扣）
  router.post('/:id/confirm', ...requireBillingWrite, scoped('write'), async (req: Request, res: Response) => {
    if(res.locals.billingSource?.developmentExpenseReviewId)return res.status(409).json({ok:false,error:{code:'FINANCE_HANDOFF_REQUIRED',message:'请在整案收费确认时选择财务接手人'}});
    const r = await confirmBillingItem({ prisma, id: req.params.id, actorId: actorIdFromRequest(req) || '' });
    if (r.ok) notify('confirm', [r.data.billingItem.id]);
    sendResult(res, r);
  });

  // 收费事项 → 应收草稿（幂等；净应收≤0 直接闭环）
  router.post('/:id/invoice', ...requireBillingWrite, scoped('write'), async (req: Request, res: Response) => {
    const r = await invoiceBillingItem({ prisma, id: req.params.id, input: req.body ?? {}, actorId: actorIdFromRequest(req) || '', trustedActor: (req as any).actor });
    if (r.ok) {
      notify('invoice', r.data.invoice ? [r.data.invoice.id] : [req.params.id]);
      if (r.data.invoice) notify('invoice', [r.data.invoice.id], 'invoices');
    }
    sendResult(res, r, r.ok && !r.data.recovered ? 201 : 200);
  });

  // 取消（draft/confirmed 可取消；已开票需先作废发票）
  router.post('/:id/cancel', ...requireBillingWrite, scoped('write'), async (req: Request, res: Response) => {
    const r = await cancelBillingItem({ prisma, id: req.params.id, reason: (req.body ?? {}).reason, actorId: actorIdFromRequest(req) || '' });
    if (r.ok) notify('cancel', [r.data.billingItem.id]);
    sendResult(res, r);
  });

  return router;
}

/** /api/v1/cost-records — 成本记录（费用发生层） */
export function createCostRecordRouter(options: BillingRouterOptions): Router {
  const { prisma, requireAuth, onDataChange } = options;
  const apiKeys = options.apiKeys ?? new Set<string>();
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const requireBillingRead = requirePermission('invoices:read');
  const requireBillingWrite = [requireWrite, requirePermission('invoices:write')];
  const notify = (action: string, ids?: string[]) => {
    try { onDataChange?.({ entity: 'cost-records', action, ids }); }
    catch (error) { logger.error('[cost-records/notify] failed after commit', { error }); }
  };

  const guarded=(run:(req:Request,res:Response)=>Promise<unknown>)=>async(req:Request,res:Response)=>{
    try {
      if((req as any).authSource!=='user-session')return res.status(401).json({ok:false,error:{code:'UNAUTHORIZED',message:'请登录后操作费用'}});
      return await run(req,res);
    }catch(error){
      const safe = safeRouteError(error, { fallbackCode: 'COST_ACCESS_FAILED' });
      if (safe.status >= 500) logger.error('[cost-records/access] failed', { error });
      return res.status(safe.status).json({ok:false,error:{code:safe.code,message:safe.message}});
    }
  };

  // [B4 零散收敛 2026-09-15] ⚠️ GET /（费用发生簿列表）前端零消费——"只能写不能看"成立。
  // 前端只 POST /v1/cost-records（developmentService.registerDevelopmentCost 登记开发费用）；
  // 费用的"看"另有两条通道：scene-invoice/preview 候选行 + billing-items/:id 的 flow.costRecords。
  // 保留待业务方定夺（是否补费用发生簿只读视图）——删则 listCostRecords service 一并成孤儿。
  router.get('/', requireBillingRead, guarded(async (req: Request, res: Response) => {
    const r = await listCostRecords({ prisma, query: req.query as any, accessWhere:await developmentBillingReadWhere(prisma,(req as any).actor) });
    sendResult(res, r);
  }));

  router.post('/', ...requireBillingWrite, guarded(async (req: Request, res: Response) => {
    await assertDevelopmentBillingSourceAccess(prisma,(req as any).actor,req.body?.sourceType,req.body?.sourceId,'write');
    const r = await createCostRecord({ prisma, input: req.body ?? {}, actorId: actorIdFromRequest(req) || '', trustedActor: (req as any).actor });
    if (r.ok) notify('create', [r.data.costRecord.id]);
    sendResult(res, r, 201);
  }));

  // DR-054 阶段 E：候选费用行汇总（开票勾选源）——caseId/batchId/sampleId/orderId 任选其一
  // [B4 零散收敛 2026-09-15] ⚠️ route 层前端零消费（前端走 scene-invoice/preview 取候选行）。
  // ⚠️ service listCostCandidateRows **有内部依赖**（sceneInvoiceService.ts preview/create 复用），**不可删**。
  router.get('/cost-rows', requireBillingRead, guarded(async (req: Request, res: Response) => {
    const r = await listCostCandidateRows({ prisma, query: req.query as any, accessWhere:await developmentBillingReadWhere(prisma,(req as any).actor) });
    sendResult(res, r);
  }));

  return router;
}
