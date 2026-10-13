import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { requirePermission } from '../auth/permissionGuard';
import { readBusinessShipmentCiSource, writeBusinessShipmentCi } from '../customs/businessShipmentCi';
import { safeRouteError } from '../shared/routeError';
import { businessError } from '../shared/errorCodes';

/** Mounted after the existing shipping authentication guard. */
export function createBusinessCiRouter(db: PrismaClient, requireWrite: any) {
  const router = Router();
  const invoke = (operation: 'source' | 'draft' | 'revise' | 'issue') => async (req: any, res: any) => {
    try {
      const actor = req.actor ?? extractActorFromRequest(req);
      if (!actor) throw businessError('UNAUTHORIZED', '请使用当前账号制单。');
      const result = operation === 'source' ? await readBusinessShipmentCiSource(db, req.params.id, req.body, actor)
        : await writeBusinessShipmentCi(db, req.params.id, req.body, actor, operation, req.params.documentId);
      res.json({ ok: true, data: result });
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  };
  // Selection is a structured body; source read does not produce facts.
  router.post('/:id/business-ci/source', requireWrite, requirePermission('customs:write'), invoke('source'));
  router.post('/:id/business-ci/draft', requireWrite, requirePermission('customs:write'), invoke('draft'));
  router.post('/:id/business-ci/:documentId/revise', requireWrite, requirePermission('customs:write'), invoke('revise'));
  router.post('/:id/business-ci/:documentId/issue', requireWrite, requirePermission('customs:write'), invoke('issue'));
  return router;
}
