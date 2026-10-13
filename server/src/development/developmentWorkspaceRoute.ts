import { Router, type Response } from 'express';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { extractActorFromRequest } from '../auth/middleware';
import { exactJsonValue } from '../lib/exactJsonValue';
import { safeRouteError } from '../shared/routeError';
import { businessError } from '../shared/errorCodes';
import { createDevelopmentWorkspaceService } from './developmentWorkspaceService';

/** Mount before /dev/:id. Guards apply only to these actual paths. */
export function createDevelopmentWorkspaceRouter(options: { prisma: any; apiKeys?: Set<string> }) {
  const router = Router(), auth = { requireAuth: true, apiKeys: options.apiKeys ?? new Set<string>() }, service = createDevelopmentWorkspaceService(options);
  async function send(res: Response, work: () => Promise<unknown>) {
    try { res.json(exactJsonValue({ ok: true, data: await work() })); }
    catch (error) { const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '当前开发工作区暂时无法核验，请保留原请求后重新核对。' }); res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } }); }
  }
  router.get('/:caseId/business-workspace', createModuleAuthGuard(auth), (req, res) => send(res, () => {
    if (Object.keys(req.query).some(key => key !== 'sampleVersionId') || req.query.sampleVersionId !== undefined && typeof req.query.sampleVersionId !== 'string')
      throw businessError('INVALID_INPUT', '请提供准确开发版本。');
    return service.read(req.params.caseId, extractActorFromRequest(req), req.query.sampleVersionId as string | undefined);
  }));
  router.post('/:caseId/business-workspace/continue', createModuleAuthGuard(auth), requireJwtForWrite(auth), (req, res) =>
    send(res, () => service.continue(req.params.caseId, extractActorFromRequest(req), req.body, req.ip)));
  return router;
}
