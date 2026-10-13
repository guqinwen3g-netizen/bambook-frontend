/**
 * A5 报表引擎 API — /api/v1/reports
 *
 * 端点：
 *   GET    /datasets                    数据集注册表（报表设计器元数据）
 *   GET    /definitions                 定义列表
 *   POST   /definitions                 创建定义（高风险角色 + 审计）
 *   GET    /definitions/:id             定义详情
 *   PATCH  /definitions/:id             更新定义（高风险角色 + 审计）
 *   DELETE /definitions/:id             软删定义（高风险角色 + 审计）
 *   POST   /preview                     临时预览（不落库，≤500 行）
 *   POST   /drill                       下钻（聚合组 → 组成员实体明细，不落库，≤200 行）
 *   POST   /definitions/:id/run         手动运行（落运行快照）
 *   GET    /runs?definitionId=          运行历史
 *   GET    /runs/:id                    运行详情
 *   GET    /runs/:id/export.csv         导出 CSV（重放快照）
 *
 * 权限（W-C 批三-E 族B 收口）：读面挂 reports:read scope 门；写/执行面
 * （definitions 增删改 / preview / drill / run / monthly-close）requireJwtForWrite
 * ＋ requirePermission('reports:write')（持有 = SALES/SALES_MANAGER/FINANCE/ADMIN
 * ＋SuperAdmin 特判；legacy requireRole(HIGH_RISK) 退役，矩阵授权 SALES 曾被其误拒）。
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission, hasScopeOnRequest } from '../auth/permissionGuard';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { listDatasets } from './datasets';
import { rowsToCsv } from './reportEngine';
import { createMonthlyCloseService } from './monthlyCloseService';
import {
  createReportDefinition,
  deleteReportDefinition,
  drillReportQuery,
  previewReportQuery,
  runReportDefinition,
  updateReportDefinition,
} from './reportDefinitionService';

export interface ReportingRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

function serialize<T>(value: T): T {
  if (typeof value === 'bigint') return Number(value) as T;
  if (Array.isArray(value)) return value.map(serialize) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serialize(v);
    return out as T;
  }
  return value;
}

const ERROR_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  UNKNOWN_DATASET: 400,
  INVALID_DIMENSIONS: 400,
  UNKNOWN_DIMENSION: 400,
  INVALID_METRICS: 400,
  INVALID_METRIC: 400,
  UNKNOWN_METRIC: 400,
  INVALID_AGG: 400,
  INVALID_FILTERS: 400,
  INVALID_FILTER: 400,
  UNKNOWN_FILTER_FIELD: 400,
  INVALID_FILTER_OP: 400,
  INVALID_FILTER_VALUE: 400,
  INVALID_SCHEDULE: 400,
  INVALID_DRILL_GROUP: 400,
  DEFINITION_INVALID: 409,
  DISABLED: 409,
  NOT_FOUND: 404,
  // REQ2-17 月末结转（DR-058）
  VALIDATION_FAILED: 400,
  NO_MONTHLY_DEFINITIONS: 404,
  INTERNAL_ERROR: 500,
};

/**
 * 权限矩阵全组合审计 P1-2：报表运行快照按数据集域加读 scope。
 * 背景：GET /runs/:id（rows 快照）与 /runs/:id/export.csv 仅 reports:read——QC 无
 * invoices:read/vouchers:read 却可经发票/凭证数据集的运行结果+CSV 导出拿到金额。
 * 解析 ReportDefinition.datasetKey → 所需读 scope（财务数据集显式收窄；orders/
 * shipments 等全员可读数据集返回 null 不额外拦截）。
 */
const DATASET_SCOPE: Record<string, PermissionScope> = {
  invoices: 'invoices:read',
  paymentVouchers: 'vouchers:read',
  vatInvoices: 'vat:read',
  outwardRemittances: 'remit:read',
  taxRefunds: 'finance:read',
  // 库存含**单位成本**（金额）→ 与财务数据集同口径收窄，不能靠 reports:read 裸读
  inventoryItems: 'inventory:read',
};

