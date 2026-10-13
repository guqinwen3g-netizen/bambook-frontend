/**
 * REQ2-22 面料计算器单测（设计文档 §6，DR-062）
 *
 * 覆盖：
 *   ① 克重换算：gsm↔ozyd 双向闭环 + 门幅派生（每米重量/公斤米数/磅码数）
 *   ② 纱支换算：Ne/D/Nm/tex 四制互转 + 非法制式拒绝
 *   ③ 理论克重：40×40/133×72 府绸 ≈119 g/m² 行业实证 + 根/10cm 与 D 输入归一 + 织缩系数
 *   ④ 门幅与用料：可裁门幅/每米重量/单件与千件用量/排料利用率
 *   ⑤ 卷装匹长：卷重→匹长 / 匹长→卷重 双向 + 码/磅换算 + 二选一约束
 *   ⑥ 装柜计算：体积/重量双约束取小 + 匹长联动总米数 + 柜型规格
 *   ⑦ 校验 fail-closed：非法 kind / 缺必填 / 负值 / 零值
 */
import { describe, expect, it } from 'vitest';
import {
  calculateFabric, FabricCalcValidationError,
  calcWeightConvert, calcYarnConvert, calcTheoreticalWeight, calcWidthUsage, calcRollLength, calcContainerLoading,
  CONTAINER_SPECS,
} from '../fabricCalculatorService';

const expectInvalid = (fn: () => unknown, msgPart?: string) => {
  try {
    fn();
    expect.unreachable('应抛 FabricCalcValidationError');
  } catch (e: any) {
    expect(e).toBeInstanceOf(FabricCalcValidationError);
    expect(e.code).toBe('VALIDATION_FAILED');
    if (msgPart) expect(e.message).toContain(msgPart);
  }
};

describe('① 克重换算 weight-convert', () => {
  it('gsm → ozyd 双向闭环（×/÷33.906）', () => {
    const r = calcWeightConvert({ gsm: 200 });
    expect(r.ozyd).toBeCloseTo(200 / 33.9057, 1);
    const back = calcWeightConvert({ ozyd: r.ozyd });
    expect(back.gsm).toBe(200);
  });

  it('gsm + 门幅 → 每米重量/公斤米数/磅码数', () => {
    const r = calcWeightConvert({ gsm: 180, widthCm: 150 });
    // 每米 = 180 × 1.5 = 270 g/m；公斤米数 = 1000/270 ≈ 3.70；磅码数 = 453.592/(270×0.9144) ≈ 1.84
    expect(r.gPerM).toBe(270);
    expect(r.mPerKg).toBeCloseTo(3.7, 1);
    expect(r.ydPerLb).toBeCloseTo(1.84, 1);
  });

  it('gsm 与 ozyd 均缺 → 校验失败', () => {
    expectInvalid(() => calcWeightConvert({}), '至少提供一项');
  });
});

describe('② 纱支换算 yarn-convert', () => {
  it('Ne=40 → D=14.76（590.5/40）→ Nm=67.75 → tex=1.64', () => {
    const r = calcYarnConvert({ value: 40, from: 'Ne' });
    expect(r.results.D).toBeCloseTo(14.76, 1);
    expect(r.results.Nm).toBeCloseTo(67.75, 1); // 1000/14.7625
    expect(r.results.tex).toBeCloseTo(1.64, 1); // 14.7625/9
  });

  it('D=150 → Ne≈3.94 → Nm≈6.67', () => {
    const r = calcYarnConvert({ value: 150, from: 'D' });
    expect(r.results.Ne).toBeCloseTo(590.5 / 150, 1);
    expect(r.results.Nm).toBeCloseTo(1000 / 150, 1);
  });

  it('tex=20 → D=180 → Ne≈3.28', () => {
    const r = calcYarnConvert({ value: 20, from: 'tex' });
    expect(r.results.D).toBe(180);
    expect(r.results.Ne).toBeCloseTo(590.5 / 180, 1);
  });

  it('非法制式/非正值 → 校验失败', () => {
    expectInvalid(() => calcYarnConvert({ value: 40, from: 'XX' as any }), 'from');
    expectInvalid(() => calcYarnConvert({ value: -1, from: 'Ne' }), '不得小于');
    expectInvalid(() => calcYarnConvert({ value: 0, from: 'Ne' }), '正数');
  });
});

