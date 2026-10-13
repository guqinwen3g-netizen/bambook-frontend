/**
 * earlyProductionSampleService.ts — 投产后早期生产样服务（DR-028）
 *
 * 设计真源：
 *   - DR-028：面料客户订单经商业批准后即投产；投产后最早可获得、能够代表实际生产质量的
 *     面料样品应尽快寄送客户确认。不限轮次闭环：业务员登记样品→寄送→客户反馈→
 *     QC 调整→工厂新样→再寄→再确认。客户通过则该轮闭环。
 *   - 正常样品反馈与 QC 调整不自动暂停大货生产；订单保持投产/生产中。
 *   - DR-029：面料样品链由业务员全程登记；QC 负责专业判断并向工厂反馈调整要求；
 *     工厂负责按要求调整并提供新样品。正常技术调整不设硬阈值，不增加主管审批门槛。
 *
 * 模型约束（schema 冻结）：
 *   - EarlyProductionSample：previousSampleId 指向上一轮（adjust_and_resend 时链入下一轮）
 *   - 客户确认链：customerStatus ∈ {pending, approved, rejected, adjust_and_resend}
 *   - 额外确认细节（渠道/证据/调整原因/QC 调整意见）存 attachments JSON
 *   - qcInspectionReportId 与 qcRequestedBy 支持 DR-029：仅 customerStatus=rejected
 *     或业务主动请求时引入 QC。
 */

import type { PrismaClient } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { isYmd, todayYmd } from './fabricShipmentSampleService';

// ────────────────────────────────────────────────────────────────────
// 常量与类型
// ────────────────────────────────────────────────────────────────────

export const EARLY_PRODUCTION_CUSTOMER_STATUSES = ['pending', 'approved', 'rejected', 'adjust_and_resend'] as const;
export type EarlyProductionCustomerStatus = (typeof EARLY_PRODUCTION_CUSTOMER_STATUSES)[number];

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}
function fail<T>(code: string, message: string, status = 400): Result<T> {
  return { ok: false, error: { code, message, status } };
}

