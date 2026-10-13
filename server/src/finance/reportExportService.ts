/**
 * 财务报表 Excel 导出（2026-08-22 全系统文档体系：财务 6 大报表零导出缺口收口）。
 *
 * 每个 reportService 报表一个转换器：JSON 结构 → XlsxSheet[]（多币种/多区块
 * 天然多 sheet 或合并行）。输出分工裁决：对外文件 PDF（对账单另有 PDF 模板），
 * 对内分析 Excel——本模块负责对内分析侧。
 */

import type { XlsxSheet } from '../templates/xlsxExport';
import type {
  AgingReport,
  CustomerStatement,
  SupplierStatement,
  FxGainLossReport,
  CashCalendarReport,
  ConsolidatedProfitReport,
  MaskedConsolidatedProfitReport,
} from './reportService';

// ── 1. 账龄分析（应收/应付五桶） ──

export function agingToSheets(report: AgingReport): XlsxSheet[] {
  const label = report.type === 'Receivable' ? '应收' : '应付';
  const columns = ['customerName', 'currency', 'invoiceCount', 'current', 'd1_30', 'd31_60', 'd61_90', 'd90plus', 'total'];
  const rows: Array<Record<string, unknown>> = report.rows.map(r => ({
    customerName: r.customerName,
    currency: r.currency,
    invoiceCount: r.invoiceCount,
    current: r.buckets.current,
    d1_30: r.buckets.d1_30,
    d31_60: r.buckets.d31_60,
    d61_90: r.buckets.d61_90,
    d90plus: r.buckets.d90plus,
    total: r.buckets.total,
  }));
  for (const t of report.totals) {
    rows.push({
      customerName: `合计（${t.currency}）`,
      currency: t.currency,
      invoiceCount: '',
      current: t.current, d1_30: t.d1_30, d31_60: t.d31_60, d61_90: t.d61_90, d90plus: t.d90plus, total: t.total,
    });
  }
  return [{
    name: `${label}账龄 ${report.asOf}`,
    columnLabels: ['客户/供应商', '币种', '发票数', '未到期', '1-30天', '31-60天', '61-90天', '90天以上', '未结合计'],
    columns,
    rows,
  }];
}

// ── 2/2b. 对账单（客户/供应商共用 Section 结构；多币种一节一个 sheet） ──

function statementSheets(
  baseName: string,
  partyName: string | null,
  from: string | null,
  to: string | null,
  sections: CustomerStatement['sections'],
  kindLabels: Record<string, string>,
): XlsxSheet[] {
  const range = from || to ? `${from ?? '…'}~${to ?? '…'}` : '全部';
  const sheets: XlsxSheet[] = sections.map(sec => ({
    name: `${baseName}-${sec.currency}`.slice(0, 31),
    columnLabels: [`日期（${range}）`, '类型', '单据号', '借方(增加)', '贷方(减少)', '余额', '期初', '期末', '对象'],
    columns: ['date', 'kind', 'number', 'debit', 'credit', 'balance', 'opening', 'closing', 'party'],
    rows: [
      { date: '', kind: '期初余额', number: '', debit: '', credit: '', balance: sec.openingBalance, opening: sec.openingBalance, closing: sec.closingBalance, party: partyName ?? '' },
      ...sec.transactions.map(t => ({
        date: t.date,
        kind: kindLabels[t.kind] ?? t.kind,
        number: t.number,
        debit: t.debit,
        credit: t.credit,
        balance: t.balance,
        opening: '', closing: '', party: '',
      })),
      { date: '', kind: '期末余额', number: '', debit: '', credit: '', balance: sec.closingBalance, opening: '', closing: sec.closingBalance, party: '' },
    ],
  }));
  return sheets;
}

/**
 * B271：对账单导出文件名收成这一个函数 —— 它的形参里**没有**内部主键的位置，
 * 所以"名字取不到就退回 relation id"那一档在结构上写不出来（B269 的两枚文件名当时只有人工 curl 证人）。
 */
export function statementExportFileName(
  prefix: string,
  name: string | null,
  code: string | null,
  to: string | null,
): string {
  return [prefix, name || code, `${to ?? '全部'}.xlsx`].filter(Boolean).join('_');
}

export function customerStatementToSheets(report: CustomerStatement): XlsxSheet[] {
  return statementSheets('客户对账', report.customerName, report.from, report.to, report.sections, {
    invoice: '发票', receipt: '收款', credit: '贷项抵扣', payment: '付款',
  });
}

export function supplierStatementToSheets(report: SupplierStatement): XlsxSheet[] {
  return statementSheets('供应商对账', report.supplierName, report.from, report.to, report.sections, {
    invoice: '发票', payment: '付款', credit: '贷项抵扣',
  });
}

// ── 3. 汇率损益 ──

export function fxGainLossToSheets(report: FxGainLossReport): XlsxSheet[] {
  const rows: Array<Record<string, unknown>> = report.rows.map(r => ({ ...r }));
  rows.push({
    allocationId: '', appliedDate: '', invoiceNumber: '合计', voucherNumber: '', invoiceType: '',
    currency: report.baseCurrency, appliedAmount: '', invoiceRate: '', voucherRate: '', gainLoss: report.totalGainLoss,
  });
  return [{
    name: '汇率损益',
    columnLabels: ['核销日期', '发票号', '凭证号', '方向', '币种', '核销金额', '开票汇率', '收款汇率', `损益(${report.baseCurrency})`],
    columns: ['appliedDate', 'invoiceNumber', 'voucherNumber', 'invoiceType', 'currency', 'appliedAmount', 'invoiceRate', 'voucherRate', 'gainLoss'],
    rows,
  }];
}

