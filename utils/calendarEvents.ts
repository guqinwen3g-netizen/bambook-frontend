import { businessNowDate } from '../lib/businessClock';
/**
 * calendarEvents — 日历页业务事件聚合层。
 *
 * 把全域日期型业务节点归一为 CalendarEvent[]，按 'YYYY-MM-DD' 建索引供月格渲染。
 * v2 事件源（2026-09-02 扩展）：
 *   - 订单交期（Order.dueDate）
 *   - 出运节点（Shipment.etd 预计离港 / eta 预计到港）
 *   - 样品节点（DevelopmentCase 样品寄出/反馈、订单级船样/匹头样寄出/确认）
 *   - 发票到期（Invoice.dueDate，应收/应付）
 *   - 开发案目标（DevelopmentCase.targetDate）
 * 事件模型带 kind 注册表——新事件源在 buildCalendarEvents 追加映射 + kind 列表
 * 即可，页面零改动（页面按 kind→filter/tag/label 的映射为白名单驱动）。
 *
 * 严重度分级（决定 chip 色语义）：
 *   danger  逾期未完成（交期已过/到港已过仍未交付）——最高优先提醒
 *   warning 7 日内到期——临近预警
 *   accent  未来正常节点（唯一行动色，与全局雾青 accent 一致）
 *   info    已完成的记录（历史留痕，弱化显示）
 */

import type { DevelopmentCase, Invoice, Order, Shipment } from '../types';
import { View } from '../types';
import { toDateKey } from './chinaHolidays';

export type CalendarEventKind =
  | 'order-due'
  | 'shipment-etd'
  | 'shipment-eta'
  // 样品（样品寄出寄发日 = 计划发出节点，确认日 = 待反馈节点）
  | 'sample-sent'
  | 'sample-confirm'
  // 财务（应收/应付发票到期 = 截止节点）
  | 'invoice-due'
  // 开发案目标完成节点
  | 'development-target';

export type CalendarEventSeverity = 'danger' | 'warning' | 'accent' | 'info';

export interface CalendarEvent {
  id: string;
  /** 'YYYY-MM-DD' */
  dateKey: string;
  kind: CalendarEventKind;
  /** 事件短标题（格内 chip 文案），如「SO-2608-014 · Nordwind」 */
  title: string;
  /** 详情阅读使用的完整标题；格内继续使用 title。 */
  fullTitle?: string;
  /** 详情面板补充说明，如「3,000 pcs · 生产中」 */
  detail?: string;
  severity: CalendarEventSeverity;
  /** 点击跳转的目标页面 */
  targetView: View.Orders | View.Shipments | View.Development | View.Invoices | View.PaymentVouchers;
  /**
   * B2：目标记录的实体 id（订单/运单/开发案/发票）。
   * 点击时随 targetView 一起 prime 进跨模块导航上下文，目标页据此直达该记录，
   * 而不是落到列表让业务员自己再找一次。
   */
  targetId?: string;
}

export type CalendarEventFilter = 'all' | 'orders' | 'shipments' | 'samples' | 'finance';

const KIND_FILTER_MAP: Record<CalendarEventKind, CalendarEventFilter> = {
  'order-due': 'orders',
  'shipment-etd': 'shipments',
  'shipment-eta': 'shipments',
  'sample-sent': 'samples',
  'sample-confirm': 'samples',
  'invoice-due': 'finance',
  'development-target': 'samples',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 业务日期字符串（可能是 'YYYY-MM-DD' 或带时间的 ISO）→ 'YYYY-MM-DD'；无效返回 null */
function toEventDateKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  return match ? match[1] : null;
}

/** 交期严重度：已完成→info；逾期→danger；7 日内→warning；未来→accent */
function resolveDueSeverity(dueKey: string, isCompleted: boolean, todayKey: string): CalendarEventSeverity {
  if (isCompleted) return 'info';
  if (dueKey < todayKey) return 'danger';
  const daysLeft = Math.round((Date.parse(`${dueKey}T12:00:00`) - Date.parse(`${todayKey}T12:00:00`)) / DAY_MS);
  if (daysLeft <= 7) return 'warning';
  return 'accent';
}

function eventTitles(text: string): Pick<CalendarEvent, 'title' | 'fullTitle'> {
  return { title: text.length > 18 ? `${text.slice(0, 18)}…` : text, fullTitle: text };
}

/**
 * 全量事件构建。orders/shipments 为 App 级快照（已滤 deletedAt 的责任在调用方，
 * 此处按既有页面惯例同样跳过 deletedAt）。
 */
