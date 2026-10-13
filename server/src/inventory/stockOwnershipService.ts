/**
 * stockOwnershipService.ts — ★ C4 库存「订单归属」与「备货」的唯一真源（2026-09-18）
 *
 * ── 为什么需要它（零基础障碍清单 C4，实测核实）──
 * 备货（无单先产：工厂按预测先做，等订单来了再归属）在面料行业很常见，但：
 *   · `InventoryItem` **完全没有订单锚点**（`StockMovement.referenceType/Id` 只记流水，
 *     表达不了「这批货**现在**挂在谁头上」）⇒ 备货无法归属订单
 *   · **A 单货挪 B 单没有任何留痕** —— 谁挪的、什么时候挪的、为什么挪，全查不到
 * ⇒ 结果是「账上有货、但不知道这批货是哪张单的」，订单成本与库存对不上。
 *
 * ── 三个状态（`orderId` × `stockPrep` 两个字段表达，不用第三个枚举）──
 *   · 备货：`orderId = null` + `stockPrep = true`
 *   · 通用库存（未归属，如常备料）：`orderId = null` + `stockPrep = false`
 *   · 已归属某订单：`orderId = <订单>`
 * 为什么不用单个 status 枚举：`stockPrep` 是「这批货的来路」，`orderId` 是「现在归谁」，
 * 两件事正交（备货被归属后 stockPrep 转 false，退回则回到备货/未归属）。
 *
 * ── 四个动作（封闭集，`InventoryOwnershipChange.action` 同值）──
 *   | action           | 前置                          | 结果            |
 *   |------------------|-------------------------------|-----------------|
 *   | mark_stock_prep  | 必须未归属                    | 未归属 + 备货   |
 *   | attribute        | 必须未归属 + 有目标订单       | 归属目标订单    |
 *   | reassign（挪货） | 必须**已归属** + 目标≠当前    | 归属目标订单    |
 *   | release          | 必须已归属                    | 未归属（非备货）|
 *
 * ⚠️ 刻意**不做**的两件事：
 *   ① 不自动校验「挪走后原订单是否还够用」—— 那需要按订单 BOM/出运核算，属独立工作流；
 *      本服务只保证**归属事实与留痕正确**，并在返回值里回带 `previousOrderId` 供上层提示。
 *   ② 不允许「已归属 → 直接改成备货」：必须先 `release`（两步都留痕），
 *      否则一次操作同时改变「归谁」与「是不是备货」两件事，事后无法分辨意图。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { resolveOrderId } from '../orders/orderIdentity';

// ────────────────────────────────────────────────────────────────
// 真源（纯函数，可单测）
// ────────────────────────────────────────────────────────────────

export const OWNERSHIP_ACTIONS = ['mark_stock_prep', 'attribute', 'reassign', 'release'] as const;
export type OwnershipAction = (typeof OWNERSHIP_ACTIONS)[number];

export const OWNERSHIP_ACTION_LABELS: Record<OwnershipAction, string> = {
  mark_stock_prep: '标记备货',
  attribute: '归属订单',
  reassign: '挪到其它订单',
  release: '退回未归属',
};

/** 事由下限（与 DR-010「原因必须写清」同取向；挪货尤其要能追） */
export const OWNERSHIP_REASON_MIN = 6;

export interface OwnershipTransitionInput {
  currentOrderId: string | null;
  currentStockPrep: boolean;
  action: OwnershipAction;
  targetOrderId?: string | null;
  /** 该库存项当前数量（0 库存的归属没有意义 → 拒绝，避免垃圾留痕） */
  quantity: number;
}

export type OwnershipTransitionResult =
  | { ok: true; nextOrderId: string | null; nextStockPrep: boolean }
  | { ok: false; code: string; message: string };

/**
 * 归属变更判定（**纯函数**，无 IO）。所有拒绝路径都给出可执行的下一步。
 */
