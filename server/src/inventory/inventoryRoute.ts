
import { registerInventoryOwner } from './inventoryOwnerRegistrationService';
import { manualStockCommand } from './manualStockCommandService';
import {createInventoryTransfer,transitionInventoryTransfer} from './inventoryTransferService';
import { resolveOrderId } from '../orders/orderIdentity';
import { buildOrderListScopeWhere } from '../orders/orderService';
/**
 * 库存管理 API — /api/v1/inventory
 *
 * 端点：
 *   ── 仓库 ──
 *   GET    /warehouses                — 仓库列表
 *   POST   /warehouses                — 创建仓库
 *   PUT    /warehouses/:id            — 更新仓库
 *   DELETE /warehouses/:id            — 软删除仓库（须无非零库存）
 *
 *   ── 库存物料 ──
 *   GET    /items                     — 库存物料列表（支持 warehouse/category/search/lowStock 过滤）
 *   GET    /items/:id                 — 库存物料详情（含最近 50 条流水）
 *   POST   /items                     — 创建库存物料（含初始入库流水）
 *   PUT    /items/:id                 — 更新库存物料（元数据，不含数量）
 *   DELETE /items/:id                 — 软删除库存物料（须 quantity=0）
 *
 *   ── 库存变动 ──
 *   GET    /movements                 — 库存变动流水（支持 itemId/warehouse/type/date 过滤）
 *   POST   /movements                — 创建库存变动（Inbound/Outbound/Transfer/Adjustment/Lock/Unlock）
 *
 *   ── 预警 ──
 *   GET    /alerts/low-stock          — 低库存预警列表
 *
 *   ── 货权（D7-②）──
 *   PATCH  /items/:id/ownership       — 设置/变更货权（inventory:write + JWT）
 *   GET    /summary-by-ownership      — 按货权汇总存货（inventory:read；含金额）
 *
 *   ── ★ D1 缸号配料（只读）──
 *   GET    /dye-lot-stock              — 库存按缸号归集 + 色差风险（inventory:read）
 *
 *   ── ★ C4 订单归属 / 备货（无单先产）──
 *   POST   /items/:id/ownership-change — 归属变更（mark_stock_prep|attribute|reassign|release；inventory:write + JWT）
 *   GET    /items/:id/ownership-history— 归属变更留痕（append-only）
 *   GET    /by-order/:orderId          — 某订单当前占用的库存
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { createOperationalReadAccess, maskOperationalRead } from '../auth/operationalReadAccess';
import type { TokenPayload } from '../auth/service';
import { logger } from '../lib/logger';
import { buildXlsx, xlsxDownloadHeaders, type XlsxSheet } from '../templates/xlsxExport';
import {
  createInventoryService,
  WarehouseInput,
  InventoryItemInput,
  StockMovementInput,
  VALID_MOVEMENT_TYPES,
} from './inventoryService';
import { createInventoryOwnershipService } from './inventoryOwnershipService';
// ★ C4：库存订单归属 / 备货（含挪货留痕）
import { applyOwnershipChange, listOwnershipHistory, listItemsByOrder } from './stockOwnershipService';
// ★ D1：库存缸号（dye lot）配料核对（只读，零 migration）
import { getDyeLotStock } from './dyeLotStockService';
import { todayLocalKey } from '../shared/localDate';


/** 库存类别 → 台账中文标签 */
const INVENTORY_CATEGORY_LABEL: Record<string, string> = {
  Fabric: '面料', Trimmings: '辅料', Accessories: '配件', Garment: '成衣', Other: '其他',
};

export interface InventoryRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createInventoryRouter(options: InventoryRouterOptions): Router {
  const router = Router();
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const service = createInventoryService(prisma);

  // W-C 批三-E 族B 收口：inline authenticate 闭包退役，统一 createModuleAuthGuard（JWT 或 API-Key）。
  // Read scope follows actual View.Inventory (orders:read); API keys still need
  // their bound principal. The existing inventory:read report gates stay below.
  // 写面 requireJwtForWrite（JWT-only，API-Key 裸写旧契约关闭）＋ inventory:write scope 门
  // （持有 = LOGISTICS 专属＋SuperAdmin 特判，GAP-R5 仓储归后勤，_shared/rolePermissionMatrix 真源）。
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireModuleRead = requirePermission('orders:read');
  router.use((req, res, next) => req.method === 'GET' || req.method === 'HEAD' ? requireModuleRead(req, res, next) : next());
  const readActor = (req: Request): TokenPayload | null => (req as any).actor ?? extractActorFromRequest(req);
  const readAccess = (req: Request) => createOperationalReadAccess(prisma, readActor(req), !requireAuth && (req as any).authSource === 'dev');
  const readResult = <T,>(req: Request, result: T): T => maskOperationalRead(result, readActor(req));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const requireInventoryWrite = requirePermission('inventory:write');
  // 2026-09-16 补：汇总含**单位成本推导的金额**，与报表引擎 inventoryItems 数据集同口径
  // （该数据集已收窄到 inventory:read）。没有这道门，持 reports:write 而无 inventory:read
  // 的角色在报表侧被 403，却能直接 GET 本端点读到库存成本 —— 门控被绕过。
  const requireInventoryRead = requirePermission('inventory:read');

