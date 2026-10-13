import { orderLineDeliveryError } from '../shared/orderTradeTerms';
import { refreshOrderQuantityHeader } from '../shared/orderQuantityProjection';
import { normalizeOrderQuantityUnit, parseOrderQuantity, OrderQuantityError } from '../shared/orderQuantitySummary';
/**
 * ERP-P1-order-line-mutation-route-foundation
 *
 * OrderLine create/update service（route + Agent flow 共用契约）。
 * OrderLine create/update + syncOrderLineEntityReferences + AuditLog 同事务闭环，失败 fail closed。
 * 显式校验 parent Order 存在且未 deleted。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { syncOrderLineEntityReferences, deactivateEntityLinks } from '../entities/sync';
import { nextItemNo } from './orderLineItems';
import { assertFabricAllowed } from '../products/fabricExclusivityService';
import { validateTolerancePercentInput } from './toleranceService';
import { dependencyCheckFailedError } from './orderLifecycleService';
import { logger } from '../lib/logger';
import type { TokenPayload } from '../auth/service';
import { authorizeOrderLineWrite, lockedOrderLine, requireOrderLineWriteIdentity, orderLineWriteFailure, OrderLineWriteError, type OrderLineWriteErrorCode } from './orderLineWriteAccess';
import { businessError, isBusinessError, lookupErrorCode } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { normalizeRequiredSampleFamilies, RequiredSampleFamiliesError } from './orderRequiredSampleFamilies';
import { GarmentSizeBreakdownError, normalizeGarmentSizeBreakdown } from './garmentSizeBreakdown';
import { normalizeGarmentFulfillment, assertAllocationCapacity } from './internalFabricPolicy';
import { produceManualOrderLineSource } from './manualOrderLineSource';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { FABRIC_SUPPLY_FIELDS } from './fabricCommissionPolicy';
import { assertFabricSupplyTermsParty } from './fabricSupplyTermsService';

export type OrderLineMutationErrorCode =
  | 'INVALID_INPUT'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_LINE_NOT_FOUND'
  | 'DUPLICATE_ITEM_NO'
  | 'CREATE_LINE_FAILED'
  | 'UPDATE_LINE_FAILED'
  | OrderLineWriteErrorCode;

export interface OrderLineMutationError {
  code: OrderLineMutationErrorCode;
  message: string;
}

export interface CreateOrderLineParams {
  prisma: PrismaClient;
  /** Reuse the parent manual-order transaction; never commit a partial main order. */
  transaction?: Prisma.TransactionClient;
  orderId: string;
  itemNo?: string; // 可选：不传则事务内自动计算下一个
  materialCode?: string;
  description?: string;
  quantity: number | string;
  unit?: string;
  unitPrice?: number | string;
  type?: string; // 从 parent Order.type 透传，决定 linkKind
  fieldSources?: Record<string, unknown>;
  actorId?: string;
  /** Verified server caller only. Required at execution; actorId is audit compatibility. */
  trustedActor?: TokenPayload;
  extra?: Record<string, unknown>; // 其他可写字段（millQuality/width 等）
}

export interface CreateOrderLineResult {
  ok: boolean;
  error?: OrderLineMutationError;
  data?: { line: any; auditId: string };
}

/** Manual terms cannot claim a derived customer/system rule or promote a DB
 * default into an agreed tolerance. Keep omitted terms unknown and never let
 * Decimal(5,2) silently round a different contractual percentage. */