export function validateOwnershipTransition(input: OwnershipTransitionInput): OwnershipTransitionResult {
  const { currentOrderId, currentStockPrep, action, quantity } = input;
  const target = (input.targetOrderId ?? '').trim() || null;

  if (!OWNERSHIP_ACTIONS.includes(action)) {
    return { ok: false, code: 'INVALID_ACTION', message: `未知的归属动作「${String(action)}」。允许：${OWNERSHIP_ACTIONS.join(' / ')}` };
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, code: 'NO_STOCK', message: `该库存项当前数量为 ${quantity}，无货可归属（归属变更不会改变数量，0 库存的归属没有意义）` };
  }

  switch (action) {
    case 'mark_stock_prep': {
      if (currentOrderId) {
        return {
          ok: false, code: 'ALREADY_ATTRIBUTED',
          message: `该批货已归属订单 ${currentOrderId}，不能直接标记为备货。请先「退回未归属」，再标记备货（两步都留痕，事后能分辨意图）`,
        };
      }
      if (currentStockPrep) {
        return { ok: false, code: 'NO_CHANGE', message: '该批货已经是备货状态，无需重复标记' };
      }
      return { ok: true, nextOrderId: null, nextStockPrep: true };
    }

    case 'attribute': {
      if (!target) return { ok: false, code: 'TARGET_REQUIRED', message: '「归属订单」必须指定目标订单' };
      if (currentOrderId) {
        return {
          ok: false, code: 'ALREADY_ATTRIBUTED',
          message: `该批货已归属订单 ${currentOrderId}。要换单请用「挪到其它订单」（reassign），两个动作分开是为了让留痕能区分「认领」与「挪货」`,
        };
      }
      return { ok: true, nextOrderId: target, nextStockPrep: false };
    }

    case 'reassign': {
      if (!target) return { ok: false, code: 'TARGET_REQUIRED', message: '「挪到其它订单」必须指定目标订单' };
      if (!currentOrderId) {
        return {
          ok: false, code: 'NOT_ATTRIBUTED',
          message: '该批货当前未归属任何订单。未归属的货请用「归属订单」（attribute）',
        };
      }
      if (currentOrderId === target) {
        return { ok: false, code: 'NO_CHANGE', message: `该批货已经归属订单 ${target}，无需挪动` };
      }
      return { ok: true, nextOrderId: target, nextStockPrep: false };
    }

    case 'release': {
      if (!currentOrderId) {
        return { ok: false, code: 'NOT_ATTRIBUTED', message: '该批货当前未归属任何订单，无需退回' };
      }
      return { ok: true, nextOrderId: null, nextStockPrep: false };
    }
  }
}

// ────────────────────────────────────────────────────────────────
// 落库（事务 + 留痕 + 审计）
// ────────────────────────────────────────────────────────────────

export type OwnershipResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const ok = <T>(data: T): OwnershipResult<T> => ({ ok: true, data });
const fail = (code: string, message: string, status = 400): OwnershipResult<never> => ({ ok: false, error: { code, message, status } });

const STATUS_BY_CODE: Record<string, number> = {
  AMBIGUOUS_ORDER_REFERENCE: 409,
  ITEM_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  NO_STOCK: 409,
  ALREADY_ATTRIBUTED: 409,
  NOT_ATTRIBUTED: 409,
  NO_CHANGE: 409,
  INVALID_ACTION: 400,
  TARGET_REQUIRED: 400,
  REASON_TOO_SHORT: 400,
};

export interface ApplyOwnershipInput {
  itemId: string;
  action: OwnershipAction;
  targetOrderId?: string | null;
  reason: string;
}

export interface OwnershipChangeResult {
  itemId: string;
  action: OwnershipAction;
  previousOrderId: string | null;
  currentOrderId: string | null;
  stockPrep: boolean;
}

/**
 * 应用归属变更：校验 → 改 `InventoryItem.orderId/stockPrep` → 写 `InventoryOwnershipChange`
 * → 写审计，**同一事务**（半途失败不能留「货动了、留痕没落」或反之）。
 */
