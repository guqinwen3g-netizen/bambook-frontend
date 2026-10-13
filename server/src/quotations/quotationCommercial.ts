import {Prisma} from '@prisma/client';
import { businessError } from '../shared/errorCodes';
export const QUOTATION_COMMERCIAL_FIELDS = ['quotationType','contactName','contactPhone','tradePlace','internalCostBasis'] as const;
export const QUOTATION_LINE_COMMERCIAL_FIELDS = ['productAssetId','productType','specification','moq','leadTimeDays','leadTimeStart','priceTiers'] as const;
export function commercialFields(source:any, fields:readonly string[], missing:any = undefined) {
  return Object.fromEntries(fields.map(key=>[key,source[key] === undefined ? missing : source[key]]));
}
export function quotationWriteFields(source:any, fields:readonly string[], missing:any=undefined) {
  const result=commercialFields(source,fields,missing);
  for(const key of ['internalCostBasis','priceTiers']) if(key in result && result[key]===null) result[key]=Prisma.DbNull;
  return result;
}
export function quotationProductType(value:unknown): 'Fabric'|'Garment'|null {
  return value === 'Fabric' || value === 'Garment' ? value : null;
}
/** Catalog identity, never quantity units, determines the business type. */
export async function validateQuotationCatalog(db:any, quotationType:unknown, lines:any[]) {
  const type=quotationProductType(quotationType);
  if (!type) throw businessError('INVALID_INPUT','请选择面料报价或服装报价。');
  if (!Array.isArray(lines) || !lines.length) throw businessError('INVALID_INPUT','至少需要一行报价明细。');
  const normalized=[];
  for(const line of lines){
    if(!line.productAssetId) throw businessError('INVALID_INPUT','报价明细必须选择产品档案。');
    const product=await db.productAsset.findFirst({where:{id:line.productAssetId,deletedAt:null},select:{id:true,mainCategory:true,sku:true,name:true,imageUrl:true}});
    if(!product || quotationProductType(product.mainCategory)!==type) throw businessError('INVALID_INPUT','产品档案类型与报价类型不一致。');
    if(line.productType && line.productType!==type) throw businessError('INVALID_INPUT','报价不可混合面料和服装。');
    if(line.moq!=null && (!Number.isFinite(Number(line.moq)) || Number(line.moq)<0)) throw businessError('INVALID_INPUT','MOQ 必须为非负数。');
    if(line.leadTimeDays!=null && (!Number.isInteger(line.leadTimeDays)||line.leadTimeDays<0)) throw businessError('INVALID_INPUT','交期天数必须为非负整数。');
    if(line.priceTiers!=null){
      if(!Array.isArray(line.priceTiers)) throw businessError('INVALID_INPUT','数量阶梯价格格式不正确。');
      let previous=0;
      for(const tier of line.priceTiers){
        if(!Number.isFinite(tier.minQuantity)||tier.minQuantity<=previous||!Number.isFinite(tier.unitPrice)||tier.unitPrice<0) throw businessError('INVALID_INPUT','阶梯起始数量须递增且价格不可为负数。');
        previous=tier.minQuantity;
      }
    }
    normalized.push({...line,productType:type,fabricCode:product.sku,description:line.description||product.name,imageUrl:line.imageUrl??product.imageUrl});
  }
  return normalized;
}
export async function resolveQuotationType(db:any, quotation:any):Promise<'Fabric'|'Garment'> {
  const explicit=quotationProductType(quotation.quotationType);
  if(explicit) return explicit;
  const types=new Set<string>();
  for(const line of quotation.lines??[]){
    if(!line.productAssetId) throw businessError('INVALID_INPUT','历史报价产品类型未核定，请先补齐产品档案与报价类型。');
    const product=await db.productAsset.findFirst({where:{id:line.productAssetId,deletedAt:null},select:{mainCategory:true}});
    const type=quotationProductType(product?.mainCategory);
    if(!type) throw businessError('INVALID_INPUT','历史报价产品类型未核定。');
    types.add(type);
  }
  if(types.size!==1) throw businessError('INVALID_INPUT','报价包含混合或未核定产品类型。');
  return [...types][0] as 'Fabric'|'Garment';
}
