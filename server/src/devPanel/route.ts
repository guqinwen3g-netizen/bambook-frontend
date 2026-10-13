import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createAuthService } from '../auth/service';
import { buildLoadedAuthTokenPayload, serializeAuthUser, loadUserWithRoles } from '../auth/tokenHelpers';
import { DEV_COMPANIES, COMPANY_BY_DB, ALLOWED_DBS } from './companies';
import { getActiveDb, setActiveDb } from './activeDb';
// ★ 未预期异常不再回显原始错误；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';
import { getBusinessClock } from '../shared/businessClock';
import { isScenarioLoopbackCaller, readScenarioDatabaseIdentity, readScenarioRuntimeIdentity } from './scenarioIdentity';

/**
 * 开发调试面板后端。
 *
 * 双护栏（任一不满足即 404，等同不存在）：
 *  1. NODE_ENV !== 'production'
 *  2. process.env.BAMBOOK_DEV_PANEL === '1'
 * 生产构建/部署默认不会带该 env，故面板天然不暴露；即便误带，护栏 1 也会拦截。
 *
 * 设计原则：把「切库 / 切账号」这类高危动作收敛到一个明确标注 DEV 的入口，
 * 并复用登录同款当前权限加载，保证调试态与真实登录态行为一致。
 */

// 虚拟「公司」档案（纯数据，见 ./companies.ts）：同一时刻服务器只「用」其中一个库，
// 但 DEV 双库模式下两个库的连接池在启动期都已建立，切库只是翻转一个内存指针（见 ./activeDb.ts），
// 不再重写 .env、不再重启服务。前端据此显示当前所在公司。

type CompanyDef = (typeof DEV_COMPANIES)[number];

function currentDbName(): string {
  return getActiveDb();
}

function currentCompany(): CompanyDef | undefined {
  return COMPANY_BY_DB.get(currentDbName());
}

function isDevPanelEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.BAMBOOK_DEV_PANEL === '1';
}

