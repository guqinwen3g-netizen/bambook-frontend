/**
 * toleranceStandardService 测试（2026-09-29）
 *
 * ★ 本文件的断言取向：**先造红，再证明修好了**。
 *   每一条都写成"如果实现偷懒（静默降级 / 静默取第一档 / 把 NULL 当覆盖值），这条就会红"。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  pickBand,
  normalizeStandardSet,
  resolveTolerancePct,
  evaluateToleranceDual,
  gateToleranceOf,
  evaluateWidthDeduction,
  gateToleranceOf,
  resolveLineTolerance,
  suggestWidthDeduction,
  widthDeviationPct,
  loadToleranceStandards,
  writeInternalToleranceStandard,
  LINE_OVERRIDE_SOURCE,
  INTERNAL_TOLERANCE_KEY,
  UNRESOLVED_GATE_PCT,
  type ToleranceBand,
} from '../toleranceStandardService';

/** 真实客户 PO 的分档（★ 声明：这是**某一个客户**的标准，不是通用规则 —— R15） */
const PO_BANDS: ToleranceBand[] = [
  { minQty: 1, maxQty: 999, pct: 5 },
  { minQty: 1000, maxQty: 3000, pct: 3 },
  { minQty: 3001, maxQty: 5000, pct: 2 },
  { minQty: 5001, maxQty: null, pct: 1 },
];

describe('pickBand — 按度量值选档（纯函数）', () => {
  it('四个档各自命中正确的 pct', () => {
    expect(pickBand(PO_BANDS, 500).band?.pct).toBe(5);
    expect(pickBand(PO_BANDS, 2000).band?.pct).toBe(3);
    expect(pickBand(PO_BANDS, 4000).band?.pct).toBe(2);
    expect(pickBand(PO_BANDS, 30000).band?.pct).toBe(1);
  });

  it('★ 档位边界是「含」：999 → 第 1 档，1000 → 第 2 档', () => {
    expect(pickBand(PO_BANDS, 999).band?.pct).toBe(5);
    expect(pickBand(PO_BANDS, 1000).band?.pct).toBe(3);
  });

  it('★★ 落进「空档」⇒ 返回 null（不是回退某个默认值）', () => {
    // 999 与 1000 之间没有档位覆盖 999.5
    const m = pickBand(PO_BANDS, 999.5);
    expect(m.band, '空档必须返回 null —— 回退默认值就是把"没覆盖到"伪装成"有标准"').toBeNull();
    expect(m.ambiguous).toEqual([]);
  });

  it('★★ 档位重叠 ⇒ ambiguous 必须非空（不许静默取第一档）', () => {
    const overlap: ToleranceBand[] = [
      { minQty: 1, maxQty: 1000, pct: 5 },
      { minQty: 500, maxQty: 2000, pct: 3 }, // 与上一条在 500–1000 重叠
    ];
    const m = pickBand(overlap, 800);
    expect(m.band?.pct).toBe(5);
    expect(m.ambiguous, '重叠必须暴露出来，否则就是"同时命中却静默丢一半"').toHaveLength(1);
    expect(m.ambiguous[0].pct).toBe(3);
  });

  it('空表 / 非法度量值 ⇒ null', () => {
    expect(pickBand(null, 100).band).toBeNull();
    expect(pickBand([], 100).band).toBeNull();
    expect(pickBand(PO_BANDS, NaN).band).toBeNull();
  });
});

