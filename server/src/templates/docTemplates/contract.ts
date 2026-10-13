/**
 * Sales Contract 销售合同 — 服务端单据模板（2026-08-22 B8 多订单组合）。
 *
 * 架构裁决：
 *   - 组合文档模式（同 MERGED_PL/MERGED_IR）：多订单在数据层聚合为一份合同，
 *     而非 PDF 拼页；即时汇总产物不登记 TradeDocument（无单一业务真源可回链）
 *   - 合同号：S/C-{finalContractNumber 首个非空}（跨订单同合同号场景），
 *     否则「SC-YYYYMMDD-N」按当日组合序号临时编号（仅展示用，不落库）
 *   - 单订单正式确认场景走 OC 订单确认书（真源归档），两者互补
 */

import { esc, renderDocStamp, type DocSeal } from '../docPrintBase';
import type { DocExporterProfile } from './packingList';

// ────────────────────────────────────────────────────────────────
// 数据形状（compositeDocumentService.assembleContractData 装配输出）
// ────────────────────────────────────────────────────────────────

export interface ContractOrderInfo {
  index: number;
  orderId: string;
  poNumber: string | null;
  customer: string;
  currency: string;
  /**
   * 「Amount 金额」那一格的值 —— 订单金额**真源**（原名 `quoteAmount`，直抄主档报价额
   * 会与同张合同的合并明细行口径不一致；E 批 2026-09-26 收敛）。取不到数为 `null`（渲染「—」）。
   */
  orderAmount: number | null;
  dueDate: string | null;
  /**
   * ★ 2026-09-29：装运期（Date of Shipment）—— **与交期 `dueDate` 不是一回事**，
   *   不能拿交期顶替。真实合同的第 1 条就是"装运期"。
   */
  shipmentDate: string | null;
  // ★ 2026-09-29：合同条款区三项（使用方拍板后加列，见 docs/inventory/待使用方判清单.md）
  insuranceMode: string | null;      // 保险方式：出卖人投保110% / 买受人自理（J-6）
  claimPeriodDays: number | null;    // 索赔期（天）：货到目的口岸后 N 天内（J-7）
  disputeResolution: string | null;  // 争议解决方式：仲裁 / 诉讼
  // ★ 装运口岸/目的地：**在运单上**（`Shipment.portOfLoading/portOfDischarge`），
  //   不在 Order 上 ⇒ 装配处按 orderId 查运单带回（见 compositeDocumentService.assembleContractData）。
  portOfLoading: string | null;
  portOfDischarge: string | null;
  deliveryTerms: string | null;
  paymentTerms: string | null;
  salesContractNumber: string | null;
  finalContractNumber: string | null;
  lineCount: number;
}

export interface ContractDocLine {
  lineNumber: number;
  orderIndex: number;
  itemNo: string | null;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  netValue: number | null;
  /**
   * ★ 2026-09-29 新增：该行的**溢短装容差**（百分数，如 5 表示 ±5%）。
   *
   * 为什么必须加：条款区原写「按各订单行级溢短装条款执行（**默认 ±5%，行业惯例**）」——
   * ★ 那是一句**系统自己编出来的业务事实**：本仓的默认值来自
   * `OrderLine.tolerancePercent @default(5)`，**不是"行业惯例"**；而真实合同里
   * 容差是**逐单/逐档**约定的（客户 PO 按数量分档、采购合同 ±1%）。
   * ⇒ 对外合同**不许自造惯例**，要么印**真实值**，要么说清**来源**。
   * 取不到数为 `null`（渲染「—」），**不回落成 5**（回落＝又编一个数）。
   */
  tolerancePercent: number | null;
}

export interface ContractDocData {
  /** 合同号（首个非空 finalContractNumber / salesContractNumber，否则临时编号） */
  contractNumber: string;
  /** 合同日期（生成当日） */
  contractDate: string;
  /** 客户档案（首个非空订单的 Relation；缺档案回落冗余名） */
  customer: { name: string; englishName: string | null; chineseName: string | null; contactInfo: string | null } | null;
  orders: ContractOrderInfo[];
  lines: ContractDocLine[];
  totals: {
    currency: string;
    amount: number | null;
    quantity: number | null;
  };
}

