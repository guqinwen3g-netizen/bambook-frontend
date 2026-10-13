import { Router, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { ENTITY_REGISTRY_VERSION, ENTITY_TYPES } from './registry';
import { countEntities, hydrateEntities, searchEntities } from './search';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { logger } from '../lib/logger';
// ★ 未预期异常不再把原始错误（Prisma 原文/表名列名）返回前端；业务错误（code+statusCode）仍透传
import { safeRouteError } from '../shared/routeError';

export interface EntitiesRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

export function createEntitiesRouter(opts: EntitiesRouterOptions): Router {
  const router = Router();

  // Shared module-level auth guard: JWT (cookie/Bearer) or API-key header.
  // Entity graph queries (links/neighbors) expose potentially sensitive
  // cross-module relationships — guard at module boundary like other ERP modules.
  const guard = createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });
  router.use(guard);

  router.get('/registry', (_req, res) => {
    return res.json({
      ok: true,
      registryVersion: ENTITY_REGISTRY_VERSION,
      entityTypes: ENTITY_TYPES,
    });
  });

  router.post('/search', async (req, res) => {
    try {
      const request = req.body || {};
      const [items, total] = await Promise.all([
        searchEntities(opts.prisma, request),
        countEntities(opts.prisma, request),
      ]);
      const limit = Math.max(1, Math.min(Number(request.limit || 10), 30));
      const offset = Math.max(0, Math.min(Number(request.offset || 0), 4970));
      const safeTotal = Math.max(total, offset + items.length);
      return res.json({
        ok: true,
        items,
        total: safeTotal,
        limit,
        offset,
        hasMore: offset + items.length < safeTotal,
      });
    } catch (e: any) {
      logger.error('[entities/search] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'ENTITY_SEARCH_FAILED', fallbackMessage: '实体检索失败，请稍后重试' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.post('/hydrate', async (req, res) => {
    try {
      const items = await hydrateEntities(opts.prisma, req.body || {});
      return res.json({ ok: true, items });
    } catch (e: any) {
      logger.error('[entities/hydrate] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'ENTITY_HYDRATE_FAILED', fallbackMessage: '实体水合失败，请稍后重试' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // [B4 冗余收敛 2026-09-15] POST /resolve-batch 已移除：
  // 前端一律走 /search（单字段）或 SmartLinkedInput 的批量组合；Agent 直调 searchEntities service
  // （toolRuntime.ts）；该路由为 searchEntities 的薄循环包装，全仓零调用方、零测试锁定。
  // ⚠️ searchEntities / hydrateEntities service 仍被 /search、/hydrate 与 Agent 使用，不可删。

  // ---------------------------------------------------------------------------
  // GET /api/v1/entities/related-summary?type=relation.organization&id=XYZ
  //
  // 跨模块导航的计数聚合：按业务表真实关联字段 count（不用 EntityLink 图谱——
  // 图谱存在历史双命名残留，且"该客户有几笔订单"应以业务真相为准）。
  // 返回各业务域的关联数，前端渲染为详情页的"关联业务"入口卡片。
  // ---------------------------------------------------------------------------
  router.get('/related-summary', async (req, res) => {
    try {
      const type = trimOrUndef(req.query.type);
      const id = trimOrUndef(req.query.id);
      if (!type || !id) {
        return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'type 与 id 必填' });
      }
      if (type !== 'relation.organization' && type !== 'relation.contact' && type !== 'product') {
        return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'related-summary 目前仅支持 relation.organization / relation.contact / product' });
      }

      const prisma = opts.prisma as any;
      const notDeleted = { deletedAt: null };

      // ── product 维度：按产品档案（ProductAsset）聚合。
      // 精确 FK：开发/库存/BOM 直接 productAssetId；
      // 业务行（订单/报价/采购/出运）为单据快照编码，用产品编码集合匹配
      // （ProductAsset.sku ∪ FabricProfile.articleNo ∪ FabricCustomerCode.clientCode）。 ──
      if (type === 'product') {
        const asset = await prisma.productAsset.findUnique({
          where: { id, deletedAt: null },
          include: { fabricProfile: true, fabricCustomerCodes: true },
        });
        if (!asset) {
          return res.status(404).json({ error: 'NOT_FOUND', message: 'product 档案不存在' });
        }
        const codes: string[] = ([] as string[])
          .concat(asset.sku || [])
          .concat(asset.fabricProfile?.articleNo ? [asset.fabricProfile.articleNo] : [])
          .concat((asset.fabricCustomerCodes ?? []).map((c: any) => c.clientCode).filter(Boolean));
        const uniqueCodes = Array.from(new Set(codes)).filter(Boolean);
        const codeMatch = uniqueCodes.length
          ? { in: uniqueCodes }
          : undefined;

        // 出运无直接 lines 关系（snapshot FK 风格），先经 shipmentLine.productCode 收集 shipmentId 再计数
        const shipRows = codeMatch
          ? await prisma.shipmentLine.findMany({ where: { productCode: codeMatch }, select: { shipmentId: true } })
          : [];
        const shipIds = Array.from(new Set((shipRows ?? []).map((r: any) => r.shipmentId).filter(Boolean)));

        const [orders, quotations, purchaseOrders, developments, inventory, boms, shipments] =
          await Promise.all([
            codeMatch
              ? prisma.order.count({ where: { ...notDeleted, lines: { some: { OR: [
                  { itemNo: codeMatch }, { materialCode: codeMatch },
                ] } } } })
              : 0,
            codeMatch
              ? prisma.quotation.count({ where: { ...notDeleted, lines: { some: { fabricCode: codeMatch } } } })
              : 0,
            codeMatch
              ? prisma.purchaseOrder.count({ where: { ...notDeleted, lines: { some: { materialCode: codeMatch } } } })
              : 0,
            prisma.developmentCase.count({ where: { ...notDeleted, productAssetId: id } }),
            prisma.inventoryItem.count({ where: { ...notDeleted, productAssetId: id } }),
            // Prisma client 对全大写 model「BOM」暴露为 bOM（首字母小写）
            prisma.bOM.count({ where: { ...notDeleted, productAssetId: id } }),
            shipIds.length
              ? prisma.shipment.count({ where: { ...notDeleted, id: { in: shipIds } } })
              : 0,
          ]);

        return res.json({
          ok: true,
          type,
          id,
          summary: {
            orders, developments, quotations, purchaseOrders, inventory, boms, shipments,
            // 以下域对产品维度不适用，置 0 占位
            invoices: 0, paymentVouchers: 0, vatInvoices: 0, customsDeclarations: 0,
            taxRefunds: 0, lettersOfCredit: 0, fxSettlements: 0, outwardRemittances: 0,
            opportunities: 0, outsourcingOrders: 0,
          },
        });
      }

      // ── relation 维度：组织/联系人 → 各业务域计数。订单按四个角色取并集 ──
      const [orders, developments, quotations, purchaseOrders, invoices, paymentVouchers,
        vatInvoices, shipments, customsDeclarations, taxRefunds, lettersOfCredit,
        fxSettlements, outwardRemittances, opportunities, outsourcingOrders] = await Promise.all([
        prisma.order.count({ where: { ...notDeleted, OR: [
          { customerRelationId: id }, { consigneeRelationId: id }, { billToRelationId: id }, { millRelationId: id },
        ] } }),
        prisma.developmentCase.count({ where: { ...notDeleted, customerRelationId: id } }),
        prisma.quotation.count({ where: { ...notDeleted, customerRelationId: id } }),
        prisma.purchaseOrder.count({ where: { ...notDeleted, supplierRelationId: id } }),
        prisma.invoice.count({ where: { ...notDeleted, customerRelationId: id } }),
        prisma.paymentVoucher.count({ where: { ...notDeleted, customerRelationId: id } }),
        prisma.vatInvoice.count({ where: { ...notDeleted, relationId: id } }),
        prisma.shipment.count({ where: { ...notDeleted, customerRelationId: id } }),
        prisma.customsDeclaration.count({ where: { ...notDeleted, relationId: id } }),
        prisma.taxRefund.count({ where: { ...notDeleted, relationId: id } }),
        prisma.letterOfCredit.count({ where: { ...notDeleted, relationId: id } }),
        prisma.fxSettlement.count({ where: { ...notDeleted, customerRelationId: id } }),
        prisma.outwardRemittance.count({ where: { ...notDeleted, customerRelationId: id } }),
        prisma.opportunity.count({ where: { ...notDeleted, relationId: id } }),
        prisma.outsourcingOrder.count({ where: { ...notDeleted, supplierId: id } }),
      ]);

      return res.json({
        ok: true,
        type,
        id,
        summary: {
          orders, developments, quotations, purchaseOrders, invoices, paymentVouchers,
          vatInvoices, shipments, customsDeclarations, taxRefunds, lettersOfCredit,
          fxSettlements, outwardRemittances, opportunities, outsourcingOrders,
          // relation 维度不适用产品域，置 0 占位
          inventory: 0, boms: 0,
        },
      });
    } catch (e: any) {
      logger.error('[entities/related-summary] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'RELATED_SUMMARY_FAILED', fallbackMessage: '关联摘要失败，请稍后重试' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ---------------------------------------------------------------------------
  // EntityLink graph queries
  //
  // GET /api/v1/entities/links?fromType=order&fromId=ABC
  //   → all outgoing links (this entity → others)
  //
  // GET /api/v1/entities/links?toType=relation.organization&toId=XYZ
  //   → all incoming links (others → this entity)
  //
  // GET /api/v1/entities/links?type=order&id=ABC
  //   → both directions, useful for "show everything related to X"
  //
  // Optional filters: linkKind, status (default 'active'), limit (default 100).
  // Optional ?expand=1 fetches snapshot fields from EntityReference for both
  // sides so the client/Agent can display labels without secondary lookups.
  // ---------------------------------------------------------------------------
  router.get('/links', async (req, res) => {
    try {
      const fromType = trimOrUndef(req.query.fromType);
      const fromId = trimOrUndef(req.query.fromId);
      const toType = trimOrUndef(req.query.toType);
      const toId = trimOrUndef(req.query.toId);
      const anyType = trimOrUndef(req.query.type);
      const anyId = trimOrUndef(req.query.id);
      const linkKind = trimOrUndef(req.query.linkKind);
      const status = trimOrUndef(req.query.status) ?? 'active';
      const limit = Math.max(1, Math.min(Number(req.query.limit || 100), 500));
      const expand = String(req.query.expand ?? '').toLowerCase() === '1'
        || String(req.query.expand ?? '').toLowerCase() === 'true';

      // Resolve direction filter
      const orClauses: any[] = [];
      if (fromType && fromId) orClauses.push({ fromType, fromId });
      if (toType && toId) orClauses.push({ toType, toId });
      if (anyType && anyId) {
        orClauses.push({ fromType: anyType, fromId: anyId });
        orClauses.push({ toType: anyType, toId: anyId });
      }
      if (orClauses.length === 0) {
        return res.status(400).json({
          error: 'BAD_QUERY',
          message: 'provide either (fromType,fromId), (toType,toId), or (type,id)',
        });
      }

      const where: any = {
        OR: orClauses,
        status,
        deletedAt: null,
      };
      if (linkKind) where.linkKind = linkKind;

      const links = await (opts.prisma as any).entityLink.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });

      const serialized = links.map((l: any) => bigintToNumber(l));

      let snapshots: Record<string, any> = {};
      if (expand && serialized.length > 0) {
        // Collect every (type,id) pair appearing on either end and fetch the
        // most recent snapshot we have for it. EntityReference uses a per-(owner,
        // field, target) row, so we fall back to the most recent reference per
        // (type,id) pair by ordering on updatedAt.
        const targets = new Set<string>();
        for (const l of serialized) {
          targets.add(`${l.fromType}::${l.fromId}`);
          targets.add(`${l.toType}::${l.toId}`);
        }
        const refs = await (opts.prisma as any).entityReference.findMany({
          where: {
            OR: Array.from(targets).map((key) => {
              const [t, id] = key.split('::');
              return { targetType: t, targetId: id, status: 'active' };
            }),
          },
          orderBy: { updatedAt: 'desc' },
          take: targets.size * 4, // a few rows per target is enough; we dedup below
        });
        for (const r of refs) {
          const key = `${r.targetType}::${r.targetId}`;
          if (!snapshots[key]) {
            snapshots[key] = bigintToNumber(r).snapshot ?? null;
          }
        }
      }

      return res.json({
        ok: true,
        links: serialized,
        snapshots: expand ? snapshots : undefined,
        total: serialized.length,
      });
    } catch (e: any) {
      logger.error('[entities/links] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'ENTITY_LINKS_FAILED', fallbackMessage: '实体关联查询失败，请稍后重试' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/entities/neighbors?type=relation.organization&id=ORG-1
  //   → grouped by linkKind for easy "see all orders / all dev cases / all
  //     contacts attached to this customer" panels.
  // ---------------------------------------------------------------------------
  router.get('/neighbors', async (req, res) => {
    try {
      const type = trimOrUndef(req.query.type);
      const id = trimOrUndef(req.query.id);
      const status = trimOrUndef(req.query.status) ?? 'active';
      const limit = Math.max(1, Math.min(Number(req.query.limit || 200), 500));
      if (!type || !id) {
        return res.status(400).json({ error: 'BAD_QUERY', message: 'type and id are required' });
      }
      const links = await (opts.prisma as any).entityLink.findMany({
        where: {
          OR: [
            { fromType: type, fromId: id },
            { toType: type, toId: id },
          ],
          status,
          deletedAt: null,
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });

      const groups: Record<string, Array<{ direction: 'out' | 'in'; type: string; id: string; linkKind: string; updatedAt: number }>> = {};
      for (const l of links) {
        const obj = bigintToNumber(l);
        const direction: 'out' | 'in' = (obj.fromType === type && obj.fromId === id) ? 'out' : 'in';
        const otherType = direction === 'out' ? obj.toType : obj.fromType;
        const otherId = direction === 'out' ? obj.toId : obj.fromId;
        const bucket = obj.linkKind || 'related';
        if (!groups[bucket]) groups[bucket] = [];
        groups[bucket].push({
          direction,
          type: otherType,
          id: otherId,
          linkKind: obj.linkKind,
          updatedAt: obj.updatedAt,
        });
      }

      return res.json({ ok: true, type, id, neighbors: groups, total: links.length });
    } catch (e: any) {
      logger.error('[entities/neighbors] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'ENTITY_NEIGHBORS_FAILED', fallbackMessage: '邻接实体查询失败，请稍后重试' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function trimOrUndef(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function bigintToNumber<T extends Record<string, any>>(row: T): T {
  const out: any = { ...row };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
  }
  return out;
}
