import { parseOrderQuantity } from '../shared/orderQuantitySummary';
/**
 * moqRoute.ts — MOQ 配置与校验 API（挂载建议：/api/v1/moq）
 *
 * 端点：
 *   GET  /config   — 当前生效 MOQ 阈值（登录即可读；无 active 配置时返回兜底常量 + fallback 标记）
 *   PUT  /config   — 管理员调整阈值（scope: settings:moq:write，changeReason ≥5 字，历史留痕）
 *   GET  /history  — 变更历史（append-only 只读，登录即可读）
 *   POST /validate — dry-run 预检（登录即可用；不写库、不建审批单；Capsule 越权 403）
 *
 * 权限（服务端强制执行，fail-closed）：
 *   - 全部端点仅 JWT（extractActorFromRequest），无 token → 401
 *   - PUT /config 无 scope → 403 SCOPE_DENIED + 越权审计（A3：不得以 UI 灰显作为唯一防线）
 */

import { Router, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { logger } from '../lib/logger';
import {
  createMoqConfigService,
  MOQ_CONFIG_WRITE_SCOPE,
  MOQ_FALLBACK_CONSTANTS,
  MOQ_INVALID_REASON,
  MOQ_INVALID_VALUE as CONFIG_INVALID_VALUE,
  MOQ_SCOPE_DENIED,
  moqActorHasScope,
  type MoqActor,
  type MoqConfigService,
} from './moqConfigService';
import { createMoqResolutionService, type MoqResolutionService } from './moqResolutionService';
import {
  createMoqValidationService,
  MOQ_CAPSULE_NOT_ALLOWED,
  MOQ_INVALID_VALUE,
  type MoqValidationService,
} from './moqValidationService';
import type { ApprovalCreateService } from '../approvals/approvalCreateService';
// ★ 未预期异常不再回显原始错误；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';

export interface MoqRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  /** 可注入（测试/复用）；缺省由 prisma 现场构建 */
  configService?: MoqConfigService;
  resolutionService?: MoqResolutionService;
  validationService?: MoqValidationService;
  approvalCreateService?: ApprovalCreateService;
}

