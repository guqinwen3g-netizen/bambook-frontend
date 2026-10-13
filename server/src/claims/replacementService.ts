/**
 * replacementService.ts — 换货补发出运单（A-3 二期 · 口径 A1「换货补发 = 只动货」）
 *
 * ════════════════════════════════════════════════════════════════════
 * ★ 为什么**复用 `Shipment`** 而不是另造一套"补发单"（行业标准）
 *   补发就是「**再发一次货**」—— 物流、订舱、报关、单证（CI/PL/BL）**必须走同一套出运流程**。
 *   另造一套等于把出运流程实现两遍：**两套必然漂移**（本仓已多次踩过"收口点错位"），
 *   而且报关行/货代只认一套单据格式。
 *   ⇒ 复用 `Shipment`，并：
 *     · `notes` 打上来源标记（**这是补发、来自哪张客诉单**）—— 否则在运单列表里无法区分
 *     · 在客诉侧用 `ClaimDisposition.replacementShipmentId` 建立**双向可查**的链接
 *       （不在 `Shipment` 上加 `claimCaseId` 列 —— 避免为一个次要场景动既有核心表）
 *
 * ★ 与"正常出运"的唯一差别：**不走钱**（不开发票）——
 *   所以本服务**只建运单**，绝不触碰发票/收款。
 * ════════════════════════════════════════════════════════════════════
 */

import type { PrismaClient } from '@prisma/client';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { replaceShipmentLinesTx } from '../shipping/shipmentPackingService';
import { claimRefusal, lockClaimRows } from './claimApprovalFact';

export type ReplacementCode = 'VALIDATION_FAILED' | 'NOT_FOUND';
export interface ReplacementError { code: ReplacementCode; message: string }
export interface ReplacementResult<T = unknown> { ok: boolean; data?: T; error?: ReplacementError }

const fail = <T>(code: ReplacementCode, message: string): ReplacementResult<T> => ({ ok: false, error: { code, message } });
const ok = <T>(data: T): ReplacementResult<T> => ({ ok: true, data });

export interface CreateReplacementShipmentInput {
  /** 来源客诉案件号（写进运单备注，便于人工识别） */
  claimCaseNumber: string;
  claimCaseId: string;
  claimDispositionId: string;
  /** 原出运单（可空）—— 用于继承 `type` / `shippingMethod` / 收发货方 */
  sourceShipmentId?: string | null;
  notes?: string | null;
}

/** 补发单备注前缀（便于列表识别 + 演练回滚按前缀扫） */
export const REPLACEMENT_NOTE_PREFIX = '[补发]';

/**
 * 建一张**补发出运单**（复用 `Shipment`；取号 `SH`）。
 *
 * 继承原票的 `type` / `shippingMethod` / 客户与收发货方快照（有原票时）——
 * 补发的运输方式与目的地通常与原票一致。
 */
export async function createReplacementShipment(
  prisma: PrismaClient,
  input: CreateReplacementShipmentInput,
  actorId: string,
  opts: { tx?: any } = {},
): Promise<ReplacementResult<{ shipment: any }>> {
  if (!input?.claimCaseId || !input?.claimCaseNumber || !input.claimDispositionId) {
    return fail('VALIDATION_FAILED', 'claimCaseId / claimCaseNumber / claimDispositionId 必填');
  }

  const db = opts.tx ?? prisma;
  // 指定原票时读故障/目标不存在不能被吞掉并静默继承默认值。
  const src = input.sourceShipmentId
    ? await db.shipment.findUnique({
        where: { id: input.sourceShipmentId },
        select: {
          type: true, shippingMethod: true, customerRelationId: true, customerName: true,
          consigneeRelationId: true, consigneeName: true, businessLine: true, deletedAt: true,
        },
      })
    : null;
  if (input.sourceShipmentId && (!src || src.deletedAt)) return fail('NOT_FOUND', '原出运单不存在或已删除');

  const runInTx = opts.tx ? (fn: (tx: any) => Promise<any>) => fn(opts.tx) : (fn: (tx: any) => Promise<any>) => prisma.$transaction(fn);
  const shipment = await runInTx(async (tx: any) => {
    const { disposition: d, claimCase } = await lockClaimRows(tx, input.claimDispositionId);
    if (d.kind !== 'Replace' || d.status !== 'Approved' || d.replacementShipmentId
        || claimCase.id !== input.claimCaseId || claimCase.caseNumber !== input.claimCaseNumber) claimRefusal('补发必须绑定准确的已批准换货处置');
    if (!d.materialCode?.trim() || !d.unit?.trim() || !d.quantity || Number(d.quantity) <= 0) claimRefusal('补发缺少已批准的真实物料、数量或单位，请先补审');
    if (src && ((src.customerRelationId && src.customerRelationId !== claimCase.customerRelationId)
        || (!src.customerRelationId && src.customerName && src.customerName !== claimCase.customerName))) claimRefusal('原出运单客户与客诉案件不一致，不能继承他人的收发货信息');
    const shipmentNumber = await nextBusinessNumber(tx, 'SH', undefined, {
      occupied: async (num) => {
        // ⚠️ 含软删行（唯一约束不排除软删行）
        const dup = await tx.shipment.findFirst({ where: { shipmentNumber: num }, select: { id: true } });
        return dup != null;
      },
    });
    const created = await tx.shipment.create({
      data: {
        id: `SHP__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        shipmentNumber,
        // ★ 继承原票属性（无原票时给保守默认 —— `type`/`shippingMethod` 是必填）
        type: src?.type ?? 'Export',
        status: 'Draft',
        shippingMethod: src?.shippingMethod ?? 'Sea',
        customerRelationId: claimCase.customerRelationId ?? null,
        customerName: claimCase.customerName ?? null,
        consigneeRelationId: src?.consigneeRelationId ?? null,
        consigneeName: src?.consigneeName ?? null,
        businessLine: src?.businessLine ?? null,
        // ★ 来源标记 —— 否则在运单列表里与正常运单无法区分
        notes: `${REPLACEMENT_NOTE_PREFIX} 来自客诉 ${input.claimCaseNumber}${input.notes ? ` · ${input.notes}` : ''}`,
        createdAt: BigInt(Date.now()),
        updatedAt: BigInt(Date.now()),
      },
    });
    const lines = await replaceShipmentLinesTx(tx, created.id, [{ productCode: d.materialCode,
      quantity: d.quantity.toString(), unit: d.unit }], actorId, undefined, { auditPrisma: prisma });
    if (lines.length !== 1 || lines[0].productCode !== d.materialCode || !lines[0].quantity?.equals(d.quantity)
        || lines[0].unit !== d.unit) claimRefusal('补发装运行未完整保留已批准的物料、数量和单位');
    return { ...(await tx.shipment.findUnique({ where: { id: created.id } })), lines };
  });

  return ok({ shipment });
}
