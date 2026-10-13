/**
 * timelineService.ts — 客户门户「全时间线」（§10.3-8）
 *
 * 业务口径（2026-09-12 业务方定案）：客户看到的是**对外节点**，内部细节一律不给。
 * 因此本模块采用**白名单构造**：只从各表挑出对外字段拼 DTO，内部字段根本不进入
 * 结果对象（而不是"查全量再删字段"——后者一旦漏删就是泄漏）。
 *
 * 对外给：
 *   - 订单状态流转（客户向文案）
 *   - 打样轮次与客户判样结果（轮次/类型/状态/寄样日期/快递单号/客户反馈日期/批准时间）
 *   - 生产里程碑（开裁 / 生产 / 成品确认 / 验货发货）
 *   - 验货**结论**（合格/有条件/不合格 + 验货日期 + 验货方）
 *   - 出运节点（订舱 / 离港 / 到港 / 状态）
 *   - 发票（号/金额/币种/开票日/到期日/状态）
 *
 * 明确不给（内部数据边界）：
 *   - 成本 / 利润 / BOM / 采购价与采购单
 *   - 工厂与供应商名称（SampleBatch.supplierName/Id 等）
 *   - 内部备注（OrderStatusTransition.note、ProductionStage.note、developmentCase.notes…）
 *   - 内部审批过程（ApprovalRequest/审批人/决议意见）与放行签字细节
 *   - QC 疵点明细（疵点数/疵点描述/抽样数/AQL 等级）与内部 QC 评审状态
 *   - 运费金额与其它内部费用
 *
 * 时间线按时间**倒序**（最新在前），每条带稳定 `key`（供前端/测试引用）。
 */

import type { PrismaClient } from '@prisma/client';

export type CustomerTimelineType = 'order' | 'sample' | 'production' | 'inspection' | 'shipment' | 'invoice';

export interface CustomerTimelineItem {
  /** 稳定标识：`<type>:<sourceId>:<event>` */
  key: string;
  type: CustomerTimelineType;
  /** 客户向标题（英文，与门户既有文案风格一致） */
  title: string;
  /** ISO 日期或时间戳 ISO 串；未知时间为 null（排在末尾） */
  at: string | null;
  /** 可选补充（仍是白名单字段） */
  detail?: Record<string, string | number | null>;
}

/** 订单状态 → 客户向文案（含内部含混状态的对客表述） */
const ORDER_STATUS_CUSTOMER_LABEL: Record<string, string> = {
  Pending: 'Order Received',
  Confirmed: 'Order Confirmed',
  Production: 'In Production',
  Shipping: 'Shipping',
  Delivered: 'Delivered',
  Alert: 'Update Required',
  CancelRequested: 'Change Under Review',
  PauseRequested: 'On Hold (Pending Review)',
  Cancelled: 'Cancelled',
  Completed: 'Completed',
};

/**
 * 生产阶段 → 客户可见里程碑白名单。
 * **不在表内的阶段对客户完全不可见**（内部排程/物料/放行门禁等），新增阶段默认隐藏，
 * 避免"新加一个内部阶段就自动暴露给客户"。
 */
const PRODUCTION_MILESTONE_LABEL: Record<string, string> = {
  pre_cut_checked: 'Cutting Started',
  manufacturing: 'In Production',
  final_review: 'Production Completed',
  qc_shipped: 'Inspected & Shipped',
};

const SAMPLE_TYPE_LABEL: Record<string, string> = {
  'lab-dip': 'Lab Dip',
  handloom: 'Handloom Sample',
  yardage: 'Yardage Sample',
  'garment-round': 'Garment Sample',
};

const SAMPLE_STATUS_LABEL: Record<string, string> = {
  pending: 'Preparing',
  making: 'In Making',
  sent: 'Sample Sent',
  approved: 'Sample Approved',
  revising: 'Revising',
};

const INSPECTION_RESULT_LABEL: Record<string, string> = {
  pass: 'Inspection Passed',
  conditional: 'Inspection Passed with Conditions',
  fail: 'Inspection Failed',
};

const SHIPMENT_EVENT_LABEL: Record<string, string> = {
  bookingDate: 'Booking Confirmed',
  atd: 'Departed',
  ata: 'Arrived',
};

