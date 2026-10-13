/**
 * Quotation 报价单 — 服务端单据模板（2026-08-22 B7 报价单服务端化）。
 *
 * 架构裁决：
 *   - 模板真源服务端（docTemplates/ 注册表体系），与 PO/IR 同一真源回链模式：
 *     数据真源=Quotation 业务实时装配（不复制进版本快照）——文档号=quotationNumber，
 *     改业务侧即改文档，重新生成文件幂等覆盖
 *   - sourceRef=Quotation.id，单据中心登记归档（domain=quotation）
 *   - 前端 QuotationManager 的 buildQuotationPrintHtml 同构迁移退役（B7 起渲染真源服务端）
 *   - 行级图片（REQ2-12 DR-053）：imageUrl 相对路径在装配时解析为绝对 URL——
 *     preview.html 同源可直接用，PDF 管线（page.setContent 无基址）必须绝对路径
 */

import { PrismaClient } from '@prisma/client';
import { esc, renderDocStamp, type DocSeal } from '../docPrintBase';
import type { DocExporterProfile } from './packingList';
import fs from 'fs';
import path from 'path';

/** Bump whenever the printed wording/layout or monetary display rules change. */
export const QUOTATION_TEMPLATE_VERSION = 'quotation-template-v1';

// ────────────────────────────────────────────────────────────────
// 数据形状（loadQuotationDocData 装配输出）
// ────────────────────────────────────────────────────────────────

export interface QuotationDocLine {
  lineNumber: number;
  fabricCode: string | null;
  description: string;
  specification?: string | null; moq?: number | null; leadTimeDays?: number | null; leadTimeStart?: string | null; priceTiers?: {minQuantity:number;unitPrice:number}[] | null;
  quantity: number | null;
  unit: string;
  unitPrice: number | null;
  amount: number | null;
  notes: string | null;
  /** 绝对 URL（PDF 渲染要求；外链保持原样） */
  imageUrl: string | null;
}

export interface QuotationDocData {
  qt: {
    id: string;
    quotationNumber: string;
    quotationType?: string | null; contactName?: string | null; contactPhone?: string | null; tradePlace?: string | null;
    status: string;
    currency: string;
    totalAmount: number;
    issueDate: string;
    validUntil: string | null;
    deliveryTerms: string | null;
    paymentTerms: string | null;
    salesperson: string | null;
    inquiryRef: string | null;
    notes: string | null;
    customerName: string | null;
    customerCode: string | null;
  };
  lines: QuotationDocLine[];
}

export interface QuotationClausePreviewEntry { no: number; title: string; body: string }

/** Dynamic terms printed by the native quotation template, in rendered order. */
export function buildQuotationClausePreview(data: QuotationDocData): { version: string; entries: QuotationClausePreviewEntry[] } {
  const qt = data.qt;
  const entries: QuotationClausePreviewEntry[] = [];
  if (qt.deliveryTerms) entries.push({ no: entries.length + 1, title: 'Delivery 交货', body: qt.deliveryTerms });
  if (qt.paymentTerms) entries.push({ no: entries.length + 1, title: 'Payment 付款', body: qt.paymentTerms });
  if (qt.validUntil) entries.push({ no: entries.length + 1, title: 'Validity 有效期', body: `${qt.issueDate} ~ ${qt.validUntil}` });
  if (qt.notes) entries.push({ no: entries.length + 1, title: 'Remarks 备注', body: qt.notes });
  return { version: QUOTATION_TEMPLATE_VERSION, entries };
}

// ────────────────────────────────────────────────────────────────
// 数据装配（业务真源实时读取）
// ────────────────────────────────────────────────────────────────

/**
 * 相对图片 URL → 绝对 URL（PDF 渲染管线 page.setContent 无基址，相对路径必挂）。
 * BAMBOOK_PUBLIC_BASE_URL 显式配置优先；兜底本机主 API 端口（与 knowledgeDocumentsRoute 同约定）。
 */
function resolveImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (isFrozenQuotationDocumentImage(url)) return url;
  if (/^https?:\/\//i.test(url)) return url;
  const base = (process.env.BAMBOOK_PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8081}`)
    .trim()
    .replace(/\/$/, '');
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * 按 Quotation.id 装配文档数据（含行明细）。
 * 单据不存在/软删返回 null（调用方 404）。
 */
export async function loadQuotationDocData(prisma: PrismaClient, quotationId: string): Promise<QuotationDocData | null> {
  const qt = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
  if (!qt || qt.deletedAt) return null;

  return assembleQuotationDocData(qt);
}

/** Historical customer content is assembled exclusively from its immutable commercial snapshot. */
export function assembleQuotationVersionDocData(version: any): QuotationDocData {
  const header = version?.headerSnapshot;
  const lines = version?.linesSnapshot;
  if (!header || !['Sent','Accepted','Rejected','Expired'].includes(header.status) || !header.quotationNumber || !Array.isArray(lines) || !lines.length) {
    throw new Error('该版本没有完整的已发报价快照，不能生成历史客户文档。');
  }
  if (lines.some((line: any) => line.imageUrl && !isFrozenQuotationDocumentImage(line.imageUrl))) {
    throw new Error('该历史版本图片未冻结，不能使用当前图片重建客户文档。');
  }
  return assembleQuotationDocData({...header, id: version.quotationId, currency: version.currency, totalAmount: version.totalAmount, lines});
}

/** Assemble the exact row already validated by the signer, without a second source read. */
export function assembleQuotationDocData(qt: any): QuotationDocData {

  return {
    qt: {
      id: qt.id,
      quotationNumber: qt.quotationNumber,
      quotationType: qt.quotationType, contactName: qt.contactName, contactPhone: qt.contactPhone, tradePlace: qt.tradePlace,
      status: qt.status,
      currency: qt.currency,
      totalAmount: Number(qt.totalAmount),
      issueDate: qt.issueDate,
      validUntil: qt.validUntil,
      deliveryTerms: qt.deliveryTerms,
      paymentTerms: qt.paymentTerms,
      salesperson: qt.salesperson,
      inquiryRef: qt.inquiryRef,
      notes: qt.notes,
      customerName: qt.customerName,
      customerCode: qt.customerCode,
    },
    lines: qt.lines.map((l: any) => ({
      lineNumber: l.lineNumber,
      fabricCode: l.fabricCode,
      description: l.description,
      specification: l.specification, moq: l.moq == null ? null : Number(l.moq), leadTimeDays:l.leadTimeDays, leadTimeStart:l.leadTimeStart, priceTiers:l.priceTiers,
      quantity: l.quantity != null ? Number(l.quantity) : null,
      unit: l.unit,
      unitPrice: l.unitPrice != null ? Number(l.unitPrice) : null,
      amount: l.amount != null ? Number(l.amount) : null,
      notes: l.notes,
      imageUrl: resolveImageUrl(l.imageUrl),
    })),
  };
}

// ────────────────────────────────────────────────────────────────
// 渲染（body 片段；经 buildServerDocument 组装）
// ────────────────────────────────────────────────────────────────

const money = (v: number | null, currency: string): string =>
  v == null ? '—' : `${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

const qty = (v: number | null): string =>
  v == null ? '—' : Number(v).toLocaleString('en-US');

const dash = (v: string | null | undefined): string => (v ? esc(v) : '—');

// P0-3 报价行图片内联：/api/uploads/quotations 静态直读已 fail-closed 404，且服务端 PDF/preview
// 渲染（headless Chrome / 无会话凭证）无法携带 JWT 回读 scoped 下载端点——图片在模板装配时
// 就地内联为 data URI（本地文件直读，无需鉴权 HTTP）。外链 / 公共静态 / 文件缺失回退原 URL。
const QUOTATION_IMG_MARKERS = ['/api/uploads/quotations/', '/api/v1/quotations/line-image/'];
const MAX_QUOTATION_IMAGE_BYTES = 10 * 1024 * 1024;

export class QuotationDocumentImageFreezeError extends Error {
  code = 'QUOTATION_IMAGE_UNFREEZABLE';
  constructor(message = '报价图片无法冻结。请通过现有报价或产品图片上传流程重新上传后，再提交正式签署。') {
    super(message);
    this.name = 'QuotationDocumentImageFreezeError';
  }
}

function failImageFreeze(): never {
  throw new QuotationDocumentImageFreezeError();
}

function allowedLocalImageOrigins(): Set<string> {
  const origins = new Set<string>();
  const port = process.env.PORT || '8081';
  for (const value of [process.env.BAMBOOK_PUBLIC_BASE_URL, `http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
    if (!value) continue;
    try { origins.add(new URL(value).origin); } catch { /* invalid public base is not an image authority */ }
  }
  return origins;
}

function quotationUploadPath(url: string): string[] {
  let rawPath = url;
  if (/^https?:\/\//i.test(url)) {
    // Parse authority separately; URL.pathname normalizes dot segments before
    // validation, which would hide encoded/traversal paths from this guard.
    const absolute = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/i.exec(url);
    if (!absolute) return failImageFreeze();
    let origin: string;
    try {
      const parsedOrigin = new URL(`${absolute[1]}://${absolute[2]}`);
      if (parsedOrigin.username || parsedOrigin.password) return failImageFreeze();
      origin = parsedOrigin.origin;
    } catch { return failImageFreeze(); }
    if (!allowedLocalImageOrigins().has(origin))
      throw new QuotationDocumentImageFreezeError('报价图片外链无法冻结。请先通过现有报价或产品图片上传流程重新上传，再提交正式签署。');
    rawPath = absolute[3] || '/';
  } else if (!url.startsWith('/') || url.startsWith('//')) return failImageFreeze();

  if (/%2f|%5c/i.test(rawPath) || rawPath.includes('\\')) return failImageFreeze();
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { return failImageFreeze(); }
  if (decoded.includes('%') || decoded.includes('\\')) return failImageFreeze();
  const parts = decoded.split('/');
  if (parts.some(part => part === '.' || part === '..')) return failImageFreeze();
  const quotation = /^\/api\/v1\/quotations\/line-image\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})$/.exec(decoded)
    || /^\/api\/uploads\/quotations\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})$/.exec(decoded);
  if (quotation) {
    if (quotation[1].includes('..')) return failImageFreeze();
    return ['quotations', quotation[1]];
  }
  const product = /^\/api\/uploads\/products\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})$/.exec(decoded);
  if (product && !product[2].includes('..')) return ['products', product[1], product[2]];
  return failImageFreeze();
}

