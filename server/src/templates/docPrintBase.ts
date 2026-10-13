/**
 * 全站单据打印样式基座（doc-* 类体系）。
 *
 * 2026-08-22 全系统文档体系裁决：从 finance/route.ts 提取为共享模块——
 * 服务端模板统一真源（B1 架构底座），发票/装箱单/合同/PO/QC 报告/对账单
 * 等所有服务端单据模板共用此基座。
 * ⚠️ 双端同步纪律：与前端 components/tools/printDocument.ts BASE_PRINT_STYLES 同源副本，
 *    任一侧修改必须同步另一侧。
 */

export const DOC_PRINT_BASE_STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #1a202c; background: #fff; padding: 40px; font-size: 12px; line-height: 1.6; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .doc-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1a202c; padding-bottom: 16px; margin-bottom: 24px; }
  .doc-title-block h1 { font-size: 22px; font-weight: 600; letter-spacing: 0.5px; }
  .doc-title-block .subtitle { font-size: 11px; color: #718096; margin-top: 4px; letter-spacing: 1px; text-transform: uppercase; }
  .doc-meta { text-align: right; font-size: 11px; color: #4a5568; line-height: 1.7; }
  .doc-meta .doc-no { font-size: 13px; font-weight: 600; color: #1a202c; }
  .doc-party-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
  .doc-party { font-size: 11px; }
  .doc-party .label { font-size: 9px; text-transform: uppercase; color: #a0aec0; letter-spacing: 1px; margin-bottom: 4px; }
  .doc-party .name { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  .doc-party .detail { color: #4a5568; line-height: 1.5; }
  table.doc-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 11px; }
  table.doc-table thead th { background: #f7fafc; color: #4a5568; font-weight: 600; text-align: left; padding: 8px 10px; border-bottom: 2px solid #cbd5e0; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  table.doc-table tbody td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; color: #2d3748; }
  table.doc-table tbody tr:nth-child(even) { background: #fafafa; }
  table.doc-table tfoot td { padding: 10px; border-top: 2px solid #cbd5e0; font-weight: 600; text-align: right; }
  .doc-section { margin-bottom: 20px; }
  .doc-section-title { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: #a0aec0; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #e2e8f0; }
  .doc-totals { margin-left: auto; width: 280px; font-size: 11px; }
  .doc-totals .total-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #e2e8f0; }
  .doc-totals .total-row.grand { font-size: 14px; font-weight: 700; border-top: 2px solid #1a202c; border-bottom: none; padding-top: 10px; margin-top: 4px; }
  .doc-footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; display: grid; grid-template-columns: 1fr 1fr; gap: 40px; }
  .doc-signature { font-size: 11px; }
  .doc-signature .sig-label { color: #718096; margin-bottom: 24px; }
  .doc-signature .sig-line { border-top: 1px solid #4a5568; padding-top: 4px; }
  .doc-signature .sig-name { font-weight: 600; margin-top: 2px; }
  .doc-signature .doc-stamp { display: block; width: 72px; height: 72px; object-fit: contain; margin: 0 0 4px auto; }
  .doc-notes { font-size: 10px; color: #718096; margin-top: 16px; line-height: 1.6; }
  .doc-notes .notes-title { text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; color: #a0aec0; }
`;

/** HTML 特殊字符转义（所有服务端单据模板共用） */
export const esc = (s: any): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/**
 * 电子签章图（§10.3-9）：签署后按签署人身份解析出的章图。
 * 与 sealService.ResolvedSeal 结构对齐（只取渲染所需三字段，避免模板层耦合服务层类型）。
 */
export interface DocSeal {
  id: string;
  name: string;
  imageDataUrl: string;
}

/**
 * 渲染签名区盖章图。无章（未签署 / 无可用章）返回空串——版式零影响。
 *
 * 2026-09-15 加固：此前原样内联、注释称"base64 不含引号无需转义"——该假设只在章图
 * 真是纯 base64 时成立。只要 imageDataUrl 里带一个双引号（业务方给的图名/转换产物
 * 千奇百怪），就能闭合 src 属性注入 onerror/onload = 存储型 XSS（管理员上传、
 * 所有看单据的人触发）。现在一律走 esc 转义属性值：合法 base64 不含 & < > " '，
 * 转义对其零影响（不误伤），但能兜住上游校验万一漏过的情形（纵深防御）。
 */
export const renderDocStamp = (seal?: DocSeal | null): string =>
  seal?.imageDataUrl ? `<img class="doc-stamp" src="${esc(seal.imageDataUrl)}" alt="seal" />` : '';

/** 千分位金额格式化（所有服务端单据模板共用） */
export const money = (v: any, currency: string | null = ''): string =>
  `${v == null ? '0.00' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`;

/**
 * 组装完整服务端单据文档（裸打印模式——PDF 渲染用，renderHtmlToPdf 自带 A4 分页）。
 * screen=true 时附加灰底 A4 纸张画布样式（preview.html 预览用，与发票同款所见即所得）。
 */
export function buildServerDocument(htmlBody: string, opts: { screen?: boolean; extraStyles?: string } = {}): string {
  const screenStyles = opts.screen
    ? `
    <style>
    body { background: #525659; display: block; padding: 24px 0; text-align: center; }
    .paper {
      width: 210mm; min-height: 297mm; padding: 40px 48px;
      background: #fff; color: #1a202c; margin: 0 auto; text-align: left;
      box-shadow: 0 2px 12px rgba(0,0,0,.35);
      display: inline-block;
      break-after: page;
    }
    .paper + .paper { margin-top: 16px; }
    @media print { body { background: #fff; padding: 0; } .paper { box-shadow: none; display: block; margin: 0; } }
    body { padding: 0 !important; }
    </style><div class="paper">`
    : '';
  const paperClose = opts.screen ? '</div>' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_PRINT_BASE_STYLES}${opts.extraStyles ?? ''}</style></head><body>${screenStyles}${htmlBody}${paperClose}</body></html>`;
}