describe('normalizeStandardSet — 容错解析（绝不 throw）', () => {
  it('非对象 ⇒ null', () => {
    expect(normalizeStandardSet(null)).toBeNull();
    expect(normalizeStandardSet('x')).toBeNull();
    expect(normalizeStandardSet([1, 2])).toBeNull();
  });

  it('★ 一个可用档位都没有 ⇒ null（不是空壳对象）', () => {
    expect(normalizeStandardSet({})).toBeNull();
    expect(normalizeStandardSet({ qtyTolerance: [] })).toBeNull();
    expect(normalizeStandardSet({ qtyTolerance: [{ minQty: 'a' }] })).toBeNull();
  });

  it('★ 坏档位被丢掉、好档位保留；maxQty 缺省 ⇒ null（上不封顶）', () => {
    const s = normalizeStandardSet({
      qtyTolerance: [
        { minQty: 1, maxQty: 999, pct: 5 },
        { minQty: 'bad', pct: 3 },
        { minQty: 5001, pct: 1 },
      ],
      agreementRef: 'PO-2026-001',
    });
    expect(s?.qtyTolerance).toHaveLength(2);
    expect(s?.qtyTolerance?.[1]).toEqual({ minQty: 5001, maxQty: null, pct: 1 });
    expect(s?.agreementRef).toBe('PO-2026-001');
  });

  it('★ 负比例被丢掉（比例不能为负）', () => {
    expect(normalizeStandardSet({ qtyTolerance: [{ minQty: 1, pct: -5 }] })).toBeNull();
  });

  it('★★ SystemConfig 把 json 值**存成字符串** ⇒ 归一化器必须认（否则内部标准永远读不到）', () => {
    // 真源：config/systemConfigService.ts 的 set()：valueType='json' 时 JSON.stringify(value)
    const stored = JSON.stringify({ qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] });
    const s = normalizeStandardSet(stored);
    expect(s?.qtyTolerance?.[0].pct, '读不到 ⇒ 门禁会一直按「未判定」卡住').toBe(5);
  });

  it('★ 坏 JSON 字符串 ⇒ null（不 throw）', () => {
    expect(normalizeStandardSet('{not json')).toBeNull();
    expect(normalizeStandardSet('"just a string"')).toBeNull();
  });
});

