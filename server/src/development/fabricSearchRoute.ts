import { listDevelopmentQcRoutingTeams } from './developmentQcRouting';
import { transitionFabricSearch } from './fabricSearchFlow';
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { currentDevelopmentActor, developmentAssignee, fabricSearchRouting, fabricSearchEligibleTeams, DevelopmentWorkError, listDevelopmentPersonnel } from './developmentPersonnelService';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { createTeamShareService } from '../teams/teamShareService';
import type { TokenPayload } from '../auth/service';
import { safeRouteError } from '../shared/routeError';
import { isValidLocalDateKey } from '../shared/localDate';

const include = { responsibleHead: { select: { id: true, displayName: true } }, routingTeam: { select: { id: true, name: true } }, requester: { select: { id: true, displayName: true } }, assignee: { select: { id: true, displayName: true } }, requestTeam: { select: { id: true, name: true } }, results: { include: { asset: { select: { id: true, name: true, sku: true, mainCategory: true, deletedAt: true } } } } };
const required = (value: unknown, label: string, max = 4000): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new DevelopmentWorkError('INVALID_INPUT', `请填写有效的${label}。`);
  return value.trim();
};
const date = (value: unknown) => {
  if (!value) return null;
  if (!isValidLocalDateKey(value)) throw new DevelopmentWorkError('INVALID_DATE', '请选择有效的反馈日期。');
  return value;
};
export function createFabricSearchRouter({ prisma }: { prisma: any }) {
  const router = Router();
  const run = (handler: (req: any, actor: any) => Promise<any>, write = false) => async (req: any, res: any) => {
    try {
      if (req.authSource !== 'user-session' || !req.actor?.userId) throw new DevelopmentWorkError('UNAUTHORIZED', '请使用员工账号登录。', 401);
      const actor = await currentDevelopmentActor(prisma, req.actor.userId, write, req.actor);
      const data = await handler(req, actor);
      await currentDevelopmentActor(prisma, req.actor.userId, write, req.actor);
      res.json({ ok: true, data });
    } catch (error) {
      if (error instanceof DevelopmentWorkError) res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } });
      else { console.error('fabric search request failed', error); const failure = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '操作未完成，请重试。' }); res.status(failure.status).json({ ok: false, error: { code: failure.code, message: failure.message } }); }
    }
  };
  const withWriteActor = (req: { actor: TokenPayload }, work: (tx: any, actor: Awaited<ReturnType<typeof currentDevelopmentActor>>) => Promise<any>) =>
    prisma.$transaction(async (tx: any) => {
      const actor = await currentDevelopmentActor(tx, req.actor.userId, true, req.actor);
      const result = await work(tx, actor);
      await currentDevelopmentActor(tx, req.actor.userId, true, req.actor);
      return result;
    });
  const visible = async (db: any, actor: any) => actor.isOwner ? {} : { OR: [{ requesterId: actor.id }, { assigneeId: actor.id }, { responsibleHeadId: actor.id }, { status: 'unclaimed', assigneeId: null, routingTeamId: { in: await fabricSearchEligibleTeams(db, actor.id, actor.trustedActor) } }] };
  const read = async (db: any, id: string, actor: any) => {
    const task = await db.fabricSearchTask.findFirst({ where: { id, ...await visible(db, actor) }, include });
    if (!task) throw new DevelopmentWorkError('NOT_FOUND', '寻样任务不存在或当前账号无权查看。', 404);
    return task;
  };
  router.get('/personnel', run(async (req, actor) => {
    const directory = await listDevelopmentPersonnel(prisma, actor.id, actor.trustedActor);
    if (req.query?.caseId === undefined) return directory;
    const caseId = required(req.query.caseId, '开发单', 100);
    const qcRoutingTeams = await listDevelopmentQcRoutingTeams(prisma, caseId, actor.id, actor.trustedActor);
    return { ...directory, qcRoutingTeams };
  }));
  router.get('/fabric-search', run(async (req, actor) => prisma.fabricSearchTask.findMany({ where: await visible(prisma, actor), include, orderBy: { updatedAt: 'desc' }, take: 100 })));
  router.get('/fabric-search/:id', run((req, actor) => read(prisma, req.params.id, actor)));
  router.post('/fabric-search', run(async (req, actor) => {
    const b = req.body;
    const command = { name: required(b.name, '任务名称', 200), requestText: required(b.requestText, '寻样要求'), initiator: b.initiator, assigneeId: b.assigneeId ? required(b.assigneeId, '跟进人', 100) : null, ...(b.routingTeamId ? { routingTeamId: required(b.routingTeamId, '面料业务团队', 100) } : {}), requestTeamId: b.initiator === 'internal' ? required(b.requestTeamId, '发起团队', 100) : null, customerRelationId: b.initiator === 'customer' ? required(b.customerRelationId, '客户', 100) : null, targetDate: date(b.targetDate) };
    if (!['internal', 'customer'].includes(command.initiator)) throw new DevelopmentWorkError('INVALID_INPUT', '请选择需求来源。');
    const requestKey = required(b.requestKey, '请求标识', 100);
    const existing = await prisma.fabricSearchTask.findUnique({ where: { requesterId_requestKey: { requesterId: actor.id, requestKey } }, include });
    if (existing) {
      if (Object.entries(command).some(([key, value]) => existing.creationInput[key] !== value)) throw new DevelopmentWorkError('REQUEST_CONFLICT', '此请求已用于另一项需求，请重新发起。', 409);
      return existing;
    }
    try { return await withWriteActor(req, async (tx, actor) => {
      const routing = await fabricSearchRouting(tx, actor.id, command, actor.trustedActor);
      const directory = await listDevelopmentPersonnel(tx, actor.id, actor.trustedActor);
      if (command.requestTeamId && !directory.requestTeams.some((t: any) => t.id === command.requestTeamId)) throw new DevelopmentWorkError('INVALID_TEAM', '请选择自己所属的有效业务团队。');
      let customerName: string | null = null;
      if (command.customerRelationId) {
        const customer = await tx.relation.findFirst({ where: { id: command.customerRelationId, category: 'Customer', isOrganization: true, deletedAt: null } });
        const accessActor = { ...actor.trustedActor, displayName: actor.displayName };
        if (!customer || await createTeamShareService(tx).resolveRelationAccess(accessActor, customer.id) === 'none') throw new DevelopmentWorkError('INVALID_CUSTOMER', '请选择有权访问的客户组织。');
        customerName = customer.name;
      }
      await currentDevelopmentActor(tx, actor.id, true, actor.trustedActor);
      const id = randomUUID();
      const task = await tx.fabricSearchTask.create({ data: { id, code: `FS-${id.slice(0, 8).toUpperCase()}`, ...command, ...routing, requesterId: actor.id, requestKey, creationInput: command, customerName, status: routing.assigneeId ? 'pending' : 'unclaimed', flowHistory: [{action:'create',actorId:actor.id,actorName:actor.displayName,at:new Date().toISOString(),from:null,to:routing.assigneeId ? 'pending' : 'unclaimed',note:'',assigneeId:routing.assigneeId}] }, include });
      await writeRouteAuditLog({ prisma: tx, actorId: actor.id, source: 'user-session', operation: 'fabric-search.create', targetType: 'fabric-search', targetId: id, after: command });
      await tx.notification.create({data: {userId: task.assigneeId || task.responsibleHeadId, type: 'fabric_search_assigned', title: '新的面料寻样任务', body: `${actor.displayName}：${task.name}`, link: `/development?id=${id}&tab=fabric-search`}});
      return task;
    }); } catch (error: any) {
      if (error?.code === 'P2002') {
        await currentDevelopmentActor(prisma, actor.id, true, actor.trustedActor);
        const recovered = await prisma.fabricSearchTask.findUnique({where:{requesterId_requestKey:{requesterId:actor.id,requestKey}},include});
        if (recovered && !Object.entries(command).some(([key,value])=>recovered.creationInput[key] !== value)) return recovered;
        if (recovered) throw new DevelopmentWorkError('REQUEST_CONFLICT','此请求已用于另一项需求。',409);
      }
      throw error;
    }
  }, true));
  const mutate = (complete: boolean) => run(async (req) => withWriteActor(req, async (tx, actor) => {
    const task = await read(tx, req.params.id, actor);
    const b = req.body;
    if (task.status !== 'in_progress' || actor.id !== task.assigneeId || !Number.isInteger(b.expectedRevision) || task.revision !== b.expectedRevision) throw new DevelopmentWorkError('REVISION_CONFLICT', '任务已更新或已结案，请刷新后再操作。', 409);
    const data: any = { revision: { increment: 1 } };
    if (complete) {
      if (!task.results.length || task.results.some((r: any) => r.asset.deletedAt !== null || r.asset.mainCategory !== 'Fabric')) throw new DevelopmentWorkError('NO_RESULTS', '请先保存至少一份有效的面料档案。');
      data.status = 'completed'; data.completedAt = new Date(); data.completionNote = typeof b.completionNote === 'string' ? b.completionNote.trim().slice(0, 4000) : null;
    } else {
      if (b.assigneeId !== undefined && b.assigneeId !== task.assigneeId) throw new DevelopmentWorkError('TRANSFER_REQUIRED','请使用转交操作并填写原因。');
      if (b.assigneeId !== undefined) { await developmentAssignee(tx, actor.id, b.assigneeId, 'fabric', actor.trustedActor); data.assigneeId = b.assigneeId; }
      if (b.name !== undefined) data.name = required(b.name, '任务名称', 200);
      if (b.requestText !== undefined) data.requestText = required(b.requestText, '寻样要求');
      if (b.targetDate !== undefined) data.targetDate = date(b.targetDate);
      if (b.assetIds !== undefined) {
        if (!Array.isArray(b.assetIds) || b.assetIds.length > 100 || b.assetIds.some((id: any) => typeof id !== 'string')) throw new DevelopmentWorkError('INVALID_ASSETS', '面料档案选择无效。');
        const ids: string[] = [...new Set<string>(b.assetIds)];
        const assets = await tx.productAsset.findMany({ where: { id: { in: ids }, mainCategory: 'Fabric', deletedAt: null }, select: { id: true } });
        if (assets.length !== ids.length) throw new DevelopmentWorkError('INVALID_ASSETS', '部分档案已删除或不是面料，请重新选择。');
        data.results = { deleteMany: {}, create: ids.map(assetId => ({ assetId, addedBy: actor.id, recommendation: typeof b.assetNotes?.[assetId] === 'string' ? b.assetNotes[assetId].trim().slice(0,2000) : task.results.find((r:any)=>r.assetId===assetId)?.recommendation || null })) };
      }
    }
    await currentDevelopmentActor(tx, actor.id, true, actor.trustedActor);
    const locked = await tx.fabricSearchTask.updateMany({ where: { id: task.id, revision: task.revision, status: 'in_progress' }, data: { revision: { increment: 1 } } });
    if (!locked.count) throw new DevelopmentWorkError('REVISION_CONFLICT', '任务已更新，请刷新后再操作。', 409);
    delete data.revision;
    const updated = await tx.fabricSearchTask.update({ where: { id: task.id }, data, include });
    await writeRouteAuditLog({ prisma: tx, actorId: actor.id, source: 'user-session', operation: complete ? 'fabric-search.complete' : 'fabric-search.update', targetType: 'fabric-search', targetId: task.id, before: { revision: task.revision, status: task.status }, after: { revision: updated.revision, status: updated.status, assigneeId: updated.assigneeId, assetIds: updated.results.map((r: any) => r.assetId) } });
    if (complete || updated.assigneeId !== task.assigneeId) await tx.notification.create({data: {userId: complete ? task.requesterId : updated.assigneeId, type: complete ? 'fabric_search_completed' : 'fabric_search_assigned', title: complete ? '面料寻样已结案' : '面料寻样已转交', body: task.name, link: `/development?id=${task.id}&tab=fabric-search`}});
    return updated;
  }), true);
  router.patch('/fabric-search/:id', mutate(false));
  router.post('/fabric-search/:id/actions/:action', run(async(req)=>withWriteActor(req,async(tx,actor)=>{
    const task=await read(tx,req.params.id,actor);
    await currentDevelopmentActor(tx,actor.id,true,actor.trustedActor);
    return transitionFabricSearch(tx,task,actor,req.params.action,req.body,include);
  }),true));
  router.post('/fabric-search/:id/complete', run(async()=>{throw new DevelopmentWorkError('CONFIRM_REQUIRED','请先反馈结果，再由发起人确认结案。',409);},true));
  return router;
}
