import { expect, it } from 'vitest';
import { cartonVolume, GSM_PER_OZ_YD2 } from './BusinessCalculators';
it('computes carton CBM, gross weight and air chargeable weight', () => {
  const v = cartonVolume(60, 40, 50, 10, 12.5);
  expect(v.cartonCbm).toBeCloseTo(0.12, 10); expect(v.totalCbm).toBeCloseTo(1.2, 10); expect(v.totalGross).toBe(125); expect(v.airChargeableKg).toBeCloseTo(200, 10);
  expect(cartonVolume(60, 40, 50, 1, null).totalGross).toBeNull();
});
it('uses the exact ounce and square-yard definitions for fabric weight', () => { expect(GSM_PER_OZ_YD2).toBeCloseTo(33.9057, 4); });
