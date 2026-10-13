/**
 * orderVisibility.ts — 「可见订单集合」基础件。
 *
 * §10.4.2（2026-09-12 业务方定案）：跟单单据与成本单据的可见性**随订单**——
 *   - BOM / 采购单：能看到某张订单，就看得到它的 BOM 与采购单（业务员要算单笔利润）；
 *   - 生产 / QC / 出运 / 报关：同理随关联订单。
 *
 * 为什么需要这个基础件：这些单据本身**没有归属人字段**（PurchaseOrder 只有自由文本
 * buyer；BOM 只挂 productAssetId/orderId/quotationId），无法用通用「ownerId ∈ 用户集」
 * 的行级范围过滤，只能通过「关联订单是否可见」推导。订单可见性的唯一真源仍是
 * `orders/orderService.buildOrderListScopeWhere`（客户跟进人 ∪ 按单分配 ∪ 小组共享），
 * 这里只做一次 id 解析与复用，避免各域各写一套。
 */

import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from './service';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { logger } from '../lib/logger';
import { businessError, lookupErrorCode } from '../shared/errorCodes';

/**
 * 当前主体可见的订单 id 列表。
 *  - 返回 `null` = **不受限**（真全权角色，或 dev/API-Key 旧口径）→ 调用方不加过滤；
 *  - 返回数组（可能为空）= 白名单 → 调用方按 `orderId ∈ 白名单` 过滤。
 *
 * 空数组与 null 语义必须区分：前者是"一张都看不到"，后者是"不限制"。
 */
export async function resolveVisibleOrderIds(
  prisma: PrismaClient,
  actor: TokenPayload | null | undefined,
  opts: { limit?: number; fresh?: boolean; strict?: boolean } = {},
): Promise<string[] | null> {
  if (opts.strict && !actor?.userId) throw businessError('UNAUTHORIZED', lookupErrorCode('UNAUTHORIZED')!.message);
  let scopeWhere: Record<string, unknown>;
  // Legacy permission resolvers catch team lookup failures. Strict consumers
  // must distinguish that outage from an actually empty L2 scope, while using
  // the same policy builder and leaving default readers unchanged.
  let resolverFault = false;
  const scopeClient = opts.strict ? new Proxy(prisma, { get(target, key) {
    if (key !== 'teamMember') return Reflect.get(target, key);
    const delegate = Reflect.get(target, key);
    if (!delegate) { resolverFault = true; throw businessError('AUTHORIZATION_UNAVAILABLE', lookupErrorCode('AUTHORIZATION_UNAVAILABLE')!.message); }
    return new Proxy(delegate, { get(model, method) {
      if (method !== 'findMany') return Reflect.get(model, method);
      return async (...args: any[]) => {
        try { return await model.findMany(...args); }
        catch (error) { resolverFault = true; throw error; }
      };
    } });
  } }) : prisma;
  try {
    scopeWhere = await buildOrderListScopeWhere(scopeClient, actor, { fresh: opts.fresh });
    if (resolverFault) throw businessError('AUTHORIZATION_UNAVAILABLE', lookupErrorCode('AUTHORIZATION_UNAVAILABLE')!.message);
  } catch (e: any) {
    if (opts.strict) throw businessError('AUTHORIZATION_UNAVAILABLE', lookupErrorCode('AUTHORIZATION_UNAVAILABLE')!.message);
    // 可见性解析失败 → fail-closed（宁少不给多），但必须吵出来：这是数据可见性故障，
    // 静默放行等于泄漏，静默拒绝等于用户莫名其妙看不到数据。
    logger.error('[orderVisibility] 订单可见范围解析失败，按 fail-closed 处理', { error: e?.message || String(e) });
    return [];
  }
  if (!scopeWhere || Object.keys(scopeWhere).length === 0) return null;
  let rows: any;
  try { rows = await (prisma as any).order.findMany({
      where: { deletedAt: null, ...scopeWhere },
      select: { id: true },
      take: opts.limit ?? 5000,
    }); }
  catch {
    if (opts.strict) throw businessError('AUTHORIZATION_UNAVAILABLE', lookupErrorCode('AUTHORIZATION_UNAVAILABLE')!.message);
    rows = null;
  }
  if (opts.strict && !Array.isArray(rows)) throw businessError('AUTHORIZATION_UNAVAILABLE', lookupErrorCode('AUTHORIZATION_UNAVAILABLE')!.message);
  if (!Array.isArray(rows)) return []; // 查询失败 → fail-closed（宁少不给多）
  return rows.map((r: any) => r.id);
}

