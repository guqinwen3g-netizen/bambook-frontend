import { businessNowDate } from '../../shared/businessClock';
/**
 * Consolidated Inspection Summary 合并验货汇总 — 组合文档模板（2026-08-22 B3 多选叠加生成）。
 *
 * 架构裁决：
 *   - 多对一数据聚合：多份验货报告合并为一份汇总文档——头部跨报告合计统计 +
 *     每报告一节（订单/类型/结果/抽样/缺陷/双签状态）
 *   - 组合文档是即时性汇总产物，不登记 TradeDocument，走 composite 端点流式输出
 *   - 版式：doc-* 基座，与单份 IR 同一气质
 */

import { esc } from '../docPrintBase';
import type { DocExporterProfile } from './packingList';
import type { InspectionReportDocData } from './inspectionReport';

// ────────────────────────────────────────────────────────────────
// 数据形状（compositeDocumentService.loadMergedInspectionSummary 输出）
// ────────────────────────────────────────────────────────────────

export interface MergedInspectionSummaryData {
  reports: InspectionReportDocData[];
  summary: {
    count: number;
    totalUnits: number;
    passedUnits: number;
    failedUnits: number;
    criticalDefects: number;
    majorDefects: number;
    minorDefects: number;
    passCount: number;
    conditionalCount: number;
    failCount: number;
  };
}

// ────────────────────────────────────────────────────────────────
// 渲染（body 片段；经 buildServerDocument 组装）
// ────────────────────────────────────────────────────────────────

const dash = (v: string | number | null | undefined): string => (v === null || v === undefined || v === '' ? '—' : esc(String(v)));

const linesToHtml = (text: string | null | undefined): string =>
  text ? String(text).split(/\r?\n/).map(esc).join('<br>') : '';

const RESULT_LABEL: Record<string, string> = {
  pass: 'PASS',
  conditional: 'CONDITIONAL',
  fail: 'FAIL',
};

const today = (): string => {
  const d = businessNowDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function reportSection(report: InspectionReportDocData, index: number): string {
  const r = report.report;
  const result = r.result != null ? RESULT_LABEL[r.result] ?? r.result : 'PENDING';
  const resultColor = r.result === 'pass' ? '#15803d' : r.result === 'fail' ? '#b91c1c' : r.result === 'conditional' ? '#a16207' : '#4a5568';
  return `
  <div class="doc-section">
    <div class="doc-section-title">Report ${index + 1} · ${esc(report.order?.poNumber || report.order?.customer || r.id)}</div>
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>Type 验货类型</strong></td>
          <td style="width:25%">${r.inspectionType === 'final' ? 'Final 最终验货' : 'Midline 中期验货'}</td>
          <td style="width:25%"><strong>Result 结论</strong></td>
          <td style="width:25%;color:${resultColor};font-weight:700">${esc(result)}</td>
        </tr>
        <tr>
          <td><strong>Customer 客户</strong></td>
          <td>${dash(report.order?.customer)}</td>
          <td><strong>Product 品名</strong></td>
          <td>${dash(report.order?.product)}</td>
        </tr>
        <tr>
          <td><strong>Inspection Date 验货日期</strong></td>
          <td>${dash(r.inspectionDate)}</td>
          <td><strong>Inspector 验货方</strong></td>
          <td>${dash(r.inspectorOrg)}</td>
        </tr>
        <tr>
          <td><strong>Sampled / Total 抽检/总数</strong></td>
          <td>${dash(r.sampleSize)} / ${dash(r.totalUnits)}</td>
          <td><strong>Passed 合格</strong></td>
          <td>${dash(r.passedUnits)}</td>
        </tr>
        <tr>
          <td><strong>Defects C/M/M 缺陷</strong></td>
          <td colspan="3">${r.criticalDefects} Critical / ${r.majorDefects} Major / ${r.minorDefects} Minor</td>
        </tr>
        <tr>
          <td><strong>Signatures 双签</strong></td>
          <td colspan="3">QC ${r.qcSignedAt ? 'Signed ' + esc(r.qcSignedAt) : 'Pending'} · Business ${r.businessSignedAt ? 'Signed ' + esc(r.businessSignedAt) : 'Pending'}</td>
        </tr>
      </tbody>
    </table>
    ${r.defectSummary ? `<div style="font-size:10px;color:#718096;margin-top:-12px;margin-bottom:4px">${linesToHtml(r.defectSummary)}</div>` : ''}
  </div>`;
}

/** 合并验货汇总渲染（body 片段） */
export function renderMergedInspectionSummaryBody(data: MergedInspectionSummaryData, exporter: DocExporterProfile): string {
  const s = data.summary;
  const overall = s.failCount > 0 ? 'FAIL 不合格' : s.conditionalCount > 0 ? 'CONDITIONAL 有条件放行' : s.passCount > 0 ? 'PASS 合格' : 'PENDING';
  const overallColor = s.failCount > 0 ? '#b91c1c' : s.conditionalCount > 0 ? '#a16207' : '#15803d';

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>INSPECTION SUMMARY</h1>
      <div class="subtitle">验货汇总（Consolidated · ${s.count} Reports 合并）</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">CONSOLIDATED</div>
      <div>Date: ${today()}</div>
      <div>Reports: ${s.count}</div>
      <div style="margin-top:6px"><span style="display:inline-block;padding:3px 12px;border:1px solid ${overallColor};border-radius:4px;background:#fff;color:${overallColor};font-weight:700;font-size:12px;letter-spacing:1px">${esc(overall)}</span></div>
    </div>
  </div>

  <div class="doc-party-grid">
    <div class="doc-party">
      <div class="label">Inspection Body 验货方</div>
      <div class="name">${esc(exporter.nameEn)}</div>
      <div class="detail">Consolidated QC Summary</div>
    </div>
    <div class="doc-party">
      <div class="label">Summary 汇总</div>
      <div class="name">${s.passCount} PASS · ${s.conditionalCount} CONDITIONAL · ${s.failCount} FAIL</div>
      <div class="detail">Total ${s.totalUnits.toLocaleString('en-US')} units · Passed ${s.passedUnits.toLocaleString('en-US')} · Failed ${s.failedUnits.toLocaleString('en-US')}</div>
    </div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Overall Totals 跨报告合计</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th>Reports 报告数</th>
          <th style="text-align:right">Total Units 总检查数</th>
          <th style="text-align:right">Passed 合格</th>
          <th style="text-align:right">Failed 不合格</th>
          <th style="text-align:right">Critical 致命缺陷</th>
          <th style="text-align:right">Major 主要缺陷</th>
          <th style="text-align:right">Minor 次要缺陷</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${s.count}</td>
          <td style="text-align:right">${s.totalUnits.toLocaleString('en-US')}</td>
          <td style="text-align:right">${s.passedUnits.toLocaleString('en-US')}</td>
          <td style="text-align:right">${s.failedUnits.toLocaleString('en-US')}</td>
          <td style="text-align:right;font-weight:600;color:${s.criticalDefects > 0 ? '#b91c1c' : '#1a202c'}">${s.criticalDefects}</td>
          <td style="text-align:right;font-weight:600;color:${s.majorDefects > 0 ? '#b91c1c' : '#1a202c'}">${s.majorDefects}</td>
          <td style="text-align:right;font-weight:600">${s.minorDefects}</td>
        </tr>
      </tbody>
    </table>
  </div>

  ${data.reports.map((r, i) => reportSection(r, i)).join('')}

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">QC Inspector 质检负责人（汇总签章）</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">Business Confirmation 业务确认</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
  </div>`;
}
