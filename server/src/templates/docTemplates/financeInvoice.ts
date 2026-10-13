/**
 * Finance Invoice 财务发票模板 — 服务端单据模板（2026-08-22 B11 结构收编）。
 *
 * 架构裁决：
 *   - 财务 Invoice 是商业发票唯一真源（2026-08-21 裁决）；本模块从 finance/route.ts
 *     原位提取（invoicePdfHtml / loadInvoiceDoc / renderInvoiceDocumentHtml），
 *     消除「路由文件持模板」的结构性错位——模板归 docTemplates/ 注册表体系
 *   - 完整文档模板（自带 doc-* 头部样式 + screen A4 画布壳），与注册表
 *     body 片段模板（renderBody → buildServerDocument 组装）是两种形态；
 *     经注册表 FIN_CI kind 的 renderDocument 分发（统一入口）
 *   - 行为零变更：finance 路由 preview.html / render.pdf 与单据中心 CI 财务回链
 *     渲染路径输出与提取前逐字节一致
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { DOC_PRINT_BASE_STYLES, esc, money, buildServerDocument } from '../docPrintBase';
import { getSystemConfigService } from '../../config/systemConfigService';
import { DEFAULT_EXPORTER_PROFILE, EXPORTER_PROFILE_CONFIG_KEY } from '../../config/systemConfigRoute';
import { amountInWords, formatDocumentDecimal, renderCommercialInvoiceBody, renderOtherTradeDocumentBody } from './customsDocs';
import type { TokenPayload } from '../../auth/service';
import { readCiInvoiceSource, readAuthorizedCiDocument, readHistoricalCiDocument, type CiInvoiceSource } from '../../customs/ciInvoiceSource';
import { DEVELOPMENT_CI_SOURCE } from '../../development/developmentCiSource';
import { readDevelopmentCiInvoiceSource } from '../../finance/developmentCiInvoiceSource';
import { renderDevelopmentCiDocument } from '../../development/developmentCiDocument';
import { businessError } from '../../shared/errorCodes';

/** 发票单据渲染上下文（loadInvoiceDoc 装配） */
export interface InvoiceDoc {
  invoice: any;
  allocs: Array<any>;
  exporter: { nameEn: string; addressEn: string; beneficiary: string; bankName: string; swiftCode: string; bankAddress: string; usdAccountNumber: string };
  relation: any | null;
  /** orderId → 订单（贸易条款/付款条款/ShipTo） */
  ordersById: Map<string, any>;
  /** orderId → 订单行明细（无行时缺省） */
  linesByOrder: Map<string, any[]>;
  /** 分配订单关联的出运单（装运信息：船名/港口/件数/毛净重） */
  shipment: any | null;
  /** Populated only by current authorized CI source reads; legacy finance/PI remains unchanged. */
  ciSource?: { draft: boolean; historical?: boolean; cancelled?: boolean };
}

/** Read the current configured exporter once; business CIs store this value in
 * their immutable issued snapshot so later profile edits cannot rewrite a CI. */
export async function currentExporterProfileSnapshot(prisma: PrismaClient): Promise<InvoiceDoc['exporter']> {
  let exporter: InvoiceDoc['exporter'] = { ...DEFAULT_EXPORTER_PROFILE };
  try {
    const found = await getSystemConfigService(prisma).get(EXPORTER_PROFILE_CONFIG_KEY);
    if (found?.value && typeof found.value === 'object') exporter = { ...DEFAULT_EXPORTER_PROFILE, ...(found.value as object) } as InvoiceDoc['exporter'];
  } catch { /* A current default may be used for preview; issued business CIs persist their snapshot. */ }
  return exporter;
}

/** Render a CI from the exact business DocumentVersion snapshot, without
 * creating or querying a financial Invoice. */
