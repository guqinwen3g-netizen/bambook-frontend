/**
 * shipmentFieldRules.test.ts — D1「运输方式驱动必填字段」纯函数
 *
 * 覆盖：Sea/Air/Courier/Land·Rail 四组规则 + 装载方式正交（FCL 才要箱号封条，LCL 不要）
 * + 不自造规则（方式无法识别 ⇒ 不校验）+ 归一。
 */
import { describe, it, expect } from 'vitest';
import { missingRequiredShipmentFields, normalizeShipMethod, normalizeLoadType } from '../shipmentFieldRules';

const BASE = {
  vesselOrFlight: 'EVER GIVEN', voyageNumber: 'V.123', containerNumber: 'MSKU1', sealNumber: 'SL1',
  trackingNumber: 'TRK1', carrierName: '某承运', portOfLoading: 'Shanghai', portOfDischarge: 'Montreal', vehicleNo: '沪A1',
};

describe('missingRequiredShipmentFields（D1 运输方式驱动必填）', () => {
  it('Sea 全填 ⇒ 无缺失', () => {
    expect(missingRequiredShipmentFields({ ...BASE, shippingMethod: 'Sea', loadType: 'FCL' })).toEqual([]);
  });

  it('★ Sea 缺船名航次 ⇒ 报缺（含起运/目的港）', () => {
    const miss = missingRequiredShipmentFields({ ...BASE, shippingMethod: 'Sea', loadType: 'FCL', vesselOrFlight: null, voyageNumber: '' });
    expect(miss).toContain('船名/航次(vesselOrFlight)');
    expect(miss).toContain('航次号(voyageNumber)');
  });

  it('★ 装载方式正交：FCL 要箱号封条，LCL 不要', () => {
    const noBox = { ...BASE, shippingMethod: 'Sea', containerNumber: null, sealNumber: null };
    expect(missingRequiredShipmentFields({ ...noBox, loadType: 'FCL' })).toEqual(
      expect.arrayContaining(['集装箱号(containerNumber)', '封条号(sealNumber)']),
    );
    // 拼柜：箱号/封条由柜聚合体承载 ⇒ 单票不强制
    expect(missingRequiredShipmentFields({ ...noBox, loadType: 'LCL' })).toEqual([]);
  });

  it('★ Air 要航班号，且明确**不**要集装箱号/封条号', () => {
    const miss = missingRequiredShipmentFields({ ...BASE, shippingMethod: 'Air', vesselOrFlight: null, containerNumber: null, sealNumber: null });
    expect(miss).toContain('航班号(vesselOrFlight)');
    expect(miss.join()).not.toContain('集装箱号');
    expect(miss.join()).not.toContain('封条号');
  });

  it('★ Courier 要跟踪号，且明确**不**要港口字段', () => {
    const miss = missingRequiredShipmentFields({ ...BASE, shippingMethod: 'Courier', trackingNumber: null, portOfLoading: null, portOfDischarge: null });
    expect(miss).toEqual(['快递跟踪号(trackingNumber)']);
  });

  it('Land / Rail 要承运方与车牌车号', () => {
    for (const m of ['Land', 'Rail']) {
      const miss = missingRequiredShipmentFields({ ...BASE, shippingMethod: m, carrierName: null, vehicleNo: null });
      expect(miss).toEqual(expect.arrayContaining(['承运方(carrierName)', '车牌/车号(vehicleNo)']));
    }
  });

  it('★ 不自造规则：方式无法识别 / 未录 ⇒ 不校验（返回空）', () => {
    expect(missingRequiredShipmentFields({ ...BASE, shippingMethod: '海运' })).toEqual([]);
    expect(missingRequiredShipmentFields({ ...BASE, shippingMethod: null })).toEqual([]);
  });
});

describe('归一', () => {
  it('方式：大小写/空白不敏感；识别不出返回 null', () => {
    expect(normalizeShipMethod('  sea ')).toBe('Sea');
    expect(normalizeShipMethod('AIR')).toBe('Air');
    expect(normalizeShipMethod('Sea Freight')).toBeNull();
    expect(normalizeShipMethod('')).toBeNull();
  });
  it('装载方式：FCL/LCL 归一；其余 null（未录 ⇒ 不做整柜校验）', () => {
    expect(normalizeLoadType('fcl')).toBe('FCL');
    expect(normalizeLoadType(' LCL ')).toBe('LCL');
    expect(normalizeLoadType(null)).toBeNull();
    expect(normalizeLoadType('整柜')).toBeNull();
  });
});
