/**
 * W-C 权限收口补漏 — dashboard 域敏感字段服务端遮罩（2026-09-02）
 *
 * 背景实锤：GET /api/v1/dashboard/cockpit 仅校验 cockpit:read，对未持
 * sensitive:cost / sensitive:profit 的角色（sales 等，SALES_BASE 明文注释
 * 「成本/利润敏感scope没给=自动遮罩」但从未实现）全量返回订单毛利表的
 * cost/margin/marginRate 与回款率。文档铁律：敏感字段按 sensitive:* scope 遮罩。
 *
 * 遮罩惯例（与 pricing/sensitiveMask.ts、auth/permissionService.ts stripSensitive 同口径）：
 *   - 数字敏感字段 → null（前端 CockpitManager formatPct/formatAmount 渲染 '—'）
 *
 * scope 判定复用 permissionGuard.hasScopeOnRequest（JWT permissions → owner 直通 →
 * legacy 角色 fallback 默认矩阵）。
 *
 * 覆盖响应形态：
 *   - orderMargins.rows[]：cost（sensitive:cost）、margin/marginRate/collectionRate（sensitive:profit）
 *   - orderMargins.totals[]：cost（sensitive:cost）、margin/marginRate（sensitive:profit）
 *   - salesLeaderboard[]：collectionRate（sensitive:profit；collectedAmount 为回款流水非成本/利润，不在敏感矩阵内）
 */

import type { Request } from 'express';
import { hasScopeOnRequest } from '../auth/permissionGuard';
import type { BusinessCockpit, OrderMarginRow, OrderMarginTotal, SalesLeaderboardRow } from './dashboardService';

export interface DashboardSensitiveVisibility {
  /** sensitive:cost — 成本 */
  cost: boolean;
  /** sensitive:profit — 毛利/毛利率/回款率 */
  profit: boolean;
}

export function dashboardSensitiveVisibility(req: Request): DashboardSensitiveVisibility {
  return {
    cost: hasScopeOnRequest(req, 'sensitive:cost'),
    profit: hasScopeOnRequest(req, 'sensitive:profit'),
  };
}

function maskOrderMarginRow(row: OrderMarginRow, vis: DashboardSensitiveVisibility): OrderMarginRow {
  if (!row || typeof row !== 'object') return row;
  const r = { ...row };
  if (!vis.cost) r.cost = null;
  if (!vis.profit) {
    r.margin = null;
    r.marginRate = null;
    r.collectionRate = null;
  }
  return r;
}

function maskOrderMarginTotal(t: OrderMarginTotal, vis: DashboardSensitiveVisibility): OrderMarginTotal {
  if (!t || typeof t !== 'object') return t;
  const r = { ...t };
  if (!vis.cost) r.cost = null;
  if (!vis.profit) {
    r.margin = null;
    r.marginRate = null;
  }
  return r;
}

function maskSalesLeaderboardRow(row: SalesLeaderboardRow, vis: DashboardSensitiveVisibility): SalesLeaderboardRow {
  if (!vis.profit) return { ...row, collectionRate: null };
  return row;
}

/**
 * 路由出口统一遮罩：对 cockpit 聚合结果按请求者 sensitive scope 裁剪敏感数字。
 *
 * ★★ **本函数刻意不处理 `fxSummary`（汇兑损益）与 `arApAlerts`（应收应付逾期预警）**
 *    —— 这是**业务方 2026-09-17 确认的口径（口径 B2）**：
 *    这两块**对所有人可见**（含业务员），**不需要** `fx:read` / `ar:read` 两个 scope。
 *
 *    ⚠️ **不要"顺手"给它们加遮罩** —— 那会改变业务方确认过的行为。
 *    若将来口径变了，请同时改 `docs/业务口径决策单-2026-09-17.md` B2
 *    与 `__tests__/sensitiveMask.test.ts` 里那条「不遮罩」断言（它会红，正是设计意图）。
 */
export function maskBusinessCockpit(cockpit: BusinessCockpit, req: Request): BusinessCockpit {
  const vis = dashboardSensitiveVisibility(req);
  if (vis.cost && vis.profit) return cockpit;
  return {
    ...cockpit,
    salesLeaderboard: cockpit.salesLeaderboard.map(r => maskSalesLeaderboardRow(r, vis)),
    orderMargins: {
      ...cockpit.orderMargins,
      rows: cockpit.orderMargins.rows.map(r => maskOrderMarginRow(r, vis)),
      totals: cockpit.orderMargins.totals.map(t => maskOrderMarginTotal(t, vis)),
    },
  };
}
