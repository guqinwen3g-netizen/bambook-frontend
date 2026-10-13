
/**
 * Phase 2 跨模块联动 — L8
 *
 * 业务规则：采购来料接收（MaterialReceived）→ 自动入库
 *
 * 设计决策：
 *   - 行级入库数量来源（2026-08-27 L8 断层修复后的 payload 契约）：
 *     ① 新事件：payload.stockInLines = 本次收料的行级增量（合格数口径，
 *        见 procurementService.MaterialReceivedStockInLine）。多张部分收料时只入库
 *        "本次"数量，不会把历史累计值重复入库；
 *     ② 旧事件仅使用本次收料审计行证据；无证据单行可用本收料合格量，多行拒绝猜测。
 *   - 指定仓库必须有效；仅未指定仓库时默认入主仓（type=Main, isActive=true）
 *   - 未指定且无主仓时尝试 active 仓库；无可用仓库返回失败供重试
 *   - 新入库流水 referenceType=MaterialReceipt，referenceId=receiptId；
 *     原生旧 PurchaseOrder+receiptId 流水仅在完整逐行证据匹配时兼容重放。
 *
 * 幂等性：
 *   - in-process: `auto:L8:${receiptId}` 去重
 *   - 业务层: 收料行锁 + 整单原子入库；仅完整逐行来源一致才视为已完成
 */

import { Prisma } from '@prisma/client';
import { businessEventBus } from '../businessEventBus';
import { createInventoryService } from '../../inventory/inventoryService';
import { isLinkageEnabled } from '../../config/automationConfig';
import { logger } from '../../lib/logger';
import type { MaterialReceivedStockInLine } from '../../procurement/procurementService';
import { resolveReceiptWarehouse } from '../../procurement/receiptWarehouseAccess';
import { verifyNativeSupplierReceiptPosting } from '../../procurement/supplierNativeReceipt';
import { todayLocalKey } from '../../shared/localDate';