function datasetScopeOf(datasetKey: unknown): PermissionScope | null {
  if (typeof datasetKey !== 'string') return null;
  return DATASET_SCOPE[datasetKey.trim()] ?? null;
}

async function resolveRunDatasetScope(prisma: any, run: { definitionId: string }): Promise<PermissionScope | null> {
  const def = await prisma.reportDefinition.findUnique({
    where: { id: run.definitionId },
    select: { datasetKey: true },
  });
  return datasetScopeOf(def?.datasetKey);
}

/**
 * P4-1 P1-#1（2026-09-15）：出数动作（preview/drill/run）与快照读取同一道数据集域门。
 * 背景：此前只有 GET /runs/:id 与 export.csv 护了数据集域 scope，而 preview/drill/run
 * 仅靠 reports:write —— 持 reports:write 的业务员可绕开快照门，直接对 invoices/
 * paymentVouchers/vatInvoices/outwardRemittances/taxRefunds 数据集即时出数拿到金额明细
 * （同一份数据，「跑完再看」被拦、「直接预览/下钻/手动跑」不拦，属同道两制）。
 * 口径与 P1-2 完全一致：orders/shipments 等全员可读数据集返回 null，不额外拦截。
 */
function rejectDatasetScope(res: Response, scope: PermissionScope, action: string): boolean {
  res.status(403).json({
    error: { code: 'INSUFFICIENT_SCOPE', message: `${action}需要 ${scope} 权限` },
  });
  return true; // true = 已拦截，调用方应立即 return
}

function guardDatasetScope(req: Request, res: Response, scope: PermissionScope | null, action: string): boolean {
  if (!scope) return false;
  if (hasScopeOnRequest(req, scope)) return false;
  return rejectDatasetScope(res, scope, action);
}