// ────────────────────────────────────────────────────────────────
// 渲染（body 片段；经 buildServerDocument 组装）
// ────────────────────────────────────────────────────────────────

/**
 * ★★ 2026-09-29：我方标准销售合同的**固定条款文本**（版本化）。
 *
 * 为什么要它：与 23 份真实销售合同对撞后发现，**软件生成的合同缺 8 条标准条款**
 * （真实合同 9 条里只有"支付方式"一条有）。其中 3 条是**纯法律文本**，
 * 不需要任何订单数据 ⇒ 作为**模板常量**补上。
 *
 * ★★ 两条硬边界（不许越界）：
 *  1. **文本只做转录，不做编写** —— 中文原文取自 `docs/inventory/我方销售合同条款原文.md`
 *     （从 23 份真实合同 OCR 而来）。**法律文本的改动须使用方确认。**
 *  2. **英文部分 OCR 噪声大，本版只保留可确认的短语**，长句英文**待使用方提供** ⇒
 *     故此处**只写中文**，并在渲染时**标注版本**，避免"改过没人知道"。
 */
export const CONTRACT_FIXED_CLAUSES_VERSION = 'sc-clauses-cn-v1（2026-09-29 转录自 23 份真实销售合同）';
/** Bump when the rendered contract layout or data-to-clause mapping changes. */
export const CONTRACT_TEMPLATE_VERSION = 'contract-template-v1';

/** 纯法律文本条款（中文原文，逐字转录） */
export const CONTRACT_FIXED_CLAUSES: Array<{ no: number; title: string; body: string }> = [
  {
    no: 6,
    title: '不可抗力 Force Majeure',
    body: '本合同所述全部或部分商品，如因战争或其他人力不可抗拒的原因，以至不能履约或延迟交货，出卖人不负责。',
  },
  {
    no: 7,
    title: '签回 Acknowledgement',
    body: '买受人于收到本合同后请立即签回一份，如买受人对本合同有异议，应于收到后五天内提出，否则认为买受人已同意接受本合同所规定的各项条款。',
  },
  {
    no: 9,
    title: '法律适用 Governing Law',
    body: '本合同的签订、修改、补充、中止以及与本合同有关的争议的解决等，适用中华人民共和国有关法律规定。同时，本合同受 Incoterms 2010 的约束。',
  },
];

