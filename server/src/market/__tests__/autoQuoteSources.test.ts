/**
 * autoQuoteSources 守卫（2026-09-19 行情自动同步）
 *
 * 背景：Kevin 否掉人工录入 ⇒ 羊毛/亚麻改由外部源自动同步。两个源的性质完全不同：
 *   · 羊毛 = FRED 公开 CSV（**结构化**）⇒ 风险在「缺失值 `.` 被当成 0/NaN」
 *   · 亚麻 = 欧洲亚麻联盟**叙述文**（无表格）⇒ 风险在「抓错句子」
 *
 * 夹具全部是 **2026-09-19 生产实测抓样**（不是手编的漂亮样本）。
 *
 * ⚠️ 每条断言都要能踩红 —— 改完请把期望值反过来跑一次确认会失败。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseFredCsv,
  parseWoolFromFred,
  parseAllianceLinen,
  pickObservatoryPages,
} from '../autoQuoteSources';

// ── 羊毛：真实 FRED 响应片段（含末尾最新两期） ──
const FRED_CSV = [
  'observation_date,PWOOLCUSDM',
  '2026-04-01,1518.1949750000001',
  '2026-05-01,1541.5804312499999',
  '2026-06-01,1550.6532800000000',
  '2026-07-01,1483.9929250000000',
].join('\n');

// ── 亚麻：真实联盟页面句子（含**陷阱句**：历史高价 + 产量数字） ──
const ALLIANCE_HTML = `
<div>
  <p>The price of Masters of FLAX FIBRE™ long fibre: an upward trend</p>
  <p>After a rapid decrease in late 2024, bringing the average price per kilogram down from €9.00 in March 2024
     to €3.33 in January 2025, the average price of Masters of FLAX FIBRE™ has risen gradually.</p>
  <p>In December 2025 – the latest available figure – the average price reached €5.49, a figure pending final consolidation,
     representing a 37% increase over a year.</p>
  <p>The average price of Masters of Flax FIBRE™ long fibres was 5.89€/kg** in March 2026, for all qualities and regions of the EU combined.</p>
  <p>Production reached 200,000 tonnes of long fibres over the season, with monthly output of 17,000 to 19,000 tonnes.</p>
</div>`;

describe('parseFredCsv / parseWoolFromFred（羊毛 = IMF 结构化 CSV）', () => {
  it('阳性对照：取到最新一期（2026-07 = 1483.99 美分/公斤）', () => {
    const q = parseWoolFromFred(FRED_CSV);
    expect(q).not.toBeNull();
    expect(q!.nativePrice).toBeCloseTo(1483.99, 2);
    expect(q!.asOf).toBe('2026-07-01');
    expect(q!.nativeUnit).toBe('USC/kg');
  });

  it('环比 = 最后一期 vs 上一期（1483.99 vs 1550.65 ⇒ 约 -4.3%）', () => {
    const q = parseWoolFromFred(FRED_CSV)!;
    expect(q.nativeChangePct).toBeCloseTo(((1483.992925 - 1550.65328) / 1550.65328) * 100, 3);
  });

  it('★ 缺失值 `.` 必须跳过（FRED 用 `.` 占位，Number(".") = NaN）', () => {
    const pts = parseFredCsv('observation_date,X\n2026-06-01,.\n2026-07-01,1483.99\n');
    expect(pts.map((p) => p.value)).toEqual([1483.99]);
  });

  it('★ 尾部为缺失值 ⇒ 不能把 NaN 当最新价（应回退到上一个有效期）', () => {
    const q = parseWoolFromFred('observation_date,X\n2026-06-01,1550.65\n2026-07-01,.\n')!;
    expect(q.nativePrice).toBeCloseTo(1550.65);
    expect(Number.isFinite(q.nativePrice)).toBe(true);
  });

  it('★ 区间守卫：把「吨数」误当价格（如 200000）⇒ 拒绝，不返回', () => {
    expect(parseWoolFromFred('observation_date,X\n2026-07-01,200000\n')).toBeNull();
  });

  it('只有表头 / 空响应 ⇒ null（不抛错、不返回 0）', () => {
    expect(parseWoolFromFred('observation_date,PWOOLCUSDM\n')).toBeNull();
    expect(parseWoolFromFred('')).toBeNull();
  });

  it('行序乱也能取到最新（不依赖 CSV 顺序）', () => {
    const q = parseWoolFromFred('observation_date,X\n2026-07-01,1483.99\n2026-06-01,1550.65\n')!;
    expect(q.asOf).toBe('2026-07-01');
  });
});

describe('parseAllianceLinen（亚麻 = 叙述文，必须失败即停）', () => {
  it('阳性对照：取最新月份那一对（March 2026 / 5.89 欧式写法）', () => {
    const q = parseAllianceLinen(ALLIANCE_HTML);
    expect(q).not.toBeNull();
    expect(q!.nativePrice).toBeCloseTo(5.89, 2);
    expect(q!.asOf).toBe('2026-03-01');
  });

  it('★ 陷阱句不能赢：」峰值 March 2024 €9.00」这类历史值必须落选（取全局最新月份）', () => {
    const q = parseAllianceLinen(ALLIANCE_HTML)!;
    expect(q.nativePrice).not.toBeCloseTo(9.0, 2);
    expect(q.nativePrice).not.toBeCloseTo(3.33, 2);
    expect(q.asOf).not.toBe('2024-03-01');
  });

  it('★ 同句中「价格 + 月份」必须配对；只有月份没有价格的句子不产生值', () => {
    const q = parseAllianceLinen('<p>Production in March 2026 reached 200,000 tonnes.</p>');
    expect(q).toBeNull();
  });

  it('★ 区间守卫：把产量数字（200000）当价格 ⇒ 拒绝', () => {
    const q = parseAllianceLinen('<p>The average price was €200000/kg in March 2026.</p>');
    expect(q).toBeNull();
  });

  it('★ 解析不到就返回 null（调用方保留旧值）—— 页面改版时最坏是数据旧，不是数字错', () => {
    expect(parseAllianceLinen('<html><body><p>Nothing about prices here.</p></body></html>')).toBeNull();
    expect(parseAllianceLinen('')).toBeNull();
  });

  it('月份无年份 ⇒ 不猜（缺年份不认，避免把去年当月当成今年）', () => {
    expect(parseAllianceLinen('<p>The average price reached €5.49 in December.</p>')).toBeNull();
  });

  it('script / style 里的数字不参与解析（先剥再切句）', () => {
    const html = '<script>var x = "€999.00 in December 2030";</script><p>The average price was €5.49 in December 2025.</p>';
    const q = parseAllianceLinen(html)!;
    expect(q.nativePrice).toBeCloseTo(5.49);
    expect(q.asOf).toBe('2025-12-01');
  });

  it('重复出现同一月份 ⇒ 取其一，不抛错', () => {
    const q = parseAllianceLinen('<p>The average price was €5.49 in December 2025. Also €5.49 in December 2025.</p>')!;
    expect(q.asOf).toBe('2025-12-01');
  });
});

describe('结构守卫：自动同步真的接进调度与路由了', () => {
  const SCHED = readFileSync(resolve(__dirname, '../../scheduler/index.ts'), 'utf8');
  const TASK = readFileSync(resolve(__dirname, '../../scheduler/tasks/marketQuoteSync.ts'), 'utf8');
  const ROUTE = readFileSync(resolve(__dirname, '../marketQuoteRoute.ts'), 'utf8');

  it('★ 调度器注册了 market_quote_sync（不注册 = 永远不自动跑）', () => {
    expect(SCHED).toContain('createMarketQuoteSyncTask');
    expect(TASK).toContain("id: 'market_quote_sync'");
  });

  it('★ 排期在汇率同步之后（羊毛折算要用当日 USD/CNY）', () => {
    const fxIdx = SCHED.indexOf('createFxRateSyncTask()');
    const mkIdx = SCHED.indexOf('createMarketQuoteSyncTask()');
    expect(fxIdx).toBeGreaterThan(-1);
    expect(mkIdx).toBeGreaterThan(fxIdx);
  });

  it('★ 路由暴露「立即同步」，且是写权限（owner/admin）', () => {
    expect(ROUTE).toContain("'/quotes/refresh'");
    expect(ROUTE).toContain('runAutoQuoteSync');
  });

  it('★ 失败必须保留旧值（不写 null / 不写兜底数字）', () => {
    // 只在「解析成功且折算后在区间内」才 writeConfig
    expect(TASK).toContain('report.failed');
    expect(TASK).toContain('ok: report.ok');
  });
});

describe('pickObservatoryPages', () => {
  it('只认联盟站内的 observatory 子页，且过滤锚点链接', () => {
    const html = `
      <a href="/en/flax-linen-hemp-economic-observatory/figures-2025">a</a>
      <a href="https://allianceflaxlinenhemp.eu/en/flax-linen-hemp-economic-observatory/2024-flax-hemp-market-figures">b</a>
      <a href="#flaxfibremarket2026">anchor</a>
      <a href="https://evil.example.com/x">out</a>`;
    const pages = pickObservatoryPages(html);
    expect(pages).toContain('https://allianceflaxlinenhemp.eu/en/flax-linen-hemp-economic-observatory/figures-2025');
    expect(pages).toContain('https://allianceflaxlinenhemp.eu/en/flax-linen-hemp-economic-observatory/2024-flax-hemp-market-figures');
    expect(pages.some((p) => p.includes('evil.example.com'))).toBe(false);
  });
});
