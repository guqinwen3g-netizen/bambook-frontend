import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { logger } from '../lib/logger';
// ★ 未预期异常不再回显原始错误；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';

export interface BusinessProfilesRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

const serializeProfile = (row: any) => ({
  ...row,
  updatedAt: Number(row.updatedAt),
  deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
});

export function createBusinessProfilesRouter(opts: BusinessProfilesRouterOptions): Router {
  const router = Router();

  // 统一认证守卫：JWT（走 jwt.verify 验签）优先，API-Key 次之；API-Key 限只读
  router.use(createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys }));

  // 写操作必须 JWT（API-Key 不可写）
  const requireWrite = requireJwtForWrite({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });

  router.get('/', async (req, res) => {
    try {
      const kind = typeof req.query.kind === 'string' ? req.query.kind.trim() : '';
      const rows = await (opts.prisma as any).businessProfile.findMany({
        where: {
          deletedAt: null,
          ...(kind ? { kind } : {}),
        },
        orderBy: [{ updatedAt: 'desc' }],
      });
      return res.json({ ok: true, profiles: rows.map(serializeProfile) });
    } catch (e: any) {
      logger.error('[business-profiles/list] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'LIST_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.post('/', requireWrite, async (req, res) => {
    try {
      const body = req.body || {};
      const now = BigInt(Date.now());
      const id = String(body.id || `BPROF-${Date.now()}`);
      const kind = String(body.kind || '').trim();
      const name = String(body.name || '').trim();

      if (!kind || !name) {
        return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'kind and name are required' });
      }

      const saved = await (opts.prisma as any).businessProfile.upsert({
        where: { id },
        update: {
          kind,
          name,
          payload: body.payload || {},
          assets: body.assets || {},
          isActive: body.isActive !== false,
          updatedAt: now,
          deletedAt: null,
        },
        create: {
          id,
          kind,
          name,
          payload: body.payload || {},
          assets: body.assets || {},
          isActive: body.isActive !== false,
          updatedAt: now,
          deletedAt: null,
        },
      });

      opts.onDataChange?.({ entity: 'business-profiles', action: 'upsert', ids: [saved.id] });
      return res.json({ ok: true, profile: serializeProfile(saved) });
    } catch (e: any) {
      logger.error('[business-profiles/upsert] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'UPSERT_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.delete('/:id', requireWrite, async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'id is required' });

      const saved = await (opts.prisma as any).businessProfile.update({
        where: { id },
        data: {
          isActive: false,
          deletedAt: BigInt(Date.now()),
          updatedAt: BigInt(Date.now()),
        },
      });

      opts.onDataChange?.({ entity: 'business-profiles', action: 'delete', ids: [id] });
      return res.json({ ok: true, profile: serializeProfile(saved) });
    } catch (e: any) {
      logger.error('[business-profiles/delete] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'DELETE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  return router;
}
