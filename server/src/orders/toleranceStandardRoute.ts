/**
 * toleranceStandardRoute.ts — 公差标准 API（挂载：`/api/v1/tolerance`）
 *
 * ── 内部标准（我方一套，辅助）──
 *   GET  /internal-standard — 当前内部公差标准（登录即可读；未配置 ⇒ `value:null` + `isDefault:true`
 *                             + `defaultValue` = **出厂默认**，界面据此预填）
 *   PUT  /internal-standard — 写入（scope `settings:tolerance:write`，reason ≥5 字，历史留痕）
 *   GET  /history           — 变更历史（append-only 只读，登录即可读）
 *
 * ── 客户标准（★ P0 硬约束）—— 2026-09-29 晚新增 ──
 *   GET  /customer-standard?relationId=  — 该客户的公差标准 + 变更历史（登录即可读）
 *   PUT  /customer-standard              — 写入 / 清空（scope `relations:write`，reason ≥5 字，审计留痕）
 *
 * ── 为什么需要它们 ──
 * 使用方 2026-09-29：「没有客户标准，就按内部标准，**内部标准会需要在系统里填好的**」+「都是**双轨制**…」
 *   ⇒ 两条轨**都必须能在系统里填**：本文件就是那两个通道。
 * ★★ 不填的后果（2026-09-29 上午实测）：出运门禁按「未判定」处理 ⇒ **按 0 卡、不放溢装**。
 *   当晚补上**出厂默认**后，"没人录"不再卡死；但公司/客户各自的标准仍必须能被录进来。
 *
 * ── 双轨制（使用方 2026-09-29 定的全局原则）──
 *   ① **内部标准**（本文件上半）= 辅助（未录 ⇒ 出厂默认）
 *   ② **客户标准**（`Relation.customerAgreementTolerance`）= ★ P0 硬约束，**没有**出厂默认
 *   ⇒ 取数链：行级覆盖 → 客户标准 → 内部/默认 → 未判定（见 `toleranceStandardService.ts`）
 *
 * ── 权限（服务端强制执行，fail-closed）──
 *   · 全部端点仅 JWT（`extractActorFromRequest` 自带验签，**不依赖中间件顺序**）
 *   · 写入无 scope ⇒ 403 `SCOPE_DENIED` + **越权审计**
 *     （A3：不得以 UI 灰显作为唯一防线）
 *   · ★ 形状照抄 `moq/moqRoute.ts`（同一套鉴权 / 审计 / 错误语义）
 */
import { Router, Request, Response, NextFunction } from 'express';
import type { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { hasScopeOnRequest } from '../auth/permissionGuard';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import { logger } from '../lib/logger';
import { safeRouteError } from '../shared/routeError';
import { httpStatusOfCode } from '../shared/errorCodes';
import {
  INTERNAL_TOLERANCE_DEFAULT,
  INTERNAL_TOLERANCE_KEY,
  INTERNAL_TOLERANCE_SCOPE,
  normalizeStandardSet,
  readCustomerToleranceStandard,
  writeCustomerToleranceStandard,
  writeInternalToleranceStandard,
  type ToleranceStandardSet,
} from './toleranceStandardService';

/** 写入内部公差标准所需的 scope（已在 `_shared/rolePermissionMatrix.ts` 登记） */
export const TOLERANCE_STANDARD_WRITE_SCOPE = 'settings:tolerance:write' as const;

/**
 * 写入**客户**公差标准所需的 scope。
 * ★ 刻意**不是**只有 `settings:tolerance:write`：客户标准是**客户档案里的合同约定**，
 *   维护它的人是客户责任人（销售/业务），不是系统管理员。
 *   ⇒ 主口径用档案域已有的 `relations:write`（**不新增 scope** ⇒ 不必动两份权限矩阵）。
 * ★ 但同时**接受** `settings:tolerance:write`：那是「公差机制的管理员」——
 *   系统管理员能改内部标准却修不了一个录错的客户标准，是运维上的死结
 *   （实测 `ADMIN_BASE` 里**没有** `relations:write`，所以只留一条路就等于把管理员挡在外面）。
 * ★ 放宽它会直接放宽出运门禁，所以两条路都要付同样的代价：**理由 ≥5 字 + 真人审计 + 历史**。
 */
export const CUSTOMER_TOLERANCE_WRITE_SCOPE = 'relations:write' as const;

const SCOPE_DENIED = 'SCOPE_DENIED';
const INVALID_VALUE = 'INVALID_VALUE';
const RELATION_ID_REQUIRED = 'RELATION_ID_REQUIRED';

export interface ToleranceStandardRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
}