  // ════════════════════════════════════════
  // 仓库
  // ════════════════════════════════════════

  router.get('/transfers', async (req,res)=>{
    try {const scope=await readAccess(req).orderWhere(true);const tasks=await prisma.inventoryTransfer.findMany({where:{...(typeof req.query.id==='string'?{id:req.query.id}:{}),sourceItem:{AND:[scope],deletedAt:null}},include:{sourceItem:{select:{id:true,description:true,batchNumber:true,warehouse:{select:{name:true}}}},targetWarehouse:{select:{id:true,name:true}}},orderBy:{createdAt:'desc'},take:100});res.json({tasks});}catch(e:any){res.status(500).json({error:e.message});}
  });
  router.post('/transfers',requireWrite,requireInventoryWrite,async(req,res)=>{
    try {if(!await readAccess(req).canReadInventoryItem(req.body.sourceItemId))return res.status(404).json({error:'来源库存不存在或不可操作'});res.status(201).json(readResult(req,{task:await createInventoryTransfer(prisma,req.body,readActor(req)?.userId||'system')}));}catch(e:any){res.status(400).json({error:e.message});}
  });
  router.post('/transfers/:id/:action',requireWrite,requireInventoryWrite,async(req,res)=>{
    try {const task=await prisma.inventoryTransfer.findUnique({where:{id:req.params.id},select:{sourceItemId:true}});if(!task||!await readAccess(req).canReadInventoryItem(task.sourceItemId))return res.status(404).json({error:'调拨任务不存在或不可操作'});res.json(readResult(req,{task:await transitionInventoryTransfer(prisma,req.params.id,req.params.action,req.body,readActor(req)?.userId||'system')}));}catch(e:any){res.status(409).json({error:e.message});}
  });

  router.get('/warehouse-personnel', async (_req, res) => {
    try { res.json({users:await prisma.userAccount.findMany({where:{deletedAt:null,status:'active'},select:{id:true,displayName:true},orderBy:{displayName:'asc'}})}); }
    catch { res.status(500).json({error:'人员目录加载失败'}); }
  });