describe('resolveTolerancePct — 取数链（① override → ② 客户 → ③ 我方 → ④ 未判定）', () => {
  it('① 行级 override 命中 ⇒ hard=true', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 30000,
      lineOverride: { pct: 7, source: LINE_OVERRIDE_SOURCE },
      customerStandard: { qtyTolerance: PO_BANDS },
    });
    expect(r.pct).toBe(7);
    expect(r.source).toBe('line_override');
    expect(r.hard).toBe(true);
  });

  it('★★★ 存量 106 行的形状：`source = NULL` ⇒ **不许**被当成 override', () => {
    // 库里 106 行的真实形状就是 { pct: 5.00, source: NULL }
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 30000,
      lineOverride: { pct: 5, source: null },
      customerStandard: { qtyTolerance: PO_BANDS },
    });
    expect(r.source, 'NULL 被当成覆盖值 ⇒ 第 ① 层永远命中 ⇒ 新机制对存量单永不生效').toBe('customer_standard');
    expect(r.pct).toBe(1); // 30000 落 5001+ 档
  });

  it('★ 只有 NULL 被拦还不够 —— 任何非白名单字符串也不许进 ① 层', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 500,
      lineOverride: { pct: 9, source: 'unset' },
      internalStandard: { qtyTolerance: PO_BANDS },
    });
    expect(r.source).toBe('internal_standard');
    expect(r.pct).toBe(5);
  });

  it('② 客户标准命中 ⇒ hard=true（P0）', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 30000,
      customerStandard: { qtyTolerance: PO_BANDS },
      internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] },
    });
    expect(r.source).toBe('customer_standard');
    expect(r.pct).toBe(1);
    expect(r.hard).toBe(true);
    expect(r.band).toEqual({ minQty: 5001, maxQty: null, pct: 1 });
  });

  it('③ 客户没有标准、我方有 ⇒ 落我方（hard=false，辅助）', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 500,
      internalStandard: { qtyTolerance: PO_BANDS },
    });
    expect(r.source).toBe('internal_standard');
    expect(r.hard).toBe(false);
  });

  /**
   * ★★ 2026-09-29 晚口径变更（Kevin：「你可以有一个默认值…即使公司没有去设置这个内部值，你也直接用这个」）
   * ⇒ 「客户未录 + 内部未录」**不再**等于"未判定"，而是落 **③b 出厂默认**（`internal_default`）。
   * ★ 下面这条断言是**新口径的化石**：它同时钉住三件事 ——
   *   ① 取到的数确实是出厂默认那一档（500 米 → ±5%）；② `source` 必须自报 `internal_default`（不许冒充别人录的）；
   *   ③ `notices` 必须点名"出厂默认 / 不是客户约定"（否则等于又一次静默降级）。
   */
  it('★★★ 客户未录 + 内部未录 ⇒ 落「出厂默认」（★ 不静默：source 与 notices 都要自报家门）', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 500,
      lineOverride: { pct: 5, source: null },
    });
    expect(r.pct).toBe(5); // 500 落出厂默认第 1 档（0–999 → ±5%）
    expect(r.source).toBe('internal_default');
    expect(r.hard, '出厂默认是我方辅助，不是硬约束（客户标准才是）').toBe(false);
    expect(r.referencePct, '★ 取到标准了 ⇒ 不再需要"参考值"（`referencePct` 只在**判不了**时出现）').toBeNull();
    expect(r.notices.join(''), '★ 必须点名"这是出厂默认"').toContain('出厂默认');
    expect(r.notices.join(''), '必须说清它不是客户约定').toContain('不是客户约定');
  });

  it('★★ 出厂默认也**只在既有档位内**生效：30000 米必须取到 1 档的 ±1%', () => {
    const r = resolveTolerancePct({ subject: 'qtyTolerance', measure: 30000 });
    expect(r.source).toBe('internal_default');
    expect(r.pct).toBe(1);
  });

  it('★★ 已录入的内部标准**压住**出厂默认（公司一调就生效，不是"默认值抢跑"）', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 500,
      internalStandard: { qtyTolerance: [{ minQty: 0, maxQty: null, pct: 9 }] },
    });
    expect(r.pct).toBe(9);
    expect(r.source).toBe('internal_standard');
    expect(r.notices.join('')).not.toContain('出厂默认');
  });

  it('★★ 出厂默认**不覆盖幅宽扣款**（没有参考数值 ⇒ 宁可不给，也不凭编的数建议扣款）', () => {
    const r = resolveTolerancePct({ subject: 'widthDeduction', measure: 145 });
    expect(r.pct).toBeNull();
    expect(r.source).toBe('none');
  });

  it('★★★ 客户侧**永不许**借用出厂默认（`allowInternalDefault:false` 的那一格）', () => {
    // 这就是 evaluateToleranceDual 里算客户侧那一遍的形状；少了那句 false，
    // 「客户标准未知」会被静默渲染成「合格」—— 正是本机制要修的病的同型。
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 500,
      internalStandard: null,
      allowInternalDefault: false,
    });
    expect(r.pct).toBeNull();
    expect(r.source).toBe('none');
    expect(r.unresolvedReason).toContain('客户标准');
  });

  it('★ 我方标准**读取失败**（≠ 没有）⇒ 未判定，且**不套出厂默认**（否则会把已录的更严标准悄悄放宽）', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 500,
      internalStandardUnavailable: true,
      lineOverride: { pct: 5, source: null },
    });
    expect(r.pct).toBeNull();
    expect(r.source).toBe('none');
    expect(r.notices.join('')).toContain('读取失败');
    expect(r.referencePct, '★ 必须带回参考值，界面要显示"系统默认、非合同约定"').toBe(5);
  });

  it('★ 落进档位空档 ⇒ 仍然报未判定（空档不许被默认值填平）', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 999.5,
      internalStandard: { qtyTolerance: [{ minQty: 0, maxQty: 999, pct: 5 }, { minQty: 1000, maxQty: null, pct: 3 }] },
    });
    expect(r.pct).toBeNull();
    expect(r.source).toBe('none');
    expect(r.unresolvedReason).toContain('空档');
  });

  it('★ 客户标准表存在但度量值落空档 ⇒ 未判定（继续降级到我方，不直接回退数字）', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 999.5,
      customerStandard: { qtyTolerance: PO_BANDS },
      internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 8 }] },
    });
    expect(r.source).toBe('internal_standard');
    expect(r.pct).toBe(8);
    expect(r.notices.join('')).toContain('空档');
  });

  it('★ 客户标准档位重叠 ⇒ notices 必须提示（不许静默）', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 800,
      customerStandard: {
        qtyTolerance: [
          { minQty: 1, maxQty: 1000, pct: 5 },
          { minQty: 500, maxQty: 2000, pct: 3 },
        ],
      },
    });
    expect(r.ambiguousBands).toHaveLength(1);
    expect(r.notices.join('')).toContain('重叠');
  });

  it('★ 幅宽扣款走同一形状，只是度量值换成幅宽', () => {
    const r = resolveTolerancePct({
      subject: 'widthDeduction',
      measure: 145,
      internalStandard: { widthDeduction: [{ minQty: 140, maxQty: 150, pct: 3 }] },
    });
    expect(r.pct).toBe(3);
    expect(r.source).toBe('internal_standard');
  });
});

