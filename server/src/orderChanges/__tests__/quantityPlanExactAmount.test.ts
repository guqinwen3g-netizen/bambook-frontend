import {describe,it,expect} from 'vitest';
import {exactQuantityUnitPriceAmount,sumExactPlanAmounts,validateProposedQuantityPlanMoney} from '../orderLineQuantityPlan';
describe('quantity plan exact local monetary arithmetic',()=>{
 it('rejects actual 22-digit product that default Decimal precision rounded into 18,4',()=>expect(()=>exactQuantityUnitPriceAmount('10000000000000.0001','1.0001')).toThrow('超过四位小数'));
 it('keeps legal maximum model amount digits',()=>expect(exactQuantityUnitPriceAmount('99999999999999.9999','1')).toBe('99999999999999.9999'));
 it('keeps four-place product without cent rounding',()=>expect(exactQuantityUnitPriceAmount('2','1.2345')).toBe('2.469'));
 it('supports legitimate high magnitude exact product',()=>expect(exactQuantityUnitPriceAmount('10000000000000','1.0001')).toBe('10001000000000'));
 it('preserves decimal 0.0003 and exact zero-price amount',()=>{expect(exactQuantityUnitPriceAmount('0.0003','1')).toBe('0.0003');expect(exactQuantityUnitPriceAmount('2','0')).toBe('0');});
 it('sums exactly at the 18,4 boundary',()=>expect(sumExactPlanAmounts(['99999999999999.9998','0.0001'])).toBe('99999999999999.9999'));
 it('rejects aggregate overflow instead of creating an impossible MOQ request',()=>expect(()=>validateProposedQuantityPlanMoney({plan:{version:2,orderId:'o',expectedUpdatedAt:'1',lines:[{lineId:'a',beforeQuantity:'1',unit:'M',afterQuantity:'2',afterNetValue:'99999999999999.9999'},{lineId:'b',beforeQuantity:'1',unit:'M',afterQuantity:'2',afterNetValue:'1'}]},actual:[{id:'a'},{id:'b'}]})).toThrow('金额必须'));
});
