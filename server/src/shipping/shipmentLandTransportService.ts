/**
 * shipmentLandTransportService.ts — T6-b 陆运段（H12/D4 拍板 3，2026-09-16 设计稿）
 *
 * 业务规则（设计真源：docs/design/T6-订舱与陆运段-设计-2026-09-16.md）：
 *   - 一票一段（shipmentId 唯一，upsert 语义；重复提交不重复建行）。
 *   - 工厂 → 货代仓一程：约定运抵时间 / 实际送达（= 进仓时刻）/ 车牌司机。
 *   - 费用采集：陆运费 / 进仓费（FOB 进成本、CIF 走应收——Incoterms 分支切换未拍板，
 *     本批只采集不进毛利；profitSheetService 未动）。
 *   - 与 T3 边界：货代仓不建库存账，本表不碰 InventoryItem。
 *
 * 字段白名单（route / Agent 共用真源）：含 id 外全部可写字段。
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { logger } from '../lib/logger';

export const LAND_TRANSPORT_WRITABLE_FIELDS: readonly string[] = [
  'plannedArrivalAt', 'actualDeliveredAt',
  'plateNo', 'driverName', 'driverPhone', 'carrierName',
  'inlandFreightAmount', 'inlandFreightCurrency', 'warehouseFeeAmount', 'warehouseFeeCurrency',
  'notes',
];

const DECIMAL_FIELDS = new Set(['inlandFreightAmount', 'warehouseFeeAmount']);
const DATE_TIME_FIELDS = new Set(['plannedArrivalAt', 'actualDeliveredAt']);

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, error: { code, message, status } });

interface LandTransportError { code: string; message: string; status: number }

function normalizeInput(input: Record<string, any>): { ok: true; data: Record<string, any> } | { ok: false; error: LandTransportError } {
  const data: Record<string, any> = {};
  for (const k of LAND_TRANSPORT_WRITABLE_FIELDS) {
    if (input[k] === undefined) continue;
    let v = input[k];
    if (DATE_TIME_FIELDS.has(k) && v != null) {
      const sv = String(v).trim();
      // YYYY-MM-DD 或 YYYY-MM-DD HH:mm（宽松校验：日期部分必须合法）
      if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(sv)) {
        return { ok: false, error: { code: 'INVALID_INPUT', message: `${k} 格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm，收到 ${sv}`, status: 400 } };
      }
      v = sv;
    }
    if (DECIMAL_FIELDS.has(k) && v != null) {
      try {
        const d = new Prisma.Decimal(String(v));
        if (!d.isFinite() || d.lt(0)) {
          return { ok: false, error: { code: 'INVALID_INPUT', message: `${k} 必须为非负数，收到 ${String(v)}`, status: 400 } };
        }
        v = d;
      } catch {
        return { ok: false, error: { code: 'INVALID_INPUT', message: `${k} 非法数字：${String(v)}`, status: 400 } };
      }
    }
    data[k] = v;
  }
  return { ok: true, data };
}

export function createShipmentLandTransportService(prisma: PrismaClient) {

  /** 查某票的陆运段（无则 null） */
  async function getLandTransport(shipmentId: string): Promise<Result<any>> {
    const row = await prisma.shipmentLandTransport.findUnique({ where: { shipmentId } });
    return ok({ landTransport: row ?? null });
  }

  /** upsert（一票一段；重复提交不重复建行） */
  async function upsertLandTransport(params: {
    shipmentId: string;
    input: Record<string, any>;
    actorId?: string | null;
    ip?: string | null;
  }): Promise<Result<any>> {
    const { shipmentId, actorId, ip } = params;
    const normalized = normalizeInput(params.input);
    if (!normalized.ok) return normalized;
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        const shipment = await tx.shipment.findUnique({ where: { id: shipmentId }, select: { id: true, shipmentNumber: true, deletedAt: true } });
        if (!shipment || shipment.deletedAt) {
          return fail('NOT_FOUND', `运单 ${shipmentId} 不存在`, 404);
        }
        const existing = await tx.shipmentLandTransport.findUnique({ where: { shipmentId } });
        const now = BigInt(Date.now());
        let row: any;
        let operation: string;
        if (existing) {
          row = await tx.shipmentLandTransport.update({ where: { shipmentId }, data: { ...normalized.data, updatedAt: now } });
          operation = 'update_shipment_land_transport';
        } else {
          row = await tx.shipmentLandTransport.create({
            data: {
              id: `SLT__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              shipmentId,
              ...normalized.data,
              createdAt: now,
              updatedAt: now,
            },
          });
          operation = 'create_shipment_land_transport';
        }
        await writeRouteAuditLog({
          prisma: tx, actorId: actorId || 'api', source: 'route:shipping:land-transport',
          operation, targetType: 'Shipment', targetId: shipmentId,
          before: existing ? { plannedArrivalAt: existing.plannedArrivalAt, actualDeliveredAt: existing.actualDeliveredAt } : null,
          after: { ...normalized.data },
          ip: ip || null,
        });
        return ok({ landTransport: row });
      });
      return result;
    } catch (e: any) {
      logger.error('[ShipmentLandTransport] upsert failed', { error: e?.message, shipmentId });
      return fail('UPSERT_FAILED', String(e?.message ?? e), 500);
    }
  }

  return { getLandTransport, upsertLandTransport };
}