describe('★★★ resolveTolerancePct — 「读不到」≠「没有」（客户标准是 P0，不许降级）', () => {
  it('★★ 客户标准读取失败 ⇒ **必须**未判定，绝不许落到我方标准', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 30000,
      customerStandardUnavailable: true,
      // 我方标准是好的 —— 一个偷懒的实现会"顺手"用它
      internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] },
    });
    expect(r.source, '静默降级 ⇒ 当"没约束"⇒ 可能放行超合同出运').toBe('none');
    expect(r.pct).toBeNull();
    expect(r.unresolvedReason).toContain('读取失败');
    expect(r.unresolvedReason).toContain('不降级是刻意的');
  });

  it('★ 反面对照：客户标准**确实没有**（不是读不到）⇒ 才允许降级到我方标准', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 500,
      customerStandard: null,
      customerStandardUnavailable: false,
      internalStandard: { qtyTolerance: PO_BANDS },
    });
    expect(r.source).toBe('internal_standard');
  });

  it('★ 我方标准读不到 ⇒ 只记 notice，不阻断（辅助项）', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 500,
      customerStandard: { qtyTolerance: PO_BANDS },
      internalStandardUnavailable: true,
    });
    expect(r.source).toBe('customer_standard');
    expect(r.pct).toBe(5);
    expect(r.notices.join('')).toContain('读取失败');
  });
});