export async function applyOwnershipChange(
  prisma: PrismaClient,
  input: ApplyOwnershipInput,
  actorId: string,
): Promise<OwnershipResult<OwnershipChangeResult>> {
  const reason = (input?.reason ?? '').trim();
  if (!input?.itemId) return fail('ITEM_NOT_FOUND', 'itemId 必填');
  if (reason.length < OWNERSHIP_REASON_MIN) {
    return fail('REASON_TOO_SHORT', `事由至少 ${OWNERSHIP_REASON_MIN} 字（归属变更必须能事后追责，挪货尤其如此）`);
  }

  try {
    const data = await prisma.$transaction(async (tx: any) => {
      const item = await tx.inventoryItem.findUnique({
        where: { id: input.itemId },
        select: { id: true, deletedAt: true, quantity: true, orderId: true, stockPrep: true, description: true },
      });
      if (!item || item.deletedAt) throw Object.assign(new Error(`库存项 ${input.itemId} 不存在或已删除`), { code: 'ITEM_NOT_FOUND' });

      // ★ 目标订单解析：**先按 id，再按 PO 号** —— 业务员手上是 PO 号（订单号），
      //   不是内部 id；只认 id 会逼前端做一次搜索请求，且填错时错误信息对业务员无意义。
      const targetRaw = (input.targetOrderId ?? '').trim() || null;
      let targetOrderId: string | null = null;
      if (targetRaw) {
        const resolved = await resolveOrderId(tx, targetRaw);
        if (!resolved) {
          throw Object.assign(new Error(`订单「${targetRaw}」不存在或已删除，请选择准确内部订单。`), { code: 'ORDER_NOT_FOUND' });
        }
        targetOrderId = resolved;
      }

      const verdict = validateOwnershipTransition({
        currentOrderId: item.orderId ?? null,
        currentStockPrep: !!item.stockPrep,
        action: input.action,
        targetOrderId,
        quantity: Number(item.quantity),
      });
      if (!verdict.ok) throw Object.assign(new Error(verdict.message), { code: verdict.code });

      const updated = await tx.inventoryItem.update({
        where: { id: input.itemId },
        data: { orderId: verdict.nextOrderId, stockPrep: verdict.nextStockPrep, updatedAt: BigInt(Date.now()) },
      });

      await tx.inventoryOwnershipChange.create({
        data: {
          id: `IOC_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          itemId: input.itemId,
          fromOrderId: item.orderId ?? null,
          toOrderId: verdict.nextOrderId,
          action: input.action,
          reason,
          operatorId: actorId || null,
          createdAt: BigInt(Date.now()),
        },
      });

      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'inventory-ownership',
        operation: 'INVENTORY_OWNERSHIP_CHANGE',
        targetType: 'InventoryItem',
        targetId: input.itemId,
        before: { orderId: item.orderId ?? null, stockPrep: !!item.stockPrep },
        after: { orderId: updated.orderId ?? null, stockPrep: !!updated.stockPrep, action: input.action, reason },
      });

      return {
        itemId: input.itemId,
        action: input.action,
        previousOrderId: item.orderId ?? null,
        currentOrderId: updated.orderId ?? null,
        stockPrep: !!updated.stockPrep,
      } satisfies OwnershipChangeResult;
    });

    return ok(data);
  } catch (e: any) {
    logger.error('[StockOwnershipService] applyOwnershipChange failed', { error: e?.message });
    const code: string = e?.code ?? 'OWNERSHIP_CHANGE_FAILED';
    return fail(code, e?.message ?? '归属变更失败', STATUS_BY_CODE[code] ?? 500);
  }
}

/** 归属变更历史（append-only；按时间倒序） */
export async function listOwnershipHistory(
  prisma: PrismaClient,
  itemId: string,
  limit = 50,
  readScopeWhere?: Prisma.InventoryOwnershipChangeWhereInput,
): Promise<OwnershipResult<{ items: any[] }>> {
  if (!itemId) return fail('ITEM_NOT_FOUND', 'itemId 必填');
  try {
    const items = await (prisma as any).inventoryOwnershipChange.findMany({
      where: { itemId, ...(readScopeWhere ? { AND: [readScopeWhere] } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return ok({ items });
  } catch (e: any) {
    logger.error('[StockOwnershipService] listOwnershipHistory failed', { error: e?.message });
    return fail('HISTORY_FAILED', e?.message ?? '查询归属历史失败', 500);
  }
}

/** 某订单当前占用的库存（只读；供订单成本/备货核对） */
export async function listItemsByOrder(
  prisma: PrismaClient,
  orderId: string,
): Promise<OwnershipResult<{ items: any[] }>> {
  if (!orderId) return fail('ORDER_NOT_FOUND', 'orderId 必填');
  try {
    const items = await (prisma as any).inventoryItem.findMany({
      where: { orderId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, materialCode: true, description: true, category: true,
        quantity: true, unit: true, unitCost: true, currency: true, warehouseId: true, batchNumber: true,
      },
    });
    return ok({ items });
  } catch (e: any) {
    logger.error('[StockOwnershipService] listItemsByOrder failed', { error: e?.message });
    return fail('LIST_FAILED', e?.message ?? '查询订单占用库存失败', 500);
  }
}

export { Prisma };
