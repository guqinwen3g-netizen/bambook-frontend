import { describe, expect, it } from 'vitest';
import { normalizeOrderQuantityUnit, OrderQuantityError, parseOrderQuantity, summarizeOrderQuantity } from '../orderQuantitySummary';
const lines = (...entries: [unknown, unknown][]) => entries.map(([quantity, unit]) => ({ quantity, unit }));
describe('exact order quantity parser', () => {
  it.each([['0001000.2500','1000.25'],['0.0001','0.0001'],['99999999999999.9999','99999999999999.9999'],[1000.25,'1000.25'],[1,'1'],[0.1,'0.1']])('canonicalizes %s', (value, expected) => expect(parseOrderQuantity(value)).toBe(expected));
  it.each([null,undefined,true,false,[],{}, {toString:()=> '1'}, '', ' ', '1e3', '1e-4', '-1', '+1','.5','1.','1.00001',NaN,Infinity,-Infinity,0,'0','000.0000',0.1+0.2,99999999999999.99])('rejects invalid/unsafe %s', value => expect(()=>parseOrderQuantity(value)).toThrow(OrderQuantityError));
  it('allows zero only at explicit summary boundaries', () => {expect(parseOrderQuantity('000.0000',{allowZero:true})).toBe('0');expect(parseOrderQuantity(0,{allowZero:true})).toBe('0');expect(()=>parseOrderQuantity(null,{allowZero:true})).toThrow();});
  it('does not repair binary scaling error',()=>{expect(()=>parseOrderQuantity(0.0003)).toThrow('十进制字符串');expect(parseOrderQuantity('0.0003')).toBe('0.0003');});
  it.each(['100000000000000','99999999999999.99990'])('rejects overflow or scale %s', value=>expect(()=>parseOrderQuantity(value)).toThrow(OrderQuantityError));
});
describe('independent physical units',()=>{
 it.each([['Meter','M'],['米','M'],['yards','YD'],['码','YD'],['KG','KG'],['g','G'],['Pcs','PC'],['Set','SET'],['Roll','ROLL'],['Dozen','DOZEN']])('normalizes alias %s', (raw, unit)=>expect(normalizeOrderQuantityUnit(raw)).toBe(unit));
 it.each([null,undefined,true,1,{},'', 'Other','unknown','gsm','constructor','__proto__','toString'])('does not guess %s',raw=>expect(normalizeOrderQuantityUnit(raw)).toBeNull());
 it('does not collapse count or weight units',()=>{const r=summarizeOrderQuantity({activeOrderLines:lines(['1','PC'],['1','Set'],['1','Dozen'],['1','Roll'],['1','KG'],['1','G'])});expect(r.state).toBe('mixed_units');expect(r.groups).toHaveLength(6);expect(r.quantity).toBeNull();});
});
describe('actual line summary',()=>{
 it('preserves reproduced decimal 1000.25 M despite old head 1000',()=>expect(summarizeOrderQuantity({activeOrderLines:lines(['1000.25','M']),legacyQuantity:1000})).toMatchObject({state:'single_unit',quantity:'1000.25',unit:'M',markedPartial:false,legacyQuantity:null}));
 it('keeps mixed M/YD same order without fake 2000 head',()=>expect(summarizeOrderQuantity({activeOrderLines:lines(['1000','M'],['1000','YD']),legacyQuantity:2000})).toEqual({version:1,state:'mixed_units',quantity:null,unit:null,groups:[{unit:'M',quantity:'1000'},{unit:'YD',quantity:'1000'}],markedPartial:false,legacyQuantity:null}));
 it('adds exact decimals, aliases and zero',()=>expect(summarizeOrderQuantity({activeOrderLines:lines(['0.1','M'],['0.2','Meter'],['0.0000','米'],['0.2501','M'])}).quantity).toBe('0.5501'));
 it('keeps partial known groups without a whole total',()=>expect(summarizeOrderQuantity({activeOrderLines:lines(['20','M'],['30',null])})).toMatchObject({state:'unresolved',quantity:null,unit:null,groups:[{unit:'M',quantity:'20'}],markedPartial:true}));
 it('does not guess Other or empty unit',()=>expect(summarizeOrderQuantity({activeOrderLines:lines(['2','Other'],['3',''])})).toMatchObject({state:'unresolved',groups:[],markedPartial:true}));
 it('validates quantity even in unknown-unit lines',()=>expect(()=>summarizeOrderQuantity({activeOrderLines:lines([null,'Other'])})).toThrow());
 it('rejects summed overflow while preserving original facts',()=>{const source=lines(['99999999999999.9999','M'],['0.0001','M']);const before=JSON.stringify(source);expect(()=>summarizeOrderQuantity({activeOrderLines:source})).toThrow('Decimal(18,4)');expect(JSON.stringify(source)).toBe(before);});
 it('does not sum independent groups for overflow',()=>expect(summarizeOrderQuantity({activeOrderLines:lines(['99999999999999.9999','M'],['99999999999999.9999','YD'])}).state).toBe('mixed_units'));
 it('legacy unrecorded unit keeps display-only number',()=>expect(summarizeOrderQuantity({activeOrderLines:[],legacyQuantity:'1000.25',legacyUnit:null})).toEqual({version:1,state:'legacy_unit_unrecorded',quantity:null,unit:null,groups:[],markedPartial:true,legacyQuantity:'1000.25'}));
 it('known recorded legacy unit yields summary',()=>expect(summarizeOrderQuantity({activeOrderLines:[],legacyQuantity:'0',legacyUnit:'Pcs'})).toMatchObject({state:'single_unit',quantity:'0',unit:'PC'}));
 it('missing history never becomes zero',()=>expect(summarizeOrderQuantity({activeOrderLines:[],legacyQuantity:null,legacyUnit:'M'})).toMatchObject({state:'unresolved',quantity:null,markedPartial:true}));
 it('actual lines ignore stale malformed legacy header',()=>expect(summarizeOrderQuantity({activeOrderLines:lines(['1.25','M']),legacyQuantity:true,legacyUnit:'YD'}).quantity).toBe('1.25'));
 it('ignores money and preserves lines',()=>{const source=[{quantity:'1000',unit:'M',amount:'99999999999999.9999'},{quantity:'1000',unit:'YD',amount:'0.0001'}];const before=JSON.stringify(source);expect(summarizeOrderQuantity({activeOrderLines:source}).state).toBe('mixed_units');expect(JSON.stringify(source)).toBe(before);});
 it('accepts exact Decimal boundary without a float intermediary',()=>expect(summarizeOrderQuantity({activeOrderLines:lines(['99999999999999.9998','M'],['0.0001','M'])}).quantity).toBe('99999999999999.9999'));
 it('freezes independent returned summaries without modifying input',()=>{const source=lines(['1','M']);const r=summarizeOrderQuantity({activeOrderLines:source});expect(Object.isFrozen(r)).toBe(true);expect(Object.isFrozen(r.groups)).toBe(true);expect(Object.isFrozen(r.groups[0])).toBe(true);expect(Object.isFrozen(source)).toBe(false);});
 it('is independent of line ordering',()=>{const source=lines(['1.0001','YD'],['2','M'],['0.0001','YD']);expect(summarizeOrderQuantity({activeOrderLines:source})).toEqual(summarizeOrderQuantity({activeOrderLines:[...source].reverse()}));});
});