describe('evaluateToleranceDual — 双重判定（各自独立算，不合取）', () => {
  it('★★★ 主用例（可证伪）：5001m 的单、客户标准 ±1%，实发 3% ⇒ 硬违规', () => {
    // 这就是设计稿 §七 的验收锚点 —— 现状会按 5% 放行，改完必须拦住
    const v = evaluateToleranceDual({
      contractQty: 30000,
      actualQty: 30900, // +3%
      unitPrice: 1.2,
      subject: 'qtyTolerance',
      customerStandard: { qtyTolerance: PO_BANDS },
      internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] },
    });
    expect(v.customer.resolved.pct).toBe(1);
    expect(v.customer.verdict).toBe('over_limit');
    expect(v.combined.verdict).toBe('hard_violation');
    // ★ 我方标准（5%）没超 —— 但不能因此放过
    expect(v.internal.verdict).toBe('ok');
  });

  it('★ 仅我方标准超限 ⇒ 内部预警（不是硬违规）', () => {
    const v = evaluateToleranceDual({
      contractQty: 1000,
      actualQty: 1035, // +3.5%
      subject: 'qtyTolerance',
      customerStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] }, // 客户宽松
      internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 3 }] }, // 我方更严
    });
    expect(v.customer.verdict).toBe('ok');
    expect(v.internal.verdict).toBe('over_limit');
    expect(v.combined.verdict).toBe('internal_warning');
  });

  it('★ 客户标准比我方松时：**客户 P0** —— 不因我方更严而升格成硬违规', () => {
    const v = evaluateToleranceDual({
      contractQty: 1000,
      actualQty: 1040, // +4%：我方 3% 超、客户 5% 未超
      subject: 'qtyTolerance',
      customerStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] },
      internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 3 }] },
    });
    expect(v.combined.verdict).toBe('internal_warning');
    expect(v.combined.verdict).not.toBe('hard_violation');
  });

  it('★★ 客户侧判不了 ⇒ **不许**声称合格（没依据的"没超"）', () => {
    const v = evaluateToleranceDual({
      contractQty: 1000,
      actualQty: 1000,
      subject: 'qtyTolerance',
      customerStandard: null, // 没有客户标准
      internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] }, // 我方说 ok
    });
    expect(v.internal.verdict).toBe('ok');
    expect(v.combined.verdict, '客户标准未知时声称"合格"是没有依据的').toBe('undetermined');
  });

  /**
   * ★★★ 2026-09-29 晚新增的**边界守护**：出厂默认上线后，最容易犯的错就是让它"顺手"去回答客户侧的问题。
   *   本用例同时钉住两面：自检侧**用上了**默认（说明口径真的生效），客户侧**没用**（说明没冒充客户）。
   */
  it('★★★ 出厂默认只服务自检侧：自检吃到默认，客户侧仍判「未判定」', () => {
    const v = evaluateToleranceDual({ contractQty: 1000, actualQty: 1010, subject: 'qtyTolerance' });
    // 自检侧：1000 米落出厂默认 1000–3000 档 ⇒ ±3%；+1% ⇒ ok
    expect(v.internal.resolved.source).toBe('internal_default');
    expect(v.internal.resolved.pct).toBe(3);
    expect(v.internal.verdict).toBe('ok');
    // 客户侧：不许借默认 ⇒ 判不了
    expect(v.customer.resolved.pct, '客户侧借用出厂默认 ⇒「客户标准未知」被静默渲染成「合格」').toBeNull();
    expect(v.customer.resolved.source).toBe('none');
    expect(v.combined.verdict).toBe('undetermined');
    expect(v.combined.headline).toContain('客户');
  });

  it('两侧都 ok ⇒ 合格', () => {
    const v = evaluateToleranceDual({
      contractQty: 1000,
      actualQty: 1020,
      subject: 'qtyTolerance',
      customerStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] },
      internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 3 }] },
    });
    expect(v.combined.verdict).toBe('ok');
  });

  it('★★ 双重判定的「双重」是真的：两侧各用自己的标准，不互相借用', () => {
    const v = evaluateToleranceDual({
      contractQty: 30000,
      actualQty: 30900,
      subject: 'qtyTolerance',
      customerStandard: { qtyTolerance: PO_BANDS },
      internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] },
    });
    // 自检那一遍拿到的必须是**我方**的 5，客户那一遍必须是**客户**的 1
    expect(v.internal.resolved.source).toBe('internal_standard');
    expect(v.internal.resolved.pct).toBe(5);
    expect(v.customer.resolved.source).toBe('customer_standard');
    expect(v.customer.resolved.pct).toBe(1);
  });

  it('★ 短装也判（verdict=under_limit ⇒ 硬违规）', () => {
    const v = evaluateToleranceDual({
      contractQty: 1000,
      actualQty: 900, // −10%
      subject: 'qtyTolerance',
      customerStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] },
    });
    expect(v.customer.verdict).toBe('under_limit');
    expect(v.combined.verdict).toBe('hard_violation');
    expect(v.combined.headline).toContain('短装');
  });
});

