/**
 * Inspection Report 验货报告 — 服务端单据模板（2026-08-22 B2 运营域单据）。
 *
 * 架构裁决：
 *   - 模板真源服务端（docTemplates/ 注册表体系），与 PL/PO/发票同一 doc-* 基座
 *   - 数据真源=InspectionReport 业务实时装配（不复制进版本快照）——
 *     sourceRef=InspectionReport.id，domain=qc，文档号 IR-YYYY-NNNN（IR 前缀已预留）
 *   - 双签区与 QC 域双签语义对齐（signatures.qcSignedAt / businessSignedAt）：
 *     未签显示待签占位，已签显示签署日期
 */

import { PrismaClient } from '@prisma/client';
import { esc } from '../docPrintBase';
import type { DocExporterProfile } from './packingList';

// ────────────────────────────────────────────────────────────────
// 数据形状（loadInspectionReportDocData 装配输出）
// ────────────────────────────────────────────────────────────────

export interface InspectionReportDocData {
  report: {
    id: string;
    inspectionType: string; // final | midpoint
    inspectionDate: string | null;
    inspectorOrg: string | null;
    aqlLevel: string | null;
    lotSize: number | null;
    sampleSize: number | null;
    totalUnits: number;
    passedUnits: number;
    criticalDefects: number;
    majorDefects: number;
    minorDefects: number;
    defectSummary: string | null;
    result: string | null; // pass | conditional | fail
    inspectedBy: string | null;
    notes: string | null;
    /** 双签（P1-7 §9.3-②：qcSignedAt/businessSignedAt ISO 或时间戳字符串） */
    qcSignedAt: string | null;
    businessSignedAt: string | null;
    coverageSummary?: string;
    revision?: number;
    supersedesId?: string | null;
    businessDecision?: string;
  };
  order: {
    poNumber: string | null;
    customer: string;
    product: string;
    quantity: string | null;
    dueDate: string;
  } | null;
  /** 验货驻地（QCAssignment.reportId → QCLocation） */
  locationName: string | null;
}

const RESULT_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  pass: { label: 'PASS 合格', color: '#15803d', bg: '#f0fdf4' },
  conditional: { label: 'CONDITIONAL 有条件放行', color: '#a16207', bg: '#fefce8' },
  fail: { label: 'FAIL 不合格', color: '#b91c1c', bg: '#fef2f2' },
};

const TYPE_LABEL: Record<string, string> = {
  final: 'Final Inspection 最终验货',
  midpoint: 'Midline Inspection 中期验货',
  mid: 'Midline Inspection 中期验货',
};

