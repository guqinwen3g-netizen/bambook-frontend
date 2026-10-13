import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { extractPdfText } from '../extractText';
import { parsePeerless } from '../parsers/peerless';
import { ACTUAL_PRICE_LINE, TOTAL_NET_LINE, peerlessHeaderLines } from './helpers/syntheticPdf';

const DIR = '/Users/qinwengu/WorkBuddy/Claw/BusinessDocu/00-Entities/Peerless/面料/BULK PO';

async function load(file: string) {
  const buf = fs.readFileSync(`${DIR}/${file}`);
  const { text } = await extractPdfText(buf);
  return parsePeerless(text);
}

describe('parsePeerless — header', () => {
  it('PO 4500159423', async () => {
    const o = await load('PO#-4500159423-0001.pdf');
    expect(o.poNumber).toBe('4500159423');
    expect(o.season).toBe('F26-INSTOCK');
    expect(o.poDate).toBe('2026/03/31');
    expect(o.contactPerson).toBe('Sonya Catalano');
    expect(o.contactPhone).toBe('514-593-9300 EXT:1510');
    expect(o.currency).toBe('USD');
    expect(o.deliveryTerms).toMatch(/FOB.*CHINA/);
    expect(o.paymentTerms).toMatch(/To be confirmed/i);
  });

  it.each([
    ['PO#-4500159154-0001.pdf', '4500159154', '2026/03/03'],
    ['PO#-4500159120-0001.pdf', '4500159120', '2026/02/25'],
    ['PO#-4500159027-0001.pdf', '4500159027', '2026/02/17'],
    ['PO#-4500158987-0001.pdf', '4500158987', '2026/02/11'],
  ] as const)('%s header', async (file, po, date) => {
    const o = await load(file);
    expect(o.poNumber).toBe(po);
    expect(o.poDate).toBe(date);
    expect(o.season).toBe('F26-INSTOCK');
    expect(o.currency).toBe('USD');
  });
});

describe('parsePeerless — line items', () => {
  it('PO 4500159423 has 4 lines and the first line matches the PDF', async () => {
    const o = await load('PO#-4500159423-0001.pdf');
    expect(o.lines).toHaveLength(4);

    const l1 = o.lines[0];
    expect(l1.itemNo).toBe('00010');
    expect(l1.materialCode).toBe('144749');
    expect(l1.millQuality).toBe('RD7302_PCHR');
    expect(l1.description).toBe('CHARCOAL SOLID');
    expect(l1.width).toBe('147 CM');
    expect(l1.exMillDate).toBe('2026/07/01');
    expect(l1.deliveryDate).toBe('2026/08/15');
    expect(l1.quantity).toBeCloseTo(3600, 6);
    expect(l1.unit).toBe('Meter');
    expect(l1.unitPrice).toBeCloseTo(8.1, 6);
    expect(l1.netValue).toBeCloseTo(29160, 6);
    expect(l1.via).toBe('SEA');
    expect(l1.cloth).toBe('70% Wool/25% Polyester/5% Spandex');
    expect(l1.weight).toBe('186GSM');
    expect(l1.category).toBe('SUITS SEPARATES');
  });

  it.each([
    ['PO#-4500159154-0001.pdf', 3],
    ['PO#-4500159120-0001.pdf', 1],
    ['PO#-4500159027-0001.pdf', 3],
    ['PO#-4500158987-0001.pdf', 2],
  ] as const)('%s line count', async (file, expectedCount) => {
    const o = await load(file);
    expect(o.lines).toHaveLength(expectedCount);
  });
});

