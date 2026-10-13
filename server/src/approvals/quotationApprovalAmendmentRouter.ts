import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { safeRouteError } from '../shared/routeError';
import type { DecideActor, ApprovalDecisionInput } from './approvalDecisionService';
import { createQuotationApprovalAmendmentService, type QuotationApprovalAmendment } from './quotationAmendmentService';

export interface QuotationApprovalAmendmentRouterOptions {
  prisma: PrismaClient;
  authenticateRead: (req: Request, res: Response) => DecideActor | null;
  authenticateDecide: (req: Request, res: Response) => DecideActor | null;
  decide: (input: ApprovalDecisionInput) => Promise<any>;
}

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};
const permittedKeys = (value: Record<string, any>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const reviewVersion = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function parseAmendment(value: unknown, includePreview: boolean): QuotationApprovalAmendment | null {
  const amendment = object(value);
  const allowed = ['lineUnitPrices', 'validUntil', 'notes', 'reason', ...(includePreview ? ['previewVersion', 'finalContentVersion'] : [])];
  if (!permittedKeys(amendment, allowed) || typeof amendment.reason !== 'string') return null;
  if (amendment.lineUnitPrices !== undefined && (!Array.isArray(amendment.lineUnitPrices)
    || !amendment.lineUnitPrices.every((row: any) => row && permittedKeys(row, ['lineId', 'unitPrice'])
      && typeof row.lineId === 'string' && (typeof row.unitPrice === 'string' || typeof row.unitPrice === 'number')))) return null;
  if (amendment.validUntil !== undefined && amendment.validUntil !== null && typeof amendment.validUntil !== 'string') return null;
  if (amendment.notes !== undefined && amendment.notes !== null && typeof amendment.notes !== 'string') return null;
  if (includePreview && (!reviewVersion(amendment.previewVersion) || !reviewVersion(amendment.finalContentVersion))) return null;
  return amendment as QuotationApprovalAmendment;
}

function respondWithError(res: Response, error: any, fallbackMessage: string) {
  const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage });
  return res.status(safe.status).json({ error: safe.message });
}

/** Native line/total quotation amendment endpoints; no generic quote-write permission is granted. */
export function createQuotationApprovalAmendmentRouter(options: QuotationApprovalAmendmentRouterOptions): Router {
  const router = Router();
  const service = createQuotationApprovalAmendmentService({ prisma: options.prisma });

  router.post('/:id/quotation-amendment/preview', async (req: Request, res: Response) => {
    const actor = options.authenticateDecide(req, res);
    if (!actor) return;
    try {
      const body = object(req.body);
      if (!permittedKeys(body, ['reviewContentVersion', 'amendment']) || !reviewVersion(body.reviewContentVersion))
        return res.status(400).json({ error: '修订预览请求格式无效' });
      const amendment = parseAmendment(body.amendment, false);
      if (!amendment) return res.status(400).json({ error: '报价修订字段超出白名单或格式无效' });
      const preview = await service.preview({ approvalId: req.params.id, actorId: actor.userId,
        reviewContentVersion: body.reviewContentVersion, amendment });
      return res.json({ preview });
    } catch (error) { return respondWithError(res, error, 'failed to preview quotation amendment'); }
  });

  router.post('/:id/quotation-amendment/confirm', async (req: Request, res: Response) => {
    const actor = options.authenticateDecide(req, res);
    if (!actor) return;
    try {
      const body = object(req.body);
      if (!permittedKeys(body, ['reviewContentVersion', 'reviewPreviewDigest', 'confirmedReviewedContent', 'amendment'])
        || !reviewVersion(body.reviewContentVersion)
        || (body.reviewPreviewDigest !== undefined && !reviewVersion(body.reviewPreviewDigest))
        || body.confirmedReviewedContent !== true)
        return res.status(400).json({ error: '报价修订确认内容或格式无效' });
      const amendment = parseAmendment(body.amendment, true);
      if (!amendment) return res.status(400).json({ error: '报价修订确认字段超出白名单或格式无效' });
      const decision = await options.decide({ id: req.params.id, actor, decision: 'approved', source: 'api:approvals',
        ip: req.ip, reviewContentVersion: body.reviewContentVersion,
        ...(body.reviewPreviewDigest !== undefined ? { reviewPreviewDigest: body.reviewPreviewDigest } : {}),
        confirmedReviewedContent: true,
        quotationAmendment: amendment });
      if (decision.updated?.id !== req.params.id || decision.updated?.status !== 'approved'
        || decision.quotationAmendment?.approvalId !== req.params.id)
        return res.status(409).json({ error: '报价修订和审批决议无法核验' });
      return res.json({ item: decision.updated, amendment: decision.quotationAmendment,
        ...(decision.eventDelivery ? { eventDelivery: decision.eventDelivery } : {}) });
    } catch (error) { return respondWithError(res, error, 'failed to confirm quotation amendment'); }
  });

  router.get('/:id/quotation-amendment/result', async (req: Request, res: Response) => {
    const actor = options.authenticateRead(req, res);
    if (!actor) return;
    try {
      const result = await service.readResult({ approvalId: req.params.id, actorId: actor.userId, roles: actor.roles });
      return res.json({ result });
    } catch (error) { return respondWithError(res, error, 'failed to read quotation amendment result'); }
  });

  return router;
}
