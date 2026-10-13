/**
 * sampleRoute.ts — 样品域统一路由，建议挂载于 /api/v1/samples
 *
 * 覆盖链路：
 *   面料 S/S 船样 + RC 匹头样（DR-011/012/014/039）：
 *   - POST /fabric/:orderId/shipment-sample        — S/S 船样登记（面料订单必须管理）
 *   - POST /fabric/:orderId/head-sample            — RC 匹头样启用（业务员决定并留痕）
 *   - POST /:id/ship                               — 寄送登记（快递商/单号/日期/收件方 + 随附单据）
 *   - POST /:id/confirm                            — 客户确认登记（结果/日期/渠道/意见/证据）
 *   - GET  /fabric/:orderId/samples                — 样品列表（含 Exmill 倒计时/逾期标记）
 *   - GET  /fabric/:orderId/shipment-eligibility   — DR-012 样品链发货资格判定（出运域消费）
 *   - GET  /fabric/:orderId/shipment-gate          — DR-013 例外门禁消费（叠加生效例外：gate/exception 放行或 409 GATE_BLOCKED）
 *
 *   投产后早期生产样（DR-028，不限轮次闭环）：
 *   - POST /early-production/:orderId/rounds           — 登记新一轮（previousSampleId 链入上一轮）
 *   - POST /early-production/rounds/:id/ship           — 寄送登记
 *   - POST /early-production/rounds/:id/feedback       — 客户反馈登记（approved 闭环；其余转 QC 迭代）
 *   - GET  /early-production/:orderId/rounds           — 链式列表
 *
 *   服装多轮样品双门禁（DR-008/DR-029）：
 *   - POST /garment/:caseId/rounds                     — 创建轮次（目的/版本/材料工艺配置必填）
 *   - POST /garment/:id/submit-qc                      — QC 评审结论登记（引用 InspectionReport 只读）
 *   - POST /garment/:id/submit-customer                — 提交客户（QC 未通过 → 409，fail-closed）
 *   - POST /garment/:id/register-customer-confirmation — 业务员登记客户确认（不加主管审批）
 *   - POST /garment/:id/seal                           — 封存产前样（不可变；pp 节点投影 approved）
 *   - GET  /garment/:caseId/rounds                     — 轮次列表（含当前封存基准）
 *
 * 守卫口径：读走 JWT 或 API-Key；写必须 JWT（requireJwtForWrite）+ scope 校验
 * （requirePermission，fail-closed：API key 不可写，无 scope → 403）。
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
// ★ 未预期异常不外泄原始错误（棘轮守卫只许减不许增；新代码必须用它）
import { safeRouteError } from '../shared/routeError';
// ★ C5：寄样历史只读查询（三入口统一口径）
import { getSampleShipmentHistory, type SampleShipmentSubject } from './sampleShipmentHistoryService';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { extractActorFromRequest } from '../auth/middleware';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { serializeValue } from '../lib/serializeValue';
import { createFabricShipmentSampleService } from './fabricShipmentSampleService';
import { createEarlyProductionSampleService } from './earlyProductionSampleService';
import { createGarmentSampleGateService } from './garmentSampleGateService';
import { createColorBatchService } from './colorBatchService';
import { createColorCardService } from './colorCardService';
import { createSampleRoomService } from './sampleRoomService';
import { createSampleCardMoveRouter } from './sampleCardMoveRoute';
import { createSampleCardSampleLinkRouter } from './sampleCardSampleLinkRoute';
import { createOrderSampleNativeRouter } from './orderSampleNativeRoute';
import { getSampleInventorySummary } from './sampleInventorySummaryService';
import { getSampleRegistrationContext } from './sampleRegistrationContextService';
import { registerSampleCommand, recoverSampleRegistration } from './sampleRegistrationCommandService';
import { createSampleLengthService } from './sampleLengthService';
import {
  listSamples, getSample, createSample, updateSample, deleteSample,
  advanceSampleStage, forkSample, invoiceSample,
} from './sampleManageService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createExceptionService } from '../exceptions/exceptionService';
import { PRIVATE_FILES_DIR, isInsideDir } from '../lib/privateFiles';
import { hasFatalSecretProblem, jwtSecretProblems } from '../auth/secretPolicy';

export interface SampleRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys?: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
  /** Private root only; never point this at the /api/uploads public root. */
  privateFilesDir?: string;
}