function normalizeManualShipmentTerms(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  const has = (field: string) => Object.prototype.hasOwnProperty.call(input, field);
  if (has('partialShipmentAllowed') && input.partialShipmentAllowed !== null && typeof input.partialShipmentAllowed !== 'boolean') {
    throw businessError('INVALID_INPUT', '分批出运约定须为明确的允许、禁止或尚未明确。');
  }
  if (has('toleranceSource') && input.toleranceSource !== null && input.toleranceSource !== 'line_override') {
    throw businessError('INVALID_INPUT', '人工容差来源只能登记为本条目明确约定，不能自报客户或系统标准。');
  }
  if (has('tolerancePercent')) {
    const value = input.tolerancePercent;
    if ((typeof value !== 'number' && typeof value !== 'string')
      || (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) {
      throw businessError('INVALID_INPUT', '溢短装容差须为 0–100 的明确数值；清除约定请将容差来源设为尚未明确。');
    }
    const checked = validateTolerancePercentInput(value);
    if (!checked.ok) throw businessError('INVALID_INPUT', checked.message);
    const decimal = new Prisma.Decimal(typeof value === 'string' ? value.trim() : value);
    if (decimal.decimalPlaces() > 2) throw businessError('INVALID_INPUT', '溢短装容差最多保留两位小数，不能自动舍入商业约定。');
    normalized.tolerancePercent = decimal.toString();
    if (!has('toleranceSource')) normalized.toleranceSource = 'line_override';
  } else if (input.toleranceSource === 'line_override') {
    throw businessError('INVALID_INPUT', '登记本条目人工容差时须同时填写明确百分比，不能使用默认数值充当约定。');
  }
  return normalized;
}

function exactLineAmount(quantityValue: unknown, unitPriceValue: unknown): Prisma.Decimal {
  const quantity = new Prisma.Decimal(parseOrderQuantity(quantityValue));
  const unitPrice = new Prisma.Decimal(unitPriceValue as Prisma.Decimal | number | string);
  const amount = quantity.mul(unitPrice);
  if (amount.decimalPlaces() > 4) throw businessError('INVALID_INPUT', '条目金额超过系统精度（最多四位小数），请明确填写约定金额。');
  return amount;
}

async function refreshOrderAmountsFromLines(tx: any, orderId: string): Promise<void> {
  const lines = await tx.orderLine.findMany({ where: { orderId }, select: { netValue: true } });
  if (lines.some((line: any) => line.netValue == null)) return;
  const total = lines.reduce((sum: Prisma.Decimal, line: any) => sum.add(line.netValue), new Prisma.Decimal(0));
  if (total.decimalPlaces() > 4) throw businessError('INVALID_INPUT', '主单金额超过系统精度（最多四位小数），请核对各条目金额。');
  await tx.order.update({ where: { id: orderId }, data: { totalNet: total, contractAmount: total, quoteAmount: total } });
}

export async function createOrderLine(params: CreateOrderLineParams): Promise<CreateOrderLineResult> {
  const { prisma, orderId, itemNo, materialCode, description, quantity, unit, unitPrice, type, fieldSources, trustedActor, extra } = params;
  const now = BigInt(Date.now());
  if (extra && ['id', 'orderId', 'quantity', 'unit'].some(key => Object.prototype.hasOwnProperty.call(extra, key))) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: '订单行 ID 与父订单不可通过附加字段改写。' } };
  }

  try {
    requireOrderLineWriteIdentity(trustedActor);
    const createInTransaction = async (tx: any) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const { order, actor } = await authorizeOrderLineWrite(tx, orderId, trustedActor, 'create');
      if (order.status !== 'Pending') {
        throw businessError('CONFLICT', '正式订单新增条目必须通过原订单的订单变更审批。');
      }
      const actorId = actor.userId;

      // P1-3 客户专属面料校验（fail-closed：行客供品号/品色号命中他人独占面料 → 409，违规尝试留痕）
      const exclusive = await assertFabricAllowed(tx, {
        customer: { customerRelationId: order.customerRelationId, customerName: order.customer },
        productKeys: {
          clientCode: materialCode ?? null,
          millQuality: (extra?.millQuality as string | undefined) ?? null,
          clientCodeCustomerHint: order.customerRelationId,
        },
        context: 'order-line:create',
        actorId,
        documentRef: { orderId, itemNo: itemNo || 'auto' },
      }, prisma);
      if (!exclusive.ok) {
        throw Object.assign(new Error(exclusive.error.message), { code: exclusive.error.code, statusCode: exclusive.error.status });
      }

      // 事务内计算 lineNumber + itemNo（基于 tx.orderLine.findMany，避免 route/service contract drift）
      const existingLines = await tx.orderLine.findMany({ where: { orderId }, select: { itemNo: true } });
      const existingItemNos = existingLines.map((l: any) => l.itemNo).filter(Boolean) as string[];
      const finalItemNo = itemNo || nextItemNo(existingItemNos);
      const lineNumber = existingLines.length + 1;

      // 重复 itemNo 校验
      if (itemNo && existingItemNos.includes(itemNo)) {
        throw Object.assign(new Error(`OrderLine with itemNo ${itemNo} already exists in order ${orderId}`), { code: 'DUPLICATE_ITEM_NO', statusCode: 409 });
      }

      const lineId = `${orderId}__${finalItemNo}`;
      const lineType = type || order.type;
      const lineIsGarment = String(order.businessLine ?? lineType ?? '').trim().toLowerCase() === 'garment';
      let normalizedExtra = extra ? normalizeManualShipmentTerms(extra) : extra;
      if (extra && FABRIC_SUPPLY_FIELDS.some(key => Object.prototype.hasOwnProperty.call(extra, key))) {
        normalizedExtra = { ...normalizedExtra, ...await assertFabricSupplyTermsParty(tx, actor,
          { id: lineId, ...extra }, String(order.businessLine ?? lineType ?? '').toLowerCase()) };
      }
      if (extra && ('fulfillmentMode' in extra || 'cmtIncludedItems' in extra)) {
        if (!lineIsGarment) throw businessError('INVALID_INPUT', '履约模式只适用于成衣条目。');
        normalizedExtra = { ...normalizedExtra, ...normalizeGarmentFulfillment(extra) };
      }
      if (extra && Object.prototype.hasOwnProperty.call(extra, 'sizeBreakdown')) {
        if (!lineIsGarment && extra.sizeBreakdown != null) throw businessError('INVALID_INPUT', '尺码矩阵只适用于成衣订单条目。');
        if (lineIsGarment) {
          try { normalizedExtra = { ...normalizedExtra, sizeBreakdown: normalizeGarmentSizeBreakdown(extra.sizeBreakdown, quantity) }; }
          catch (error) {
            if (error instanceof GarmentSizeBreakdownError || error instanceof OrderQuantityError)
              throw businessError('INVALID_INPUT', error.message);
            throw error;
          }
        }
      }
      let requiredSampleFamilies: string[];
      try { requiredSampleFamilies = normalizeRequiredSampleFamilies(order, extra?.requiredSampleFamilies); }
      catch (error) {
        if (error instanceof RequiredSampleFamiliesError) throw businessError('INVALID_INPUT', error.message);
        throw error;
      }
      if (!extra || !Object.prototype.hasOwnProperty.call(extra, 'exMillDate')) {
        normalizedExtra = { ...normalizedExtra, exMillDate: order.clientDate || order.dueDate || null };
      }
      const deliveryError = orderLineDeliveryError(order, normalizedExtra || {});
      if (deliveryError) throw businessError('INVALID_INPUT', deliveryError);
      let created: any;
      const { manualSpecification, ...storedExtra } = normalizedExtra || {};
      const normalizedQuantity = parseOrderQuantity(quantity);
      const lineAmount = unitPrice == null ? null : exactLineAmount(normalizedQuantity, unitPrice);
      try { created = await tx.orderLine.create({
        data: {
          id: lineId,
          orderId,
          lineNumber,
          itemNo: finalItemNo,
          materialCode: materialCode || null,
          description: description || null,
          quantity: normalizedQuantity,
          unit: unit || null,
          unitPrice: unitPrice ?? null,
          netValue: lineAmount,
          status: 'Pending',
          fieldSources: fieldSources || { _manual: true },
          ...storedExtra,
          requiredSampleFamilies,
        } as any,
      }); } catch (error) {
        // Serializable contenders can share an earlier empty line-list
        // snapshot and both choose the same generated id. Only the actual
        // OrderLine create/id-constraint failure is this business conflict;
        // an unrelated upsert/audit uniqueness failure must remain a failure.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
          && Array.isArray(error.meta?.target) && error.meta.target.length === 1 && error.meta.target[0] === 'id') {
          throw new OrderLineWriteError('CONFLICT', lookupErrorCode('CONFLICT')!.message);
        }
        throw error;
      }

      if (manualSpecification !== undefined) {
        const manual = await produceManualOrderLineSource(tx, order, created, manualSpecification, actorId);
        created = await tx.orderLine.update({ where: { id: created.id }, data: manual });
      }

      await refreshOrderAmountsFromLines(tx, orderId);
      await refreshOrderQuantityHeader(tx, orderId);
      // sync（同事务，fail closed）— type 从 parent order 透传
      const lineForSync = { ...created, type: lineType };
      await syncOrderLineEntityReferences(prisma, lineForSync as any, { source: 'route:order-line:create' }, tx);

      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:order-line:create',
        operation: 'create_order_line', targetType: 'OrderLine', targetId: created.id,
        after: { id: created.id, orderId, itemNo: finalItemNo, materialCode: materialCode || null, lineNumber, quantity: created.quantity.toString(), unit: created.unit,
          partialShipmentAllowed: created.partialShipmentAllowed ?? null, tolerancePercent: created.tolerancePercent?.toString() ?? null,
          toleranceSource: created.toleranceSource ?? null },
      });

      // hydrate parent order（前端 serializeOrderLine 读 line.order）
      return { line: { ...created, order: await tx.order.findUniqueOrThrow({ where: { id: orderId } }) }, auditId };
    };
    const result = params.transaction
      ? await createInTransaction(params.transaction)
      : await prisma.$transaction(createInTransaction, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ok: true, data: result };
  } catch (e: any) {
    if (e instanceof OrderQuantityError) return { ok: false, error: { code: 'INVALID_INPUT', message: e.message } };
    if (e instanceof DevelopmentDomainError && ['INVALID_INPUT', 'CONFLICT'].includes(e.code)) return { ok: false, error: { code: e.code as OrderLineMutationErrorCode, message: e.message } };
    const denied = orderLineWriteFailure(e); if (denied) return { ok: false, error: denied };
    const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR' });
    if (isBusinessError(e)) return { ok: false, error: { code: e.code as OrderLineMutationErrorCode, message: safe.message } };
    return { ok: false, error: { code: 'CREATE_LINE_FAILED', message: safe.message } };
  }
}

