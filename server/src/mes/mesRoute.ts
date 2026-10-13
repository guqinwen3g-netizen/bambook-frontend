
/**
 * 生产 MES API — /api/v1/mes
 *
 * 端点：
 *   ── 工位 WorkStation ──
 *   GET    /work-stations                — 工位列表（支持 type/isActive 过滤 + limit/offset 分页）
 *   GET    /work-stations/:id            — 工位详情（含最近 10 条排产）
 *   GET    /work-stations/:id/utilization — 工位利用率（?startDate=&endDate=）
 *   POST   /work-stations                — 创建工位
 *   PUT    /work-stations/:id            — 更新工位
 *   DELETE /work-stations/:id            — 软删除工位
 *
 *   ── 排产 ProductionPlan ──
 *   GET    /plans                        — 排产列表（支持 orderId/workStationId/status/processType/date 过滤 + limit/offset 分页）
 *   GET    /plans/:id                    — 排产详情（含工位 + 工时）
 *   POST   /plans                        — 创建排产单
 *   PUT    /plans/:id                    — 更新排产单（仅 Draft）
 *   DELETE /plans/:id                    — 软删除排产单（仅 Draft）
 *   POST   /plans/:id/transition         — 状态流转（?toStatus=）
 *   POST   /plans/:id/progress           — 更新生产进度（actualQuantity）
 *
 *   ── 工时 WorkHour ──
 *   GET    /work-hours                   — 工时列表（支持 planId/employeeId/date 过滤）
 *   GET    /work-hours/summary           — 工时汇总（按员工聚合）
 *   POST   /work-hours                   — 创建工时记录
 *   DELETE /work-hours/:id               — 删除工时记录
 *
 *   ── 计件规则 PieceRateRule ──
 *   GET    /piece-rate-rules             — 计件规则列表
 *   POST   /piece-rate-rules             — 创建计件规则
 *   PUT    /piece-rate-rules/:id         — 更新计件规则
 *   DELETE /piece-rate-rules/:id         — 软删除计件规则
 *
 *   ── 计件记录 PieceRateRecord ──
 *   GET    /piece-rate-records           — 计件记录列表
 *   GET    /piece-rate-records/summary   — 计件工资汇总（按员工聚合）
 *   POST   /piece-rate-records           — 创建计件记录（自动金额计算）
 *   POST   /piece-rate-records/:id/transition — 状态流转（Pending→Confirmed→Paid）
 *   DELETE /piece-rate-records/:id       — 删除计件记录（已支付不可删）
 *
 *   ── 外协 OutsourcingOrder ──
 *   GET    /outsourcing                  — 外协订单列表
 *   GET    /outsourcing/:id             — 外协订单详情
 *   POST   /outsourcing                  — 创建外协订单（含行明细 + 自动 totalAmount）
 *   PUT    /outsourcing/:id              — 更新外协订单（仅 Draft）
 *   DELETE /outsourcing/:id              — 软删除外协订单（仅 Draft）
 *   POST   /outsourcing/:id/transition   — 状态流转（Draft→Sent→Confirmed→InProduction→Received）
 *   POST   /outsourcing/:id/receive      — 外协到货验收（qualityAcceptedQty / qualityRejectedQty）
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { createCurrentWriteActor } from '../auth/currentWriteActor';
import { createPermissionService } from '../auth/permissionService';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { createOperationalReadAccess, maskOperationalRead, canReadPieceRatePay } from '../auth/operationalReadAccess';
import type { TokenPayload } from '../auth/service';
import { logger } from '../lib/logger';
import {
  createMesService,
  WorkStationInput,
  ProductionPlanInput,
  WorkHourInput,
  PieceRateRuleInput,
  PieceRateRecordInput,
  OutsourcingOrderInput,
  ProductionPlanStatus,
  PieceRateStatus,
  OutsourcingStatus,
} from './mesService';
import { createProcessChainService, ProcessChainResult } from './processChainService';
import { buildXlsx, xlsxDownloadHeaders, type XlsxSheet } from '../templates/xlsxExport';
import { statusFromError } from '../shared/bizStatus';
import { todayLocalKey, localDateKey } from '../shared/localDate';


export interface MesRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

/** 排产状态 → 台账中文标签（与 MesManager 展示口径一致） */
const PLAN_STATUS_LABEL: Record<string, string> = {
  Draft: '草稿', Confirmed: '已确认', InProgress: '进行中', Completed: '已完成', Cancelled: '已取消',
};