describe('gateToleranceOf — ★★ 唯一一处决定「未判定怎么办」（收掉 0 vs 5 的分歧）', () => {
  it('有标准 ⇒ 原样透传（★ 不许被改写成 0）', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 500,
      internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] },
    });
    const g = gateToleranceOf(r);
    expect(g.pct).toBe(5);
    expect(g.source).toBe('internal_standard');
    expect(g.gateNote).toBeNull();
  });

  it('★★ 未判定 ⇒ 按 UNRESOLVED_GATE_PCT 卡（= 0，不放溢装），且带原因 + 下一步', () => {
    // ★ 2026-09-29 晚口径：出厂默认上线后，"没人录"**不再**是未判定的来源
    //   ⇒ 本用例改从**仍然可达**的那条路径造：我方标准**读不到**（配置损坏 / DB 抖动）
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 500,
      internalStandardUnavailable: true,
    });
    const g = gateToleranceOf(r);
    expect(g.pct, '★ 回退成 5% 就等于继续用系统默认假设冒充合同条款').toBe(UNRESOLVED_GATE_PCT);
    expect(g.pct).toBe(0);
    expect(g.source).toBe('none');
    expect(g.unresolvedReason).toBeTruthy();
    expect(g.gateNote).toContain('不放溢装');
    expect(g.gateNote).toContain('内部公差标准');
  });

  it('★★ 内部未录时门禁拿到的**不是 0**，而是出厂默认的数（这才是 Kevin 那条口径的牙齿）', () => {
    const r = resolveTolerancePct({ subject: 'qtyTolerance', measure: 500 });
    const g = gateToleranceOf(r);
    expect(g.pct, '修前这里是 0 ⇒ 任何溢装一律卡死，业务侧无自解手段').toBe(5);
    expect(g.source).toBe('internal_default');
    expect(g.gateNote, '有可用标准 ⇒ 不该再出"请补录"的兜底话术').toBeNull();
  });

  it('★ 客户标准读不到时也按未判定卡（不降级到内部标准）', () => {
    const r = resolveTolerancePct({
      subject: 'qtyTolerance',
      measure: 500,
      customerStandardUnavailable: true,
      internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] },
    });
    const g = gateToleranceOf(r);
    expect(g.source).toBe('none');
    expect(g.pct).toBe(0);
    expect(g.unresolvedReason).toContain('读取失败');
  });
});

describe('suggestWidthDeduction — ★★ 只建议，不落账', () => {
  it('给出建议额 + 明确说明不自动落账', () => {
    const s = suggestWidthDeduction({ amount: 10000, pct: 3 });
    expect(s.amount).toBe(300);
    expect(s.basis).toContain('不自动落账');
  });

  it('★ 缺基数或比例 ⇒ amount=null（不猜）', () => {
    expect(suggestWidthDeduction({ amount: null, pct: 3 }).amount).toBeNull();
    expect(suggestWidthDeduction({ amount: 10000, pct: null }).amount).toBeNull();
    expect(suggestWidthDeduction({ amount: 10000, pct: null }).basis).toContain('不猜');
  });
});