const INVOICE_STATUS_FALLBACK: Record<string, string> = {
  Draft: 'Draft',
  Issued: 'Issued',
  PartiallyPaid: 'Partially Paid',
  Paid: 'Paid',
  Cancelled: 'Cancelled',
};

/** BigInt epoch ms → ISO（容忍 null） */
function msToIso(value: bigint | number | null | undefined): string | null {
  if (value == null) return null;
  const n = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

/** 'YYYY-MM-DD' → ISO（容忍 null/非法值） */
function dateToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return new Date(`${s}T00:00:00.000Z`).toISOString();
}

export interface BuildTimelineResult {
  items: CustomerTimelineItem[];
}

/**
 * 组装某订单的客户时间线。调用方负责**已校验该订单属于该客户**（relationId 作用域），
 * 本函数只做组装与白名单，不做授权判断（授权在 route 层，与既有 :id 端点同口径）。
 */
export async function buildCustomerTimeline(
  prisma: PrismaClient,
  orderId: string,
): Promise<BuildTimelineResult> {
  const items: CustomerTimelineItem[] = [];

  // ── 1. 订单状态流转 ──
  const transitions = await (prisma as any).orderStatusTransition
    .findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })
    .catch(() => []);
  for (const t of transitions ?? []) {
    const label = ORDER_STATUS_CUSTOMER_LABEL[t.toStatus] ?? t.toStatus;
    items.push({
      key: `order:${t.id}:status`,
      type: 'order',
      title: label,
      at: msToIso(t.createdAt),
    });
  }

  // ── 2. 打样轮次（经开发案关联：DevelopmentCase.linkedOrderId → SampleBatch）──
  const cases = await (prisma as any).developmentCase
    .findMany({ where: { linkedOrderId: orderId, deletedAt: null }, select: { id: true } })
    .catch(() => []);
  const caseIds = (cases ?? []).map((c: any) => c.id);
  if (caseIds.length > 0) {
    const batches = await (prisma as any).sampleBatch
      .findMany({ where: { developmentCaseId: { in: caseIds }, deletedAt: null } })
      .catch(() => []);
    for (const b of batches ?? []) {
      const typeLabel = SAMPLE_TYPE_LABEL[b.sampleType] ?? 'Sample';
      const statusLabel = SAMPLE_STATUS_LABEL[b.status] ?? b.status;
      const detail: Record<string, string | number | null> = {
        round: b.round ?? 1,
        sampleType: b.sampleType ?? null,
        status: b.status ?? null,
        // 客户可跟踪自己的样品件（快递单号对外有意义；工厂名称/费用不在白名单）
        trackingNumber: b.trackingNumber ?? null,
        feedbackDate: b.feedbackDate ?? null,
      };
      // 寄样（有寄出日期才算对客事件）
      const sentIso = dateToIso(b.sentDate);
      if (sentIso) {
        items.push({
          key: `sample:${b.id}:sent`,
          type: 'sample',
          title: `${typeLabel} Round ${b.round ?? 1} Sent`,
          at: sentIso,
          detail,
        });
      }
      // 客户批准
      const approvedIso = msToIso(b.approvedAt);
      if (approvedIso) {
        items.push({
          key: `sample:${b.id}:approved`,
          type: 'sample',
          title: `${typeLabel} Round ${b.round ?? 1} Approved`,
          at: approvedIso,
          detail,
        });
      } else if (!sentIso) {
        // 尚未寄样：只暴露"在做"的粗粒度状态（无日期 → 排末尾）
        items.push({
          key: `sample:${b.id}:status`,
          type: 'sample',
          title: `${typeLabel} Round ${b.round ?? 1}: ${statusLabel}`,
          at: null,
          detail,
        });
      }
    }
  }

  // ── 3. 生产里程碑（白名单；表外阶段对客户不可见）──
  const stages = await (prisma as any).productionStage
    .findMany({ where: { orderId }, orderBy: { stageSeq: 'asc' } })
    .catch(() => []);
  for (const st of stages ?? []) {
    const title = PRODUCTION_MILESTONE_LABEL[st.stageKey];
    if (!title) continue; // 内部阶段：跳过
    if (st.status !== 'done' && st.status !== 'in_progress') continue;
    items.push({
      key: `production:${st.id}:${st.status}`,
      type: 'production',
      title,
      at: msToIso(st.doneAt),
    });
  }

  // ── 4. 验货结论（只给结论与日期；疵点明细/抽样数/AQL 不给）──
  const inspections = await (prisma as any).inspectionReport
    .findMany({ where: { orderId } })
    .catch(() => []);
  for (const r of inspections ?? []) {
    const title = INSPECTION_RESULT_LABEL[r.result];
    if (!title) continue; // 未出结论不对外
    items.push({
      key: `inspection:${r.id}:result`,
      type: 'inspection',
      title: r.inspectionType === 'midline' ? `${title} (Midline)` : title,
      at: dateToIso(r.inspectionDate),
      detail: { inspectionDate: r.inspectionDate ?? null },
    });
  }

  // ── 5. 出运节点（订舱/离港/到港；运费等内部费用不给）──
  const allocs = await (prisma as any).shipmentOrderAllocation
    .findMany({ where: { orderId }, select: { shipmentId: true } })
    .catch(() => []);
  const shipmentIds = Array.from(new Set((allocs ?? []).map((a: any) => a.shipmentId).filter(Boolean)));
  const shipments = await (prisma as any).shipment
    .findMany({
      where: {
        deletedAt: null,
        OR: [{ orderId }, ...(shipmentIds.length ? [{ id: { in: shipmentIds } }] : [])],
      },
    })
    .catch(() => []);
  for (const sh of shipments ?? []) {
    for (const field of ['bookingDate', 'atd', 'ata'] as const) {
      const iso = dateToIso(sh[field]);
      if (!iso) continue;
      items.push({
        key: `shipment:${sh.id}:${field}`,
        type: 'shipment',
        title: SHIPMENT_EVENT_LABEL[field],
        at: iso,
        detail: { shipmentNumber: sh.shipmentNumber ?? null },
      });
    }
    // 预计日期：仅在没有实际日期时给出（避免同一节点重复两条）
    if (sh.etd && !sh.atd) {
      items.push({
        key: `shipment:${sh.id}:etd`,
        type: 'shipment',
        title: 'Estimated Departure',
        at: dateToIso(sh.etd),
        detail: { shipmentNumber: sh.shipmentNumber ?? null },
      });
    }
    if (sh.eta && !sh.ata) {
      items.push({
        key: `shipment:${sh.id}:eta`,
        type: 'shipment',
        title: 'Estimated Arrival',
        at: dateToIso(sh.eta),
        detail: { shipmentNumber: sh.shipmentNumber ?? null },
      });
    }
  }

  // ── 6. 发票（金额/币种/日期/状态；应收口径，且已限定本客户）──
  const invoices = await (prisma as any).invoice
    .findMany({ where: { orderId, type: 'Receivable', deletedAt: null } })
    .catch(() => []);
  for (const inv of invoices ?? []) {
    items.push({
      key: `invoice:${inv.id}:issued`,
      type: 'invoice',
      title: `Invoice ${inv.invoiceNumber ?? ''} Issued`.trim(),
      at: dateToIso(inv.issueDate),
      detail: {
        invoiceNumber: inv.invoiceNumber ?? null,
        amount: inv.amount != null ? Number(inv.amount) : null,
        currency: inv.currency ?? null,
        dueDate: inv.dueDate ?? null,
        status: INVOICE_STATUS_FALLBACK[inv.status] ?? inv.status ?? null,
      },
    });
  }

  // 倒序（最新在前）；无时间的排最后，同时间按 key 稳定排序保证幂等
  items.sort((a, b) => {
    if (a.at && b.at) return a.at === b.at ? a.key.localeCompare(b.key) : (a.at < b.at ? 1 : -1);
    if (a.at) return -1;
    if (b.at) return 1;
    return a.key.localeCompare(b.key);
  });

  return { items };
}

/** 供测试与前端复用：导出映射表（避免两边各写一套文案） */
export const CUSTOMER_TIMELINE_LABELS = {
  ORDER_STATUS_CUSTOMER_LABEL,
  PRODUCTION_MILESTONE_LABEL,
  SAMPLE_TYPE_LABEL,
  SAMPLE_STATUS_LABEL,
  INSPECTION_RESULT_LABEL,
  SHIPMENT_EVENT_LABEL,
};
