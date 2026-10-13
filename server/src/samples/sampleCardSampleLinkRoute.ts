/** Mount before Sample's dynamic /:id. Independent protocol; old Room writes never substitute it. */
import { Router, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { serializeValue } from '../lib/serializeValue';
import { logger } from '../lib/logger';
import { getSampleCardSampleLinkContext, listSampleCardSampleLinkCandidates, linkReceivedCardToSample, recoverSampleCardSampleLink, listReceivedCardsForSample, listSampleLinkedReviewCards } from './sampleCardSampleLinkService';

export interface SampleCardSampleLinkRouterOptions { prisma: PrismaClient; requireAuth: boolean; apiKeys?: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void; }
export function createSampleCardSampleLinkRouter(options: SampleCardSampleLinkRouterOptions): Router {
  const router = Router(); const auth = { requireAuth: options.requireAuth, apiKeys: options.apiKeys ?? new Set<string>() };
  router.use(createModuleAuthGuard(auth));
  const read = requirePermission('products:read');
  const send = (res: Response, r: any) => r.ok ? res.status(200).json(serializeValue({ ok: true, ...r.data }))
    : res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
  const readQuery = (req: any, res: Response) => {
    if (Object.keys(req.query).some(k => !['limit', 'cursor'].includes(k))) { res.status(400).json({ error: { code: 'INVALID_INPUT', message: '原卡读取只接受 limit/cursor，目标样品由当前路径固定。' } }); return false; }
    return true;
  };
  router.get('/room/sample-links/:sampleId/received-cards', read, async (req, res) => {
    if (readQuery(req, res)) return send(res, await listReceivedCardsForSample({ prisma: options.prisma, actor: (req as any).actor, sampleId: req.params.sampleId, limit: req.query.limit, cursor: req.query.cursor }));
  });
  router.get('/room/sample-links/:sampleId/linked-review', read, async (req, res) => {
    if (readQuery(req, res)) return send(res, await listSampleLinkedReviewCards({ prisma: options.prisma, actor: (req as any).actor, sampleId: req.params.sampleId, limit: req.query.limit, cursor: req.query.cursor }));
  });
  const path = '/room/items/:cardId/sample-link';
  router.get(`${path}/context`, read, async (req, res) => send(res, await getSampleCardSampleLinkContext({ prisma: options.prisma, actor: (req as any).actor, cardId: req.params.cardId })));
  router.get(`${path}/candidates`, read, async (req, res) => send(res, await listSampleCardSampleLinkCandidates({ prisma: options.prisma, actor: (req as any).actor, cardId: req.params.cardId, limit: req.query.limit, cursor: req.query.cursor })));
  router.post(`${path}/exact`, requireJwtForWrite(auth), requirePermission('sample:room:write'), read, async (req, res) => {
    const result = await linkReceivedCardToSample({ prisma: options.prisma, actor: (req as any).actor, cardId: req.params.cardId, input: req.body, ip: req.ip });
    // Commit is durable even if a UI notification cannot be delivered.
    if (result.ok && !result.data.replayed) try { options.onDataChange?.({ entity: 'samples', action: 'link_sample_card_to_sample', ids: [req.params.cardId, result.data.ack.targetSampleId] }); }
    catch (error) { logger.error('[sample-card-link] committed notification failed', { error }); }
    return send(res, result);
  });
  router.get(`${path}/requests/:requestKey`, read, async (req, res) => send(res, await recoverSampleCardSampleLink({ prisma: options.prisma, actor: (req as any).actor, cardId: req.params.cardId, requestKey: req.params.requestKey })));
  return router;
}