describe('loadToleranceStandards — ★ 区分「没有」与「读不到」', () => {
  const stub = (over: Record<string, unknown> = {}) =>
    ({
      relation: { findUnique: vi.fn().mockResolvedValue({ customerAgreementTolerance: null }) },
      systemConfig: { findUnique: vi.fn().mockResolvedValue(null) },
      ...over,
    } as any);

  it('★ 列是 NULL（确实没录）⇒ unavailable 必须是 false', async () => {
    const r = await loadToleranceStandards(stub(), { customerRelationId: 'REL_1' });
    expect(r.customerStandard).toBeNull();
    expect(r.customerStandardUnavailable, '「没有」被当成「读不到」会误报故障').toBe(false);
  });

  it('★★ 查询抛错（读不到）⇒ unavailable 必须是 true', async () => {
    const r = await loadToleranceStandards(
      stub({ relation: { findUnique: vi.fn().mockRejectedValue(new Error('connection lost')) } }),
      { customerRelationId: 'REL_1' },
    );
    expect(r.customerStandard).toBeNull();
    expect(r.customerStandardUnavailable, '读不到必须显式标记，否则会被当成"没约束"').toBe(true);
  });

  it('★ 读到真标准 ⇒ 归一化后返回', async () => {
    const r = await loadToleranceStandards(
      stub({
        relation: {
          findUnique: vi.fn().mockResolvedValue({ customerAgreementTolerance: { qtyTolerance: PO_BANDS } }),
        },
      }),
      { customerRelationId: 'REL_1' },
    );
    expect(r.customerStandard?.qtyTolerance).toHaveLength(4);
    expect(r.customerStandardUnavailable).toBe(false);
  });

  it('★ 我方标准从 SystemConfig 读（global::tolerance.internal_standard）', async () => {
    const sysFind = vi.fn().mockResolvedValue({ value: { qtyTolerance: [{ minQty: 1, pct: 4 }] } });
    const r = await loadToleranceStandards(
      stub({ systemConfig: { findUnique: sysFind } }),
      { customerRelationId: null },
    );
    expect(r.internalStandard?.qtyTolerance?.[0].pct).toBe(4);
    expect(sysFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scope_key: { scope: 'global', key: 'tolerance.internal_standard' } },
      }),
    );
  });

  it('★ 没给 customerRelationId ⇒ 不查 relation（也不误报 unavailable）', async () => {
    const relFind = vi.fn();
    const r = await loadToleranceStandards(stub({ relation: { findUnique: relFind } }), { customerRelationId: null });
    expect(relFind).not.toHaveBeenCalled();
    expect(r.customerStandardUnavailable).toBe(false);
  });

  /**
   * ★★ 2026-09-29 晚：三条"没拿到可用内部标准"的路必须分开 —— 混在一起就会出两种错：
   *   把「没录」当故障（误报），或把「坏配置」当没录（拿出厂默认把已录的更严标准悄悄放宽）。
   */
  it('★ 内部标准**没录**（行不存在）⇒ standard=null 且 unavailable=false（出厂默认由解析器补）', async () => {
    const r = await loadToleranceStandards(stub(), { customerRelationId: null });
    expect(r.internalStandard).toBeNull();
    expect(r.internalStandardUnavailable, '「没录」不是故障 —— 标成 unavailable 会让它落"未判定"').toBe(false);
  });

  it('★★ 内部标准**配置存在但解析不出档位** ⇒ unavailable=true（★ 不许套出厂默认）', async () => {
    const r = await loadToleranceStandards(
      stub({ systemConfig: { findUnique: vi.fn().mockResolvedValue({ value: {} }) } }),
      { customerRelationId: null },
    );
    expect(r.internalStandard).toBeNull();
    expect(r.internalStandardUnavailable, '坏配置按"读不到"处理 —— 它绝不能被当成"没录"然后放宽').toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 幅宽扣款（窄幅索赔）—— 2026-09-29 晚
//   客户标准原文：「可用幅宽 ≥147CM；偏差 ≤3%→扣10% · ≤4.5%→扣25% · ≤6%→扣30%」
// ════════════════════════════════════════════════════════════════════

describe('widthDeviationPct — 幅宽偏差（正数 = 窄于基准）', () => {
  it('★ 基准 147 / 实测 141.12 ⇒ 偏差 4%（整）', () => {
    expect(widthDeviationPct(147, 141.12)).toBe(4);
  });

  it('★ 实测 = 基准 ⇒ 0；实测更宽 ⇒ 负数（不是"没偏差"）', () => {
    expect(widthDeviationPct(147, 147)).toBe(0);
    expect(widthDeviationPct(147, 150)).toBe(-2.0408);
  });

  it('★★ 基准缺失 / 为 0 / 非数字 ⇒ null（不猜，绝不当 0 处理）', () => {
    expect(widthDeviationPct(null, 140)).toBeNull();
    expect(widthDeviationPct(0, 140)).toBeNull();
    expect(widthDeviationPct(147, undefined)).toBeNull();
    expect(widthDeviationPct('abc', 140)).toBeNull();
  });
});

describe('evaluateWidthDeduction — ★★ 只建议不落账，且**没有出厂默认**', () => {
  /** 客户标准：照原文录（按**偏差 %** 分档） */
  const customerStd = {
    widthDeduction: [
      { minQty: 0, maxQty: 3, pct: 10 },
      { minQty: 3, maxQty: 4.5, pct: 25 },
      { minQty: 4.5, maxQty: 6, pct: 30 },
    ],
  };
  const gate = (standard: any, measure: number, opts: any = {}) =>
    gateToleranceOf(
      resolveTolerancePct({
        subject: 'widthDeduction',
        measure,
        customerStandard: standard,
        ...opts,
      }),
    );

  it('★★ 偏差 4% + 客户标准 ⇒ 扣 25%，金额 = 该行货款金额 × 25%', () => {
    const ev = evaluateWidthDeduction({
      basisWidthCm: 147,
      measuredWidthCm: 141.12,
      lineNetValue: 10000,
      tolerance: gate(customerStd, 4),
    });
    expect(ev.verdict).toBe('deduct');
    expect(ev.deviationPct).toBe(4);
    expect(ev.pct, '4% 落 3–4.5 档 ⇒ 25%').toBe(25);
    expect(ev.source).toBe('customer_standard');
    expect(ev.suggestedAmount).toBe(2500);
    expect(ev.headline).toContain('不自动落账');
    expect(ev.unresolvedReason).toBeNull();
  });

  it('★ 界值 3% 归**较低扣款档**（客户标准原文的"≤3%"就是这个意思）', () => {
    const ev = evaluateWidthDeduction({
      basisWidthCm: 147, measuredWidthCm: 142.59, lineNetValue: 10000,
      tolerance: gate(customerStd, 3),
    });
    expect(ev.pct, '精确 3% 取第一档（10%），不是 25%').toBe(10);
  });

  it('★★ **幅宽扣款没有出厂默认**：客户未录、我方也未录 ⇒ 未判定（不拿数量公差那套替它算）', () => {
    const g = gate(null, 4);
    const ev = evaluateWidthDeduction({
      basisWidthCm: 147, measuredWidthCm: 141.12, lineNetValue: 10000,
      tolerance: g,
    });
    expect(ev.verdict).toBe('undetermined');
    expect(ev.pct, '★ 编一个 5% 出来就等于用系统默认假设冒充客户条款').toBeNull();
    expect(ev.suggestedAmount).toBeNull();
    expect(ev.unresolvedReason).toContain('幅宽扣款');
    expect(ev.unresolvedReason).toContain('没有出厂默认');
  });

  it('★ 偏差超出最后一档（落在空档）⇒ 未判定，且点名"空档"而不是"没有标准"', () => {
    const ev = evaluateWidthDeduction({
      basisWidthCm: 147, measuredWidthCm: 138, lineNetValue: 10000,  // 偏差 ≈ 6.12%
      tolerance: gate(customerStd, 6.1224),
    });
    expect(ev.verdict).toBe('undetermined');
    expect(ev.unresolvedReason).toContain('空档');
  });

  it('★ 够宽（偏差 ≤ 0）⇒ ok + 0 扣款，**不报未判定**（没有标准也不该报，因为根本不需要标准）', () => {
    const ev = evaluateWidthDeduction({
      basisWidthCm: 147, measuredWidthCm: 150, lineNetValue: 10000,
      tolerance: gate(null, -2.0408),
    });
    expect(ev.verdict).toBe('ok');
    expect(ev.pct).toBe(0);
    expect(ev.suggestedAmount).toBe(0);
    expect(ev.unresolvedReason).toBeNull();
  });

  it('★ 缺幅宽数据 ⇒ 未判定（说清缺哪个数 + 下一步）', () => {
    const ev = evaluateWidthDeduction({
      basisWidthCm: null, measuredWidthCm: 141, lineNetValue: 10000,
      tolerance: gate(customerStd, 0),
    });
    expect(ev.verdict).toBe('undetermined');
    expect(ev.deviationPct).toBeNull();
    expect(ev.unresolvedReason).toContain('基准幅宽');
  });

  it('★ 缺行金额 ⇒ 只给比例、不给金额（不猜金额）', () => {
    const ev = evaluateWidthDeduction({
      basisWidthCm: 147, measuredWidthCm: 141.12, lineNetValue: null,
      tolerance: gate(customerStd, 4),
    });
    expect(ev.verdict).toBe('deduct');
    expect(ev.pct).toBe(25);
    expect(ev.suggestedAmount).toBeNull();
    expect(ev.notices.join('')).toContain('不给金额');
  });

  it('★★ 量纲是**偏差 %**（不是幅宽 cm）：同一份标准下，实测 141.12 命中 25%，实测 146 命中 10%', () => {
    const a = evaluateWidthDeduction({ basisWidthCm: 147, measuredWidthCm: 141.12, lineNetValue: 1000, tolerance: gate(customerStd, widthDeviationPct(147, 141.12)!) });
    const b = evaluateWidthDeduction({ basisWidthCm: 147, measuredWidthCm: 146, lineNetValue: 1000, tolerance: gate(customerStd, widthDeviationPct(147, 146)!) });
    expect(a.pct).toBe(25);
    expect(b.pct, '偏差 0.68% 落 0–3 档 ⇒ 10%').toBe(10);
  });
});
