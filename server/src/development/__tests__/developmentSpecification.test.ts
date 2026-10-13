import { describe,it,expect } from 'vitest';
import {normalizeFabricSpecification as normalize,normalizeGarmentSpecification} from '../../_shared/developmentSpecification';
const unknown=()=>({compositionStatus:'factory_analysis',composition:[],weightStatus:'factory_analysis',widthStatus:'factory_analysis',yarnStatus:'factory_analysis',constructionStatus:'factory_analysis'});
describe('development specification raw and normalized facts',()=>{
 it('permits unknown requirements and never invents GSM',()=>expect(normalize(unknown()).gsm).toBeNull());
 it('retains original per-yard and inches while converting using matching width',()=>{
  const result=normalize({...unknown(),weightStatus:'known',weight:{value:300,unit:'g/yd'},widthStatus:'known',width:{value:60,unit:'in',kind:'full'}});
  expect(result.weight).toEqual({value:300,unit:'g/yd'});expect(result.widthCm).toBeCloseTo(152.4);expect(result.gsm).toBeCloseTo(215.278);
 });
 it('does not guess width for linear weight',()=>expect(normalize({...unknown(),weightStatus:'known',weight:{value:300,unit:'g/m'}}).gsm).toBeNull());
 it('converts area weight independently of width',()=>expect(normalize({...unknown(),weightStatus:'known',weight:{value:8,unit:'oz/yd2'}}).gsm).toBeCloseTo(271.246));
 it('requires complete composition100 and explicit units',()=>{
  expect(()=>normalize({...unknown(),compositionStatus:'known',composition:[{fiber:'Cotton',percentage:90}]})).toThrow('100');
  expect(()=>normalize({...unknown(),weight:{value:200}})).toThrow('单位');
  expect(normalize({...unknown(),compositionStatus:'known',composition:[{fiber:'Cotton',percentage:80},{fiber:'Linen',percentage:20}]}).composition).toHaveLength(2);
 });
 it('rejects invalid values and does not derive from category',()=>{
  expect(()=>normalize({...unknown(),width:{value:-1,unit:'cm',kind:'usable'}})).toThrow('正数');
  expect(normalize({...unknown(),categoryId:'PDML-X'}).composition).toEqual([]);
 });
 it('keeps customer style names intact and optional style/block independent',()=>{
  expect(normalizeGarmentSpecification({styleName:'Mia X-20',styleNo:'S5',block:'B1'})).toEqual({styleName:'Mia X-20',styleNo:'S5',block:'B1',garmentCategory:undefined});
  expect(()=>normalizeGarmentSpecification({styleNo:'S1'})).toThrow('名称');
 });
});
