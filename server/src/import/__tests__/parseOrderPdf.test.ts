import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { parseOrderPdf } from '../parseOrderPdf';
import { ACTUAL_PRICE_LINE, TOTAL_NET_LINE, buildPdf, peerlessHeaderLines } from './helpers/syntheticPdf';

const DIR = '/Users/qinwengu/WorkBuddy/Claw/BusinessDocu/00-Entities/Peerless/面料/BULK PO';
const ALL = [
  ['PO#-4500159423-0001.pdf', '4500159423', 4],
  ['PO#-4500159154-0001.pdf', '4500159154', 3],
  ['PO#-4500159120-0001.pdf', '4500159120', 1],
  ['PO#-4500159027-0001.pdf', '4500159027', 3],
  ['PO#-4500158987-0001.pdf', '4500158987', 2],
] as const;

describe('parseOrderPdf — Peerless 5 fixtures', () => {
  it.each(ALL)('%s parses end-to-end', async (file, po, lineCount) => {
    const buf = fs.readFileSync(`${DIR}/${file}`);
    const r = await parseOrderPdf(buf);
    expect(r.detection.customerId).toBe('peerless');
    expect(r.detection.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.order?.poNumber).toBe(po);
    expect(r.order?.lines.length).toBe(lineCount);
    expect(r.error).toBeUndefined();
  });

  it('empty buffer returns error, not throw', async () => {
    const r = await parseOrderPdf(Buffer.from(''));
    expect(r.order).toBeUndefined();
    expect(r.error).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S4 处置 · 任务 1（P1）：缺行时错误要**一路走到用户面前**（走全链，不只测解析器）
//
// 这条链本来就有、且是专门为解析失败设计的：`parseOrderPdf` 的 try/catch 把 message
// 放进 `error` 字段 → `import/route.ts` 再把 `error` 逐文件返回前端。
// 原来的 `: 0` 让这条通道**永远走不到**（缺行被当成"成功"）。
//
// ★ 用合成 PDF（`helpers/syntheticPdf.ts`）而不是真 PO：真 PO 5 份全命中，造不出"缺行"。
// ★ 注：`parseOrderPdf` 的 catch 分支会把 `detection` 重置为 `customerId: null`
//   （既有行为，对 :96/:98 那两处抛错也一样）—— 本任务不改它，故此处不断言 detection。
// ─────────────────────────────────────────────────────────────────────────────
describe('parseOrderPdf — 缺行 ⇒ error 是中文人话、order 不存在（S4 任务 1）', () => {
  const HEADER = peerlessHeaderLines();

  it('阳性对照：两行都在 ⇒ order 存在、error 未定义、金额为真值', async () => {
    const r = await parseOrderPdf(buildPdf([...HEADER, TOTAL_NET_LINE, ACTUAL_PRICE_LINE]));
    expect(r.error).toBeUndefined();
    expect(r.order?.poNumber).toBe('4500159423');
    expect(r.order?.totalNet).toBeCloseTo(103680, 2);
    expect(r.order?.totalActual).toBeCloseTo(103680, 2);
  });

  it('缺「Actual price」⇒ 不抛，order 不存在，error 是中文人话', async () => {
    const r = await parseOrderPdf(buildPdf([...HEADER, TOTAL_NET_LINE]));
    // 改前：order 存在且 totalActual = 0、error 为 undefined ⇒ 本用例咬红
    expect(r.order).toBeUndefined();
    expect(r.error).toBeTruthy();
    expect(r.error).toContain('未找到「Actual price」行');
    expect(r.error).toContain('无法确定成交金额');
    expect(r.error).toContain('请核对 PDF 或让供应商重新出具');
    expect(r.error).not.toMatch(/\\s|\[A-Z\]|\[\d/);
  });

  it('缺「Tot. net item val. excl. tax」⇒ 同样走到 error（不是静默 0）', async () => {
    const r = await parseOrderPdf(buildPdf([...HEADER, ACTUAL_PRICE_LINE]));
    expect(r.order).toBeUndefined();
    expect(r.error).toContain('未找到「Tot. net item val. excl. tax」行');
    expect(r.error).toContain('无法确定净金额');
  });
});
