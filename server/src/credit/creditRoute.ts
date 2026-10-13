/**
 * creditRoute.ts — 信用控制域 API（Track F）
 *
 * 挂载：createCreditRouter({ prisma, requireAuth })
 * 建议路径：/api/v1/credit（由主代理在 index.ts 收口）
 *
 * 端点（:customerId = 客户 Relation.id）：
 *   POST /:customerId/freeze   — 人工冻结（scope credit:freeze:write，理由必填）
 *   POST /:customerId/thaw     — 主管手动解冻（scope credit:thaw:write，理由必填，记录 thawedReason）
 *   GET  /:customerId/status   — 信用状态（含门禁标记 creditFrozen / 最大逾期天数）
 *   GET  /:customerId/history  — 历史时间线（冻结/解冻/占用释放全事件，append-only）
 *
 * 鉴权：JWT fail-closed（无 token 401，无 scope 403）。
 * 设计真源：docs/design/03-业务规则/信用控制规则.md §2.4 / §6 #5/#6
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { hasScopeOnRequest } from '../auth/permissionGuard';
import { createCreditService } from './creditService';
import { createBankruptcyService } from './bankruptcyService';
import { logger } from '../lib/logger';
import { serializeValue } from '../lib/serializeValue';

export interface CreditRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
}

export function createCreditRouter(options: CreditRouterOptions): Router {
  const router = Router();
  const { prisma, requireAuth } = options;
  const creditService = createCreditService({ prisma });
  const bankruptcyService = createBankruptcyService(prisma);

  // ── 鉴权：JWT fail-closed ──
  const authenticate = (req: Request, res: Response): { userId: string; roles: string[] } | null => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required.' });
      return null;
    }
    (req as any).actor = actor; // 供 hasScopeOnRequest 使用（permissionGuard 从 req.actor 取权限）
    return { userId: actor.userId, roles: actor.roles ?? [] };
  };

  const requireScope = (req: Request, res: Response, scope: string): boolean => {
    if (!requireAuth) return true;
    if (!hasScopeOnRequest(req, scope as any)) {
      res.status(403).json({ error: 'FORBIDDEN', message: `INSUFFICIENT_SCOPE: ${scope}` });
      return false;
    }
    return true;
  };

  // ══════════════════════════════════════════════════════════════════
  // REQ2-15 客户破产货权处置（DR-055；字面 /bankruptcy 路由须在 /:customerId 参数路由之前）
  // 写守卫：credit:freeze:write（开案含冻结语义；处置动作/闭案同款信用域高危链）
  // ══════════════════════════════════════════════════════════════════

  const sendBankruptcy = <T>(res: Response, r: { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } }, okStatus: number, wrap: (d: T) => Record<string, unknown>) => {
    if (!r.ok) {
      return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
    }
    res.status(okStatus).json(serializeValue(wrap(r.data)) as any);
  };

  // POST /bankruptcy — 开案（declare 首动作 + 自动信用冻结 best-effort）
  router.post('/bankruptcy', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'credit:freeze:write')) return;
    const r = await bankruptcyService.openProceeding((req.body ?? {}) as any, auth.userId);
    sendBankruptcy(res, r, 201, (d) => ({ ok: true, proceeding: d.proceeding, creditFrozen: d.creditFrozen }));
  });

  // GET /bankruptcy?relationId=&status= — 案件列表（含金额汇总）
  router.get('/bankruptcy', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    const r = await bankruptcyService.listProceedings({
      relationId: typeof req.query.relationId === 'string' ? req.query.relationId : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    sendBankruptcy(res, r, 200, (d) => ({ ok: true, items: d.items }));
  });

  // GET /bankruptcy/:id — 详情（动作时间线 + 损益汇总）
  router.get('/bankruptcy/:id', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    const r = await bankruptcyService.getProceeding(req.params.id);
    sendBankruptcy(res, r, 200, (d) => ({ ok: true, proceeding: d.proceeding, actions: d.actions, summary: d.summary }));
  });

  // POST /bankruptcy/:id/actions — 追加处置动作（resale/return_shipment/bad_debt/recover）
  router.post('/bankruptcy/:id/actions', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'credit:freeze:write')) return;
    const r = await bankruptcyService.addAction(req.params.id, (req.body ?? {}) as any, auth.userId);
    sendBankruptcy(res, r, 201, (d) => ({ ok: true, action: d.action, summary: d.summary }));
  });

  // POST /bankruptcy/:id/close — 闭案（终态：close 动作 + 汇总结论落 closeNote）
  router.post('/bankruptcy/:id/close', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'credit:freeze:write')) return;
    const r = await bankruptcyService.closeProceeding(req.params.id, (req.body ?? {}) as any, auth.userId);
    sendBankruptcy(res, r, 200, (d) => ({ ok: true, proceeding: d.proceeding, summary: d.summary }));
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /:customerId/freeze — 人工冻结（理由必填）
  // ══════════════════════════════════════════════════════════════════
  router.post('/:customerId/freeze', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'credit:freeze:write')) return;

    try {
      const result = await creditService.freezeCredit({
        relationId: req.params.customerId,
        reason: String(req.body?.reason ?? '').trim(),
        actorId: auth.userId,
        triggerId: req.body?.triggerId ? String(req.body.triggerId) : undefined,
      });
      if (!result.ok) {
        return res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message });
      }
      return res.json(serializeValue({ ok: true, ...result.data }));
    } catch (e: any) {
      logger.error('[CreditRoute] POST /:customerId/freeze failed', { error: e?.message });
      // B33：原文只进日志（上一行），对外只给中文 + 下一步。
      // ★ 不写「本次没有写入任何数据」：这个 catch 也兜住 `res.json(serializeValue(...))` 的失败，
      //   而那时事务已经提交过 —— 承诺"零写入"会是假话。宁可不承诺，也不给业务员假结论。
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '信用冻结未能完成，请稍后重试；持续失败请联系管理员核对该客户的信用额度与冻结记录。' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /:customerId/thaw — 主管手动解冻（理由必填，记录 thawedReason）
  // ══════════════════════════════════════════════════════════════════
  router.post('/:customerId/thaw', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'credit:thaw:write')) return;

    try {
      const result = await creditService.thawCredit({
        relationId: req.params.customerId,
        reason: String(req.body?.reason ?? '').trim(),
        actorId: auth.userId,
        triggerId: req.body?.triggerId ? String(req.body.triggerId) : undefined,
      });
      if (!result.ok) {
        return res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message });
      }
      return res.json(serializeValue({ ok: true, ...result.data }));
    } catch (e: any) {
      logger.error('[CreditRoute] POST /:customerId/thaw failed', { error: e?.message });
      // B33：同上 —— 不承诺写入状态（catch 覆盖面含响应序列化）。
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '信用解冻未能完成，请稍后重试；持续失败请联系管理员核对该客户的信用额度与解冻记录。' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /:customerId/status — 信用状态（含门禁标记）
  // ══════════════════════════════════════════════════════════════════
  router.get('/:customerId/status', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const status = await creditService.getCreditStatus(req.params.customerId);
      if (!status) {
        return res.status(400).json({ error: 'RELATION_REQUIRED', message: 'customerId 必填' });
      }
      return res.json(serializeValue(status));
    } catch (e: any) {
      logger.error('[CreditRoute] GET /:customerId/status failed', { error: e?.message });
      // B33：读端点，无写入语义。
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '该客户的信用状态加载失败，请稍后重试；持续失败请联系管理员核对信用额度与逾期数据。' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /:customerId/history — 历史时间线
  // ══════════════════════════════════════════════════════════════════
  router.get('/:customerId/history', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const result = await creditService.getCreditHistory({
        relationId: req.params.customerId,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      if (!result.ok) {
        return res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message });
      }
      return res.json(serializeValue(result.data));
    } catch (e: any) {
      logger.error('[CreditRoute] GET /:customerId/history failed', { error: e?.message });
      // B33：读端点，无写入语义。
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '该客户的信用历史加载失败，请稍后重试；持续失败请联系管理员核对信用事件时间线。' });
    }
  });

  return router;
}
