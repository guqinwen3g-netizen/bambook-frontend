import {describe,it,expect,vi} from 'vitest';
import {validateQuotationCatalog,resolveQuotationType} from '../quotationCommercial';
const database=(type='Fabric')=>({productAsset:{findFirst:vi.fn().mockResolvedValue({id:'P1',sku:'F1',name:'Cloth',mainCategory:type})}});
const line={productAssetId:'P1',description:'cloth',unit:'M',quantity:100,unitPrice:2};
describe('quotation business type and commercial contract',()=>{
 it('requires explicit type and catalog identity for new quotations',async()=>{
  await expect(validateQuotationCatalog(database(),null,[line])).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(validateQuotationCatalog(database(),'Fabric',[{...line,productAssetId:undefined}])).rejects.toMatchObject({code:'INVALID_INPUT'});
 });
 it('rejects mixed product types independently of units',async()=>{
  await expect(validateQuotationCatalog(database('Garment'),'Fabric',[line])).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect((await validateQuotationCatalog(database('Garment'),'Garment',[{...line,unit:'M'}]))[0].productType).toBe('Garment');
 });
 it('validates tier ranges and commercial quantities',async()=>{
  for(const change of [{moq:-1},{leadTimeDays:1.5},{priceTiers:[{minQuantity:10,unitPrice:2},{minQuantity:5,unitPrice:1}]}])
   await expect(validateQuotationCatalog(database(),'Fabric',[{...line,...change}])).rejects.toMatchObject({code:'INVALID_INPUT'});
 });
 it('does not infer legacy type from units',async()=>{
  await expect(resolveQuotationType(database(),{lines:[{unit:'M'}]})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(await resolveQuotationType(database(),{lines:[line]})).toBe('Fabric');
 });
 it('rejects catalog-mixed legacy quotation',async()=>{
  const db=database(); db.productAsset.findFirst.mockResolvedValueOnce({mainCategory:'Fabric'}).mockResolvedValueOnce({mainCategory:'Garment'});
  await expect(resolveQuotationType(db,{lines:[line,line]})).rejects.toMatchObject({code:'INVALID_INPUT'});
 });
});

import {assembleQuotationDocData} from '../../templates/docTemplates/quotation';
import {buildQuotationSnapshot} from '../quotationApprovalSnapshot';
describe('commercial source and outward document boundary',()=>{
 const quote=()=>({id:'Q',quotationNumber:'QT',version:1,currency:'USD',totalAmount:20,notes:null,
  quotationType:'Fabric',internalCostBasis:{supplierCost:12,margin:40},contactName:'Alice',tradePlace:'Shanghai',
  lines:[{...line,id:'L',lineNumber:1,amount:200,productType:'Fabric',specification:'100% cotton',moq:100,leadTimeDays:30,leadTimeStart:'deposit received',priceTiers:[{minQuantity:100,unitPrice:2}]}]});
 it('freezes internal costs and commercial terms for full-version confirmation',()=>{
  const snapshot=buildQuotationSnapshot(quote());
  expect(snapshot.internalCostBasis).toEqual({supplierCost:12,margin:40});
  expect(snapshot.lines[0]).toMatchObject({specification:'100% cotton',moq:'100',leadTimeStart:'deposit received'});
 });
 it('outward DTO retains customer conditions and excludes internal costs',()=>{
  const dto=assembleQuotationDocData(quote());
  expect(dto.qt).toMatchObject({contactName:'Alice',tradePlace:'Shanghai'});
  expect(dto.lines[0]).toMatchObject({moq:100,leadTimeDays:30});
  expect(JSON.stringify(dto)).not.toMatch(/supplierCost|margin|internalCostBasis/);
 });
});

import {assembleQuotationVersionDocData} from '../../templates/docTemplates/quotation';
describe('historical customer quotation documents',()=>{
 const version={quotationId:'Q1',currency:'EUR',totalAmount:15,headerSnapshot:{status:'Sent',quotationNumber:'QT1',customerName:'Frozen customer',quotationType:'Garment',internalCostBasis:{cost:8},validUntil:'2026-11-01'},linesSnapshot:[{lineNumber:1,description:'Frozen item',quantity:3,unit:'PC',unitPrice:5,amount:15}]};
 it('uses the frozen header and lines and strips private costs',()=>{
  const document=assembleQuotationVersionDocData(version);
  expect(document.qt.customerName).toBe('Frozen customer');
  expect(document.lines[0].description).toBe('Frozen item');
  expect(document.qt.totalAmount).toBe(15);
  expect(JSON.stringify(document)).not.toContain('internalCostBasis');
 });
 it('refuses draft versions and mutable historical image links',()=>{
  expect(()=>assembleQuotationVersionDocData({...version,headerSnapshot:{...version.headerSnapshot,status:'Draft'}})).toThrow('已发报价快照');
  expect(()=>assembleQuotationVersionDocData({...version,linesSnapshot:[{...version.linesSnapshot[0],imageUrl:'/uploads/current.png'}]})).toThrow('图片未冻结');
 });
});

import {snapshotQuotationVersion} from '../quotationService';
it('preserves the version frozen at issuance when later revising',async()=>{
 const tx={quotationVersion:{findFirst:vi.fn().mockResolvedValue({id:'issued'}),create:vi.fn()}};
 await snapshotQuotationVersion(tx,{id:'Q1',version:2,status:'Sent',lines:[{imageUrl:'/mutable.png'}]},'owner','revise');
 expect(tx.quotationVersion.create).not.toHaveBeenCalled();
});
