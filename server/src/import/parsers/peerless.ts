import { ParsedLine, ParsedOrder, ParsedShipTo } from '../types';
import { parseEuropeanNumber } from '../utils/numbers';
import { logger } from '../../lib/logger';

const RE_PO_BLOCK = /PO number \/ season \/ date\s*\n\s*(\d+)\s*\/\s*([^\/\n]+?)\s*\/\s*(\d{4}\/\d{2}\/\d{2})/i;
const RE_CONTACT_BLOCK = /Contact person\/Telephone\s*\n\s*([^\/\n]+?)\/(.+)/i;
const RE_CURRENCY = /Currency\s+([A-Z]{3})/;
const RE_DELIVERY = /Delivery terms:\s*([^\n]+)/i;
const RE_PAYMENT = /Payment terms:\s*(.+?)\s+Currency/i;

const RE_TOTAL_NET = /Tot\. net item val\. excl\. tax\s+[A-Z]{3}\s+([\d.,]+)/i;
const RE_ACTUAL = /Actual price\s+([\d.,]+)/i;

const RE_ITEM_HEAD =
  /^(\d{5})\s+(\d+)\s+(\S+)\s+(.+?)\s+(\d+\s*CM)\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s*$/;
const RE_ITEM_QTY =
  /^([\d.,]+)\s+(\w+)\s+([\d.,]+)\s+(.+?)\s+([\d.,]+)\s+([A-Z]+)\s*$/;

function parseLines(text: string): ParsedLine[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const out: ParsedLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(RE_ITEM_HEAD);
    if (!head) continue;
    const next = lines[i + 1] ?? '';
    const qty = next.match(RE_ITEM_QTY);
    if (!qty) continue;

    const weight = (lines[i + 2] ?? '').trim();
    const category = (lines[i + 3] ?? '').trim();

    out.push({
      itemNo: head[1],
      materialCode: head[2],
      millQuality: head[3],
      description: head[4].trim(),
      width: head[5],
      exMillDate: head[6],
      deliveryDate: head[7],
      quantity: parseEuropeanNumber(qty[1]),
      unit: qty[2],
      unitPrice: parseEuropeanNumber(qty[3]),
      cloth: qty[4].trim(),
      netValue: parseEuropeanNumber(qty[5]),
      via: qty[6],
      weight: /GSM$/i.test(weight) ? weight : undefined,
      category:
        category && !/_{3,}/.test(category) && !/^\d{5}\s/.test(category)
          ? category
          : undefined,
    });
  }
  return out;
}

function parseShipTo(text: string): ParsedShipTo {
  const lines = text.split('\n').map((l) => l.trim());
  const idx = lines.findIndex((l) => /^A\/S:/.test(l));
  if (idx < 0) return { addressLines: [] };
  const asMatch = lines[idx].match(/^A\/S:\s*(.+)$/);
  const contactName = asMatch ? asMatch[1].trim() : undefined;
  // The 4-5 lines after A/S: company / [PANDA branding] / address1 / address2 / country
  const tail = lines
    .slice(idx + 1, idx + 7)
    .filter((l) => l.length > 0)
    .filter((l) => l !== 'PANDA');
  // Drop trailing "Please deliver to:" / "Page" / etc
  const stop = tail.findIndex((l) => /^(Please deliver to|Page|FAX|TO BE CONFIRMED)/i.test(l));
  const block = stop >= 0 ? tail.slice(0, stop) : tail;
  const country = block.find((l) => /^(CHINA|CA|USA|HK)$/i.test(l));
  const company = block[0];
  const addressLines = block.filter((l) => l !== company && l !== country);
  return { contactName, company, addressLines, country };
}

function parseDeliverTo(text: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim());
  const idx = lines.findIndex((l) => /^Please deliver to:/i.test(l));
  if (idx < 0) return undefined;
  const consignee = lines[idx + 1];
  const country = lines[idx + 2];
  if (!consignee) return undefined;
  return country && /^[A-Z]{2}$/.test(country) ? `${consignee}, ${country}` : consignee;
}

/**
 * 取一条**必填**金额行；匹配不到就抛。
 *
 * ★ 2026-09-25（S4 处置 · 任务 1）：这里原来是 `n ? parse(...) : 0` —— 匹配不到**静默写 0**。
 * 而 0 会一路放行：`persistOrders.ts` 写的是 `parsed.totalActual ?? 0` / `?? null`，
 * 而 `??` 只挡 null/undefined，**挡不住 0** ⇒ 落库成一份"看起来成功、成交金额却是 0"的订单。
 *
 * 为什么是抛而不是回退到 `net`：29/29 真 PO 里 `totalNet ≡ totalActual`，所以回退**看起来总对**；
 * 正因如此，一旦某份 PO 因版式/OCR 变化匹配不到 Actual price 行（而金额确实与 net 不同），
 * 回退会**静默写一个像真的错数** —— 0 刺眼，假数不刺眼。⇒ **不猜。**
 *
 * 抛出后无需任何新管道：`parseOrderPdf.ts` 的 try/catch 会把 message 放进 `error` 字段
 * （该文件顶部注释即写明「Errors are caught and surfaced via `error` field rather than thrown」），
 * `import/route.ts` 再把 `error` 逐文件返回前端。
 */
function requireAmount(
  text: string,
  re: RegExp,
  opts: { field: 'totalNet' | 'totalActual'; label: string; meaning: string },
): number {
  const m = text.match(re);
  if (!m) {
    // 技术细节（正则原文）只进日志，**不进 message** —— message 是给业务用户看的
    // （内部异常原文上屏属 B33/B36/B37 族，不在此处重复制造）。
    logger.warn('Peerless PO 解析：必填金额行未匹配', {
      component: 'IMPORT_PEERLESS',
      field: opts.field,
      pattern: re.source,
    });
    throw new Error(
      `PO 解析失败：未找到「${opts.label}」行，无法确定${opts.meaning} —— 请核对 PDF 或让供应商重新出具`,
    );
  }
  return parseEuropeanNumber(m[1]);
}

function parseTotals(text: string): { net: number; actual: number } {
  return {
    net: requireAmount(text, RE_TOTAL_NET, {
      field: 'totalNet',
      label: 'Tot. net item val. excl. tax',
      meaning: '净金额',
    }),
    actual: requireAmount(text, RE_ACTUAL, {
      field: 'totalActual',
      label: 'Actual price',
      meaning: '成交金额',
    }),
  };
}

export function parsePeerless(text: string): ParsedOrder {
  const poMatch = text.match(RE_PO_BLOCK);
  if (!poMatch) throw new Error('Peerless: PO block not found');
  const contactMatch = text.match(RE_CONTACT_BLOCK);
  if (!contactMatch) throw new Error('Peerless: Contact block not found');
  const currencyMatch = text.match(RE_CURRENCY);
  const deliveryMatch = text.match(RE_DELIVERY);
  const paymentMatch = text.match(RE_PAYMENT);

  const totals = parseTotals(text);

  return {
    customerId: 'peerless',
    poNumber: poMatch[1],
    season: poMatch[2].trim(),
    poDate: poMatch[3],
    contactPerson: contactMatch[1].trim(),
    contactPhone: contactMatch[2].trim(),
    currency: currencyMatch ? currencyMatch[1] : 'USD',
    deliveryTerms: deliveryMatch ? deliveryMatch[1].trim() : '',
    paymentTerms: paymentMatch ? paymentMatch[1].trim() : '',
    shipTo: parseShipTo(text),
    deliverTo: parseDeliverTo(text),
    lines: parseLines(text),
    totalNet: totals.net,
    totalActual: totals.actual,
  };
}