/** SystemConfig 的主键格式：`${scope}::${key}`（与 systemConfigService.idOf 同口径） */
const CONFIG_ID = `${INTERNAL_TOLERANCE_SCOPE}::${INTERNAL_TOLERANCE_KEY}`;

/**
 * `PUT /customer-standard` 的**形状校验**（纯函数 ⇒ 可单测，也是"错误档位唯一出口"的一半）。
 *
 * ★ 三条规矩，第二条是最容易被写错的那条：
 *   ① `relationId` 必填（客户标准挂在客户身上，不是全局配置）；
 *   ② ★★ **`value` 缺失 ≠ 清空** —— 清空必须显式 `value: null` 或 `clear: true`；
 *      否则一次前端笔误就会静默删掉客户的 **P0 约束**（`undefined` 与 `null` 在 JSON 里也是两回事）；
 *   ③ `value` 必须是对象（`[]`/字符串都不算）。
 */
export function validateCustomerStandardWrite(body: any): { code: string; message: string } | null {
  const relationId = typeof body?.relationId === 'string' ? body.relationId : '';
  if (!relationId.trim()) {
    return { code: RELATION_ID_REQUIRED, message: 'relationId 必填（客户标准挂在客户身上，不是全局配置）' };
  }
  const wantsClear = body.value === null || body.clear === true;
  if (!wantsClear && body.value === undefined) {
    return {
      code: INVALID_VALUE,
      message:
        'value 必填；形状：{ relationId, value: { qtyTolerance?: [{ minQty, maxQty, pct }], widthDeduction?, agreementDate?, agreementRef? }, reason }；' +
        '要清空请**显式**传 value=null（★ "没传"不等于"清空"）',
    };
  }
  if (!wantsClear && (typeof body.value !== 'object' || Array.isArray(body.value))) {
    return { code: INVALID_VALUE, message: 'value 必须为对象（或 null = 清空）' };
  }
  return null;
}

