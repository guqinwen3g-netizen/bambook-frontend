/**
 * Risk Module Route — 风险管理与合规（阶段 H H3 / PRD 15）
 *
 * 端点（挂载于 /api/v1/risk）：
 *
 * 统一预警 RiskAlert：
 *   - GET   /overview                      — 风险总览（Open 按类型/级别分布 + 最近 10 条）
 *   - GET   /alerts                        — 预警列表（?type&level&status&limit&offset）
 *   - PATCH /alerts/:id                    — 更新状态 {status: Open|Acknowledged|Resolved}
 *
 * 汇率（PRD 15.1）：
 *   - GET    /fx-rates                     — 汇率列表（?currency&limit）
 *   - GET    /fx-rates-latest              — 各币种最新汇率（字面路由须在参数路由前）
 *   - POST   /fx-rates                     — 录入汇率 {currency, rate, effectiveDate?, source?, note?}（波动 ≥2% 自动预警）
 *   - GET    /fx-locks                     — 汇率锁定列表（?orderId）
 *   - POST   /fx-locks                     — 锁定汇率 {orderId, currency, rate?, note?}
 *   - DELETE /fx-locks/:id                 — 解除锁定（软删）
 *
 * 信用（PRD 15.2）：
 *   - GET  /credit-ratings                 — 评级历史（?relationId&latestOnly=true&limit）
 *   - POST /credit-ratings/evaluate        — 评估客户信用评级 {relationId}
 *   - POST /credit-risk-scan               — 手动触发信用风险扫描（owner/admin/manager）
 *
 * 合规（PRD 15.3）：
 *   - GET  /compliance-checks              — 检查记录（?type&result&targetType&targetId&limit&offset）
 *   - POST /compliance-checks/hs-code      — HS 编码校验 {declarationId}
 *   - POST /compliance-checks/export-control — 出口管制校验 {declarationId}
 *   - POST /compliance-checks              — 人工录入（origin_rule 等）{type, targetType, targetId, result, summary, details?}
 *   - GET  /sanctioned-countries           — 禁运国清单（M7：SystemConfig 配置，未配置回退默认）
 *   - PUT  /sanctioned-countries           — 更新禁运国清单 {items: string[], reason?}（risk:write）
 *
 * 质量（PRD 15.4）：
 *   - GET  /quality/defect-trends          — 疵点趋势（?groupBy=factory|quarter，默认 factory）
 *   - POST /quality/repeat-scan            — 重复疵点扫描（近 90 天同工厂同疵点 ≥2 张报告 → 预警）
 *
 * 守卫口径（W-C 批三-E 族B 收口）：读面挂 risk:read scope 门；写面 requireJwtForWrite
 * ＋ risk:write scope 门（持有 = FINANCE/SALES_MANAGER＋SuperAdmin 特判，JWT-only，API-Key 不足）；
 * 信用风险扫描（批量冻结，高危）挂 ['risk:write','risk:admin']（risk:admin = 总监级，
 * ADMIN 经此保留文档授权的信用额度管理面；其余 risk 写端点 ADMIN 无 risk:write → 403 属 §6.6 预期收紧）。
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { serializeValue } from '../lib/serializeValue';
import { resolveError } from '../shared/errorCodes';
import {
  createRiskService,
  ExchangeRateInput,
  FxLockInput,
  ManualComplianceCheckInput,
} from './riskService';

export interface RiskRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createRiskRouter(options: RiskRouterOptions): Router {
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const router = Router();
  const service = createRiskService(prisma);

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  // W-C 批三-E：risk 域 scope 门（_shared/rolePermissionMatrix 真源）
  const requireRiskRead = requirePermission('risk:read');
  const requireRiskWrite = requirePermission('risk:write');
  /** 信用扫描属批量冻结级高危操作：risk:write 操作面 或 risk:admin 总监面（OR） */
  const requireRiskScan = requirePermission(['risk:write', 'risk:admin']);
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'risk', action, ids });

  /**
   * 统一错误出口（S0-A Task 5，试点域）：状态码与文案一律由 `shared/errorCodes` 决定。
   *
   * 旧实现（已删）做两件现在看必须算 bug 的事：
   *   1. **用中文子串猜状态码** —— `msg.includes('必填') || includes('大于') → 400`、
   *      `includes('不存在') → 404`、其余 500。同款写法**不是 risk 独有**：2026-09-20 取样的一版
   *      **启发式计数**（窗口 ±6 行、判定 = 中文 `.includes()` 参与状态码判定、先剥注释，
   *      **不是**精确普查）估出全仓另有 **约 21 个文件 / 跨 18 个模块** 在用同款写法，
   *      而且**关键词清单互不相同** ⇒ 同一句文案在 A 域 400、在 B 域 500；真正的
   *      `PrismaClientKnownRequestError`（不含任何这些中文词）恰好落进「其余 = 500」，
   *      于是**数据库原文被当成 500 甩给业务用户**，用户看见 `Unknown argument \`deletedAts\``。
   *      ⚠️ 那个数只支撑「不是孤例」这一句：换窗口/换判据就会得到别的数（同一处注释先写过
   *      「10 个域」与「24 文件 / 16 模块」两版没量清楚的口径，不剥注释则数出 36），
   *      它**不等于「剩余工作量 = 21 个文件」，不要拿它排期**。
   *   2. **把 `e.message` 原样写进响应体**（`json({ error: { code, message: msg } })`）。
   *
   * 现在的口径：**安全可外发的文案进响应，完整原文进日志** —— `logger.error` 仍带原始
   * message（明细不丢，排障要看的就是它），响应体只含注册表文案或业务错误自带的文案。
   * 业务错误（自带 `code` + `statusCode`）照旧透传自己的状态与文案，本函数不改写它。
   */
  const handleError = (res: Response, e: unknown, code: string) => {
    // 非 Error 抛出物（`throw { message }` / `throw 'x'`）也要留下可查的原文：
    // 直接 `String(e)` 会打成 `[object Object]` —— 明细是排障的唯一依据，这里不丢。
    const raw = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e);
    logger.error(`[RiskRoute] ${code} failed`, { error: raw }); // 明细只进日志
    const r = resolveError(e, code);
    res.status(r.status).json({
      error: {
        code: r.code,
        message: r.message,
        ...(r.details === undefined ? {} : { details: r.details }),
      },
    });
  };

  // ══════════════════════════════════════════════════════════════
  // 统一预警
  // ══════════════════════════════════════════════════════════════

  router.get('/overview', requireRiskRead, async (_req: Request, res: Response) => {
    try {
      res.json(serializeValue(await service.getRiskOverview()));
    } catch (e: any) {
      handleError(res, e, 'OVERVIEW_FAILED');
    }
  });

  router.get('/alerts', requireRiskRead, async (req: Request, res: Response) => {
    try {
      const result = await service.listAlerts({
        type: req.query.type ? String(req.query.type) : undefined,
        level: req.query.level ? String(req.query.level) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json(serializeValue(result));
    } catch (e: any) {
      handleError(res, e, 'ALERT_LIST_FAILED');
    }
  });

  router.patch('/alerts/:id', requireWrite, requireRiskWrite, async (req: Request, res: Response) => {
    try {
      const alert = await service.updateAlertStatus(req.params.id, String(req.body?.status || ''), actorIdFromRequest(req));
      notify('update_alert', [alert.id]);
      res.json(serializeValue({ ok: true, item: alert }));
    } catch (e: any) {
      handleError(res, e, 'ALERT_UPDATE_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 汇率
  // ══════════════════════════════════════════════════════════════

  router.get('/fx-rates', requireRiskRead, async (req: Request, res: Response) => {
    try {
      const result = await service.listExchangeRates({
        currency: req.query.currency ? String(req.query.currency) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json(serializeValue(result));
    } catch (e: any) {
      handleError(res, e, 'FX_LIST_FAILED');
    }
  });

  // 字面路由须在 /fx-rates 参数化变体前（本路由无 /fx-rates/:id，仍保持字面前置约定）
  router.get('/fx-rates-latest', requireRiskRead, async (_req: Request, res: Response) => {
    try {
      const items = await service.getLatestRates();
      res.json(serializeValue({ items, total: items.length }));
    } catch (e: any) {
      handleError(res, e, 'FX_LATEST_FAILED');
    }
  });

  router.post('/fx-rates', requireWrite, requireRiskWrite, async (req: Request, res: Response) => {
    try {
      const rate = await service.addExchangeRate(req.body as ExchangeRateInput, actorIdFromRequest(req));
      notify('add_fx_rate', [rate.id]);
      res.status(201).json(serializeValue({ ok: true, item: rate }));
    } catch (e: any) {
      handleError(res, e, 'FX_ADD_FAILED');
    }
  });

  router.get('/fx-locks', requireRiskRead, async (req: Request, res: Response) => {
    try {
      const result = await service.listFxLocks({
        orderId: req.query.orderId ? String(req.query.orderId) : undefined,
      });
      res.json(serializeValue(result));
    } catch (e: any) {
      handleError(res, e, 'FX_LOCK_LIST_FAILED');
    }
  });

  router.post('/fx-locks', requireWrite, requireRiskWrite, async (req: Request, res: Response) => {
    try {
      const lock = await service.lockFxRate(req.body as FxLockInput, actorIdFromRequest(req));
      notify('lock_fx_rate', [lock.id]);
      res.status(201).json(serializeValue({ ok: true, item: lock }));
    } catch (e: any) {
      handleError(res, e, 'FX_LOCK_FAILED');
    }
  });

  router.delete('/fx-locks/:id', requireWrite, requireRiskWrite, async (req: Request, res: Response) => {
    try {
      await service.deleteFxLock(req.params.id, actorIdFromRequest(req));
      notify('delete_fx_lock', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'FX_LOCK_DELETE_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 信用
  // ══════════════════════════════════════════════════════════════

  router.get('/credit-ratings', requireRiskRead, async (req: Request, res: Response) => {
    try {
      const result = await service.listCreditRatings({
        relationId: req.query.relationId ? String(req.query.relationId) : undefined,
        latestOnly: req.query.latestOnly === 'true',
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json(serializeValue(result));
    } catch (e: any) {
      handleError(res, e, 'RATING_LIST_FAILED');
    }
  });

  router.post('/credit-ratings/evaluate', requireWrite, requireRiskWrite, async (req: Request, res: Response) => {
    try {
      const rating = await service.evaluateCreditRating(String(req.body?.relationId || ''), actorIdFromRequest(req));
      notify('evaluate_credit', [rating.id]);
      res.status(201).json(serializeValue({ ok: true, item: rating }));
    } catch (e: any) {
      handleError(res, e, 'RATING_EVALUATE_FAILED');
    }
  });

  // 信用风险扫描：批量冻结客户信用额度，高危操作挂 risk:write/risk:admin 双通道 scope 门
  router.post('/credit-risk-scan', requireWrite, requireRiskScan, async (_req: Request, res: Response) => {
    try {
      const result = await service.runCreditRiskScan();
      if (result.frozenCount > 0 || result.badDebtCount > 0) notify('credit_risk_scan');
      res.json(serializeValue({ ok: true, ...result }));
    } catch (e: any) {
      handleError(res, e, 'CREDIT_SCAN_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 合规
  // ══════════════════════════════════════════════════════════════

  router.get('/compliance-checks', requireRiskRead, async (req: Request, res: Response) => {
    try {
      const result = await service.listComplianceChecks({
        type: req.query.type ? String(req.query.type) : undefined,
        result: req.query.result ? String(req.query.result) : undefined,
        targetType: req.query.targetType ? String(req.query.targetType) : undefined,
        targetId: req.query.targetId ? String(req.query.targetId) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json(serializeValue(result));
    } catch (e: any) {
      handleError(res, e, 'COMPLIANCE_LIST_FAILED');
    }
  });

  router.post('/compliance-checks/hs-code', requireWrite, requireRiskWrite, async (req: Request, res: Response) => {
    try {
      const check = await service.runHsCodeCheck(String(req.body?.declarationId || ''), actorIdFromRequest(req));
      notify('hs_code_check', [check.id]);
      res.status(201).json(serializeValue({ ok: true, item: check }));
    } catch (e: any) {
      handleError(res, e, 'HS_CODE_CHECK_FAILED');
    }
  });

  router.post('/compliance-checks/export-control', requireWrite, requireRiskWrite, async (req: Request, res: Response) => {
    try {
      const check = await service.runExportControlCheck(String(req.body?.declarationId || ''), actorIdFromRequest(req));
      notify('export_control_check', [check.id]);
      res.status(201).json(serializeValue({ ok: true, item: check }));
    } catch (e: any) {
      handleError(res, e, 'EXPORT_CONTROL_CHECK_FAILED');
    }
  });

  // 人工录入（origin_rule 等无自动通道的检查类型）
  router.post('/compliance-checks', requireWrite, requireRiskWrite, async (req: Request, res: Response) => {
    try {
      const check = await service.addManualComplianceCheck(req.body as ManualComplianceCheckInput, actorIdFromRequest(req));
      notify('manual_compliance_check', [check.id]);
      res.status(201).json(serializeValue({ ok: true, item: check }));
    } catch (e: any) {
      handleError(res, e, 'COMPLIANCE_CREATE_FAILED');
    }
  });

  // 禁运国清单配置（M7：SystemConfig 数据库真源，未配置时 source=default 回退内置清单）
  router.get('/sanctioned-countries', requireRiskRead, async (_req: Request, res: Response) => {
    try {
      const result = await service.getSanctionedCountries();
      res.json(serializeValue({ ok: true, ...result }));
    } catch (e: any) {
      handleError(res, e, 'SANCTIONED_LIST_FAILED');
    }
  });

  router.put('/sanctioned-countries', requireWrite, requireRiskWrite, async (req: Request, res: Response) => {
    try {
      const result = await service.updateSanctionedCountries(
        { items: req.body?.items, reason: typeof req.body?.reason === 'string' ? req.body.reason : null },
        actorIdFromRequest(req),
      );
      notify('update_sanctioned_countries');
      res.json(serializeValue({ ok: true, ...result }));
    } catch (e: any) {
      handleError(res, e, 'SANCTIONED_UPDATE_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 质量
  // ══════════════════════════════════════════════════════════════

  router.get('/quality/defect-trends', requireRiskRead, async (req: Request, res: Response) => {
    try {
      const groupBy = req.query.groupBy === 'quarter' ? 'quarter' : 'factory';
      res.json(serializeValue(await service.getDefectTrends({ groupBy })));
    } catch (e: any) {
      handleError(res, e, 'DEFECT_TRENDS_FAILED');
    }
  });

  router.post('/quality/repeat-scan', requireWrite, requireRiskWrite, async (_req: Request, res: Response) => {
    try {
      const result = await service.runQualityRepeatScan();
      if (result.alerted > 0) notify('quality_repeat_scan');
      res.json(serializeValue({ ok: true, ...result }));
    } catch (e: any) {
      handleError(res, e, 'QUALITY_SCAN_FAILED');
    }
  });

  return router;
}
