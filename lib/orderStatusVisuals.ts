import type { Order } from '../types';

export type OrderStatusDotTone = 'neutral' | 'blue' | 'green' | 'red';

export interface OrderStatusDotVisual {
  tone: OrderStatusDotTone;
  className: string;
  label: string;
}

const STATUS_DOT_VISUALS: Record<Exclude<Order['status'], 'Delivered'>, OrderStatusDotVisual> = {
  Pending: {
    tone: 'neutral',
    label: '待生产',
    className: 'bg-slate-400 shadow-[0_0_8px_rgba(148,163,184,0.35)]',
  },
  Production: {
    tone: 'blue',
    label: '生产中',
    className: 'bg-[#4A90E2] shadow-[0_0_10px_rgba(74,144,226,0.45)]',
  },
  Confirmed: {
    tone: 'blue',
    label: '已确认',
    className: 'bg-[#4A90E2] shadow-[0_0_10px_rgba(74,144,226,0.38)]',
  },
  Shipping: {
    tone: 'green',
    label: '已出运',
    className: 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.45)]',
  },
  Alert: {
    tone: 'red',
    label: '有延误',
    className: 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]',
  },
  Cancelled: {
    tone: 'neutral',
    label: '已取消',
    className: 'bg-slate-500 shadow-none',
  },
};

export function getOrderStatusDot(status: Order['status']): OrderStatusDotVisual | null {
  if (status === 'Delivered') return null;
  return STATUS_DOT_VISUALS[status];
}