function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function readPrivateQuotationImage(relativePath: string[]): { mime: string; bytes: Buffer } {
  try {
    const configuredRoot = process.env.BAMBOOK_UPLOAD_DIR || path.resolve(__dirname, '../../../../uploads');
    // Resolve the configured storage root once. The configured root may itself
    // be a deployment symlink, but no file below it may escape or traverse links.
    const root = fs.realpathSync(configuredRoot);
    const absolute = path.resolve(root, ...relativePath);
    const rel = path.relative(root, absolute);
    if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) return failImageFreeze();
    let cursor = root;
    for (const segment of rel.split(path.sep)) {
      cursor = path.join(cursor, segment);
      const item = fs.lstatSync(cursor);
      if (item.isSymbolicLink()) return failImageFreeze();
    }
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size <= BigInt(0) || before.size > BigInt(MAX_QUOTATION_IMAGE_BYTES)) return failImageFreeze();
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (read <= 0) return failImageFreeze();
        offset += read;
      }
      const after = fs.fstatSync(fd, { bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
        return failImageFreeze();
      const mime = imageMime(bytes);
      if (!mime) return failImageFreeze();
      return { mime, bytes };
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error instanceof QuotationDocumentImageFreezeError) throw error;
    return failImageFreeze();
  }
}

/** True only for a bounded, base64-encoded image whose bytes match its MIME. */
export function isFrozenQuotationDocumentImage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length > Math.ceil(MAX_QUOTATION_IMAGE_BYTES * 4 / 3) + 4) return false;
  try {
    const bytes = Buffer.from(match[2], 'base64');
    return bytes.length > 0 && bytes.length <= MAX_QUOTATION_IMAGE_BYTES
      && bytes.toString('base64') === match[2] && imageMime(bytes) === match[1];
  } catch { return false; }
}
function inlineQuotationImage(url: string): string {
  const marker = QUOTATION_IMG_MARKERS.find((m) => url.includes(m));
  if (!marker) return url;
  const raw = (url.split(marker)[1] || '').split(/[?#]/)[0];
  let filename: string;
  try {
    filename = decodeURIComponent(raw);
  } catch {
    return url;
  }
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) return url;
  const roots = [
    process.env.BAMBOOK_UPLOAD_DIR,
    path.resolve(__dirname, '../../../../uploads'), // 与 index.ts UPLOAD_DIR 默认布局一致
    path.resolve(process.cwd(), 'uploads'),
  ].filter(Boolean) as string[];
  const ext = path.extname(filename).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  for (const root of roots) {
    const abs = path.join(root, 'quotations', filename);
    try {
      if (fs.existsSync(abs)) {
        return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
      }
    } catch {
      // 该候选根不可读，尝试下一个
    }
  }
  return url;
}

/** Freeze supported private-upload image bytes; external and unresolved paths fail closed. */
export function freezeQuotationDocumentImages(data: QuotationDocData): QuotationDocData {
  return { ...data, lines: data.lines.map(line => {
    if (!line.imageUrl) return { ...line, imageUrl: null };
    if (isFrozenQuotationDocumentImage(line.imageUrl)) return { ...line };
    const stored = readPrivateQuotationImage(quotationUploadPath(line.imageUrl));
    return { ...line, imageUrl: `data:${stored.mime};base64,${stored.bytes.toString('base64')}` };
  }) };
}

/** 报价单渲染（body 片段，中英文对照——与 B7 前端版式同构迁移） */
export function renderQuotationBody(data: QuotationDocData, exporter: DocExporterProfile, seal?: DocSeal | null): string {
  const { qt } = data;
  const cur = qt.currency || 'USD';

  // 行级图片（REQ2-12 DR-053-③）：有图行嵌入缩略图；无图行不渲染图片列——版式向后兼容
  const hasAnyImage = data.lines.some(l => l.imageUrl);
  const imageCell = (url: string | null) => url
    ? `<img src="${esc(inlineQuotationImage(url))}" alt="" style="width:54px;height:54px;object-fit:contain;border:1px solid #e2e8f0;border-radius:4px" />`
    : '<span style="display:inline-block;width:54px;height:54px"></span>';

  const rows = data.lines.map(l => `
    <tr>
      <td style="text-align:center">${l.lineNumber}</td>
      ${hasAnyImage ? `<td>${imageCell(l.imageUrl)}</td>` : ''}
      <td>${esc([l.fabricCode, l.description].filter(Boolean).join(' · '))}${l.specification ? `<div>${esc(l.specification)}</div>` : ''}${l.moq != null ? `<div>MOQ: ${qty(l.moq)} ${esc(l.unit)}</div>` : ''}${l.leadTimeDays != null ? `<div>Lead time: ${esc(String(l.leadTimeDays))} days${l.leadTimeStart ? ` / ${esc(l.leadTimeStart)}` : ''}</div>` : ''}${Array.isArray(l.priceTiers) ? l.priceTiers.map(t => `<div>${qty(t.minQuantity)}+ ${esc(l.unit)}: ${money(t.unitPrice,cur)}</div>`).join('') : ''}${l.notes ? `<div style="color:#718096;font-size:10px">${esc(l.notes)}</div>` : ''}</td>
      <td style="text-align:right">${qty(l.quantity)}</td>
      <td>${esc(l.unit)}</td>
      <td style="text-align:right">${l.unitPrice == null ? '—' : Number(l.unitPrice).toFixed(4)}</td>
      <td style="text-align:right">${money(l.amount, cur)}</td>
    </tr>`).join('');

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>QUOTATION</h1>
      <div class="subtitle">报 价 单</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">${esc(qt.quotationNumber)}</div>
      <div>Date 报价日期: ${esc(qt.issueDate)}</div>
      ${qt.validUntil ? `<div>Valid Until 有效期至: ${esc(qt.validUntil)}</div>` : ''}
      ${qt.inquiryRef ? `<div>Inquiry Ref 询价参考: ${esc(qt.inquiryRef)}</div>` : ''}
    </div>
  </div>

  <div class="doc-party-grid">
    <div class="doc-party">
      <div class="label">From 报价方</div>
      <div class="name">${esc(exporter.nameEn)}</div>
      ${qt.contactName ? `<div class="detail">Contact 联系人: ${esc(qt.contactName)} ${esc(qt.contactPhone || '')}</div>` : ''}
      ${qt.tradePlace ? `<div class="detail">Trade place 贸易地点: ${esc(qt.tradePlace)}</div>` : ''}
      ${qt.salesperson ? `<div class="detail">Sales 业务员: ${esc(qt.salesperson)}</div>` : ''}
    </div>
    <div class="doc-party">
      <div class="label">To 致客户</div>
      <div class="name">${dash(qt.customerName)}</div>
      ${qt.customerCode ? `<div class="detail">Code 客户编码: ${esc(qt.customerCode)}</div>` : ''}
    </div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Quotation Lines 报价明细</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th style="text-align:center">No.<br/>序号</th>
          ${hasAnyImage ? '<th style="width:62px">Photo 图片</th>' : ''}
          <th>Description 品名描述</th>
          <th style="text-align:right">Qty 数量</th>
          <th>Unit 单位</th>
          <th style="text-align:right">Unit Price 单价 (${esc(cur)})</th>
          <th style="text-align:right">Amount 金额 (${esc(cur)})</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="${hasAnyImage ? 6 : 5}">TOTAL 总计 (${esc(cur)})</td>
          <td style="text-align:right">${money(qt.totalAmount, cur)}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Terms &amp; Conditions 条款</div>
    <div style="font-size:11px;line-height:1.8">
      ${qt.deliveryTerms ? `<div><strong>Delivery 交货:</strong> ${esc(qt.deliveryTerms)}</div>` : ''}
      ${qt.paymentTerms ? `<div><strong>Payment 付款:</strong> ${esc(qt.paymentTerms)}</div>` : ''}
      ${qt.validUntil ? `<div><strong>Validity 有效期:</strong> ${esc(qt.issueDate)} ~ ${esc(qt.validUntil)}</div>` : ''}
    </div>
  </div>

  ${qt.notes ? `
  <div class="doc-notes">
    <div class="notes-title">Remarks 备注</div>
    ${esc(qt.notes)}
  </div>` : ''}

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">Seller's Signature 卖方签章</div>
      ${renderDocStamp(seal)}
      <div class="sig-line">&nbsp;</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">Buyer's Confirmation 买方确认</div>
      <div class="sig-line">&nbsp;</div>
    </div>
  </div>`;
}
