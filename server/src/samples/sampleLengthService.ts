import { businessNowDate } from '../shared/businessClock';
/**
 * sampleLengthService.ts — D6-Q1 米样长度口径（2026-09-16 拍板）
 *
 * 业务规则（设计真源：docs/业务变体矩阵-2026-09-16.md §D6 拍板 1）：
 *   - 米样升为 Decimal 长度口径：Sample.lengthQty/lengthUnit 类型化字段（单位 M/YD 可选），
 *     取代 attachments JSON 里不可校验/聚合的 sampleQuantity 语义（历史 JSON 不回填不动）。
 *   - 动作：分割 cut（一张米样剪一段给客户，父子两样）、余量退回 return、损耗入账 loss、
 *     从工厂借入 borrow_in / 归还 borrow_return。
 *   - 样卡（SampleCardItem）保持张数语义不动——两者是不同实物。
 *
 * 账务纪律（与 StockMovement 同范式）：
 *   - Sample.lengthQty 是当前持有长度快照真源；SampleLengthMovement 是 append-only 流水。
 *   - 同一样品全部流水必须同 lengthUnit；M 与 YD 不可互算（报错优于算错——矩阵 §三 铁律）。
 *   - 持有长度不可为负（减法前校验，fail-closed）。
 *   - cut 新建子样：type/subType/source/sourceOrderId/supplier/customer 继承父样，lengthQty=剪出量。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { createInventoryService } from '../inventory/inventoryService';
import { createBillingItemInTx } from '../finance/billingItemService';
import { logger } from '../lib/logger';
import { lockSampleBusinessSources, resolveSampleBusinessContext } from './sampleBusinessContext';
import { cloneSampleOrigins, lockSampleOriginParents, sampleOriginLockHints } from './sampleOriginService';

export const SAMPLE_LENGTH_UNITS = ['M', 'YD'] as const;
export type SampleLengthUnit = (typeof SAMPLE_LENGTH_UNITS)[number];

// D7-① 转化通道新增：to_bulk（米样转大货）/ to_resale（米样转售）
export const SAMPLE_LENGTH_MOVEMENT_TYPES = ['cut', 'give', 'return', 'loss', 'borrow_in', 'borrow_return', 'to_bulk', 'to_resale'] as const;
export type SampleLengthMovementType = (typeof SAMPLE_LENGTH_MOVEMENT_TYPES)[number];

/** 减方向的动作：持有长度减少（cut/give/return/loss 是从本样减去；borrow_return 是归还工厂） */
const OUTBOUND_TYPES: ReadonlySet<string> = new Set(['cut', 'give', 'return', 'loss', 'borrow_return', 'to_bulk', 'to_resale']);
/** 增方向的动作 */
const INBOUND_TYPES: ReadonlySet<string> = new Set(['borrow_in']);

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, error: { code, message, status } });
const ok = <T>(data: T): Result<T> => ({ ok: true, data });

const D = (v: unknown) => new Prisma.Decimal(String(v ?? 0));
const q4 = (v: Prisma.Decimal) => new Prisma.Decimal(v.toFixed(4));

