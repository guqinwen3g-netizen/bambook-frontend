/**
 * 权限矩阵全组合审计 P0-4 — BOM 域敏感字段服务端遮罩（2026-09-03）
 *
 * 背景实锤：GET /api/v1/bom 列表与 /:id 详情仅 module 认证门，返回 unitCost / amount /
 * totalMaterialCost / totalLaborCost / totalOverheadCost / totalCost / profitAmount 等
 * 成本字段。矩阵敏感 scope 持有实测：sensitive:cost 仅 Fin/Admin/SuperAdmin 持有，
 * Sales/SM/QC（持 bom:read 但无 sensitive:cost）不应看到 BOM 成本明细。
 * 文档铁律：敏感字段按 sensitive:* scope 遮罩。
 *
 * 遮罩惯例（与 dashboard/sensitiveMask.ts、pricing/sensitiveMask.ts、finance/sensitiveMask.ts
 * 同口径）：数字敏感字段 → null（前端 formatMoney 渲染 '—'）；保形不删行。
 */

import type { Request } from 'express';
import { hasScopeOnRequest } from '../auth/permissionGuard';

export interface BomSensitiveVisibility {
  /** sensitive:cost — BOM 成本/单价/金额 */
  cost: boolean;
}

export function bomSensitiveVisibility(req: Request): BomSensitiveVisibility {
  return {
    cost: hasScopeOnRequest(req, 'sensitive:cost'),
  };
}

/** 数字遮罩：已有 null/undefined 原样保留，其余 → null */
function maskNum(v: unknown): unknown {
  return v === undefined || v === null ? v : null;
}

/** BOM 列表项遮罩：四项成本合计及利润 → null */
export function maskBomListItem<T extends Record<string, any>>(item: T, vis: BomSensitiveVisibility): T {
  if (!item || typeof item !== 'object' || vis.cost) return item;
  const r: any = { ...item };
  r.totalMaterialCost = maskNum(r.totalMaterialCost);
  r.totalLaborCost = maskNum(r.totalLaborCost);
  r.totalOverheadCost = maskNum(r.totalOverheadCost);
  r.totalCost = maskNum(r.totalCost);
  r.profitAmount = maskNum(r.profitAmount);
  r.profitMargin = maskNum(r.profitMargin);
  return r as T;
}

/** BOM 详情遮罩：成本合计 + 物料行 unitCost/amount + 成本估算项 amount + 利润分析 → null */
export function maskBomDetail<T extends Record<string, any>>(bom: T, vis: BomSensitiveVisibility): T {
  if (!bom || typeof bom !== 'object' || vis.cost) return bom;
  const r: any = { ...bom };
  r.totalMaterialCost = maskNum(r.totalMaterialCost);
  r.totalLaborCost = maskNum(r.totalLaborCost);
  r.totalOverheadCost = maskNum(r.totalOverheadCost);
  r.totalCost = maskNum(r.totalCost);
  r.profitAmount = maskNum(r.profitAmount);
  r.profitMargin = maskNum(r.profitMargin);
  if (Array.isArray(r.lines)) {
    r.lines = r.lines.map((l: any) =>
      l && typeof l === 'object' ? { ...l, unitCost: maskNum(l.unitCost), amount: maskNum(l.amount) } : l);
  }
  if (Array.isArray(r.costEstimates)) {
    r.costEstimates = r.costEstimates.map((ce: any) =>
      ce && typeof ce === 'object' ? { ...ce, amount: maskNum(ce.amount) } : ce);
  }
  return r as T;
}
