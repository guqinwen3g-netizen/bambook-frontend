/**
 * reconciliationRoute.ts — W-B 波次 P2-6 客户四单对账工作台 API
 * 挂载点：/api/v1/reconciliation（server/src/index.ts）
 *
 * 端点：
 *   GET  /orders/:orderId          — 单订单四单勾稽（订单↔出运↔开票↔收款）
 *   GET  /customers/:customerId    — 客户维度批量对账（该客户全部订单 + 汇总）
 *   GET  /discrepancies            — 全量差异清单（severity 排序，分页/筛选）
 *   GET  /acks                     — 客户对账回执列表（H16-② 配套：客户能回签，财务要能看到）
 *   POST /orders/:orderId/refresh  — 强制重算（当前无缓存，直接重跑引擎；预留缓存失效钩子）
 *
 * 全部只读：对账引擎不写库；refresh 与 GET 同口径（幂等），POST 仅为语义化重算入口。
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { reconcileOrder, reconcileCustomer, listAllDiscrepancies, DiscrepancySeverity } from './reconciliationService';
import { reconcileReceiptFob } from './receiptFobReconciliationService';
import { listReconciliationAcks } from '../customer/reconciliationAckService';
import { extractActorFromRequest } from '../auth/middleware';
import { withFinanceReadProjection } from './financeReadProjection';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';

export interface ReconciliationRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

const VALID_SEVERITIES = new Set(['critical', 'warning', 'info']);

export function createReconciliationRouter(options: ReconciliationRouterOptions): Router {
  const { prisma, requireAuth, apiKeys } = options;
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  // 权限矩阵全组合审计 P2：四单对账为纯财务口径数据（订单↔出运↔开票↔收款差异），
  // 此前仅 module 认证门——2026-09-03 起挂 invoices:read ∨ vouchers:read（QC 两 scope 均无
  // → 403；finance:read 全员持有挡不住，故不用它）。与财务视图（发票/凭证）可见性同口径。
  const requireFinanceRead = requirePermission(['invoices:read', 'vouchers:read']);

  // GET /api/v1/reconciliation/orders/:orderId — 单订单对账
  router.get('/orders/:orderId', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const result = await withFinanceReadProjection(prisma, extractActorFromRequest(req), db => reconcileOrder(db, req.params.orderId), {orderId: req.params.orderId});
      if (!result) {
        res.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: `订单 ${req.params.orderId} 不存在` } });
        return;
      }
      res.json(result);
    } catch (err: any) {
      const failure = safeRouteError(err, {fallbackCode: 'RECONCILE_FAILED', fallbackMessage: '当前财务对账暂时无法读取。'});
      res.status(failure.status).json({error: {code: failure.code, message: failure.message}});
    }
  });

  // POST /api/v1/reconciliation/orders/:orderId/refresh — 强制重算（预留缓存失效钩子；当前与 GET 同口径，幂等）
  router.post('/orders/:orderId/refresh', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const result = await withFinanceReadProjection(prisma, extractActorFromRequest(req), db => reconcileOrder(db, req.params.orderId), {orderId: req.params.orderId});
      if (!result) {
        res.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: `订单 ${req.params.orderId} 不存在` } });
        return;
      }
      res.json({ refreshed: true, result });
    } catch (err: any) {
      const failure = safeRouteError(err, {fallbackCode: 'RECONCILE_FAILED', fallbackMessage: '当前财务对账暂时无法读取。'});
      res.status(failure.status).json({error: {code: failure.code, message: failure.message}});
    }
  });

  // GET /api/v1/reconciliation/orders/:orderId/receipt-fob — T7-③ 收汇 ↔ 报关 FOB 勾稽
  // 口径 D：容差 max(5%×FOB, 500)，超差**只预警不阻断**；CIF 单先剥运费保费（币种不一致不换算）。
  router.get('/orders/:orderId/receipt-fob', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const result = await withFinanceReadProjection(prisma, extractActorFromRequest(req), db => reconcileReceiptFob(db, req.params.orderId), {orderId: req.params.orderId});
      if (!result) {
        res.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: `订单 ${req.params.orderId} 不存在` } });
        return;
      }
      res.json(result);
    } catch (err: any) {
      logger.error('[ReconciliationRoute] receipt-fob failed', { error: err?.message, orderId: req.params.orderId });
      const failure = safeRouteError(err, {fallbackCode: 'RECEIPT_FOB_FAILED', fallbackMessage: '当前财务对账暂时无法读取。'});
      res.status(failure.status).json({error: {code: failure.code, message: failure.message}});
    }
  });

  // GET /api/v1/reconciliation/customers/:customerId — 客户维度批量对账
  router.get('/customers/:customerId', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const { summary, orders } = await withFinanceReadProjection(prisma, extractActorFromRequest(req), db => reconcileCustomer(db, req.params.customerId), {relationId: req.params.customerId});
      res.json({ summary, orders });
    } catch (err: any) {
      const failure = safeRouteError(err, {fallbackCode: 'RECONCILE_FAILED', fallbackMessage: '当前财务对账暂时无法读取。'});
      res.status(failure.status).json({error: {code: failure.code, message: failure.message}});
    }
  });

  // GET /api/v1/reconciliation/acks — 客户对账回执列表（?relationId=&status=&periodFrom=&periodTo=&limit=&offset=）
  // H16-② 配套：客户门户能回签，内部侧此前**零入口**（回执落库+发通知后就没人看得到）。
  router.get('/acks', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const r = await withFinanceReadProjection(prisma, extractActorFromRequest(req), db => listReconciliationAcks(db, {
        relationId: req.query.relationId ? String(req.query.relationId) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        periodFrom: req.query.periodFrom ? String(req.query.periodFrom) : undefined,
        periodTo: req.query.periodTo ? String(req.query.periodTo) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      }));
      if (!r.ok) {
        res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
        return;
      }
      res.json(r.data);
    } catch (err: any) {
      logger.error('[ReconciliationRoute] acks failed', { error: err?.message });
      const failure = safeRouteError(err, {fallbackCode: 'ACK_LIST_FAILED', fallbackMessage: '当前财务对账暂时无法读取。'});
      res.status(failure.status).json({error: {code: failure.code, message: failure.message}});
    }
  });

  // GET /api/v1/reconciliation/discrepancies — 全量差异清单（?severity=&type=&customerRelationId=&page=&pageSize=）
  router.get('/discrepancies', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const severityRaw = req.query.severity ? String(req.query.severity) : undefined;
      if (severityRaw && !VALID_SEVERITIES.has(severityRaw)) {
        res.status(400).json({ error: { code: 'INVALID_SEVERITY', message: `severity 必须是: critical | warning | info` } });
        return;
      }
      const result = await withFinanceReadProjection(prisma, extractActorFromRequest(req), db => listAllDiscrepancies(db, {
        severity: severityRaw as DiscrepancySeverity | undefined,
        type: req.query.type ? String(req.query.type) : undefined,
        customerRelationId: req.query.customerRelationId ? String(req.query.customerRelationId) : undefined,
        page: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      }));
      res.json(result);
    } catch (err: any) {
      const failure = safeRouteError(err, {fallbackCode: 'RECONCILE_FAILED', fallbackMessage: '当前财务对账暂时无法读取。'});
      res.status(failure.status).json({error: {code: failure.code, message: failure.message}});
    }
  });

  return router;
}
