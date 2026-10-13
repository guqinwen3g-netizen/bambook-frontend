/**
 * C4 发货深化 — 装箱明细服务（行级 + 逐箱级）
 *
 * 职责：
 *   - ShipmentLine 写路径单一来源（此前模型存在但全库无写入，制单靠回退链兜底）
 *   - ShipmentCarton / ShipmentCartonItem 逐箱装箱（混装分配）
 *   - 运单汇总字段派生：有箱 → 箱级合计；无箱有行 → 行级合计；皆无 → 保持手工录入
 *
 * 设计决策：
 *   1. 全量替换语义（PUT）：行/箱均以整组替换落库，事务内 delete→create，
 *      天然幂等；行被移除时级联清理引用它的箱内分配（snapshot FK 无数据库级联）。
 *   2. 编辑窗口：仅 Draft/Booked/Loading 可改装箱（Shipped 起货已离厂，锁定 409）。
 *   3. 分配校验：每行累计分配量不得超过行数量（行数量为 null 时不校验上限）。
 *   4. 体积推导：箱三尺寸齐全且 volume 缺省时按 L×W×H÷1e6 推导 CBM。
 *   5. 审计：每次替换写一条 AuditLog（PACKING_LINES_REPLACE / PACKING_CARTONS_REPLACE）。
 */

import type { TokenPayload } from '../auth/service';
import { lockShipmentPhysicalConsumer, validateReservedPhysicalShipment, type ShipmentPhysicalContext } from './shipmentPhysicalConsumerService';
import { validatePhysicalPackingQuantities } from './shipmentPhysicalCommand';
import { safeRouteError } from '../shared/routeError';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { PrismaClient, Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { lockClaimShipmentSource } from '../claims/claimShipmentFact';
import { assertFabricAllowed } from '../products/fabricExclusivityService';

export type PackingErrorCode =
  | 'CONFLICT' | 'INVALID_INPUT' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'AUTHORIZATION_UNAVAILABLE' | 'ACCOUNT_DISABLED' | 'SHIPMENT_NOT_FOUND'
  | 'NOT_FOUND'
  | 'INVALID_CURRENT_STATUS'
  | 'VALIDATION_FAILED'
  | 'ORDER_NOT_FOUND'
  | 'EXCLUSIVE_FABRIC_BLOCKED'
  | 'SAVE_FAILED';

export interface PackingResult<T = any> {
  ok: boolean;
  data?: T;
  error?: { code: PackingErrorCode; message: string; statusCode?: number };
}

/** 可编辑装箱的运单状态（Shipped 起锁定） */
const PACKING_EDITABLE_STATUSES = new Set(['Draft', 'Booked', 'Loading']);

function fail<T>(code: PackingErrorCode, message: string): PackingResult<T> {
  return { ok: false, error: { code, message } };
}

function toDecimal(v: unknown): Prisma.Decimal | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return new Prisma.Decimal(String(v));
}

function numOrNull(v: unknown): number | null {
  const d = toDecimal(v);
  return d === null ? null : Number(d);
}

