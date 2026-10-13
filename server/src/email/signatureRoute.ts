/**
 * 阶段 P3b — 邮件签名路由（PRD 12.1 EmailSignature），挂载于 /api/v1/email-signatures
 *
 * 端点：
 *   - GET    /          — 签名列表（?language=&includeInactive=）
 *   - POST   /          — 新建签名（variables 自动从 content 解析）
 *   - GET    /:id       — 签名详情
 *   - PATCH  /:id       — 更新签名（改 content 时重解析变量；isDefault 同 language 事务内唯一）
 *   - DELETE /:id       — 软删除
 *
 * 守卫口径与 email-templates 一致：读走 JWT 或 API-Key，写必须 JWT（requireJwtForWrite）。
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { createEmailSignatureService, EmailSignatureInput } from './emailSignatureService';

export interface EmailSignatureRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

/** BigInt 序列化（模块自洽，不依赖 index.ts 全局 toJSON 补丁的挂载顺序） */
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

export function createEmailSignatureRouter(options: EmailSignatureRouterOptions): Router {
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const router = Router();
  const signatures = createEmailSignatureService(prisma);

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'emailSignature', action, ids });

  const handleError = (res: Response, e: any, code: string) => {
    const msg = e?.message || 'operation failed';
    logger.error(`[EmailSignatureRoute] ${code}`, { error: msg });
    const isNotFound = msg.includes('不存在');
    const isClient = msg.includes('必填') || msg.includes('非法') || msg.includes('不可为空');
    res.status(isNotFound ? 404 : isClient ? 400 : 500).json({ error: { code, message: msg } });
  };

  router.get('/', async (req: Request, res: Response) => {
    try {
      const result = await signatures.listSignatures({
        language: req.query.language as string | undefined,
        includeInactive: req.query.includeInactive === '1' || req.query.includeInactive === 'true',
      });
      res.json(serializeBigInts(result));
    } catch (e: any) {
      handleError(res, e, 'ES_LIST_FAILED');
    }
  });

  router.post('/', requireWrite, async (req: Request, res: Response) => {
    try {
      const row = await signatures.createSignature(req.body as EmailSignatureInput, actorIdFromRequest(req));
      notify('create_email_signature', [row.id]);
      res.status(201).json(serializeBigInts({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'ES_CREATE_FAILED');
    }
  });

  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const row = await signatures.getSignature(req.params.id);
      res.json(serializeBigInts({ item: row }));
    } catch (e: any) {
      handleError(res, e, 'ES_GET_FAILED');
    }
  });

  router.patch('/:id', requireWrite, async (req: Request, res: Response) => {
    try {
      const row = await signatures.updateSignature(req.params.id, (req.body ?? {}) as Partial<EmailSignatureInput>, actorIdFromRequest(req));
      notify('update_email_signature', [row.id]);
      res.json(serializeBigInts({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'ES_UPDATE_FAILED');
    }
  });

  router.delete('/:id', requireWrite, async (req: Request, res: Response) => {
    try {
      await signatures.deleteSignature(req.params.id, actorIdFromRequest(req));
      notify('delete_email_signature', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'ES_DELETE_FAILED');
    }
  });

  return router;
}
