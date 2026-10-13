/** Explicit domain is authoritative; old untyped records remain readable without rewriting history. */
export type DevelopmentDomain = 'garment' | 'fabric';
export function developmentDomain(values:{domain?:DevelopmentDomain;category?:string}):DevelopmentDomain {return values.domain??(/面料|fabric/i.test(values.category||'')?'fabric':'garment');}
export type FabricDevelopmentRequirements={composition:string;weightValue:string;weightUnit:string;widthValue:string;widthUnit:string;yarn:string;weave:string;usage:string;handle:string;finish:string;performance:string};
export const emptyFabricRequirements=():FabricDevelopmentRequirements=>({composition:'待工厂分析',weightValue:'',weightUnit:'',widthValue:'',widthUnit:'',yarn:'待工厂分析',weave:'待工厂分析',usage:'',handle:'',finish:'',performance:''});
export function fabricRequirementError(input:FabricDevelopmentRequirements):string|null{
 if(input.composition.trim()&&input.composition.trim()!=='待工厂分析'){
  const rows=input.composition.split(/[\n、;；]/).map(x=>x.trim()).filter(Boolean);let total=0;
  for(const row of rows){const m=/^(.+?)\s*[:：]\s*(\d+(?:\.\d+)?)\s*%?$/.exec(row);if(!m||!m[1].trim()||Number(m[2])<=0||Number(m[2])>100)return '成分请逐行填写“纤维:比例”，未知请注明待工厂分析';total+=Number(m[2]);}
  if(Math.abs(total-100)>1e-8)return '目标成分比例合计须为100%';
 }
 for(const [value,unit,label] of [[input.weightValue,input.weightUnit,'克重'],[input.widthValue,input.widthUnit,'幅宽']]){
  if(value.trim()&&(!/^\d+(?:\.\d+)?$/.test(value)||!Number.isFinite(Number(value))||Number(value)<=0))return label+'须为大于0的有限数';
  if(!!value.trim()!==!!unit.trim())return label+'须同时记录原值和原单位，未知请都留空';
 }
 return null;
}
export function validFabricSample(quantity:number,form:string,unit:string):boolean{if(typeof form!=='string'||typeof unit!=='string')return false;const f=form.trim(),u=unit.trim();return Number.isFinite(quantity)&&quantity>0&&!!f&&((f==='米样'&&u==='米')||(f!=='米样'&&u==='份'&&Number.isInteger(quantity)));}
