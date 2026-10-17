import { listSupplierDirectory, supplierDirectoryItem } from './supplierDirectory';
/**
 * Supplier / Factory Module Route — 供应商管理（阶段 H H1 / PRD 13 / 19.18）
 *
 * 端点（挂载于 /api/v1/suppliers）：
 *
 * 工厂档案 FactoryProfile：
 *   - GET    /                          — 档案列表/排名（search / blacklisted / sort=quality|delivery|orders|amount）
 *   - POST   /                          — 建立工厂档案（挂 category=Supplier 的组织 Relation，1:1）
 *   - GET    /expiring-certifications   — 认证到期预警扫描（?days=30，字面路由须在 /:id 之前）
 *   - GET    /:id                       — 档案详情（含 Relation + 认证）
 *   - PATCH  /:id                       — 更新档案（白名单字段）
 *   - DELETE /:id                       — 软删除档案
 *   - POST   /:id/blacklist             — 拉黑（{reason}，suppliers:admin scope）
 *   - DELETE /:id/blacklist             — 解除拉黑（suppliers:admin scope）
 *
 * 评估记录 FactoryEvaluation（append-only 真源，追加后事务内重算质量/交期缓存分）：
 *   - GET    /:id/evaluations           — 评分明细（?kind=inspection|delivery）
 *   - POST   /:id/evaluations           — 追加评分 {kind, score 0-100, sourceType?, sourceId?, evaluatedAt, note?}
 *
 * 认证记录 FactoryCertification：
 *   - GET    /:id/certifications        — 认证列表（按有效期升序）
 *   - POST   /:id/certifications        — 新增认证 {type, certificateNo?, issuedAt?, validUntil?}
 *   - PATCH  /certifications/:certId    — 更新认证
 *   - DELETE /certifications/:certId    — 软删除认证
 *
 * 产能日历 FactoryCapacity（占用量由在手采购单实时聚合，不落地）：
 *   - GET    /:id/capacity              — 产能日历（含 occupied 聚合）
 *   - PUT    /:id/capacity/:month       — upsert 月计划产能 {capacity, unit?, note?}
 *   - DELETE /:id/capacity/:month       — 软删除月产能
 *
 * 总览：
 *   - GET    /:id/overview              — 工厂 360°（档案 + 近期评分 + 认证 + 产能）
 *
 * 守卫口径与 email 模块一致：读走 JWT 或 API-Key，写必须 JWT（requireJwtForWrite）；
 * 全部写端点叠加 requirePermission('suppliers:write') scope 守卫（对齐 procurementRoute
 * requireProcurementWrite 口径：JWT permissions 直查 / legacy 角色映射矩阵兜底）；
 * 黑名单属高风险管理动作，叠加 requirePermission('suppliers:admin') scope 守卫
 * （S3-γ：legacy owner/admin/manager 角色门收编为 scope 门；SM/ADMIN 持有，SuperAdmin 全通）。
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { serializeValue } from '../lib/serializeValue';
import { createFactoryService, FactoryProfileInput, FactoryEvaluationInput, FactoryCertificationInput } from './factoryService';
import { createTcCertificateService, TcResult } from './tcCertificateService';
import { createDelayImpactService } from './delayImpactService';

export interface SupplierRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createSupplierRouter(options: SupplierRouterOptions): Router {
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const router = Router();
  const service = createFactoryService(prisma);
  const tcService = createTcCertificateService(prisma);
  const delayService = createDelayImpactService(prisma);

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  // 写端点 scope 门（对齐 procurementRoute requireProcurementWrite 口径；黑名单另叠加 suppliers:admin）
  const requireSupplierWrite = requirePermission('suppliers:write');
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'suppliers', action, ids });

  const handleError = (res: Response, e: any, code: string) => {
    const msg = e?.message || 'operation failed';
    logger.error(`[SupplierRoute] ${code}`, { error: msg });
    const isClient =
      msg.includes('必填') || msg.includes('非法') || msg.includes('必须是') ||
      msg.includes('无效') || msg.includes('已停用') || msg.includes('已存在') || msg.includes('仅 category') ||
      msg.includes('挂在组织') || msg.includes('禁止') || msg.includes('之间');
    const isNotFound = msg.includes('不存在');
    res.status(isNotFound ? 404 : isClient ? 400 : 500).json({ error: { code, message: msg } });
  };

  // ══════════════════════════════════════════════════════════════
  // 字面路由（须在 /:id 之前）
  // ══════════════════════════════════════════════════════════════

  // GET / — 列表/排名
  router.get('/', async (req: Request, res: Response) => {
    try {
      const blacklisted =
        req.query.blacklisted === 'true' ? true :
        req.query.blacklisted === 'false' ? false : undefined;
      const result = await service.listProfiles({
        search: req.query.search ? String(req.query.search) : undefined,
        blacklisted,
        sort: req.query.sort ? String(req.query.sort) : undefined,
        order: req.query.order === 'asc' ? 'asc' : req.query.order === 'desc' ? 'desc' : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json(serializeValue(result));
    } catch (e: any) {
      handleError(res, e, 'LIST_FAILED');
    }
  });

  // GET /expiring-certifications — 认证到期预警（默认 30 天）
  router.get('/expiring-certifications', async (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
      const items = await service.listExpiringCertifications(days);
      res.json(serializeValue({ items, total: items.length, days }));
    } catch (e: any) {
      handleError(res, e, 'EXPIRING_LIST_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // REQ2-06 GRS TC 交易证书链 TcCertificate（DR-048；字面路由须在 /:id 之前）
  // ══════════════════════════════════════════════════════════════

  /** TcResult → HTTP（结构化错误码直透） */
  const handleTcResult = <T>(
    res: Response,
    result: TcResult<T>,
    successStatus: number,
    wrap: (data: T) => Record<string, unknown>,
  ) => {
    if (!result.ok) {
      return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
    }
    res.status(successStatus).json(serializeValue(wrap(result.data)) as any);
  };

  // POST /tc-certificates — 登记 TC（三段链）
  router.post('/tc-certificates', requireWrite, requireSupplierWrite, async (req: Request, res: Response) => {
    const result = await tcService.createTc((req.body ?? {}) as any);
    if (result.ok) notify('create_tc_certificate', [result.data.tc.id]);
    handleTcResult(res, result, 201, (d) => ({ ok: true, tc: d.tc }));
  });

  // GET /tc-certificates?orderId= | ?relationId= — 链视图（按 stage 分组 + 段位吨位聚合）
  router.get('/tc-certificates', async (req: Request, res: Response) => {
    const result = await tcService.listTc({
      orderId: typeof req.query.orderId === 'string' ? req.query.orderId : undefined,
      relationId: typeof req.query.relationId === 'string' ? req.query.relationId : undefined,
    });
    handleTcResult(res, result, 200, (d) => ({ ok: true, ...d }));
  });

  // GET /tc-certificates/verify?orderId= — 一键校验（四检查项，只读；出货门禁消费方调用）
  router.get('/tc-certificates/verify', async (req: Request, res: Response) => {
    const result = await tcService.verifyChain(String(req.query.orderId ?? ''));
    handleTcResult(res, result, 200, (d) => ({ ok: true, verification: d }));
  });

  // PATCH /tc-certificates/:tcId — 修正（吨位/效期/备注白名单）
  router.patch('/tc-certificates/:tcId', requireWrite, requireSupplierWrite, async (req: Request, res: Response) => {
    const result = await tcService.updateTc(req.params.tcId, (req.body ?? {}) as any);
    if (result.ok) notify('update_tc_certificate', [req.params.tcId]);
    handleTcResult(res, result, 200, (d) => ({ ok: true, tc: d.tc }));
  });

  // DELETE /tc-certificates/:tcId — 软删
  router.delete('/tc-certificates/:tcId', requireWrite, requireSupplierWrite, async (req: Request, res: Response) => {
    const result = await tcService.deleteTc(req.params.tcId);
    if (result.ok) notify('delete_tc_certificate', [req.params.tcId]);
    handleTcResult(res, result, 200, (d) => ({ ok: true, id: d.id }));
  });

  // ══════════════════════════════════════════════════════════════
  // REQ2-10 工厂延迟链路影响计算（DR-052；字面路由须在 /:id 之前）
  // ══════════════════════════════════════════════════════════════

  /** DelayImpactResult → HTTP（结构化错误码直透） */
  const handleDelayResult = <T>(res: Response, result: { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } }, successStatus: number, wrap: (data: T) => Record<string, unknown>) => {
    if (!result.ok) {
      return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
    }
    res.status(successStatus).json(serializeValue(wrap(result.data)) as any);
  };

  // GET /delays/preview?supplierRelationId=&delayDays= — 登记前预检（不落库）
  router.get('/delays/preview', async (req: Request, res: Response) => {
    const result = await delayService.previewImpact(
      String(req.query.supplierRelationId ?? ''),
      Number(req.query.delayDays),
    );
    handleDelayResult(res, result, 200, (d) => ({ ok: true, ...d }));
  });

  // POST /delays — 登记延迟（落库 + 影响快照 + 交期分联动）
  router.post('/delays', requireWrite, requireSupplierWrite, async (req: Request, res: Response) => {
    const result = await delayService.registerDelay((req.body ?? {}) as any, actorIdFromRequest(req));
    if (result.ok) notify('register_factory_delay', [result.data.record.id]);
    handleDelayResult(res, result, 201, (d) => ({ ok: true, record: d.record, impact: d.impact, qualityScoreLinked: d.qualityScoreLinked }));
  });

  // GET /delays?supplierRelationId= — 延迟记录列表
  router.get('/delays', async (req: Request, res: Response) => {
    const result = await delayService.listDelays({
      supplierRelationId: typeof req.query.supplierRelationId === 'string' ? req.query.supplierRelationId : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    handleDelayResult(res, result, 200, (d) => ({ ok: true, items: d.items }));
  });

  // GET /delays/:id — 详情（登记时影响快照）
  router.get('/delays/:id', async (req: Request, res: Response) => {
    const result = await delayService.getDelay(req.params.id);
    handleDelayResult(res, result, 200, (d) => ({ ok: true, record: d.record }));
  });

  router.get('/directory', async (req, res) => {
    try { res.json(serializeValue(await listSupplierDirectory(prisma, req.query))); }
    catch (e: any) { handleError(res, e, 'DIRECTORY_FAILED'); }
  });
  router.get('/directory/:relationId', async (req, res) => {
    try {
      const relation = await prisma.relation.findUnique({where:{id:req.params.relationId}});
      if (!relation || relation.deletedAt != null || relation.category !== 'Supplier' || !relation.isOrganization) return res.status(404).json({error:'供应商不存在'});
      const stored = await prisma.factoryProfile.findUnique({where:{relationId:relation.id}});
      const profile = supplierDirectoryItem(relation,stored);
      const overview = profile.productionProfileId ? await service.getOverview(profile.productionProfileId) : null;
      res.json(serializeValue({...overview,profile,evaluations:overview?.evaluations||[],certifications:overview?.certifications||[],capacity:overview?.capacity||[]}));
    } catch(e:any) {handleError(res,e,'DIRECTORY_DETAIL_FAILED');}
  });

  // Existing supplier identity is reused; never replace its production data with an empty draft.
  router.post('/ensure', requireWrite, requireSupplierWrite, async (req: Request, res: Response) => {
    try {
      const relationId = String(req.body.relationId || '');
      if (!relationId) throw new Error('relationId 必填');
      const identity = await prisma.relation.findUnique({where:{id:relationId}});
      if (!identity || identity.deletedAt != null || identity.category !== 'Supplier' || !identity.isOrganization) throw new Error('必须是有效供应商组织');
      const previous = await prisma.factoryProfile.findUnique({where:{relationId}});
      if (previous?.deletedAt != null) throw new Error('该供应商档案已停用，请先恢复档案');
      let profile = await service.getProfileByRelation(relationId);
      if (!profile) {
        try { profile = await service.createProfile(req.body as FactoryProfileInput, actorIdFromRequest(req)); }
        catch (error: any) {
          // A concurrent submission may have completed the same one-to-one association.
          profile = await service.getProfileByRelation(relationId);
          if (!profile || profile.deletedAt != null) throw error;
        }
      }
      notify('upsert', [profile.id]);
      res.json(serializeValue({ ok: true, item: profile }));
    } catch (e: any) { handleError(res, e, 'ENSURE_PROFILE_FAILED'); }
  });

  // POST / — 建立工厂档案
  router.post('/', requireWrite, requireSupplierWrite, async (req: Request, res: Response) => {
    try {
      const profile = await service.createProfile(req.body as FactoryProfileInput, actorIdFromRequest(req));
      notify('create', [profile.id]);
      res.status(201).json(serializeValue({ ok: true, item: profile }));
    } catch (e: any) {
      handleError(res, e, 'CREATE_FAILED');
    }
  });

  // PATCH /certifications/:certId（字面前缀，须在 /:id 通配前注册）
  router.patch('/certifications/:certId', requireWrite, requireSupplierWrite, async (req: Request, res: Response) => {
    try {
      const cert = await service.updateCertification(req.params.certId, req.body, actorIdFromRequest(req));
      notify('update_certification', [cert.id]);
      res.json(serializeValue({ ok: true, item: cert }));
    } catch (e: any) {
      handleError(res, e, 'UPDATE_CERT_FAILED');
    }
  });

  router.delete('/certifications/:certId', requireWrite, requireSupplierWrite, async (req: Request, res: Response) => {
    try {
      await service.deleteCertification(req.params.certId, actorIdFromRequest(req));
      notify('delete_certification', [req.params.certId]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'DELETE_CERT_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 档案 /:id
  // ══════════════════════════════════════════════════════════════

  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const profile = await service.getProfile(req.params.id);
      if (!profile) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '工厂档案不存在' } });
      res.json(serializeValue({ item: profile }));
    } catch (e: any) {
      handleError(res, e, 'GET_FAILED');
    }
  });

  router.patch('/:id', requireWrite, requireSupplierWrite, async (req: Request, res: Response) => {
    try {
      const profile = await service.updateProfile(req.params.id, req.body, actorIdFromRequest(req));
      notify('update', [profile.id]);
      res.json(serializeValue({ ok: true, item: profile }));
    } catch (e: any) {
      handleError(res, e, 'UPDATE_FAILED');
    }
  });

  router.delete('/:id', requireWrite, requirePermission('suppliers:admin') /* P6：评级/删除档案须主管 */, async (req: Request, res: Response) => {
    try {
      await service.deleteProfile(req.params.id, actorIdFromRequest(req));
      notify('delete', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'DELETE_FAILED');
    }
  });

  // ─── 黑名单（高风险管理动作：suppliers:admin scope，S3-γ 收编） ───

  router.post('/:id/blacklist', requireWrite, requirePermission('suppliers:admin'), async (req: Request, res: Response) => {
    try {
      const profile = await service.setBlacklist(req.params.id, String(req.body?.reason || ''), actorIdFromRequest(req));
      notify('blacklist', [profile.id]);
      res.json(serializeValue({ ok: true, item: profile }));
    } catch (e: any) {
      handleError(res, e, 'BLACKLIST_FAILED');
    }
  });

  router.delete('/:id/blacklist', requireWrite, requirePermission('suppliers:admin'), async (req: Request, res: Response) => {
    try {
      const profile = await service.clearBlacklist(req.params.id, actorIdFromRequest(req));
      notify('unblacklist', [profile.id]);
      res.json(serializeValue({ ok: true, item: profile }));
    } catch (e: any) {
      handleError(res, e, 'UNBLACKLIST_FAILED');
    }
  });

  // ─── 评估记录 ───

  router.get('/:id/evaluations', async (req: Request, res: Response) => {
    try {
      const items = await service.listEvaluations(req.params.id, req.query.kind ? String(req.query.kind) : undefined);
      res.json(serializeValue({ items, total: items.length }));
    } catch (e: any) {
      handleError(res, e, 'EVALUATION_LIST_FAILED');
    }
  });

  router.post('/:id/evaluations', requireWrite, requirePermission('suppliers:admin') /* P6：评级/删除档案须主管 */, async (req: Request, res: Response) => {
    try {
      const evaluation = await service.addEvaluation(req.params.id, req.body as FactoryEvaluationInput, actorIdFromRequest(req));
      notify('add_evaluation', [evaluation.id]);
      res.status(201).json(serializeValue({ ok: true, item: evaluation }));
    } catch (e: any) {
      handleError(res, e, 'ADD_EVALUATION_FAILED');
    }
  });

  // ─── 认证记录 ───

  router.get('/:id/certifications', async (req: Request, res: Response) => {
    try {
      const items = await service.listCertifications(req.params.id);
      res.json(serializeValue({ items, total: items.length }));
    } catch (e: any) {
      handleError(res, e, 'CERT_LIST_FAILED');
    }
  });

  router.post('/:id/certifications', requireWrite, requireSupplierWrite, async (req: Request, res: Response) => {
    try {
      const cert = await service.addCertification(req.params.id, req.body as FactoryCertificationInput, actorIdFromRequest(req));
      notify('add_certification', [cert.id]);
      res.status(201).json(serializeValue({ ok: true, item: cert }));
    } catch (e: any) {
      handleError(res, e, 'ADD_CERT_FAILED');
    }
  });

  // ─── 产能日历 ───

  router.get('/:id/capacity', async (req: Request, res: Response) => {
    try {
      const items = await service.listCapacity(req.params.id);
      res.json(serializeValue({ items, total: items.length }));
    } catch (e: any) {
      handleError(res, e, 'CAPACITY_LIST_FAILED');
    }
  });

  router.put('/:id/capacity/:month', requireWrite, requireSupplierWrite, async (req: Request, res: Response) => {
    try {
      const row = await service.upsertCapacity(req.params.id, {
        month: req.params.month,
        capacity: Number(req.body?.capacity),
        unit: req.body?.unit ?? null,
        note: req.body?.note ?? null,
      }, actorIdFromRequest(req));
      notify('upsert_capacity', [row.id]);
      res.json(serializeValue({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'UPSERT_CAPACITY_FAILED');
    }
  });

  router.delete('/:id/capacity/:month', requireWrite, requireSupplierWrite, async (req: Request, res: Response) => {
    try {
      await service.deleteCapacity(req.params.id, req.params.month, actorIdFromRequest(req));
      notify('delete_capacity', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'DELETE_CAPACITY_FAILED');
    }
  });

  // ─── 360° 总览 ───

  router.get('/:id/overview', async (req: Request, res: Response) => {
    try {
      const overview = await service.getOverview(req.params.id);
      if (!overview) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '工厂档案不存在' } });
      res.json(serializeValue(overview));
    } catch (e: any) {
      handleError(res, e, 'OVERVIEW_FAILED');
    }
  });

  return router;
}