/** 工序类型 → 台账中文标签（ProductionPlan.processType 枚举） */
const PROCESS_TYPE_LABEL: Record<string, string> = {
  Sewing: '缝制', Cutting: '裁剪', Printing: '印花', Embroidery: '绣花', Packing: '包装', QC: '质检', Other: '其他',
};

/** BigInt 毫秒时间戳 → YYYY-MM-DD（台账展示口径） */
function tsToDate(v: unknown): string | null {
  if (v == null) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return localDateKey(new Date(n));
}

const VALID_PLAN_STATUSES: ProductionPlanStatus[] = ['Draft', 'Confirmed', 'InProgress', 'Completed', 'Cancelled'];
const VALID_PIECE_RATE_STATUSES: PieceRateStatus[] = ['Pending', 'Confirmed', 'Paid'];
const VALID_OUTSOURCING_STATUSES: OutsourcingStatus[] = ['Draft', 'Sent', 'Confirmed', 'InProduction', 'Received', 'Cancelled'];

/**
 * R678：list 端点分页查询参数解析（limit/offset 均为可选，向后兼容）。
 * 非法值（非数字）按缺省处理；收敛规则在 service 层 pageArgs（limit [1,500] / offset ≥0）。
 */
function parsePageQuery(req: Request): { limit?: number; offset?: number } {
  const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
  const rawOffset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
  return {
    limit: rawLimit !== undefined && Number.isFinite(rawLimit) ? rawLimit : undefined,
    offset: rawOffset !== undefined && Number.isFinite(rawOffset) ? rawOffset : undefined,
  };
}