export interface UpdateOrderLineParams {
  prisma: PrismaClient;
  lineId: string;
  patch: Record<string, unknown>;
  actorId?: string;
  trustedActor?: TokenPayload;
}

export interface UpdateOrderLineResult {
  ok: boolean;
  error?: OrderLineMutationError;
  data?: { line: any; auditId: string };
}

// Once the order is submitted for approval, the line is a business commitment.
// Contract/specification changes belong to the approved order-change flow, and
// fulfillment facts belong to their owning workflow (QC/shipping/finance).
// The generic line editor may only append a harmless note after that boundary.
const ORDER_LINE_DIRECT_FIELDS_AFTER_SUBMISSION = new Set(['notes', 'fieldSources']);
export function submittedOrderLinePatchRejection(orderStatus: string, patch: Record<string, unknown>): string | null {
  if (orderStatus === 'Pending') return null;
  return Object.keys(patch).some(key => !ORDER_LINE_DIRECT_FIELDS_AFTER_SUBMISSION.has(key))
    ? '订单已提交审批，条目业务变更必须通过订单变更审批；生产、质检、出运和财务数据请在对应业务模块操作。'
    : null;
}

export async function updateOrderLine(params: UpdateOrderLineParams): Promise<UpdateOrderLineResult> {
  const { prisma, lineId, patch, trustedActor } = params;
  let normalizedPatch = patch;
  const now = BigInt(Date.now());
  if (['id', 'orderId'].some(key => Object.prototype.hasOwnProperty.call(patch, key))) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: '订单行 ID 与父订单不可改写。' } };
  }

  try {
    requireOrderLineWriteIdentity(trustedActor);
    const result = await prisma.$transaction(async (tx: any) => {
      const hint = await tx.orderLine.findUnique({ where: { id: lineId }, select: { orderId: true } });
      if (!hint) {
        throw Object.assign(new Error(`OrderLine ${lineId} not found`), { code: 'ORDER_LINE_NOT_FOUND', statusCode: 404 });
      }
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${hint.orderId} FOR UPDATE`;
      const { order, actor } = await authorizeOrderLineWrite(tx, hint.orderId, trustedActor, 'update');
      const actorId = actor.userId;
      const existing = await lockedOrderLine(tx, lineId, order.id);

      // A submitted order is a locked business commitment. Do not let the
      // generic row endpoint bypass order-change approval for price/spec/terms,
      // or overwrite facts owned by production, QC, shipping, or finance.
      // Harmless note edits remain available and auditable.
      const submittedPatchError = submittedOrderLinePatchRejection(order.status, patch);
      if (submittedPatchError) throw businessError('CONFLICT', submittedPatchError);
      normalizedPatch = normalizeManualShipmentTerms(patch);
      if (['agreedDeliveryDate', 'deliveryAgreementBasis', 'exMillDate', 'deliveryDate'].some(key => key in patch)) {
        const error = orderLineDeliveryError(order, { ...existing, ...patch });
        if (error) throw businessError('INVALID_INPUT', error);
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'requiredSampleFamilies')) {
        try { normalizedPatch = { ...normalizedPatch, requiredSampleFamilies: normalizeRequiredSampleFamilies(order, patch.requiredSampleFamilies) }; }
        catch (error) {
          if (error instanceof RequiredSampleFamiliesError) throw businessError('INVALID_INPUT', error.message);
          throw error;
        }
      }

      const orderLineType = String(order.businessLine ?? order.type ?? '').trim().toLowerCase();
      if (FABRIC_SUPPLY_FIELDS.some(key => Object.prototype.hasOwnProperty.call(patch, key))) {
        normalizedPatch = { ...normalizedPatch, ...await assertFabricSupplyTermsParty(tx, actor,
          { ...existing, ...patch }, orderLineType) };
      }
      if ('fulfillmentMode' in patch || 'cmtIncludedItems' in patch) {
        if (orderLineType !== 'garment') throw businessError('INVALID_INPUT', '履约模式只适用于成衣条目。');
        normalizedPatch = { ...normalizedPatch, ...normalizeGarmentFulfillment({ ...existing, ...patch }) };
      }
      const hasSizeBreakdown = Object.prototype.hasOwnProperty.call(patch, 'sizeBreakdown');
      const hasSizeRelevantQuantity = Object.prototype.hasOwnProperty.call(patch, 'quantity');
      if (hasSizeBreakdown || (hasSizeRelevantQuantity && existing.sizeBreakdown != null)) {
        const nextBreakdown = hasSizeBreakdown ? patch.sizeBreakdown : existing.sizeBreakdown;
        if (orderLineType !== 'garment' && nextBreakdown != null)
          throw businessError('INVALID_INPUT', '尺码矩阵只适用于成衣订单条目。');
        if (orderLineType === 'garment') {
          try {
            normalizedPatch = { ...normalizedPatch, sizeBreakdown: normalizeGarmentSizeBreakdown(nextBreakdown,
              hasSizeRelevantQuantity ? patch.quantity : existing.quantity.toString()) };
          } catch (error) {
            if (error instanceof GarmentSizeBreakdownError || error instanceof OrderQuantityError)
              throw businessError('INVALID_INPUT', error.message);
            throw error;
          }
        }
      }

      // Draft quantity/unit validation remains strict before the order is
      // submitted. Submitted orders are already rejected above for all fields
      // except notes/provenance, so quantity and unit cannot bypass approval.
      const hasQuantity = Object.prototype.hasOwnProperty.call(patch, 'quantity');
      const hasUnit = Object.prototype.hasOwnProperty.call(patch, 'unit');
      if (hasQuantity || hasUnit) {
        const currentQuantity = parseOrderQuantity(existing.quantity.toString(), { allowZero: true });
        const nextQuantity = hasQuantity ? parseOrderQuantity(patch.quantity) : currentQuantity;
        const currentUnit = normalizeOrderQuantityUnit(existing.unit);
        const rawUnit = hasUnit ? patch.unit : existing.unit;
        const nextUnit = normalizeOrderQuantityUnit(rawUnit);
        if (rawUnit != null && String(rawUnit).trim() && nextUnit == null) {
          throw new OrderQuantityError('INVALID_QUANTITY', '数量单位未识别，请选择系统支持的单位。');
        }
        const quantitySemanticsChanged = nextQuantity !== currentQuantity || nextUnit !== currentUnit;
        if (quantitySemanticsChanged && order.status !== 'Pending') {
          throw businessError('CONFLICT', '订单已提交确认，数量或单位变更必须通过订单变更申请审批。');
        }
        if (order.orderPurpose === 'internal_fabric_supply') {
          const active = await tx.fabricLineAllocation.findMany({ where: { fabricOrderLineId: lineId, status: 'active' } });
          if (active.length) {
            if (nextUnit !== 'M') throw businessError('CONFLICT', '已分配内部面料米数，不能改成其他单位。');
            assertAllocationCapacity(nextQuantity, active.map((row: any) => row.metres.toString()));
          }
        }
      }

      // P1-3 客户专属面料校验：仅 patch 触碰产品锚（materialCode/millQuality）时执行
      if ('materialCode' in patch || 'millQuality' in patch) {
        const exclusive = await assertFabricAllowed(tx, {
          customer: { customerRelationId: order.customerRelationId, customerName: order.customer },
          productKeys: {
            clientCode: (patch.materialCode as string | undefined) ?? existing.materialCode ?? null,
            millQuality: (patch.millQuality as string | undefined) ?? existing.millQuality ?? null,
            clientCodeCustomerHint: order.customerRelationId,
          },
          context: 'order-line:update',
          actorId,
          documentRef: { orderId: existing.orderId, lineId },
        }, prisma);
        if (!exclusive.ok) {
          throw Object.assign(new Error(exclusive.error.message), { code: exclusive.error.code, statusCode: exclusive.error.status });
        }
      }

      const manualInput = patch.manualSpecification ?? (existing.confirmedSourceType === 'ManualOrderLine' && order.status === 'Pending'
        && ['description', 'materialCode', 'quantity', 'unit', 'sizeBreakdown', 'fulfillmentMode', 'cmtIncludedItems'].some(key => key in patch)
        ? existing.specSnapshot?.manualOrderLine : undefined);
      const { manualSpecification: _manualInput, ...storedPatch } = normalizedPatch;
      normalizedPatch = storedPatch;
      if (manualInput !== undefined) {
        const source = existing.specSnapshot?.manualOrderLine;
        const input = manualInput === source ? { factoryRelationId: source.factoryRelationId, specification: source.specification,
          agreementBasis: source.agreementBasis, evidence: source.evidence } : manualInput;
        const nextLine = { ...existing, ...storedPatch, ...(Object.prototype.hasOwnProperty.call(patch, 'quantity') ? { quantity: parseOrderQuantity(patch.quantity) } : {}) };
        normalizedPatch = { ...storedPatch, ...await produceManualOrderLineSource(tx, order, nextLine, input, actorId) };
      }
      const quantityChanged = Object.prototype.hasOwnProperty.call(patch, 'quantity');
      const unitPriceChanged = Object.prototype.hasOwnProperty.call(patch, 'unitPrice');
      if ((quantityChanged || unitPriceChanged) && !Object.prototype.hasOwnProperty.call(patch, 'netValue')) {
        const nextQuantity = quantityChanged ? parseOrderQuantity(patch.quantity) : existing.quantity.toString();
        const nextUnitPrice = unitPriceChanged ? patch.unitPrice : existing.unitPrice;
        normalizedPatch = { ...normalizedPatch, netValue: nextUnitPrice == null ? null : exactLineAmount(nextQuantity, nextUnitPrice) };
      }
      const updated = await tx.orderLine.update({
        where: { id: lineId },
        data: { ...normalizedPatch, ...(Object.prototype.hasOwnProperty.call(patch, 'quantity') ? { quantity: parseOrderQuantity(patch.quantity) } : {}) } as any,
      });

      if (quantityChanged || unitPriceChanged || Object.prototype.hasOwnProperty.call(patch, 'netValue')) await refreshOrderAmountsFromLines(tx, existing.orderId);
      if (quantityChanged || Object.prototype.hasOwnProperty.call(patch, 'unit')) await refreshOrderQuantityHeader(tx, existing.orderId);
      // sync（materialCode 变化时）— type 从 parent order 透传
      const lineForSync = { ...updated, type: order.type };
      await syncOrderLineEntityReferences(prisma, lineForSync as any, { source: 'route:order-line:update' }, tx);

      // Audit the stored before/after values for every edited field, including
      // harmless formal-order notes. Decimal/bigint values remain JSON safe.
      const auditFields = [...new Set(['materialCode', 'quantity', 'unit', ...Object.keys(normalizedPatch)])];
      const auditSnapshot = (line: Record<string, unknown>) => Object.fromEntries(auditFields.map(field => {
        const value = line[field];
        return [field, (field === 'quantity' && value != null) || typeof value === 'bigint' || value instanceof Prisma.Decimal
          ? value.toString() : value ?? null];
      }));
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:order-line:update',
        operation: 'update_order_line', targetType: 'OrderLine', targetId: lineId,
        before: auditSnapshot(existing),
        after: auditSnapshot(updated),
      });

      // hydrate parent order（前端 serializeOrderLine 读 line.order）
      return { line: { ...updated, order: await tx.order.findUniqueOrThrow({ where: { id: existing.orderId } }) }, auditId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return { ok: true, data: result };
  } catch (e: any) {
    if (e instanceof OrderQuantityError) return { ok: false, error: { code: 'INVALID_INPUT', message: e.message } };
    if (e instanceof DevelopmentDomainError && ['INVALID_INPUT', 'CONFLICT'].includes(e.code)) return { ok: false, error: { code: e.code as OrderLineMutationErrorCode, message: e.message } };
    const denied = orderLineWriteFailure(e); if (denied) return { ok: false, error: denied };
    const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR' });
    if (isBusinessError(e)) return { ok: false, error: { code: e.code as OrderLineMutationErrorCode, message: safe.message } };
    return { ok: false, error: { code: 'UPDATE_LINE_FAILED', message: safe.message } };
  }
}

export async function deleteOrderLine(params: {
  prisma: PrismaClient;
  lineId: string;
  actorId?: string;
  trustedActor?: TokenPayload;
}): Promise<{ ok: true; data: { auditId: string } } | { ok: false; error: { code: string; message: string } }> {
  const { prisma, lineId, trustedActor } = params;
  try {
    requireOrderLineWriteIdentity(trustedActor);
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const hint = await tx.orderLine.findUnique({ where: { id: lineId }, select: { orderId: true } });
      if (!hint) throw Object.assign(new Error(`order line ${lineId} not found`), { code: 'ORDER_LINE_NOT_FOUND', statusCode: 404 });
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${hint.orderId} FOR UPDATE`;
      const { order, actor } = await authorizeOrderLineWrite(tx, hint.orderId, trustedActor, 'delete');
      if (order.status !== 'Pending') {
        throw businessError('CONFLICT', '正式订单删除条目必须通过原订单的订单变更审批。');
      }
      const actorId = actor.userId;
      const existing = await lockedOrderLine(tx, lineId, order.id);

      // 检查是否有关联的发货/发票记录（通过 EntityLink 查）
      //
      // ★ B14 同形缺陷（refs G3-LA · G4.4 缺口③，Step 4 全库派生扫描命中）：
      // 原先这里挂着 `.catch(() => 0)`，而 0 在下一行是**判定值** —— 查询一失败就被当成
      // 「这行没有关联单据」⇒ **跳过** deactivateEntityLinks，紧接着执行**硬删** `orderLine.delete`
      // ⇒ 留下一批指向已删行的 active EntityLink 孤儿（比 deleteOrder 那五路更硬：行是真没了）。
      // 与 deleteOrder 五路同口径：查不出来就在事务内抛出 ⇒ Prisma 回滚整笔删除（fail-closed）。
      //
      // ★★ Step 0 的编译器当场报出这一路**今天就坏**：`EntityLinkWhereInput` 没有
      // sourceType/sourceId 这两个字段（真名 fromType/fromId，见 schema.prisma:1781-1798，
      // 与同口径的 deactivateEntityLinks 一致）。所以它不是「将来可能漂移」，而是**每次调用**
      // 都抛 PrismaClientValidationError —— 客户端侧错误不污染 PG 事务（构造验证 §2 P-B），
      // 旧的 `.catch(() => 0)` 便把它吞成 0 ⇒ 每一次删订单行都跳过 EntityLink 清理、
      // 紧接着硬删 ⇒ 稳定产出指向已删行的 active 孤儿链。字段名与本批一并改对。
      let linkCount: number;
      try {
        linkCount = await tx.entityLink.count({ where: { fromType: 'orderLine', fromId: lineId, deletedAt: null } });
      } catch (e) {
        logger.error('[deleteOrderLine] 关联校验失败，拒绝删除（fail-closed）', {
          lineId, error: (e as Error)?.message ?? String(e),
        });
        throw dependencyCheckFailedError();
      }
      if (linkCount > 0) {
        await deactivateEntityLinks(tx, 'orderLine', lineId, BigInt(Date.now()));
      }

      await tx.orderLine.delete({ where: { id: lineId } });
      await refreshOrderAmountsFromLines(tx, existing.orderId);
      await refreshOrderQuantityHeader(tx, existing.orderId);

      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:order-line:delete',
        operation: 'delete_order_line', targetType: 'OrderLine', targetId: lineId,
        before: { id: lineId, orderId: existing.orderId, itemNo: existing.itemNo, lineNumber: existing.lineNumber, quantity: existing.quantity.toString(), unit: existing.unit },
      });
      return { auditId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ok: true, data: result };
  } catch (e: any) {
    if (e instanceof OrderQuantityError) return { ok: false, error: { code: 'INVALID_INPUT', message: e.message } };
    const denied = orderLineWriteFailure(e); if (denied) return { ok: false, error: denied };
    const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR' });
    if (isBusinessError(e)) return { ok: false, error: { code: e.code, message: safe.message } };
    return { ok: false, error: { code: 'DELETE_LINE_FAILED', message: safe.message } };
  }
}
