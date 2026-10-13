/**
 * processCoverage.test.ts — ★ D2 真源单测：排产覆盖度（多工厂/多工位分批交货的合计核对）
 *
 * 为什么单测这块（零基础障碍清单 D2）：
 *   `ProductionPlan` 有 `processSeq`（工序顺序）⇒ **每道工序都排「全量」是正常的**
 *   （裁剪 1000 → 缝制 1000 → 包装 1000）。所以「Σ 全部排产 ≤ 订单量」是**错的判据**，
 *   会把正常多工序排产全判成超产。正确判据 = **同一工序类型内**跨工位/跨批次合计。
 *   这条判据极易写错，必须钉成可单测的纯函数。
 */
import { describe, expect, it } from 'vitest';
import { summarizeProcessCoverage, processTypeLabel, PROCESS_TYPE_LABELS, type ProcessEntryRef } from '../processCoverageService';

const P = (processType: string, qty: number, over: Partial<ProcessEntryRef> = {}): ProcessEntryRef =>
  ({ processType, plannedQuantity: qty, unit: 'PC', source: 'plan', ...over });
const O = (processType: string, qty: number, over: Partial<ProcessEntryRef> = {}): ProcessEntryRef =>
  ({ processType, plannedQuantity: qty, unit: 'PC', source: 'outsourcing', ...over });