export async function renderBusinessShipmentCiSnapshot(prisma: PrismaClient, snapshot: any, documentNumber: string,
  opts: { screen?: boolean; draft?: boolean; historical?: boolean; cancelled?: boolean } = {}): Promise<string> {
  if (!snapshot || snapshot.protocolVersion !== 1 || !Array.isArray(snapshot.lines) || !snapshot.lines.length) {
    throw new Error('BUSINESS_CI_SNAPSHOT_INVALID');
  }
  const exporter = snapshot.exporterSnapshot && typeof snapshot.exporterSnapshot === 'object'
    ? snapshot.exporterSnapshot as InvoiceDoc['exporter'] : await currentExporterProfileSnapshot(prisma);
  const orders = Array.isArray(snapshot.confirmedOrderSnapshot) ? snapshot.confirmedOrderSnapshot : [];
  const ordersById = new Map<string, any>();
  const linesByOrder = new Map<string, any[]>();
  const amounts = new Map<string, Prisma.Decimal>();
  for (const order of orders) if (typeof order?.id === 'string') ordersById.set(order.id, order);
  for (const line of snapshot.lines) {
    if (!ordersById.has(line.orderId) || line.quantity == null || line.unitPrice == null || line.amount == null) {
      throw new Error('BUSINESS_CI_SNAPSHOT_INVALID');
    }
    const specification = line.specification && typeof line.specification === 'object'
      ? Object.entries(line.specification).filter(([, value]) => value != null && typeof value !== 'object').map(([key, value]) => `${key}: ${String(value)}`).join(' · ')
      : typeof line.specification === 'string' ? line.specification : '';
    const description = [line.description, line.materialCode, specification].filter(Boolean).join(' · ');
    if (!description) throw new Error('BUSINESS_CI_SNAPSHOT_INVALID');
    const rows = linesByOrder.get(line.orderId) ?? [];
    rows.push({ itemNo: line.itemNo ?? null, description, quantity: line.quantity, unit: line.unit, unitPrice: line.unitPrice, netValue: line.amount });
    linesByOrder.set(line.orderId, rows);
    amounts.set(line.orderId, (amounts.get(line.orderId) ?? new Prisma.Decimal(0)).plus(line.amount));
  }
  const billTo = snapshot.parties?.billTo ?? {};
  const relation = { englishName: billTo.name ?? '', name: billTo.name ?? '', contactInfo: billTo.address ?? '' };
  const allocs = [...amounts.entries()].map(([orderId, amount]) => {
    const order = ordersById.get(orderId);
    return { orderId, orderNumber: order.code ?? order.orderNumber ?? null, poNumber: order.poNumber ?? null, allocatedAmount: amount.toString() };
  });
  const totalAmount = new Prisma.Decimal(String(snapshot.totalAmount));
  const invoice = { type: 'Receivable', invoiceNumber: documentNumber, status: opts.draft ? 'Draft' : 'Issued',
    amount: totalAmount, currency: snapshot.currency, issueDate: snapshot.issueDate ?? null,
    customerName: billTo.name ?? '', customerRelationId: billTo.relationId ?? null, notes: null };
  return invoicePdfHtml({ invoice, allocs, exporter, relation, ordersById, linesByOrder, shipment: null,
    ciSource: { draft: Boolean(opts.draft), historical: Boolean(opts.historical), cancelled: Boolean(opts.cancelled) } }, opts);
}

/**
 * 发票单据模板——doc-* 基座体系（2026-08-21 统一裁决：与合同/装箱单/出运 CI 同一版式基因）。
 * 结构：doc-header（标题+编号组）→ doc-party-grid 双方栏（名称/地址/税号/联系人）→
 * Shipment & Terms 条款组（doc-table 标签-内容式）→ 货品明细 doc-table → 合计+金额大写 →
 * 收款银行 → doc-footer 双签章（sig 三段式）→ E&OE 尾注。
 *  screen=true 供浏览器预览端点（/:id/preview.html）：A4 纸张画布（.paper 210mm 宽）。
 */