/** BigInt/ISO 时间戳 → YYYY-MM-DD（非法/空返回 null） */
function tsToDate(v: string | null): string | null {
  if (!v) return null;
  const d = /^\d+$/.test(v) ? new Date(Number(v)) : new Date(v);
  if (Number.isNaN(d.getTime())) return v; // 已是日期字符串则原样
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ────────────────────────────────────────────────────────────────
// 数据装配（业务真源实时读取）
// ────────────────────────────────────────────────────────────────

/**
 * 按 InspectionReport.id 装配文档数据（含订单 + 验货驻地）。
 * 报告不存在返回 null（调用方 404）。
 */
export async function loadInspectionReportDocData(prisma: PrismaClient, reportId: string): Promise<InspectionReportDocData | null> {
  const report = await prisma.inspectionReport.findUnique({ where: { id: reportId } });
  if (!report) return null;

  const [order, assignment] = await Promise.all([
    report.orderId
      ? prisma.order.findUnique({
          where: { id: report.orderId },
          select: { poNumber: true, customer: true, product: true, quantity: true, dueDate: true },
        })
      : Promise.resolve(null),
    prisma.qCAssignment.findFirst({
      where: { reportId },
      select: { locationId: true },
    }),
  ]);

  const location = assignment?.locationId
    ? await prisma.qCLocation.findUnique({ where: { id: assignment.locationId }, select: { name: true } })
    : null;

  const sig = (report.signatures ?? {}) as { qcSignedAt?: string | number; businessSignedAt?: string | number };
  const scope: any = report.scopeSnapshot;
  const coverageSummary = report.scopeFingerprint
    ? report.scopeType === 'production_batch'
      ? `${scope?.batch?.batchCode ?? '实际批次'} · ${scope?.batch?.quantity ?? '—'} ${scope?.batch?.unit ?? ''} · 批次修订 ${report.productionBatchRevision ?? '—'}`
      : '整单 · 本次报告已冻结的实际行与批次范围'
    : undefined;

  return {
    report: {
      id: report.id,
      inspectionType: report.inspectionType,
      inspectionDate: report.inspectionDate,
      inspectorOrg: report.inspectorOrg,
      aqlLevel: report.aqlLevel,
      lotSize: report.lotSize,
      sampleSize: report.sampleSize,
      totalUnits: report.totalUnits,
      passedUnits: report.passedUnits,
      criticalDefects: report.criticalDefects,
      majorDefects: report.majorDefects,
      minorDefects: report.minorDefects,
      defectSummary: report.defectSummary,
      result: report.result,
      inspectedBy: report.inspectedBy,
      notes: report.notes,
      qcSignedAt: sig.qcSignedAt != null ? tsToDate(String(sig.qcSignedAt)) : null,
      businessSignedAt: sig.businessSignedAt != null ? tsToDate(String(sig.businessSignedAt)) : null,
      ...(coverageSummary ? { coverageSummary, revision: report.revision, supersedesId: report.supersedesId,
        businessDecision: report.approvedAt != null ? report.approvedByBusiness ? '已批准' : '已拒绝' : '待业务决定' } : {}),
    },
    order: order
      ? { poNumber: order.poNumber, customer: order.customer, product: order.product, quantity: order.quantity?.toString() ?? null, dueDate: order.dueDate }
      : null,
    locationName: location?.name ?? null,
  };
}

// ────────────────────────────────────────────────────────────────
// 渲染（body 片段；经 buildServerDocument 组装）
// ────────────────────────────────────────────────────────────────

const dash = (v: string | number | null | undefined): string => (v === null || v === undefined || v === '' ? '—' : esc(String(v)));

const linesToHtml = (text: string | null | undefined): string =>
  text ? String(text).split(/\r?\n/).map(esc).join('<br>') : '';

function infoCell(label: string, value: string): string {
  return `<td style="width:25%"><strong>${esc(label)}</strong></td><td style="width:25%">${value}</td>`;
}

/** 验货报告渲染（body 片段） */
export function renderInspectionReportBody(data: InspectionReportDocData, exporter: DocExporterProfile): string {
  const { report, order } = data;
  const badge = (report.result != null ? RESULT_BADGE[report.result] : undefined)
    ?? { label: report.result ?? 'PENDING', color: '#4a5568', bg: '#f7fafc' };
  const failedUnits = Math.max(0, report.totalUnits - report.passedUnits);

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>INSPECTION REPORT</h1>
      <div class="subtitle">验货报告</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">${esc(TYPE_LABEL[report.inspectionType] ?? report.inspectionType)}</div>
      ${report.inspectionDate ? `<div>Date: ${esc(report.inspectionDate)}</div>` : ''}
      ${report.inspectorOrg ? `<div>Inspector: ${esc(report.inspectorOrg)}</div>` : ''}
      <div style="margin-top:6px"><span style="display:inline-block;padding:3px 12px;border:1px solid ${badge.color};border-radius:4px;background:${badge.bg};color:${badge.color};font-weight:700;font-size:12px;letter-spacing:1px">${esc(badge.label)}</span></div>
    </div>
  </div>

  <div class="doc-party-grid">
    <div class="doc-party">
      <div class="label">Inspection Body 验货方</div>
      <div class="name">${esc(report.inspectorOrg || exporter.nameEn)}</div>
      <div class="detail">${report.inspectedBy ? 'Inspector: ' + esc(report.inspectedBy) : ''}</div>
    </div>
    <div class="doc-party">
      <div class="label">Order 订单</div>
      <div class="name">${order ? esc(order.poNumber || order.customer) : '—'}</div>
      <div class="detail">
        ${order ? esc(order.customer) + '<br>' + esc(order.product) : ''}
        ${data.locationName ? '<br>Location: ' + esc(data.locationName) : ''}
      </div>
    </div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Order Info 订单信息</div>
    ${report.coverageSummary ? `<p>Coverage 验货范围：${esc(report.coverageSummary)}<br>Report revision 报告修订：${esc(String(report.revision ?? '—'))}${report.supersedesId ? ' · 复验报告（原修订保留）' : ''}<br>Business decision 业务决定：${esc(report.businessDecision ?? '待核验')}<br>本报告保存的是当次范围与决定；当前放行资格须在系统中重新核验。</p>` : ''}
    <table class="doc-table">
      <tbody>
        <tr>
          ${infoCell('Customer Order No. 客户单号', dash(order?.poNumber))}
          ${infoCell('Customer 客户', dash(order?.customer))}
        </tr>
        <tr>
          ${infoCell('Product 品名', dash(order?.product))}
          ${infoCell('Order Qty 订单数量', order?.quantity != null ? esc(order.quantity) : '未统一单位 / 未录')}
        </tr>
        <tr>
          ${infoCell('Due Date 交期', dash(order?.dueDate))}
          ${infoCell('Inspection Date 验货日期', dash(report.inspectionDate))}
        </tr>
      </tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Sampling &amp; Results 抽样与结果</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th>AQL Level</th>
          <th style="text-align:right">Lot Size 批量</th>
          <th style="text-align:right">Sample Size 抽样数</th>
          <th style="text-align:right">Total Units 总检查数</th>
          <th style="text-align:right">Passed 合格</th>
          <th style="text-align:right">Failed 不合格</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${dash(report.aqlLevel)}</td>
          <td style="text-align:right">${dash(report.lotSize)}</td>
          <td style="text-align:right">${dash(report.sampleSize)}</td>
          <td style="text-align:right">${dash(report.totalUnits)}</td>
          <td style="text-align:right">${dash(report.passedUnits)}</td>
          <td style="text-align:right">${dash(failedUnits)}</td>
        </tr>
      </tbody>
    </table>
    <table class="doc-table">
      <thead>
        <tr>
          <th style="text-align:right">Critical Defects 致命缺陷</th>
          <th style="text-align:right">Major Defects 主要缺陷</th>
          <th style="text-align:right">Minor Defects 次要缺陷</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="text-align:right;font-weight:600;color:${report.criticalDefects > 0 ? '#b91c1c' : '#1a202c'}">${report.criticalDefects}</td>
          <td style="text-align:right;font-weight:600;color:${report.majorDefects > 0 ? '#b91c1c' : '#1a202c'}">${report.majorDefects}</td>
          <td style="text-align:right;font-weight:600">${report.minorDefects}</td>
        </tr>
      </tbody>
    </table>
  </div>

  ${report.defectSummary ? `
  <div class="doc-section">
    <div class="doc-section-title">Defect Summary 缺陷描述</div>
    <div style="font-size:11px;line-height:1.7;color:#2d3748">${linesToHtml(report.defectSummary)}</div>
  </div>` : ''}

  ${report.notes ? `
  <div class="doc-notes">
    <div class="notes-title">Notes 备注</div>
    ${linesToHtml(report.notes)}
  </div>` : ''}

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">QC Inspector 质检员签字</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">${report.qcSignedAt ? `Signed ${esc(report.qcSignedAt)}` : 'Pending 待签'}</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">Business Confirmation 业务确认</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">${report.businessSignedAt ? `Signed ${esc(report.businessSignedAt)}` : 'Pending 待签'}</div>
    </div>
  </div>`;
}