export function createSampleLengthService(prisma: PrismaClient) {

  /** Length is a fabric operation, never evidence that the record is fabric.
   * Lock authoritative parents first, then re-read the locked sample so neither
   * a concurrent source change nor a stale balance can authorize a mutation. */
  async function fabricSampleForWrite(tx: any, sampleId: string): Promise<Result<any>> {
    const initial = await tx.sample.findUnique({ where: { id: sampleId } });
    if (!initial || initial.deletedAt != null) return fail('NOT_FOUND', `样品 ${sampleId} 不存在`, 404);
    const originParents = await sampleOriginLockHints(tx, [sampleId]);
    await lockSampleOriginParents(tx, { ...originParents,
      caseIds: [...originParents.caseIds, ...(initial.sourceCaseId ? [initial.sourceCaseId] : [])] });
    // All cases and native batches precede orders/assets and the Sample row.
    // Case locks are already held; do not discover new parents after a child.
    await lockSampleBusinessSources(tx, [{ sourceOrderId: initial.sourceOrderId, productAssetId: initial.productAssetId }]);
    const context = await resolveSampleBusinessContext(tx, initial);
    if (context.status !== 'resolved') {
      return fail(
        context.status === 'conflict' ? 'SAMPLE_BUSINESS_CONTEXT_CONFLICT' : 'SAMPLE_BUSINESS_CONTEXT_UNRESOLVED',
        context.status === 'conflict'
          ? '样品的开发案、订单或产品档案业务线冲突，请先核对来源，不能进行米样长度操作。'
          : '样品业务线尚未确认，请先核对有效的开发案、订单或产品档案来源，不能进行米样长度操作。',
        409,
      );
    }
    if (context.businessLine !== 'fabric') {
      return fail('SAMPLE_LENGTH_BUSINESS_LINE_MISMATCH', '成衣样品不能进行米样长度操作，请使用成衣样品的实物管理流程。', 409);
    }
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id" = ${sampleId} FOR UPDATE`);
    const currentOriginParents = await sampleOriginLockHints(tx, [sampleId]);
    if (JSON.stringify(currentOriginParents) !== JSON.stringify(originParents)) {
      return fail('SAMPLE_SOURCE_CHANGED', '样品的精确批次来源在锁定时变化，请刷新后重试。', 409);
    }
    const sample = await tx.sample.findUnique({ where: { id: sampleId } });
    if (!sample || sample.deletedAt != null) return fail('NOT_FOUND', `样品 ${sampleId} 不存在`, 404);
    const sourceKeys = ['sourceCaseId', 'sourceOrderId', 'productAssetId'] as const;
    if (sourceKeys.some(key => String(sample[key] ?? '').trim() !== String(initial[key] ?? '').trim())) {
      return fail('SAMPLE_BUSINESS_CONTEXT_CONFLICT', '样品来源在校验期间发生变化，请刷新并核对来源后再操作。', 409);
    }
    return ok(sample);
  }

  /** 校验数量 > 0 且单位合法 */
  function validateQtyUnit(quantity: unknown, unit: unknown): { qty: Prisma.Decimal; unit: SampleLengthUnit } | { err: ReturnType<typeof fail> } {
    let qty: Prisma.Decimal;
    try {
      qty = D(quantity);
    } catch {
      return { err: fail('INVALID_INPUT', `数量非法：${JSON.stringify(quantity)}`) };
    }
    if (!qty.isFinite() || qty.lte(0)) {
      return { err: fail('INVALID_INPUT', `数量必须 > 0，收到 ${String(quantity)}`) };
    }
    const u = String(unit ?? '').trim().toUpperCase();
    if (!(SAMPLE_LENGTH_UNITS as readonly string[]).includes(u)) {
      return { err: fail('INVALID_INPUT', `单位必须是 ${SAMPLE_LENGTH_UNITS.join(' / ')}，收到 ${String(unit)}`) };
    }
    return { qty: q4(qty), unit: u as SampleLengthUnit };
  }

  /** 写流水（append-only） */
  async function writeMovement(tx: any, data: {
    sampleId: string; type: string; quantity: Prisma.Decimal; unit: string;
    counterpartSampleId?: string | null; balanceAfter?: Prisma.Decimal | null;
    /** D7-① 转化通道的目标对象 */
    targetInventoryItemId?: string | null; targetRelationId?: string | null; amount?: Prisma.Decimal | null;
    note?: string | null; operator?: string | null;
  }): Promise<any> {
    return tx.sampleLengthMovement.create({
      data: {
        id: `SLM__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        sampleId: data.sampleId,
        type: data.type,
        quantity: data.quantity,
        unit: data.unit,
        counterpartSampleId: data.counterpartSampleId ?? null,
        balanceAfter: data.balanceAfter ?? null,
        targetInventoryItemId: data.targetInventoryItemId ?? null,
        targetRelationId: data.targetRelationId ?? null,
        amount: data.amount ?? null,
        note: data.note ?? null,
        operator: data.operator ?? null,
        createdAt: BigInt(Date.now()),
      },
    });
  }

  /**
   * 首次登记/初始化米样长度（set）。只允许在尚未建长度账时设置初始值；
   * 后续长度变化必须通过对应的实际业务动作形成流水，不提供盘点修正。
   */
  async function setSampleLength(params: {
    sampleId: string; quantity: unknown; unit: unknown; note?: string | null; operator?: string | null;
  }): Promise<Result<any>> {
    const v = validateQtyUnit(params.quantity, params.unit);
    if ('err' in v) return v.err;
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        const source = await fabricSampleForWrite(tx, params.sampleId);
        if (!source.ok) return source;
        const sample = source.data;
        if (sample.lengthQty != null) {
          return fail('ALREADY_SET', `样品 ${sample.code} 已建长度账（${sample.lengthQty} ${sample.lengthUnit}），调整请走 return/loss/borrow 流水`, 409);
        }
        const updated = await tx.sample.update({
          where: { id: params.sampleId },
          data: { lengthQty: v.qty, lengthUnit: v.unit, updatedAt: BigInt(Date.now()) },
        });
        await writeMovement(tx, {
          sampleId: sample.id, type: 'set', quantity: v.qty, unit: v.unit,
          balanceAfter: v.qty, note: params.note ?? '长度建账', operator: params.operator ?? null,
        });
        await writeRouteAuditLog({
          prisma: tx, actorId: params.operator || 'api', source: 'route:samples:length',
          operation: 'set_sample_length', targetType: 'Sample', targetId: sample.id,
          after: { lengthQty: v.qty.toString(), lengthUnit: v.unit },
        });
        return ok({ sample: updated });
      });
      return result;
    } catch (e: any) {
      logger.error('[SampleLength] set failed', { error: e?.message, sampleId: params.sampleId });
      return fail('SET_FAILED', String(e?.message ?? e), 500);
    }
  }

  /**
   * 长度变动（give/return/loss/borrow_in/borrow_return）。
   * cut 走独立的 cutSampleLength（需要建子样）。
   */
  async function moveSampleLength(params: {
    sampleId: string; type: SampleLengthMovementType; quantity: unknown; note?: string | null; operator?: string | null;
  }): Promise<Result<any>> {
    if (params.type === 'cut') {
      return fail('INVALID_INPUT', '分割请走 cutSampleLength（需要建子样）');
    }
    if (params.type === 'to_bulk' || params.type === 'to_resale') {
      return fail('INVALID_INPUT', params.type === 'to_bulk'
        ? '转大货请走 convertToBulk（需要同事务写入大货库存）'
        : '转售请走 convertToResale（需要同事务创建应收计费项）');
    }
    if (!(SAMPLE_LENGTH_MOVEMENT_TYPES as readonly string[]).includes(params.type)) {
      return fail('INVALID_INPUT', `动作必须是 ${SAMPLE_LENGTH_MOVEMENT_TYPES.join(' / ')}`);
    }
    // 单位从样品账上取（同一米样全程同单位，不允许调用方换单位）
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        const source = await fabricSampleForWrite(tx, params.sampleId);
        if (!source.ok) return source;
        const sample = source.data;
        if (sample.lengthQty == null || !sample.lengthUnit) {
          return fail('NO_LENGTH_ACCOUNT', `样品 ${sample.code} 未建长度账，请先登记米样长度`, 409);
        }
        const qty = q4(D(params.quantity));
        if (!qty.isFinite() || qty.lte(0)) {
          return fail('INVALID_INPUT', `数量必须 > 0，收到 ${String(params.quantity)}`);
        }
        const current = new Prisma.Decimal(sample.lengthQty);
        let balanceAfter: Prisma.Decimal;
        if (OUTBOUND_TYPES.has(params.type)) {
          balanceAfter = current.minus(qty);
          if (balanceAfter.lt(0)) {
            return fail('LENGTH_INSUFFICIENT', `持有长度不足：当前 ${current.toFixed(4)} ${sample.lengthUnit}，本笔 ${qty.toFixed(4)} ${sample.lengthUnit}`, 409);
          }
        } else if (INBOUND_TYPES.has(params.type)) {
          balanceAfter = current.plus(qty);
        } else {
          return fail('INVALID_INPUT', `未支持的动作：${params.type}`);
        }
        const updated = await tx.sample.update({
          where: { id: sample.id },
          data: { lengthQty: q4(balanceAfter), updatedAt: BigInt(Date.now()) },
        });
        await writeMovement(tx, {
          sampleId: sample.id, type: params.type, quantity: qty, unit: sample.lengthUnit,
          balanceAfter: q4(balanceAfter), note: params.note ?? null, operator: params.operator ?? null,
        });
        await writeRouteAuditLog({
          prisma: tx, actorId: params.operator || 'api', source: 'route:samples:length',
          operation: `sample_length_${params.type}`, targetType: 'Sample', targetId: sample.id,
          after: { type: params.type, quantity: qty.toString(), unit: sample.lengthUnit, balanceAfter: q4(balanceAfter).toString() },
        });
        return ok({ sample: updated });
      });
      return result;
    } catch (e: any) {
      logger.error('[SampleLength] move failed', { error: e?.message, sampleId: params.sampleId, type: params.type });
      return fail('MOVE_FAILED', String(e?.message ?? e), 500);
    }
  }

  /**
   * 裁剪分割：从父样剪出 quantity（同单位）给客户。
   * 父样持有长度减少；新建子样（继承 type/subType/来源/工厂/客户，lengthQty=剪出量）；
   * 父子流水互引 counterpartSampleId。剪给客户的那段语义由 note 表达（type=cut）。
   */
  async function cutSampleLength(params: {
    sampleId: string; quantity: unknown; note?: string | null; operator?: string | null;
  }): Promise<Result<any>> {
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        const source = await fabricSampleForWrite(tx, params.sampleId);
        if (!source.ok) return source;
        const parent = source.data;
        if (parent.lengthQty == null || !parent.lengthUnit) {
          return fail('NO_LENGTH_ACCOUNT', `样品 ${parent.code} 未建长度账，请先登记米样长度`, 409);
        }
        const qty = q4(D(params.quantity));
        if (!qty.isFinite() || qty.lte(0)) {
          return fail('INVALID_INPUT', `数量必须 > 0，收到 ${String(params.quantity)}`);
        }
        const current = new Prisma.Decimal(parent.lengthQty);
        const remain = current.minus(qty);
        if (remain.lt(0)) {
          return fail('LENGTH_INSUFFICIENT', `持有长度不足：当前 ${current.toFixed(4)} ${parent.lengthUnit}，要剪 ${qty.toFixed(4)} ${parent.lengthUnit}`, 409);
        }

        // 建子样（继承来源/归属，长度=剪出量；code 由序列生成）
        const childCode = await nextSampleCode(tx);
        const child = await tx.sample.create({
          data: {
            id: `SMP__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            code: childCode,
            type: parent.type,
            subType: parent.subType,
            sourceCaseId: parent.sourceCaseId,
            sourceOrderId: parent.sourceOrderId,
            productAssetId: parent.productAssetId,
            supplierRelationId: parent.supplierRelationId,
            supplierName: parent.supplierName,
            customerRelationId: parent.customerRelationId,
            status: 'draft',
            lengthQty: qty,
            lengthUnit: parent.lengthUnit,
            notes: `由 ${parent.code} 分割（剪出 ${qty.toFixed(4)} ${parent.lengthUnit}）${params.note ? `：${params.note}` : ''}`,
            createdAt: BigInt(Date.now()),
            updatedAt: BigInt(Date.now()),
          },
        });

        // A new physical portion retains frozen ancestry, never the parent's
        // canonical projection identity or a new production approval.
        await cloneSampleOrigins(tx, parent.id, child.id, params.operator || 'api');

        const parentAfter = q4(remain);
        await tx.sample.update({
          where: { id: parent.id },
          data: { lengthQty: parentAfter, updatedAt: BigInt(Date.now()) },
        });
        // 父子流水互引
        await writeMovement(tx, {
          sampleId: parent.id, type: 'cut', quantity: qty, unit: parent.lengthUnit,
          counterpartSampleId: child.id, balanceAfter: parentAfter,
          note: params.note ?? null, operator: params.operator ?? null,
        });
        await writeMovement(tx, {
          sampleId: child.id, type: 'cut', quantity: qty, unit: parent.lengthUnit,
          counterpartSampleId: parent.id, balanceAfter: qty,
          note: `自 ${parent.code} 分割`, operator: params.operator ?? null,
        });
        await writeRouteAuditLog({
          prisma: tx, actorId: params.operator || 'api', source: 'route:samples:length',
          operation: 'sample_length_cut', targetType: 'Sample', targetId: parent.id,
          after: { childId: child.id, childCode: child.code, quantity: qty.toString(), unit: parent.lengthUnit, parentBalanceAfter: parentAfter.toString() },
        });
        return ok({ parent: { ...parent, lengthQty: parentAfter }, child });
      });
      return result;
    } catch (e: any) {
      logger.error('[SampleLength] cut failed', { error: e?.message, sampleId: params.sampleId });
      return fail('CUT_FAILED', String(e?.message ?? e), 500);
    }
  }

  /**
   * D7-① **米样转大货**：样品侧减（to_bulk 流水）+ 大货侧增（createStockMovement，referenceType='Sample'）。
   *
   * - **双侧同事务**：`createStockMovement` 支持 `opts.tx`（T3 加的），两侧在同一事务内原子提交，
   *   不会出现「样品扣了但大货没增」。
   * - **大货侧严禁绕过 `createStockMovement` 直改 `InventoryItem.quantity`**（T3 铁律：
   *   绕过 = 丢流水 + 丢并发保护）。
   * - **单位铁律**：样品 `lengthUnit` 与目标库存项 `unit` 必须一致（M 与 YD 不可互算
   *   ——矩阵 §三铁律「报错优于算错」）。
   * - **损耗**（可选）：单独记一笔 `loss` 流水，**不计入大货数量**（损耗是样品侧的事，
   *   大货成本由大货侧自行决定）。
   */
  async function convertToBulk(params: {
    sampleId: string;
    quantity: unknown;
    /** 目标库存项；缺省时按 materialCode 找，找不到则建行（复用 T3/L8「缺项自动建行」范式） */
    targetInventoryItemId?: string | null;
    warehouseId?: string | null;
    materialCode?: string | null;
    description?: string | null;
    /** 剪裁损耗（可选） */
    lossQty?: unknown;
    note?: string | null;
    operator?: string | null;
  }): Promise<Result<any>> {
    const inventoryService = createInventoryService(prisma);
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        const source = await fabricSampleForWrite(tx, params.sampleId);
        if (!source.ok) return source;
        const sample = source.data;
        if (sample.lengthQty == null || !sample.lengthUnit) {
          return fail('NO_LENGTH_ACCOUNT', `样品 ${sample.code} 未建长度账，请先登记米样长度`, 409);
        }
        const qty = q4(D(params.quantity));
        if (!qty.isFinite() || qty.lte(0)) {
          return fail('INVALID_INPUT', `转大货数量必须 > 0，收到 ${String(params.quantity)}`);
        }
        let loss = new Prisma.Decimal(0);
        if (params.lossQty != null && String(params.lossQty).trim() !== '') {
          loss = q4(D(params.lossQty));
          if (!loss.isFinite() || loss.lt(0)) return fail('INVALID_INPUT', `损耗必须 ≥ 0，收到 ${String(params.lossQty)}`);
        }

        const current = new Prisma.Decimal(sample.lengthQty);
        const balanceAfter = current.minus(qty).minus(loss);
        if (balanceAfter.lt(0)) {
          return fail('LENGTH_INSUFFICIENT',
            `持有长度不足：当前 ${current.toFixed(4)} ${sample.lengthUnit}，本笔转大货 ${qty.toFixed(4)}`
            + `${loss.gt(0) ? ` + 损耗 ${loss.toFixed(4)}` : ''} ${sample.lengthUnit}`, 409);
        }

        // ── 目标库存项 ──
        let item: any = null;
        if (params.targetInventoryItemId) {
          item = await tx.inventoryItem.findUnique({ where: { id: params.targetInventoryItemId } });
          if (!item || item.deletedAt) return fail('ITEM_NOT_FOUND', `目标库存项 ${params.targetInventoryItemId} 不存在`, 404);
        } else {
          const materialCode = String(params.materialCode ?? '').trim() || sample.code;
          item = await tx.inventoryItem.findFirst({
            where: { materialCode, deletedAt: null, ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}) },
            orderBy: { createdAt: 'asc' },
          });
          if (!item) {
            let whId = String(params.warehouseId ?? '').trim() || null;
            if (!whId) {
              const main = await tx.warehouse.findFirst({ where: { type: 'Main', isActive: true, deletedAt: null }, orderBy: { sortOrder: 'asc' } })
                ?? await tx.warehouse.findFirst({ where: { isActive: true, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
              whId = main?.id ?? null;
            }
            if (!whId) return fail('NO_WAREHOUSE', '没有可用仓库，无法建立大货库存项', 409);
            const now = BigInt(Date.now());
            item = await tx.inventoryItem.create({
              data: {
                id: `INV_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                warehouseId: whId,
                materialCode,
                description: String(params.description ?? '').trim() || `${sample.code} 米样转大货`,
                category: 'Fabric',
                quantity: new Prisma.Decimal(0),
                lockedQuantity: new Prisma.Decimal(0),
                unit: sample.lengthUnit,
                createdAt: now, updatedAt: now,
              },
            });
          }
        }

        // ── 单位铁律（M 与 YD 不可互算）──
        if (String(item.unit ?? '').toUpperCase() !== String(sample.lengthUnit).toUpperCase()) {
          return fail('UNIT_MISMATCH',
            `单位不一致：样品 ${sample.lengthUnit} / 库存项 ${item.unit} —— M 与 YD 不可互算（矩阵铁律：报错优于算错）`, 409);
        }

        // ── 样品侧减 ──
        const afterOut = q4(balanceAfter);
        await tx.sample.update({ where: { id: sample.id }, data: { lengthQty: afterOut, updatedAt: BigInt(Date.now()) } });
        await writeMovement(tx, {
          sampleId: sample.id, type: 'to_bulk', quantity: qty, unit: sample.lengthUnit,
          targetInventoryItemId: item.id, balanceAfter: afterOut,
          note: params.note ?? null, operator: params.operator ?? null,
        });
        if (loss.gt(0)) {
          await writeMovement(tx, {
            sampleId: sample.id, type: 'loss', quantity: loss, unit: sample.lengthUnit,
            balanceAfter: afterOut, note: '转大货剪裁损耗', operator: params.operator ?? null,
          });
        }

        // ── 大货侧增（经单一写入口，同事务）──
        await inventoryService.createStockMovement({
          itemId: item.id,
          type: 'Inbound',
          quantity: qty,
          unit: sample.lengthUnit,
          referenceType: 'Sample',
          referenceId: sample.id,
          reason: `米样转大货：${sample.code}`,
          notes: `D7-① 转化通道${params.note ? ` · ${params.note}` : ''}`,
        } as any, params.operator ?? 'api', { tx });

        await writeRouteAuditLog({
          prisma: tx, actorId: params.operator || 'api', source: 'route:samples:convert',
          operation: 'sample_convert_to_bulk', targetType: 'Sample', targetId: sample.id,
          after: { quantity: qty.toString(), unit: sample.lengthUnit, lossQty: loss.toString(), inventoryItemId: item.id, balanceAfter: afterOut.toString() },
        });

        return ok({
          sample: { ...sample, lengthQty: afterOut },
          inventoryItemId: item.id,
          convertedQty: qty.toNumber(),
          lossQty: loss.toNumber(),
          balanceAfter: afterOut.toNumber(),
        });
      });
      return result;
    } catch (e: any) {
      logger.error('[SampleLength] convertToBulk failed', { error: e?.message, sampleId: params.sampleId });
      return fail('CONVERT_TO_BULK_FAILED', String(e?.message ?? e), 500);
    }
  }

  /**
   * D7-① **米样转售**：样品侧减（to_resale 流水）+ 应收侧增（BillingItem，sourceType='Sample'）。
   *
   * **双侧严格同事务**（2026-09-16 收口）：两侧在**同一个** `prisma.$transaction` 内完成 ——
   * 样品侧扣减 + 流水 + 审计，应收侧走 `createBillingItemInTx(tx, …)`。
   * 任一侧失败 → **整体回滚**，不会出现「样品已扣、应收没建」的半成品。
   *
   * ⚠️ 事务回调里 `return fail(...)` **不会**回滚（正常返回即提交）—— 故本函数内所有失败路径
   * 一律用 `throwFail`（throw）而非 return，把外层事务带崩。这是刻意的，勿改回 return。
   */
  async function convertToResale(params: {
    sampleId: string;
    quantity: unknown;
    customerRelationId: string;
    amount: unknown;
    currency?: string | null;
    note?: string | null;
    operator?: string | null;
  }): Promise<Result<any>> {
    /** 事务内失败 → throw（携带 code/status，供外层映射回 Result） */
    const throwFail = (code: string, message: string, status = 400): never => {
      throw Object.assign(new Error(message), { __convertFail: true, code, httpStatus: status });
    };

    // 纯输入校验（无写操作）留在事务外，快速失败
    const amount = D(params.amount);
    if (!amount.isFinite() || amount.lte(0)) {
      return fail('INVALID_INPUT', `转售金额必须 > 0，收到 ${String(params.amount)}`);
    }
    if (!String(params.customerRelationId ?? '').trim()) {
      return fail('INVALID_INPUT', '转售必须指定客户（customerRelationId）');
    }

    try {
      const data = await prisma.$transaction(async (tx: any) => {
        const source = await fabricSampleForWrite(tx, params.sampleId);
        if (!source.ok) return throwFail(source.error.code, source.error.message, source.error.status);
        const sample = source.data;
        if (sample.lengthQty == null || !sample.lengthUnit) {
          throwFail('NO_LENGTH_ACCOUNT', `样品 ${sample.code} 未建长度账，请先登记米样长度`, 409);
        }
        const qty = q4(D(params.quantity));
        if (!qty.isFinite() || qty.lte(0)) {
          throwFail('INVALID_INPUT', `转售数量必须 > 0，收到 ${String(params.quantity)}`);
        }
        const current = new Prisma.Decimal(sample.lengthQty);
        const balanceAfter = current.minus(qty);
        if (balanceAfter.lt(0)) {
          throwFail('LENGTH_INSUFFICIENT', `持有长度不足：当前 ${current.toFixed(4)} ${sample.lengthUnit}，本笔转售 ${qty.toFixed(4)} ${sample.lengthUnit}`, 409);
        }
        const afterOut = q4(balanceAfter);
        await tx.sample.update({ where: { id: sample.id }, data: { lengthQty: afterOut, updatedAt: BigInt(Date.now()) } });
        await writeMovement(tx, {
          sampleId: sample.id, type: 'to_resale', quantity: qty, unit: sample.lengthUnit,
          targetRelationId: params.customerRelationId, amount: q4(amount), balanceAfter: afterOut,
          note: params.note ?? null, operator: params.operator ?? null,
        });
        await writeRouteAuditLog({
          prisma: tx, actorId: params.operator || 'api', source: 'route:samples:convert',
          operation: 'sample_convert_to_resale', targetType: 'Sample', targetId: sample.id,
          after: { quantity: qty.toString(), unit: sample.lengthUnit, amount: q4(amount).toString(), customerRelationId: params.customerRelationId, balanceAfter: afterOut.toString() },
        });

        // 应收侧：既有 BillingItem 通路（sourceType='Sample' 合法；chargeType 用白名单内的 other），
        // 传同一个 tx → 与样品侧同事务。失败即 throw → 上面所有写一并回滚。
        const billingItem = await createBillingItemInTx(tx, {
          input: {
            sourceType: 'Sample',
            sourceId: params.sampleId,
            chargeType: 'other',
            amount: amount.toNumber(),
            currency: String(params.currency ?? '').trim() || 'CNY',
            bearerType: 'customer',
            bearerRelationId: params.customerRelationId,
            notes: `米样转售：${sample.code} ${qty.toFixed(4)} ${sample.lengthUnit}`
              + `${params.note ? ` · ${params.note}` : ''}`,
          },
          actorId: params.operator ?? 'api',
        });

        return { sample, qty, unit: sample.lengthUnit, balanceAfter: afterOut, billingItem };
      });

      return ok({
        sample: { ...data.sample, lengthQty: data.balanceAfter },
        resoldQty: data.qty.toNumber(),
        amount: amount.toNumber(),
        balanceAfter: data.balanceAfter.toNumber(),
        billingItem: data.billingItem,
        // 同事务后不再存在「样品已扣、应收未建」的半成品 → 无 warning 语义
        warning: null,
      });
    } catch (e: any) {
      // 本层校验失败 / 计费层失败 —— 都带上原始 code（保留 COST_ALREADY_BILLED 这类具体诊断，别糊成 500）
      if (e?.__convertFail || e?.__billingFail) return fail(e.code, String(e?.message ?? ''), e.httpStatus ?? 400);
      logger.error('[SampleLength] convertToResale failed', { error: e?.message, sampleId: params.sampleId });
      return fail('CONVERT_TO_RESALE_FAILED', String(e?.message ?? e), 500);
    }
  }

  /** 长度流水台账（按样品） */
  async function listLengthMovements(params: { sampleId: string; limit?: number }): Promise<Result<any>> {
    const rows = await prisma.sampleLengthMovement.findMany({
      where: { sampleId: params.sampleId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(params.limit ?? 100, 500),
    });
    return ok({ movements: rows });
  }

  return { setSampleLength, moveSampleLength, cutSampleLength, convertToBulk, convertToResale, listLengthMovements };
}

/** 样品号生成（SMP-YYYYMMDD-NNN，占用校验含软删） */
async function nextSampleCode(tx: any): Promise<string> {
  const d = businessNowDate();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  for (let i = 1; i < 1000; i++) {
    const code = `SMP-${ymd}-${String(i).padStart(3, '0')}`;
    const dup = await tx.sample.findFirst({ where: { code }, select: { id: true } });
    if (!dup) return code;
  }
  throw new Error('SMP code exhausted for today');
}
