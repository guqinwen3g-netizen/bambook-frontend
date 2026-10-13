
/**
 * BOM / 成本核算 API — /api/v1/bom
 *
 * 端点：
 *   GET    /                    — BOM 列表（支持 status/productAssetId/orderId/search 过滤）
 *   GET    /:id                 — BOM 详情（含物料行 + 成本估算项）
 *   POST   /                    — 创建 BOM（Draft 状态）
 *   PUT    /:id                 — 更新 BOM（仅 Draft）
 *   DELETE /:id                 — 软删除 BOM（仅 Draft）
 *   POST   /:id/confirm         — 确认 BOM（Draft → Confirmed）
 *   POST   /:id/archive         — 归档 BOM（Draft/Confirmed → Archived）
 *   POST   /:id/revise          — 修订出新版（Confirmed → 原归档 + 新 Draft v+1，parentBomId 版本链）
 *   POST   /:id/recalculate     — 重新计算成本（仅 Draft）
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { logger } from '../lib/logger';
import { buildXlsx, xlsxDownloadHeaders, type XlsxSheet } from '../templates/xlsxExport';
import { createBOMService, CreateBOMInput, UpdateBOMInput } from './bomService';
import { bomSensitiveVisibility, maskBomDetail, maskBomListItem } from './sensitiveMask';

import { resolveVisibleOrderIds, isOrderLinkedVisible } from '../auth/orderVisibility';
import { todayLocalKey, localDateKey } from '../shared/localDate';

/** BOM 状态 → 台账中文标签（与 BomManager 展示口径一致，枚举镜像 bomService BOMStatus） */
const BOM_STATUS_LABEL: Record<string, string> = {
  Draft: '草稿', Confirmed: '已确认', Archived: '已归档',
};

/** BigInt 毫秒时间戳 → YYYY-MM-DD（台账展示口径） */
function tsToDate(v: unknown): string | null {
  if (v == null) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return localDateKey(new Date(n));
}

export interface BOMRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createBOMRouter(options: BOMRouterOptions): Router {
  const router = Router();
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const service = createBOMService(prisma);

  // W-C 批三-E 族B 收口：inline authenticate 闭包退役，统一 createModuleAuthGuard（JWT 或 API-Key）。
  // 读面保持认证门（API-Key 兼容契约，auth/__tests__/moduleApiKeyHeader.test.ts 锁定）；
  // 写面 requireJwtForWrite（JWT-only，API-Key 裸写旧契约关闭）＋ bom:write scope 门
  // （_shared/rolePermissionMatrix 真源：bom:write 当前持有 = QC＋SuperAdmin 特判——
  //  SALES/SALES_MANAGER 未持 bom:write 属矩阵口径，收紧影响已上报七角色走查）。
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const requireBomWrite = requirePermission('bom:write');
  // B-5（§10.7 权限矩阵批）：读面此前零 scope，登录即可看全部 BOM 成本
  const requireBomRead = requirePermission('bom:read');

