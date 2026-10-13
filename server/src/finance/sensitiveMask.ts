/**
 * 权限矩阵全组合审计 P0-1 — finance 域敏感字段服务端遮罩（2026-09-03）
 *
 * 背景实锤：GET /api/v1/finance/reports/consolidated-profit（含 ?format=xlsx 导出）
 * 仅校验 finance:read——该 scope 全员持有（SALES/SALES_MANAGER/FINANCE/ADMIN/QC/LOGISTICS
 * 默认矩阵均含），Sales/QC/Logistics 未持 sensitive:cost / sensitive:profit 却可明文读取
 * 公司合并利润/成本。文档铁律：敏感字段按 sensitive:* scope 遮罩。
 *
 * 遮罩惯例（与 dashboard/sensitiveMask.ts、pricing/sensitiveMask.ts 同口径）：
 *   - 数字敏感字段 → null（前端 FinanceReportsPanel formatAmount 渲染 '—'）
 *   - 非敏感字段（合并收入/部门收入/订单计数/币种等）原样保留——「保留金额数量等非敏感字段」
 *
 * scope 判定复用 permissionGuard.hasScopeOnRequest（JWT permissions → owner 直通 →
 * legacy 角色 fallback 默认矩阵），与 dashboard/pricing 同语义。
 *
 * 覆盖响应形态（ConsolidatedProfitReport）：
 *   - consolidatedCost / costBreakdown.* / elimination.*（内部采购/销售/抵销额/差异）
 *     / departments.*.cost / unconverted[].amount → sensitive:cost
 *   - consolidatedProfit / departments.*.profit → sensitive:profit
 *   - consolidatedRevenue / departments.*.revenue / orders.* → 非敏感，保留
 */

import type { Request } from 'express';
import { hasScopeOnRequest } from '../auth/permissionGuard';
import type { ConsolidatedProfitReport, MaskedConsolidatedProfitDepartment, MaskedConsolidatedProfitReport } from './reportService';

export interface FinanceSensitiveVisibility {
  /** sensitive:cost — 成本 */
  cost: boolean;
  /** sensitive:profit — 利润 */
  profit: boolean;
}

export function financeSensitiveVisibility(req: Request): FinanceSensitiveVisibility {
  return {
    cost: hasScopeOnRequest(req, 'sensitive:cost'),
    profit: hasScopeOnRequest(req, 'sensitive:profit'),
  };
}

/** 数字遮罩：敏感数字一律 → null（前端按 null 渲染 '—'；对可能为 null 的输入同样归 null） */
function maskNum(_v: number | null | undefined): number | null {
  return null;
}

export function maskConsolidatedProfitReport(
  report: ConsolidatedProfitReport,
  req: Request,
): ConsolidatedProfitReport | MaskedConsolidatedProfitReport {
  const vis = financeSensitiveVisibility(req);
  if (vis.cost && vis.profit) return report;

  const garment: MaskedConsolidatedProfitDepartment = { ...report.departments.garment };
  const fabric: MaskedConsolidatedProfitDepartment = { ...report.departments.fabric };
  if (!vis.cost) {
    garment.cost = maskNum(garment.cost);
    fabric.cost = maskNum(fabric.cost);
  }
  if (!vis.profit) {
    garment.profit = maskNum(garment.profit);
    fabric.profit = maskNum(fabric.profit);
  }

  return {
    ...report,
    consolidatedCost: vis.cost ? report.consolidatedCost : maskNum(report.consolidatedCost),
    consolidatedProfit: vis.profit ? report.consolidatedProfit : maskNum(report.consolidatedProfit),
    costBreakdown: vis.cost
      ? report.costBreakdown
      : {
          externalPurchaseNetOfInternal: null,
          realFabricCost: null,
          freightCost: null,
          miscCost: null,
          // ★ M1·D7-1c：新增两个成本维度会随 costBreakdown 整体出现在响应里。
          //   漏遮 = 无 sensitive:cost 的人「合计被遮、但手续费/折让明文」⇒ G4 权限边界破口，
          //   与 pricing/sensitiveMask 里 bankFeeCost/allowanceCost 的处理同一取向。
          bankFeeCost: null,
          allowanceCost: null,
        },
    elimination: vis.cost
      ? report.elimination
      : {
          internalPurchase: null,
          internalSales: null,
          amount: null,
          discrepancy: null,
        },
    departments: { garment, fabric },
    unconverted: vis.cost
      ? report.unconverted
      : report.unconverted.map(u => ({ ...u, amount: null })),
  };
}
