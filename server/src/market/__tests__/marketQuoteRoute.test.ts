/**
 * marketQuoteRoute 守卫（2026-09-19 羊毛/亚麻录入入口）
 *
 * 背景：羊毛 / 亚麻市场上没有实时价 ⇒ 真源 = 系统配置人工录入。
 * 但录入端**此前完全不存在**（只能由开发写 SQL）⇒ 本批补上，风险点全在「校验」上：
 *   · 漏校验 ⇒ 业务员多敲一个 0，全公司的行情卡显示 ¥975,000/吨
 *   · 未来日期 ⇒ 界面显示"未来的行情"，比错数字更让人困惑
 *   · 读写区间不一致 ⇒ 录入端接受、展示端却当脏数据丢掉（哑巴故障）
 *
 * ⚠️ 每条断言都要能踩红 —— 改完请把期望值反过来跑一次确认会失败。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateManualQuote, checkQuoteRange, isManualQuoteKey } from '../marketQuoteRoute';
import { MANUAL_QUOTE_RANGES, MANUAL_QUOTE_KEYS, manualQuoteConfigKey } from '../marketQuoteService';

const TODAY = '2026-09-19';

describe('validateManualQuote', () => {
  it('阳性对照：合法值 ⇒ 通过并原样返回', () => {
    const r = validateManualQuote({ price: 97500, asOf: '2026-09-18', note: 'AWEX EMI 折算' }, TODAY);
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ price: 97500, asOf: '2026-09-18', note: 'AWEX EMI 折算' });
  });

  it('只填价格也能过（asOf / note 可省）⇒ asOf=null（不是编一个今天）', () => {
    const r = validateManualQuote({ price: 86000 }, TODAY);
    expect(r.errors).toEqual([]);
    expect(r.value!.asOf).toBeNull();
    expect(r.value!.note).toBeNull();
  });

  it('价格必填：缺 / 空串 / null 都拒', () => {
    for (const body of [{}, { price: '' }, { price: null }]) {
      const r = validateManualQuote(body, TODAY);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.value).toBeUndefined();
    }
  });

  it('价格必须 > 0 且是数字（0 / 负数 / 非数字都拒）', () => {
    for (const price of [0, -1, 'abc', NaN]) {
      const r = validateManualQuote({ price }, TODAY);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('★ asOf 不能晚于今天（未来日期 = 笔误，会显示"未来的行情"）', () => {
    const r = validateManualQuote({ price: 97500, asOf: '2026-09-20' }, TODAY);
    expect(r.errors.some(e => e.includes('不能晚于今天'))).toBe(true);
  });

  it('asOf 必须是 YYYY-MM-DD（挡掉 2026/9/18、09-18 这类写法）', () => {
    for (const asOf of ['2026/09/18', '09-18', '2026-9-8', 'yesterday']) {
      const r = validateManualQuote({ price: 97500, asOf }, TODAY);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('asOf = 今天 ⇒ 允许（当天录入是正常操作）', () => {
    const r = validateManualQuote({ price: 97500, asOf: TODAY }, TODAY);
    expect(r.errors).toEqual([]);
    expect(r.value!.asOf).toBe(TODAY);
  });

  it('note 超长拒绝；首尾空白被 trim，且全空白 ⇒ null（不落空字符串）', () => {
    const long = validateManualQuote({ price: 1, note: 'x'.repeat(121) }, TODAY);
    expect(long.errors.length).toBeGreaterThan(0);

    const trimmed = validateManualQuote({ price: 97500, note: '  AWEX  ' }, TODAY);
    expect(trimmed.value!.note).toBe('AWEX');

    const blank = validateManualQuote({ price: 97500, note: '   ' }, TODAY);
    expect(blank.value!.note).toBeNull();
  });

  it('价格是数字字符串也接受（表单 input 本来就是字符串）', () => {
    const r = validateManualQuote({ price: '97500' }, TODAY);
    expect(r.errors).toEqual([]);
    expect(r.value!.price).toBe(97500);
  });
});

describe('checkQuoteRange', () => {
  it('阳性对照：区间内的真实业务值通过', () => {
    expect(checkQuoteRange('wool', 97500)).toBeNull();
    expect(checkQuoteRange('linen', 87500)).toBeNull();
  });

  it('★ 数量级笔误必须挡住（多敲一个 0）', () => {
    expect(checkQuoteRange('wool', 975000)).not.toBeNull();
    expect(checkQuoteRange('linen', 8750000)).not.toBeNull();
  });

  it('顺手填成澳分/公斤 这类小数字也挡（如 1873）', () => {
    expect(checkQuoteRange('wool', 1873)).not.toBeNull();
  });

  it('边界值包含在内（闭区间）', () => {
    for (const key of MANUAL_QUOTE_KEYS) {
      const [lo, hi] = MANUAL_QUOTE_RANGES[key];
      expect(checkQuoteRange(key, lo)).toBeNull();
      expect(checkQuoteRange(key, hi)).toBeNull();
      expect(checkQuoteRange(key, lo - 1)).not.toBeNull();
      expect(checkQuoteRange(key, hi + 1)).not.toBeNull();
    }
  });
});

describe('isManualQuoteKey / 配置键', () => {
  it('只认 wool / linen；大小写不敏感由路由侧 toLowerCase 处理', () => {
    expect(isManualQuoteKey('wool')).toBe(true);
    expect(isManualQuoteKey('linen')).toBe(true);
    expect(isManualQuoteKey('cotton')).toBe(false); // 棉花是实时源，不允许人工覆盖
    expect(isManualQuoteKey('')).toBe(false);
  });

  it('配置键与读取端（marketQuoteService）必须完全一致 —— 不一致 = 存了读不到', () => {
    const src = readFileSync(resolve(__dirname, '../marketQuoteService.ts'), 'utf8');
    expect(manualQuoteConfigKey('wool')).toBe('market.wool');
    expect(manualQuoteConfigKey('linen')).toBe('market.linen');
    // 读取端必须用同一个构造函数（避免读写各拼一套字符串而漂移）
    expect(src).toContain('manualQuoteConfigKey');
  });

  it('★ 读写共用同一份区间常量（否则会出现"录入端收、展示端丢"的哑巴故障）', () => {
    const readSrc = readFileSync(resolve(__dirname, '../marketQuoteService.ts'), 'utf8');
    const routeSrc = readFileSync(resolve(__dirname, '../marketQuoteRoute.ts'), 'utf8');
    expect(routeSrc).toContain('MANUAL_QUOTE_RANGES');
    expect(readSrc).toContain('MANUAL_QUOTE_RANGES');
    // 读取端的越界检查必须存在（只在写入端挡 = 直接改库 / 自动同步解析错位后页面照样显示错值）
    expect(readSrc).toContain('quote-out-of-range');
  });
});

describe('结构守卫：写入口有权限与审计', () => {
  const SRC = readFileSync(resolve(__dirname, '../marketQuoteRoute.ts'), 'utf8');

  it('★ 写端点必须是 requireRole(owner/admin)（行情写错会让全公司看到错价）', () => {
    expect(SRC).toContain("requireRole('owner', 'admin')");
  });

  it('★ 写操作必须带 actorId + reason（留痕）', () => {
    expect(SRC).toContain('actorId');
    expect(SRC).toContain('reason');
  });

  it('★ actor 必须走既有真源 extractActorFromRequest（读 req.user 会拿不到 ⇒ updatedBy 空）', () => {
    expect(SRC).toContain('extractActorFromRequest');
    // 反向：不得直接读 req.user / req.auth 当身份来源
    expect(SRC).not.toMatch(/\(req as any\)\.user\?\.id/);
    expect(SRC).not.toMatch(/\(req as any\)\.auth\?\.userId/);
  });

  it('★ 不得在这里写 localStorage 或前端缓存（真源只有服务端配置）', () => {
    expect(SRC).not.toContain('localStorage');
  });
});
