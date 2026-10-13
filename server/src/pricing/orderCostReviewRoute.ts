import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import type { TokenPayload } from '../auth/service';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { safeRouteError } from '../shared/routeError';
import { businessError } from '../shared/errorCodes';
import { logger } from '../lib/logger';
import { COST_EVIDENCE_MAX_BYTES } from '../development/developmentCostEvidenceFiles';
import type { PricingRouterOptions } from './pricingRoute';
import { authorizeOrderCostReview, createOrderCostReviewService, type OrderCostReviewFiles } from './orderCostReviewService';
import { reviewReject } from './orderCostReviewSource';

/** Mount /api/v1/pricing/order-cost-reviews; no app/scheduler initialization. */
export function createOrderCostReviewRouter(options: PricingRouterOptions & { files?: OrderCostReviewFiles }): Router {
  const router = Router(); const service = createOrderCostReviewService(options.prisma, options.files);
  router.use(createModuleAuthGuard(options));
  const actor = (req: Request) => (req as Request & { actor: TokenPayload }).actor;
  const read = [requirePermission('pricing:read'), requirePermission('sensitive:cost')];
  const write = [requireJwtForWrite(options), requirePermission('invoices:write'), requirePermission('invoices:reconcile')];
  const session = (req: Request, res: Response, next: NextFunction) => { if ((req as any).authSource !== 'user-session') { error(res, businessError('UNAUTHORIZED', '请使用用户会话核对成本')); return; } next(); };
  const error = (res: Response, value: unknown) => {
    logger.error('[order-cost-review] operation failed', { error: (value as Error).message });
    const safe = safeRouteError(value, { fallbackCode: 'ORDER_COST_REVIEW_FAILED', fallbackMessage: '核对结果暂不可确认，请使用原请求重试并核查记录。' });
    res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
  };
  const run = (work: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => { void work(req, res).catch(value => error(res, value)); };
  router.get('/:orderId', ...read, run(async (req, res) => { res.json(await service.list(actor(req), req.params.orderId)); }));
  router.post('/:orderId/preview', ...write, session, run(async (req, res) => { res.json(await service.preview(actor(req), req.params.orderId, req.body)); }));
  router.post('/:orderId/confirm', ...write, session, run(async (req, res) => {
    const result = await service.confirm(actor(req), req.params.orderId, req.body, req.ip);
    if (!result.replayed) options.onDataChange?.({ entity: 'pricing.order-cost-reviews', action: 'create', ids: [result.item.id] });
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  router.post('/:orderId/requests/retire', ...write, session, run(async (req, res) => {
    const result = await service.retire(actor(req), req.params.orderId, req.body, req.ip);
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: COST_EVIDENCE_MAX_BYTES, files: 1, fields: 2, fieldSize: 8000 } }).single('file');
  router.post('/:orderId/evidence', ...write, session, (req, res, next) => {
    void authorizeOrderCostReview(options.prisma, actor(req), 'write', req.params.orderId).then(() => upload(req, res, uploadError => {
      if (uploadError) { error(res, businessError('INVALID_INPUT', '请上传单个有效凭据文件，大小不超过10MiB')); return; } next();
    })).catch(value => error(res, value));
  }, run(async (req, res) => {
    if (!req.file || Object.keys(req.body).some(key => !['requestId', 'note'].includes(key))) reviewReject('INVALID_INPUT', '请选择文件并填写请求标识、凭据说明');
    const result = await service.addEvidence(actor(req), req.params.orderId, { bytes: req.file.buffer, originalName: req.file.originalname, requestId: req.body.requestId, note: req.body.note }, req.ip);
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  router.get('/:orderId/evidence/:evidenceId/download', ...read, run(async (req, res) => {
    const result = await service.download(actor(req), req.params.orderId, req.params.evidenceId);
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.attachment(result.evidence.originalName).type('application/octet-stream').send(result.bytes);
  }));
  return router;
}
