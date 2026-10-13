/**
 * taxRefundFobStrip.test.ts — 退税基数：按成交方式把申报毛额剥离成 FOB
 *
 * 背景（2026-09-17 修的高危 bug）：
 *   退税 = FOB × 退税率。CIF/CFR 报关时 `CustomsDeclaration.totalValue` 是**含运保费**的，
 *   旧代码直接把它当 FOB 用（变量名还叫 exportAmountFob，实为 CIF）
 *   → **CIF 单退税额系统性虚高，且不报错**。
 *
 * 口径（复用 T7-3 收汇↔FOB 勾稽，不另立一套）：
 *   FOB/FCA/EXW 不剥 · CFR/CPT 剥运费 · CIF/CIP 剥运费+保费 · DDP/DAP/DPU 不猜
 *   未填成交方式 → 按不剥（保守）· 需要剥但没登记 → **不给数**（绝不回退成毛额）
 *
 * 业务拍板（Kevin 2026-09-17）：
 *   ① 运费保费登记在**报关单**（税务认报关单上的数，不复用运单的实际费用）
 *   ② 剥不出来就**不给数 + 明确提示**，不许拿 CIF 冒充 FOB
 */
import { describe, expect, it } from 'vitest';
import { stripToFob, incotermStripClass } from '../taxRefundCalcService';

const GROSS = 100000; // 申报毛额（CIF 口径下含运保费）

describe('stripToFob — 不需要剥离的成交方式', () => {
  it('FOB → 申报额即 FOB，原样返回（不减任何东西）', () => {
    const r = stripToFob({ gross: GROSS, tradeTerms: 'FOB', freightAmount: 3000, insuranceAmount: 500 });
    expect(r.fob).toBe(GROSS);
    expect(r.strippedFreight).toBe(0);
    expect(r.needFreight).toBe(false);
    expect(r.gap).toBeNull();
  });

  it('FCA / EXW → 同样不剥（离岸/出厂价）', () => {
    expect(stripToFob({ gross: GROSS, tradeTerms: 'FCA' }).fob).toBe(GROSS);
    expect(stripToFob({ gross: GROSS, tradeTerms: 'EXW' }).fob).toBe(GROSS);
  });

  it('小写/带空格也认（fob、 cif ）', () => {
    expect(stripToFob({ gross: GROSS, tradeTerms: 'fob' }).fob).toBe(GROSS);
    expect(stripToFob({ gross: GROSS, tradeTerms: ' cif ', freightAmount: 3000, insuranceAmount: 500 }).fob).toBe(96500);
  });

  it('未填成交方式 → 按不剥处理（保守方向：宁可偏高也不静默产出一个看似精确的错误数）', () => {
    for (const t of [null, undefined, '']) {
      expect(stripToFob({ gross: GROSS, tradeTerms: t }).fob).toBe(GROSS);
    }
  });
});

describe('stripToFob — 需要剥离的成交方式', () => {
  it('CFR / CPT → 只剥运费（不含保险，保费不该减）', () => {
    const r = stripToFob({ gross: GROSS, tradeTerms: 'CFR', freightAmount: 3000, insuranceAmount: 500 });
    expect(r.fob).toBe(97000);
    expect(r.strippedFreight).toBe(3000);
    expect(r.strippedInsurance).toBe(0);
    expect(r.needInsurance).toBe(false);
  });

  it('CIF / CIP → 运费 + 保费都剥', () => {
    const r = stripToFob({ gross: GROSS, tradeTerms: 'CIF', freightAmount: 3000, insuranceAmount: 500 });
    expect(r.fob).toBe(96500);
    expect(r.strippedFreight).toBe(3000);
    expect(r.strippedInsurance).toBe(500);
  });

  it('这是修复的核心：CIF 的 FOB 必须**小于**申报额（旧实现等于申报额 → 退税额虚高）', () => {
    const r = stripToFob({ gross: GROSS, tradeTerms: 'CIF', freightAmount: 8000, insuranceAmount: 1200 });
    expect(r.fob).toBeLessThan(GROSS);
    expect(r.fob).toBe(90800);
  });
});

