import { Router, type Request, type Response } from 'express';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { safeRouteError } from '../shared/routeError';
import { ciJson } from '../development/developmentCiSource';
import { listPendingDevelopmentCiReceivables, registerDevelopmentCiReceivable } from './developmentCiReceivableService';
import { businessError } from '../shared/errorCodes';

/** Mount at /api/v1/finance before its generic /:id handler. */
export function createDevelopmentCiFinanceRouter(options: { prisma: any; requireAuth: boolean; apiKeys: Set<string>; onDataChange?: (value: any) => void }) {
  const router = Router(); router.use(createModuleAuthGuard(options));
  const handle = (run: (req: Request) => Promise<any>) => async (req: Request, res: Response) => {
    try { res.json(ciJson(await run(req))); }
    catch (error) { const failure = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '开发 CI 财务登记结果暂不可确认，请核对原票后重试。' }); res.status(failure.status).json({ error: { code: failure.code, message: failure.message } }); }
  };
  router.get('/development-ci-pending', requirePermission('invoices:read'), handle(req => listPendingDevelopmentCiReceivables(options.prisma, (req as any).actor)));
  router.post('/development-ci/:documentId/register', requireJwtForWrite(options), requirePermission('invoices:write'), handle(async req => {
    if (req.body && Object.keys(req.body).some(key => !['requestKey', 'expectedVersionId'].includes(key))) throw businessError('INVALID_INPUT', '财务登记金额和客户只取已签发原票，不能手工覆盖。');
    const result = await registerDevelopmentCiReceivable(options.prisma, (req as any).actor, req.params.documentId, req.body);
    if (!result.replayed) options.onDataChange?.({ entity: 'finance', action: 'register_development_ci', ids: [result.invoice.id] });
    return result;
  }));
  return router;
}