describe('summarizeProcessCoverage（按工序类型合计）', () => {
  it('★ ① 多工序各排「全量」→ **全部 ok**（不是超产）—— 本判据的核心', () => {
    const r = summarizeProcessCoverage({
      orderQuantity: 1000,
      entries: [P('Cutting', 1000), P('Sewing', 1000), P('Packing', 1000)],
    });
    expect(r.processes).toHaveLength(3);
    // ★ 必须断言**具体数量**：我第一版只断言「3 组、无超产」，结果 `num()` 不认 Prisma Decimal
    //   （对象 ⇒ Number.isFinite=false ⇒ 全丢成 0）时，这条例用**照样绿**（0 当然不超产）——
    //   典型的「空过的验证器」，靠真库演练 ② 才抓出来。断言数量后它再也空不过去。
    expect(r.processes.map(p => p.plannedTotal).sort()).toEqual([1000, 1000, 1000]);
    expect(r.overProcessTypes).toEqual([]);
    expect(r.processes.every(p => p.verdict === 'ok')).toBe(true);
  });

  it('①b ★ Decimal 对象入参必须算得准（不是只认 number/字符串）', () => {
    const decimalLike = { toString: () => '1000' } as any;
    const r = summarizeProcessCoverage({ orderQuantity: decimalLike, entries: [P('Sewing', decimalLike)] });
    expect(r.processes[0].plannedTotal).toBe(1000);
    expect(r.processes[0].share).toBe(1);
    expect(r.overProcessTypes).toEqual([]);
  });

  it('★ ② 同一工序跨工位合计超订单 → over（裁剪两个工位各 1000 = 2000）', () => {
    const r = summarizeProcessCoverage({
      orderQuantity: 1000,
      entries: [P('Cutting', 1000, { label: 'WS-1' }), P('Cutting', 1000, { label: 'WS-2' })],
    });
    expect(r.overProcessTypes).toEqual(['Cutting']);
    const c = r.processes[0];
    expect(c.plannedTotal).toBe(2000);
    expect(c.overBy).toBe(1000);
    expect(c.share).toBe(2);
  });

  it('③ 同一工序拆两批（各 500）= 合计 1000 → ok（分批是正常业务）', () => {
    const r = summarizeProcessCoverage({
      orderQuantity: 1000,
      entries: [P('Sewing', 500), P('Sewing', 500)],
    });
    expect(r.overProcessTypes).toEqual([]);
    expect(r.processes[0].plannedTotal).toBe(1000);
  });

  it('④ 排产 + 外协**同一工序**合并计算（不同厂各 600 → 超产）', () => {
    const r = summarizeProcessCoverage({
      orderQuantity: 1000,
      entries: [P('Sewing', 600), O('Sewing', 600, { label: 'SUP-1' })],
    });
    expect(r.processes).toHaveLength(1);
    expect(r.processes[0].plannedTotal).toBe(1200);
    expect(r.overProcessTypes).toEqual(['Sewing']);
  });

  it('⑤ 容差：+3% 备品时 1030 不超、1040 超', () => {
    const ok = summarizeProcessCoverage({ orderQuantity: 1000, entries: [P('Sewing', 1030)], tolerancePercent: 3 });
    expect(ok.overProcessTypes).toEqual([]);
    const over = summarizeProcessCoverage({ orderQuantity: 1000, entries: [P('Sewing', 1040)], tolerancePercent: 3 });
    expect(over.overProcessTypes).toEqual(['Sewing']);
    expect(over.processes[0].overBy).toBe(10);
  });

  it('⑥ 欠产**不判错**：只报 share（覆盖度），不把少排当异常', () => {
    const r = summarizeProcessCoverage({ orderQuantity: 1000, entries: [P('Sewing', 200)] });
    expect(r.processes[0].verdict).toBe('ok');
    expect(r.processes[0].share).toBe(0.2); // 界面据此提示「只排了 20%」
  });

  it('⑦ ★ 单位不一致 → 不判定（跨单位相加是错的），显式标 unknown', () => {
    const r = summarizeProcessCoverage({
      orderQuantity: 1000,
      entries: [P('Sewing', 500, { unit: 'PC' }), P('Sewing', 300, { unit: 'SET' })],
    });
    expect(r.processes[0].verdict).toBe('unknown');
    expect(r.unknownProcessTypes).toEqual(['Sewing']);
    expect(r.processes[0].unit).toBeNull();
  });

  it('⑧ 订单数量无效 → judged=false，只汇总不判定（不猜）', () => {
    for (const q of [null, 0, -1, Number.NaN]) {
      const r = summarizeProcessCoverage({ orderQuantity: q as any, entries: [P('Sewing', 99999)] });
      expect(r.judged).toBe(false);
      expect(r.overProcessTypes).toEqual([]);
      expect(r.processes[0].share).toBeNull();
    }
  });

  it('⑨ 空工序类型归入 Other（不丢行）', () => {
    const r = summarizeProcessCoverage({ orderQuantity: 1000, entries: [P('', 500), P('   ', 500)] });
    expect(r.processes).toHaveLength(1);
    expect(r.processes[0].processType).toBe('Other');
    expect(r.processes[0].plannedTotal).toBe(1000);
  });

  it('⑩ 非数/负数量被跳过（脏数据不制造超产）', () => {
    const r = summarizeProcessCoverage({
      orderQuantity: 1000,
      entries: [P('Sewing', 500), P('Sewing', Number.NaN as any), P('Sewing', -100)],
    });
    expect(r.processes[0].plannedTotal).toBe(500);
  });

  it('⑪ 排序：超产的排前面（业务员先看要处理的）', () => {
    const r = summarizeProcessCoverage({
      orderQuantity: 1000,
      entries: [P('Packing', 300), P('Sewing', 3000), P('Cutting', 1000)],
    });
    expect(r.processes[0].processType).toBe('Sewing');
    expect(r.processes[0].verdict).toBe('over');
  });
});

describe('processTypeLabel（工序中文标签）', () => {
  it('已知工序给中文；未知原样返回（不猜）', () => {
    expect(processTypeLabel('Sewing')).toBe('缝制');
    expect(processTypeLabel('Cutting')).toBe('裁剪');
    expect(processTypeLabel('Weird')).toBe('Weird');
  });

  it('标签表覆盖 schema 注释列出的全部工序取值', () => {
    for (const k of ['Sewing', 'Cutting', 'Printing', 'Embroidery', 'Packing', 'QC', 'Washing', 'Dyeing', 'Other']) {
      expect(Object.keys(PROCESS_TYPE_LABELS), `缺 ${k}`).toContain(k);
    }
  });
});