describe('stripToFob — 剥不出来就**不给数**（fail-closed，绝不回退成毛额）', () => {
  it('CIF 但没登记运费 → null + freight_missing（**不能**返回毛额）', () => {
    const r = stripToFob({ gross: GROSS, tradeTerms: 'CIF', freightAmount: null, insuranceAmount: 500 });
    expect(r.fob).toBeNull();
    expect(r.gap).toBe('freight_missing');
  });

  it('CIF 但没登记保费 → null + insurance_missing', () => {
    const r = stripToFob({ gross: GROSS, tradeTerms: 'CIF', freightAmount: 3000, insuranceAmount: null });
    expect(r.fob).toBeNull();
    expect(r.gap).toBe('insurance_missing');
  });

  it('CFR 缺运费 → null + freight_missing', () => {
    const r = stripToFob({ gross: GROSS, tradeTerms: 'CFR' });
    expect(r.fob).toBeNull();
    expect(r.gap).toBe('freight_missing');
  });

  it('DDP / DAP / DPU → 不猜，标记 trade_terms_unsupported', () => {
    for (const t of ['DDP', 'DAP', 'DPU']) {
      const r = stripToFob({ gross: GROSS, tradeTerms: t, freightAmount: 3000, insuranceAmount: 500 });
      expect(r.fob).toBeNull();
      expect(r.gap).toBe('trade_terms_unsupported');
    }
  });

  it('申报毛额都没有 → null（无 gap，由调用方的 no_lines/line_total 报缺）', () => {
    const r = stripToFob({ gross: null, tradeTerms: 'CIF' });
    expect(r.fob).toBeNull();
    expect(r.gap).toBeNull();
  });

  it('运费 ≥ 申报额（数据异常）→ 不给数，绝不产出 0 或负数', () => {
    // 剥成负数：数据一定填错了，给数就是给个假数
    expect(stripToFob({ gross: 1000, tradeTerms: 'CIF', freightAmount: 2000, insuranceAmount: 0 }).fob).toBeNull();
    // 剥成刚好 0：同样不给（FOB=0 的退税没有意义，且多半是漏填）
    expect(stripToFob({ gross: 1000, tradeTerms: 'CIF', freightAmount: 1000, insuranceAmount: 0 }).fob).toBeNull();
  });

  it('剥成 ≤0 的报缺码是 fob_not_positive，**不是** freight_missing', () => {
    // 为什么钉这个码：运保费其实都登记了，报 freight_missing 会让 UI 叫用户
    // 「去报关单填运费」—— 填一个已经填了的字段，用户会卡在这儿反复试。
    const r = stripToFob({ gross: 1000, tradeTerms: 'CIF', freightAmount: 2000, insuranceAmount: 100 });
    expect(r.gap).toBe('fob_not_positive');
    expect(r.strippedFreight).toBe(2000);   // 已登记的事实要如实带出
    expect(r.strippedInsurance).toBe(100);
  });
});

// ────────────────────────────────────────────────────────────────
// ★ 矩阵补测（2026-09-26 · G2 变异矩阵普查 §11 第 4 条 M4 的未测格）
//   普查现量：CPT / CIP 的**成本语义**在代码里已实现（CFR/CPT 一组、CIF/CIP 一组），
//   但单测标题写着"CFR/CPT"而 body 只跑 CFR ⇒ 把 CPT 挪进别的组**不会有任何一格红**。
//   外加一条**集合守卫**：FAS 之所以能悄悄走进"不剥"那一支（台账 B225），
//   正是因为全仓没有一把尺把 11 条 Incoterms 当**集合**过一遍。
// ────────────────────────────────────────────────────────────────
describe('矩阵补测：CPT / CIP 的剥离语义 + 11 条成交方式必须被显式归类', () => {
  it('CPT：运费已含 ⇒ 只剥运费；保费自保 ⇒ 一律不剥（哪怕登记了保费也不减）', () => {
    const r = stripToFob({ gross: GROSS, tradeTerms: 'CPT', freightAmount: 3000, insuranceAmount: 500 });
    expect(r.fob).toBe(97000);
    expect(r.strippedFreight).toBe(3000);
    expect(r.strippedInsurance).toBe(0); // ★ 有人把 CPT 挪进 CIF 组 ⇒ 这一格当场红
    expect(r.gap).toBeNull();
  });

  it('CIP：运费与保费都含 ⇒ 两项都剥', () => {
    const r = stripToFob({ gross: GROSS, tradeTerms: 'CIP', freightAmount: 3000, insuranceAmount: 500 });
    expect(r.fob).toBe(96500);
    expect(r.strippedFreight).toBe(3000);
    expect(r.strippedInsurance).toBe(500);
  });

  it('CPT / CIP 缺登记 ⇒ 不给数并指向缺的那一项（绝不回退成毛额）', () => {
    expect(stripToFob({ gross: GROSS, tradeTerms: 'CPT' }).gap).toBe('freight_missing');
    expect(stripToFob({ gross: GROSS, tradeTerms: 'CIP', freightAmount: 3000 }).gap).toBe('insurance_missing');
    expect(stripToFob({ gross: GROSS, tradeTerms: 'CPT' }).fob).toBeNull();
  });

  it('★ 集合守卫：Incoterms 2020 全 11 条，除已立账的 FAS 外必须各有归类', () => {
    const EXPECT: Record<string, string> = {
      EXW: 'no-strip', FCA: 'no-strip', FOB: 'no-strip',
      CFR: 'freight-only', CPT: 'freight-only',
      CIF: 'freight-and-insurance', CIP: 'freight-and-insurance',
      DAP: 'unstrippable', DPU: 'unstrippable', DDP: 'unstrippable',
    };
    const REGISTERED_UNCLASSIFIED = ['FAS']; // 台账 B225：该不该剥离属行业口径（M2），先立账不猜
    for (const [term, want] of Object.entries(EXPECT)) {
      expect(incotermStripClass(term), `${term} 的归类漂了`).toBe(want);
    }
    for (const term of REGISTERED_UNCLASSIFIED) {
      expect(incotermStripClass(term), `${term} 一旦被显式归类，请同步撤掉 B225 与本行例外`).toBe('unknown');
    }
    // 分母自检：两份名单合起来必须正好 11 条（漏登记一条 ⇒ 这条守卫自己先红）
    expect(Object.keys(EXPECT).length + REGISTERED_UNCLASSIFIED.length).toBe(11);
    // 未知串同样落 'unknown' ⇒ 说明上面那条不是"任何未知都算过"，靠的是 11 条枚举
    expect(incotermStripClass('DAT')).toBe('unknown');
    expect(incotermStripClass(null)).toBe('unknown');
  });
});
