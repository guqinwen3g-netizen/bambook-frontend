import { describe, expect, it } from 'vitest';
import { compareMoqQuantity } from '../moqQuantityBasis';
describe('MOQ exact unit basis', () => {
  it.each([
    ['800','M','800','M',true],['99999999999999.9999','YD','91439999999999.9999','M',true],['99999999999999.9998','YD','91439999999999.9999','M',false],['99999999999999.9999','YD','91440000000000','M',false],['800','YD','800','M',false],
    ['1000','YD','914.4','M',true],['914.4','M','1000','YD',true],
    ['914.3999','M','1000','YD',false],['0.0003','M','0.0002','M',true],
    ['200','PCS','200','PC',true],['2','SET','2','SET',true],
    ['1','KG','2','KG',false],
  ])('compares %s %s to %s %s precisely', (q,u,m,mu,compliant) => {
    expect(compareMoqQuantity(q,u,m,mu)).toMatchObject({resolved:true,compliant});
  });
  it.each([
    ['200','SET','200','PC'],['800',null,'800','M'],['800','BOX','800','M'],
    ['800','KG','800','M'],['800','M','800',null],['0','M','800','M'],
    [{toString:()=> '800'},'M','800','M'],['NaN','M','800','M'],
  ])('does not invent unresolved unit or quantity basis', (q,u,m,mu) => {
    expect(compareMoqQuantity(q,u,m,mu)).toMatchObject({resolved:false});
  });
});