export function createMesRouter(options: MesRouterOptions): Router {
  const router = Router();
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const service = createMesService(prisma);
  const chainService = createProcessChainService(prisma);
  const permissionService = createPermissionService({ prisma });
  const authenticateRead = createModuleAuthGuard({ requireAuth, apiKeys });
  const requireModuleRead = requirePermission('production:read');
  const authenticateWrite = createCurrentWriteActor(prisma);
  router.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    return authenticateWrite(req, res, next);
  });
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    authenticateRead(req, res, () => requireModuleRead(req, res, next));
  });
  const readActor = (req: Request): TokenPayload | null => (req as any).actor ?? extractActorFromRequest(req);
  const readAccess = (req: Request) => createOperationalReadAccess(prisma, readActor(req), !requireAuth && (req as any).authSource === 'dev');
  const readResult = <T,>(req: Request, result: T, kind: 'cost' | 'salary' = 'cost'): T => maskOperationalRead(result, readActor(req), kind);
  // Personal pay is the matrix's hr:salary:read + sensitive:salary dual key.
  // A production read scope or sensitive:cost cannot reveal employee pay rows.
  const requireSalaryRead = (req: Request, res: Response, next: NextFunction) => {
    if (!canReadPieceRatePay(readActor(req))) return res.status(403).json({ error: 'FORBIDDEN', message: '薪酬明细需 hr:salary:read + sensitive:salary' });
    next();
  };

  const authenticate = (req: Request, res: Response): boolean => {
    if (!requireAuth) return true;
    const apiKey = (req.query.apiKey as string) || (req.headers['x-bambook-api-key'] as string) || (req.headers['x-api-key'] as string);
    if (apiKey && apiKeys.has(apiKey)) return true;
    const actor = extractActorFromRequest(req);
    if (actor?.userId) return true;
    res.status(401).json({ error: 'authentication required' });
    return false;
  };

  // W-C 批三：写面 scope 门禁（production:write；读面与 procurement/inventory/bom 同族保留 API-Key 兼容认证门）
  // 裸 API-Key 无 actor 身份 → scope 判定失败 401（与批二-B/批三-E 新契约一致）；
  // 写主体已由严格入口从当前数据库加载；开发配置只影响读兼容，不影响写权限。
  const scopeGate = (req: Request, res: Response, scope: 'production:write'): boolean => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'authentication required' });
      return false;
    }
    if (!permissionService.hasScope(actor, scope)) {
      res.status(403).json({ error: 'FORBIDDEN', message: `缺少权限 ${scope}` });
      return false;
    }
    return true;
  };
  const requireProductionWrite = (req: Request, res: Response): boolean =>
    authenticate(req, res) && scopeGate(req, res, 'production:write');

  const actorOf = (req: Request): string => extractActorFromRequest(req)?.userId || 'system';

  // ════════════════════════════════════════
  // 工位 WorkStation
  // ════════════════════════════════════════

  router.get('/work-stations', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const { type, isActive } = req.query;
      const { items, total } = await service.listWorkStations({
        type: type as string | undefined,
        isActive: isActive === undefined ? undefined : isActive === 'true',
        ...parsePageQuery(req),
      });
      res.json({ items, total });
    } catch (e: any) {
      logger.error('[MesRoute] GET work-stations failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list work stations' });
    }
  });

  router.get('/work-stations/:id', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const item = await service.getWorkStation(req.params.id, await readAccess(req).productionPlanWhere());
      if (!item) return res.status(404).json({ error: '工位不存在' });
      res.json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] GET work-station failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to get work station' });
    }
  });

  router.get('/work-stations/:id/utilization', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const { startDate, endDate } = req.query;
      if (!startDate || !endDate) {
        return res.status(400).json({ error: '需要 startDate 与 endDate 查询参数' });
      }
      const utilization = await service.getWorkStationUtilization(
        req.params.id,
        startDate as string,
        endDate as string,
        await readAccess(req).productionPlanWhere(),
      );
      res.json({ utilization });
    } catch (e: any) {
      logger.error('[MesRoute] GET utilization failed', { error: e?.message });
      res.status(statusFromError(e, 500)).json({ error: e?.message || 'failed to get utilization' });
    }
  });

  router.post('/work-stations', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      const input = req.body as WorkStationInput;
      if (!input.code || !input.name || !input.type) {
        return res.status(400).json({ error: '缺少必填字段：code / name / type' });
      }
      const item = await service.createWorkStation(input, actorOf(req));
      onDataChange?.({ entity: 'WorkStation', action: 'create', ids: [item.id] });
      res.status(201).json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] POST work-station failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create work station' });
    }
  });

  router.put('/work-stations/:id', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      const input = req.body as Partial<WorkStationInput>;
      const item = await service.updateWorkStation(req.params.id, input, actorOf(req));
      onDataChange?.({ entity: 'WorkStation', action: 'update', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] PUT work-station failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to update work station' });
    }
  });

  router.delete('/work-stations/:id', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      await service.deleteWorkStation(req.params.id, actorOf(req));
      onDataChange?.({ entity: 'WorkStation', action: 'delete', ids: [req.params.id] });
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('[MesRoute] DELETE work-station failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to delete work station' });
    }
  });

  // ════════════════════════════════════════
  // 排产 ProductionPlan
  // ════════════════════════════════════════

  router.get('/plans', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const { orderId, workStationId, status, processType, dateFrom, dateTo } = req.query;
      const filters = {
        orderId: orderId as string | undefined,
        workStationId: workStationId as string | undefined,
        status: status as string | undefined,
        processType: processType as string | undefined,
        dateFrom: dateFrom as string | undefined,
        dateTo: dateTo as string | undefined,
        readScopeWhere: await readAccess(req).productionPlanWhere(),
      };
      if (req.query.format === 'xlsx') {
        // 台账导出为全量口径（不走分页）
        const { items } = await service.listProductionPlans(filters);
        const sheet: XlsxSheet = {
          name: '生产计划台账',
          columnLabels: ['排产单号', '关联订单', '工序', '工序顺序', '工位', '状态', '优先级', '计划数量', '实际数量', '单位', '计划开工', '计划完工', '实际开工', '实际完工', '负责人', '创建时间'],
          columns: ['planNumber', 'orderId', 'processType', 'processSeq', 'workStation', 'status', 'priority', 'plannedQuantity', 'actualQuantity', 'unit', 'plannedStartDate', 'plannedEndDate', 'actualStartDate', 'actualEndDate', 'assignedTo', 'createdAt'],
          rows: items.map((p: any) => ({
            planNumber: p.planNumber,
            orderId: p.orderId,
            processType: PROCESS_TYPE_LABEL[p.processType] ?? p.processType,
            processSeq: p.processSeq,
            workStation: p.workStation ? `${p.workStation.name}（${p.workStation.code}）` : null,
            status: PLAN_STATUS_LABEL[p.status] ?? p.status,
            priority: p.priority,
            plannedQuantity: p.plannedQuantity != null ? Number(p.plannedQuantity) : null,
            actualQuantity: p.actualQuantity != null ? Number(p.actualQuantity) : null,
            unit: p.unit,
            plannedStartDate: p.plannedStartDate,
            plannedEndDate: p.plannedEndDate,
            actualStartDate: p.actualStartDate,
            actualEndDate: p.actualEndDate,
            assignedTo: p.assignedTo,
            createdAt: tsToDate(p.createdAt),
          })),
        };
        const today = todayLocalKey();
        res.set(xlsxDownloadHeaders(`生产计划台账_${today}.xlsx`)).send(buildXlsx([sheet]));
        return;
      }
      const { items, total } = await service.listProductionPlans({ ...filters, ...parsePageQuery(req) });
      res.json({ items, total });
    } catch (e: any) {
      logger.error('[MesRoute] GET plans failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list production plans' });
    }
  });

  router.get('/plans/:id', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const item = await service.getProductionPlan(req.params.id, await readAccess(req).productionPlanWhere());
      if (!item) return res.status(404).json({ error: '排产单不存在' });
      res.json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] GET plan failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to get production plan' });
    }
  });

  router.post('/plans', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      const input = req.body as ProductionPlanInput;
      if (!input.planNumber || !input.workStationId || !input.processType || input.plannedQuantity == null || !input.unit || !input.plannedStartDate || !input.plannedEndDate) {
        return res.status(400).json({ error: '缺少必填字段：planNumber / workStationId / processType / plannedQuantity / unit / plannedStartDate / plannedEndDate' });
      }
      const item = await service.createProductionPlan(input, actorOf(req));
      onDataChange?.({ entity: 'ProductionPlan', action: 'create', ids: [item.id] });
      res.status(201).json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] POST plan failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create production plan' });
    }
  });

  router.put('/plans/:id', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      const input = req.body as Partial<ProductionPlanInput>;
      const item = await service.updateProductionPlan(req.params.id, input, actorOf(req));
      onDataChange?.({ entity: 'ProductionPlan', action: 'update', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] PUT plan failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to update production plan' });
    }
  });

  router.delete('/plans/:id', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      await service.deleteProductionPlan(req.params.id, actorOf(req));
      onDataChange?.({ entity: 'ProductionPlan', action: 'delete', ids: [req.params.id] });
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('[MesRoute] DELETE plan failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to delete production plan' });
    }
  });

  router.post('/plans/:id/transition', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      const { toStatus } = req.body as { toStatus: ProductionPlanStatus };
      if (!toStatus || !VALID_PLAN_STATUSES.includes(toStatus)) {
        return res.status(400).json({ error: `非法排产状态：${toStatus}` });
      }
      const item = await service.transitionPlanStatus(req.params.id, toStatus, actorOf(req));
      onDataChange?.({ entity: 'ProductionPlan', action: 'transition', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] POST plan transition failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to transition plan status' });
    }
  });

  router.post('/plans/:id/progress', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      const { actualQuantity } = req.body as { actualQuantity: number };
      if (actualQuantity == null || actualQuantity < 0) {
        return res.status(400).json({ error: 'actualQuantity 必须 ≥ 0' });
      }
      const item = await service.updatePlanProgress(req.params.id, actualQuantity, actorOf(req));
      onDataChange?.({ entity: 'ProductionPlan', action: 'progress', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] POST plan progress failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to update plan progress' });
    }
  });

  // ════════════════════════════════════════
  // 工时 WorkHour
  // ════════════════════════════════════════

  router.get('/work-hours', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const { productionPlanId, employeeId, dateFrom, dateTo } = req.query;
      const { items, total } = await service.listWorkHours({
        productionPlanId: productionPlanId as string | undefined,
        employeeId: employeeId as string | undefined,
        dateFrom: dateFrom as string | undefined,
        dateTo: dateTo as string | undefined,
        ...parsePageQuery(req),
        readScopeWhere: await readAccess(req).workHourWhere(),
      });
      res.json({ items, total });
    } catch (e: any) {
      logger.error('[MesRoute] GET work-hours failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list work hours' });
    }
  });

  router.get('/work-hours/summary', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const { productionPlanId, dateFrom, dateTo } = req.query;
      const summary = await service.getWorkHourSummary({
        productionPlanId: productionPlanId as string | undefined,
        dateFrom: dateFrom as string | undefined,
        dateTo: dateTo as string | undefined,
        readScopeWhere: await readAccess(req).workHourWhere(),
      });
      res.json({ summary, total: summary.length });
    } catch (e: any) {
      logger.error('[MesRoute] GET work-hours summary failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to get work hour summary' });
    }
  });

  router.post('/work-hours', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      const input = req.body as WorkHourInput;
      if (!input.productionPlanId || !input.workDate || input.hours == null) {
        return res.status(400).json({ error: '缺少必填字段：productionPlanId / workDate / hours' });
      }
      const item = await service.createWorkHour(input, actorOf(req));
      onDataChange?.({ entity: 'WorkHour', action: 'create', ids: [item.id] });
      res.status(201).json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] POST work-hour failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create work hour' });
    }
  });

  router.delete('/work-hours/:id', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      await service.deleteWorkHour(req.params.id, actorOf(req));
      onDataChange?.({ entity: 'WorkHour', action: 'delete', ids: [req.params.id] });
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('[MesRoute] DELETE work-hour failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to delete work hour' });
    }
  });

  // ════════════════════════════════════════
  // 计件规则 PieceRateRule
  // ════════════════════════════════════════

  router.get('/piece-rate-rules', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const { processType, productAssetId, isActive } = req.query;
      const { items, total } = await service.listPieceRateRules({
        processType: processType as string | undefined,
        productAssetId: productAssetId as string | undefined,
        isActive: isActive === undefined ? undefined : isActive === 'true',
        ...parsePageQuery(req),
      });
      res.json(readResult(req, { items, total }, 'salary'));
    } catch (e: any) {
      logger.error('[MesRoute] GET piece-rate-rules failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list piece rate rules' });
    }
  });

  router.post('/piece-rate-rules', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      const input = req.body as PieceRateRuleInput;
      if (!input.code || !input.name || !input.processType || !input.unit || input.ratePerUnit == null || !input.effectiveFrom) {
        return res.status(400).json({ error: '缺少必填字段：code / name / processType / unit / ratePerUnit / effectiveFrom' });
      }
      const item = await service.createPieceRateRule(input, actorOf(req));
      onDataChange?.({ entity: 'PieceRateRule', action: 'create', ids: [item.id] });
      res.status(201).json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] POST piece-rate-rule failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create piece rate rule' });
    }
  });

  router.put('/piece-rate-rules/:id', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      const input = req.body as Partial<PieceRateRuleInput>;
      const item = await service.updatePieceRateRule(req.params.id, input, actorOf(req));
      onDataChange?.({ entity: 'PieceRateRule', action: 'update', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] PUT piece-rate-rule failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to update piece rate rule' });
    }
  });

  router.delete('/piece-rate-rules/:id', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      await service.deletePieceRateRule(req.params.id, actorOf(req));
      onDataChange?.({ entity: 'PieceRateRule', action: 'delete', ids: [req.params.id] });
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('[MesRoute] DELETE piece-rate-rule failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to delete piece rate rule' });
    }
  });

  // ════════════════════════════════════════
  // 计件记录 PieceRateRecord
  // ════════════════════════════════════════

  router.get('/piece-rate-records', requireSalaryRead, async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const { pieceRateRuleId, productionPlanId, employeeId, status, dateFrom, dateTo } = req.query;
      const { items, total } = await service.listPieceRateRecords({
        pieceRateRuleId: pieceRateRuleId as string | undefined,
        productionPlanId: productionPlanId as string | undefined,
        employeeId: employeeId as string | undefined,
        status: status as string | undefined,
        dateFrom: dateFrom as string | undefined,
        dateTo: dateTo as string | undefined,
        ...parsePageQuery(req),
        readScopeWhere: await readAccess(req).pieceRateWhere(),
      });
      res.json({ items, total });
    } catch (e: any) {
      logger.error('[MesRoute] GET piece-rate-records failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list piece rate records' });
    }
  });

  router.get('/piece-rate-records/summary', requireSalaryRead, async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const { employeeId, status, dateFrom, dateTo } = req.query;
      const summary = await service.getPiceRateSummary({
        employeeId: employeeId as string | undefined,
        status: status as string | undefined,
        dateFrom: dateFrom as string | undefined,
        dateTo: dateTo as string | undefined,
        readScopeWhere: await readAccess(req).pieceRateWhere(),
      });
      res.json({ summary, total: summary.length });
    } catch (e: any) {
      logger.error('[MesRoute] GET piece-rate summary failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to get piece rate summary' });
    }
  });

  router.post('/piece-rate-records', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      const input = req.body as PieceRateRecordInput;
      if (!input.pieceRateRuleId || !input.workDate || input.quantity == null || !input.unit) {
        return res.status(400).json({ error: '缺少必填字段：pieceRateRuleId / workDate / quantity / unit' });
      }
      const item = await service.createPieceRateRecord(input, actorOf(req));
      onDataChange?.({ entity: 'PieceRateRecord', action: 'create', ids: [item.id] });
      res.status(201).json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] POST piece-rate-record failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create piece rate record' });
    }
  });

  router.post('/piece-rate-records/:id/transition', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      const { toStatus } = req.body as { toStatus: PieceRateStatus };
      if (!toStatus || !VALID_PIECE_RATE_STATUSES.includes(toStatus)) {
        return res.status(400).json({ error: `非法计件状态：${toStatus}` });
      }
      const item = await service.transitionPieceRateStatus(req.params.id, toStatus, actorOf(req));
      onDataChange?.({ entity: 'PieceRateRecord', action: 'transition', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[MesRoute] POST piece-rate transition failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to transition piece rate status' });
    }
  });

  router.delete('/piece-rate-records/:id', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    try {
      await service.deletePieceRateRecord(req.params.id, actorOf(req));
      onDataChange?.({ entity: 'PieceRateRecord', action: 'delete', ids: [req.params.id] });
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('[MesRoute] DELETE piece-rate-record failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to delete piece rate record' });
    }
  });

  // ════════════════════════════════════════
  // 外协 OutsourcingOrder
  // ════════════════════════════════════════

  router.get('/outsourcing', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const { supplierId, orderId, status, processType } = req.query;
      const { items, total } = await service.listOutsourcingOrders({
        supplierId: supplierId as string | undefined,
        orderId: orderId as string | undefined,
        status: status as string | undefined,
        processType: processType as string | undefined,
        ...parsePageQuery(req),
        readScopeWhere: await readAccess(req).orderWhere(true),
      });
      res.json(readResult(req, { items, total }));
    } catch (e: any) {
      logger.error('[MesRoute] GET outsourcing failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list outsourcing orders' });
    }
  });

  router.get('/outsourcing/:id', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const item = await service.getOutsourcingOrder(req.params.id, await readAccess(req).orderWhere(true));
      if (!item) return res.status(404).json({ error: '外协单不存在' });
      res.json(readResult(req, { item }));
    } catch (e: any) {
      logger.error('[MesRoute] GET outsourcing detail failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to get outsourcing order' });
    }
  });

  // Supplier promises and physical returns use the procurement domain's
  // native source/revision commands. Production scope alone cannot create them.
  for (const [method, url] of [
    ['post', '/outsourcing'], ['put', '/outsourcing/:id'], ['delete', '/outsourcing/:id'],
    ['post', '/outsourcing/:id/transition'], ['post', '/outsourcing/:id/receive'],
  ] as const) router[method](url, (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    res.status(409).json({ code: 'NATIVE_SUPPLIER_COMMAND_REQUIRED', error: '加工合同请从采购与加工工作区独立审批并逐行登记实际接料/回交；业务收货不代表专业 QC 合格。' });
  });

  // ════════════════════════════════════════
  // REQ2-05 面料工序级委外链 OrderProcessNode（DR-047：计划+成本核算层）
  // ════════════════════════════════════════

  /** ProcessChainResult → HTTP（结构化错误码直透） */
  const handleChainResult = <T>(
    res: Response,
    result: ProcessChainResult<T>,
    successStatus: number,
    wrap: (data: T) => Record<string, unknown>,
  ) => {
    if (!result.ok) {
      return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
    }
    res.status(successStatus).json(wrap(result.data) as any);
  };

  // 创建工序节点
  router.post('/order-processes', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    const result = await chainService.createNode((req.body ?? {}) as any);
    if (result.ok) onDataChange?.({ entity: 'OrderProcessNode', action: 'create', ids: [result.data.node.id] });
    handleChainResult(res, result, 201, (d) => ({ ok: true, node: d.node }));
  });

  // 订单工序链全景（完整链路进度 + 累计损耗 + 加工费合计）
  router.get('/order-processes', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const orderId = String(req.query.orderId ?? '');
      if (orderId && !await readAccess(req).canReadOrder(orderId)) return res.status(404).json({ error: '订单不存在或不可见' });
      const result = await chainService.listChain(orderId);
      handleChainResult(res, result, 200, (d) => readResult(req, { ok: true, ...d }));
    } catch (e: any) {
      logger.error('[MesRoute] GET order-processes failed', { error: e?.message });
      res.status(500).json({ error: 'failed to get process chain' });
    }
  });

  // 修正计划字段（planned/in_progress 限定；done 仅备注）
  router.patch('/order-processes/:id', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    const result = await chainService.updateNode(req.params.id, (req.body ?? {}) as any);
    if (result.ok) onDataChange?.({ entity: 'OrderProcessNode', action: 'update', ids: [req.params.id] });
    handleChainResult(res, result, 200, (d) => ({ ok: true, node: d.node }));
  });

  // planned → in_progress
  router.post('/order-processes/:id/start', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    const result = await chainService.startNode(req.params.id);
    if (result.ok) onDataChange?.({ entity: 'OrderProcessNode', action: 'start', ids: [req.params.id] });
    handleChainResult(res, result, 200, (d) => ({ ok: true, node: d.node }));
  });

  // 完工登记：产出量 → 损耗率 + 金额重算（按产出计费 DR-047-③）
  router.post('/order-processes/:id/complete', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    const result = await chainService.completeNode(req.params.id, (req.body ?? {}) as any);
    if (result.ok) onDataChange?.({ entity: 'OrderProcessNode', action: 'complete', ids: [req.params.id] });
    handleChainResult(res, result, 200, (d) => ({ ok: true, node: d.node, lossPct: d.lossPct }));
  });

  // 软删（仅 planned；开工/完工节点核算留痕不可删）
  router.delete('/order-processes/:id', async (req: Request, res: Response) => {
    if (!requireProductionWrite(req, res)) return;
    const result = await chainService.deleteNode(req.params.id);
    if (result.ok) onDataChange?.({ entity: 'OrderProcessNode', action: 'delete', ids: [req.params.id] });
    handleChainResult(res, result, 200, (d) => ({ ok: true, id: d.id }));
  });

  return router;
}