describe('③ 理论克重 theoretical-weight', () => {
  it('行业实证：40×40 / 133×72 全棉府绸 ≈ 119 g/m²（3.51 oz/yd²）', () => {
    const r = calcTheoreticalWeight({
      warpDensity: 133, weftDensity: 72, warpYarn: 40, weftYarn: 40, densityUnit: 'per-in', yarnUnit: 'Ne',
    });
    expect(r.theoreticalOzyd).toBeCloseTo(3.51, 1);
    expect(r.theoreticalGsm).toBeCloseTo(119.2, 0); // 119-125 行业区间
  });

  it('根/10cm 输入归一（523 根/10cm ≡ 133 根/in）', () => {
    const perIn = calcTheoreticalWeight({ warpDensity: 133, weftDensity: 72, warpYarn: 40, weftYarn: 40 });
    const per10cm = calcTheoreticalWeight({ warpDensity: 523, weftDensity: 284, warpYarn: 40, weftYarn: 40, densityUnit: 'per-10cm' });
    expect(per10cm.theoreticalGsm).toBeCloseTo(perIn.theoreticalGsm, 0);
  });

  it('旦尼尔纱支输入归一（D=14.76 ≡ Ne=40）+ 织缩系数 1.05', () => {
    const byNe = calcTheoreticalWeight({ warpDensity: 133, weftDensity: 72, warpYarn: 40, weftYarn: 40 });
    const byD = calcTheoreticalWeight({ warpDensity: 133, weftDensity: 72, warpYarn: 14.76, weftYarn: 14.76, yarnUnit: 'D' });
    expect(byD.theoreticalGsm).toBeCloseTo(byNe.theoreticalGsm, 0);
    const shrunk = calcTheoreticalWeight({ warpDensity: 133, weftDensity: 72, warpYarn: 40, weftYarn: 40, shrinkFactor: 1.05 });
    expect(shrunk.theoreticalGsm).toBeCloseTo(byNe.theoreticalGsm * 1.05, 0);
  });
});

describe('④ 门幅与用料 width-usage', () => {
  it('可裁门幅/每米重量/公斤米数/单件与千件用量', () => {
    const r = calcWidthUsage({ widthCm: 150, gsm: 180, lengthPerPieceM: 1.65 });
    expect(r.usableWidthCm).toBe(147); // 默认边损 3
    expect(r.gPerM).toBe(270);
    expect(r.mPerKg).toBeCloseTo(3.7, 1);
    expect(r.pieceWeightKg).toBeCloseTo(0.4455, 2); // 270×1.65/1000
    expect(r.perThousandKg).toBeCloseTo(445.5, 0);
    expect(r.perThousandM).toBe(1650);
    expect(r.utilizationPct).toBeNull();
  });

  it('提供净裁片面积 → 排料利用率', () => {
    const r = calcWidthUsage({ widthCm: 150, gsm: 180, lengthPerPieceM: 1.65, pieceAreaM2: 1.8 });
    // 1.8 / (1.47 × 1.65) ≈ 74.2%
    expect(r.utilizationPct).toBeCloseTo(74.2, 0);
  });

  it('零/负值 → 校验失败', () => {
    expectInvalid(() => calcWidthUsage({ widthCm: 0, gsm: 180, lengthPerPieceM: 1 }), '正数');
    expectInvalid(() => calcWidthUsage({ widthCm: 150, gsm: -5, lengthPerPieceM: 1 }), '不得小于');
  });
});

describe('⑤ 卷装匹长 roll-length', () => {
  it('by-weight：卷重 30kg / 180gsm / 150cm → 匹长 ≈ 111.11m', () => {
    const r = calcRollLength({ gsm: 180, widthCm: 150, rollWeightKg: 30 });
    expect(r.mode).toBe('by-weight');
    expect(r.lengthM).toBeCloseTo(111.11, 1); // 30×1000/270
    expect(r.lengthYd).toBeCloseTo(111.11 / 0.9144, 1);
    expect(r.rollWeightLb).toBeCloseTo(66.14, 1); // 30×2.20462
  });

  it('by-length：匹长 100m / 180gsm / 150cm → 卷重 27kg（与 by-weight 闭环）', () => {
    const r = calcRollLength({ gsm: 180, widthCm: 150, lengthM: 100 });
    expect(r.mode).toBe('by-length');
    expect(r.rollWeightKg).toBe(27);
    expect(r.gPerM).toBe(270);
  });

  it('两项都给或都不给 → 校验失败（二选一）', () => {
    expectInvalid(() => calcRollLength({ gsm: 180, widthCm: 150, rollWeightKg: 30, lengthM: 100 }), '二选一');
    expectInvalid(() => calcRollLength({ gsm: 180, widthCm: 150 }), '二选一');
  });
});

