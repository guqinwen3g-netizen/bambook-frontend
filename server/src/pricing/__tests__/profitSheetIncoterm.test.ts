/**
 * profitSheetIncoterm.test.ts — D2-Q4 贸易术语归一（CIF/CFR 垫付运费改开应收，不计成本）
 *
 * 覆盖：四档归一（FOB/CIF/CFR/OTHER）+ 不自造阈值（空/无法识别/其它术语一律 OTHER）。
 * ★ 存量保护：现状 69 单全是 "FOB Shanghai" ⇒ 归一为 FOB ⇒ 运费仍计入成本，毛利零变化。
 */
import { describe, it, expect } from 'vitest';
import { normalizeIncoterm } from '../profitSheetService';

describe('normalizeIncoterm 贸易术语归一（D2-Q4 判据）', () => {
  it('带港口/空格的文本取首段：FOB Shanghai → FOB', () => {
    expect(normalizeIncoterm('FOB Shanghai')).toBe('FOB');
    expect(normalizeIncoterm('CIF Montreal')).toBe('CIF');
    expect(normalizeIncoterm('  cif   montreal  ')).toBe('CIF');
  });

  it('CFR 与同义写法（CNF / C&F）归为 CFR（随 CIF 口径）', () => {
    expect(normalizeIncoterm('CFR Hamburg')).toBe('CFR');
    expect(normalizeIncoterm('CNF Hamburg')).toBe('CFR');
    expect(normalizeIncoterm('C&F Hamburg')).toBe('CFR');
  });

  it('★ 不自造阈值：空 / 无法识别 / 其它术语（EXW·DDP…）一律 OTHER（保持既有行为）', () => {
    expect(normalizeIncoterm(null)).toBe('OTHER');
    expect(normalizeIncoterm('')).toBe('OTHER');
    expect(normalizeIncoterm('   ')).toBe('OTHER');
    expect(normalizeIncoterm('EXW Shanghai')).toBe('OTHER');
    expect(normalizeIncoterm('DDP Montreal')).toBe('OTHER');
    expect(normalizeIncoterm('到岸价')).toBe('OTHER');
  });

  it('★ 存量保护：现有 69 单的 "FOB Shanghai" 归 FOB ⇒ 运费仍计入成本，毛利不变', () => {
    expect(normalizeIncoterm('FOB Shanghai')).toBe('FOB');
    // CIF/CFR 才触发"不计成本"
    const rebillable = (t: string) => ['CIF', 'CFR'].includes(normalizeIncoterm(t));
    expect(rebillable('FOB Shanghai')).toBe(false);
    expect(rebillable('CIF Montreal')).toBe(true);
  });
});
