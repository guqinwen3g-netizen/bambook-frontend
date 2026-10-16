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

/** BB-DEV-1：开发案发起方。旧记录没有该字段时均为客户开发，按原样读取。 */
export type DevelopmentInitiator = 'customer' | 'internal';
export type DevelopmentRequestType = 'replicate' | 'design' | 'other';
export const DEVELOPMENT_REQUEST_TYPES: Record<DevelopmentRequestType, { label: string; hint: string }> = {
  replicate: { label: '复刻', hint: '客户有明确来样' },
  design: { label: '我方设计', hint: '客户给定参数方向' },
  other: { label: '其他', hint: '须写明具体情况' },
};
export const developmentInitiator = (values: { initiator?: DevelopmentInitiator }): DevelopmentInitiator => values.initiator === 'internal' ? 'internal' : 'customer';
/** 是否收费：未单独填写时按发起方默认（客户要求 = 收费，内部需求 = 不收费）。 */
export const developmentCharged = (values: { initiator?: DevelopmentInitiator; charged?: boolean }): boolean => typeof values.charged === 'boolean' ? values.charged : developmentInitiator(values) === 'customer';
export function developmentInitiatorLabel(values: { initiator?: DevelopmentInitiator; requestType?: DevelopmentRequestType; requester?: string }): string {
  if (developmentInitiator(values) === 'internal') return `内部需求${values.requester ? ' · ' + values.requester : ''}`;
  return `客户要求${values.requestType ? ' · ' + DEVELOPMENT_REQUEST_TYPES[values.requestType].label : ''}`;
}
