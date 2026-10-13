/**
 * unitConversion.test.ts — 克重归一化换算（gsm/oz/yd²/g/yd² → g/m² 单一真源）
 *
 * 覆盖：
 *   ① weightToGsm：gsm 系原样 / oz/yd² ×33.9057 / g/yd² ×1.196（round1）
 *   ② normalizeWeightUnit：大小写与别名归一
 *   ③ fail-closed：非法数值 / 无法识别单位返回 null
 */
import { describe, expect, it } from 'vitest';
import { normalizeWeightUnit, weightToGsm } from '../unitConversion';

describe('normalizeWeightUnit', () => {
  it('归一 gsm 系别名（大小写/符号变体）', () => {
    for (const raw of ['gsm', 'GSM', 'g/m2', 'g/m²', 'g/㎡', 'g/m', 'g/sqm', 'Grams']) {
      expect(normalizeWeightUnit(raw)).toBe('gsm');
    }
  });
  it('归一 oz/yd² 系别名', () => {
    for (const raw of ['oz/yd²', 'oz/yd2', 'ozyd', 'oz/sqyd', 'oz', 'OZ/YD2']) {
      expect(normalizeWeightUnit(raw)).toBe('oz/yd2');
    }
  });
  it('空值/无法识别返回 null', () => {
    expect(normalizeWeightUnit(null)).toBeNull();
    expect(normalizeWeightUnit(undefined)).toBeNull();
    expect(normalizeWeightUnit('')).toBeNull();
    expect(normalizeWeightUnit('kg')).toBeNull();
  });
});

describe('weightToGsm', () => {
  it('gsm 系原样（round1）', () => {
    expect(weightToGsm(180, 'gsm')).toBe(180);
    expect(weightToGsm(240.55, 'g/m²')).toBe(240.6);
  });
  it('oz/yd² → g/m² ×33.9057', () => {
    expect(weightToGsm(12, 'oz/yd²')).toBe(406.9); // 12 × 33.9057 = 406.8684
    expect(weightToGsm(8, 'oz/yd2')).toBe(271.2); // 8 × 33.9057 = 271.2456
  });
  it('g/yd² → g/m² ×1.196', () => {
    expect(weightToGsm(100, 'g/yd²')).toBe(119.6);
  });
  it('fail-closed：非法数值/无法识别单位返回 null', () => {
    expect(weightToGsm(180, 'kg')).toBeNull();
    expect(weightToGsm(-1, 'gsm')).toBeNull();
    expect(weightToGsm(NaN, 'gsm')).toBeNull();
    expect(weightToGsm(180, null)).toBeNull();
    expect(weightToGsm(180, undefined)).toBeNull();
  });
});
