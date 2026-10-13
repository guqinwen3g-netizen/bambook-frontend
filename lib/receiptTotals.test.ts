import {describe,it,expect} from 'vitest';
import {receiptTotalsByUnit} from './receiptTotals';
describe('receipt quantity display',()=>{
  it('keeps fabric metres and garment trims separate',()=>{
    expect(receiptTotalsByUnit([{id:'fabric',unit:'M'},{id:'trim',unit:'PCS'}],{fabric:{accepted:'88',rejected:'2'},trim:{accepted:'290',rejected:'10'}})).toEqual([{unit:'M',accepted:88,rejected:2},{unit:'PCS',accepted:290,rejected:10}]);
  });
  it('sums same-unit rows without floating point residue and ignores stale rows',()=>{
    expect(receiptTotalsByUnit([{id:'a',unit:'M'},{id:'b',unit:'M'}],{a:{accepted:'0.1',rejected:''},b:{accepted:'0.2',rejected:'1'},stale:{accepted:'100',rejected:'100'}})).toEqual([{unit:'M',accepted:0.3,rejected:1}]);
  });
});