export function createReportingRouter(options: ReportingRouterOptions): Router {
  const { prisma, requireAuth, apiKeys } = options;
  const router = Router();

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));

  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  // W-C 批三-E：reporting 域 scope 门（_shared/rolePermissionMatrix 真源）
  const requireReportsRead = requirePermission('reports:read');
  const requireReportsWrite = requirePermission('reports:write');
  const monthlyCloseService = createMonthlyCloseService(prisma);

  const sendError = (res: Response, error: { code: string; message: string }) => {
    res.status(ERROR_STATUS[error.code] ?? 500).json({ error });
  };

  // ── 数据集注册表 ──
  router.get('/datasets', requireReportsRead, (_req: Request, res: Response) => {
    res.json({ datasets: listDatasets() });
  });

  // ── 定义列表 ──
  router.get('/definitions', requireReportsRead, async (_req: Request, res: Response) => {
    try {
      const definitions = await (prisma as any).reportDefinition.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      res.json(serialize({ definitions }));
    } catch (err: any) {
      res.status(500).json({ error: { code: 'LIST_FAILED', message: err.message } });
    }
  });

  // ── 定义详情 ──
  router.get('/definitions/:id', requireReportsRead, async (req: Request, res: Response) => {
    try {
      const definition = await (prisma as any).reportDefinition.findUnique({ where: { id: req.params.id } });
      if (!definition || definition.deletedAt) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'report definition not found' } });
        return;
      }
      res.json(serialize({ definition }));
    } catch (err: any) {
      res.status(500).json({ error: { code: 'GET_FAILED', message: err.message } });
    }
  });

  // ── 创建定义 ──
  router.post('/definitions', requireWrite, requireReportsWrite, async (req: Request, res: Response) => {
    const result = await createReportDefinition({
      prisma,
      input: req.body,
      actorId: actorIdFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      sendError(res, result.error!);
      return;
    }
    res.status(201).json(serialize(result.data!.definition));
  });

  // ── 更新定义 ──
  router.patch('/definitions/:id', requireWrite, requireReportsWrite, async (req: Request, res: Response) => {
    const result = await updateReportDefinition({
      prisma,
      definitionId: req.params.id,
      input: req.body,
      actorId: actorIdFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      sendError(res, result.error!);
      return;
    }
    res.json(serialize(result.data!.definition));
  });

  // ── 软删定义 ──
  router.delete('/definitions/:id', requireWrite, requireReportsWrite, async (req: Request, res: Response) => {
    const result = await deleteReportDefinition({
      prisma,
      definitionId: req.params.id,
      actorId: actorIdFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      sendError(res, result.error!);
      return;
    }
    res.json({ ok: true });
  });

  // ── 预览（不落库；执行类端点与写面同级 reports:write 门，W-C 批三-E） ──
  router.post('/preview', requireWrite, requireReportsWrite, async (req: Request, res: Response) => {
    // P4-1 P1-#1：与 GET /runs/:id 同口径——财务数据集即时出数也需对应域读 scope
    if (guardDatasetScope(req, res, datasetScopeOf(req.body?.datasetKey), '报表预览')) return;
    const result = await previewReportQuery({ prisma, input: req.body });
    if (!result.ok) {
      sendError(res, result.error!);
      return;
    }
    res.json(serialize(result.data));
  });

  // ── 下钻（不落库；返回业务明细行，与预览同级权限） ──
  router.post('/drill', requireWrite, requireReportsWrite, async (req: Request, res: Response) => {
    // P4-1 P1-#1：下钻返回的是业务明细行（比聚合更敏感），与预览同门
    if (guardDatasetScope(req, res, datasetScopeOf(req.body?.datasetKey), '报表下钻')) return;
    const result = await drillReportQuery({ prisma, input: req.body });
    if (!result.ok) {
      sendError(res, result.error!);
      return;
    }
    res.json(serialize(result.data));
  });

  // ── 手动运行（落快照） ──
  router.post('/definitions/:id/run', requireWrite, requireReportsWrite, async (req: Request, res: Response) => {
    // P4-1 P1-#1：手动运行的落库快照与 GET /runs/:id 是同一份数据 → 门必须在「跑」之前，
    // 否则跑完仍读不到，却已产生一条含明细的快照行（留痕但不该产生）。
    const def = await (prisma as any).reportDefinition.findUnique({
      where: { id: req.params.id },
      select: { datasetKey: true },
    });
    if (guardDatasetScope(req, res, datasetScopeOf(def?.datasetKey), '报表手动运行')) return;
    const result = await runReportDefinition({
      prisma,
      definitionId: req.params.id,
      trigger: 'manual',
      actorId: actorIdFromRequest(req),
    });
    if (!result.ok) {
      sendError(res, result.error!);
      return;
    }
    res.status(201).json(serialize({ run: result.data!.run }));
  });

  // ── REQ2-17 月末批量结转（DR-058）：mc: 幂等键月末时点快照 + 相邻期对比 ──
  // 守卫与定义变更同级（结转是财务批量快照动作，reports:write scope + JWT）。
  router.post('/monthly-close', requireWrite, requireReportsWrite, async (req: Request, res: Response) => {
    const result = await monthlyCloseService.runMonthlyClose({
      periodKey: typeof req.body?.periodKey === 'string' ? req.body.periodKey : undefined,
      actorId: actorIdFromRequest(req),
      ip: req.ip,
    });
    if (!result.ok) {
      sendError(res, result.error!);
      return;
    }
    res.json(serialize(result.data));
  });

  // R678：compare 是纯读聚合（仅查 ReportDefinition/ReportRun 快照），降为 reports:read ——
  // 原挂 reports:write 导致只读角色进「月末结转」tab（MonthlyCloseSection 挂载即 loadCompare）即 403
  router.get('/monthly-close/compare', requireReportsRead, async (req: Request, res: Response) => {
    const result = await monthlyCloseService.compareMonthlyClose({
      periodKey: typeof req.query.periodKey === 'string' ? req.query.periodKey : undefined,
    });
    if (!result.ok) {
      sendError(res, result.error!);
      return;
    }
    res.json(serialize(result.data));
  });

  // ── 运行历史（R3：补 offset 分页 + total，前端「加载更多」消费） ──
  router.get('/runs', requireReportsRead, async (req: Request, res: Response) => {
    try {
      const definitionId = typeof req.query.definitionId === 'string' ? req.query.definitionId : undefined;
      const limitRaw = Number(req.query.limit);
      const take = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 50;
      const offsetRaw = Number(req.query.offset);
      const skip = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
      const where = definitionId ? { definitionId } : {};
      const [runs, total] = await Promise.all([
        (prisma as any).reportRun.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take,
          skip,
          select: {
            id: true, definitionId: true, definitionName: true, status: true, trigger: true,
            idempotencyKey: true, rowCount: true, error: true,
            startedAt: true, finishedAt: true, createdAt: true,
            // 列表不携带 rows 快照（可能很大），详情接口单独取
          },
        }),
        (prisma as any).reportRun.count({ where }),
      ]);
      res.json(serialize({ runs, total }));
    } catch (err: any) {
      res.status(500).json({ error: { code: 'LIST_FAILED', message: err.message } });
    }
  });

  // ── 运行详情（含快照行） ──
  router.get('/runs/:id', requireReportsRead, async (req: Request, res: Response) => {
    try {
      const run = await (prisma as any).reportRun.findUnique({ where: { id: req.params.id } });
      if (!run) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'report run not found' } });
        return;
      }
      // P1-2：财务数据集快照需对应域读 scope（QC 无 invoices/vouchers/vat/remit:read → 403）
      const datasetScope = await resolveRunDatasetScope(prisma, run);
      if (datasetScope && !hasScopeOnRequest(req, datasetScope)) {
        res.status(403).json({ error: { code: 'INSUFFICIENT_SCOPE', message: `报表运行快照需要 ${datasetScope} 权限` } });
        return;
      }
      res.json(serialize({ run }));
    } catch (err: any) {
      res.status(500).json({ error: { code: 'GET_FAILED', message: err.message } });
    }
  });

  // ── 导出 CSV（重放快照） ──
  router.get('/runs/:id/export.csv', requireReportsRead, async (req: Request, res: Response) => {
    try {
      const run = await (prisma as any).reportRun.findUnique({ where: { id: req.params.id } });
      if (!run) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'report run not found' } });
        return;
      }
      // P1-2：同详情——财务数据集导出需对应域读 scope
      const datasetScope = await resolveRunDatasetScope(prisma, run);
      if (datasetScope && !hasScopeOnRequest(req, datasetScope)) {
        res.status(403).json({ error: { code: 'INSUFFICIENT_SCOPE', message: `报表导出需要 ${datasetScope} 权限` } });
        return;
      }
      if (run.status !== 'Success' || !Array.isArray(run.rows) || !Array.isArray(run.columns)) {
        res.status(409).json({ error: { code: 'RUN_NOT_EXPORTABLE', message: `run status is ${run.status}; only successful runs export` } });
        return;
      }
      // 表头标签随快照落库；缺失（历史数据）时回退列键
      const columnLabels = Array.isArray(run.columnLabels) && run.columnLabels.length === run.columns.length
        ? (run.columnLabels as string[])
        : (run.columns as string[]);
      const csv = rowsToCsv(columnLabels, run.columns as string[], run.rows as Array<Record<string, unknown>>);
      const filename = `${run.definitionName || 'report'}-${run.id}.csv`.replace(/[\\/:*?"<>|]/g, '_');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.send(csv);
    } catch (err: any) {
      logger.error('[Reporting] export failed', { error: err?.message });
      res.status(500).json({ error: { code: 'EXPORT_FAILED', message: err.message } });
    }
  });

  return router;
}
