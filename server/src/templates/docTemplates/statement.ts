
/**
 * Statement of Account 客户对账单 — 服务端单据模板（2026-08-22 B9 财务域报表）。
 *
 * 架构裁决：
 *   - 模板真源服务端（docTemplates/ 注册表体系 STMT kind），数据真源=
 *     finance/reportService.getCustomerStatement（期初/流水/期末 + running balance）
 *   - 周期性报表而非归档单据：preview 走 finance 路由 /reports/statement/preview.html
 *     （与发票 preview.html 同模式），不登记 TradeDocument
 *   - 多币种分节呈现（每币种独立期初/流水/期末），与 xlsx 导出 statementSheets 同数据形状
 */

import { esc } from '../docPrintBase';
import type { DocExporterProfile } from './packingList';
import { todayLocalKey } from '../../shared/localDate';


// ────────────────────────────────────────────────────────────────
// 数据形状（与 finance/reportService.CustomerStatement 对齐）
// ────────────────────────────────────────────────────────────────

export interface StatementDocTransaction {
  date: string;
  kind: 'invoice' | 'receipt' | 'payment' | 'credit';
  number: string;
  debit: number;
  credit: number;
  balance: number;
  /** A2 第三方代付标注：本行收款由第三方代付（对账单发出去必须写得清是谁付的） */
  isThirdParty?: boolean;
  payerName?: string | null;
  note?: string | null;
}

export interface StatementDocSection {
  currency: string;
  openingBalance: number;
  closingBalance: number;
  transactions: StatementDocTransaction[];
}

export interface StatementDocData {
  customerRelationId: string;
  customerName: string | null;
  /** B269：对外件只印业务编码（CUS-0001），内部 relation id 不许出现在客户拿到的那张纸上 */
  customerCode: string | null;
  from: string | null;
  to: string | null;
  sections: StatementDocSection[];
}

// ────────────────────────────────────────────────────────────────
// 渲染（body 片段；经 buildServerDocument 组装）
// ────────────────────────────────────────────────────────────────

const money = (v: number | null, currency: string): string =>
  v == null ? '—' : `${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

const KIND_LABEL: Record<string, string> = {
  invoice: 'Invoice 发票',
  receipt: 'Receipt 收款',
  payment: 'Payment 付款',
  credit: 'Credit applied 贷项抵扣',
};

/** 客户对账单渲染（body 片段，中英文对照——多币种分节） */
export function renderStatementBody(data: StatementDocData, exporter: DocExporterProfile): string {
  const period = data.from || data.to
    ? `${data.from ?? '…'} ~ ${data.to ?? '…'}`
    : 'All Period 全部期间';
  const generatedAt = todayLocalKey();

  const sectionsHtml = data.sections.map(sec => {
    const rows = sec.transactions.map(t => `
      <tr>
        <td>${esc(t.date)}</td>
        <td>${esc(KIND_LABEL[t.kind] ?? t.kind)}${t.isThirdParty ? `<div style="font-size:11px;color:#b7791f">Third-party payment 第三方代付${t.payerName ? `：${esc(t.payerName)}` : ''}</div>` : ''}</td>
        <td>${esc(t.number)}${t.note ? `<div style="font-size:11px;color:#718096">${esc(t.note)}</div>` : ''}</td>
        <td style="text-align:right">${t.debit ? money(t.debit, sec.currency) : '—'}</td>
        <td style="text-align:right">${t.credit ? money(t.credit, sec.currency) : '—'}</td>
        <td style="text-align:right">${money(t.balance, sec.currency)}</td>
      </tr>`).join('');

    const emptyRow = sec.transactions.length === 0
      ? `<tr><td colspan="6" style="text-align:center;color:#718096">No transactions in period 本期间无交易</td></tr>`
      : '';

    return `
    <div class="doc-section">
      <div class="doc-section-title">Account Summary · ${esc(sec.currency)} 账户小节（${esc(sec.currency)}）</div>
      <table class="doc-table">
        <thead>
          <tr>
            <th>Date 日期</th>
            <th>Type 类型</th>
            <th>Doc No. 单据号</th>
            <th style="text-align:right">Debit 借方(增加)</th>
            <th style="text-align:right">Credit 贷方(减少)</th>
            <th style="text-align:right">Balance 余额</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colspan="3"><strong>Opening Balance 期初余额</strong></td>
            <td colspan="2"></td>
            <td style="text-align:right"><strong>${money(sec.openingBalance, sec.currency)}</strong></td>
          </tr>
          ${rows}
          ${emptyRow}
          <tr>
            <td colspan="3"><strong>Closing Balance 期末余额</strong></td>
            <td colspan="2"></td>
            <td style="text-align:right"><strong>${money(sec.closingBalance, sec.currency)}</strong></td>
          </tr>
        </tbody>
      </table>
    </div>`;
  }).join('');

  const emptySections = data.sections.length === 0
    ? `<div class="doc-section"><div class="doc-section-title">Account Summary 账户小节</div>
       <p style="color:#718096">No billing activity on record 无账务记录。</p></div>`
    : '';

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>STATEMENT OF ACCOUNT</h1>
      <div class="subtitle">客户对账单</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">${esc(data.customerName || data.customerCode || '—')}</div>
      <div>Period 期间: ${esc(period)}</div>
      <div>Generated 生成日期: ${esc(generatedAt)}</div>
    </div>
  </div>

  <div class="doc-party-grid">
    <div class="doc-party">
      <div class="label">From 出具方</div>
      <div class="name">${esc(exporter.nameEn)}</div>
      <div class="detail">${esc(exporter.addressEn || '')}</div>
    </div>
    <div class="doc-party">
      <div class="label">To 客户</div>
      <div class="name">${esc(data.customerName || '—')}</div>
      ${data.customerCode ? `<div class="detail">Account 账户: ${esc(data.customerCode)}</div>` : ''}
    </div>
  </div>

  ${sectionsHtml}
  ${emptySections}

  <div class="doc-notes">
    <div class="notes-title">Notes 备注</div>
    <div style="font-size:11px;line-height:1.8">
      本对账单涵盖所选期间内的应收发票与收款流水；期末余额为该客户当前应收净额。
      如对以上明细有任何疑问，请于收到对账单后 7 个工作日内与我们联系，逾期视为确认无误。
    </div>
  </div>

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (出具方签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">Customer Confirmation 客户确认</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
  </div>`;
}
