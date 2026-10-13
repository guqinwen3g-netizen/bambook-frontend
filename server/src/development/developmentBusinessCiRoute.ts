import { Router, type Request, type Response, type NextFunction } from 'express';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { safeRouteError } from '../shared/routeError';
import { renderHtmlToPdf } from '../templates/pdf';
import { commandDevelopmentCi, previewDevelopmentCiSource } from './developmentBusinessCiService';
import { ciJson, readDevelopmentCiVersionInTx } from './developmentCiSource';
import { renderDevelopmentCiDocument } from './developmentCiDocument';
import { readDevelopmentFinanceProjection } from './developmentFinanceProjectionService';
import { businessError } from '../shared/errorCodes';
import { createDevelopmentSupplementalBillingDraft, previewDevelopmentSupplementalBilling } from './developmentBillingDraftService';
import { commandDevelopmentCommercialBilling, listDevelopmentCommercialBillings, readDevelopmentCommercialOptions } from './developmentCommercialBillingService';
import { previewDevelopmentCiV2Source } from './developmentBusinessCiV2Service';

/** Mount at /api/v1/development, before the existing development router. */
export function createDevelopmentBusinessCiRouter(options: { prisma: any; requireAuth: boolean; apiKeys: Set<string>; onDataChange?: (value: any) => void }) {
  const { prisma } = options, router = Router();
  router.use(createModuleAuthGuard(options));
  const session = (req: Request, res: Response, next: NextFunction) => {
    if ((req as any).authSource !== 'user-session' || !(req as any).actor?.userId) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请登录后处理开发 CI。' } });
    next();
  };
  const handle = (run: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { const value = await run(req, res); if (!res.headersSent) res.json(ciJson(value)); }
    catch (error) { const failure = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '开发 CI 结果暂不可确认，请保留原请求并刷新核对。' }); res.status(failure.status).json({ error: { code: failure.code, message: failure.message } }); }
  };
  router.get('/:id/ci-finance', session, requirePermission('products:read'), handle(req => readDevelopmentFinanceProjection(prisma, req.params.id, (req as any).actor)));
  router.get('/:id/ci-billings', session, requirePermission('products:read'), handle(req => listDevelopmentCommercialBillings({ prisma, actor: (req as any).actor }, req.params.id)));
  router.get('/:id/ci-commercial-options', session, requirePermission('products:read'), handle(req => readDevelopmentCommercialOptions({ prisma, actor: (req as any).actor }, req.params.id,
    typeof req.query.billingItemId === 'string' ? req.query.billingItemId : undefined)));
  const commercialCommand = (billing: boolean) => handle(async req => {
    const result = await commandDevelopmentCommercialBilling({ prisma, actor: (req as any).actor }, req.params.id, billing ? req.params.billingId : null, req.body);
    if (!result.replayed) options.onDataChange?.({ entity: 'development', action: 'commercial_billing', ids: [req.params.id, result.receipt.billingItemId] });
    return result;
  });
  router.post('/:id/ci-billings', session, requirePermission('products:write'), commercialCommand(false));
  router.post('/:id/ci-billings/:billingId/charge-lines', session, requirePermission('products:write'), commercialCommand(true));
  router.get('/:id/ci-source', session, requirePermission('products:read'), handle(req => previewDevelopmentCiV2Source({ prisma, actor: (req as any).actor }, req.params.id,
    typeof req.query.billingItemIds === 'string' ? req.query.billingItemIds.split(',') : [], typeof req.query.documentId === 'string' ? req.query.documentId : undefined)));
  router.get('/:id/ci-source/:billingId', session, requirePermission('products:read'), handle(req => previewDevelopmentCiSource({ prisma, actor: (req as any).actor }, req.params.id, req.params.billingId)));
  router.get('/:id/ci-uncovered-costs', session, requirePermission('products:read'), handle(req => previewDevelopmentSupplementalBilling({ prisma, actor: (req as any).actor }, req.params.id)));
  router.post('/:id/ci-supplemental-billings', session, requirePermission('products:write'), handle(async req => {
    const result = await createDevelopmentSupplementalBillingDraft({ prisma, actor: (req as any).actor }, req.params.id, req.body);
    if (!result.replayed) options.onDataChange?.({ entity: 'development', action: 'supplemental_billing', ids: [req.params.id, result.receipt.billingItemId] });
    return result;
  }));
  router.post('/:id/ci-commands', session, requirePermission('products:write'), handle(async req => {
    const result = await commandDevelopmentCi({ prisma, actor: (req as any).actor }, req.params.id, req.body);
    if (!result.replayed) options.onDataChange?.({ entity: 'development', action: 'business_ci', ids: [req.params.id, result.receipt.documentId] });
    return result;
  }));
  const read = (req: Request) => prisma.$transaction(async (tx: any) => {
    const result = await readDevelopmentCiVersionInTx(tx, req.params.documentId, (req as any).actor,
      req.query.version === undefined ? {} : { version: Number(req.query.version) });
    if (result.snapshot.caseId !== req.params.id) throw businessError('NOT_FOUND', '票据不属于当前案。');
    return result;
  });
  router.get('/:id/ci/:documentId', session, requirePermission('products:read'), handle(read));
  router.get('/:id/ci/:documentId/preview.html', session, requirePermission('products:read'), handle(async (req, res) => {
    const source = await read(req); res.setHeader('Cache-Control', 'no-store'); res.type('html').send(renderDevelopmentCiDocument(source, true));
  }));
  router.get('/:id/ci/:documentId/render.pdf', session, requirePermission('products:read'), handle(async (req, res) => {
    const source = await read(req), pdf = await renderHtmlToPdf(renderDevelopmentCiDocument(source));
    const final = await read(req); if (final.version.id !== source.version.id) throw businessError('CONFLICT', '原票已变化，请重新下载。');
    res.setHeader('Cache-Control', 'no-store'); res.type('pdf').send(pdf.pdf);
  }));
  return router;
}