export function invoicePdfHtml(doc: InvoiceDoc, opts: { screen?: boolean } = {}): string {
  const { invoice, allocs, exporter, relation, ordersById, linesByOrder, shipment } = doc;
  const isProforma = invoice.type === 'Proforma';
  const isPayable = invoice.type === 'Payable';
  const titleEn = isProforma ? 'PROFORMA INVOICE' : isPayable ? 'INVOICE' : 'COMMERCIAL INVOICE';
  const titleZh = isProforma ? '形式发票' : isPayable ? '应付发票' : '商业发票';
  const currency = invoice.currency || '';
  const sourceMoney = (value: any, currency: any) => doc.ciSource ? formatDocumentDecimal(value == null ? null : String(value), 2, 4) : money(value, currency);
  const sourceQuantity = (value: any) => formatDocumentDecimal(value == null ? null : String(value), 0, 4);
  const sourcePrice = (value: any) => formatDocumentDecimal(value == null ? null : String(value), 2, 4);

  // 交易双方（吸收合同模板结构：名称 + 地址 + 税号 + 联系人）：
  // 应收/形式发票 我方为卖方；应付发票 对方为卖方（我方采购）
  const buyerName = relation?.englishName || relation?.name || invoice.customerName || '';
  /**
   * ⚠️ extra 视为「已转义的 HTML 片段」（内含 <br> 分隔符，不能整体再 esc）。
   * 调用方必须自行保证每个插值都已 esc——见下方 relationContact。
   * 2026-09-15 加固：此前 relationContact 原样内联 primaryContactName/Email
   * （Relation 档案属四方数据，且 contactSync 会用邮件同步的联系人回写），
   * 可注入 <img onerror> 形成存储型 XSS。
   */
  const partyDetail = (detail: string, extra?: string): string =>
    `${detail ? esc(detail).replace(/\n/g, '<br>') : ''}${extra ? `<br>${extra}` : ''}`;
  const exporterDetail = partyDetail(exporter.addressEn);
  const relationContact = relation
    ? [
        relation.primaryContactName ? `Contact: ${esc(relation.primaryContactName)}` : '',
        relation.primaryContactEmail ? `Email: ${esc(relation.primaryContactEmail)}` : '',
      ].filter(Boolean).join('<br>')
    : '';
  const relationDetail = partyDetail(relation?.contactInfo || '', relationContact || undefined);
  const seller = isPayable
    ? { name: buyerName || '—', detail: relationDetail }
    : { name: exporter.nameEn, detail: exporterDetail };
  const buyer = isPayable
    ? { name: exporter.nameEn, detail: exporterDetail }
    : { name: buyerName || '—', detail: relationDetail };

  const partyBlock = (label: string, p: { name: string; detail: string }): string => `
    <div class="doc-party">
      <div class="label">${esc(label)}</div>
      <div class="name">${esc(p.name)}</div>
      ${p.detail ? `<div class="detail">${p.detail}</div>` : ''}
    </div>`;

  // 订单/PO 引用行（多订单合并开票）
  const poRefs = (allocs ?? []).map(a => a.poNumber).filter(Boolean);
  const orderRefs = (allocs ?? []).map(a => a.orderNumber).filter(Boolean);

  // ── 运输与条款（合同式标签-内容表）：从订单/出运单聚合 ──
  const primaryOrder = (allocs ?? []).length ? ordersById.get(allocs[0].orderId) : null;
  const anyOrder = primaryOrder || [...ordersById.values()][0] || null;
  const terms = anyOrder?.deliveryTerms || null;
  const paymentTerms = anyOrder?.paymentTerms || null;
  const shipTo = anyOrder?.shipToName
    ? [anyOrder.shipToName, anyOrder.shipToAddress1, anyOrder.shipToAddress2, anyOrder.shipToCountry].filter(Boolean).join(', ')
    : null;
  const vessel = shipment?.vesselOrFlight ? `${shipment.vesselOrFlight}${shipment.voyageNumber ? ' / ' + shipment.voyageNumber : ''}` : null;
  const pol = shipment?.portOfLoading || null;
  const pod = shipment?.portOfDischarge || null;
  const etd = shipment?.atd || shipment?.etd || null;
  const pkgs = shipment?.totalPackages ?? null;
  const gwt = shipment?.grossWeight ?? null;
  const nwt = shipment?.netWeight ?? null;
  const termRow = (label: string, value: string | null): string =>
    value ? `<tr><td style="padding:6px 0;width:150px;color:#718096;vertical-align:top">${esc(label)}</td><td style="padding:6px 0">${esc(value)}</td></tr>` : '';
  const shipmentRows = [
    termRow('Terms of Delivery 贸易条款', terms),
    termRow('Terms of Payment 付款方式', paymentTerms),
    termRow('Country of Origin 原产国', 'CHINA'),
    termRow('Vessel / Voyage 船名航次', vessel),
    termRow('Port of Loading 装货港', pol),
    termRow('Port of Discharge 目的港', pod),
    termRow('ETD 离港日', etd),
    pkgs != null ? termRow('Packages 件数', `${pkgs} CTNS`) : '',
    (gwt != null || nwt != null)
      ? termRow('Gross / Net Weight 毛重/净重', `${gwt != null ? `${Number(gwt).toLocaleString('en-US', { maximumFractionDigits: 3 })} KGS` : '—'} / ${nwt != null ? `${Number(nwt).toLocaleString('en-US', { maximumFractionDigits: 3 })} KGS` : '—'}`)
      : '',
    termRow('Ship To 收货地', shipTo),
  ].filter(Boolean).join('');
  const shipmentGroup = shipmentRows ? `
    <div class="doc-section">
      <div class="doc-section-title">Shipment &amp; Terms 运输与条款</div>
      <table style="width:100%;font-size:11px;border-collapse:collapse">${shipmentRows}</table>
    </div>` : '';

  // 货品明细：任一分配订单有行明细 → 分组行明细；无分配时空态占位（禁止 TOTAL 悬空）
  // B271：对外发票上的订单引用只认业务编号（订单号 / P/O 号）；两个都没有就整段留空，
  //   绝不退回 orderId —— 那是我们库里的内部主键，客户对着它无法核对任何东西。
  const orderRefLabel = (a: any, sep = ' · '): string =>
    [a.orderNumber ? `Order ${esc(a.orderNumber)}` : '', a.poNumber ? `P/O ${esc(a.poNumber)}` : '']
      .filter(Boolean).join(sep);
  const hasLines = (allocs ?? []).some(a => (linesByOrder.get(a.orderId) || []).length > 0);
  let goodsRows: string;
  if (hasLines) {
    goodsRows = (allocs ?? []).map((a) => {
      const lines = linesByOrder.get(a.orderId) || [];
      const head = `
        <tr style="background:#f7fafc"><td colspan="4" style="font-weight:600;color:#4a5568">${orderRefLabel(a, ' &nbsp;·&nbsp; ')}</td></tr>`;
      const rows = lines.map((l: any) => `
        <tr>
          <td>${esc(l.itemNo ? `${l.itemNo} ` : '')}${esc(l.description || '')}</td>
          <td style="text-align:right">${l.quantity != null ? `${doc.ciSource ? sourceQuantity(l.quantity) : Number(l.quantity).toLocaleString('en-US', { maximumFractionDigits: 2 })}${l.unit ? ' ' + esc(l.unit) : ''}` : '—'}</td>
          <td style="text-align:right">${l.unitPrice != null ? (doc.ciSource ? sourcePrice(l.unitPrice) : Number(l.unitPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })) : '—'}</td>
          <td style="text-align:right">${l.netValue != null ? sourceMoney(l.netValue, null) : '—'}</td>
        </tr>`).join('');
      return head + rows;
    }).join('');
  } else if ((allocs ?? []).length) {
    goodsRows = (allocs ?? []).map((a) => `
        <tr>
          <td>${orderRefLabel(a)}</td>
          <td style="text-align:right">—</td>
          <td style="text-align:right">—</td>
          <td style="text-align:right">${a.allocatedAmount != null ? sourceMoney(a.allocatedAmount, null) : sourceMoney(invoice.amount, null)}</td>
        </tr>`).join('');
  } else {
    goodsRows = `
        <tr><td colspan="4" style="color:#a0aec0;font-style:italic;text-align:center;padding:70px 10px">— No order lines allocated. 请在发票详情中分配订单后生成货品明细 —</td></tr>`;
  }

  const amountNum = Number(invoice.amount == null ? 0 : invoice.amount);

  // 收款银行：应收/形式发票（我方收款）展示受益人银行；应付发票无对手方银行数据则省略
  const bankBlock = !isPayable ? `
    <div class="doc-section">
      <div class="doc-section-title">Beneficiary Bank 收款银行</div>
      <div class="doc-party" style="font-size:11px">
        <div class="detail">
          Beneficiary: ${esc(exporter.beneficiary)}<br>
          Bank: ${esc(exporter.bankName)}<br>
          Address: ${esc(exporter.bankAddress)}<br>
          SWIFT: ${esc(exporter.swiftCode)}<br>
          A/C No.: ${esc(exporter.usdAccountNumber)}
        </div>
      </div>
    </div>` : '';

  // screen 预览 = 固定 A4 纸张画布（.paper 210mm 宽，多页自动分页）；
  // PDF 渲染走无画布裸文档（renderHtmlToPdf 的 A4 + 12mm margin 自行分页）。
  const screenShell = opts.screen
    ? `<style>
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
    </style><div class="paper">`
    : '';
  const screenShellEnd = opts.screen ? '</div>' : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_PRINT_BASE_STYLES}
    ${opts.screen ? `
    /* screen 模式覆盖基座 body padding（纸张自带内边距） */
    body { padding: 0 !important; }
    ` : ''}
  </style></head><body>
    ${screenShell}
    <div class="doc-header">
      <div class="doc-title-block">
        <h1>${titleEn}${doc.ciSource?.historical ? ' — HISTORICAL COPY' : doc.ciSource?.draft ? ' — DRAFT PREVIEW' : ''}</h1>
        <div class="subtitle">${titleZh}</div>
      </div>
      <div class="doc-meta">
        <div class="doc-no">${esc(invoice.invoiceNumber)}</div>
        <div>Date: ${esc(invoice.issueDate ?? '—')}</div>
        ${invoice.dueDate ? `<div>Due: ${esc(invoice.dueDate)}</div>` : ''}
        <div>${doc.ciSource?.historical ? 'HISTORICAL VERSION / 历史版本' + (doc.ciSource.cancelled ? ' · 原票已取消' : '') : doc.ciSource?.draft ? 'DRAFT / 草稿预览 · 未正式签发' : 'ORIGINAL'}</div>
      </div>
    </div>

    <div class="doc-party-grid">
      ${partyBlock('Seller / Exporter 卖方', seller)}
      ${partyBlock('Buyer / Consignee 买方', buyer)}
    </div>

    ${(orderRefs.length || poRefs.length) ? `
    <div class="doc-notes" style="margin-top:0;margin-bottom:16px">
      ${orderRefs.length ? `<div><b>Order No.:</b> ${esc(orderRefs.join(' / '))}</div>` : ''}
      ${poRefs.length ? `<div><b>P/O No.:</b> ${esc(poRefs.join(' / '))}</div>` : ''}
    </div>` : ''}

    ${shipmentGroup}

    <table class="doc-table">
      <thead><tr><th>Description of Goods 品名</th><th style="text-align:right">Quantity 数量</th><th style="text-align:right">Unit Price 单价${currency ? ` (${esc(currency)})` : ''}</th><th style="text-align:right">Amount 金额${currency ? ` (${esc(currency)})` : ''}</th></tr></thead>
      <tbody>${goodsRows}</tbody>
      <tfoot>
        <tr>
          <td colspan="3" style="text-align:right">TOTAL 合计</td>
          <td>${sourceMoney(invoice.amount, null)}</td>
        </tr>
      </tfoot>
    </table>
    <div class="doc-notes">
      <div class="notes-title">Amount in Words 金额大写</div>
      <div style="color:#1a202c;font-size:11px">${esc(doc.ciSource ? exactCiAmountInWords(invoice.amount, invoice.currency) : amountInWords(amountNum, invoice.currency))}</div>
    </div>

    ${bankBlock}

    ${invoice.notes ? `<div class="doc-notes"><div class="notes-title">Remarks 备注</div><div>${esc(invoice.notes).replace(/\n/g, '<br>')}</div></div>` : ''}

    <div class="doc-footer">
      <div class="doc-signature">
        <div class="sig-label">For ${esc(seller.name)} (签章)</div>
        <div class="sig-line" style="margin-top:36px"></div>
        <div class="sig-name">${esc(seller.name)}</div>
        <div style="font-size:10px;color:#718096;margin-top:2px">Authorized Signature / Date</div>
      </div>
      <div class="doc-signature">
        <div class="sig-label">For Buyer 买方确认 (签章)</div>
        <div class="sig-line" style="margin-top:36px"></div>
        <div class="sig-name">${esc(buyer.name)}</div>
        <div style="font-size:10px;color:#718096;margin-top:2px">Confirmed by / Date</div>
      </div>
    </div>

    <div class="doc-notes" style="margin-top:20px">
      E. &amp; O. E. · ${esc(titleEn)} · ${esc(invoice.invoiceNumber)}
    </div>
    ${screenShellEnd}
  </body></html>`;
}

/** 装配发票单据上下文（发票 + 订单分配 + 出口商档案 + 交易对手 + 订单 + 订单行明细 + 出运单）；发票不存在/已删返回 null */
export async function loadInvoiceDoc(prisma: PrismaClient, id: string): Promise<InvoiceDoc | null> {
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice || invoice.deletedAt) return null;
  const allocs = await (prisma as any).invoiceOrderAllocation.findMany({ where: { invoiceId: invoice.id, deletedAt: null }, orderBy: { createdAt: 'asc' } }) || [];
  // 出口商档案：SystemConfig 真源（30s TTL 缓存）→ 默认值兜底；读取失败不阻断单据渲染
  let exporter: InvoiceDoc['exporter'] = { ...DEFAULT_EXPORTER_PROFILE };
  try {
    const found = await getSystemConfigService(prisma).get(EXPORTER_PROFILE_CONFIG_KEY);
    if (found?.value && typeof found.value === 'object') {
      exporter = { ...DEFAULT_EXPORTER_PROFILE, ...(found.value as object) } as InvoiceDoc['exporter'];
    }
  } catch { /* 配置读取失败走默认档案 */ }
  // 交易对手档案（买方/供应商名称与联系地址）
  let relation: any = null;
  if (invoice.customerRelationId) {
    try { relation = await (prisma as any).relation.findUnique({ where: { id: invoice.customerRelationId } }); } catch { /* 快照字段兜底 invoice.customerName */ }
  }
  // 分配订单（贸易/付款条款、ShipTo 快照）+ 订单行明细（分组展示）
  const orderIds = allocs.map((a: any) => a.orderId).filter(Boolean);
  const ordersById = new Map<string, any>();
  const linesByOrder = new Map<string, any[]>();
  if (orderIds.length) {
    try {
      const orders = await (prisma as any).order.findMany({ where: { id: { in: orderIds }, deletedAt: null } }) || [];
      for (const o of orders) ordersById.set(o.id, o);
    } catch { /* 订单查询失败条款组隐藏 */ }
    try {
      const lines = await (prisma as any).orderLine.findMany({ where: { orderId: { in: orderIds } }, orderBy: { orderId: 'asc', lineNumber: 'asc' } }) || [];
      for (const l of lines) {
        const arr = linesByOrder.get(l.orderId) || [];
        arr.push(l);
        linesByOrder.set(l.orderId, arr);
      }
    } catch { /* 行明细查询失败退化到分配行 */ }
  }
  // 分配订单关联出运单（首条，装运信息：船名/港口/件数/毛净重）
  let shipment: any = null;
  if (orderIds.length) {
    try {
      shipment = await (prisma as any).shipment.findFirst({ where: { orderId: { in: orderIds }, deletedAt: null } });
    } catch { /* 出运单查询失败装运组隐藏 */ }
  }
  return { invoice, allocs, exporter, relation, ordersById, linesByOrder, shipment };
}

/**
 * 财务发票单据 HTML（CI 唯一真源模板）。
 * screen=true → A4 纸张画布预览模式（与 GET /:id/preview.html 同一份渲染）；
 * 默认裸文档（与 GET /:id/render.pdf 同一份）。发票不存在/已删返回 null。
 */
export async function renderFinanceInvoiceDocument(prisma: PrismaClient, invoiceId: string, opts: {
  screen?: boolean; trustedActor?: TokenPayload | null; shipmentId?: string; documentId?: string; version?: number;
  expectedSourceFingerprint?: string; expectedShipmentSourceFingerprint?: string;
} = {}): Promise<string | null> {
  const native = await prisma.invoice.findFirst({ where: { id: invoiceId, deletedAt: null }, select: { sourceType: true } });
  if (native?.sourceType === DEVELOPMENT_CI_SOURCE) {
    const source = await readDevelopmentCiInvoiceSource(prisma, invoiceId, opts.trustedActor);
    if (opts.documentId && opts.documentId !== source.document.id || opts.version !== undefined && opts.version !== source.version.version
      || opts.shipmentId !== undefined || opts.expectedShipmentSourceFingerprint !== undefined
      || opts.expectedSourceFingerprint !== undefined && opts.expectedSourceFingerprint !== source.fingerprint)
      throw businessError('CONFLICT', '开发 CI 原票版本或来源参数不一致。');
    const html = renderDevelopmentCiDocument(source, opts.screen);
    const final = await readDevelopmentCiInvoiceSource(prisma, invoiceId, opts.trustedActor);
    if (final.fingerprint !== source.fingerprint) throw businessError('CONFLICT', '开发 CI 原票来源在读取期间变化。');
    return html;
  }
  if (opts.screen && opts.documentId) return renderHistoricalCiInvoiceDocument(prisma, opts.documentId, opts);
  const options = { trustedActor: opts.trustedActor ?? null, mode: opts.screen ? 'preview' as const : 'render' as const,
    ...(opts.expectedSourceFingerprint !== undefined ? { expectedSourceFingerprint: opts.expectedSourceFingerprint } : {}),
    ...(opts.expectedShipmentSourceFingerprint !== undefined ? { expectedShipmentSourceFingerprint: opts.expectedShipmentSourceFingerprint } : {}) };
  const source = opts.documentId
    ? (await readAuthorizedCiDocument(prisma, opts.documentId, options)).source
    : await readCiInvoiceSource(prisma, { ...options, sourceInvoiceId: invoiceId, ...(opts.shipmentId ? { shipmentId: opts.shipmentId } : {}) });
  if (source.invoice.id !== invoiceId) throw Error('CI_SOURCE_MISMATCH');
  const doc = await ciInvoiceDoc(prisma, source);
  // Metadata lookup/render await cannot turn a stale credential into disclosure.
  if (opts.documentId) await readAuthorizedCiDocument(prisma, opts.documentId, { ...options, expectedSourceFingerprint: source.fingerprint });
  else await readCiInvoiceSource(prisma, { ...options, sourceInvoiceId: invoiceId, ...(opts.shipmentId ? { shipmentId: opts.shipmentId } : {}), expectedSourceFingerprint: source.fingerprint });
  return invoicePdfHtml(doc, opts);
}

async function ciInvoiceDoc(prisma: PrismaClient, source: CiInvoiceSource, historical = false): Promise<InvoiceDoc> {
  let exporter: InvoiceDoc['exporter'] = { ...DEFAULT_EXPORTER_PROFILE };
  try { const found = await getSystemConfigService(prisma).get(EXPORTER_PROFILE_CONFIG_KEY);
    if (found?.value && typeof found.value === 'object') exporter = { ...exporter, ...(found.value as object) } as InvoiceDoc['exporter'];
  } catch { /* Existing exporter profile fallback, never financial facts. */ }
  const relation = historical ? { name: source.invoice.customerName ?? source.orders.map(order => order.customer).find(Boolean) ?? '' }
    : source.invoice.customerRelationId ? await prisma.relation.findUnique({ where: { id: source.invoice.customerRelationId } }) : null;
  const ordersById = new Map<string, any>(), linesByOrder = new Map<string, any[]>(), grouped = new Map<string, any>();
  const common = (key: string) => { const values = [...new Set(source.orders.map(order => order[key] ?? null))]; return values.length === 1 ? values[0] : null; };
  for (const order of source.orders) ordersById.set(order.id, { ...order, deliveryTerms: common('deliveryTerms'), paymentTerms: common('paymentTerms'),
    shipToName: common('shipToName'), shipToAddress1: common('shipToAddress1'), shipToAddress2: common('shipToAddress2'), shipToCountry: common('shipToCountry') });
  for (const allocation of source.allocations) {
    const previous = grouped.get(allocation.orderId);
    const order = source.orders.find(row => row.id === allocation.orderId);
    grouped.set(allocation.orderId, { ...allocation, poNumber: order?.poNumber ?? allocation.poNumber, orderNumber: order?.orderNumber ?? allocation.orderNumber,
      allocatedAmount: previous ? new Prisma.Decimal(previous.allocatedAmount).plus(allocation.allocatedAmount).toString() : allocation.allocatedAmount });
  }
  for (const [orderId] of grouped) {
    const allocations = source.allocations.filter(row => row.orderId === orderId);
    const batchShipmentIds = [...new Set(allocations.filter(row => row.batchId).map(row => source.batches.find(batch => batch.id === row.batchId)?.shipmentId).filter(Boolean))];
    if (batchShipmentIds.length) {
      const goods = source.shipmentSources.filter(row => batchShipmentIds.includes(row.shipment.id)).flatMap(row => row.lines.filter(line => line.orderId === orderId));
      linesByOrder.set(orderId, goods.map(line => ({ ...line.originalOrderLine, quantity: line.quantity, unit: line.unit, unitPrice: line.unitPrice, netValue: line.amount })));
    } else linesByOrder.set(orderId, source.orders.find(row => row.id === orderId)?.lines ?? []);
  }
  // A multi-shipment invoice has no arbitrary first vessel/header. Its actual
  // batch goods remain complete; ticket-specific preview may name that ticket.
  const shipment = source.requestedShipmentId ? source.shipmentSources.find(row => row.shipment.id === source.requestedShipmentId)?.shipment ?? null
    : source.shipmentSources.length === 1 ? source.shipmentSources[0].shipment : null;
  return { invoice: source.invoice, allocs: [...grouped.values()], exporter, relation, ordersById, linesByOrder, shipment, ciSource: { draft: source.draft } };
}

/** Decimal(18,4): integer groups never exceed 999. Four fractional digits are
 * spelled as digits instead of silently rounding original money to cents. */
function exactCiAmountInWords(value: any, currency: string | null): string {
  const fixed = new Prisma.Decimal(String(value)).toFixed(4), [integer, fraction] = fixed.split('.');
  const ones = ['ZERO','ONE','TWO','THREE','FOUR','FIVE','SIX','SEVEN','EIGHT','NINE','TEN','ELEVEN','TWELVE','THIRTEEN','FOURTEEN','FIFTEEN','SIXTEEN','SEVENTEEN','EIGHTEEN','NINETEEN'];
  const tens = ['','','TWENTY','THIRTY','FORTY','FIFTY','SIXTY','SEVENTY','EIGHTY','NINETY'];
  const chunk = (n: number): string => {
    const h = Math.floor(n / 100), rest = n % 100;
    const tail = rest < 20 ? (rest ? ones[rest] : '') : tens[Math.floor(rest / 10)] + (rest % 10 ? '-' + ones[rest % 10] : '');
    return [h ? ones[h] + ' HUNDRED' : '', tail].filter(Boolean).join(h && tail ? ' AND ' : ' ');
  };
  const groups = integer.replace(/^0+/, '').match(/\d{1,3}(?=(?:\d{3})*$)/g) ?? ['0'];
  const labels = ['', 'THOUSAND', 'MILLION', 'BILLION', 'TRILLION'];
  const whole = groups.map((digits, index) => { const word = chunk(Number(digits)); return word ? word + (labels[groups.length - index - 1] ? ' ' + labels[groups.length - index - 1] : '') : ''; }).filter(Boolean).join(' ') || 'ZERO';
  const decimal = fraction.replace(/0+$/, '');
  return ['SAY TOTAL', currency ?? '', whole, decimal ? 'POINT ' + [...decimal].map(digit => ones[Number(digit)]).join(' ') : '', 'ONLY'].filter(Boolean).join(' ');
}

/** Explicit existing-doc history uses immutable version data. It can display a
 * cancelled original Invoice as history, never re-register/re-render formally. */
export async function renderHistoricalCiInvoiceDocument(prisma: PrismaClient, documentId: string,
  opts: { trustedActor?: TokenPayload | null; version?: number } = {}): Promise<string> {
  const historyOptions = { trustedActor: opts.trustedActor ?? null, ...(opts.version !== undefined ? { version: opts.version } : {}) };
  const history = await readHistoricalCiDocument(prisma, documentId, historyOptions);
  let html: string;
  if (history.sourceSnapshot) {
    const doc = await ciInvoiceDoc(prisma, history.sourceSnapshot, true);
    doc.ciSource = { draft: false, historical: true, cancelled: history.currentInvoice?.status === 'Cancelled' };
    html = invoicePdfHtml(doc, { screen: true });
  } else {
    let exporter: InvoiceDoc['exporter'] = { ...DEFAULT_EXPORTER_PROFILE };
    try { const found = await getSystemConfigService(prisma).get(EXPORTER_PROFILE_CONFIG_KEY);
      if (found?.value && typeof found.value === 'object') exporter = { ...exporter, ...(found.value as object) } as InvoiceDoc['exporter'];
    } catch { /* Legacy presentation fallback only. */ }
    const label = '<div class="doc-notes"><b>HISTORICAL COPY / 历史版本</b><br>Document: ' + esc(history.document.documentNumber) + ' · Version ' + esc(history.version.version) + '<br>'
      + (history.currentInvoice ? '只读原归档版本，不替代当前原票或重新正式出单。' + (history.currentInvoice.status === 'Cancelled' ? '原财务票已取消。' : '')
        : '原财务来源未核验，仅供历史阅读，不能作为正式商业发票。') + '</div>';
    const body = history.documentSet ? renderCommercialInvoiceBody(history.documentSet, exporter)
      : renderOtherTradeDocumentBody({ source: 'doc', doc: history.version.content }, exporter);
    html = buildServerDocument(label + body, { screen: true });
  }
  const final = await readHistoricalCiDocument(prisma, documentId, historyOptions);
  if (final.fingerprint !== history.fingerprint) throw Error('CI_HISTORY_CHANGED');
  return html;
}
