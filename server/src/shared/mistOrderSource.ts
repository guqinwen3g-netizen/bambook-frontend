/** BB-ORD-2：订单条目来源（开发版本 / 产品档案）的服务端校验。只读开发与产品数据，不修改开发、报价模块。 */
import {MistCommandError,type MistState,type MistOrder} from './mistWorkspace';
import {developmentDomain} from './mistDevelopmentDomain';

export type OrderLineSource={sourceDevId?:string;sourceVersionId?:string;sourceProductId?:string};
export type OrderSourceScope={type:MistOrder['type'];customerId:string;internal:boolean};
const TYPE_LABEL:Record<MistOrder['type'],string>={garment:'成衣',fabric:'面料'};

function fail(message:string):never{throw new MistCommandError('VALIDATION',message,422);}
function id(value:unknown,label:string){if(value===undefined||value===null||value==='')return '';if(typeof value!=='string'||value.length>200||!value.trim())fail(label+'格式无效');return value.trim();}

/** 规范来源字段：只保留非空的三个字段。 */
export function normalizeOrderLineSource(row:OrderLineSource):OrderLineSource{
  const sourceDevId=id(row.sourceDevId,'来源开发案'),sourceVersionId=id(row.sourceVersionId,'来源版本'),sourceProductId=id(row.sourceProductId,'来源产品档案');
  return {...(sourceProductId?{sourceProductId}:{}),...(sourceDevId?{sourceDevId}:{}),...(sourceVersionId?{sourceVersionId}:{})};
}

/** 返回第一个不满足的原因；满足返回 null。label 用于在多条目时指出是哪一条。 */
export function orderLineSourceProblem(state:MistState,scope:OrderSourceScope,source:OrderLineSource,label:string):string|null{
  const s=normalizeOrderLineSource(source);const at=`条目「${label}」`;
  if(s.sourceProductId){
    const product=(state.market?.products||[]).find(row=>row.id===s.sourceProductId);
    if(!product)return `${at}引用的产品档案不存在`;
    if(product.status!=='active')return `${at}引用的产品档案已归档，不能用于新订单`;
    if(product.category!==scope.type)return `${at}引用的产品档案不是${TYPE_LABEL[scope.type]}，与订单类型不一致`;
    // 产品档案自带的开发来源只能原样携带，不能改写成其他开发案或版本
    if(s.sourceDevId&&s.sourceDevId!==(product.sourceDevId||''))return `${at}的来源开发案与产品档案记录不一致`;
    if(s.sourceVersionId&&s.sourceVersionId!==(product.sourceVersionId||''))return `${at}的来源版本与产品档案记录不一致`;
    return null;
  }
  if(!s.sourceDevId&&!s.sourceVersionId)return null;
  if(!s.sourceVersionId)return `${at}只写了来源开发案，请同时选择已认可的来源版本`;
  if(!s.sourceDevId)return `${at}缺少来源开发案`;
  const version=state.versions.find(row=>row.id===s.sourceVersionId);
  if(!version)return `${at}引用的开发版本不存在`;
  const dev=state.devs.find(row=>row.id===s.sourceDevId);
  if(!dev)return `${at}引用的开发案不存在`;
  if(version.devId!==dev.id)return `${at}的来源版本 ${version.label} 不属于开发案 ${dev.code}`;
  if(version.archivedAt)return `${at}的来源版本 ${dev.code} · ${version.label} 已归档，不能用于新订单`;
  const latest=version.confirmations.at(-1);
  if(latest?.result!=='approved')return `${at}的来源版本 ${dev.code} · ${version.label} 尚未获得客户认可（${!latest?'尚无需求方确认':latest.result==='needs_adjustment'?'需求方要求调整':'需求方未认可'}）`;
  if(developmentDomain(dev.values)!==scope.type)return `${at}的来源开发案是${TYPE_LABEL[developmentDomain(dev.values)]}，与${TYPE_LABEL[scope.type]}订单不一致`;
  if(!scope.internal&&dev.customerId&&dev.customerId!==scope.customerId)return `${at}的来源开发案 ${dev.code} 属于其他客户，不能用于本订单客户`;
  return null;
}

export function assertOrderLineSource(state:MistState,scope:OrderSourceScope,source:OrderLineSource,label:string){const problem=orderLineSourceProblem(state,scope,source,label);if(problem)fail(problem);return normalizeOrderLineSource(source);}
