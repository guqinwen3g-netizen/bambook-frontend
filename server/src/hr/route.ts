import { Router, Request, Response } from 'express';
import { createOrganizationDepartment, updateOrganizationDepartment, retireOrganizationDepartment, OrganizationError } from './organizationService';
import { addExistingTeamMember, listTeamMemberCandidates } from './teamMembershipService';
import { departmentBusinessAttributes } from './departmentBusinessAttributes';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { requirePermission } from '../auth/permissionGuard';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { writeRouteAuditLog, actorIdFromRequest } from '../audit/routeAudit';
import { createHrService, HrError, hrStatusForBareCode } from './hrService';
import { safeRouteError } from '../shared/routeError';
// ★ S4 任务3：订单金额口径收口到唯一真源（原写法裸用 quoteAmount，跳过真源②totalNet）
import { orderAmountOf } from '../shared/orderAmount';
import { invalidateTeamMembershipCache, createTeamShareService } from '../teams/teamShareService';

type HRRouterOptions = {
  prisma: PrismaClient;
  /** 是否启用认证（默认 true，与历史行为一致：HR 路由始终要求 owner/admin JWT）。 */
  requireAuth?: boolean;
  /** 允许的 API-Key 集合（默认空集——HR 不接受 API-Key，仅 JWT）。 */
  apiKeys?: Set<string>;
};

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function deletionStamp(): bigint {
  return BigInt(Date.now());
}

