import {it,expect} from 'vitest';
import {meterScaled,meterRemaining} from './sampleMeterQuantity';
it('compares Decimal(18,4) at maximum size without floating point rounding',()=>{
 expect(meterScaled('99999999999999.9999')).toBe(999999999999999999n);
 expect(meterRemaining('99999999999999.9999','99999999999999.9998')).toBe('0.0001');
 expect(meterRemaining('1.25','0.1')).toBe('1.15');
 for(const invalid of ['1e3','0.00001','-1','100000000000000'])expect(meterScaled(invalid)).toBeNull();
});