export function createToleranceStandardRouter(options: ToleranceStandardRouterOptions): Router {
  const router = Router();
  const { prisma } = options;
  const db = prisma as any;

  // ── 鉴权：仅 JWT；fail-closed ──
  /** 本文件内部用的 actor 摘要（只取审计与 scope 判定需要的字段） */
  type RouteActor = { userId: string; roles: string[]; roleIds?: string[]; permissions?: string[] };

  const authenticate = (req: Request, res: Response): RouteActor | null => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required（公差标准接口仅接受 JWT 登录）' });
      return null;
    }
    (req as any).actor = actor;
    return { userId: actor.userId, roles: actor.roles ?? [], roleIds: actor.roleIds, permissions: actor.permissions };
  };

  /** 越权尝试审计（best-effort，不阻断 403 响应） */
  async function auditScopeDenied(
    actor: RouteActor,
    path: string,
    target: { targetType: string; targetId: string; action: string } = {
      targetType: 'SystemConfig',
      targetId: CONFIG_ID,
      action: 'TOLERANCE_STANDARD_WRITE_DENIED',
    },
  ) {
    try {
      await db.auditLog?.create?.({
        data: {
          id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actor.userId,
          action: target.action,
          targetType: target.targetType,
          targetId: target.targetId,
          detail: { source: 'api:tolerance', path, roles: actor.roles ?? [] } as any,
          operationType: 'create',
          fieldPath: null,
          transactionId: null,
        },
      });
    } catch (e: any) {
      logger.warn('[ToleranceStandardRoute] 越权审计写入失败（不阻断 403）', { error: e?.message });
    }
  }

  // ── GET /internal-standard — 当前内部标准（登录即可读） ──
  router.get('/internal-standard', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const row = await db.systemConfig.findUnique({
        where: { scope_key: { scope: INTERNAL_TOLERANCE_SCOPE, key: INTERNAL_TOLERANCE_KEY } },
        select: { value: true, version: true, updatedAt: true, updatedBy: true },
      });
      // ★ 未配置**不是错误**：返回 value:null + isDefault:true，**不 500、不造默认值**
      //   （造默认值就等于继续用系统假设冒充标准 —— 那正是本次要修的病）
      //   ★ 2026-09-29 晚：把**出厂默认**一并给出（`defaultValue`）供界面预填与展示；
      //     「出厂默认」与「有人录过的标准」在**数据上仍然分开**（`isDefault` / `value` 各说各话）。
      res.json({
        ok: true,
        key: INTERNAL_TOLERANCE_KEY,
        value: row ? normalizeStandardSet(row.value) : null,
        defaultValue: INTERNAL_TOLERANCE_DEFAULT,
        version: row?.version ?? 0,
        isDefault: !row,
        // ★ SystemConfig.updatedAt 是 BigInt（epoch ms）⇒ res.json 前必须转 Number（否则抛 TypeError）
        updatedAt: row ? Number(row.updatedAt) : null,
        updatedBy: row?.updatedBy ?? null,
      });
    } catch (e: any) {
      logger.error('[ToleranceStandardRoute] GET /internal-standard failed', { error: e?.message });
      const r = safeRouteError(e, {
        fallbackCode: 'CONFIG_READ_FAILED',
        fallbackMessage: '内部公差标准读取失败，请联系管理员（原文已记入服务端日志）',
      });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  /**
   * ★★ 2026-09-29：写入门写成**路由实参位的具名中间件**，**不**写在 handler 体内。
   *
   * 为什么（实测出来的，不是风格偏好）：
   *   G4.1 写面尺（`scripts/lib/writeRouteSurface.mjs`）的 `shape` **只看实参位有没有中间件**
   *   （`guards.length ? 'inline' : 'naked'`）⇒ 门写在体内一律被判成 `naked`，
   *   进 `nakedWriteRoutes` 棘轮桶。★ MOQ 的 `PUT /config` 就是这么被记进基线的（同形）。
   *   写成实参位 ⇒ ① 门**跑在 handler 之前**（handler 不可能忘）
   *              ② 尺的 `extractLocalGates` 认得 —— ★ 它找的是**小写** `hasScope(` / `hasPermission(` /
   *                 `checkPermission(`（`PERMISSION_BODY` 正则），所以这里用本仓**通用**的
   *                 `hasScopeOnRequest(req, scope)`（`auth/permissionGuard.ts`），
   *                 **不**用 `moqActorHasScope(...)`（大写 H，正则匹配不到 ⇒ 会被判成 `authnOnly`）。
   *                 ⇒ **不必去重冻结基线**（重冻结 = 把新债悄悄抹平，本仓明令禁止）。
   *   ★ 仍保留**自带验签**（`extractActorFromRequest`）⇒ 不依赖挂载层中间件的顺序。
   */
  const requireToleranceWrite = async (req: Request, res: Response, next: NextFunction) => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required（公差标准接口仅接受 JWT 登录）' });
      return;
    }
    // ★ `hasScopeOnRequest` 读 `req.actor` ⇒ 先把它挂上（本路由自带验签，不依赖上游中间件）
    (req as any).actor = actor;
    if (!hasScopeOnRequest(req, TOLERANCE_STANDARD_WRITE_SCOPE as PermissionScope)) {
      await auditScopeDenied(
        { userId: actor.userId, roles: actor.roles ?? [], roleIds: actor.roleIds, permissions: actor.permissions },
        `${req.method} ${req.baseUrl}${req.path}`,
      );
      res.status(403).json({
        error: SCOPE_DENIED,
        message: `INSUFFICIENT_SCOPE ${TOLERANCE_STANDARD_WRITE_SCOPE}（仅系统管理员/超级管理员可调内部公差标准）`,
      });
      return;
    }
    next();
  };

  // ── PUT /internal-standard — 写入（门在实参位：requireToleranceWrite） ──
  router.put('/internal-standard', requireToleranceWrite, async (req: Request, res: Response) => {
    // ★ 门已由 `requireToleranceWrite` 通过（actor 已挂到 req 上）
    const auth = (req as any).actor as { userId: string };
    try {
      const body = req.body || {};
      const value = body.value;
      const reason = typeof body.reason === 'string' ? body.reason : '';

      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return res.status(400).json({
          error: INVALID_VALUE,
          message: 'value 必填且必须为对象，形状：{ qtyTolerance?: [{ minQty, maxQty, pct }], widthDeduction?: [{ minQty, maxQty, pct }], agreementDate?, agreementRef? }',
        });
      }

      const r = await writeInternalToleranceStandard(prisma, value as ToleranceStandardSet, {
        actorId: auth.userId,
        reason,
      });
      if (!r.ok) {
        return res.status(400).json({ error: INVALID_VALUE, message: r.message });
      }
      res.json({ ok: true, key: INTERNAL_TOLERANCE_KEY, version: r.version });
    } catch (e: any) {
      logger.error('[ToleranceStandardRoute] PUT /internal-standard failed', { error: e?.message, code: e?.code });
      const r = safeRouteError(e, {
        fallbackCode: 'CONFIG_WRITE_FAILED',
        fallbackMessage: '内部公差标准写入失败，请联系管理员（原文已记入服务端日志）',
      });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ── GET /history — 变更历史（append-only 只读） ──
  router.get('/history', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const rawLimit = req.query.limit ? Number(req.query.limit) : 50;
      const take = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
      const items = await db.systemConfigHistory.findMany({
        where: { configId: CONFIG_ID },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          versionFrom: true,
          versionTo: true,
          valueFrom: true,
          valueTo: true,
          actorId: true,
          reason: true,
          createdAt: true,
        },
      });
      res.json({ items });
    } catch (e: any) {
      logger.error('[ToleranceStandardRoute] GET /history failed', { error: e?.message });
      const r = safeRouteError(e, {
        fallbackCode: 'INTERNAL_ERROR',
        fallbackMessage: '内部公差标准变更历史读取失败，请联系管理员（原文已记入服务端日志）',
      });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // ★ 客户公差标准（P0 那一轨）—— 2026-09-29 晚新增
  // ─────────────────────────────────────────────────────────────────

  /**
   * 参数 / 数据类错误的**唯一出口**（这两个新端点的所有校验分支都走这里）。
   *
   * ★ 挡位**问真源不问本地**：`httpStatusOfCode(code)`（`shared/errorCodes`）——
   *   本批第一版这里写的是 `code === 'RELATION_NOT_FOUND' ? 404 : 400`，被 `codeStatusTruthSourceRatchet`
   *   当场逮住（「出现了基线外的本地 code→status 映射」）。那不是"多了一处债"，而是 **D33/G6.3
   *   「状态规则只许有一份真源」**被违反 ⇒ 修法是**改问本表**（并把这 5 枚码登记进注册表），不是登记欠债。
   * ★ 顺带的好处：B126 那把尺（错误档位落点）本次新增的落点也因此**只剩这一个**。
   * ⚠️ 注册表缺码 ⇒ `httpStatusOfCode` 直接抛（编程错误），绝不静默给默认档。
   */
  const invalid = (res: Response, code: string, message: string) =>
    res.status(httpStatusOfCode(code)).json({ error: code, message });

  // ── GET /customer-standard?relationId= — 该客户的标准 + 变更历史（登录即可读） ──
  router.get('/customer-standard', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const relationId = typeof req.query.relationId === 'string' ? req.query.relationId : '';
      const r = await readCustomerToleranceStandard(prisma, relationId);
      // ★ 400/404 分开（少了参数是调用方的错，"客户不存在"是数据的事）—— 由 `invalid` 统一落档
      if (!r.ok) return invalid(res, r.code, r.message);
      // ★ 客户标准**没有**出厂默认（客户的约定不许我们替它编）⇒ 未录就是 `value:null` + `isUnset:true`
      res.json({
        ok: true,
        relationId: r.relationId,
        customerName: r.customerName,
        value: r.value,
        isUnset: r.value == null,
        history: r.history,
      });
    } catch (e: any) {
      logger.error('[ToleranceStandardRoute] GET /customer-standard failed', { error: e?.message });
      const r = safeRouteError(e, {
        fallbackCode: 'TOLERANCE_CUSTOMER_READ_FAILED',
        fallbackMessage: '客户公差标准读取失败，请重试或联系管理员（原文已记入服务端日志）',
      });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  /**
   * 写客户标准的门 —— ★★ 与内部标准那条同样写成**实参位具名中间件**（理由见上面 `requireToleranceWrite`）。
   * ★ scope 是 `relations:write`（客户档案域）为主口径，另接受 `settings:tolerance:write`（公差机制管理员）——
   *   `ADMIN_BASE` 里没有 `relations:write`，只留一条路会把管理员挡在外面（改不了一个录错的客户标准）。
   * ★ 仍然用**小写** `hasScopeOnRequest(` —— G4.1 写面尺的 `PERMISSION_BODY` 正则只认这个形状。
   */
  const requireCustomerToleranceWrite = async (req: Request, res: Response, next: NextFunction) => {
    // ★ 401 复用既有的 `authenticate`（它已带验签并挂 req.actor）—— 不再复制一份 401 出口
    const actor = authenticate(req, res);
    if (!actor) return;
    // ★ 两条路任一即可：① 客户责任人（relations:write）② 公差机制管理员（settings:tolerance:write）
    const allowed =
      hasScopeOnRequest(req, CUSTOMER_TOLERANCE_WRITE_SCOPE as PermissionScope) ||
      hasScopeOnRequest(req, TOLERANCE_STANDARD_WRITE_SCOPE as PermissionScope);
    if (!allowed) {
      const relationId = typeof (req.body?.relationId) === 'string' ? req.body.relationId : '';
      await auditScopeDenied(
        { userId: actor.userId, roles: actor.roles ?? [], roleIds: actor.roleIds, permissions: actor.permissions },
        `${req.method} ${req.baseUrl}${req.path}`,
        {
          targetType: 'Relation',
          targetId: relationId || 'unknown',
          action: 'CUSTOMER_TOLERANCE_WRITE_DENIED',
        },
      );
      res.status(403).json({
        error: SCOPE_DENIED,
        message:
          `INSUFFICIENT_SCOPE ${CUSTOMER_TOLERANCE_WRITE_SCOPE}（改客户标准需要客户档案的编辑权限；` +
          `或 ${TOLERANCE_STANDARD_WRITE_SCOPE} = 公差机制管理员）`,
      });
      return;
    }
    next();
  };

  // ── PUT /customer-standard — 写入 / 清空（门在实参位：requireCustomerToleranceWrite） ──
  router.put('/customer-standard', requireCustomerToleranceWrite, async (req: Request, res: Response) => {
    const auth = (req as any).actor as { userId: string };
    try {
      const body = req.body || {};
      // ★ 形状校验（含"`value` 缺失 ≠ 清空"那条规矩）收在纯函数里，错误出口只有 `invalid` 一处
      const problem = validateCustomerStandardWrite(body);
      if (problem) return invalid(res, problem.code, problem.message);

      const relationId = body.relationId as string;
      const wantsClear = body.value === null || body.clear === true;
      const r = await writeCustomerToleranceStandard(
        prisma,
        relationId,
        wantsClear ? null : (body.value as ToleranceStandardSet),
        { actorId: auth.userId, reason: typeof body.reason === 'string' ? body.reason : '' },
      );
      // ★ 校验类错误 → 400；关系不存在 → 404（与 GET 同口径，由 `invalid` 统一落档）
      if (!r.ok) return invalid(res, r.code, r.message);
      res.json({ ok: true, relationId, cleared: r.cleared });
    } catch (e: any) {
      logger.error('[ToleranceStandardRoute] PUT /customer-standard failed', { error: e?.message, code: e?.code });
      const r = safeRouteError(e, {
        fallbackCode: 'TOLERANCE_CUSTOMER_WRITE_FAILED',
        fallbackMessage: '客户公差标准写入失败，请重试或联系管理员（原文已记入服务端日志）',
      });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  return router;
}