const money = (v: number | null, currency: string): string =>
  v == null ? '—' : `${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

const qty = (v: number | null): string =>
  v == null ? '—' : Number(v).toLocaleString('en-US');

const dash = (v: string | null | undefined): string => (v ? esc(v) : '—');

const linesToHtml = (text: string | null | undefined): string =>
  text ? String(text).split(/\r?\n/).map(esc).join('<br>') : '';

export const CONTRACT_GENERAL_CLAUSE_TEXT = '本合同项下各订单的品名、数量、单价与交期以「订单一览」与「合并明细」为准；如与订单原始文件冲突，以买卖双方书面确认的最新版本为准。';

/** Exact clause bodies used by both the renderer and the approval snapshot. */
export function buildContractClausePreview(data: ContractDocData): { quantityTolerance: string; entries: Array<{ no: number; title: string; body: string }>; generalClause: string } {
  const tolValues = [...new Set(data.lines.map(l => l.tolerancePercent).filter((v): v is number => v != null && Number.isFinite(v)))].sort((a, b) => a - b);
  const quantityTolerance = tolValues.length === 1 ? `±${tolValues[0]}%（按订单行级约定）`
    : tolValues.length > 1 ? `见各行（本合同出现 ${tolValues.map(v => `±${v}%`).join(' / ')}）`
      : '见各行（本合同未载明统一容差）';
  const na = '未载明（本合同未记录该项，请以买卖双方书面确认为准）';
  const perOrder = (pick: (order: ContractOrderInfo) => string | null | undefined): string => {
    const values = [...new Set(data.orders.map(pick).filter((value): value is string => Boolean(value)))];
    return values.length ? values.join(' / ') : na;
  };
  const portText = perOrder(order => [order.portOfLoading, order.portOfDischarge].filter(Boolean).join(' → '));
  const claimDays = [...new Set(data.orders.map(order => order.claimPeriodDays).filter((days): days is number => days != null))].sort((a, b) => a - b);
  const claimText = claimDays.length ? `货到目的口岸 ${claimDays.map(days => `${days} 天`).join(' / ')}内提出，凭公证机构检验报告` : na;
  const dataClauses = [
    { no: 1, title: '装运期 Date of Shipment', body: perOrder(order => order.shipmentDate) },
    { no: 2, title: '装运口岸和目的地 Loading Port & Destination', body: portText },
    { no: 3, title: '保险 Insurance', body: perOrder(order => order.insuranceMode) },
    { no: 5, title: '品质数量异议、索赔 Claims', body: claimText },
    { no: 8, title: '争议的解决 Dispute Resolution', body: perOrder(order => order.disputeResolution) },
  ];
  return { quantityTolerance, entries: [...dataClauses, ...CONTRACT_FIXED_CLAUSES].sort((a, b) => a.no - b.no), generalClause: CONTRACT_GENERAL_CLAUSE_TEXT };
}

/** 销售合同渲染（body 片段，中英文对照——订单一览 + 合并明细 + 通用条款 + 双签） */
export function renderContractBody(data: ContractDocData, exporter: DocExporterProfile, seal?: DocSeal | null): string {
  const cur = data.totals.currency;
  const customerName = data.customer
    ? (data.customer.englishName || data.customer.chineseName || data.customer.name)
    : (data.orders[0]?.customer ?? '—');

  /**
   * ★ 2026-09-29：溢短装条款**印真实值**，不许自造"行业惯例"。
   *
   * 原写法是固定一句「默认 ±5%，行业惯例」——那是**系统自己编的业务事实**：
   * 5% 只是 `OrderLine.tolerancePercent` 的**默认值**，与"行业惯例"无关；
   * 而真实合同里容差是**逐单约定**的（客户 PO 按数量分档、采购合同 ±1%）。
   *
   * 新写法分三种情况，**都说实话**：
   *   · 所有行都有值且**一致** ⇒ 印那一个值
   *   · 有值但**不一致** ⇒ 印"见各行"，并在括号里列出出现过的值
   *   · **一条都取不到** ⇒ 印「见各行」+ 明确"本合同未载明统一容差"（**不回落成 5**）
   */
  /**
   * ★ 2026-09-29：**可数据化的 4 条**（真实合同 1/2/3/5/8 条）——
   *   ★ 取得到就印真实值，**取不到就印「未载明」**，绝不编。
   *
   * 为什么这么写而不是"先加字段再印"：加库列是 schema 变更（影响两棵树 + 要动迁移账本），
   * 属**另一类动作**；而**条款结构补全 + 诚实回退**不需要 schema 变更，
   * 且将来字段补齐后**模板自动开始印真实值**，不用再改模板。
   *
   * ⚠️ 当前字段实况（查 `information_schema.columns`）：
   *   · 装运期 → `Order.shipmentDate` ✅ 有
   *   · 装运口岸/目的地 → `Order` 上**无** `portOfLoading/portOfDischarge`（`Shipment` 上有）
   *   · 保险（二选一）→ **无字段**
   *   · 索赔期 → **无字段**
   *   · 争议解决（二选一）→ **无字段**
   * ⇒ 后四条**当前必然印「未载明」**，这是**如实反映系统现状**，不是缺陷掩盖。
   */
  const { quantityTolerance: tolText, entries: allClauses, generalClause } = buildContractClausePreview(data);

  const orderRows = data.orders.map(o => `
    <tr>
      <td style="text-align:center">${o.index}</td>
      <td>${dash(o.poNumber)}</td>
      <td>${esc(o.customer)}</td>
      <td style="text-align:right">${money(o.orderAmount, o.currency)}</td>
      <td>${dash(o.dueDate)}</td>
      <td style="text-align:center">${o.lineCount}</td>
    </tr>`).join('');

  const lineRows = data.lines.map(l => `
    <tr>
      <td style="text-align:center">${l.lineNumber}</td>
      <td style="text-align:center">O${l.orderIndex}</td>
      <td>${dash(l.itemNo)}</td>
      <td>${dash(l.description)}</td>
      <td style="text-align:right">${qty(l.quantity)}${l.unit ? ' ' + esc(l.unit) : ''}</td>
      <td style="text-align:right">${l.unitPrice == null ? '—' : Number(l.unitPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
      <td style="text-align:right">${money(l.netValue, cur)}</td>
    </tr>`).join('');

  const first = data.orders[0];
  const deliveryTerms = first?.deliveryTerms;
  const paymentTerms = first?.paymentTerms;

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>SALES CONTRACT</h1>
      <div class="subtitle">销售合同</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">${esc(data.contractNumber)}</div>
      <div>Date 合同日期: ${esc(data.contractDate)}</div>
      <div>Orders 订单数: ${data.orders.length}</div>
    </div>
  </div>

  <div class="doc-party-grid">
    <div class="doc-party">
      <div class="label">Seller 卖方</div>
      <div class="name">${esc(exporter.nameEn)}</div>
      <div class="detail">${linesToHtml(exporter.addressEn)}</div>
    </div>
    <div class="doc-party">
      <div class="label">Buyer 买方</div>
      <div class="name">${esc(customerName)}</div>
      ${data.customer?.contactInfo ? `<div class="detail">${linesToHtml(data.customer.contactInfo)}</div>` : ''}
    </div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Order Summary 订单一览</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th style="text-align:center">#</th>
          <th>P/O No. 订单号</th>
          <th>Customer 客户</th>
          <th style="text-align:right">Amount 金额</th>
          <th>Due Date 交期</th>
          <th style="text-align:center">Lines 行数</th>
        </tr>
      </thead>
      <tbody>${orderRows}</tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Contract Lines 合并明细（O# = 订单序号）</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th style="text-align:center">#</th>
          <th style="text-align:center">O#</th>
          <th>Item No.</th>
          <th>Description 品名描述</th>
          <th style="text-align:right">Quantity 数量</th>
          <th style="text-align:right">Unit Price 单价</th>
          <th style="text-align:right">Amount 金额</th>
        </tr>
      </thead>
      <tbody>${lineRows}</tbody>
      <tfoot>
        <tr>
          <td colspan="6">TOTAL 合计</td>
          <td style="text-align:right">${money(data.totals.amount, cur)}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Terms &amp; Conditions 条款</div>
    <div style="font-size:11px;line-height:1.8">
      ${deliveryTerms ? `<div><strong>Delivery 交货:</strong> ${esc(deliveryTerms)}</div>` : ''}
      ${paymentTerms ? `<div><strong>Payment 付款:</strong> ${esc(paymentTerms)}</div>` : ''}
      <div><strong>Quantity Tolerance 溢短装:</strong> ${esc(tolText)}。</div>
      ${allClauses.map((c) => `<div><strong>${c.no}. ${esc(c.title)}:</strong> ${esc(c.body)}</div>`).join('')}
      <div><strong>General 一般条款:</strong> ${esc(generalClause)}</div>
      <div style="color:#888;font-size:10px;margin-top:4px">条款文本版本：${esc(CONTRACT_FIXED_CLAUSES_VERSION)}</div>
    </div>
  </div>

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (Seller 卖方签章)</div>
      ${renderDocStamp(seal)}
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">Buyer 买方签章</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
  </div>`;
}