  // ── GET / — 列表（format=xlsx → 全量台账 Excel 导出） ──
  router.get('/', requireBomRead, async (req: Request, res: Response) => {
    try {
      const { status, productAssetId, orderId, quotationId, search, limit, offset } = req.query;
      const exportAll = req.query.format === 'xlsx';
      const vis = bomSensitiveVisibility(req);
      // §10.4.2：BOM 随关联订单可见（业务方 2026-09-12 定案）
      const visibleOrderIds = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      const result = await service.listBOMs({
        visibleOrderIds,
        status: status as string | undefined,
        productAssetId: productAssetId as string | undefined,
        orderId: orderId as string | undefined,
        quotationId: quotationId as string | undefined,
        search: search as string | undefined,
        limit: exportAll || !limit ? undefined : parseInt(limit as string, 10),
        offset: exportAll || !offset ? undefined : parseInt(offset as string, 10),
        ...(exportAll ? { exportAll: true } : {}),
      });
      if (exportAll) {
        const sheet: XlsxSheet = {
          name: 'BOM台账',
          columnLabels: ['BOM 编号', '描述/款式', '状态', '版本', '物料行数', '物料成本', '人工成本', '制造费用', '总成本', '币种', '创建时间', '更新时间'],
          columns: ['bomNumber', 'description', 'status', 'version', 'lineCount', 'totalMaterialCost', 'totalLaborCost', 'totalOverheadCost', 'totalCost', 'currency', 'createdAt', 'updatedAt'],
          rows: result.items.map(b => {
            const masked = maskBomListItem(b as Record<string, any>, vis);
            return {
              bomNumber: b.bomNumber,
              description: b.description,
              status: BOM_STATUS_LABEL[b.status] ?? b.status,
              version: b.version,
              lineCount: (b as any).lines?.length ?? 0,
              totalMaterialCost: masked.totalMaterialCost != null ? Number(masked.totalMaterialCost) : null,
              totalLaborCost: masked.totalLaborCost != null ? Number(masked.totalLaborCost) : null,
              totalOverheadCost: masked.totalOverheadCost != null ? Number(masked.totalOverheadCost) : null,
              totalCost: masked.totalCost != null ? Number(masked.totalCost) : null,
              currency: b.currency,
              createdAt: tsToDate(b.createdAt),
              updatedAt: tsToDate(b.updatedAt),
            };
          }),
        };
        const today = todayLocalKey();
        res.set(xlsxDownloadHeaders(`BOM台账_${today}.xlsx`)).send(buildXlsx([sheet]));
        return;
      }
      res.json({ ...result, items: result.items.map((b: any) => maskBomListItem(b, vis)) });
    } catch (e: any) {
      logger.error('[BOMRoute] GET list failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list BOMs' });
    }
  });

  // ── GET /:id — 详情 ──
  router.get('/:id', requireBomRead, async (req: Request, res: Response) => {
    try {
      const bom = await service.getBOM(req.params.id);
      if (!bom) {
        return res.status(404).json({ error: 'BOM 不存在' });
      }
      // §10.4.2：详情按「关联订单可见」把关（防猜 id 直读越权 BOM）；
      // 无关联订单的 BOM 与列表同口径（图书馆）放行。
      const visibleOrderIds = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      const bomOrderId = (bom as any).orderId;
      if (bomOrderId && !isOrderLinkedVisible(visibleOrderIds, bomOrderId)) {
        return res.status(404).json({ error: 'BOM 不存在' });
      }
      res.json({ bom: maskBomDetail(bom as Record<string, any>, bomSensitiveVisibility(req)) });
    } catch (e: any) {
      logger.error('[BOMRoute] GET detail failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to get BOM' });
    }
  });

  // ── POST / — 创建 ──
  router.post('/', requireWrite, requireBomWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as CreateBOMInput;

      if (!input.bomNumber || !input.description || !input.lines || input.lines.length === 0) {
        return res.status(400).json({ error: '缺少必填字段：bomNumber / description / lines' });
      }

      const bom = await service.createBOM(input, actor?.userId || 'system');
      onDataChange?.({ entity: 'BOM', action: 'create', ids: [bom.id] });
      res.status(201).json({ bom });
    } catch (e: any) {
      logger.error('[BOMRoute] POST create failed', { error: e?.message });
      const msg = e?.message || '';
      const status = msg.includes('已存在') ? 409
        : msg.includes('非法') || msg.includes('至少需要') ? 400
        : 500;
      res.status(status).json({ error: msg || 'failed to create BOM' });
    }
  });

  // ── PUT /:id — 更新（仅 Draft） ──
  router.put('/:id', requireWrite, requireBomWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as UpdateBOMInput;
      const bom = await service.updateBOM(req.params.id, input, actor?.userId || 'system');
      onDataChange?.({ entity: 'BOM', action: 'update', ids: [bom.id] });
      res.json({ bom });
    } catch (e: any) {
      logger.error('[BOMRoute] PUT update failed', { error: e?.message });
      const msg = e?.message || '';
      const status = msg.includes('不存在') ? 404
        : msg.includes('仅 Draft') || msg.includes('非法') ? 409
        : 400;
      res.status(status).json({ error: msg || 'failed to update BOM' });
    }
  });

  // ── DELETE /:id — 软删除（仅 Draft） ──
  router.delete('/:id', requireWrite, requireBomWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      await service.deleteBOM(req.params.id, actor?.userId || 'system');
      onDataChange?.({ entity: 'BOM', action: 'delete', ids: [req.params.id] });
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('[BOMRoute] DELETE failed', { error: e?.message });
      const msg = e?.message || '';
      const status = msg.includes('不存在') ? 404
        : msg.includes('仅 Draft') ? 409
        : 400;
      res.status(status).json({ error: msg || 'failed to delete BOM' });
    }
  });

  // ── POST /:id/confirm — 确认（Draft → Confirmed） ──
  router.post('/:id/confirm', requireWrite, requireBomWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const bom = await service.confirmBOM(req.params.id, actor?.userId || 'system');
      onDataChange?.({ entity: 'BOM', action: 'confirm', ids: [bom.id] });
      res.json({ bom });
    } catch (e: any) {
      logger.error('[BOMRoute] POST confirm failed', { error: e?.message });
      const msg = e?.message || '';
      const status = msg.includes('不存在') ? 404
        : msg.includes('非法状态转换') ? 409
        : 400;
      res.status(status).json({ error: msg || 'failed to confirm BOM' });
    }
  });

  // ── POST /:id/archive — 归档 ──
  router.post('/:id/archive', requireWrite, requireBomWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const bom = await service.archiveBOM(req.params.id, actor?.userId || 'system');
      onDataChange?.({ entity: 'BOM', action: 'archive', ids: [bom.id] });
      res.json({ bom });
    } catch (e: any) {
      logger.error('[BOMRoute] POST archive failed', { error: e?.message });
      const msg = e?.message || '';
      const status = msg.includes('不存在') ? 404
        : msg.includes('非法状态转换') ? 409
        : 400;
      res.status(status).json({ error: msg || 'failed to archive BOM' });
    }
  });

  // ── POST /:id/revise — 修订出新版（原 BOM 归档 + 新 Draft v+1，parentBomId 版本链） ──
  router.post('/:id/revise', requireWrite, requireBomWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const bom = await service.reviseBOM(req.params.id, actor?.userId || 'system');
      onDataChange?.({ entity: 'BOM', action: 'revise', ids: [bom.id] });
      res.status(201).json({ bom });
    } catch (e: any) {
      logger.error('[BOMRoute] POST revise failed', { error: e?.message });
      const msg = e?.message || '';
      const status = msg.includes('不存在') ? 404
        : msg.includes('仅 Confirmed') ? 409
        : 400;
      res.status(status).json({ error: msg || 'failed to revise BOM' });
    }
  });

  // ── POST /:id/recalculate — 重新计算成本（仅 Draft） ──
  router.post('/:id/recalculate', requireWrite, requireBomWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const bom = await service.recalculateCost(req.params.id, actor?.userId || 'system');
      onDataChange?.({ entity: 'BOM', action: 'recalculate', ids: [bom.id] });
      res.json({ bom });
    } catch (e: any) {
      logger.error('[BOMRoute] POST recalculate failed', { error: e?.message });
      const msg = e?.message || '';
      const status = msg.includes('不存在') ? 404
        : msg.includes('仅 Draft') ? 409
        : 400;
      res.status(status).json({ error: msg || 'failed to recalculate BOM cost' });
    }
  });

  return router;
}