export function buildCalendarEvents(
  orders: Order[],
  shipments: Shipment[],
  developmentCases: DevelopmentCase[] = [],
  invoices: Invoice[] = [],
  today = businessNowDate(),
): CalendarEvent[] {
  const todayKey = toDateKey(today);
  const events: CalendarEvent[] = [];

  for (const order of orders) {
    if (order.deletedAt) continue;
    const dateKey = toEventDateKey(order.dueDate);
    if (!dateKey) continue;
    // 已交付且交期已过 → 历史留痕（info）；已交付但交期在未来 → 交易周期未完
    //（发票/回款可能未结清），走正常分级（7 日内 warning / 未来 accent），
    // 与 seed 财务分流的既定口径一致——避免 9-10 月一堵灰墙掩盖真实预警。
    const isCompleted = order.status === 'Delivered' && dateKey < todayKey;
    events.push({
      id: `order-due:${order.id}`,
      targetId: order.id,
      dateKey,
      kind: 'order-due',
      ...eventTitles(`${order.product} · ${order.customer}`),
      detail: `${order.quantity.toLocaleString()} ${order.unit ?? (order.type === 'Fabric' ? 'Meter' : 'Pcs')} · ${order.status}`,
      severity: resolveDueSeverity(dateKey, isCompleted, todayKey),
      targetView: View.Orders,
    });
  }

  for (const shipment of shipments) {
    if (shipment.deletedAt) continue;
    const etdKey = toEventDateKey(shipment.etd);
    if (etdKey) {
      events.push({
        id: `shipment-etd:${shipment.id}`,
        targetId: shipment.id,
        dateKey: etdKey,
        kind: 'shipment-etd',
        ...eventTitles(`离港 · ${shipment.shipmentNumber}`),
        detail: [shipment.portOfLoading, shipment.vesselOrFlight].filter(Boolean).join(' · ') || undefined,
        // 已实际离港（atd 存在）→ 记录；逾期未离 → danger；7 日内 → warning
        severity: shipment.atd
          ? 'info'
          : resolveDueSeverity(etdKey, false, todayKey),
        targetView: View.Shipments,
      });
    }
    const etaKey = toEventDateKey(shipment.eta);
    if (etaKey) {
      events.push({
        id: `shipment-eta:${shipment.id}`,
        targetId: shipment.id,
        dateKey: etaKey,
        kind: 'shipment-eta',
        ...eventTitles(`到港 · ${shipment.shipmentNumber}`),
        detail: [shipment.portOfDischarge, shipment.vesselOrFlight].filter(Boolean).join(' · ') || undefined,
        severity: shipment.ata ? 'info' : resolveDueSeverity(etaKey, false, todayKey),
        targetView: View.Shipments,
      });
    }
  }

  // ── 样品节点（2026-09-02 v2 扩展）──────────────────────────────
  // Order 级样品跟踪（船样 shipment sample / 匹头样 header sample）：
  //   - 有"需要船样/需要匹头样"标记时，发出/确认日按其状态判定等级
  for (const order of orders) {
    if (order.deletedAt) continue;
    // 匹头样（header sample）
    if (order.needHeaderSample) {
      const sentKey = toEventDateKey(order.fabricSampleSentDate);
      const confirmKey = toEventDateKey(order.fabricSampleConfirmedDate);
      const label = order.fabricSampleConfirmedDate
        ? '匹头样待确认'
        : (order.fabricSampleSentDate ? '匹头样待发信' : '匹头样待寄出');
      // 主节点：未发（计划期）→ accent 未来；已发未确认 → warning；已确认 → info
      const hasConfirm = Boolean(confirmKey);
      const hasSent = Boolean(sentKey);
      if (!hasSent) {
        events.push({
          id: `sample-confirm:${order.id}:header`,
          targetId: order.id,
          dateKey: todayKey,
          kind: 'sample-confirm',
          ...eventTitles(`${order.product} · 匹头样`),
          detail: '需要时发送（待安排）',
          severity: 'accent',
          targetView: View.Orders,
        });
      } else {
        events.push({
          id: `sample-sent:${order.id}:header`,
          targetId: order.id,
          dateKey: sentKey!,
          kind: 'sample-sent',
          ...eventTitles(`${order.product} · 匹头样寄出`),
          detail: order.fabricSampleTrackingNumber ? `单号 ${order.fabricSampleTrackingNumber}` : undefined,
          severity: hasConfirm ? 'info' : 'warning',
          targetView: View.Orders,
        });
      }
    }
    // 船样（shipment sample）
    if (order.needShipmentSample) {
      const sentKey = toEventDateKey(order.sampleSentDate);
      const confirmKey = toEventDateKey(order.sampleConfirmedDate);
      const hasSent = Boolean(sentKey);
      const hasConfirm = Boolean(confirmKey);
      if (!hasSent && !confirmKey) {
        events.push({
          id: `sample-confirm:${order.id}:shipment`,
          targetId: order.id,
          dateKey: todayKey,
          kind: 'sample-confirm',
          ...eventTitles(`${order.product} · 船样`),
          detail: '需要时发送（待安排）',
          severity: 'accent',
          targetView: View.Orders,
        });
      } else if (hasSent) {
        events.push({
          id: `sample-sent:${order.id}:shipment`,
          targetId: order.id,
          dateKey: sentKey!,
          kind: 'sample-sent',
          ...eventTitles(`${order.product} · 船样寄出`),
          detail: order.sampleTrackingNumber ? `单号 ${order.sampleTrackingNumber}` : undefined,
          severity: hasConfirm ? 'info' : 'warning',
          targetView: View.Orders,
        });
      }
    }
  }

  // 开发案样品（DevelopmentCase 顶层样品字段）
  for (const dev of developmentCases) {
    if (dev.deletedAt) continue;
    const sampleSentKey = toEventDateKey(dev.sampleSentDate);
    const feedbackKey = toEventDateKey(dev.sampleFeedbackDate);
    const isDone = dev.stage === 'approved' || dev.stage === 'cancelled';
    if (sampleSentKey) {
      events.push({
        id: `sample-sent:${dev.id}:dev`,
        targetId: dev.id,
        dateKey: sampleSentKey,
        kind: 'sample-sent',
        ...eventTitles(`${dev.sampleType ?? '样品'} · ${dev.customerName ?? '开发案'}`),
        detail: feedbackKey ? '已反馈' : (dev.sampleTrackingNumber ? `单号 ${dev.sampleTrackingNumber}` : '待客户反馈'),
        severity: isDone ? 'info' : (feedbackKey ? 'info' : 'warning'),
        targetView: View.Development,
      });
    }
    // 开发案目标完成节点（targetDate = 计划截止）
    const targetKey = toEventDateKey(dev.targetDate);
    if (targetKey) {
      events.push({
        id: `development-target:${dev.id}`,
        dateKey: targetKey,
        kind: 'development-target',
        ...eventTitles(`开发目标 · ${dev.productName ?? '开发案'}`),
        detail: `阶段 ${dev.stage}`,
        severity: isDone ? 'info' : resolveDueSeverity(targetKey, false, todayKey),
        targetView: View.Development,
      });
    }
  }

  // ── 发票到期（2026-09-02 v2 扩展，应收/应付）────────────────────
  for (const invoice of invoices) {
    if (invoice.deletedAt) continue;
    const dueKey = toEventDateKey(invoice.dueDate);
    if (!dueKey) continue;
    const isDone = invoice.status === 'Paid' || invoice.status === 'Cancelled';
    events.push({
      id: `invoice-due:${invoice.id}`,
      targetId: invoice.id,
      dateKey: dueKey,
      kind: 'invoice-due',
      ...eventTitles(`${invoice.type === 'Receivable' ? '应收' : '应付'} · ${invoice.invoiceNumber ?? invoice.id.slice(0, 8)}`),
      detail: `${invoice.currency ?? ''} ${invoice.amount ?? ''} · ${invoice.status}`.trim(),
      severity: isDone ? 'info' : resolveDueSeverity(dueKey, false, todayKey),
      targetView: invoice.type === 'Payable' ? View.PaymentVouchers : View.Invoices,
    });
  }

  return events;
}

/** 按日期索引事件（同日多事件保序），供月格 O(1) 取数 */
export function indexEventsByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const bucket = map.get(event.dateKey);
    if (bucket) bucket.push(event);
    else map.set(event.dateKey, [event]);
  }
  return map;
}

/** 类型筛选（全部 / 订单交期 / 出运节点） */
export function filterEvents(events: CalendarEvent[], filter: CalendarEventFilter): CalendarEvent[] {
  if (filter === 'all') return events;
  return events.filter(event => KIND_FILTER_MAP[event.kind] === filter);
}

/** 事件类型中文标签（详情面板/图例用） */
export function eventKindLabel(kind: CalendarEventKind): string {
  switch (kind) {
    case 'order-due': return '订单交期';
    case 'shipment-etd': return '预计离港';
    case 'shipment-eta': return '预计到港';
    case 'sample-sent': return '样品寄出';
    case 'sample-confirm': return '样品待确认';
    case 'invoice-due': return '发票到期';
    case 'development-target': return '开发目标';
  }
}

/** 事件类型主域标签（图例分组名，samples 含开发目标） */
export function eventKindGroupLabel(kind: CalendarEventKind): string {
  return KIND_FILTER_MAP[kind];
}