// ── 4. 资金日历（四区块多 sheet） ──

export function cashCalendarToSheets(report: CashCalendarReport): XlsxSheet[] {
  const sheets: XlsxSheet[] = [];
  const actions = [...report.todayActions, ...report.upcoming];
  if (actions.length > 0) {
    sheets.push({
      name: `现金流动作 ${report.asOf}`,
      columnLabels: ['单据号', '方向', '交易对象', '币种', '未结金额', '到期日', '逾期天数', '批次'],
      columns: ['invoiceNumber', 'type', 'counterparty', 'currency', 'openAmount', 'dueDate', 'daysOverdue', 'batch'],
      rows: actions.map(a => ({
        ...a,
        type: a.type === 'Receivable' ? '应收(流入)' : '应付(流出)',
        batch: report.todayActions.includes(a) ? '今日动作' : `未来${report.days}天`,
      })),
    });
  }
  if (report.forecast.length > 0) {
    sheets.push({
      name: '现金流预测',
      columnLabels: ['币种', '逾期未收', '逾期未付', `窗口流入(${report.days}d)`, `窗口流出(${report.days}d)`, '窗口净额', '笔数'],
      columns: ['currency', 'overdueInflow', 'overdueOutflow', 'windowInflow', 'windowOutflow', 'netWindow', 'itemCount'],
      rows: report.forecast as unknown as Array<Record<string, unknown>>,
    });
  }
  if (report.fxExposure.length > 0) {
    sheets.push({
      name: '外汇敞口',
      columnLabels: ['币种', '净应收', '净应付'],
      columns: ['currency', 'netReceivable', 'netPayable'],
      rows: report.fxExposure as unknown as Array<Record<string, unknown>>,
    });
  }
  if (report.unappliedVouchers.length > 0) {
    sheets.push({
      name: '未核销凭证',
      columnLabels: ['凭证类别', '币种', '未核销余额', '笔数'],
      columns: ['voucherCategory', 'currency', 'unapplied', 'count'],
      rows: report.unappliedVouchers as unknown as Array<Record<string, unknown>>,
    });
  }
  return sheets;
}

// ── 5. 合并利润 ──

export function consolidatedProfitToSheets(report: ConsolidatedProfitReport | MaskedConsolidatedProfitReport): XlsxSheet[] {
  const summary: Array<Record<string, unknown>> = [
    { item: '实际成本覆盖状态', value: report.coverage?.status === 'complete' ? '完整' : '未完整，空金额不代表零成本或零利润' },
    { item: '已验证订单数', value: report.coverage?.coveredCount ?? 0 },
    { item: '待完善成本依据订单数', value: report.coverage?.pendingCount ?? 0 },
    { item: '旧表或缺少利润表订单数', value: report.coverage?.unknownCount ?? 0 },
    { item: '合并收入（本位币）', value: report.consolidatedRevenue },
    { item: '合并成本（本位币）', value: report.consolidatedCost },
    { item: '合并利润（本位币）', value: report.consolidatedProfit },
    { item: '', value: '' },
    { item: '成本构成：外部采购（净内部加价）', value: report.costBreakdown.externalPurchaseNetOfInternal },
    { item: '成本构成：真实面料成本', value: report.costBreakdown.realFabricCost },
    { item: '成本构成：运费', value: report.costBreakdown.freightCost },
    { item: '成本构成：杂费', value: report.costBreakdown.miscCost },
    // ★ M1·D7-1c：导出与页面必须同口径 —— 少一行就等于把手续费/折让从成本里抹掉，
    //   而合计里却含着 ⇒ 导出的分项加不出合计，是典型的"对不上账"投诉源。
    { item: '成本构成：银行手续费（收款侧）', value: report.costBreakdown.bankFeeCost },
    { item: '成本构成：折让/索赔', value: report.costBreakdown.allowanceCost },
    { item: '', value: '' },
    { item: '抵销：内部采购合计', value: report.elimination.internalPurchase },
    { item: '抵销：内部销售合计', value: report.elimination.internalSales },
    { item: '抵销额（单边口径）', value: report.elimination.amount },
    { item: '双边差异（应≈0）', value: report.elimination.discrepancy },
    { item: '', value: '' },
    { item: '服装部收入', value: report.departments.garment.revenue },
    { item: '服装部成本', value: report.departments.garment.cost },
    { item: '服装部利润', value: report.departments.garment.profit },
    { item: '面料部收入', value: report.departments.fabric.revenue },
    { item: '面料部成本', value: report.departments.fabric.cost },
    { item: '面料部利润', value: report.departments.fabric.profit },
    { item: '', value: '' },
    { item: '外部订单数', value: report.orders.externalCount },
    { item: '内部订单数', value: report.orders.internalCount },
  ];
  const sheets: XlsxSheet[] = [{
    name: '合并利润汇总',
    columnLabels: ['项目', `金额(${report.baseCurrency})`],
    columns: ['item', 'value'],
    rows: summary,
  }];
  if (report.unconverted.length > 0) {
    sheets.push({
      name: '非本位币披露',
      columnLabels: ['交易ID', '订单ID', '方向', '金额', '币种', '说明'],
      columns: ['transferId', 'orderId', 'direction', 'amount', 'currency', 'reason'],
      rows: report.unconverted as unknown as Array<Record<string, unknown>>,
    });
  }
  return sheets;
}