export function createMoqRouter(options: MoqRouterOptions): Router {
  const router = Router();
  const { prisma } = options;
  const db = prisma as any;

  const configService = options.configService ?? createMoqConfigService({ prisma });
  const resolutionService = options.resolutionService ?? createMoqResolutionService({ prisma, configService });
  const validationService = options.validationService ?? createMoqValidationService({
    prisma,
    configService,
    resolutionService,
    approvalCreateService: options.approvalCreateService,
  });

  // ── 鉴权：仅 JWT；fail-closed ──
  const authenticate = (req: Request, res: Response): MoqActor | null => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required（MOQ 接口仅接受 JWT 登录）' });
      return null;
    }
    (req as any).actor = actor;
    return { userId: actor.userId, roles: actor.roles ?? [], roleIds: actor.roleIds, permissions: actor.permissions };
  };

  // ── 越权尝试审计（best-effort，不阻断 403 响应） ──
  async function auditScopeDenied(actor: MoqActor, path: string) {
    try {
      await db.auditLog?.create?.({
        data: {
          id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actor.userId,
          action: 'MOQ_CONFIG_WRITE_DENIED',
          targetType: 'MoqThresholdConfig',
          targetId: null,
          detail: { source: 'api:moq', path, roles: actor.roles ?? [] } as any,
          operationType: 'create',
          fieldPath: null,
          transactionId: null,
        },
      });
    } catch (e: any) {
      logger.warn('[MoqRoute] 越权审计写入失败（不阻断 403）', { error: e?.message });
    }
  }

  // ── GET /config — 当前生效配置（登录即可读） ──
  router.get('/config', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const item = await configService.getActiveConfig();
      res.json({
        item,
        fallback: item ? null : { ...MOQ_FALLBACK_CONSTANTS },
        message: item ? undefined : 'MOQ 配置未初始化或加载失败，当前展示兜底常量（请联系管理员）',
      });
    } catch (e: any) {
      logger.error('[MoqRoute] GET /config failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'failed to load moq config' });
      res.status(r.status).json({ error: r.message });
    }
  });

  // ── PUT /config — 管理员调整阈值（scope: settings:moq:write） ──
  router.put('/config', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!moqActorHasScope(auth, MOQ_CONFIG_WRITE_SCOPE)) {
      await auditScopeDenied(auth, 'PUT /config');
      return res.status(403).json({
        error: MOQ_SCOPE_DENIED,
        message: `INSUFFICIENT_SCOPE ${MOQ_CONFIG_WRITE_SCOPE}（仅系统管理员/超级管理员可调 MOQ 阈值）`,
      });
    }
    try {
      const { fabricDefaultMoq, garmentDefaultMoq, capsuleMoq, changeReason } = req.body || {};
      const item = await configService.updateConfig(auth, {
        fabricDefaultMoq: Number(fabricDefaultMoq),
        garmentDefaultMoq: Number(garmentDefaultMoq),
        capsuleMoq: Number(capsuleMoq),
        changeReason: typeof changeReason === 'string' ? changeReason : '',
      });
      res.json({ item });
    } catch (e: any) {
      if (e?.code === MOQ_SCOPE_DENIED) {
        await auditScopeDenied(auth, 'PUT /config');
        return res.status(403).json({ error: MOQ_SCOPE_DENIED, message: e.message });
      }
      if (e?.code === MOQ_INVALID_REASON || e?.code === CONFIG_INVALID_VALUE) {
        return res.status(400).json({ error: e.code, message: e.message });
      }
      logger.error('[MoqRoute] PUT /config failed', { error: e?.message, code: e?.code });
      const r = safeRouteError(e, { fallbackCode: 'MOQ_UPDATE_FAILED', fallbackMessage: 'failed to update moq config' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ── GET /history — 变更历史（append-only 只读） ──
  router.get('/history', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const items = await configService.listHistory({ limit: Number.isFinite(limit) ? limit : undefined });
      res.json({ items });
    } catch (e: any) {
      logger.error('[MoqRoute] GET /history failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'failed to load moq history' });
      res.status(r.status).json({ error: r.message });
    }
  });

  // ── POST /validate — dry-run 预检（不写库、不建审批单） ──
  router.post('/validate', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const body = req.body || {};
      const lines = Array.isArray(body.lines) ? body.lines : null;
      if (!lines || lines.length === 0) {
        return res.status(400).json({ error: MOQ_INVALID_VALUE, message: 'lines 必填且至少 1 行' });
      }
      for (let i = 0; i < lines.length; i++) {
        try { parseOrderQuantity(lines[i]?.quantity); } catch {
          return res.status(400).json({ error: MOQ_INVALID_VALUE, message: `lines[${i}].quantity 必须为有效 Decimal(18,4) 正数` });
        }
      }
      const result = await validationService.validateCreate(
        {
          type: body.type ?? null,
          businessLine: body.businessLine ?? null,
          capsuleExemption: body.capsuleExemption === true,
          customerRelationId: body.customerRelationId ?? null,
          snapshot: body.snapshot ?? null,
          lines: lines.map((l: any) => ({
            quantity: parseOrderQuantity(l.quantity),
            unit: l.unit,
            moqOverride: l.moqOverride ?? null,
            productAssetId: l.productAssetId ?? null,
            styleNo: l.styleNo ?? null,
            materialCode: l.materialCode ?? null,
            // 行级业务线透传（报价单等无单据级 businessLine 的载体逐行推导），service 层行级优先、缺省回退单据级
            businessLine: l.businessLine ?? null,
          })),
        },
        { actor: auth, autoCreateApproval: false }, // dry-run：永不建审批单
      );
      res.json(result);
    } catch (e: any) {
      if (e?.code === MOQ_CAPSULE_NOT_ALLOWED) {
        return res.status(403).json({ error: MOQ_CAPSULE_NOT_ALLOWED, message: 'Capsule 豁免仅适用于服装订单' });
      }
      if (e?.code === MOQ_SCOPE_DENIED) {
        return res.status(403).json({ error: MOQ_SCOPE_DENIED, message: e.message });
      }
      if (e?.code === MOQ_INVALID_VALUE) {
        return res.status(400).json({ error: MOQ_INVALID_VALUE, message: e.message });
      }
      logger.error('[MoqRoute] POST /validate failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'failed to validate moq' });
      res.status(r.status).json({ error: r.message });
    }
  });

  return router;
}
