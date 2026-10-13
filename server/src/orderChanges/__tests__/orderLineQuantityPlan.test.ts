import {describe,it,expect} from 'vitest';
import {assertShippedQuantityFacts,assertInternalFabricAllocationCapacity,canonicalQuantityPlan,quantityPlanHash,quantityPlanApprovalHash,exactPlanAmount} from '../orderLineQuantityPlan';
const plan=()=>({version:1,orderId:'O',expectedUpdatedAt:'123',lines:[{lineId:'b',beforeQuantity:'1000.2500',unit:'meter',afterQuantity:'999.0001'},{lineId:'a',beforeQuantity:'1000',unit:'yd',afterQuantity:'800.5'}]});
describe('approved internal fabric capacity survives quantity amendments',()=>{
 const one=(afterQuantity='600.125')=>canonicalQuantityPlan({version:1,orderId:'FABRIC',expectedUpdatedAt:'123',lines:[{lineId:'F1',beforeQuantity:'1000',unit:'M',afterQuantity}]});
 const facts=[{fabricOrderId:'FABRIC',fabricOrderLineId:'F1',metres:'300.0625',status:'active'},{fabricOrderId:'FABRIC',fabricOrderLineId:'F1',metres:'300.0625',status:'active'}];
 it('keeps decimal commitments across multiple garment lines within the amended source supply',()=>{
  expect(()=>assertInternalFabricAllocationCapacity(one(),facts)).not.toThrow();
  expect(()=>assertInternalFabricAllocationCapacity(one('600.1249'),facts)).toThrow('不能低于');
 });
 it('counts only active allocations and refuses source or unit conflicts',()=>{
  expect(()=>assertInternalFabricAllocationCapacity(one('300.0625'),[facts[0],{...facts[1],status:'cancelled'}])).not.toThrow();
  expect(()=>assertInternalFabricAllocationCapacity(one(),[{...facts[0],fabricOrderId:'OTHER'}])).toThrow('来源');
  const p=one();p.lines[0].unit='YD';expect(()=>assertInternalFabricAllocationCapacity(p,facts)).toThrow('米');
 });
});
describe('fixed explicit quantity plan contract',()=>{
 it('canonical exact quantities and separate units; deterministic sorted identity',()=>{const a=canonicalQuantityPlan(plan());expect(a.lines.map(l=>[l.lineId,l.unit,l.beforeQuantity,l.afterQuantity])).toEqual([['a','YD','1000','800.5'],['b','M','1000.25','999.0001']]);const b=plan();b.lines.reverse();expect(quantityPlanHash(a)).toBe(quantityPlanHash(canonicalQuantityPlan(b)));});
 it.each(['afterQuantity','beforeQuantity'] as const)('rejects overprecision %s',key=>{const p=plan();p.lines[0][key]='1.00001';expect(()=>canonicalQuantityPlan(p)).toThrow();});
 it.each(['Other','unknown','__proto__',''])('does not infer unit %s',unit=>{const p=plan();p.lines[0].unit=unit;expect(()=>canonicalQuantityPlan(p)).toThrow();});
 it('rejects duplicate real line identities',()=>{const p=plan();p.lines[1].lineId='b';expect(()=>canonicalQuantityPlan(p)).toThrow();});
 it('rejects missing parent epoch',()=>{const p:any=plan();delete p.expectedUpdatedAt;expect(()=>canonicalQuantityPlan(p)).toThrow();});
 it('rejects extra quantity/factory fields rather than accepting opaque approval payload',()=>{const p:any=plan();p.lines[0].factoryId='F';expect(()=>canonicalQuantityPlan(p)).toThrow();});
 it('changed order/epoch/line/quantity/unit changes exact approval hash',()=>{const original=canonicalQuantityPlan(plan());for(const mutate of [(p:any)=>p.orderId='X',(p:any)=>p.expectedUpdatedAt='124',(p:any)=>p.lines[0].lineId='x',(p:any)=>p.lines[0].afterQuantity='1',(p:any)=>p.lines[0].unit='KG']){const p=plan();mutate(p);expect(quantityPlanHash(canonicalQuantityPlan(p))).not.toBe(quantityPlanHash(original));}});
});
describe('explicit approved quantity and money v2',()=>{
 const v2=()=>({version:2,orderId:'O',expectedUpdatedAt:'123',lines:[{lineId:'a',beforeQuantity:'1',unit:'M',afterQuantity:'2',beforeUnitPrice:'1.2345',beforeNetValue:'1.2345',afterNetValue:'2.4690'}]});
 it('retains every stored Decimal(18,4) monetary digit',()=>expect(canonicalQuantityPlan(v2()).lines[0]).toEqual({lineId:'a',beforeQuantity:'1',unit:'M',afterQuantity:'2',beforeUnitPrice:'1.2345',beforeNetValue:'1.2345',afterNetValue:'2.469'}));
 it('distinguishes unknown before amounts from actual zero',()=>{const p:any=v2();p.lines[0].beforeUnitPrice=null;p.lines[0].beforeNetValue=null;p.lines[0].afterNetValue='0';const unknown=canonicalQuantityPlan(p);p.lines[0].beforeNetValue='0';expect(quantityPlanHash(canonicalQuantityPlan(p))).not.toBe(quantityPlanHash(unknown));});
 it('explicit new net amount participates in approval hash',()=>{const p=v2(),old=quantityPlanHash(canonicalQuantityPlan(p));p.lines[0].afterNetValue='2.4';expect(quantityPlanHash(canonicalQuantityPlan(p))).not.toBe(old);});
 it('actual source and price facts participate in the original v2 approval hash',()=>{const p=canonicalQuantityPlan(v2()),facts={source:{confirmedSourceId:null},unitPrice:'1.2345'},old=quantityPlanApprovalHash(p,facts);expect(quantityPlanApprovalHash(p,{...facts,source:{confirmedSourceId:'changed'}})).not.toBe(old);expect(quantityPlanApprovalHash(p,{...facts,unitPrice:'1.2346'})).not.toBe(old);});
 it('preserves existing v1 approval hash without pretending it held v2 monetary facts',()=>{const p=canonicalQuantityPlan(plan());expect(quantityPlanApprovalHash(p,{source:'new'})).toBe(quantityPlanHash(p));});
 it('original price and net amount participate in approval hash',()=>{const p=v2(),old=quantityPlanHash(canonicalQuantityPlan(p));p.lines[0].beforeUnitPrice='1.23';expect(quantityPlanHash(canonicalQuantityPlan(p))).not.toBe(old);p.lines[0].beforeNetValue='1.23';expect(quantityPlanHash(canonicalQuantityPlan(p))).not.toBe(old);});
 it('requires explicit original null instead of omitted facts',()=>{const p:any=v2();delete p.lines[0].beforeUnitPrice;expect(()=>canonicalQuantityPlan(p)).toThrow();});
 it('does not accept customer or owner changes in monetary line plan',()=>{const p:any=v2();p.lines[0].ownerId='OTHER';expect(()=>canonicalQuantityPlan(p)).toThrow();});
 it('keeps an unchanged unknown legacy net amount null',()=>{const p:any=v2();p.lines[0].beforeQuantity='2';p.lines[0].afterQuantity='2';p.lines[0].beforeUnitPrice=null;p.lines[0].beforeNetValue=null;p.lines[0].afterNetValue=null;expect(canonicalQuantityPlan(p).lines[0].afterNetValue).toBeNull();});
 it('requires an explicit net amount for a changed quantity row',()=>{const p:any=v2();p.lines[0].beforeUnitPrice=null;p.lines[0].beforeNetValue=null;p.lines[0].afterNetValue=null;expect(()=>canonicalQuantityPlan(p)).toThrow('必须明确填写变更后净额');});
 it('does not allow a money-only mutation inside a quantity plan',()=>{const p:any=v2();p.lines[0].afterQuantity='1';p.lines[0].afterNetValue='0';expect(()=>canonicalQuantityPlan(p)).toThrow('不能夹带单独行金额变更');});
 it.each(['-1','Infinity','NaN','1.00001','100000000000000','1e2',null,{},true])('refuses invalid monetary fact %s',value=>expect(()=>exactPlanAmount(value)).toThrow());
 it('does not invoke arbitrary monetary object coercion',()=>{const toString=()=>{throw Error('coerced');};expect(()=>exactPlanAmount({toString})).toThrow('金额必须');});
});
describe('shipped quantity plan gate',()=>{
 const one=(afterQuantity='40')=>canonicalQuantityPlan({version:1,orderId:'O',expectedUpdatedAt:'123',lines:[{lineId:'L1',beforeQuantity:'100',unit:'PC',afterQuantity}]});
 it('uses exact legacy ShipmentLine facts when the allocation table has no row',()=>{
  assertShippedQuantityFacts('Production',one('40.0001'),[{id:'S1',status:'Shipped'}],[],[{shipmentId:'S1',orderLineId:'L1',quantity:'40',unit:'PCS'}]);
  expect(()=>assertShippedQuantityFacts('Production',one('39.9999'),[{id:'S1',status:'Shipped'}],[],[{shipmentId:'S1',orderLineId:'L1',quantity:'40',unit:'PC'}])).toThrow('不能低于');
 });
 it('fails closed when a shipped or Shipping order has no verifiable actual quantity',()=>{
  expect(()=>assertShippedQuantityFacts('Shipping',one(),[],[],[])).toThrow('没有可核验');
  expect(()=>assertShippedQuantityFacts('Production',one(),[{id:'S1',status:'Shipped'}],[],[])).toThrow('缺少完整订单行数量分配');
  expect(()=>assertShippedQuantityFacts('Production',one(),[{id:'S1',status:'Booked'}],[],[])).not.toThrow();
 });
 it('rejects missing or mismatched units and line identity instead of treating facts as zero',()=>{
  const ships=[{id:'S1',status:'Shipped'}];
  expect(()=>assertShippedQuantityFacts('Production',one(),ships,[],[{shipmentId:'S1',orderLineId:'L1',quantity:'12',unit:null}])).toThrow('无法明确归属');
  expect(()=>assertShippedQuantityFacts('Production',one(),ships,[],[{shipmentId:'S1',orderLineId:'OTHER',quantity:'12',unit:'PC'}])).toThrow('缺少完整订单行数量分配');
  expect(()=>assertShippedQuantityFacts('Production',one(),ships,[{shipmentId:'S1',orderLineId:'L1',actualQty:null,unit:'PC',status:'Fulfilled'}],[])).toThrow('无法明确归属');
 });
 it('keeps shipped totals independent for mixed units and line identities',()=>{
  const plan=canonicalQuantityPlan({version:1,orderId:'O',expectedUpdatedAt:'123',lines:[{lineId:'L1',beforeQuantity:'50',unit:'PC',afterQuantity:'10'},{lineId:'L2',beforeQuantity:'10',unit:'M',afterQuantity:'2'}]});
  const facts=[{shipmentId:'S1',orderLineId:'L1',quantity:'5',unit:'PCS'},{shipmentId:'S1',orderLineId:'L2',quantity:'1.5',unit:'meter'}];
  assertShippedQuantityFacts('Production',plan,[{id:'S1',status:'Arrived'}],[],facts);
  const tooSmall=canonicalQuantityPlan({version:1,orderId:'O',expectedUpdatedAt:'123',lines:[{lineId:'L1',beforeQuantity:'50',unit:'PC',afterQuantity:'10'},{lineId:'L2',beforeQuantity:'10',unit:'M',afterQuantity:'1.4999'}]});
  expect(()=>assertShippedQuantityFacts('Production',tooSmall,[{id:'S1',status:'Arrived'}],[],facts)).toThrow('不能低于');
 });
});