  router.get('/warehouses', async (req: Request, res: Response) => {
    try {
      const includeInactive = req.query.includeInactive === 'true';
      const warehouses = await service.listWarehouses(includeInactive);
      res.json({ warehouses });
    } catch (e: any) {
      logger.error('[InventoryRoute] GET warehouses failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list warehouses' });
    }
  });

  router.post('/warehouses', requireWrite, requireInventoryWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as WarehouseInput;
      if (!input.code || !input.name || !input.type) {
        return res.status(400).json({ error: '缺少必填字段：code / name / type' });
      }
      const warehouse = await service.createWarehouse(input, actor?.userId || 'system');
      onDataChange?.({ entity: 'Warehouse', action: 'create', ids: [warehouse.id] });
      res.status(201).json({ warehouse });
    } catch (e: any) {
      logger.error('[InventoryRoute] POST warehouse failed', { error: e?.message });
      const status = e?.message?.includes('已存在') ? 409 : 400;
      res.status(status).json({ error: e?.message || 'failed to create warehouse' });
    }
  });

  router.put('/warehouses/:id', requireWrite, requireInventoryWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as Partial<WarehouseInput>;
      const warehouse = await service.updateWarehouse(req.params.id, input, actor?.userId || 'system');
      onDataChange?.({ entity: 'Warehouse', action: 'update', ids: [warehouse.id] });
      res.json({ warehouse });
    } catch (e: any) {
      logger.error('[InventoryRoute] PUT warehouse failed', { error: e?.message });
      const status = e?.message?.includes('不存在') ? 404 : 400;
      res.status(status).json({ error: e?.message || 'failed to update warehouse' });
    }
  });

  router.delete('/warehouses/:id', requireWrite, requireInventoryWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      await service.deleteWarehouse(req.params.id, actor?.userId || 'system');
      onDataChange?.({ entity: 'Warehouse', action: 'delete', ids: [req.params.id] });
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('[InventoryRoute] DELETE warehouse failed', { error: e?.message });
      const status = e?.message?.includes('不存在') ? 404 : e?.message?.includes('不可删除') ? 409 : 400;
      res.status(status).json({ error: e?.message || 'failed to delete warehouse' });
    }
  });

  // ════════════════════════════════════════
  // 库存物料
  // ════════════════════════════════════════

  router.get('/items', async (req: Request, res: Response) => {
    try {
      const { warehouseId, category, materialCode, search, lowStockOnly, limit, offset } = req.query;
      const exportAll = req.query.format === 'xlsx';
      const result = await service.listInventoryItems({
        orderId:typeof req.query.orderId==='string'?req.query.orderId:undefined,
        productAssetId:typeof req.query.productAssetId==='string'?req.query.productAssetId:undefined,
        warehouseId: warehouseId as string | undefined,
        category: category as string | undefined,
        materialCode: materialCode as string | undefined,
        search: search as string | undefined,
        lowStockOnly: lowStockOnly === 'true',
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
        ...(exportAll ? { exportAll: true } : {}),
        readScopeWhere: await readAccess(req).orderWhere(true),
      });
      const visibleResult = readResult(req, result);
      if (exportAll) {
        const sheet: XlsxSheet = {
          name: '库存台账',
          columnLabels: ['物料编码', '品名描述', '类别', '规格', '批次号', '库位', '仓库', '库存数量', '锁定数量', '可用数量', '单位', '单位成本', '币种', '最低库存', '最后入库', '最后出库', '备注'],
          columns: ['materialCode', 'description', 'category', 'specification', 'batchNumber', 'locationCode', 'warehouseName', 'quantity', 'lockedQuantity', 'available', 'unit', 'unitCost', 'currency', 'minStock', 'lastInDate', 'lastOutDate', 'notes'],
          rows: visibleResult.items.map((it: any) => ({
            materialCode: it.materialCode ?? '',
            description: it.description,
            category: it.category ? INVENTORY_CATEGORY_LABEL[it.category] ?? it.category : '',
            specification: it.specification ?? '',
            batchNumber: it.batchNumber ?? '',
            locationCode: it.locationCode ?? '',
            warehouseName: it.warehouse?.name ?? '',
            quantity: Number(it.quantity),
            lockedQuantity: Number(it.lockedQuantity),
            available: Number(it.quantity) - Number(it.lockedQuantity),
            unit: it.unit,
            unitCost: it.unitCost != null ? Number(it.unitCost) : null,
            currency: it.currency,
            minStock: it.minStock != null ? Number(it.minStock) : null,
            lastInDate: it.lastInDate ?? '',
            lastOutDate: it.lastOutDate ?? '',
            notes: it.notes ?? '',
          })),
        };
        const today = todayLocalKey();
        res.set(xlsxDownloadHeaders(`库存台账_${today}.xlsx`)).send(buildXlsx([sheet]));
        return;
      }
      res.json(visibleResult);
    } catch (e: any) {
      logger.error('[InventoryRoute] GET items failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list inventory items' });
    }
  });

  router.get('/items/:id', async (req: Request, res: Response) => {
    try {
      const access = readAccess(req);
      const item = await service.getInventoryItem(req.params.id, await access.orderWhere(true), await access.stockMovementWhere());
      if (!item) return res.status(404).json({ error: '库存项不存在' });
      const nativeReceipt=await prisma.productionStockReceipt.findFirst({where:{inventoryItemId:item.id},select:{id:true}});
      const sourceLinks:Array<{type:string;id:string;label:string}>=[];
      for(const movement of item.movements||[]){
        if(movement.referenceType==='MaterialReceipt'&&movement.referenceId){const receipt=await prisma.materialReceipt.findUnique({where:{id:movement.referenceId},select:{purchaseOrderId:true,receiptNumber:true}});if(receipt)sourceLinks.push({type:'PurchaseOrder',id:receipt.purchaseOrderId,label:receipt.receiptNumber});}
        if(movement.referenceType==='Shipment'&&movement.referenceId)sourceLinks.push({type:'Shipment',id:movement.referenceId,label:'出运记录'});
      }
      res.json(readResult(req, { item:{...item,sourceLinks,nativeProductionReceiptId:nativeReceipt?.id} }));
    } catch (e: any) {
      logger.error('[InventoryRoute] GET item failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to get inventory item' });
    }
  });

  router.post('/items', requireWrite, requireInventoryWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as InventoryItemInput;
      if (!input.warehouseId || !input.description || !input.unit) {
        return res.status(400).json({ error: '缺少必填字段：warehouseId / description / unit' });
      }
      if (input.quantity == null) input.quantity = 0;
      const item = input.requestKey ? await manualStockCommand(prisma,'receipt',input,actor?.userId || 'system') : await service.createInventoryItem(input, actor?.userId || 'system');
      onDataChange?.({ entity: 'InventoryItem', action: 'create', ids: [item.id] });
      res.status(201).json({ item });
    } catch (e: any) {
      logger.error('[InventoryRoute] POST item failed', { error: e?.message });
      const status = e?.message?.includes('不存在') ? 404 : e?.message?.includes('已停用') ? 409 : 400;
      res.status(status).json({ error: e?.message || 'failed to create inventory item' });
    }
  });

  router.put('/items/:id', requireWrite, requireInventoryWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as Partial<InventoryItemInput>;
      const item = await service.updateInventoryItem(req.params.id, input, actor?.userId || 'system');
      onDataChange?.({ entity: 'InventoryItem', action: 'update', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[InventoryRoute] PUT item failed', { error: e?.message });
      const status = e?.message?.includes('不存在') ? 404 : 400;
      res.status(status).json({ error: e?.message || 'failed to update inventory item' });
    }
  });

  router.delete('/items/:id', requireWrite, requireInventoryWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      await service.deleteInventoryItem(req.params.id, actor?.userId || 'system');
      onDataChange?.({ entity: 'InventoryItem', action: 'delete', ids: [req.params.id] });
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('[InventoryRoute] DELETE item failed', { error: e?.message });
      const status = e?.message?.includes('不存在') ? 404 : e?.message?.includes('不可删除') ? 409 : 400;
      res.status(status).json({ error: e?.message || 'failed to delete inventory item' });
    }
  });

  // ════════════════════════════════════════
  // 库存变动
  // ════════════════════════════════════════

  // ════════════════════════════════════════
  // D7-② 货权标记 + 按货权汇总（2026-09-16）
  // 拍板：资产/存货报表**按货权汇总**，不按物理位置 —— 货权已转移的不得计入我方存货。
  // 货权标记在**库存项**（不是仓库）：同一个第三方仓里可能同时存在我方货权与已转移的货。
  // ════════════════════════════════════════
  const ownershipService = createInventoryOwnershipService(prisma);

  // PATCH /items/:id/ownership — 设置/变更货权（Owned=我方货权 | Transferred=货权已转移）
  router.post('/items/:id/owner-registration',requireWrite,requireInventoryWrite,async(req,res)=>{
    try{if(!await readAccess(req).canReadInventoryItem(req.params.id))return res.status(404).json({error:'库存不存在或不可操作'});const item=await registerInventoryOwner(prisma,req.params.id,req.body,readActor(req)?.userId||'system');onDataChange?.({entity:'InventoryItem',action:'ownership',ids:[item.id]});res.json(readResult(req,{item}));}catch(e:any){res.status(409).json({error:e.message});}
  });
  router.patch('/items/:id/ownership', requireWrite, requireInventoryWrite, async (req: Request, res: Response) => {
    try {
      if(!await readAccess(req).canReadInventoryItem(req.params.id))return res.status(404).json({error:'库存不存在或不可操作'});
      const r = await ownershipService.setOwnership({
        itemId: req.params.id,
        ownership: (req.body || {}).ownership,
        note: (req.body || {}).note ?? null,
        actorId: (req as any).actor?.userId || 'api',
        ip: req.ip || null,
      });
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      onDataChange?.({ entity: 'inventory', action: 'ownership', ids: [req.params.id] });
      res.json({ ok: true, ...(r.data as any) });
    } catch (err: any) {
      logger.error('[InventoryRoute] set ownership failed', { error: err?.message });
      res.status(500).json({ error: { code: 'SET_OWNERSHIP_FAILED', message: err.message } });
    }
  });

  /**
   * ★ C4（2026-09-18）POST /items/:id/ownership-change — 库存「订单归属」变更
   *
   * body: { action: 'mark_stock_prep'|'attribute'|'reassign'|'release', targetOrderId?, reason }
   *
   * 为什么要一个端点承载四个动作：四个动作的**前置条件互斥**（见 stockOwnershipService 头注释），
   * 用 action 显式表达意图 → 留痕能区分「认领」与「挪货」；拆四个端点会让「谁在什么前置下可用」
   * 分散到四处，正是本仓反复踩的「同一判据散落多份」。
   *
   * 权限：inventory:write + JWT（与货权变更同档 —— 都是改「这批货的归属事实」）。
   */
  router.post('/items/:id/ownership-change', requireWrite, requireInventoryWrite, async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      if(['reassign','release'].includes(body.action)&&await prisma.productionStockReceipt.findFirst({where:{inventoryItemId:req.params.id},select:{id:true}}))return res.status(409).json({error:'生产收货库存归属以原订单与批次凭据为准，请从原订单核对业务变更'});
      const access=readAccess(req);if(!await access.canReadInventoryItem(req.params.id))return res.status(404).json({error:'库存不存在或不可操作'});
      const targetOrderId = body.targetOrderId ? await resolveOrderId(prisma, String(body.targetOrderId),
        await buildOrderListScopeWhere(prisma, readActor(req), { fresh: true })) : null;
      if(body.targetOrderId && (!targetOrderId || !await access.canReadOrder(targetOrderId))) return res.status(404).json({error:'目标订单不存在或不可操作'});
      const r = await applyOwnershipChange(prisma, {
        itemId: req.params.id,
        action: body.action,
        targetOrderId,
        reason: String(body.reason ?? ''),
      }, (req as any).actor?.userId || 'api');
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      onDataChange?.({ entity: 'inventory', action: 'ownership_change', ids: [req.params.id] });
      res.json({ ok: true, ...(r.data as any) });
    } catch (err: any) {
      logger.error('[InventoryRoute] ownership-change failed', { error: err?.message });
      if (err?.code === 'AMBIGUOUS_ORDER_REFERENCE') return res.status(409).json({ error: { code: err.code, message: err.message } });
      res.status(500).json({ error: { code: 'OWNERSHIP_CHANGE_FAILED', message: err.message } });
    }
  });

  /** ★ C4 GET /items/:id/ownership-history — 归属变更留痕（append-only，倒序） */
  router.get('/items/:id/ownership-history', requireInventoryRead, async (req: Request, res: Response) => {
    try {
      const access = readAccess(req);
      if (!await access.canReadInventoryItem(req.params.id)) return res.status(404).json({ error: '库存项不存在或不可见' });
      const r = await listOwnershipHistory(prisma, req.params.id, Number(req.query.limit ?? 50), await access.ownershipHistoryWhere());
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      res.json(readResult(req, r.data));
    } catch (err: any) {
      logger.error('[InventoryRoute] ownership-history failed', { error: err?.message });
      res.status(500).json({ error: { code: 'HISTORY_FAILED', message: err.message } });
    }
  });

  /** ★ C4 GET /by-order/:orderId — 某订单当前占用的库存（订单成本/备货核对） */
  router.get('/by-order/:orderId', requireInventoryRead, async (req: Request, res: Response) => {
    try {
      if (!await readAccess(req).canReadOrder(req.params.orderId)) return res.status(404).json({ error: '订单不存在或不可见' });
      const r = await listItemsByOrder(prisma, req.params.orderId);
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      res.json(readResult(req, r.data));
    } catch (err: any) {
      logger.error('[InventoryRoute] by-order failed', { error: err?.message });
      res.status(500).json({ error: { code: 'LIST_FAILED', message: err.message } });
    }
  });

  /**
   * ★ D1（2026-09-18）GET /dye-lot-stock — 库存按**缸号**归集 + 色差风险（只读，零 migration）
   *
   * 为什么需要：面料行业**同缸号才能同批裁**（避免缸差），而库存层此前没有缸号语义 ——
   * 缸号/色差评级只存在于缸差登记（`SampleColorBatch`），与库存零交集 ⇒
   * 业务员无法回答「这批货是哪个缸的、色差几级、能不能用来做这一单」。
   *
   * 口径：把库存 `batchNumber` 与已登记 `dyeLotNo` 对撞 —— 能对上的带出评级；
   *      对不上的标 `unknown`（**不是** low：「不知道」不能显示成「没问题」）。
   */
  router.get('/dye-lot-stock', requireInventoryRead, async (req: Request, res: Response) => {
    try {
      const access = readAccess(req);
      const result = await getDyeLotStock(prisma, {
        category: req.query.category ? String(req.query.category) : undefined,
        warehouseId: req.query.warehouseId ? String(req.query.warehouseId) : undefined,
        readScopeWhere: await access.orderWhere(true),
        colorBatchScopeWhere: await access.colorBatchWhere(),
      });
      res.json(result);
    } catch (err: any) {
      logger.error('[InventoryRoute] dye-lot-stock failed', { error: err?.message });
      res.status(500).json({ error: { code: 'DYE_LOT_FAILED', message: err.message } });
    }
  });

  // GET /summary-by-ownership — 按货权汇总存货（报表口径）
  // 数量按 unit 分组、金额按 currency 分组 —— **跨单位/跨币种不相加**（T7-① 同款纪律）
  router.get('/summary-by-ownership', requireInventoryRead, async (req: Request, res: Response) => {
    try {
      const r = await ownershipService.summarizeByOwnership({
        warehouseId: req.query.warehouseId ? String(req.query.warehouseId) : null,
        readScopeWhere: await readAccess(req).orderWhere(true),
      });
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      res.json(readResult(req, r.data));
    } catch (err: any) {
      logger.error('[InventoryRoute] summarize by ownership failed', { error: err?.message });
      res.status(500).json({ error: { code: 'SUMMARIZE_FAILED', message: err.message } });
    }
  });

  router.get('/movements', async (req: Request, res: Response) => {
    try {
      const { itemId, warehouseId, type, dateFrom, dateTo, limit, offset } = req.query;
      const result = await service.listStockMovements({
        itemId: itemId as string | undefined,
        warehouseId: warehouseId as string | undefined,
        type: type as string | undefined,
        dateFrom: dateFrom as string | undefined,
        dateTo: dateTo as string | undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
        readScopeWhere: await readAccess(req).stockMovementWhere(),
      });
      res.json(readResult(req, result));
    } catch (e: any) {
      logger.error('[InventoryRoute] GET movements failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list stock movements' });
    }
  });

  router.post('/movements', requireWrite, requireInventoryWrite, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as StockMovementInput;

      if (!input.itemId || !input.type || input.quantity == null) {
        return res.status(400).json({ error: '缺少必填字段：itemId / type / quantity' });
      }
      if (!VALID_MOVEMENT_TYPES.includes(input.type)) {
        return res.status(400).json({ error: `非法变动类型：${input.type}` });
      }
      if (input.type === 'Transfer' && !input.targetWarehouseId) {
        return res.status(400).json({ error: '调拨必须指定 targetWarehouseId' });
      }
      if (input.quantity < 0) {
        return res.status(400).json({ error: '变动数量不能为负数' });
      }
      // 盘点（Adjustment）的 quantity 是「盘点后实际总数」目标绝对值（服务层
      // qtyDelta = moveQty - currentQty），0 = 盘点清零，是合法语义；其余类型必须 > 0
      if (input.quantity === 0 && input.type !== 'Adjustment') {
        return res.status(400).json({ error: '变动数量必须 > 0（盘点 Adjustment 允许 0 = 清零）' });
      }

      if(!await readAccess(req).canReadInventoryItem(input.itemId))return res.status(404).json({error:'库存不存在或不可操作'});
      const movement = (req.body as any).requestKey ? await manualStockCommand(prisma,'movement',input,actor?.userId || 'system') : await service.createStockMovement(input, actor?.userId || 'system');
      onDataChange?.({ entity: 'StockMovement', action: 'create', ids: [movement.id] });
      onDataChange?.({ entity: 'InventoryItem', action: 'movement', ids: [input.itemId] });
      res.status(201).json({ movement });
    } catch (e: any) {
      logger.error('[InventoryRoute] POST movement failed', { error: e?.message });
      const msg = e?.message || '';
      const status = msg.includes('不存在') ? 404
        : msg.includes('库存不足') || msg.includes('不可删除') || msg.includes('非法') || msg.includes('并发冲突') ? 409
        : 400;
      res.status(status).json({ error: msg || 'failed to create stock movement' });
    }
  });

  // ════════════════════════════════════════
  // 预警
  // ════════════════════════════════════════

  router.get('/alerts/low-stock', async (req: Request, res: Response) => {
    try {
      const items = await service.getLowStockItems(await readAccess(req).orderWhere(true));
      res.json(readResult(req, { items, total: items.length }));
    } catch (e: any) {
      logger.error('[InventoryRoute] GET low-stock failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to get low stock alerts' });
    }
  });

  return router;
}