export function createSampleRouter(options: SampleRouterOptions): Router {
  const { prisma, requireAuth, onDataChange } = options;
  const privateFilesDir = path.resolve(options.privateFilesDir ?? PRIVATE_FILES_DIR);
  const apiKeys = options.apiKeys ?? new Set<string>();
  const router = Router();

  // DR-013 例外查询链（门禁消费真源）：hasActiveException 注入样品链门禁消费点
  const exceptionRoutingService = createApprovalRoutingService({ prisma });
  const exceptionApprovalCreateService = createApprovalCreateService({ prisma, routingService: exceptionRoutingService });
  const exceptionService = createExceptionService({ prisma, approvalCreateService: exceptionApprovalCreateService });

  const fabricService = createFabricShipmentSampleService({ prisma, exceptionChecker: exceptionService.hasActiveException });
  const earlyService = createEarlyProductionSampleService({ prisma });
  const garmentService = createGarmentSampleGateService({ prisma });

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  router.use('/room/items',createSampleCardMoveRouter({prisma,apiKeys,onDataChange}));
  router.use('/order-native', createOrderSampleNativeRouter({ prisma, apiKeys, onDataChange }));
  router.use(createSampleCardSampleLinkRouter({ prisma, requireAuth, apiKeys, onDataChange }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });

  // scope 中间件（fail-closed；写类 scope 强制 JWT user-session）
  const requireShipmentWrite = [requireWrite, requirePermission('sample:shipment:write')];
  const requireEarlyWrite = [requireWrite, requirePermission('sample:early_production:write')];
  const requireGarmentWrite = [requireWrite, requirePermission('products:write')];
  const requireGarmentQc = [requireWrite, requirePermission('qc:garment_chain:write')];

  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'samples', action, ids });

  const sendResult = <T>(res: Response, r: { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } }, okStatus = 200, wrapKey?: string) => {
    if (!r.ok) {
      return res.status(r.error.status ?? 400).json({ error: { code: r.error.code, message: r.error.message } });
    }
    const body = wrapKey ? { ok: true, [wrapKey]: (r.data as any)[wrapKey], ...omit(r.data as any, wrapKey) } : { ok: true, ...(r.data as any) };
    res.status(okStatus).json(serializeValue(body));
  };
  const omit = (obj: any, key: string) => {
    const { [key]: _drop, ...rest } = obj ?? {};
    return rest;
  };

  // ══════════════════════════════════════════════════════════════
  // 面料 S/S 船样 + RC 匹头样
  // ══════════════════════════════════════════════════════════════

  router.post('/fabric/:orderId/shipment-sample', ...requireShipmentWrite, (_req: Request, res: Response) => {
    res.status(410).json({ error: { code: 'GONE', message: '旧订单样品登记入口已退役。请在订单详情或样品管理选择实际订单行、生产批次和工厂，使用订单样品登记流程。' } });
  });

  router.post('/fabric/:orderId/head-sample', ...requireShipmentWrite, (_req: Request, res: Response) => {
    res.status(410).json({ error: { code: 'GONE', message: '旧订单样品登记入口已退役。请在订单详情或样品管理选择实际订单行、生产批次和工厂，使用订单样品登记流程。' } });
  });

  router.get('/fabric/:orderId/samples', async (req: Request, res: Response) => {
    try {
      const r = await fabricService.listOrderSamples({ orderId: req.params.orderId });
      sendResult(res, r, 200, 'items');
    } catch (e: any) {
      logger.error('[SampleRoute] FABRIC_SAMPLE_LIST_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'FABRIC_SAMPLE_LIST_FAILED', fallbackMessage: '该订单的面料寄样清单加载失败，请稍后重试；持续失败请联系管理员核对寄样记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.get('/fabric/:orderId/shipment-eligibility', async (req: Request, res: Response) => {
    try {
      const r = await fabricService.computeShipmentEligibility({ orderId: req.params.orderId });
      sendResult(res, r, 200, 'eligibility');
    } catch (e: any) {
      logger.error('[SampleRoute] SHIPMENT_ELIGIBILITY_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'SHIPMENT_ELIGIBILITY_FAILED', fallbackMessage: '该订单的出运资格判定加载失败，请稍后重试；为避免误放行，本页不显示判定结论，请稍后再试或联系管理员。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // DR-013 例外门禁消费端点：叠加生效例外后的放行结论（gate / exception）或 409 GATE_BLOCKED
  // （阻断时透传 blockingReasons + exceptionReason + exceptionEntryHint，引导 DR-013 申请入口）
  // [B4 零散收敛 2026-09-15] ⚠️ 前端与 Agent 均零消费：
  // 前端用不带例外叠加的兄弟端点 shipment-eligibility（sampleService/qcService）；
  // 出运域已用并行实现 evaluateShipmentReleaseGate（shipping/shipmentEligibilityGate.ts）覆盖同一语义。
  // 保留原因：被 2 条 HTTP 契约测试锁定（samples/__tests__/sampleRoute.test.ts）；
  // 若产品需要「订单级出运门禁预览（含 DR-013 例外放行徽标）」的只读入口则仍有用——待业务方定夺后再删并同步移除测试。
  router.get('/fabric/:orderId/shipment-gate', async (req: Request, res: Response) => {
    try {
      const r = await fabricService.assertFabricShipmentGate({ orderId: req.params.orderId });
      if (!r.ok) {
        return res.status(r.error.status ?? 400).json({
          error: {
            code: r.error.code,
            message: r.error.message,
            blockingReasons: r.error.blockingReasons,
            exceptionReason: r.error.exceptionReason,
            exceptionEntryHint: r.error.exceptionEntryHint,
          },
        });
      }
      res.status(200).json(serializeValue({ ok: true, pass: r.data.pass, eligibility: r.data.eligibility }));
    } catch (e: any) {
      logger.error('[SampleRoute] SHIPMENT_GATE_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'SHIPMENT_GATE_FAILED', fallbackMessage: '该订单的出运门禁明细加载失败，请稍后重试；缺哪几条暂时看不到，请勿据此判断可以出运。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 投产后早期生产样（DR-028）
  // ══════════════════════════════════════════════════════════════

  router.post('/early-production/:orderId/rounds', ...requireEarlyWrite, (_req: Request, res: Response) => {
    res.status(410).json({ error: { code: 'GONE', message: '旧订单样品登记入口已退役。请在订单详情或样品管理选择实际订单行、生产批次和工厂，使用订单样品登记流程。' } });
  });

  router.post('/early-production/rounds/:id/ship', ...requireEarlyWrite, async (req: Request, res: Response) => {
    try {
      const r = await earlyService.sendSample({
        sampleId: req.params.id,
        input: req.body ?? {},
        actorId: actorIdFromRequest(req),
        ip: req.ip,
      });
      if (r.ok) notify('send_early_production_sample', [req.params.id]);
      sendResult(res, r, 200, 'sample');
    } catch (e: any) {
      logger.error('[SampleRoute] EPS_SHIP_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'EPS_SHIP_FAILED', fallbackMessage: '该轮早产样未能标记寄出，本次改动未生效，请稍后重试；持续失败请联系管理员核对样品与快递单号。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.post('/early-production/rounds/:id/feedback', ...requireEarlyWrite, async (req: Request, res: Response) => {
    try {
      const r = await earlyService.confirmSample({
        sampleId: req.params.id,
        input: req.body ?? {},
        actorId: actorIdFromRequest(req),
        ip: req.ip,
      });
      if (r.ok) notify('confirm_early_production_sample', [req.params.id]);
      sendResult(res, r, 200, 'sample');
    } catch (e: any) {
      logger.error('[SampleRoute] EPS_CONFIRM_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'EPS_CONFIRM_FAILED', fallbackMessage: '该轮早产样的客户反馈未能登记，本次改动未生效，请稍后重试；持续失败请联系管理员核对该轮次状态。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.get('/early-production/:orderId/rounds', async (req: Request, res: Response) => {
    try {
      const r = await earlyService.listByOrder({ orderId: req.params.orderId });
      sendResult(res, r, 200, 'items');
    } catch (e: any) {
      logger.error('[SampleRoute] EPS_LIST_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'EPS_LIST_FAILED', fallbackMessage: '该订单的早产样轮次加载失败，请稍后重试；持续失败请联系管理员核对轮次记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 服装多轮样品双门禁（DR-008）
  // ══════════════════════════════════════════════════════════════

  router.post('/garment/:caseId/rounds', ...requireGarmentWrite, async (req: Request, res: Response) => {
    try {
      const r = await garmentService.createRound({
        caseId: req.params.caseId,
        input: req.body ?? {},
        actorId: actorIdFromRequest(req),
        ip: req.ip,
      });
      if (r.ok) notify('create_garment_sample_round', (r.data.rounds || [r.data.round]).map((round: any) => round.id));
      sendResult(res, r, 201, 'round');
    } catch (e: any) {
      logger.error('[SampleRoute] GARMENT_ROUND_CREATE_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'GARMENT_ROUND_CREATE_FAILED', fallbackMessage: '成衣样轮次未能建立，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该开发案例。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.post('/garment/rounds/:roundId/micro-versions', ...requireGarmentWrite, async (req: Request, res: Response) => {
    try {
      const r = await garmentService.addMicroVersion({
        roundId: req.params.roundId, note: req.body?.note, requestKey: req.body?.requestKey,
        actorId: actorIdFromRequest(req), trustedActor: extractActorFromRequest(req) ?? undefined, ip: req.ip,
      });
      if (r.ok) notify('add_garment_micro_version', [req.params.roundId]);
      sendResult(res, r, 201, 'round');
    } catch (e: any) {
      logger.error('[SampleRoute] GARMENT_MICRO_VERSION_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'GARMENT_MICRO_VERSION_FAILED', fallbackMessage: '微调记录未能保存，请稍后重试。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.post('/garment/:id/submit-qc', ...requireGarmentQc, async (req: Request, res: Response) => {
    try {
      const r = await garmentService.submitQcConclusion({
        roundId: req.params.id,
        input: req.body ?? {},
        actorId: actorIdFromRequest(req),
        ip: req.ip,
      });
      if (r.ok) notify('submit_garment_sample_qc', [req.params.id]);
      sendResult(res, r, 200, 'round');
    } catch (e: any) {
      logger.error('[SampleRoute] GARMENT_QC_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'GARMENT_QC_FAILED', fallbackMessage: '该成衣样未能提交内检，本次改动未生效，请稍后重试；持续失败请联系管理员核对样衣与检验项。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.post('/garment/:id/submit-customer', ...requireGarmentWrite, async (req: Request, res: Response) => {
    try {
      const r = await garmentService.submitToCustomer({
        roundId: req.params.id,
        input: req.body ?? {},
        actorId: actorIdFromRequest(req),
        trustedActor: (req as any).actor,
        ip: req.ip,
      });
      if (r.ok) notify('submit_garment_sample_to_customer', [req.params.id]);
      sendResult(res, r, 200, 'round');
    } catch (e: any) {
      logger.error('[SampleRoute] GARMENT_SUBMIT_CUSTOMER_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'GARMENT_SUBMIT_CUSTOMER_FAILED', fallbackMessage: '该成衣样未能提交客户确认，本次改动未生效，请稍后重试；持续失败请联系管理员核对寄送与收件人信息。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.post('/garment/:id/register-customer-confirmation', ...requireGarmentWrite, async (req: Request, res: Response) => {
    try {
      const r = await garmentService.registerCustomerConfirmation({
        roundId: req.params.id,
        input: req.body ?? {},
        actorId: actorIdFromRequest(req),
        trustedActor: extractActorFromRequest(req) ?? undefined,
        ip: req.ip,
      });
      if (r.ok) notify('confirm_garment_sample', [req.params.id]);
      sendResult(res, r, 200, 'round');
    } catch (e: any) {
      logger.error('[SampleRoute] GARMENT_CONFIRM_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'GARMENT_CONFIRM_FAILED', fallbackMessage: '该成衣样的客户确认结论未能登记，本次改动未生效，请稍后重试；持续失败请联系管理员核对确认单号与日期。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.post('/garment/:id/seal', ...requireGarmentWrite, async (req: Request, res: Response) => {
    try {
      const r = await garmentService.sealRound({ roundId: req.params.id, actorId: actorIdFromRequest(req), trustedActor: extractActorFromRequest(req) ?? undefined,
        sampleVersionId: req.body?.sampleVersionId, ip: req.ip, retainLocation: req.body?.retainLocation });
      if (r.ok) notify('seal_garment_preproduction_sample', [req.params.id]);
      sendResult(res, r, 200, 'round');
    } catch (e: any) {
      logger.error('[SampleRoute] GARMENT_SEAL_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'GARMENT_SEAL_FAILED', fallbackMessage: '该成衣样未能封样，本次改动未生效，请稍后重试；封样后款式不再接受改动，请确认无误再操作。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.get('/garment/:caseId/rounds', async (req: Request, res: Response) => {
    try {
      const r = await garmentService.listRounds({ caseId: req.params.caseId, trustedActor: extractActorFromRequest(req) ?? undefined });
      if (!r.ok) return res.status(r.error.status ?? 400).json({ error: { code: r.error.code, message: r.error.message } });
      res.json(serializeValue({ ok: true, items: r.data.items, sealedRoundId: r.data.sealedRoundId }));
    } catch (e: any) {
      logger.error('[SampleRoute] GARMENT_ROUND_LIST_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'GARMENT_ROUND_LIST_FAILED', fallbackMessage: '该开发案例的成衣样轮次加载失败，请稍后重试；持续失败请联系管理员核对轮次记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 通用样品操作（/:id 两段式，注册在最后避免吞掉字面路由）
  // ══════════════════════════════════════════════════════════════

  /**
   * ★ C5（2026-09-18）GET /shipment-history/:subject/:id — 寄样历史（只读）
   *
   * 为什么需要：三个寄样入口里，**只有早产样支持分批寄样**（`attachments.rounds[]` 追加），
   * 面料取样与成衣轮次原来是**覆盖式**（只留最后一次）⇒ 客户问"上次那批什么时候寄的"查不到。
   * C5 已把后两者对齐成**追加式**（与早产样同模式、零 migration）；本端点把三者的历史
   * 收敛成**同一返回形状**，前端不必各写一套解析。
   *
   * @param subject fabric（面料出运取样）| garment（成衣轮次）| early（早产样）
   */
  router.get('/shipment-history/:subject/:id', async (req: Request, res: Response) => {
    const subject = String(req.params.subject) as SampleShipmentSubject;
    if (!['fabric', 'garment', 'early'].includes(subject)) {
      return res.status(400).json({ error: { code: 'INVALID_SUBJECT', message: `subject 必须是 fabric / garment / early，收到 ${subject}` } });
    }
    try {
      res.json(await getSampleShipmentHistory(prisma, subject, req.params.id));
    } catch (e: any) {
      logger.error('[SampleRoute] SHIPMENT_HISTORY_FAILED', { error: e?.message });
      // ⓘ 本文件历史上有 41 处 `e?.message` 直返（棘轮基线冻结，只许减不许增）
      //   ⇒ 新代码一律走 safeRouteError（未预期异常换通用文案，业务错误原样透传）
      const r = safeRouteError(e, { fallbackCode: 'SHIPMENT_HISTORY_FAILED', fallbackMessage: '寄样历史查询失败，请稍后重试' });
      res.status(r.status).json({ error: { code: r.code, message: r.message } });
    }
  });

  router.post('/:id/ship', ...requireShipmentWrite, async (req: Request, res: Response) => {
    try {
      const r = await fabricService.registerSampleShipment({
        sampleId: req.params.id,
        input: req.body ?? {},
        actorId: actorIdFromRequest(req),
        ip: req.ip,
      });
      if (r.ok) notify('ship_sample', [req.params.id]);
      sendResult(res, r, 200, 'sample');
    } catch (e: any) {
      logger.error('[SampleRoute] SAMPLE_SHIP_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'SAMPLE_SHIP_FAILED', fallbackMessage: '该样品未能登记寄出，本次改动未生效，请稍后重试；持续失败请联系管理员核对快递单号与收件信息。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.post('/:id/confirm', ...requireShipmentWrite, async (req: Request, res: Response) => {
    try {
      const r = await fabricService.registerCustomerConfirmation({
        sampleId: req.params.id,
        input: req.body ?? {},
        actorId: actorIdFromRequest(req),
        ip: req.ip,
      });
      if (r.ok) notify('confirm_sample', [req.params.id]);
      sendResult(res, r, 200, 'sample');
    } catch (e: any) {
      logger.error('[SampleRoute] SAMPLE_CONFIRM_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'SAMPLE_CONFIRM_FAILED', fallbackMessage: '该样品未能登记确认结论，本次改动未生效，请稍后重试；持续失败请联系管理员核对确认人与日期。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // REQ2-01 打色批次（色差管理体系）：缸号级色差证据链
  // 读走 JWT/API-Key；写必须 JWT（sample:color_batch:write scope）
  // ══════════════════════════════════════════════════════════════
  const colorBatchService = createColorBatchService(prisma);
  const requireColorBatchWrite = [requireWrite, requirePermission('sample:color_batch:write')];

  // ══════════════════════════════════════════════════════════════
  // D6-Q1 米样长度口径（2026-09-16 拍板）— /:id/length[-movements]
  // 长度建账 / 分割 / 剪给客户 / 余量退回 / 损耗 / 借入归还；台账 append-only
  // 权限：与样品登记同门（products:write——通用样品登记走 sampleGarmentWrite 同款，见 T1 口径）
  // ══════════════════════════════════════════════════════════════
  const lengthService = createSampleLengthService(prisma);
  const requireSampleLengthWrite = [requireWrite, requirePermission('products:write')];

  // POST /:id/length — 长度建账（仅未建账样品；单位 M/YD）
  router.post('/:id/length', ...requireSampleLengthWrite, async (req: Request, res: Response) => {
    try {
      const r = await lengthService.setSampleLength({
        sampleId: req.params.id,
        quantity: (req.body || {}).quantity,
        unit: (req.body || {}).unit,
        note: (req.body || {}).note ?? null,
        operator: actorIdFromRequest(req),
      });
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      notify('length_set', [req.params.id]);
      res.json(serializeValue({ ok: true, sample: (r.data as any).sample }));
    } catch (err: any) {
      logger.error('[sampleRoute] set length failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'LENGTH_SET_FAILED', fallbackMessage: '该样布米数未能保存，本次改动未生效，请稍后重试；持续失败请联系管理员核对该样布的用量记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // POST /:id/length/cut — 裁剪分割（父样减、建子样、双向流水）
  router.post('/:id/length/cut', ...requireSampleLengthWrite, async (req: Request, res: Response) => {
    try {
      const r = await lengthService.cutSampleLength({
        sampleId: req.params.id,
        quantity: (req.body || {}).quantity,
        note: (req.body || {}).note ?? null,
        operator: actorIdFromRequest(req),
      });
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      notify('length_cut', [req.params.id, (r.data as any).child.id]);
      res.json(serializeValue({ ok: true, ...(r.data as any) }));
    } catch (err: any) {
      logger.error('[sampleRoute] cut length failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'LENGTH_CUT_FAILED', fallbackMessage: '该样布剪裁米数未能登记，本次改动未生效，请稍后重试；剪样不可逆，请确认无误再操作。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // POST /:id/length/move — give/return/loss/borrow_in/borrow_return
  router.post('/:id/length/move', ...requireSampleLengthWrite, async (req: Request, res: Response) => {
    try {
      const r = await lengthService.moveSampleLength({
        sampleId: req.params.id,
        type: (req.body || {}).type,
        quantity: (req.body || {}).quantity,
        note: (req.body || {}).note ?? null,
        operator: actorIdFromRequest(req),
      });
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      notify('length_move', [req.params.id]);
      res.json(serializeValue({ ok: true, sample: (r.data as any).sample }));
    } catch (err: any) {
      logger.error('[sampleRoute] move length failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'LENGTH_MOVE_FAILED', fallbackMessage: '该样布米数异动未能登记，本次改动未生效，请稍后重试；持续失败请联系管理员核对出入库记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // ─── D7-① 转化通道（2026-09-16）—— 米样 ↔ 大货/应收 ───────────────────
  // POST /:id/convert-to-bulk — 米样转大货：样品侧减（to_bulk）+ 大货侧增（createStockMovement），**双侧同事务**
  router.post('/:id/convert-to-bulk', ...requireSampleLengthWrite, async (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      const r = await lengthService.convertToBulk({
        sampleId: req.params.id,
        quantity: b.quantity,
        targetInventoryItemId: b.targetInventoryItemId ?? null,
        warehouseId: b.warehouseId ?? null,
        materialCode: b.materialCode ?? null,
        description: b.description ?? null,
        lossQty: b.lossQty,
        note: b.note ?? null,
        operator: actorIdFromRequest(req),
      });
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      notify('length_move', [req.params.id]);
      res.json(serializeValue({ ok: true, ...(r.data as any) }));
    } catch (err: any) {
      logger.error('[sampleRoute] convert to bulk failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'CONVERT_TO_BULK_FAILED', fallbackMessage: '该样品未能转大货，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对样衣与订单关联。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // POST /:id/convert-to-resale — 米样转售：样品侧减（to_resale）+ 应收侧增（BillingItem sourceType='Sample'）
  // 双侧**严格同事务**（2026-09-16 收口）：应收侧走 createBillingItemInTx(tx, …)，任一侧失败整体回滚
  router.post('/:id/convert-to-resale', ...requireSampleLengthWrite, async (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      const r = await lengthService.convertToResale({
        sampleId: req.params.id,
        quantity: b.quantity,
        customerRelationId: b.customerRelationId,
        amount: b.amount,
        currency: b.currency ?? null,
        note: b.note ?? null,
        operator: actorIdFromRequest(req),
      });
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      notify('length_move', [req.params.id]);
      res.json(serializeValue({ ok: true, ...(r.data as any) }));
    } catch (err: any) {
      logger.error('[sampleRoute] convert to resale failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'CONVERT_TO_RESALE_FAILED', fallbackMessage: '该样品未能转内销，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对样衣处置记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /:id/length/movements — 长度台账
  router.get('/:id/length/movements', async (req: Request, res: Response) => {
    try {
      const r = await lengthService.listLengthMovements({
        sampleId: req.params.id,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      res.json(serializeValue({ ok: true, movements: (r.data as any).movements }));
    } catch (err: any) {
      logger.error('[sampleRoute] list length movements failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'LENGTH_LIST_FAILED', fallbackMessage: '该样布的米数异动流水加载失败，请稍后重试；持续失败请联系管理员核对出入库记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // REQ2-09 Pantone 色号库（DR-051）— /colors
  // 读走 JWT/API-Key；写必须 JWT（sample:color_batch:write 同款角色链）
  // ══════════════════════════════════════════════════════════════
  const colorCardService = createColorCardService(prisma);
  const requireColorCardWrite = [requireWrite, requirePermission('sample:color_batch:write')];

  router.get('/colors', async (req: Request, res: Response) => {
    try {
      const r = await colorCardService.listColors({
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        family: typeof req.query.family === 'string' ? req.query.family : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      sendResult(res, r, 200, 'items');
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_LIST_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_LIST_FAILED', fallbackMessage: '色卡列表加载失败，请稍后重试；持续失败请联系管理员核对色卡数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // 字面路由（/colors/:code/color-batches）须在参数路由（/colors/:id PATCH/DELETE 按 id）之前；
  // GET /colors/:code 与 PATCH/DELETE /colors/:id 键不同不冲突
  router.get('/colors/:code/color-batches', async (req: Request, res: Response) => {
    try {
      const r = await colorCardService.listColorBatchesForColor(
        req.params.code,
        req.query.includeNearby === 'true' || req.query.includeNearby === '1',
      );
      sendResult(res, r, 200, 'batches');
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_BATCHES_FOR_COLOR_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_BATCHES_FOR_COLOR_FAILED', fallbackMessage: '该色号的批色记录加载失败，请稍后重试；持续失败请联系管理员核对批色与色卡关联。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.get('/colors/:code', async (req: Request, res: Response) => {
    try {
      const r = await colorCardService.getColorByCode(req.params.code);
      sendResult(res, r, 200, 'color');
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_GET_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_GET_FAILED', fallbackMessage: '该色号详情加载失败，请稍后重试；若反复出现请核对色号是否输错或已被删除。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.post('/colors', ...requireColorCardWrite, async (req: Request, res: Response) => {
    try {
      const r = await colorCardService.createColor(req.body ?? {});
      if (r.ok) notify('create_color_card', [r.data.color.id]);
      sendResult(res, r, 201, 'color');
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_CREATE_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_CREATE_FAILED', fallbackMessage: '该色号未能新建，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对色号是否重复。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.patch('/colors/:id', ...requireColorCardWrite, async (req: Request, res: Response) => {
    try {
      const r = await colorCardService.updateColor(req.params.id, req.body ?? {});
      sendResult(res, r, 200, 'color');
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_UPDATE_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_UPDATE_FAILED', fallbackMessage: '该色号未能保存，本次改动未生效，请稍后重试；持续失败请联系管理员核对该色号记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.delete('/colors/:id', ...requireColorCardWrite, async (req: Request, res: Response) => {
    try {
      const r = await colorCardService.deleteColor(req.params.id);
      if (r.ok) notify('delete_color_card', [req.params.id]);
      sendResult(res, r, 200, 'deleted');
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_DELETE_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_DELETE_FAILED', fallbackMessage: '该色号未能删除，本次未确认任何改动，请稍后重试；若已被引用请先处理引用记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // 种子端点（幂等）：Pantone TCX 常用子集补缺
  router.post('/colors/seed', ...requireColorCardWrite, async (req: Request, res: Response) => {
    try {
      const r = await colorCardService.seedPantoneTcx();
      res.status(200).json(serializeValue({ ok: true, ...r }));
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_SEED_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_SEED_FAILED', fallbackMessage: '标准色卡初始化未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对标准色库文件。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // REQ2-16 样品间管理（DR-057）：实物样卡登记（二维码编号）→ 借出/归还 → 看样记录
  // 守卫沿样品域惯例：读登录即可（样卡目录非敏感）；写 JWT + sample:room:write。
  // ══════════════════════════════════════════════════════════════════
  const sampleRoomService = createSampleRoomService(prisma);
  const requireRoomWrite = [requireWrite, requirePermission('sample:room:write')];

  const photoSecret = () => {
    const secret = process.env.JWT_SECRET;
    return secret && secret.length >= 32 && !hasFatalSecretProblem(jwtSecretProblems(secret)) ? secret : null;
  };
  const photoSignature = (secret:string,itemId:string,photo:any) => createHmac('sha256',secret)
    .update([itemId,photo.id,photo.storageKey,photo.mimeType,String(photo.size),photo.sha256,photo.uploadedAt,photo.uploadedBy].join('\n')).digest('hex');
  const equalHex = (left:unknown,right:unknown) => typeof left==='string'&&typeof right==='string'&&/^[a-f0-9]{64}$/.test(left)&&/^[a-f0-9]{64}$/.test(right)
    &&timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
  const inspectImage = (buffer:Buffer) => {
    if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mimeType:'image/png',extension:'.png'};
    if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return {mimeType:'image/jpeg',extension:'.jpg'};
    if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return {mimeType:'image/webp',extension:'.webp'};
    return null;
  };
  const photoUpload = multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:8},fileFilter:(_req,file,cb)=>{
    if(['image/jpeg','image/png','image/webp'].includes(file.mimetype))cb(null,true);else cb(new Error('仅支持 JPEG、PNG、WebP 图片'));
  }}).array('photos',8);

  // Complete unit-separated snapshot; terminal physical records are separate.
  router.get('/room/summary', requirePermission('products:read'), async (req: Request, res: Response) => {
    const ids = typeof req.query.sampleIds === 'string' ? req.query.sampleIds.split(',') : undefined;
    sendResult(res, await getSampleInventorySummary(prisma, ids, (req as any).actor));
  });

  // Explicit projection; query cannot select the legacy full DTO for catalog rows.
  router.get('/room/custody-directory', requirePermission('products:read'), async (req: Request, res: Response) => {
    try {
      sendResult(res, await sampleRoomService.listCustodyDirectory(req.query, (req as any).actor));
    } catch (error) {
      const failure = safeRouteError(error, { fallbackCode: 'ROOM_DIRECTORY_UNAVAILABLE', fallbackMessage: '实物台账暂不可用，请重新读取。' });
      res.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
    }
  });

  // POST /room/items — 样卡登记（编号自动生成 SC-YYYYMMDD-NNN，二维码载荷）
  router.post('/room/items', ...requireRoomWrite, async (req: Request, res: Response) => {
    try {
      const r = await sampleRoomService.createItem(req.body ?? {}, (req as any).actor);
      if (r.ok) notify('create_sample_card', [r.data.item.id]);
      sendResult(res, r, 201, 'item');
    } catch (e: any) {
      logger.error('[SampleRoute] ROOM_ITEM_CREATE_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'ROOM_ITEM_CREATE_FAILED', fallbackMessage: '样品室物品未能登记入库，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对物品与存放位置。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.patch('/room/items/:id/library', ...requireRoomWrite, async(req:Request,res:Response)=>{
    const r=await sampleRoomService.updateLibrary(req.params.id,req.body??{},(req as any).actor);
    if(r.ok)notify('update_sample_card_library',[req.params.id]);
    sendResult(res,r,200,'item');
  });

  // GET /room/items — 列表（状态/类型/搜索/编号直达；附活跃借出与逾期派生标记）
  // v2：支持 warehouseId/devCaseId/orderId/productAssetId 联动过滤 + lowStock 预警过滤
  // v3（样品库）：sampleIds 逗号分隔批量过滤（样品管理页列表实物摘要聚合一次拉回）
  router.get('/room/items', requirePermission('products:read'), async (req: Request, res: Response) => {
    try {
      const r = await sampleRoomService.listItems({
        status: req.query.status, cardType: req.query.cardType, search: req.query.search, code: req.query.code,
        warehouseId: req.query.warehouseId, devCaseId: req.query.devCaseId, orderId: req.query.orderId,
        productAssetId: req.query.productAssetId, sampleId: req.query.sampleId, sampleIds: req.query.sampleIds,
        scope: req.query.scope, lowStock: req.query.lowStock, limit: req.query.limit, offset: req.query.offset,
      }, (req as any).actor);
      sendResult(res, r.ok?{ok:true,data:{...r.data,moveVersion:1}}:r, 200, 'list');
    } catch (e: any) {
      logger.error('[SampleRoute] ROOM_ITEM_LIST_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'ROOM_ITEM_LIST_FAILED', fallbackMessage: '样品室物品列表加载失败，请稍后重试；持续失败请联系管理员核对样品室台账。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /room/items/:id — 详情（含借还历史正序）
  router.get('/room/items/:id', requirePermission('products:read'), async (req: Request, res: Response) => {
    try {
      const r = await sampleRoomService.getItem(req.params.id, (req as any).actor);
      sendResult(res, r, 200, 'detail');
    } catch (e: any) {
      logger.error('[SampleRoute] ROOM_ITEM_GET_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'ROOM_ITEM_GET_FAILED', fallbackMessage: '该样品室物品详情加载失败，请稍后重试；若反复出现请核对物品编号是否正确。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // 私有实物照片：小批图片先完整进入内存，核验真实格式后原子落盘；
  // DB 元数据和审计同一事务，失败时清理新文件。每次读取重新授权并验 HMAC/内容 SHA-256。
  router.post('/room/items/:id/photos', ...requireRoomWrite, (req:Request,res:Response,next)=>photoUpload(req,res,(error:any)=>{
    if(error)return res.status(error.code==='LIMIT_FILE_SIZE'||error.code==='LIMIT_FILE_COUNT'?413:400).json({error:{code:'INVALID_SAMPLE_PHOTO',message:'照片须为 JPEG、PNG 或 WebP，单张不超过 5 MB，每件最多 8 张。'}});
    next();
  }), async (req:Request,res:Response)=>{
    const stored:string[]=[],temporary:string[]=[];
    try {
      const secret=photoSecret();
      if(!secret)return res.status(503).json({error:{code:'PHOTO_SIGNING_UNAVAILABLE',message:'照片私有签名服务暂不可用。'}});
      const files=(req.files??[]) as Express.Multer.File[];
      if(!files.length)return res.status(400).json({error:{code:'INVALID_SAMPLE_PHOTO',message:'请至少选择一张照片。'}});
      if(files.length>8)return res.status(413).json({error:{code:'PHOTO_LIMIT_REACHED',message:'每次最多上传 8 张照片。'}});
      // Exact full-detail authorization before any private bytes are written.
      const current=await sampleRoomService.getItem(req.params.id,(req as any).actor);
      if(!current.ok)return sendResult(res,current);
      const existing=Array.isArray((current.data as any).item?.photos)?(current.data as any).item.photos:[];
      if(existing.length+files.length>8)return res.status(409).json({error:{code:'PHOTO_LIMIT_REACHED',message:'每件实物最多登记 8 张照片。'}});
      const prepared=files.map(file=>({file,format:inspectImage(file.buffer)}));
      if(prepared.some(row=>!row.format))return res.status(415).json({error:{code:'INVALID_SAMPLE_PHOTO',message:'图片内容格式无效。'}});
      const root=path.resolve(privateFilesDir,'sample-photos');
      const publicUploadRoot=path.resolve(process.env.BAMBOOK_UPLOAD_DIR||path.join(__dirname,'../../../uploads'));
      if(!isInsideDir(privateFilesDir,root)||isInsideDir(privateFilesDir,publicUploadRoot)||isInsideDir(publicUploadRoot,privateFilesDir))
        return res.status(503).json({error:{code:'PHOTO_STORAGE_UNAVAILABLE',message:'照片私有存储暂不可用。'}});
      await fs.promises.mkdir(privateFilesDir,{recursive:true});
      const privateReal=await fs.promises.realpath(privateFilesDir);
      await fs.promises.mkdir(root,{recursive:true});
      const rootReal=await fs.promises.realpath(root);
      if(!isInsideDir(privateReal,rootReal)||isInsideDir(publicUploadRoot,rootReal)||isInsideDir(rootReal,publicUploadRoot))
        return res.status(503).json({error:{code:'PHOTO_STORAGE_UNAVAILABLE',message:'照片私有存储暂不可用。'}});
      const now=new Date().toISOString(),actorId=(req as any).actor.userId as string;
      const metadata:any[]=[];
      for(const {file,format} of prepared) {
        if(!format)throw new Error('Validated image format unexpectedly missing');
        const id=randomUUID(),storageKey=`sample-photos/${id}${format.extension}`;
        const target=path.resolve(privateReal,storageKey),temp=`${target}.${randomUUID()}.tmp`;
        if(!isInsideDir(rootReal,target))return res.status(400).json({error:{code:'INVALID_SAMPLE_PHOTO',message:'照片存储目标无效。'}});
        temporary.push(temp);
        await fs.promises.writeFile(temp,file.buffer,{flag:'wx',mode:0o600});
        await fs.promises.rename(temp,target);temporary.splice(temporary.indexOf(temp),1);stored.push(target);
        const photo:any={id,storageKey,mimeType:format.mimeType,size:file.buffer.length,sha256:createHash('sha256').update(file.buffer).digest('hex'),uploadedAt:now,uploadedBy:actorId};
        photo.signature=photoSignature(secret,req.params.id,photo);metadata.push(photo);
      }
      const result=await sampleRoomService.appendItemPhotos(req.params.id,metadata,(req as any).actor);
      if(!result.ok){await Promise.all(stored.map(file=>fs.promises.rm(file,{force:true})));return sendResult(res,result);}
      notify('upload_sample_card_photos',[req.params.id]);
      return sendResult(res,result,201,'item');
    } catch(error:any) {
      await Promise.all([...stored,...temporary].map(file=>fs.promises.rm(file,{force:true}).catch(()=>undefined)));
      logger.error('[SampleRoute] ROOM_ITEM_PHOTO_UPLOAD_FAILED',{error:error?.message});
      const failure=safeRouteError(error,{fallbackCode:'SAMPLE_PHOTO_UPLOAD_FAILED',fallbackMessage:'样品照片未能安全登记，请重试。'});
      return res.status(failure.status).json({error:{code:failure.code,message:failure.message}});
    }
  });

  router.get('/room/items/:id/photos/:photoId', requirePermission('products:read'), async(req:Request,res:Response)=>{
    try {
      const result=await sampleRoomService.getItemPhoto(req.params.id,req.params.photoId,(req as any).actor);
      if(!result.ok)return sendResult(res,result);
      const secret=photoSecret(),photo=(result.data as any).photo;
      if(!secret||!equalHex(photo.signature,photoSignature(secret,req.params.id,photo))||!equalHex(req.query.sig,photo.signature))
        return res.status(404).json({error:{code:'SAMPLE_PHOTO_NOT_FOUND',message:'样品照片不存在或不可用。'}});
      if(!/^sample-photos\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(photo.storageKey??''))return res.status(404).json({error:{code:'SAMPLE_PHOTO_NOT_FOUND',message:'样品照片不存在或不可用。'}});
      const privateRoot=await fs.promises.realpath(privateFilesDir),root=await fs.promises.realpath(path.resolve(privateFilesDir,'sample-photos'));
      const publicUploadRoot=path.resolve(process.env.BAMBOOK_UPLOAD_DIR||path.join(__dirname,'../../../uploads'));
      if(!isInsideDir(privateRoot,root)||isInsideDir(root,publicUploadRoot)||isInsideDir(publicUploadRoot,root))return res.status(404).json({error:{code:'SAMPLE_PHOTO_NOT_FOUND',message:'样品照片不存在或不可用。'}});
      const filename=photo.storageKey.slice('sample-photos/'.length),target=path.resolve(root,filename);
      if(!isInsideDir(root,target))return res.status(404).json({error:{code:'SAMPLE_PHOTO_NOT_FOUND',message:'样品照片不存在或不可用。'}});
      const real=await fs.promises.realpath(target),stat=await fs.promises.lstat(target);
      if(stat.isSymbolicLink()||!stat.isFile()||!isInsideDir(root,real))return res.status(404).json({error:{code:'SAMPLE_PHOTO_NOT_FOUND',message:'样品照片不存在或不可用。'}});
      const bytes=await fs.promises.readFile(real),digest=createHash('sha256').update(bytes).digest('hex');
      if(bytes.length!==photo.size||!equalHex(digest,photo.sha256))return res.status(404).json({error:{code:'SAMPLE_PHOTO_INTEGRITY_FAILED',message:'样品照片完整性核验失败。'}});
      return res.status(200).type(photo.mimeType).set('Cache-Control','private, no-store').set('X-Content-Type-Options','nosniff').send(bytes);
    } catch(error:any) {
      if(error?.code==='ENOENT')return res.status(404).json({error:{code:'SAMPLE_PHOTO_NOT_FOUND',message:'样品照片不存在或不可用。'}});
      logger.error('[SampleRoute] ROOM_ITEM_PHOTO_READ_FAILED',{error:error?.message});
      return res.status(500).json({error:{code:'SAMPLE_PHOTO_READ_FAILED',message:'样品照片读取失败。'}});
    }
  });

  // POST /room/items/:id/retire — 退役（终态；在借不可退役）
  router.post('/room/items/:id/retire', ...requireRoomWrite, async (req: Request, res: Response) => {
    try {
      const r = await sampleRoomService.retireItem(req.params.id, req.body?.note, (req as any).actor);
      if (r.ok) notify('retire_sample_card', [req.params.id]);
      sendResult(res, r, 200, 'item');
    } catch (e: any) {
      logger.error('[SampleRoute] ROOM_ITEM_RETIRE_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'ROOM_ITEM_RETIRE_FAILED', fallbackMessage: '该物品未能标记退出样品室，本次改动未生效，请稍后重试；持续失败请联系管理员核对在借记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // POST /room/items/:id/loans — 借出（borrow）/ 看样登记（viewing）
  // v2：透传 loanQuantity 支持一次借多张
  router.post('/room/items/:id/loans', ...requireRoomWrite, async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const r = await sampleRoomService.createLoan(req.params.id, {
        loanType: body.loanType,
        loanQuantity: body.loanQuantity,
        loanLength: body.loanLength, requestKey: body.requestKey,
        borrowerName: body.borrowerName,
        borrowerUserId: body.borrowerUserId,
        relationId: body.relationId,
        dueAt: body.dueAt != null ? Number(body.dueAt) : undefined,
      }, (req as any).actor);
      if (r.ok) notify('loan_sample_card', [req.params.id]);
      sendResult(res, r, 201, 'loanResult');
    } catch (e: any) {
      logger.error('[SampleRoute] ROOM_LOAN_CREATE_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'ROOM_LOAN_CREATE_FAILED', fallbackMessage: '该样品的借用未能登记，本次未确认任何改动，请稍后重试；请确认库存在借出前未被占用。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // DR-054 阶段 C：寄出出样（ship）——寄出=扣减数量+终态归档，不可归还
  router.post('/room/items/:id/ship', ...requireRoomWrite, async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const r = await sampleRoomService.shipItem(req.params.id, {
        shipQuantity: body.shipQuantity != null ? Number(body.shipQuantity) : undefined,
        shipLength: body.shipLength, requestKey: body.requestKey,
        recipientName: body.recipientName,
        relationId: body.relationId,
        dueAt: body.dueAt != null ? Number(body.dueAt) : undefined,
      }, (req as any).actor);
      if (r.ok) notify('ship_sample_card', [req.params.id]);
      sendResult(res, r, 201, 'shipResult');
    } catch (e: any) {
      logger.error('[SampleRoute] ROOM_ITEM_SHIP_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'ROOM_ITEM_SHIP_FAILED', fallbackMessage: '该样品的寄出未能登记，本次改动未生效，请稍后重试；持续失败请联系管理员核对快递单号与收件人。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // DR-054 阶段 C：封样 = 实物级 tag（记录标准批次 reference）
  router.post('/room/items/:id/seal', ...requireRoomWrite, async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const r = await sampleRoomService.sealCard(req.params.id, {
        standardBatchNo: body.standardBatchNo,
        notes: body.notes,
      }, (req as any).actor);
      if (r.ok) notify('seal_sample_card', [req.params.id]);
      sendResult(res, r, 200, 'item');
    } catch (e: any) {
      logger.error('[SampleRoute] ROOM_ITEM_SEAL_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'ROOM_ITEM_SEAL_FAILED', fallbackMessage: '该实物未能登记封样标签，本次改动未生效，请稍后重试；持续失败请核对实物来源与封样记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /room/low-stock — 低库存预警（v2 新增：availableQty <= minStock）
  router.get('/room/low-stock', requirePermission('products:read'), async (req: Request, res: Response) => {
    try {
      const r = await sampleRoomService.listLowStock(req.query.limit ? Number(req.query.limit) : undefined, (req as any).actor);
      sendResult(res, r, 200, 'list');
    } catch (e: any) {
      logger.error('[SampleRoute] ROOM_LOW_STOCK_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'ROOM_LOW_STOCK_FAILED', fallbackMessage: '样品室低库存清单加载失败，请稍后重试；为避免误判缺货，本页不显示结论，请稍后再试或联系管理员。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // POST /room/loans/:id/return — 归还（append-only：只补 returnedAt/conditionNote）
  router.post('/room/loans/:id/return', ...requireRoomWrite, async (req: Request, res: Response) => {
    try {
      const r = await sampleRoomService.returnLoan(req.params.id, req.body?.returnLength !== undefined || req.body?.requestKey !== undefined ? {returnLength:req.body?.returnLength,requestKey:req.body?.requestKey,conditionNote:req.body?.conditionNote,returnQuantity:req.body?.returnQuantity} : req.body?.conditionNote, (req as any).actor);
      if (r.ok) notify('return_sample_card', [r.data.item.id]);
      sendResult(res, r, 200, 'loanResult');
    } catch (e: any) {
      logger.error('[SampleRoute] ROOM_LOAN_RETURN_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'ROOM_LOAN_RETURN_FAILED', fallbackMessage: '该借用未能登记归还，本次改动未生效，请稍后重试；持续失败请联系管理员核对借用单与实收状态。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /room/loans — 借还流水（在借/逾期/历史/看样）
  router.get('/room/loans', requirePermission('products:read'), async (req: Request, res: Response) => {
    try {
      const r = await sampleRoomService.listLoans({
        active: req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined,
        overdue: req.query.overdue === 'true' ? true : undefined,
        loanType: typeof req.query.loanType === 'string' ? req.query.loanType : undefined,
        itemId: typeof req.query.itemId === 'string' ? req.query.itemId : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }, (req as any).actor);
      sendResult(res, r, 200, 'list');
    } catch (e: any) {
      logger.error('[SampleRoute] ROOM_LOAN_LIST_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'ROOM_LOAN_LIST_FAILED', fallbackMessage: '样品借用记录加载失败，请稍后重试；持续失败请联系管理员核对借还台账。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // 字面路由（/color-batches/evidence）须在参数路由（/color-batches/:id）之前
  router.get('/color-batches/evidence', async (req: Request, res: Response) => {
    try {
      const r = await colorBatchService.getColorBatchEvidence({
        developmentCaseId: typeof req.query.developmentCaseId === 'string' ? req.query.developmentCaseId : undefined,
        orderId: typeof req.query.orderId === 'string' ? req.query.orderId : undefined,
      });
      sendResult(res, r, 200, 'evidence');
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_EVIDENCE_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_EVIDENCE_FAILED', fallbackMessage: '批色凭证记录加载失败，请稍后重试；持续失败请联系管理员核对批色与色卡的关联。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.get('/color-batches', async (req: Request, res: Response) => {
    try {
      const r = await colorBatchService.listColorBatches({
        developmentCaseId: typeof req.query.developmentCaseId === 'string' ? req.query.developmentCaseId : undefined,
        orderId: typeof req.query.orderId === 'string' ? req.query.orderId : undefined,
      });
      sendResult(res, r, 200, 'items');
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_BATCH_LIST_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_BATCH_LIST_FAILED', fallbackMessage: '批色记录列表加载失败，请稍后重试；持续失败请联系管理员核对批色数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.post('/color-batches', ...requireColorBatchWrite, async (req: Request, res: Response) => {
    try {
      const r = await colorBatchService.createColorBatch(req.body ?? {}, actorIdFromRequest(req));
      if (r.ok) notify('create_color_batch', [r.data.id]);
      sendResult(res, r, 201, 'batch');
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_BATCH_CREATE_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_BATCH_CREATE_FAILED', fallbackMessage: '该批色记录未能新建，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对色号与客户要求。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.patch('/color-batches/:id', ...requireColorBatchWrite, async (req: Request, res: Response) => {
    try {
      const r = await colorBatchService.updateColorBatch(req.params.id, req.body ?? {});
      sendResult(res, r, 200, 'batch');
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_BATCH_UPDATE_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_BATCH_UPDATE_FAILED', fallbackMessage: '该批色记录未能保存，本次改动未生效，请稍后重试；持续失败请联系管理员核对批色编号。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // 客户判定（批色即封样 + 疵点自动入供应商质量分）
  router.post('/color-batches/:id/customer-feedback', ...requireColorBatchWrite, async (req: Request, res: Response) => {
    try {
      const r = await colorBatchService.recordCustomerFeedback(req.params.id, req.body ?? {}, actorIdFromRequest(req));
      if (r.ok) notify('color_batch_customer_feedback', [req.params.id]);
      sendResult(res, r, 200, 'batch');
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_FEEDBACK_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_FEEDBACK_FAILED', fallbackMessage: '该批色的客户反馈未能登记，本次改动未生效，请稍后重试；持续失败请联系管理员核对反馈单与日期。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.delete('/color-batches/:id', ...requireColorBatchWrite, async (req: Request, res: Response) => {
    try {
      const r = await colorBatchService.deleteColorBatch(req.params.id, actorIdFromRequest(req));
      sendResult(res, r, 200, 'deleted');
    } catch (e: any) {
      logger.error('[SampleRoute] COLOR_BATCH_DELETE_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'COLOR_BATCH_DELETE_FAILED', fallbackMessage: '该批色记录未能删除，本次未确认任何改动，请稍后重试；若已被引用请先处理引用记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // ── 样品管理域（DR-052）：统一样品对象 Sample CRUD + 双状态机 + 复刻 ──
  // 守卫：读 products:read；写 products:write（样品源自开发/订单域，对齐 development 口径）
  const requireSampleWrite = [requireWrite, requirePermission('products:write')];
  const requireSampleRead = requirePermission('products:read');
  // DR-053 阶段 0：开票是财务写动作，除样品写权限外必须对齐 invoices:write（缺一 403）
  const requireSampleInvoiceWrite = [...requireSampleWrite, requirePermission('invoices:write')];

  // Multi-segment paths deliberately cannot be accepted by an old /:id route.
  router.get('/registration/context', requireWrite, requireSampleRead, async (req: Request, res: Response) => {
    sendResult(res, await getSampleRegistrationContext({ prisma, actor: (req as any).actor, caseId: req.query.caseId }));
  });
  router.post('/registration/exact', ...requireSampleWrite, async (req: Request, res: Response) => {
    const r = await registerSampleCommand({ prisma, actor: (req as any).actor, input: req.body, ip: req.ip ?? null });
    if (r.ok && !r.data.replayed) {
      // A subscriber failure after commit cannot erase the durable receipt.
      try { notify('create', [r.data.sample.id]); }
      catch (error) { logger.error('[SampleRoute] registration notification failed after commit', { error }); }
    }
    sendResult(res, r, r.ok && r.data.replayed ? 200 : 201);
  });
  router.get('/registration/requests/:requestKey', requireWrite, requireSampleRead, async (req: Request, res: Response) => {
    sendResult(res, await recoverSampleRegistration({ prisma, actor: (req as any).actor, requestKey: req.params.requestKey }));
  });

  router.get('/', requireSampleRead, async (req: Request, res: Response) => {
    try {
      const r = await listSamples(prisma, {
        type: String(req.query.type ?? ''), status: String(req.query.status ?? ''),
        sourceCaseId: req.query.sourceCaseId, sourceOrderId: String(req.query.sourceOrderId ?? ''),
        supplier: String(req.query.supplier ?? ''), search: String(req.query.search ?? ''),
        scope: req.query.scope, limit: req.query.limit, offset: req.query.offset,
      });
      sendResult(res, r);
    } catch (e: any) {
      logger.error('[SampleRoute] SAMPLE_LIST_FAILED', { error: e?.message });
      const se = safeRouteError(e, { fallbackCode: 'SAMPLE_LIST_FAILED', fallbackMessage: '样品列表暂时无法加载，请稍后重试。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });
  router.post('/', ...requireSampleWrite, async (req: Request, res: Response) => {
    if (['origin', 'sealOrigin', 'registrationVersion', 'requestKey', 'expectedCaseUpdatedAt', 'expectedCaseContentFingerprint'].some(key => Object.prototype.hasOwnProperty.call(req.body ?? {}, key))) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: '准确来源登记须先读取登记上下文并使用专用版本 2 入口；不能降级为普通草稿。' } });
    }
    const r = await createSample({ prisma, input: req.body ?? {}, actorId: actorIdFromRequest(req) || '', trustedActor: (req as any).actor, ip: req.ip ?? null });
    if (!r.ok) return sendResult(res, r);
    notify('create', [r.data.sample.id]);
    sendResult(res, r, 201, 'sample');
  });
  router.get('/:id', requireSampleRead, async (req: Request, res: Response) => {
    const r = await getSample(prisma, req.params.id);
    sendResult(res, r, 200, 'sample');
  });
  router.patch('/:id', ...requireSampleWrite, async (req: Request, res: Response) => {
    const r = await updateSample({ prisma, sampleId: req.params.id, input: req.body ?? {}, actorId: actorIdFromRequest(req) || '', ip: req.ip ?? null });
    if (!r.ok) return sendResult(res, r);
    notify('update', [r.data.sample.id]);
    sendResult(res, r, 200, 'sample');
  });
  router.delete('/:id', ...requireSampleWrite, async (req: Request, res: Response) => {
    const r = await deleteSample({ prisma, sampleId: req.params.id, actorId: actorIdFromRequest(req) || '', ip: req.ip ?? null });
    if (!r.ok) return sendResult(res, r);
    notify('delete', [r.data.sample.id]);
    sendResult(res, r, 200, 'sample');
  });
  router.patch('/:id/stage', ...requireSampleWrite, async (req: Request, res: Response) => {
    const { action } = req.body ?? {};
    const r = await advanceSampleStage({ prisma, sampleId: req.params.id, action, input: req.body ?? {}, actorId: actorIdFromRequest(req) || '', ip: req.ip ?? null });
    if (!r.ok) return sendResult(res, r);
    notify('stage', [r.data.sample.id]);
    sendResult(res, r, 200, 'sample');
  });
  router.post('/:id/fork', ...requireSampleWrite, async (req: Request, res: Response) => {
    const r = await forkSample({ prisma, sampleId: req.params.id, input: req.body ?? {}, actorId: actorIdFromRequest(req) || '', ip: req.ip ?? null });
    if (!r.ok) return sendResult(res, r);
    notify('fork', [r.data.sample.id]);
    sendResult(res, r, 201, 'sample');
  });

  // DR-052 §6 产物级开票触点：样品对象独立开票（自动带出客户/默认金额 → 回填 invoiceId）
  // DR-053 阶段 0：权限对齐财务 invoices:write；幂等（来源唯一约束 + 重试恢复）
  // 样品直接开票（DR-054 §2.4/§3-3）：开票已收归财务域单入口（finance scene-invoice 按场景完成），
// 本端点 fail-closed 410，前端已于 DR-054 阶段 F 移除直接开票按钮（仅保留跳财务预填入口）。
router.post('/:id/invoice', ...requireSampleInvoiceWrite, async (_req: Request, res: Response) => {
  res.status(410).json({ ok: false, error: { code: 'GONE', message: '样品开票已收归财务域单入口，请到财务模块按「样品及邮寄」场景开票（DR-054 阶段 F）' } });
});

  return router;
}