/**
 * 关联订单字段的行级 where 片段。用 `AND` 叠加而不是顶层 `OR`——
 * 预算了各域已有的 search OR（顶层裸 OR 会互相覆盖，QA-SEC-1 踩过）。
 */
export function buildOrderLinkedScope(
  visibleOrderIds: string[] | null | undefined,
  field = 'orderId',
): Record<string, unknown> {
  if (!visibleOrderIds) return {}; // null / undefined = 不受限
  return { [field]: { in: visibleOrderIds } };
}

/** 单条记录是否落在可见订单集合内（详情端点防「猜 id 直读」）。 */
export function isOrderLinkedVisible(
  visibleOrderIds: string[] | null | undefined,
  orderId: string | null | undefined,
): boolean {
  if (!visibleOrderIds) return true;
  if (!orderId) return false; // 无关联订单 → 不在白名单内
  return visibleOrderIds.includes(orderId);
}

/**
 * 出运单侧：一次出运可覆盖多张订单，**真源是分配表**（`ShipmentOrderAllocation`，
 * DR-016 明确 `Shipment.orderId` 只是"首条派生的投影字段"）。因此判断"这票运单
 * 是否可见"必须查分配表，不能只看投影字段，否则多单拼柜的票会被漏判。
 *
 * 返回这些可见订单涉及的运单 id（供 `{ id: { in: ids } }` 使用）。
 */
export async function resolveVisibleShipmentIds(
  prisma: PrismaClient,
  visibleOrderIds: string[],
  options: { strict?: boolean } = {},
): Promise<string[]> {
  if (visibleOrderIds.length === 0) return [];
  let rows: any;
  try { rows = await (prisma as any).shipmentOrderAllocation.findMany({
    where: { orderId: { in: visibleOrderIds } },
    select: { shipmentId: true },
  }); }
  catch {
    if (options.strict) throw businessError('AUTHORIZATION_UNAVAILABLE', lookupErrorCode('AUTHORIZATION_UNAVAILABLE')!.message);
    rows = [];
  }
  if (options.strict && !Array.isArray(rows)) throw businessError('AUTHORIZATION_UNAVAILABLE', lookupErrorCode('AUTHORIZATION_UNAVAILABLE')!.message);
  return Array.from(new Set((rows ?? []).map((r: any) => r.shipmentId).filter(Boolean)));
}

/**
 * 出运单可见性 where（AND 叠加用）。同时覆盖两种情况：
 *  - 投影字段命中（单订单运单，历史数据/新建运单）；
 *  - 分配表里任一来源订单命中（多单拼柜）。
 */
export async function buildShipmentVisibilityWhere(
  prisma: PrismaClient,
  visibleOrderIds: string[] | null | undefined,
): Promise<Record<string, unknown>> {
  if (!visibleOrderIds) return {};
  const shipmentIds = await resolveVisibleShipmentIds(prisma, visibleOrderIds);
  return {
    OR: [
      { orderId: { in: visibleOrderIds } },
      { id: { in: shipmentIds } },
    ],
  };
}

/** 单票运单是否对当前主体可见（详情端点用）。 */
export async function isShipmentVisible(
  prisma: PrismaClient,
  visibleOrderIds: string[] | null | undefined,
  shipment: { id: string; orderId?: string | null } | null | undefined,
): Promise<boolean> {
  if (!visibleOrderIds) return true;
  if (!shipment) return false;
  if (shipment.orderId && visibleOrderIds.includes(shipment.orderId)) return true;
  const rows = await (prisma as any).shipmentOrderAllocation
    .findMany({ where: { shipmentId: shipment.id }, select: { orderId: true } })
    .catch(() => []);
  return (rows ?? []).some((r: any) => visibleOrderIds.includes(r.orderId));
}