function shortId(prefix: string): string {
  return `${prefix}__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function mergeAttachments(existing: any, patch: Record<string, unknown>): any {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as any) } : {};
  return { ...base, ...patch };
}

/** 面料订单判定 */
function isFabricOrder(order: any): boolean {
  if (!order) return false;
  if (String(order.businessLine ?? '').toLowerCase() === 'fabric') return true;
  return String(order.type ?? '').toLowerCase() === 'fabric';
}

async function resolveFabricOrder(prisma: PrismaClient, orderId: string): Promise<Result<{ order: any }>> {
  const order = await prisma.order.findFirst({ where: { id: orderId, deletedAt: null } });
  if (!order) return fail('NOT_FOUND', `订单 ${orderId} 不存在`, 404);
  if (!isFabricOrder(order)) return fail('NOT_FABRIC_ORDER', `订单 ${orderId} 不是面料订单`);
  return ok({ order });
}

async function nextEpsCode(prisma: PrismaClient): Promise<string> {
  const prefix = `EPS-${todayYmd().replace(/-/g, '')}`;
  const count = await prisma.earlyProductionSample.count({ where: { sampleCode: { startsWith: prefix } } });
  return `${prefix}-${String(count + 1).padStart(3, '0')}`;
}

// ────────────────────────────────────────────────────────────────────
// 输入类型
// ────────────────────────────────────────────────────────────────────

export interface CreateEarlyProductionSampleInput {
  fabricProfileId?: string;
  millName?: string;
  sampleQuantity: number;          // 必填
  sampleUnit?: string;
  productionStage?: string;        // greige_out_of_loom | after_dyeing | after_finishing
  producedMeterage?: number;
  cuttingDate: string;             // 必填
  notes?: string;
  previousSampleId?: string;       // 调整重发链：新轮次指向上一轮
}

export interface SendEarlyProductionSampleInput {
  sentDate?: string;
  trackingNumber?: string;
  recipientName?: string;
  recipientContact?: string;
  courier?: string;
  documents?: any[];
}

export interface ConfirmEarlyProductionSampleInput {
  result: 'approved' | 'rejected' | 'adjust_and_resend';
  confirmationDate: string;
  channel: string;
  note?: string;
  evidence?: any[];
  /** 仅 customerStatus=rejected 或业务主动请求 QC 时填写 */
  qcInspectionReportId?: string;
  /** QC 向工厂提出的调整要求（DR-029：业务员交给 QC，QC 录入专业意见） */
  qcAdjustmentNote?: string;
}

// ────────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────────

export function createEarlyProductionSampleService(opts: { prisma: PrismaClient }) {
  const { prisma } = opts;

  /** 登记早期生产样（不限轮次；previousSampleId 非空时形成闭环链） */
  async function createSample(params: {
    orderId: string;
    input: CreateEarlyProductionSampleInput;
    actorId: string;
    ip?: string | null;
  }): Promise<Result<{ sample: any }>> {
    const { orderId, input, actorId, ip } = params;
    if (!input || typeof input !== 'object') return fail('INVALID_INPUT', '请求体必填');
    if (!(Number(input.sampleQuantity) > 0)) return fail('INVALID_INPUT', 'sampleQuantity 必填且大于 0');
    if (!isYmd(input.cuttingDate)) return fail('INVALID_INPUT', 'cuttingDate 必填，格式 YYYY-MM-DD');
    if (input.previousSampleId) {
      const prev = await prisma.earlyProductionSample.findFirst({
        where: { id: input.previousSampleId, deletedAt: null },
      });
      if (!prev) return fail('PREVIOUS_SAMPLE_NOT_FOUND', `上一轮样品 ${input.previousSampleId} 不存在`, 404);
      if (prev.orderId !== orderId) return fail('ORDER_MISMATCH', 'previousSampleId 必须属于同一订单', 400);
    }

    const orderR = await resolveFabricOrder(prisma, orderId);
    if (!orderR.ok) return orderR;
    // DR-028：早期生产样是「投产后」节点；订单须已过商业批准（非草稿/待批/取消）。
    // 注意：本服务在任何路径都不写 Order.status——正常迭代不暂停生产（订单保持投产/生产中）。
    const orderStatus = String((orderR.data.order as any).status ?? '').toLowerCase();
    if (['pending', 'draft', 'cancelled', 'canceled'].includes(orderStatus)) {
      return fail('ORDER_NOT_IN_PRODUCTION', `订单 ${orderId} 尚未投产（当前状态 ${(orderR.data.order as any).status}），投产后才可登记早期生产样（DR-028）`, 409);
    }

    try {
      const created = await (prisma as any).$transaction(async (tx: any) => {
        const sample = await tx.earlyProductionSample.create({
          data: {
            id: shortId('EPS'),
            sampleCode: await nextEpsCode(tx),
            orderId,
            fabricProfileId: input.fabricProfileId ?? null,
            millName: input.millName ?? null,
            sampleQuantity: input.sampleQuantity,
            sampleUnit: input.sampleUnit ?? 'meter',
            productionStage: input.productionStage ?? null,
            producedMeterage: input.producedMeterage ?? null,
            cuttingDate: input.cuttingDate,
            previousSampleId: input.previousSampleId ?? null,
            notes: input.notes ?? null,
            attachments: { rounds: [] },
          },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:samples:early_production',
          operation: 'create_early_sample',
          targetType: 'EarlyProductionSample',
          targetId: sample.id,
          after: { id: sample.id, sampleCode: sample.sampleCode, orderId, previousSampleId: input.previousSampleId ?? null },
          ip: ip ?? null,
        });
        return sample;
      });
      logger.info('[EarlyProd] 早期生产样已登记', { sampleId: created.id, orderId, actorId });
      return ok({ sample: created });
    } catch (e: any) {
      // B39：原文只进日志，对外只给中文 + 下一步（本 catch 的写路径唯一 = 上面那个 $transaction，
      // 抛错即回滚 ⇒ 文案可以承诺"本次未确认任何改动"，与 samples 域既有 48 条同口径）。
      logger.error('[EarlyProd] 轮次登记失败', { orderId, error: e?.message });
      if (e?.code === 'P2002') return fail('DUPLICATE_CODE', '样品业务号冲突', 409);
      return fail('CREATE_FAILED', '早期生产样轮次登记未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该订单的样品轮次与业务号。', 500);
    }
  }

  /** 寄送登记（支持不限轮次重寄） */
  async function sendSample(params: {
    sampleId: string;
    input: SendEarlyProductionSampleInput;
    actorId: string;
    ip?: string | null;
  }): Promise<Result<{ sample: any }>> {
    const { sampleId, input, actorId, ip } = params;
    if((input as any)?.physicalShipment!==undefined)return fail('NATIVE_SHIPMENT_REQUIRED','请从订单原生先锋样记录寄样，同步更新样品仓库。',409);
    const sample = await prisma.earlyProductionSample.findFirst({ where: { id: sampleId, deletedAt: null } });
    if (!sample) return fail('NOT_FOUND', `样品 ${sampleId} 不存在`, 404);
    if (sample.customerStatus === 'approved') {
      return fail('ALREADY_APPROVED', '该样品客户已批准，不可再寄送；如需新一轮请创建新样品（previousSampleId 链入）', 409);
    }

    const now = Date.now();
    const sentDate = input.sentDate || todayYmd();
    try {
      const updated = await (prisma as any).$transaction(async (tx: any) => {
        const native=await tx.orderSampleSource.findFirst({where:{orderId:sample.orderId},select:{id:true}});
        const physical=await tx.sampleCardItem.findFirst({where:{orderId:sample.orderId,deletedAt:null},select:{id:true}});
        if(native||physical)throw Object.assign(new Error('该订单已有原生样品或实物登记，请从订单对应先锋样记录寄样，同步更新样品仓库。'),{code:'NATIVE_SHIPMENT_REQUIRED',status:409});
        const roundEntry = {
          round: ((sample.attachments as any)?.rounds?.length ?? 0) + 1,
          sentDate,
          trackingNumber: input.trackingNumber ?? null,
          recipientName: input.recipientName ?? null,
          recipientContact: input.recipientContact ?? null,
          courier: input.courier ?? null,
          documents: Array.isArray(input.documents) ? input.documents : [],
          shippedBy: actorId,
          shippedAt: now,
        };
        const attachments = mergeAttachments(sample.attachments, {
          rounds: [...((sample.attachments as any)?.rounds ?? []), roundEntry],
        });
        const row = await tx.earlyProductionSample.update({
          where: { id: sample.id },
          data: {
            sentToCustomer: true,
            sentDate,
            trackingNumber: input.trackingNumber ?? null,
            attachments,
          },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:samples:early_production',
          operation: 'send_early_sample',
          targetType: 'EarlyProductionSample',
          targetId: sample.id,
          before: { sentToCustomer: sample.sentToCustomer, sentDate: sample.sentDate },
          after: { sentToCustomer: true, sentDate, roundEntry },
          ip: ip ?? null,
        });
        return row;
      });
      return ok({ sample: updated });
    } catch (e: any) {
      if(e?.code==='NATIVE_SHIPMENT_REQUIRED')return fail(e.code,e.message,409);
      logger.error('[EarlyProd] 寄送登记失败', { sampleId, error: e?.message });
      return fail('UPDATE_FAILED', '该轮早期生产样的寄送登记未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对样品与快递单号。', 500);
    }
  }

  /** 客户确认登记（闭环判定；adjust_and_resend 允许继续迭代） */
  async function confirmSample(params: {
    sampleId: string;
    input: ConfirmEarlyProductionSampleInput;
    actorId: string;
    ip?: string | null;
  }): Promise<Result<{ sample: any }>> {
    const { sampleId, input, actorId, ip } = params;
    if (!input || typeof input !== 'object') return fail('INVALID_INPUT', '请求体必填');
    if (!['approved', 'rejected', 'adjust_and_resend'].includes(String(input.result))) {
      return fail('INVALID_INPUT', 'result 必须是 approved | rejected | adjust_and_resend');
    }
    if (!isYmd(input.confirmationDate)) return fail('INVALID_INPUT', 'confirmationDate 必填，格式 YYYY-MM-DD');
    if (!input.channel || !String(input.channel).trim()) return fail('INVALID_INPUT', 'channel（确认渠道）必填');

    const sample = await prisma.earlyProductionSample.findFirst({ where: { id: sampleId, deletedAt: null } });
    if (!sample) return fail('NOT_FOUND', `样品 ${sampleId} 不存在`, 404);
    if (!sample.sentToCustomer) return fail('NOT_SENT', '样品尚未寄送，须先完成寄送登记', 409);
    if (sample.customerStatus === 'approved') return fail('ALREADY_APPROVED', '该轮已 approved，不可重复确认；如需新一轮请创建新样品', 409);

    const now = Date.now();
    try {
      const updated = await (prisma as any).$transaction(async (tx: any) => {
        const prevRounds = Array.isArray((sample.attachments as any)?.rounds) ? (sample.attachments as any).rounds : [];
        const lastRound = prevRounds.length ? prevRounds[prevRounds.length - 1] : null;
        if (lastRound) {
          lastRound.confirmation = {
            result: input.result,
            date: input.confirmationDate,
            channel: input.channel,
            note: input.note ?? null,
            evidence: Array.isArray(input.evidence) ? input.evidence : [],
            registeredBy: actorId,
            registeredAt: now,
          };
        }
        const attachments = mergeAttachments(sample.attachments, {
          rounds: prevRounds,
          lastConfirmation: {
            result: input.result,
            date: input.confirmationDate,
            channel: input.channel,
            note: input.note ?? null,
            evidence: Array.isArray(input.evidence) ? input.evidence : [],
            registeredBy: actorId,
            registeredAt: now,
          },
          ...(input.qcAdjustmentNote ? { qcAdjustmentNote: String(input.qcAdjustmentNote) } : {}),
        });
        const data: any = {
          customerStatus: input.result,
          customerFeedbackDate: input.confirmationDate,
          customerFeedbackNote: input.note ?? null,
          attachments,
        };
        if (input.result === 'adjust_and_resend') {
          data.qcRequestedBy = actorId;
          data.qcRequestedAt = new Date(now);
        }
        if (input.qcInspectionReportId) {
          data.qcInspectionReportId = input.qcInspectionReportId;
        }
        const row = await tx.earlyProductionSample.update({ where: { id: sample.id }, data });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:samples:early_production',
          operation: 'confirm_early_sample',
          targetType: 'EarlyProductionSample',
          targetId: sample.id,
          before: { customerStatus: sample.customerStatus },
          after: {
            customerStatus: input.result,
            confirmationDate: input.confirmationDate,
            channel: input.channel,
            qcInspectionReportId: input.qcInspectionReportId ?? null,
          },
          ip: ip ?? null,
        });
        return row;
      });
      logger.info('[EarlyProd] 客户确认已登记', { sampleId, result: input.result, actorId });
      return ok({ sample: updated });
    } catch (e: any) {
      logger.error('[EarlyProd] 客户确认登记失败', { sampleId, error: e?.message });
      return fail('UPDATE_FAILED', '该轮早期生产样的客户确认结论未能登记，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该轮次的确认单与日期。', 500);
    }
  }

  /** 按订单列出早期生产样链（按 previousSampleId 构建链条） */
  async function listByOrder(params: { orderId: string }): Promise<Result<{ items: any[] }>> {
    const { orderId } = params;
    const order = await prisma.order.findFirst({ where: { id: orderId, deletedAt: null } });
    if (!order) return fail('NOT_FOUND', `订单 ${orderId} 不存在`, 404);
    const all = await prisma.earlyProductionSample.findMany({
      where: { orderId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    // 构建链条（previousSampleId → 链入下一轮）
    const map = new Map<string, any>();
    for (const s of all) map.set(s.id, { ...s, chain: [] as any[] });
    const roots: any[] = [];
    for (const s of all) {
      if (s.previousSampleId && map.has(s.previousSampleId)) {
        map.get(s.previousSampleId).chain.push(map.get(s.id));
      } else {
        roots.push(map.get(s.id));
      }
    }
    return ok({ items: roots });
  }

  return { createSample, sendSample, confirmSample, listByOrder };
}

export type EarlyProductionSampleService = ReturnType<typeof createEarlyProductionSampleService>;