export function createDevPanelRouter(options: { prisma: PrismaClient }) {
  const router = Router();
  const { prisma } = options;
  const auth = createAuthService();

  // 护栏：非开发面板启用态一律 404
  router.use((_req: Request, res: Response, next: () => void) => {
    if (!isDevPanelEnabled()) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    next();
  });

  // Physical target proof is available before the first master transaction.
  router.get('/database-identity', async (req: Request, res: Response) => {
    if (!isScenarioLoopbackCaller(req.socket.remoteAddress)) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    try {
      const identity = await readScenarioDatabaseIdentity(prisma);
      return res.json({ ok: true, identity });
    } catch (error) {
      const failure = safeRouteError(error, { fallbackCode: 'SCENARIO_IDENTITY_FAILED' });
      return res.status(failure.status).json({ ok: false, error: failure.code, message: failure.message });
    }
  });

  // The scenario driver binds HTTP commands to the server's own SQL instance.
  // This read is local-only and returns hashes, never credentials or PG paths.
  router.get('/scenario-identity', async (req: Request, res: Response) => {
    if (!isScenarioLoopbackCaller(req.socket.remoteAddress)) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    try {
      const identity = await readScenarioRuntimeIdentity(prisma, req.query.requestKey);
      return res.json({ ok: true, identity });
    } catch (error) {
      const failure = safeRouteError(error, { fallbackCode: 'SCENARIO_IDENTITY_FAILED' });
      return res.status(failure.status).json({ ok: false, error: failure.code, message: failure.message });
    }
  });

  // GET /api/dev/status —— 面板与前端徽标的数据源
  router.get('/status', async (_req: Request, res: Response) => {
    const db = currentDbName();
    const company = currentCompany();
    const [accountCount, orderCount, relationCount] = await Promise.all([
      prisma.userAccount.count({ where: { deletedAt: null } }),
      prisma.order.count().catch(() => 0),
      prisma.relation.count().catch(() => 0),
    ]).catch(() => [0, 0, 0]) as [number, number, number];
    return res.json({
      ok: true,
      devPanelEnabled: true,
      currentDb: db,
      businessClock: getBusinessClock(),
      currentCompany: company
        ? { id: company.id, label: company.label, dbName: company.dbName, description: company.description, accent: company.accent }
        : { id: 'unknown', label: db, dbName: db, description: '', accent: 'var(--text-tertiary)' },
      companies: DEV_COMPANIES.map(c => ({ id: c.id, label: c.label, dbName: c.dbName, description: c.description, accent: c.accent })),
      stats: { accountCount, orderCount, relationCount },
      env: {
        nodeEnv: process.env.NODE_ENV || 'development',
        devPanel: process.env.BAMBOOK_DEV_PANEL === '1',
        uptimeSec: Math.round(process.uptime()),
      },
    });
  });

  // GET /api/dev/env —— 脱敏后的环境变量清单（便于排查配置，不泄露密钥值）
  router.get('/env', (_req: Request, res: Response) => {
    const sensitive = /(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL|PRIVATE)/i;
    const keys = Object.keys(process.env).filter(k => !sensitive.test(k)).sort();
    return res.json({ ok: true, keys, total: keys.length });
  });

  // POST /api/dev/company/switch { db: 'empty'|'mature' }
  // DEV 双库模式：切库只翻转内存指针（setActiveDb），两个库的连接池启动期已就绪，
  // 故无需重写 .env、无需重启服务——前端即时生效。
  router.post('/company/switch', (req: Request, res: Response) => {
    const dbName = String((req.body as any)?.db || '').trim();
    if (!ALLOWED_DBS.has(dbName)) {
      return res.status(400).json({ ok: false, error: 'INVALID_DB', message: `只允许切换到 ${[...ALLOWED_DBS].join(' / ')}` });
    }
    if (dbName === currentDbName()) {
      return res.json({ ok: true, switchedTo: dbName, alreadyThere: true, restarting: false });
    }
    const ok = setActiveDb(dbName);
    if (!ok) {
      return res.status(500).json({ ok: false, error: 'SWITCH_FAILED', message: '切库失败' });
    }
    // 回包（前端据此翻转当前库并清登录态），无需重启。
    res.json({ ok: true, switchedTo: dbName, alreadyThere: false, restarting: false });
  });

  // GET /api/dev/accounts —— 当前库账号列表（供一键切换）
  router.get('/accounts', async (_req: Request, res: Response) => {
    try {
      const accounts = await prisma.userAccount.findMany({
        where: { deletedAt: null },
        orderBy: [{ status: 'asc' }, { displayName: 'asc' }],
        include: { roles: { include: { role: true } }, primaryDepartment: { select: { name: true } } },
      });
      const memberships = await prisma.teamMember.findMany({
        where: { userId: { in: accounts.map(a => a.id) }, leftAt: null, team: { deletedAt: null, status: 'active' } },
        select: { userId: true, role: true, team: { select: { id: true, name: true, leaderId: true } } },
      });
      const list = (accounts as any[]).map(a => ({
        id: a.id,
        displayName: a.displayName,
        email: a.email,
        status: a.status,
        avatarUrl: a.avatarUrl,
        department: a.primaryDepartment?.name || null,
        teams: memberships.filter(member => member.userId === a.id).map(member => ({
          id: member.team.id, name: member.team.name,
          role: member.team.leaderId === a.id || member.role === 'leader' ? 'leader' : 'member',
        })),
        duty: typeof a.metadata?.roleTitle === 'string' ? a.metadata.roleTitle : null,
        roles: (a.roles || []).map((r: any) => r.role?.displayName || r.role?.name).filter(Boolean),
      }));
      return res.json({ ok: true, count: list.length, accounts: list });
    } catch (e: any) {
      const r = safeRouteError(e, { fallbackCode: 'LIST_FAILED' });
      return res.status(r.status).json({ ok: false, error: r.code, message: r.message });
    }
  });

  // POST /api/dev/accounts/:id/login —— 复用登录同款 token 构造，一键以该账号身份进入
  router.post('/accounts/:id/login', async (req: Request, res: Response) => {
    try {
      const userId = String(req.params.id || '');
      if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_ID' });
      const user = await loadUserWithRoles(prisma, userId);
      if (!user) return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });
      if (user.status !== 'active') {
        return res.status(403).json({ ok: false, error: 'USER_INACTIVE', message: `账号状态为 ${user.status}，无法登录` });
      }
      const tokenPayload = await buildLoadedAuthTokenPayload(prisma, user);
      const { roles, permissions, departmentIds, roleIds: newRoleIds } = tokenPayload;
      const token = auth.signToken(tokenPayload);
      // 与真实登录一致：刷新 lastLogin 并写审计
      prisma.userAccount.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => undefined);
      prisma.auditLog.create({
        data: { id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, actorId: user.id, action: 'dev_panel_login', ip: req.ip },
      }).catch(() => undefined);
      return res.json({ ok: true, token, user: serializeAuthUser(user, roles, permissions, departmentIds, { newRoleIds, authorizationLoaded: tokenPayload.authorizationLoaded }) });
    } catch (error) {
      const failure = safeRouteError(error, { fallbackCode: 'AUTHORIZATION_LOAD_FAILED' });
      return res.status(failure.status).json({ ok: false, error: failure.code, message: failure.message });
    }
  });

  return router;
}
