/** Generic workflow HTTP: current module permissions and source L2 are enforced
 * inside the same transaction as every write; domain approval stays separate. */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { WorkflowEngine } from './workflowEngine';
export function createWorkflowRouter(prisma: PrismaClient): Router {
  const router = Router(), engine = new WorkflowEngine(prisma);
  const run = (operation: string, handler: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { await handler(req, res); }
    catch (error) {
      logger.error('[WorkflowRoute] operation failed', { operation, error });
      const result = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '工作流操作未能完成，请保留原请求并稍后核对' });
      res.status(result.status).json({ error: result.code, message: result.message });
    }
  };
  const command = (req: Request) => ({ actor: extractActorFromRequest(req), clientRequestId: req.body?.clientRequestId,
    expectedStepId: req.body?.expectedStepId, expectedStepIndex: req.body?.expectedStepIndex, sourceFingerprint: req.body?.sourceFingerprint });
  router.get('/definitions', run('definitions', async (req, res) => { res.json({ definitions: await engine.listDefinitions(extractActorFromRequest(req)) }); }));
  router.get('/sources', run('sources', async (req, res) => {
    res.json(await engine.listSources({ actor: extractActorFromRequest(req), entityType: req.query.entityType as string,
      limit: req.query.limit === undefined ? 50 : Number(req.query.limit), offset: req.query.offset === undefined ? 0 : Number(req.query.offset) }));
  }));
  router.post('/requests/result', run('request-result', async (req, res) => {
    res.json(await engine.getRequestResult(req.body, extractActorFromRequest(req)));
  }));
  router.post('/requests/retire', run('request-retire', async (req, res) => {
    res.json(await engine.retireRequest(req.body, extractActorFromRequest(req)));
  }));
  router.post('/instances', run('create', async (req, res) => {
    const actor = extractActorFromRequest(req);
    const instance = await engine.createInstance({ definitionId: req.body?.definitionId, entityType: req.body?.entityType, entityId: req.body?.entityId,
      title: req.body?.title, clientRequestId: req.body?.clientRequestId, actor, initiatedById: actor?.userId });
    res.status(201).json({ instance });
  }));
  router.get('/instances', run('list', async (req, res) => {
    const q = req.query;
    res.json(await engine.listInstances({ actor: extractActorFromRequest(req), status: q.status as any, entityType: q.entityType as string,
      entityId: q.entityId as string, view: q.view as any, initiatedById: q.initiatedById as string, pendingApproverUserId: q.pendingApproverUserId as string,
      pendingApproverRole: q.pendingApproverRole as string, limit: q.limit === undefined ? 50 : Number(q.limit), offset: q.offset === undefined ? 0 : Number(q.offset) }));
  }));
  router.get('/instances/:id', run('detail', async (req, res) => {
    const instance = await engine.getInstance(req.params.id, extractActorFromRequest(req));
    if (!instance) { res.status(404).json({ error: 'NOT_FOUND', message: '工作流实例不存在' }); return; }
    res.json({ instance });
  }));
  for (const [path, decision] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
    router.post('/instances/:id/' + path, run(path, async (req, res) => {
      const options = command(req);
      res.json({ instance: await engine.decideStep({ ...options, instanceId: req.params.id, decidedById: options.actor?.userId || '', decision,
        note: req.body?.note, confirmedReviewedContent: req.body?.confirmedReviewedContent,
        rejectionReason: req.body?.rejectionReason, requestedChanges: req.body?.requestedChanges }) });
    }));
  }
  router.post('/instances/:id/cancel', run('cancel', async (req, res) => {
    res.json({ instance: await engine.cancelInstance(req.params.id, req.body?.reason, command(req)) });
  }));
  router.get('/entity/:entityType/:entityId', run('history', async (req, res) => {
    res.json({ instances: await engine.getInstancesForEntity(req.params.entityType, req.params.entityId, extractActorFromRequest(req)) });
  }));
  return router;
}