export function createHRRouter(options: HRRouterOptions) {
  const router = Router();
  const { prisma } = options;
  const teamShareSvc = createTeamShareService(prisma);

  const isAssignableDepartment = async (id: unknown) => {
    if (typeof id !== 'string' || !id) return false;
    const department = await prisma.department.findUnique({ where: { id } });
    return !!department?.parentId && department.status === 'active';
  };

  const requireAuth = options.requireAuth ?? true;
  const apiKeys = options.apiKeys ?? new Set<string>();

  // 统一认证守卫：JWT（走 jwt.verify 验签）优先，API-Key 次之
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));

  // W-C 七角色走查收口（族 C 同型 HR 死胡同修复）：
  // 原全局 requireRole('owner','admin') 使 FINANCE（legacy finance∉组）持 hr:read 仍全端点 403。
  // 按矩阵真源改 scope 门：GET → hr:read（FINANCE/ADMIN 持有），写 → hr:write（ADMIN 持有，
  // §6.6 人事管理归总领导；SuperAdmin 经 hasPermission 特判全通）；
  // GET /teams/mine 按小组与业务数据共享 §6 文档放开给任何登录用户（团队共享基础）。
  if (requireAuth) {
    const requireHrRead = requirePermission('hr:read');
    const requireHrWrite = requirePermission('hr:write');
    router.use((req, res, next) => {
      if (req.method === 'GET' && req.path === '/teams/mine') return next();
      return (req.method === 'GET' ? requireHrRead : requireHrWrite)(req, res, next);
    });
    // K1 工资保密门禁（批次二）：薪酬明细接口（薪资结构/工资单/工资明细）在
    // hr:read|write 之上叠加 sensitive:salary 敏感 scope——矩阵真源仅 SuperAdmin +
    // 被显式授权的指定 HR 持有；FINANCE（hr:read）与 ADMIN（hr:read|write）均未授予，
    // 越权访问一律 403 INSUFFICIENT_SCOPE。
    router.use(
      ['/salary-structures', '/payroll-runs', '/payroll-items'],
      requirePermission('sensitive:salary'),
    );
  }

  router.use(['/projects', '/assignments'], (_req, res) => {
    res.status(410).json({ ok: false, error: 'FEATURE_RETIRED', message: '当前版本不提供项目和项目任务功能。' });
  });

  router.post('/departments', async (req, res) => {
    try {
      const department = await createOrganizationDepartment(prisma, req.body || {});
      await writeRouteAuditLog({ prisma, actorId: actorIdFromRequest(req), source: 'route:hr:create_department', operation: 'create_department', targetType: 'Department', targetId: department.id, after: { name: department.name, parentId: department.parentId }, ip: req.ip || null });
      res.json({ ok: true, department });
    } catch (error) {
      if (error instanceof OrganizationError) return res.status(error.status).json({ ok: false, error: 'VALIDATION_FAILED', message: error.message });
      const result = safeRouteError(error, { fallbackCode: 'HR_DEPARTMENT_CREATE_FAILED' });
      res.status(result.status).json({ ok: false, error: result.code, message: result.message });
    }
  });

  for (const action of ['edit', 'retire'] as const) {
    router[action === 'edit' ? 'patch' : 'post'](`/departments/:id${action === 'retire' ? '/retire' : ''}`, async (req, res) => {
      try {
        const before = await prisma.department.findUnique({ where: { id: req.params.id } });
        const result = action === 'edit' ? await updateOrganizationDepartment(prisma, req.params.id, req.body || {}) : await retireOrganizationDepartment(prisma, req.params.id, req.body || {});
        await writeRouteAuditLog({ prisma, actorId: actorIdFromRequest(req), source: `route:hr:${action}_department`, operation: `${action}_department`, targetType: 'Department', targetId: req.params.id, before, after: result, ip: req.ip || null });
        invalidateTeamMembershipCache();
        res.json({ ok: true, result });
      } catch (error) {
        if (error instanceof OrganizationError) return res.status(error.status).json({ ok: false, error: 'VALIDATION_FAILED', message: error.message });
        const result = safeRouteError(error, { fallbackCode: 'HR_DEPARTMENT_UPDATE_FAILED' });
        res.status(result.status).json({ ok: false, error: result.code, message: result.message });
      }
    });
  }

  router.post('/personnel', (_req, res) => res.status(410).json({ ok: false, error: 'ACCOUNT_CREATION_MOVED', message: '请在管理后台创建用户，或审批注册申请；HR 仅维护已有账号的人员归属。' }));

  // ════════════════════════════════════════════
  // Personnel Overview (aggregated from UserAccount)
  // ════════════════════════════════════════════
  router.get('/personnel', async (_req: Request, res: Response) => {
    try {
      // 查询条件：未软删 或 停用（status='disabled'）。
      // 已抹除个人数据(metadata.erased/deletionMode='erase-personal-data')的用户
      // 仍会命中 status='disabled' 分支，因此查询后需再次过滤 metadata,
      // 与 admin/route.ts L91-L94 保持一致 — 设计真源:
      // docs/design/04-模块设计/08-设置与后台/Settings-设置/管理后台AdminPanel.md L264-275
      // 「抹除个人数据(deletionMode='erase-personal-data')：从列表过滤，数据保留但不可见」
      const usersRaw = await prisma.userAccount.findMany({
        where: {
          OR: [{ deletedAt: null }, { status: 'disabled' }],
        },
        include: {
          roles: { include: { role: true } },
          primaryDepartment: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      const users = usersRaw.filter(u => {
        const metadata = (u.metadata || {}) as any;
        return u.status !== 'pending' && !metadata.personnelOnly && !!u.passwordHash && !metadata.erased && metadata.deletionMode !== 'erase-personal-data';
      });

      const departments = await prisma.department.findMany({
        where: { status: 'active' },
        orderBy: { name: 'asc' },
      });

      const positions = await prisma.jobPosition.findMany({
        where: { deletedAt: null },
        include: { department: true },
        orderBy: { title: 'asc' },
      });

      res.json({
        ok: true,
        personnel: users.map(u => ({
          id: u.id,
          displayName: u.displayName,
          email: u.email,
          avatarUrl: (u as any).avatarUrl || null,
          status: u.status,
          roles: u.roles.map(ur => ur.role.name),
          departmentId: u.primaryDeptId,
          department: u.primaryDepartment?.name || null,
          lastLoginAt: u.lastLoginAt,
          createdAt: u.createdAt,
        })),
        departments: departments.map(d => ({
          id: d.id,
          name: d.name,
          parentId: d.parentId,
          status: d.status,
          businessAttributes: departmentBusinessAttributes(d),
        })),
        positions: positions.map(p => ({
          id: p.id,
          title: p.title,
          departmentId: p.departmentId,
          department: p.department?.name || null,
          headcount: p.headcount,
          status: p.status,
          description: p.description,
        })),
      });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_PERSONNEL_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  // ════════════════════════════════════════════
  // Job Positions CRUD
  // ════════════════════════════════════════════
  router.post('/positions', async (req: Request, res: Response) => {
    try {
      const { title, departmentId, description, headcount } = req.body || {};
      if (!title?.trim()) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'title is required.' });
      }
      if (!(await isAssignableDepartment(departmentId))) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: '请选择所属部门，不能直接归属公司。' });
      }
      if (headcount !== undefined && !(Number.isInteger(headcount) && headcount >= 1 && headcount <= 9999)) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: '编制人数须为 1–9999 的整数。' });
      }
      const position = await prisma.jobPosition.create({
        data: {
          id: genId('pos'),
          title: title.trim(),
          departmentId: departmentId || null,
          description: description || null,
          headcount: headcount || 1,
        },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:create_position',
        operation: 'create_position',
        targetType: 'JobPosition',
        targetId: position.id,
        after: { id: position.id, title: position.title, departmentId: position.departmentId, headcount: position.headcount },
        ip: req.ip || null,
      });
      res.json({ ok: true, position });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_POSITION_CREATE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.patch('/positions/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { title, departmentId, description, headcount, status } = req.body || {};
      if (departmentId !== undefined && !(await isAssignableDepartment(departmentId))) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: '请选择所属部门，不能直接归属公司。' });
      }
      if (title !== undefined && !String(title).trim()) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: '岗位名称不能为空。' });
      }
      if (headcount !== undefined && !(Number.isInteger(headcount) && headcount >= 1 && headcount <= 9999)) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: '编制人数须为 1–9999 的整数。' });
      }
      if (status !== undefined && !['active', 'inactive'].includes(status)) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: '岗位状态只能是启用或停用。' });
      }
      const updated = await prisma.jobPosition.update({
        where: { id },
        data: {
          ...(title !== undefined && { title: String(title).trim() }),
          ...(departmentId !== undefined && { departmentId: departmentId || null }),
          ...(description !== undefined && { description }),
          ...(headcount !== undefined && { headcount }),
          ...(status !== undefined && { status }),
        },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:update_position',
        operation: 'update_position',
        targetType: 'JobPosition',
        targetId: id,
        after: { id: updated.id, title: updated.title, status: updated.status, headcount: updated.headcount },
        ip: req.ip || null,
      });
      res.json({ ok: true, position: updated });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_POSITION_UPDATE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.delete('/positions/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      // 仍有在职员工挂在该岗位时不允许删除（否则档案显示一个已删除的岗位）；可改为停用。
      const inUse = await prisma.employeeProfile.count({
        where: { positionId: id, deletedAt: null, employmentStatus: { in: ['Probation', 'Regular', 'Suspended'] } },
      });
      if (inUse > 0) {
        return res.status(409).json({ ok: false, error: 'POSITION_IN_USE', message: `该岗位仍有 ${inUse} 名在职员工，请先调岗或改为停用。` });
      }
      await prisma.jobPosition.update({
        where: { id },
        data: { deletedAt: deletionStamp() },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:delete_position',
        operation: 'delete_position',
        targetType: 'JobPosition',
        targetId: id,
        after: { deleted: true },
        ip: req.ip || null,
      });
      res.json({ ok: true, deleted: true });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_POSITION_DELETE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  // ════════════════════════════════════════════
  // Teams CRUD
  // ════════════════════════════════════════════
  router.get('/teams', async (_req: Request, res: Response) => {
    try {
      const teams = await prisma.team.findMany({
        where: { deletedAt: null },
        include: {
          department: true,
          members: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({
        ok: true,
        teams: teams.map(t => ({
          id: t.id,
          name: t.name,
          description: t.description,
          leaderId: t.leaderId,
          departmentId: t.departmentId,
          department: t.department?.name || null,
          businessAttributes: departmentBusinessAttributes(t.department),
          status: t.status,
          memberCount: t.members.filter(m => !m.leftAt).length,
          // 成员明细（含在组成员与已退出标记）——组详情的成员区/添加人过滤依赖此数组
          members: t.members.map(m => ({ id: m.id, userId: m.userId, role: m.role, leftAt: m.leftAt })),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
      });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_TEAMS_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.post('/teams', async (req: Request, res: Response) => {
    try {
      const { name, description, leaderId, departmentId } = req.body || {};
      if (!name?.trim()) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'name is required.' });
      }
      if (!(await isAssignableDepartment(departmentId))) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: '请选择所属部门，不能直接归属公司。' });
      }
      const team = await prisma.team.create({
        data: {
          id: genId('team'),
          name: name.trim(),
          description: description || null,
          leaderId: leaderId || null,
          departmentId: departmentId || null,
        },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:create_team',
        operation: 'create_team',
        targetType: 'Team',
        targetId: team.id,
        after: { id: team.id, name: team.name, leaderId: team.leaderId, departmentId: team.departmentId },
        ip: req.ip || null,
      });
      res.json({ ok: true, team });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_TEAM_CREATE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.patch('/teams/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { name, description, leaderId, departmentId, status } = req.body || {};
      if (departmentId !== undefined && !(await isAssignableDepartment(departmentId))) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: '请选择所属部门，不能直接归属公司。' });
      }
      const updated = await prisma.team.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(leaderId !== undefined && { leaderId: leaderId || null }),
          ...(departmentId !== undefined && { departmentId: departmentId || null }),
          ...(status !== undefined && { status }),
        },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:update_team',
        operation: 'update_team',
        targetType: 'Team',
        targetId: id,
        after: { id: updated.id, name: updated.name, status: updated.status, leaderId: updated.leaderId },
        ip: req.ip || null,
      });
      invalidateTeamMembershipCache();
      res.json({ ok: true, team: updated });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_TEAM_UPDATE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  // v2.1 P0（DR-042 §0/T-31）：删除组 = 解散组——统一走 dissolveTeam 事务
  // （批量 revoke 全部授权 → 软删组 → 审计），消除「HR 界面删组留僵尸授权行」的分叉。
  router.delete('/teams/:id', async (req: Request, res: Response) => {
    const actor = extractActorFromRequest(req);
    const result = await teamShareSvc.dissolveTeam(actor, req.params.id, req.ip);
    if (!result.ok) {
      // G6.5（Task 4b）：此处原有内联 statusMap 副本，已删 —— 档位只出自 hrService 的那一条规则。
      // 本端点拿到的是 dissolveTeam 的**裸码**（跨模块返回值，不是 HrError 实例）⇒ 走 hrStatusForBareCode：
      // 认得出的码 401/403/404/409/500 逐一同值（src/teams/teamShareService.ts:412-441 全路径枚举），
      // 认不出的码答 500 —— 与收口前的 `statusMap[code] || 500` 同值（复审 F2：那是恢复，不是改行为）。
      return res.status(hrStatusForBareCode(result.error!.code)).json({ ok: false, error: result.error!.code, message: result.error!.message });
    }
    await writeRouteAuditLog({
      prisma,
      actorId: actorIdFromRequest(req),
      source: 'route:hr:delete_team',
      operation: 'delete_team',
      targetType: 'Team',
      targetId: req.params.id,
      after: { deleted: true, ...result.data },
      ip: req.ip || null,
    });
    return res.json({ ok: true, deleted: true, ...result.data });
  });

  // ════════════════════════════════════════════
  // DR-042 小组数据共享（设计真源：docs/design/03-业务规则/小组与业务数据共享.md §7）
  // 说明：本路由 W-C 起挂 scope 门（GET hr:read / 写 hr:write + /teams/mine 全登录放开），
  // 建组/解散/审计视图为 hr:write（ADMIN 总领导）口径；组长/主管的就地共享走
  // /api/v2/relations/:id/team-shares（双重门禁在 teamShareService）。
  // ════════════════════════════════════════════

  // 解散组（事务化：批量 revoke 授权 → 软删组 → 审计；重复解散 409，T-04/T-05）
  router.post('/teams/:id/dissolve', async (req: Request, res: Response) => {
    const actor = extractActorFromRequest(req);
    const result = await teamShareSvc.dissolveTeam(actor, req.params.id, req.ip);
    if (!result.ok) {
      // G6.5（Task 4b）：此处原有内联 statusMap 副本，已删 —— 档位只出自 hrService 的那一条规则。
      // 本端点拿到的是 dissolveTeam 的**裸码**（跨模块返回值，不是 HrError 实例）⇒ 走 hrStatusForBareCode：
      // 认得出的码 401/403/404/409/500 逐一同值（src/teams/teamShareService.ts:412-441 全路径枚举），
      // 认不出的码答 500 —— 与收口前的 `statusMap[code] || 500` 同值（复审 F2：那是恢复，不是改行为）。
      return res.status(hrStatusForBareCode(result.error!.code)).json({ ok: false, error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, ...result.data });
  });

  // 组内授权列表（含已撤销，审计视图，分页）
  router.get('/teams/:id/grants', async (req: Request, res: Response) => {
    try {
      const activeOnly = req.query.activeOnly === 'true';
      const grants = await teamShareSvc.listTeamGrants(req.params.id, activeOnly);
      res.json({ ok: true, grants });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_TEAM_GRANTS_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  // 组经营概况聚合（v2.1 §8.6 视角聚焦器的数据源）：组生效授权的 relation 集
  // → 关联客户 + 派生订单 + 金额/状态统计。纯展示层聚合，不动任何权限接口。
  router.get('/teams/:id/overview', async (req: Request, res: Response) => {
    try {
      const teamId = req.params.id;
      const team = await prisma.team.findFirst({
        where: { id: teamId, deletedAt: null },
        select: { id: true, name: true, description: true, leaderId: true, departmentId: true },
      });
      if (!team) return res.status(404).json({ ok: false, error: 'TEAM_NOT_FOUND', message: '小组不存在或已解散' });

      const grants = await teamShareSvc.listTeamGrants(teamId, true); // 仅生效授权
      const relationIds = grants.filter(g => g.entityType === 'relation').map(g => g.entityId);
      const relations = relationIds.length > 0
        ? await prisma.relation.findMany({
            where: { id: { in: relationIds }, deletedAt: null },
            select: { id: true, name: true, stage: true, tier: true, ownerId: true },
          })
        : [];
      const orders = relationIds.length > 0
        ? await prisma.order.findMany({
            where: { customerRelationId: { in: relationIds }, deletedAt: null },
            select: { id: true, poNumber: true, status: true, quoteAmount: true, currency: true, customerRelationId: true },
            orderBy: { createdAt: 'desc' },
            take: 50,
          })
        : [];

      const byStatus: Record<string, { count: number; amount: number }> = {};
      let totalAmount = 0;
      for (const o of orders) {
        const amt = orderAmountOf(o);
        totalAmount += amt;
        const bucket = byStatus[o.status] || { count: 0, amount: 0 };
        bucket.count += 1;
        bucket.amount += amt;
        byStatus[o.status] = bucket;
      }
      res.json({
        ok: true,
        overview: {
          team,
          activeGrants: grants.length,
          relations,
          orders,
          orderStats: { total: orders.length, totalAmount, byStatus },
        },
      });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_TEAM_OVERVIEW_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  // 当前用户所在组（会话态；前端「我的小组」入口 + 徽章数据源）
  router.get('/teams/mine', async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      if (!actor?.userId) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: '需登录' });
      const memberships = await prisma.teamMember.findMany({
        where: { userId: actor.userId, leftAt: null, team: { deletedAt: null } },
        include: { team: true },
      });
      const teams = memberships
        .map((m: any) => m.team)
        .filter(Boolean)
        .map((t: any) => ({ id: t.id, name: t.name, description: t.description, leaderId: t.leaderId, status: t.status }));
      res.json({ ok: true, teams });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_MY_TEAMS_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  // Team members
  router.get('/teams/:id/member-candidates', async (req, res) => {
    try { res.json({ ok: true, users: await listTeamMemberCandidates(prisma, req.params.id) }); }
    catch (error) {
      if (error instanceof OrganizationError) return res.status(error.status).json({ ok: false, message: error.message });
      const r = safeRouteError(error, { fallbackCode: 'HR_MEMBER_CANDIDATES_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });
  router.post('/teams/:id/members', async (req, res) => {
    try {
      const member = await addExistingTeamMember(prisma, req.params.id, req.body?.userId, async (tx, member) => {
        await writeRouteAuditLog({ prisma: tx as any, actorId: actorIdFromRequest(req), source: 'route:hr:add_team_member', operation: 'add_team_member', targetType: 'TeamMember', targetId: member.id, after: { teamId: member.teamId, userId: member.userId }, ip: req.ip || null });
      });
      invalidateTeamMembershipCache();
      res.json({ ok: true, member });
    } catch (error) {
      if (error instanceof OrganizationError) return res.status(error.status).json({ ok: false, error: 'INVALID_MEMBERSHIP', message: error.message });
      const r = safeRouteError(error, { fallbackCode: 'HR_TEAM_MEMBER_ADD_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.delete('/teams/:id/members/:userId', async (req: Request, res: Response) => {
    try {
      const { id, userId } = req.params;
      await prisma.teamMember.updateMany({
        where: { teamId: id, userId, leftAt: null },
        data: { leftAt: new Date() },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:remove_team_member',
        operation: 'remove_team_member',
        targetType: 'TeamMember',
        targetId: `${id}:${userId}`,
        after: { teamId: id, userId, removed: true },
        ip: req.ip || null,
      });
      invalidateTeamMembershipCache();
      res.json({ ok: true, removed: true });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_TEAM_MEMBER_REMOVE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  // ════════════════════════════════════════════
  // Projects CRUD
  // ════════════════════════════════════════════
  router.get('/projects', async (_req: Request, res: Response) => {
    try {
      const projects = await prisma.project.findMany({
        where: { deletedAt: null },
        include: {
          team: true,
          members: true,
          assignments: {
            where: { deletedAt: null },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({
        ok: true,
        projects: projects.map(p => ({
          id: p.id,
          name: p.name,
          code: p.code,
          description: p.description,
          teamId: p.teamId,
          teamName: p.team?.name || null,
          status: p.status,
          priority: p.priority,
          startDate: p.startDate,
          endDate: p.endDate,
          memberCount: p.members.length,
          assignmentCount: p.assignments.length,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
      });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_PROJECTS_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.post('/projects', async (req: Request, res: Response) => {
    try {
      const { name, code, description, teamId, priority, startDate, endDate } = req.body || {};
      if (!name?.trim()) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'name is required.' });
      }
      const project = await prisma.project.create({
        data: {
          id: genId('proj'),
          name: name.trim(),
          code: code || null,
          description: description || null,
          teamId: teamId || null,
          priority: priority || 'normal',
          startDate: startDate || null,
          endDate: endDate || null,
        },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:create_project',
        operation: 'create_project',
        targetType: 'Project',
        targetId: project.id,
        after: { id: project.id, name: project.name, code: project.code, teamId: project.teamId, priority: project.priority },
        ip: req.ip || null,
      });
      res.json({ ok: true, project });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_PROJECT_CREATE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.patch('/projects/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { name, code, description, teamId, status, priority, startDate, endDate } = req.body || {};
      const updated = await prisma.project.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(code !== undefined && { code }),
          ...(description !== undefined && { description }),
          ...(teamId !== undefined && { teamId: teamId || null }),
          ...(status !== undefined && { status }),
          ...(priority !== undefined && { priority }),
          ...(startDate !== undefined && { startDate }),
          ...(endDate !== undefined && { endDate }),
        },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:update_project',
        operation: 'update_project',
        targetType: 'Project',
        targetId: id,
        after: { id: updated.id, name: updated.name, status: updated.status, priority: updated.priority },
        ip: req.ip || null,
      });
      res.json({ ok: true, project: updated });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_PROJECT_UPDATE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.delete('/projects/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      await prisma.project.update({
        where: { id },
        data: { deletedAt: deletionStamp() },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:delete_project',
        operation: 'delete_project',
        targetType: 'Project',
        targetId: id,
        after: { deleted: true },
        ip: req.ip || null,
      });
      res.json({ ok: true, deleted: true });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_PROJECT_DELETE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  // Project members
  router.post('/projects/:id/members', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { userId, role } = req.body || {};
      if (!userId) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'userId is required.' });
      }
      const member = await prisma.projectMember.create({
        data: {
          id: genId('pm'),
          projectId: id,
          userId,
          role: role || 'member',
        },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:add_project_member',
        operation: 'add_project_member',
        targetType: 'ProjectMember',
        targetId: member.id,
        after: { id: member.id, projectId: id, userId, role: member.role },
        ip: req.ip || null,
      });
      res.json({ ok: true, member });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_PROJECT_MEMBER_ADD_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.delete('/projects/:id/members/:userId', async (req: Request, res: Response) => {
    try {
      const { id, userId } = req.params;
      await prisma.projectMember.deleteMany({
        where: { projectId: id, userId },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:remove_project_member',
        operation: 'remove_project_member',
        targetType: 'ProjectMember',
        targetId: `${id}:${userId}`,
        after: { projectId: id, userId, removed: true },
        ip: req.ip || null,
      });
      res.json({ ok: true, removed: true });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_PROJECT_MEMBER_REMOVE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  // ════════════════════════════════════════════
  // Work Assignments CRUD
  // ════════════════════════════════════════════
  // 业务受管任务只能由来源业务推进；HR权限不能替代费用核对/财务门禁。
  const isDevelopmentManaged = (metadata: unknown) =>
    !!metadata && typeof metadata === 'object' && (metadata as Record<string, unknown>).managedBy === 'development_cost_closure';
  router.use(['/assignments/:id', '/assignments'], async (req: Request, res: Response, next) => {
    if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const reject = () => res.status(409).json({ok:false,error:'MANAGED_ASSIGNMENT',message:'开发费用受管任务须通过对应业务入口处理，不能在人事任务中创建、更改或删除。'});
    if (isDevelopmentManaged(req.body?.metadata)) return reject();
    if (req.method === 'PATCH' || req.method === 'DELETE') {
      try {
        const assignment = await prisma.workAssignment.findUnique({where:{id:req.params.id},select:{metadata:true}});
        if (isDevelopmentManaged(assignment?.metadata)) return reject();
      } catch (err) {
        const r = safeRouteError(err, {fallbackCode:'HR_ASSIGNMENT_GUARD_FAILED'});
        return res.status(r.status).json({ok:false,error:r.code,message:r.message});
      }
    }
    return next();
  });

  router.get('/assignments', async (req: Request, res: Response) => {
    try {
      const { userId, projectId, status } = req.query as any;
      const where: any = { deletedAt: null };
      if (userId) where.userId = userId;
      if (projectId) where.projectId = projectId;
      if (status) where.status = status;

      const assignments = await prisma.workAssignment.findMany({
        where,
        include: { project: true },
        orderBy: { createdAt: 'desc' },
      });

      // Fetch assignee info
      const userIds = [...new Set(assignments.map(a => a.userId))];
      const users = userIds.length > 0
        ? await prisma.userAccount.findMany({
            where: { id: { in: userIds } },
            select: { id: true, displayName: true, avatarUrl: true },
          })
        : [];
      const userMap = new Map(users.map(u => [u.id, u]));

      res.json({
        ok: true,
        assignments: assignments.map(a => ({
          id: a.id,
          title: a.title,
          description: a.description,
          projectId: a.projectId,
          projectName: a.project?.name || null,
          userId: a.userId,
          userName: userMap.get(a.userId)?.displayName || a.userId,
          userAvatar: userMap.get(a.userId)?.avatarUrl || null,
          assignerId: a.assignerId,
          status: a.status,
          priority: a.priority,
          dueDate: a.dueDate,
          completedAt: a.completedAt,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        })),
      });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_ASSIGNMENTS_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.post('/assignments', async (req: Request, res: Response) => {
    try {
      const { title, description, projectId, userId, priority, dueDate } = req.body || {};
      if (!title?.trim() || !userId) {
        return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'title and userId are required.' });
      }
      const assignment = await prisma.workAssignment.create({
        data: {
          id: genId('wa'),
          title: title.trim(),
          description: description || null,
          projectId: projectId || null,
          userId,
          // ★ 原写法 `(req as any).user?.id || null` —— `req.user` 在本仓**从未被赋值**
          //   （全库只有测试 mock 赋过它），所以 `assignerId` **恒为 null**：
          //   「谁派的活」永久丢失。改用本仓既定的 actor 取值器
          //   （与同 handler 下方审计日志的 `actorId: actorIdFromRequest(req)` 同源）。
          assignerId: actorIdFromRequest(req),
          priority: priority || 'normal',
          dueDate: dueDate || null,
        },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:create_assignment',
        operation: 'create_assignment',
        targetType: 'WorkAssignment',
        targetId: assignment.id,
        after: { id: assignment.id, title: assignment.title, userId, projectId: assignment.projectId, priority: assignment.priority },
        ip: req.ip || null,
      });
      res.json({ ok: true, assignment });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_ASSIGNMENT_CREATE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.patch('/assignments/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { title, description, projectId, userId, status, priority, dueDate } = req.body || {};
      const completedAt = status === 'completed' ? new Date() : undefined;
      const updated = await prisma.workAssignment.update({
        where: { id },
        data: {
          ...(title !== undefined && { title }),
          ...(description !== undefined && { description }),
          ...(projectId !== undefined && { projectId: projectId || null }),
          ...(userId !== undefined && { userId }),
          ...(status !== undefined && { status, ...(completedAt && { completedAt }) }),
          ...(priority !== undefined && { priority }),
          ...(dueDate !== undefined && { dueDate }),
        },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:update_assignment',
        operation: 'update_assignment',
        targetType: 'WorkAssignment',
        targetId: id,
        after: { id: updated.id, title: updated.title, status: updated.status, priority: updated.priority },
        ip: req.ip || null,
      });
      res.json({ ok: true, assignment: updated });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_ASSIGNMENT_UPDATE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.delete('/assignments/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      await prisma.workAssignment.update({
        where: { id },
        data: { deletedAt: deletionStamp() },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:hr:delete_assignment',
        operation: 'delete_assignment',
        targetType: 'WorkAssignment',
        targetId: id,
        after: { deleted: true },
        ip: req.ip || null,
      });
      res.json({ ok: true, deleted: true });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_ASSIGNMENT_DELETE_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  // ════════════════════════════════════════════
  // C3 HR 深化 — 员工档案 / 生命周期 / 考勤请假 / 薪资 / 绩效 / 培训
  // 业务规则统一收口 hrService，route 只做参数透传 + 审计
  // ════════════════════════════════════════════
  const hr = createHrService(prisma);

  /**
   * 带审计的写操作包装。错误出口走 `shared/routeError`（G6.5 · §9 B22）：
   * 业务错误（`HrError`，其 `statusCode` 的默认值出自 `hrService.hrStatusForCode` 这一份真源）
   * 原样透传自己的码与文案；未预期异常答注册表文案，**不再把 `err.message` 原文发给前端**。
   */
  async function audited(
    req: Request,
    res: Response,
    ctx: { source: string; operation: string; targetType: string; targetId: () => string },
    fn: () => Promise<{ payload: Record<string, unknown>; auditAfter?: Record<string, unknown> }>,
  ) {
    try {
      const { payload, auditAfter } = await fn();
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: ctx.source,
        operation: ctx.operation,
        targetType: ctx.targetType,
        targetId: ctx.targetId(),
        after: auditAfter ?? payload,
        ip: req.ip || null,
      });
      res.json({ ok: true, ...payload });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_OPERATION_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  }

  // ── C3a 员工档案 ──
  router.get('/employees', async (req: Request, res: Response) => {
    try {
      const { status, deptId, q } = req.query as any;
      const employees = await hr.listProfiles({ status, deptId, q });
      res.json({ ok: true, employees });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_EMPLOYEES_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.get('/employees/:userId', async (req: Request, res: Response) => {
    try {
      const profile = await hr.getProfile(req.params.userId);
      if (!profile) return res.status(404).json({ ok: false, error: 'PROFILE_NOT_FOUND', message: '员工档案不存在' });
      res.json({ ok: true, profile });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_EMPLOYEE_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.put('/employees/:userId', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:upsert_employee', operation: 'upsert_employee',
      targetType: 'EmployeeProfile', targetId: () => req.params.userId,
    }, async () => {
      const { profile, created } = await hr.upsertProfile({ ...req.body, userId: req.params.userId });
      return { payload: { profile, created } };
    });
  });

  router.delete('/employees/:userId', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:delete_employee', operation: 'delete_employee',
      targetType: 'EmployeeProfile', targetId: () => req.params.userId,
    }, async () => ({ payload: await hr.deleteProfile(req.params.userId) }));
  });

  // ── C3a 生命周期事件 ──
  router.get('/employment-events', async (req: Request, res: Response) => {
    try {
      const { userId, type, limit } = req.query as any;
      const events = await hr.listEmploymentEvents({ userId, type, limit: limit ? Number(limit) : undefined });
      res.json({ ok: true, events });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_EVENTS_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.post('/employment-events', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:record_employment_event', operation: 'record_employment_event',
      targetType: 'EmploymentEvent', targetId: () => req.body?.userId || 'unknown',
    }, async () => {
      const { event, accountDisabled, leftTeams } = await hr.recordEmploymentEvent(actorIdFromRequest(req) ?? 'unknown', req.body || {});
      if (leftTeams) invalidateTeamMembershipCache();
      return { payload: { event, accountDisabled, leftTeams } };
    });
  });

  // ── C3b 考勤 ──
  router.get('/attendance', async (req: Request, res: Response) => {
    try {
      const { userId, month, date, status } = req.query as any;
      const records = await hr.listAttendance({ userId, month, date, status });
      res.json({ ok: true, records });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_ATTENDANCE_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.get('/attendance/summary', async (req: Request, res: Response) => {
    try {
      const { month } = req.query as any;
      const summary = await hr.attendanceSummary(month);
      res.json({ ok: true, summary });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_ATTENDANCE_SUMMARY_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.post('/attendance', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:upsert_attendance', operation: 'upsert_attendance',
      targetType: 'AttendanceRecord', targetId: () => `${req.body?.userId || 'unknown'}:${req.body?.date || ''}`,
    }, async () => {
      // 卫生项（2026-09-03）：写入前校验 userId 外键存在（AttendanceRecord 唯一外键列），
      // 防脏数据孤儿考勤记录（前端可保存后查询 → 姓名恒空）。不存在 → 400 中文错误，不落库。
      const attendanceUserId = (req.body || {}).userId;
      if (typeof attendanceUserId !== 'string' || !attendanceUserId.trim()) {
        throw new HrError('VALIDATION_FAILED', 'userId 必填');
      }
      const attendanceUser = await prisma.userAccount.findUnique({
        where: { id: attendanceUserId.trim() },
        select: { id: true },
      });
      if (!attendanceUser) {
        throw new HrError('VALIDATION_FAILED', `userId 不存在：${attendanceUserId}`);
      }
      const { record } = await hr.upsertAttendance(req.body || {});
      return { payload: { record } };
    });
  });

  // ── C3b 请假 ──
  router.get('/leave-requests', async (req: Request, res: Response) => {
    try {
      const { userId, status } = req.query as any;
      const requests = await hr.listLeaveRequests({ userId, status });
      res.json({ ok: true, requests });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_LEAVE_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.post('/leave-requests', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:create_leave_request', operation: 'create_leave_request',
      targetType: 'LeaveRequest', targetId: () => req.body?.userId || 'unknown',
    }, async () => {
      const { request } = await hr.createLeaveRequest(req.body || {});
      return { payload: { request } };
    });
  });

  router.post('/leave-requests/:id/decide', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:decide_leave_request', operation: 'decide_leave_request',
      targetType: 'LeaveRequest', targetId: () => req.params.id,
    }, async () => {
      const { decision, rejectReason } = req.body || {};
      if (decision !== 'Approved' && decision !== 'Rejected') {
        throw new HrError('VALIDATION_FAILED', 'decision 须为 Approved 或 Rejected');
      }
      const { request } = await hr.decideLeaveRequest(actorIdFromRequest(req) ?? 'unknown', req.params.id, decision, rejectReason);
      return { payload: { request } };
    });
  });

  router.post('/leave-requests/:id/cancel', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:cancel_leave_request', operation: 'cancel_leave_request',
      targetType: 'LeaveRequest', targetId: () => req.params.id,
    }, async () => {
      const { request } = await hr.cancelLeaveRequest(req.params.id);
      return { payload: { request } };
    });
  });

  // ── C3c 薪资 ──
  router.get('/salary-structures/:userId', async (req: Request, res: Response) => {
    try {
      const structures = await hr.getSalaryHistory(req.params.userId);
      res.json({ ok: true, structures });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_SALARY_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.post('/salary-structures', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:set_salary_structure', operation: 'set_salary_structure',
      targetType: 'SalaryStructure', targetId: () => req.body?.userId || 'unknown',
    }, async () => {
      const result = await hr.setSalaryStructure(req.body || {});
      return { payload: result };
    });
  });

  router.get('/payroll-runs', async (_req: Request, res: Response) => {
    try {
      const runs = await hr.listPayrollRuns();
      res.json({ ok: true, runs });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_PAYROLL_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.get('/payroll-runs/:id', async (req: Request, res: Response) => {
    try {
      const run = await hr.getPayrollRun(req.params.id);
      if (!run) return res.status(404).json({ ok: false, error: 'RUN_NOT_FOUND', message: '工资单不存在' });
      res.json({ ok: true, run });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_PAYROLL_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.post('/payroll-runs', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:create_payroll_run', operation: 'create_payroll_run',
      targetType: 'PayrollRun', targetId: () => req.body?.period || 'unknown',
    }, async () => {
      const { run } = await hr.createPayrollRun(req.body?.period, req.body?.note);
      return { payload: { run } };
    });
  });

  router.post('/payroll-runs/:id/generate', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:generate_payroll_items', operation: 'generate_payroll_items',
      targetType: 'PayrollRun', targetId: () => req.params.id,
    }, async () => ({ payload: await hr.generatePayrollItems(req.params.id) }));
  });

  router.patch('/payroll-items/:id', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:update_payroll_item', operation: 'update_payroll_item',
      targetType: 'PayrollItem', targetId: () => req.params.id,
    }, async () => {
      const { item } = await hr.updatePayrollItem(req.params.id, req.body || {});
      return { payload: { item } };
    });
  });

  router.post('/payroll-runs/:id/confirm', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:confirm_payroll_run', operation: 'confirm_payroll_run',
      targetType: 'PayrollRun', targetId: () => req.params.id,
    }, async () => {
      const { run } = await hr.confirmPayrollRun(req.params.id);
      return { payload: { run } };
    });
  });

  router.post('/payroll-runs/:id/pay', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:mark_payroll_paid', operation: 'mark_payroll_paid',
      targetType: 'PayrollRun', targetId: () => req.params.id,
    }, async () => {
      const { run } = await hr.markPayrollPaid(req.params.id);
      return { payload: { run } };
    });
  });

  // ── C3d 绩效 ──
  router.get('/performance-cycles', async (_req: Request, res: Response) => {
    try {
      const cycles = await hr.listPerformanceCycles();
      res.json({ ok: true, cycles });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_CYCLES_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.post('/performance-cycles', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:create_performance_cycle', operation: 'create_performance_cycle',
      targetType: 'PerformanceCycle', targetId: () => req.body?.period || 'unknown',
    }, async () => {
      const { cycle } = await hr.createPerformanceCycle(req.body || {});
      return { payload: { cycle } };
    });
  });

  router.post('/performance-cycles/:id/close', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:close_performance_cycle', operation: 'close_performance_cycle',
      targetType: 'PerformanceCycle', targetId: () => req.params.id,
    }, async () => {
      const { cycle } = await hr.closePerformanceCycle(req.params.id);
      return { payload: { cycle } };
    });
  });

  router.get('/performance-reviews', async (req: Request, res: Response) => {
    try {
      const { cycleId, userId, status } = req.query as any;
      const reviews = await hr.listPerformanceReviews({ cycleId, userId, status });
      res.json({ ok: true, reviews });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_REVIEWS_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.put('/performance-reviews', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:upsert_performance_review', operation: 'upsert_performance_review',
      targetType: 'PerformanceReview', targetId: () => `${req.body?.cycleId || ''}:${req.body?.userId || ''}`,
    }, async () => {
      const { review } = await hr.upsertPerformanceReview(req.body || {});
      return { payload: { review } };
    });
  });

  router.post('/performance-reviews/:id/submit', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:submit_performance_review', operation: 'submit_performance_review',
      targetType: 'PerformanceReview', targetId: () => req.params.id,
    }, async () => {
      const { review } = await hr.submitPerformanceReview(req.params.id);
      return { payload: { review } };
    });
  });

  router.post('/performance-reviews/:id/confirm', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:confirm_performance_review', operation: 'confirm_performance_review',
      targetType: 'PerformanceReview', targetId: () => req.params.id,
    }, async () => {
      const { review } = await hr.confirmPerformanceReview(req.params.id, {
        ...req.body,
        reviewerId: req.body?.reviewerId ?? actorIdFromRequest(req) ?? null,
      });
      return { payload: { review } };
    });
  });

  // ── C3e 培训 ──
  router.get('/training-courses', async (req: Request, res: Response) => {
    try {
      const { status } = req.query as any;
      const courses = await hr.listTrainingCourses({ status });
      res.json({ ok: true, courses });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_COURSES_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.post('/training-courses', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:create_training_course', operation: 'create_training_course',
      targetType: 'TrainingCourse', targetId: () => req.body?.title || 'unknown',
    }, async () => {
      const { course } = await hr.createTrainingCourse(req.body || {});
      return { payload: { course } };
    });
  });

  router.patch('/training-courses/:id', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:update_training_course', operation: 'update_training_course',
      targetType: 'TrainingCourse', targetId: () => req.params.id,
    }, async () => {
      const { course } = await hr.updateTrainingCourse(req.params.id, req.body || {});
      return { payload: { course } };
    });
  });

  router.delete('/training-courses/:id', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:delete_training_course', operation: 'delete_training_course',
      targetType: 'TrainingCourse', targetId: () => req.params.id,
    }, async () => ({ payload: await hr.deleteTrainingCourse(req.params.id) }));
  });

  router.get('/training-enrollments', async (req: Request, res: Response) => {
    try {
      const { courseId, userId } = req.query as any;
      const enrollments = await hr.listEnrollments({ courseId, userId });
      res.json({ ok: true, enrollments });
    } catch (err: any) {
      const r = safeRouteError(err, { fallbackCode: 'HR_ENROLLMENTS_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  router.post('/training-courses/:id/enroll', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:enroll_training', operation: 'enroll_training',
      targetType: 'TrainingEnrollment', targetId: () => `${req.params.id}:${req.body?.userId || ''}`,
    }, async () => {
      const { enrollment } = await hr.enrollTraining(req.params.id, req.body?.userId);
      return { payload: { enrollment } };
    });
  });

  router.patch('/training-enrollments/:id', async (req: Request, res: Response) => {
    await audited(req, res, {
      source: 'route:hr:update_enrollment', operation: 'update_enrollment',
      targetType: 'TrainingEnrollment', targetId: () => req.params.id,
    }, async () => {
      const { enrollment } = await hr.updateEnrollment(req.params.id, req.body || {});
      return { payload: { enrollment } };
    });
  });

  return router;
}