function newId(prefix: string): string {
  return `${prefix}__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ─── 输入类型 ────────────────────────────────────────────────────

export interface ShipmentLineInput {
  orderLineId?: string | null;
  productCode?: string | null;
  productName?: string | null;
  colorCode?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  cartons?: number | null;
  grossWeight?: number | string | null;
  netWeight?: number | string | null;
  volume?: number | string | null;
  hsCode?: string | null;
  countryOfOrigin?: string | null;
}

export interface CartonItemInput {
  shipmentLineId: string;
  quantity: number | string;
}

export interface ShipmentCartonInput {
  cartonNo: string;
  description?: string | null;
  length?: number | string | null;
  width?: number | string | null;
  height?: number | string | null;
  grossWeight?: number | string | null;
  netWeight?: number | string | null;
  volume?: number | string | null;
  items?: CartonItemInput[];
}

// ─── 查询 ────────────────────────────────────────────────────────

export async function listShipmentLines(prisma: PrismaClient, shipmentId: string) {
  return (prisma as any).shipmentLine.findMany({
    where: { shipmentId },
    orderBy: { lineNumber: 'asc' },
  });
}

export async function listShipmentCartons(prisma: PrismaClient, shipmentId: string) {
  return (prisma as any).shipmentCarton.findMany({
    where: { shipmentId },
    include: { items: true },
    orderBy: { createdAt: 'asc' },
  });
}

// ─── 汇总派生 ────────────────────────────────────────────────────

/**
 * 重算运单汇总字段（事务内调用）：
 *   有箱 → totalPackages=箱数，毛/净/体=箱级合计
 *   无箱有行 → totalPackages=行箱数合计，毛/净/体=行级合计
 *   皆无 → 不动（保持手工录入）
 */
async function recomputeShipmentTotals(t: any, shipmentId: string): Promise<void> {
  const cartons = await t.shipmentCarton.findMany({ where: { shipmentId } });
  const lines = await t.shipmentLine.findMany({ where: { shipmentId } });

  const sum = (rows: any[], key: string): Prisma.Decimal | null => {
    let has = false;
    let acc = new Prisma.Decimal(0);
    for (const r of rows) {
      if (r[key] !== null && r[key] !== undefined) {
        acc = acc.plus(new Prisma.Decimal(r[key].toString()));
        has = true;
      }
    }
    return has ? acc : null;
  };

  let patch: any = null;
  if (cartons.length > 0) {
    patch = {
      totalPackages: cartons.length,
      grossWeight: sum(cartons, 'grossWeight'),
      netWeight: sum(cartons, 'netWeight'),
      volume: sum(cartons, 'volume'),
    };
  } else if (lines.length > 0) {
    const cartonSum = lines.reduce((acc: number, l: any) => acc + (typeof l.cartons === 'number' ? l.cartons : 0), 0);
    patch = {
      totalPackages: cartonSum > 0 ? cartonSum : null,
      grossWeight: sum(lines, 'grossWeight'),
      netWeight: sum(lines, 'netWeight'),
      volume: sum(lines, 'volume'),
    };
  }
  // Every collection mutation advances the post-lock stored version, even
  // when both collections are empty and manual summary fields stay unchanged.
  const current = await t.shipment.findUnique({ where: { id: shipmentId }, select: { updatedAt: true } });
  if (!current) throw businessError('NOT_FOUND', `运单 ${shipmentId} 不存在`);
  const nextVersion = BigInt(current.updatedAt) + BigInt(1), now = BigInt(Date.now());
  await t.shipment.update({ where: { id: shipmentId }, data: { ...(patch ?? {}), updatedAt: now > nextVersion ? now : nextVersion } });
}

// ─── 守卫 ────────────────────────────────────────────────────────

async function loadEditableShipment(t: any, shipmentId: string, actor?: TokenPayload | null) {
  // Claim source rows and the Shipment are locked in the same order as release.
  // The status check below uses the post-lock reread, never an earlier Draft snapshot.
  const context = await lockShipmentPhysicalConsumer(t, { shipmentId, actor, mode: 'packing' });
  const claim = context.kind === 'claim' ? await lockClaimShipmentSource(t, shipmentId) : null;
  const sh = claim?.shipment ?? context.shipment;
  if (!sh || sh.deletedAt) {
    throw Object.assign(new Error(`运单 ${shipmentId} 不存在`), { code: 'NOT_FOUND' });
  }
  if (!PACKING_EDITABLE_STATUSES.has(sh.status)) {
    throw Object.assign(
      new Error(`运单状态 ${sh.status} 不可编辑装箱明细（仅 Draft/Booked/Loading 可编辑）`),
      { code: 'INVALID_CURRENT_STATUS' },
    );
  }
  return { ...sh, physicalContext: context };
}

function toPackingError(e: any): { code: PackingErrorCode; message: string; statusCode?: number } {
  if (isBusinessError(e)) {
    const safe = safeRouteError(e, { fallbackCode: 'SAVE_FAILED', fallbackMessage: '装箱明细保存结果暂不可确认，请刷新核对原运单。' });
    return { code: safe.code as PackingErrorCode, message: safe.message, statusCode: safe.status };
  }
  if (e?.code === 'NOT_FOUND' || e?.code === 'INVALID_CURRENT_STATUS' || e?.code === 'VALIDATION_FAILED' || e?.code === 'ORDER_NOT_FOUND' || e?.code === 'EXCLUSIVE_FABRIC_BLOCKED') {
    return { code: e.code, message: String(e.message ?? e) };
  }
  const safe = safeRouteError(e, { fallbackCode: 'SAVE_FAILED', fallbackMessage: '装箱明细保存结果暂不可确认，请刷新核对原运单。' });
  return { code: 'SAVE_FAILED', message: safe.message, statusCode: safe.status };
}

// ─── 行级装箱：整组替换 ──────────────────────────────────────────

/** 事务内整组替换装运行（createShipment 首装 / pull-from-order / PUT 共用） */
export async function replaceShipmentLinesTx(
  t: any,
  shipmentId: string,
  lines: ShipmentLineInput[],
  actorId: string,
  ip?: string | null,
  options?: { skipStatusCheck?: boolean; actor?: TokenPayload | null; physicalContext?: ShipmentPhysicalContext; auditPrisma?: PrismaClient; auditTransactionId?: string },
): Promise<any[]> {
  const context = options?.skipStatusCheck ? options.physicalContext : (await loadEditableShipment(t, shipmentId, options?.actor)).physicalContext;
  if (context?.kind === 'physical') {
    if (context.actor?.userId !== actorId) throw businessError('FORBIDDEN', '当前装箱操作人身份不一致。');
    await validateReservedPhysicalShipment(t, context, true);
    validatePhysicalPackingQuantities(context, lines);
  }

  // 校验
  lines.forEach((l, i) => {
    const qty = numOrNull(l.quantity);
    if (qty !== null && qty < 0) {
      throw Object.assign(new Error(`第 ${i + 1} 行数量不能为负`), { code: 'VALIDATION_FAILED' });
    }
    if (l.cartons !== null && l.cartons !== undefined && (!Number.isInteger(Number(l.cartons)) || Number(l.cartons) < 0)) {
      throw Object.assign(new Error(`第 ${i + 1} 行箱数必须为非负整数`), { code: 'VALIDATION_FAILED' });
    }
  });

  // P1-3 客户专属面料校验（fail-closed：行产品锚命中他人独占面料 → 409，违规尝试留痕）
  // 锚解析：orderLineId → OrderLine（客供品号/品色号）；无 orderLineId 行按 productCode 兜底为客供品号。
  const exclusiveLineIds = lines.map(l => l.orderLineId).filter((x): x is string => !!x);
  const orderLinesById = new Map<string, any>(
    exclusiveLineIds.length > 0
      ? (await t.orderLine.findMany({ where: { id: { in: exclusiveLineIds } }, select: { id: true, materialCode: true, millQuality: true } })).map((ol: any) => [ol.id, ol])
      : [],
  );
  const shipmentForExclusive = await t.shipment.findUnique({
    where: { id: shipmentId },
    select: { customerRelationId: true, customerName: true },
  });
  for (const l of lines) {
    const ol = l.orderLineId ? orderLinesById.get(l.orderLineId) : null;
    const clientCode = ol?.materialCode ?? l.productCode ?? null;
    const millQuality = ol?.millQuality ?? null;
    if (!clientCode && !millQuality) continue;
    const exclusive = await assertFabricAllowed(t, {
      customer: { customerRelationId: shipmentForExclusive?.customerRelationId ?? null, customerName: shipmentForExclusive?.customerName ?? null },
      productKeys: { clientCode, millQuality, clientCodeCustomerHint: shipmentForExclusive?.customerRelationId ?? null },
      context: 'shipment-lines:replace',
      actorId,
      documentRef: { shipmentId, orderLineId: l.orderLineId ?? null, productCode: l.productCode ?? null },
    }, options?.auditPrisma ?? t);
    if (!exclusive.ok) {
      throw Object.assign(new Error(exclusive.error.message), { code: exclusive.error.code, statusCode: exclusive.error.status });
    }
  }

  const ts = BigInt(Date.now());
  // 级联：被移除的行需清理箱内分配（snapshot FK 无数据库级联）
  const removedLineIds: string[] = (await t.shipmentLine.findMany({ where: { shipmentId }, select: { id: true } })).map((r: any) => r.id);
  if (removedLineIds.length > 0) {
    await t.shipmentCartonItem.deleteMany({ where: { shipmentLineId: { in: removedLineIds } } });
  }
  await t.shipmentLine.deleteMany({ where: { shipmentId } });

  const created: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    created.push(await t.shipmentLine.create({
      data: {
        id: newId('SHPL'),
        shipmentId,
        lineNumber: i + 1,
        orderLineId: l.orderLineId ?? null,
        productCode: l.productCode ?? null,
        productName: l.productName ?? null,
        colorCode: l.colorCode ?? null,
        quantity: toDecimal(l.quantity),
        unit: l.unit ?? null,
        cartons: l.cartons !== null && l.cartons !== undefined ? Number(l.cartons) : null,
        grossWeight: toDecimal(l.grossWeight),
        netWeight: toDecimal(l.netWeight),
        volume: toDecimal(l.volume),
        hsCode: l.hsCode ?? null,
        countryOfOrigin: l.countryOfOrigin ?? null,
        createdAt: ts,
        updatedAt: ts,
      },
    }));
  }

  await recomputeShipmentTotals(t, shipmentId);
  await writeRouteAuditLog({
    prisma: t, actorId, source: 'route:shipping:packing',
    operation: 'PACKING_LINES_REPLACE', targetType: 'Shipment', targetId: shipmentId,
    ...(options?.auditTransactionId ? { transactionId: options.auditTransactionId } : {}),
    after: { lineCount: created.length },
    ip: ip || null,
  });
  return created;
}

export async function replaceShipmentLines(
  prisma: PrismaClient,
  shipmentId: string,
  lines: ShipmentLineInput[],
  actorId: string,
  ip?: string | null,
  options?: { actor?: TokenPayload | null },
): Promise<PackingResult<{ lines: any[] }>> {
  try {
    const result = await (prisma as any).$transaction(async (t: any) => {
      return replaceShipmentLinesTx(t, shipmentId, lines, actorId, ip, { ...options, auditPrisma: prisma });
    });
    return { ok: true, data: { lines: result } };
  } catch (e: any) {
    return { ok: false, error: toPackingError(e) };
  }
}

/** OrderLine → ShipmentLineInput 映射（单一来源，pull 端点与 createShipment 首装共用） */
export function mapOrderLinesToShipmentLineInputs(orderLines: any[]): ShipmentLineInput[] {
  return orderLines.map((ol: any) => ({
    orderLineId: ol.id,
    productCode: ol.materialCode ?? ol.itemNo ?? null,
    productName: ol.description ?? null,
    quantity: ol.quantity !== null && ol.quantity !== undefined ? ol.quantity.toString() : null,
    unit: ol.unit ?? null,
  }));
}

// ─── 从订单带出装运行 ────────────────────────────────────────────

export async function pullLinesFromOrder(
  prisma: PrismaClient,
  shipmentId: string,
  actorId: string,
  ip?: string | null,
  options?: { actor?: TokenPayload | null },
): Promise<PackingResult<{ lines: any[] }>> {
  try {
    const result = await (prisma as any).$transaction(async (t: any) => {
      const sh = await loadEditableShipment(t, shipmentId, options?.actor);
      const context: ShipmentPhysicalContext = sh.physicalContext;
      let lines: ShipmentLineInput[];
      if (context.kind === 'physical') {
        await validateReservedPhysicalShipment(t, context, true);
        const totals = new Map<string, Prisma.Decimal>();
        for (const allocation of context.allocations.filter(row => row.status !== 'Cancelled')) {
          if (!allocation.orderLineId || allocation.actualQty == null) throw businessError('CONFLICT', '须先核对本票实际行级分配。');
          totals.set(allocation.orderLineId, (totals.get(allocation.orderLineId) ?? new Prisma.Decimal(0)).plus(allocation.actualQty));
        }
        const orderLines = await t.orderLine.findMany({ where: { id: { in: [...totals.keys()] } }, orderBy: [{ orderId: 'asc' }, { lineNumber: 'asc' }] });
        if (orderLines.length !== totals.size) throw businessError('CONFLICT', '本票原订单行缺失，请核对实际分配。');
        lines = mapOrderLinesToShipmentLineInputs(orderLines).filter(line => totals.get(line.orderLineId!)!.gt(0))
          .map(line => ({ ...line, quantity: totals.get(line.orderLineId!)!.toString() }));
      } else {
        if (!sh.orderId) throw Object.assign(new Error('运单未关联订单，无法带出装运行'), { code: 'VALIDATION_FAILED' });
        const order = await t.order.findUnique({ where: { id: sh.orderId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
        if (!order || order.deletedAt) throw Object.assign(new Error('来源订单不存在。'), { code: 'ORDER_NOT_FOUND' });
        lines = mapOrderLinesToShipmentLineInputs(order.lines);
      }
      return replaceShipmentLinesTx(t, shipmentId, lines, actorId, ip, { skipStatusCheck: true, actor: options?.actor, physicalContext: context, auditPrisma: prisma });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 });
    return { ok: true, data: { lines: result } };
  } catch (e: any) {
    return { ok: false, error: toPackingError(e) };
  }
}

// ─── 逐箱装箱：整组替换 ──────────────────────────────────────────

export async function replaceShipmentCartonsTx(
  t: any, shipmentId: string, cartons: ShipmentCartonInput[], actorId: string,
  ip?: string | null, options?: { actor?: TokenPayload | null; physicalContext?: ShipmentPhysicalContext; auditTransactionId?: string },
): Promise<any[]> {
      if (options?.physicalContext) {
    if (options.physicalContext.shipment?.id !== shipmentId || options.actor?.userId !== actorId || options.physicalContext.actor?.userId !== actorId)
      throw businessError('FORBIDDEN', '装箱事务来源与当前操作人身份不一致。');
    if (options.physicalContext.shipment.deletedAt != null) throw businessError('NOT_FOUND', '运单不存在。');
    if (!PACKING_EDITABLE_STATUSES.has(options.physicalContext.shipment.status)) throw businessError('INVALID_CURRENT_STATUS', '仅未发运运单可修改装箱明细。');
  }
  const sh = options?.physicalContext ? { physicalContext: options.physicalContext } : await loadEditableShipment(t, shipmentId, options?.actor);

      const lines: any[] = await t.shipmentLine.findMany({ where: { shipmentId } });
      if (sh.physicalContext.kind === 'physical') {
        await validateReservedPhysicalShipment(t, sh.physicalContext, true);
        validatePhysicalPackingQuantities(sh.physicalContext, lines);
        for (const carton of cartons) for (const item of carton.items ?? []) {
          if (typeof item.quantity !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(item.quantity))
            throw businessError('VALIDATION_FAILED', '实际批次箱内数量须为明确的精确十进制字符串。');
        }
      }
      const lineById = new Map<string, any>(lines.map((l: any) => [l.id, l]));

      // 校验：箱号必填；分配引用本运单既有行；每行累计分配 ≤ 行数量
      const allocatedByLine = new Map<string, Prisma.Decimal>();
      cartons.forEach((c, ci) => {
        if (!c.cartonNo || !String(c.cartonNo).trim()) {
          throw Object.assign(new Error(`第 ${ci + 1} 箱箱号必填`), { code: 'VALIDATION_FAILED' });
        }
        for (const item of c.items ?? []) {
          const line = lineById.get(item.shipmentLineId);
          if (!line) {
            throw Object.assign(new Error(`箱 ${c.cartonNo} 分配了不属于本运单的装运行 ${item.shipmentLineId}`), { code: 'VALIDATION_FAILED' });
          }
          const qty = toDecimal(item.quantity);
          if (qty === null || qty.lte(0)) {
            throw Object.assign(new Error(`箱 ${c.cartonNo} 分配数量必须为正数`), { code: 'VALIDATION_FAILED' });
          }
          const acc = (allocatedByLine.get(item.shipmentLineId) ?? new Prisma.Decimal(0)).plus(qty);
          allocatedByLine.set(item.shipmentLineId, acc);
        }
      });
      for (const [lineId, allocated] of allocatedByLine) {
        const line = lineById.get(lineId)!;
        if (line.quantity !== null && allocated.gt(new Prisma.Decimal(line.quantity.toString()))) {
          throw Object.assign(
            new Error(`装运行 ${line.lineNumber} 累计分配 ${allocated.toString()} 超过行数量 ${line.quantity.toString()}`),
            { code: 'VALIDATION_FAILED' },
          );
        }
      }

      const ts = BigInt(Date.now());
      await t.shipmentCarton.deleteMany({ where: { shipmentId } }); // items 随 onDelete: Cascade

      const created: any[] = [];
      for (const c of cartons) {
        const length = toDecimal(c.length);
        const width = toDecimal(c.width);
        const height = toDecimal(c.height);
        let volume = toDecimal(c.volume);
        if (volume === null && length !== null && width !== null && height !== null) {
          volume = length.mul(width).mul(height).div(1_000_000); // cm³ → CBM
        }
        const carton = await t.shipmentCarton.create({
          data: {
            id: newId('SHPC'),
            shipmentId,
            cartonNo: String(c.cartonNo).trim(),
            description: c.description ?? null,
            length, width, height,
            grossWeight: toDecimal(c.grossWeight),
            netWeight: toDecimal(c.netWeight),
            volume,
            createdAt: ts,
            updatedAt: ts,
          },
        });
        const items: any[] = [];
        for (const item of c.items ?? []) {
          items.push(await t.shipmentCartonItem.create({
            data: {
              id: newId('SHPCI'),
              cartonId: carton.id,
              shipmentLineId: item.shipmentLineId,
              quantity: toDecimal(item.quantity)!,
              createdAt: ts,
              updatedAt: ts,
            },
          }));
        }
        created.push({ ...carton, items });
      }

      await recomputeShipmentTotals(t, shipmentId);
      await writeRouteAuditLog({
        prisma: t, actorId, source: 'route:shipping:packing',
        operation: 'PACKING_CARTONS_REPLACE', targetType: 'Shipment', targetId: shipmentId,
        ...(options?.auditTransactionId ? { transactionId: options.auditTransactionId } : {}),
        after: { cartonCount: created.length },
        ip: ip || null,
      });
      return created;
}

export async function replaceShipmentCartons(
  prisma: PrismaClient,
  shipmentId: string,
  cartons: ShipmentCartonInput[],
  actorId: string,
  ip?: string | null,
  options?: { actor?: TokenPayload | null },
): Promise<PackingResult<{ cartons: any[] }>> {
  try {
    const result = await (prisma as any).$transaction(async (t: any) => {
      return replaceShipmentCartonsTx(t, shipmentId, cartons, actorId, ip, options);
    });
    return { ok: true, data: { cartons: result } };
  } catch (e: any) {
    return { ok: false, error: toPackingError(e) };
  }
}