export function registerL8AutoStockIn(): void {
  businessEventBus.registerLinkage({
    id: 'L8_auto_stock_in',
    eventType: 'MaterialReceived',
    idempotencyKey: (e) => {
      const payload = e.payload as { receiptId?: string };
      return `auto:L8:${payload.receiptId ?? e.sourceEntityId}`;
    },
    execute: async (prisma, event) => {
      if (!isLinkageEnabled('L8_auto_stock_in')) {
        logger.info('[L8] linkage disabled, skipping', { purchaseOrderId: event.sourceEntityId });
        return { ok: true, created: null, error: 'linkage disabled' };
      }

      const payload = event.payload as {
        purchaseOrderId?: string;
        poNumber?: string;
        receiptId?: string;
        receiptNumber?: string;
        warehouseId?: string;
        warehouseName?: string;
        currency?: string;
        stockInLines?: MaterialReceivedStockInLine[];
      };

      const purchaseOrderId = payload.purchaseOrderId ?? event.sourceEntityId;
      const receiptId = payload.receiptId;

      if (!purchaseOrderId || !receiptId) {
        logger.warn('[L8] MaterialReceived event missing purchaseOrderId/receiptId', { eventId: event.id });
        return { ok: false, error: 'missing purchaseOrderId or receiptId' };
      }

      try {
        return await prisma.$transaction(async (tx) => {
        const receipts = await tx.$queryRaw<Array<{id:string; purchaseOrderId:string; totalReceived:Prisma.Decimal; totalAccepted:Prisma.Decimal; warehouseId:string|null; warehouseName:string|null}>>(Prisma.sql`SELECT "id", "purchaseOrderId", "totalReceived", "totalAccepted", "warehouseId", "warehouseName" FROM "MaterialReceipt" WHERE "id" = ${receiptId} FOR UPDATE`);
        if (!receipts[0] || receipts[0].purchaseOrderId !== purchaseOrderId) throw new Error('收料来源不存在或不属于该采购单');
        const existingMovements = await tx.stockMovement.findMany({ where: {
          referenceId: receiptId, type: 'Inbound', OR: [{ referenceType: 'MaterialReceipt' }, { referenceType: 'PurchaseOrder' }],
        }, select: { id: true, notes: true, warehouseId: true } });
        // 查询采购单 + 行明细
        const po = await tx.purchaseOrder.findUnique({
          where: { id: purchaseOrderId },
          include: { lines: true },
        });

        if (!po || po.deletedAt) {
          logger.warn('[L8] purchase order not found', { purchaseOrderId });
          return { ok: false, error: `PO ${purchaseOrderId} not found` };
        }

        if (await verifyNativeSupplierReceiptPosting(tx, po, receipts[0], payload.warehouseId)) {
          if (existingMovements.length) throw new Error('原生供应商交接已经原子入账，但发现额外旧收料流水，须核查。');
          return { ok: true, created: null, error: 'native supplier actual receipt already posted' };
        }

        const audit = await tx.auditLog.findFirst({ where: { targetId: purchaseOrderId, action: 'create_material_receipt', detail: { path: ['after', 'receiptId'], equals: receiptId } }, select: { detail: true } });
        const evidence = (audit?.detail as any)?.after?.lineReceipts;
        const receiptQuantity = new Prisma.Decimal(receipts[0].totalAccepted);
        if (!receiptQuantity.isFinite() || receiptQuantity.lt(0)) throw new Error('收料合格数量无效');
        // 行级入库明细：优先使用收料事务内计算好的行级增量（stockInLines 契约），
        // 旧事件必须从本次收料证据还原，绝不使用采购累计数量
        const hasStockInLines = Array.isArray(payload.stockInLines);
        let targetLines: Array<{
          lineId: string | undefined;
          materialCode: string | undefined;
          description: string;
          category: string | undefined;
          specification: string | undefined;
          unit: string;
          unitPrice: number | undefined;
          quantity: number;
        }>;

        if (hasStockInLines) {
          if (payload.stockInLines!.some(l => !Number.isFinite(Number(l.quantity)) || Number(l.quantity) < 0 || !po.lines.some(p => p.id === l.lineId))) throw new Error('入库行数量无效或不属于来源采购单');
          targetLines = (payload.stockInLines ?? [])
            .map((l) => ({
              lineId: l.lineId,
              materialCode: l.materialCode ?? undefined,
              description: l.description || l.materialCode || '未知物料',
              category: l.category ?? undefined,
              specification: l.specification ?? undefined,
              unit: l.unit || 'PC',
              unitPrice: l.unitPrice != null ? Number(l.unitPrice) : undefined,
              quantity: Number(l.quantity),
            }))
            .filter((l) => l.quantity > 0);
        } else {
          const quantities: Array<{lineId:string; accepted:number}> = Array.isArray(evidence) ? evidence
            : po.lines.length === 1 ? [{ lineId: po.lines[0].id, accepted: Number(receiptQuantity) }]
            : (() => { throw new Error('历史多行收料缺少本次行级证据，须人工核对，禁止按采购累计入库'); })();
          let evidenceTotal = new Prisma.Decimal(0);
          targetLines = quantities.map(entry => {
            const line = po.lines.find(l => l.id === entry.lineId);
            const quantity = new Prisma.Decimal(entry.accepted);
            if (!line || !quantity.isFinite() || quantity.lt(0)) throw new Error('历史收料行证据无效');
            evidenceTotal = evidenceTotal.plus(quantity);
            return { lineId: line.id, materialCode: line.materialCode ?? undefined,
              description: line.description, category: line.category ?? undefined,
              specification: line.specification ?? undefined, unit: line.unit,
              unitPrice: Number(line.unitPrice), quantity: Number(quantity) };
          }).filter(line => line.quantity > 0);
          if (!evidenceTotal.eq(receiptQuantity)) throw new Error('历史收料行证据与本次合格总量不一致');
        }

        // Receipt facts are authoritative for both modern and legacy event formats.
        const actual = new Map<string, Prisma.Decimal>();
        for (const line of targetLines) {
          if (!line.lineId || actual.has(line.lineId)) throw new Error('入库采购行来源重复或缺失');
          actual.set(line.lineId, new Prisma.Decimal(line.quantity));
        }
        const total = [...actual.values()].reduce((sum, quantity) => sum.plus(quantity), new Prisma.Decimal(0));
        if (!total.eq(receiptQuantity)) throw new Error('入库事件合格总量与本收料单不一致');
        if (Array.isArray(evidence)) {
          const expected = new Map<string, Prisma.Decimal>();
          const seen = new Set<string>();
          for (const entry of evidence) {
            const quantity = new Prisma.Decimal(entry.accepted);
            if (!entry.lineId || seen.has(entry.lineId) || !po.lines.some(line => line.id === entry.lineId) || !quantity.isFinite() || quantity.lt(0)) throw new Error('收料审计行证据无效');
            seen.add(entry.lineId);
            if (quantity.gt(0)) expected.set(entry.lineId, quantity);
          }
          if (expected.size !== actual.size || [...expected].some(([lineId, quantity]) => !actual.get(lineId)?.eq(quantity))) throw new Error('入库事件逐行数量与收料审计不一致');
        }
        // Product identity and unit always come from the referenced purchase line.
        targetLines = targetLines.map(target => {
          const source = po.lines.find(line => line.id === target.lineId)!;
          if (source.kind === 'ProcessingService') throw new Error('加工服务不能生成物料库存');
          if (hasStockInLines && ((target.materialCode ?? '') !== (source.materialCode ?? '') || target.unit !== source.unit)) throw new Error('入库事件物料或单位与采购来源不一致');
          return { ...target, description: source.description, category: source.category ?? undefined,
            specification: source.specification ?? undefined, unitPrice: Number(source.unitPrice) };
        });

        if (targetLines.length === 0) {
          if (existingMovements.length) throw new Error('零合格收料存在入库流水，须核查');
          logger.info('[L8] no lines with received quantity, skipping', { purchaseOrderId });
          return { ok: true, created: null, error: 'no received lines' };
        }

        const payloadWarehouseId = typeof payload.warehouseId === 'string' && payload.warehouseId.trim() ? payload.warehouseId.trim() : null;
        const receiptWarehouseId = receipts[0].warehouseId || null;
        if (receiptWarehouseId && payloadWarehouseId && receiptWarehouseId !== payloadWarehouseId) {
          throw new Error('入库事件仓库与实际收料仓库不一致，禁止改存其他仓库');
        }
        const sourceMarker = (line: typeof targetLines[number], warehouseId: string) => `L8-source:${JSON.stringify({ receiptId, lineId: line.lineId, quantity: line.quantity, unit: line.unit, warehouseId })}`;
        if (targetLines.some(line => !line.lineId || !Number.isFinite(line.quantity)) || new Set(targetLines.map(line => line.lineId)).size !== targetLines.length) throw new Error('入库事件缺少有效且唯一的采购行来源');
        if (existingMovements.length) {
          // A completed native fact remains completed after the warehouse is
          // stopped. Verify its actual destination/markers before any current
          // warehouse lookup; never choose a new default for an old replay.
          const postedWarehouses = new Set(existingMovements.map(m => m.warehouseId).filter(Boolean));
          const postedWarehouse = receiptWarehouseId || payloadWarehouseId || (postedWarehouses.size === 1 ? [...postedWarehouses][0] : null);
          const expected = postedWarehouse ? targetLines.map(line => sourceMarker(line, postedWarehouse)) : [];
          if (!postedWarehouse || postedWarehouses.size !== 1 || !postedWarehouses.has(postedWarehouse)
            || existingMovements.length !== expected.length || !expected.every(marker => existingMovements.filter(m => m.notes === marker).length === 1)) {
            throw new Error('收料存在旧格式、部分或不匹配入库流水，须核对后修复，不能跳过整单');
          }
          return { ok: true, created: null, error: 'already stocked in' };
        }
        // New receipts already pin the server-resolved warehouse. Only old
        // receipts without that fact retain the original Main→active fallback.
        const warehouse = await resolveReceiptWarehouse(tx, receiptWarehouseId || payloadWarehouseId);
        if (typeof po.currency !== 'string' || !po.currency.trim()) throw new Error('采购来源缺少真实币种，禁止猜测库存成本币种');
        const sourceCurrency = po.currency;
        if (payload.currency != null && payload.currency !== sourceCurrency) throw new Error('入库事件币种与当前采购来源不一致，请核对原收料依据');
        // createInventoryItem uses an internal callback transaction; bind that callback to
        // this already-open transaction, while movement uses its explicit tx API.
        const transactionClient = new Proxy(tx, { get(target, prop) {
          if (prop === '$transaction') return async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx);
          return Reflect.get(target, prop);
        } });
        const inventoryService = createInventoryService(transactionClient as any);
        const movementDate = todayLocalKey();
        const createdMovements: string[] = [];

        for (const line of targetLines) {
          const receivedQty = line.quantity;
          const materialCode = line.materialCode;
          const description = line.description;

          // 查找或创建库存项
          let inventoryItem = null;
          if (materialCode) {
            inventoryItem = await tx.inventoryItem.findFirst({
              where: {
                warehouseId: warehouse.id,
                materialCode,
                deletedAt: null,
              },
            });
          }

          let itemId: string;
          if (inventoryItem) {
            if (inventoryItem.currency !== sourceCurrency) throw new Error('同物料库存币种与本次采购不同，须核对真实汇率或独立库存来源，禁止混合计价');
            itemId = inventoryItem.id;
          } else {
            // 创建新库存项（初始数量 0，随后通过入库变动增加）
            const newItem = await inventoryService.createInventoryItem({
              warehouseId: warehouse.id,
              materialCode: materialCode ?? undefined,
              description,
              category: line.category ?? undefined,
              specification: line.specification ?? undefined,
              quantity: 0,
              unit: line.unit || 'PC',
              unitCost: line.unitPrice ? Number(line.unitPrice) : undefined,
              currency: sourceCurrency,
              notes: `由采购单 ${po.poNumber} 来料自动创建`,
            }, event.actorId || 'agent:auto');
            itemId = newItem.id;
          }

          // 创建入库变动
          const movement = await inventoryService.createStockMovement({
            itemId,
            type: 'Inbound',
            quantity: receivedQty,
            unit: line.unit || 'PC',
            unitCost: line.unitPrice ? Number(line.unitPrice) : undefined,
            reason: `采购到货：${po.poNumber}`,
            referenceType: 'MaterialReceipt',
            referenceId: receiptId,
            movementDate,
            notes: sourceMarker(line, warehouse.id),
          }, event.actorId || 'system', { tx });

          createdMovements.push(movement.id);
        }

        // Append the real posting fact, including a legacy warehouse resolution,
        // without rewriting the original receipt command or queued event.
        await tx.auditLog.create({ data: {
          id: `alog_l8_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: event.actorId || 'system', action: 'stock_in_material_receipt', targetType: 'MaterialReceipt', targetId: receiptId,
          detail: { source: 'linkage:L8', eventId: event.id, purchaseOrderId,
            after: { warehouseId: warehouse.id, warehouseName: warehouse.name, currency: sourceCurrency,
              movementIds: createdMovements, lineIds: targetLines.map(line => line.lineId!),
              resolvedLegacyWarehouse: receiptWarehouseId === null } },
        } });

        logger.info('[L8] auto stock-in completed', {
          purchaseOrderId, poNumber: po.poNumber,
          receiptId, warehouseId: warehouse.id,
          movementCount: createdMovements.length,
        });

        return {
          ok: true,
          created: {
            warehouseId: warehouse.id,
            movementIds: createdMovements,
            movementCount: createdMovements.length,
          },
        };
        });
      } catch (e: any) {
        logger.error('[L8] auto stock-in failed', {
          error: e?.message,
          purchaseOrderId,
          receiptId,
          eventId: event.id,
        });
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
  });
}
