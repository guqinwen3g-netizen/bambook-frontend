/**
 * routeV2.ts — Phase 1-01 客户/市场域 V2 路由
 *
 * 挂载点：/api/v2/relations
 *
 * 与 V1 (/api/v1/relations) 的区别：
 *   - V2 使用 requirePermission 守卫（scope 级精确校验）
 *   - V2 列表/详情自带行级权限过滤（dataScope）
 *   - V2 创建自动生成编号（CUS-00001 / SUP-00001）
 *   - V2 创建/更新自动校验 stage/tier（DataDictionary）
 *   - V2 新增：销售漏斗聚合 GET /funnel + 阶段变更 PATCH /:id/stage
 *
 * 路由表：
 *   GET    /                  — 列表（带 scope + 筛选 + 分页；DR-042 读 scope 含小组维 + teamShares 徽章 + ?teamId= 组筛选器）
 *   GET    /funnel            — 销售漏斗聚合（按 stage 分组 count）
 *   GET    /:id               — 详情（带 scope 校验；DR-042 附 accessMode + teamShares chips）
 *   GET    /:id/team-shares   — DR-042 反查该客户共享给了哪些组（chips 数据）
 *   POST   /:id/team-shares   — DR-042 详情页就地共享 { teamIds[], permission }
 *   DELETE /:id/team-shares/:teamId — DR-042 就地移除共享 { reason }
 *   POST   /                  — 创建（编号 + 字典 + 配置默认值）
 *   PUT    /:id               — 更新（scope + 字典校验；DR-042 写 scope 仅部门维）
 *   PATCH  /:id/stage         — 阶段变更（Kanban 拖拽；写 scope 仅部门维）
 *   DELETE /:id               — 软删除（scope 校验；写 scope 仅部门维）
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { extractActorFromRequest } from '../auth/middleware';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { createRelationServiceV2 } from './relationServiceV2';
import { logger } from '../lib/logger';
import { csvCellSafe } from '../_shared/csvCell';
import { todayLocalKey } from '../shared/localDate';


export interface RelationsV2RouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

export function createRelationsV2Router(opts: RelationsV2RouterOptions): Router {
  const router = Router();

  // 上游 auth guard（JWT cookie/Bearer 或 API-key）
  const guard = createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });
  router.use(guard);

  // 写操作需要 JWT
  const requireWrite = requireJwtForWrite({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });

  const svc = createRelationServiceV2(opts.prisma);

  // 从 req 提取 actor
  function actorOf(req: Request) {
    return extractActorFromRequest(req);
  }

  // ── GET / 列表 ──
  router.get('/', requirePermission('relations:read'), async (req, res) => {
    const actor = actorOf(req);
    const filter = {
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      stage: typeof req.query.stage === 'string' ? req.query.stage : undefined,
      tier: typeof req.query.tier === 'string' ? req.query.tier : undefined,
      ownerId: typeof req.query.ownerId === 'string' ? req.query.ownerId : undefined,
      departmentId: typeof req.query.departmentId === 'string' ? req.query.departmentId : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      isOrganization: req.query.isOrganization === 'true' ? true : req.query.isOrganization === 'false' ? false : undefined,
      // 联系人统一：按挂靠组织过滤人物记录（CRM 页联系人 Tab 拉档案域联系人用）
      parentId: typeof req.query.parentId === 'string' && req.query.parentId ? req.query.parentId : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
      sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
      teamId: typeof req.query.teamId === 'string' ? req.query.teamId : undefined, // DR-042 §8.2 组筛选器
      bizScope: (req.query.bizScope === 'mine' ? 'mine' : undefined) as 'mine' | undefined, // P1-001：L2 业务口径（CRM 下拉）
    };
    const result = await svc.listRelations(actor, filter);
    if (!result.ok) return res.status(500).json({ error: result.error!.code, message: result.error!.message });
    return res.json({ ok: true, ...result.data });
  });

  // ── GET /funnel 销售漏斗 ──
  // [B4 零散收敛 2026-09-15] ⚠️ 前端零消费（无销售漏斗视图）。后端聚合 getSalesFunnel 已完整实现，
  // 非死代码而是**能力缺口**：待业务方定夺「补 CRM 销售漏斗视图」或「随 v2 双轨统一下线」。
  // 保留现状，勿在未拍板前删（删则丢失已就绪聚合能力）。
  router.get('/funnel', requirePermission('relations:read'), async (req, res) => {
    const actor = actorOf(req);
    const filter = {
      category: typeof req.query.category === 'string' ? req.query.category : 'Customer',
      tier: typeof req.query.tier === 'string' ? req.query.tier : undefined,
    };
    const result = await svc.getSalesFunnel(actor, filter);
    if (!result.ok) return res.status(500).json({ error: result.error!.code, message: result.error!.message });
    return res.json({ ok: true, ...result.data });
  });

  // ── GET /:id/team-shares DR-042 反查共享组（chips + 当前用户访问档位）──
  router.get('/:id/team-shares', requirePermission('relations:read'), async (req, res) => {
    const actor = actorOf(req);
    const result = await svc.getRelationTeamShares(actor, req.params.id);
    if (!result.ok) {
      const statusMap: Record<string, number> = { NOT_FOUND: 404, INTERNAL_ERROR: 500 };
      return res.status(statusMap[result.error!.code] || 500).json({ error: result.error!.code, message: result.error!.message });
    }
    // accessMode 供前端渲染跟进输入框（§8.3）；解析失败按最严格档（fail-closed）
    let accessMode = 'none';
    try {
      const { createTeamShareService } = await import('../teams/teamShareService');
      accessMode = await createTeamShareService(opts.prisma).resolveRelationAccess(actor, req.params.id);
    } catch { /* fail-closed: none */ }
    return res.json({ ok: true, teamShares: result.data, accessMode });
  });

  // ── POST /:id/team-shares DR-042 详情页就地共享 ──
  router.post('/:id/team-shares', requireWrite, requirePermission('relations:write'), async (req, res) => {
    const actor = actorOf(req);
    const teamIds: string[] = Array.isArray(req.body?.teamIds) ? req.body.teamIds.map(String).filter(Boolean) : [];
    const permission = req.body?.permission === 'read' ? 'read' : 'read+followup';
    if (teamIds.length === 0) return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'body.teamIds[] 必填' });
    const result = await svc.shareRelationToTeams(actor, req.params.id, { teamIds, permission }, req.ip);
    if (!result.ok) {
      // DR-042 §7 错误码契约
      const statusMap: Record<string, number> = {
        UNAUTHORIZED: 401, VALIDATION_FAILED: 400, INVALID_GRANT: 400,
        NOT_FOUND: 404, ENTITY_NOT_FOUND: 404, TEAM_NOT_FOUND: 404,
        TEAM_DISSOLVED: 409, FORBIDDEN: 403, GRANT_SCOPE_BLOCKED: 403,
        SENSITIVE_ENTITY_NOT_SHAREABLE: 409, // v2.2 §4.4 T-41：confidential 禁止组共享
      };
      return res.status(statusMap[result.error!.code] || 500).json({ error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, ...result.data });
  });

  // ── DELETE /:id/team-shares/:teamId DR-042 就地移除共享 ──
  router.delete('/:id/team-shares/:teamId', requireWrite, requirePermission('relations:write'), async (req, res) => {
    const actor = actorOf(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'body.reason 必填（审计留痕）' });
    const result = await svc.unshareRelationFromTeam(actor, req.params.id, req.params.teamId, reason, req.ip);
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        UNAUTHORIZED: 401, NOT_FOUND: 404, VALIDATION_FAILED: 400, FORBIDDEN: 403, INTERNAL_ERROR: 500,
      };
      return res.status(statusMap[result.error!.code] || 500).json({ error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, ...result.data });
  });

  // ── GET /:id/360 360°客户视图 ──
  router.get('/:id/360', requirePermission('relations:read'), async (req, res) => {
    const actor = actorOf(req);
    const result = await svc.get360View(actor, req.params.id);
    if (!result.ok) {
      const status = result.error!.code === 'NOT_FOUND' ? 404 : 500;
      return res.status(status).json({ error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, ...result.data });
  });

  // ── POST /batch/stage 批量阶段变更 ──
  router.post('/batch/stage', requireWrite, requirePermission('relations:write'), async (req, res) => {
    const actor = actorOf(req);
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const newStage = typeof req.body?.stage === 'string' ? req.body.stage.trim() : '';
    if (ids.length === 0 || !newStage) return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'ids[] 和 stage 必填' });
    const result = await svc.batchChangeStage(actor, ids, newStage);
    if (!result.ok) return res.status(500).json({ error: result.error!.code, message: result.error!.message });
    return res.json({ ok: true, ...result.data });
  });

  // ── GET /export.csv 客户档案受控导出（REQ2-13 DR-056-④，SEC-01）──
  // 门禁 data:export:full（矩阵既定仅 SuperAdmin 的高危 scope）：业务员/普通角色 403；
  // 每次导出写审计（actor/行数/过滤条件）。注册于 /:id 之前，防路径参数误吞。
  router.get('/export.csv', requireWrite, requirePermission('data:export:full'), async (req, res) => {
    try {
      const where: Record<string, unknown> = { deletedAt: null };
      if (typeof req.query.category === 'string' && req.query.category) where.category = req.query.category;
      if (typeof req.query.stage === 'string' && req.query.stage) where.stage = req.query.stage;
      if (typeof req.query.tier === 'string' && req.query.tier) where.tier = req.query.tier;
      if (req.query.isOrganization === 'true') where.isOrganization = true;
      if (req.query.isOrganization === 'false') where.isOrganization = false;

      // 上限兜底：导出属管理动作，超限提示收窄过滤条件（防误操作全表拉取）
      const MAX_EXPORT_ROWS = 20_000;
      const total = await opts.prisma.relation.count({ where });
      if (total > MAX_EXPORT_ROWS) {
        return res.status(400).json({ error: 'EXPORT_TOO_LARGE', message: `匹配 ${total} 行超过导出上限 ${MAX_EXPORT_ROWS}，请用 category/stage/tier 收窄范围` });
      }

      const rows = await opts.prisma.relation.findMany({
        where,
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
        select: {
          code: true, name: true, chineseName: true, englishName: true, category: true, type: true,
          stage: true, tier: true, sensitivity: true, ownerId: true, primaryContactName: true,
          email: true, phone: true, website: true, currency: true,
        },
      });

      const header = ['code', 'name', 'chineseName', 'englishName', 'category', 'type', 'stage', 'tier', 'sensitivity', 'ownerId', 'primaryContactName', 'email', 'phone', 'website', 'currency'];
      // 2026-09-15：改用共享 csvCellSafe —— 原实现只处理引号/逗号/换行，
      // 不防 CSV 公式注入（客户名以 = + - @ 开头时，导出的 CSV 在 Excel 打开会被当公式执行）。
      const csvEscape = (v: unknown): string => csvCellSafe(v);
      const csv = '\uFEFF' + [header.join(','), ...rows.map((r: any) => header.map(k => csvEscape((r as any)[k])).join(','))].join('\n');

      // 审计：谁在何时导出了多少行、什么过滤条件（SEC-01 防泄露留痕）
      await writeRouteAuditLog({
        prisma: opts.prisma,
        actorId: actorOf(req)?.userId || 'system',
        source: 'relations',
        operation: 'relations_export_csv',
        targetType: 'Relation',
        targetId: 'bulk',
        after: { rowCount: rows.length, filters: where },
        ip: req.ip ?? null,
        operationType: 'link',
      });

      const filename = `relations-${todayLocalKey()}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      return res.send(csv);
    } catch (err: any) {
      logger.error('[RelationsV2] export.csv failed', { error: err?.message });
      return res.status(500).json({ error: 'EXPORT_FAILED', message: err?.message || '导出失败' });
    }
  });

  // ── GET /:id 详情 ──
  router.get('/:id', requirePermission('relations:read'), async (req, res) => {
    const actor = actorOf(req);
    const result = await svc.getRelation(actor, req.params.id);
    if (!result.ok) {
      const status = result.error!.code === 'NOT_FOUND' ? 404 : 500;
      return res.status(status).json({ error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, relation: result.data });
  });

  // ── POST / 创建 ──
  router.post('/', requireWrite, requirePermission('relations:write'), async (req, res) => {
    const actor = actorOf(req);
    const result = await svc.createRelation(actor, req.body || {});
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        UNAUTHORIZED: 401, VALIDATION_FAILED: 400, SEQUENCE_FAILED: 500, INTERNAL_ERROR: 500,
      };
      return res.status(statusMap[result.error!.code] || 500).json({ error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, relation: result.data });
  });

  // ── PUT /:id 更新 ──
  router.put('/:id', requireWrite, requirePermission('relations:write'), async (req, res) => {
    const actor = actorOf(req);
    const result = await svc.updateRelation(actor, req.params.id, req.body || {});
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        UNAUTHORIZED: 401, FORBIDDEN: 403, VALIDATION_FAILED: 400, NOT_FOUND: 404, INTERNAL_ERROR: 500,
      };
      return res.status(statusMap[result.error!.code] || 500).json({ error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, relation: result.data });
  });

  // ── PATCH /:id/stage 阶段变更（Kanban 拖拽）──
  router.patch('/:id/stage', requireWrite, requirePermission('relations:write'), async (req, res) => {
    const actor = actorOf(req);
    const newStage = typeof req.body?.stage === 'string' ? req.body.stage.trim() : '';
    if (!newStage) return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'body.stage 必填' });
    const result = await svc.changeStage(actor, req.params.id, newStage);
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        UNAUTHORIZED: 401, VALIDATION_FAILED: 400, NOT_FOUND: 404, INTERNAL_ERROR: 500,
      };
      return res.status(statusMap[result.error!.code] || 500).json({ error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, relation: result.data });
  });

  // ── DELETE /:id 软删除 ──
  router.delete('/:id', requireWrite, requirePermission('relations:delete'), async (req, res) => {
    const actor = actorOf(req);
    const result = await svc.deleteRelation(actor, req.params.id);
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, INTERNAL_ERROR: 500,
      };
      return res.status(statusMap[result.error!.code] || 500).json({ error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, relation: result.data });
  });

  return router;
}