describe('parsePeerless — ship-to & totals', () => {
  it.each([
    ['PO#-4500159423-0001.pdf', 103680],
    ['PO#-4500159154-0001.pdf', 93150],
    ['PO#-4500159120-0001.pdf', 40500],
    ['PO#-4500159027-0001.pdf', 125550],
    ['PO#-4500158987-0001.pdf', 42930],
  ] as const)('%s totals', async (file, expected) => {
    const o = await load(file);
    expect(o.totalNet).toBeCloseTo(expected, 2);
    expect(o.totalActual).toBeCloseTo(expected, 2);
  });

  it.each([
    'PO#-4500159423-0001.pdf',
    'PO#-4500159154-0001.pdf',
    'PO#-4500159120-0001.pdf',
    'PO#-4500159027-0001.pdf',
    'PO#-4500158987-0001.pdf',
  ])('%s ship-to is Panda Clothing in CHINA', async (file) => {
    const o = await load(file);
    expect(o.shipTo.contactName).toBe('Richard Gu');
    expect(o.shipTo.company).toMatch(/Jiangsu Panda Clothing/);
    expect(o.shipTo.country).toBe('CHINA');
    expect(o.shipTo.addressLines.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S4 处置 · 任务 1（P1）：必填金额行缺失 ⇒ 抛错，**不得静默写 0**
//
// 改前行为（已实测复现）：缺行时 `parseTotals` 返回 0 且不报错；0 会经
// `persistOrders.ts` 的 `parsed.totalActual ?? 0` / `?? null` 一路落库
// （`??` 只挡 null/undefined，挡不住 0）⇒ 生成一份"看起来成功、成交金额为 0"的订单。
//
// 注：真 PO 的 5 份 fixture 全部命中这两行，所以"缺行"场景**必须合成文本**，
// 无法从真 PDF 里造出来 —— 这正是这条静默兜底此前从未被覆盖的原因。
// ─────────────────────────────────────────────────────────────────────────────
describe('parsePeerless — 必填金额行缺失 ⇒ 抛错（S4 任务 1）', () => {
  const HEADER = peerlessHeaderLines().join('\n');

  it('阳性对照：两行都在 ⇒ 正常返回数值（证明下面的红不是因为合成本文一律失败）', () => {
    const o = parsePeerless([HEADER, TOTAL_NET_LINE, ACTUAL_PRICE_LINE].join('\n'));
    expect(o.totalNet).toBeCloseTo(103680, 2);
    expect(o.totalActual).toBeCloseTo(103680, 2);
  });

  it('缺「Actual price」行 ⇒ 抛错，且**不是**返回 0', () => {
    const text = [HEADER, TOTAL_NET_LINE].join('\n');
    // 改前：这里返回 totalActual = 0（不抛）⇒ 本行咬红
    expect(() => parsePeerless(text)).toThrow();
    expect(() => parsePeerless(text)).toThrow(/未找到「Actual price」行/);
    expect(() => parsePeerless(text)).toThrow(/无法确定成交金额/);
  });

  it('缺「Tot. net item val. excl. tax」行 ⇒ 抛错（同族一并处理，不只改一半）', () => {
    const text = [HEADER, ACTUAL_PRICE_LINE].join('\n');
    // 改前：这里返回 totalNet = 0（不抛）⇒ 本行咬红
    expect(() => parsePeerless(text)).toThrow(/未找到「Tot\. net item val\. excl\. tax」行/);
    expect(() => parsePeerless(text)).toThrow(/无法确定净金额/);
  });

  it('两行都缺 ⇒ 抛错（不是两个 0）', () => {
    expect(() => parsePeerless(HEADER)).toThrow(/未找到「Tot\. net item val\. excl\. tax」行/);
  });

  it('★ 错误文案是"人话"：中文、可执行、不含正则原文/英文技术串', () => {
    let msg = '';
    try {
      parsePeerless([HEADER, TOTAL_NET_LINE].join('\n'));
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toContain('PO 解析失败');
    expect(msg).toContain('请核对 PDF 或让供应商重新出具');
    // 正则原文/元字符不得上屏（B33/B36/B37 族）
    expect(msg).not.toMatch(/\\s|\\d|\[A-Z\]|\(\[|\.\*|\?/);
    // 同文件 :96/:98 那两处英文技术串的写法，新抛的不许照抄
    expect(msg).not.toMatch(/Peerless:.*not found/i);
    expect(msg).not.toMatch(/Actual price\s+\[/);
  });
});
