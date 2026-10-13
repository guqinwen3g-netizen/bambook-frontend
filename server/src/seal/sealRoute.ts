/**
 * §10.3-9 电子签·印章库路由（Seal），挂载于 /api/v1/seals
 *
 * 端点：
 *   - GET    /          — 印章列表（?type=&ownerRoleId=&ownerUserId=&includeInactive=）
 *   - POST   /          — 新建印章
 *   - GET    /:id       — 印章详情
 *   - PATCH  /:id       — 更新印章
 *   - DELETE /:id       — 软删除
 *   - GET    /resolve   — 按签字人解析应盖章图（?userId=&roleId=），供渲染链内部调用
 *
 * 守卫口径：印章含公司公章图，敏感。全部要求 JWT（挂载时传空 apiKeys 强制），
 * 且调用方须为 领导(role-admin) 或 老板(role-super-admin)，否则 403。
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { createSealService, SealInput, SealValidationError, SYSTEM_ROLE_IDS } from './sealService';

export interface SealRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

function serializeBigInts<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value) as T;
  if (Array.isArray(value)) return value.map(serializeBigInts) as T;
  if (typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value as any)) out[k] = serializeBigInts(v);
    return out;
  }
  return value;
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // JWT.roles 装 legacy 名（owner/admin/…），roleIds 才是系统角色 id——两套都要认。
  // 空库彩排实测：bootstrap 管理员（roles=['owner','admin']）也 403，印章根本传不上、电子签瘫痪。
  const actor: any = (req as any).actor ?? {};
  const roles: string[] = actor.roles ?? [];
  const roleIds: string[] = actor.roleIds ?? [];
  const ok = roleIds.includes(SYSTEM_ROLE_IDS.ADMIN)
    || roleIds.includes(SYSTEM_ROLE_IDS.SUPER_ADMIN)
    || roles.includes(SYSTEM_ROLE_IDS.ADMIN)
    || roles.includes(SYSTEM_ROLE_IDS.SUPER_ADMIN)
    || roles.includes('admin')
    || roles.includes('owner');
  if (!ok) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '仅管理员可管理印章' } });
  }
  next();
}

export function createSealRouter(options: SealRouterOptions): Router {
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const router = Router();
  const seals = createSealService(prisma);

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'seal', action, ids });

  const handleError = (res: Response, e: any, code: string) => {
    const msg = e?.message || 'operation failed';
    // SealValidationError = 调用方输入问题 → 400（不靠消息字符串匹配：
    // 新增校验文案的措辞一变就会误判成 500，污染告警并误导前端重试）
    const isValidation = e instanceof SealValidationError;
    if (!isValidation) logger.error(`[SealRoute] ${code}`, { error: msg });
    const isNotFound = msg.includes('不存在');
    res.status(isValidation ? 400 : isNotFound ? 404 : 500).json({ error: { code, message: msg } });
  };

  router.get('/', requireAdmin, async (req: Request, res: Response) => {
    try {
      const result = await seals.listSeals({
        type: req.query.type as string | undefined,
        ownerRoleId: req.query.ownerRoleId as string | undefined,
        ownerUserId: req.query.ownerUserId as string | undefined,
        includeInactive: req.query.includeInactive === '1' || req.query.includeInactive === 'true',
      });
      res.json(serializeBigInts(result));
    } catch (e: any) {
      handleError(res, e, 'SEAL_LIST_FAILED');
    }
  });

  router.get('/resolve', requireAdmin, async (req: Request, res: Response) => {
    try {
      const resolved = await seals.resolveSealForSigner({
        userId: (req.query.userId as string) || null,
        roleId: (req.query.roleId as string) || null,
      });
      res.json(serializeBigInts({ seal: resolved }));
    } catch (e: any) {
      handleError(res, e, 'SEAL_RESOLVE_FAILED');
    }
  });

  router.post('/', requireAdmin, requireWrite, async (req: Request, res: Response) => {
    try {
      const row = await seals.createSeal(req.body as SealInput, actorIdFromRequest(req));
      notify('create_seal', [row.id]);
      res.status(201).json(serializeBigInts({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'SEAL_CREATE_FAILED');
    }
  });

  router.get('/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      const row = await seals.getSeal(req.params.id);
      res.json(serializeBigInts({ item: row }));
    } catch (e: any) {
      handleError(res, e, 'SEAL_GET_FAILED');
    }
  });

  router.patch('/:id', requireAdmin, requireWrite, async (req: Request, res: Response) => {
    try {
      const row = await seals.updateSeal(req.params.id, (req.body ?? {}) as Partial<SealInput>, actorIdFromRequest(req));
      notify('update_seal', [row.id]);
      res.json(serializeBigInts({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'SEAL_UPDATE_FAILED');
    }
  });

  router.delete('/:id', requireAdmin, requireWrite, async (req: Request, res: Response) => {
    try {
      await seals.deleteSeal(req.params.id, actorIdFromRequest(req));
      notify('delete_seal', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'SEAL_DELETE_FAILED');
    }
  });

  return router;
}