describe('⑥ 装柜计算 container-loading', () => {
  it('20GP：卷径 60cm/卷宽 152cm/卷重 25kg → 体积与重量双约束取小', () => {
    const r = calcContainerLoading({ containerType: '20GP', rollDiameterCm: 60, rollWidthCm: 152, rollWeightKg: 25 });
    // 卷体积 = π/4 × 0.6² × 1.52 ≈ 0.4299 m³
    expect(r.rollVolumeM3).toBeCloseTo(0.43, 2);
    // 按体积 = floor(28×0.9/0.4299) = floor(58.6) = 58；按重量 = floor(21700/25) = 868
    expect(r.byVolume).toBe(58);
    expect(r.byWeight).toBe(868);
    expect(r.recommendedRolls).toBe(58);
    expect(r.bindingConstraint).toBe('volume');
    expect(r.totalWeightKg).toBe(1450);
  });

  it('提供 gsm+widthCm → 匹长联动总米数', () => {
    const r = calcContainerLoading({
      containerType: '40HQ', rollDiameterCm: 60, rollWidthCm: 152, rollWeightKg: 25, gsm: 180, widthCm: 150,
    });
    // 40HQ 按体积 = floor(68×0.9/0.4299) = floor(142.3) = 142
    expect(r.recommendedRolls).toBe(142);
    expect(r.rollLengthM).toBeCloseTo(25 * 1000 / 270, 1); // ≈92.59
    expect(r.totalLengthM).toBeCloseTo(142 * 92.59, 0); // ≈13148
    expect(r.container.code).toBe('40HQ');
    expect(r.container.payloadKg).toBe(CONTAINER_SPECS['40HQ'].payloadKg);
  });

  it('重量约束场景：重卷（500kg/卷）→ 按重量取小', () => {
    const r = calcContainerLoading({ containerType: '20GP', rollDiameterCm: 120, rollWidthCm: 152, rollWeightKg: 500 });
    // 体积 = π/4×1.2²×1.52 ≈ 1.7197 → 按体积 = floor(28×0.9/1.7197) = 14；按重量 = floor(21700/500) = 43
    expect(r.byVolume).toBe(14);
    expect(r.byWeight).toBe(43);
    expect(r.bindingConstraint).toBe('volume');
    // 更极端：卷重 2000kg → 按重量 floor(21700/2000)=10 < 按体积 14
    const heavy = calcContainerLoading({ containerType: '20GP', rollDiameterCm: 120, rollWidthCm: 152, rollWeightKg: 2000 });
    expect(heavy.bindingConstraint).toBe('weight');
    expect(heavy.recommendedRolls).toBe(10);
  });

  it('gsm 与 widthCm 只给一项 → 校验失败；非法柜型拒绝', () => {
    expectInvalid(() => calcContainerLoading({ containerType: '20GP', rollDiameterCm: 60, rollWidthCm: 152, rollWeightKg: 25, gsm: 180 } as any), '同时提供');
    expectInvalid(() => calcContainerLoading({ containerType: '45GP' as any, rollDiameterCm: 60, rollWidthCm: 152, rollWeightKg: 25 }), 'containerType');
  });
});

describe('⑦ kind 判别总入口 calculateFabric', () => {
  it('六类 kind 正常分发', () => {
    expect(calculateFabric('weight-convert', { gsm: 200 }).ozyd).toBeCloseTo(5.9, 1);
    expect(calculateFabric('yarn-convert', { value: 40, from: 'Ne' }).results.D).toBeCloseTo(14.76, 1);
    expect(calculateFabric('theoretical-weight', { warpDensity: 133, weftDensity: 72, warpYarn: 40, weftYarn: 40 }).theoreticalGsm).toBeGreaterThan(115);
    expect(calculateFabric('width-usage', { widthCm: 150, gsm: 180, lengthPerPieceM: 1.65 }).gPerM).toBe(270);
    expect(calculateFabric('roll-length', { gsm: 180, widthCm: 150, rollWeightKg: 30 }).lengthM).toBeCloseTo(111.11, 1);
    expect(calculateFabric('container-loading', { containerType: '20GP', rollDiameterCm: 60, rollWidthCm: 152, rollWeightKg: 25 }).recommendedRolls).toBe(58);
  });

  it('非法 kind / 缺 input → 校验失败', () => {
    expectInvalid(() => calculateFabric('bogus', {}), 'kind 须为');
    expectInvalid(() => calculateFabric('weight-convert', {} as any), '至少提供一项');
  });
});
