import {Prisma} from '@prisma/client';
import {parseOrderQuantity, normalizeOrderQuantityUnit, summarizeOrderQuantity} from './orderQuantitySummary';
import {businessError} from './errorCodes';
/** Exact known-DB Decimal adapter; no arbitrary object conversion. */
export function orderQuantityDto(row:any) {
 const decimal=(v:unknown)=>v instanceof Prisma.Decimal?v.toString():v;
 const lines=Array.isArray(row.lines)?row.lines:[];
 const summary=summarizeOrderQuantity({activeOrderLines:lines.map((l:any)=>({quantity:decimal(l.quantity),unit:l.unit})),legacyQuantity:decimal(row.quantity),legacyUnit:row.unit});
 return {...row,quantity:row.quantity==null?null:parseOrderQuantity(decimal(row.quantity),{allowZero:true}),unit:normalizeOrderQuantityUnit(row.unit),quantitySummary:summary,
 ...(Array.isArray(row.lines)?{lines:lines.map((l:any)=>({...l,quantity:parseOrderQuantity(decimal(l.quantity),{allowZero:true})}))}:{})};
}
/** Caller holds Order lock; header cannot overwrite actual line facts. */
export async function guardOrderHeaderQuantity(tx:any,order:any,patch:Record<string,unknown>,expectedUpdatedAt?:unknown) {
 if(!Object.prototype.hasOwnProperty.call(patch,'quantity')&&!Object.prototype.hasOwnProperty.call(patch,'unit'))return;
 const lines=await tx.orderLine.findMany({where:{orderId:order.id},select:{quantity:true,unit:true},orderBy:{id:'asc'}});
 if(lines.length){
 if(expectedUpdatedAt==null||String(expectedUpdatedAt)!==order.updatedAt?.toString())throw businessError('CONFLICT','请核对当前订单版本后保存数量相关内容');
 const s=summarizeOrderQuantity({activeOrderLines:lines.map((l:any)=>({quantity:l.quantity.toString(),unit:l.unit}))});
 const q=Object.prototype.hasOwnProperty.call(patch,'quantity')?(patch.quantity==null?null:parseOrderQuantity(patch.quantity,{allowZero:true})):s.quantity;
 const unit=Object.prototype.hasOwnProperty.call(patch,'unit')?normalizeOrderQuantityUnit(patch.unit):s.unit;
 if(q!==s.quantity||unit!==s.unit)throw businessError('CONFLICT','订单数量和单位由实际明细行派生，请修改对应明细行或提交明确的逐行数量变更方案。');
 delete patch.quantity;delete patch.unit;return;
 }
 if(Object.prototype.hasOwnProperty.call(patch,'quantity'))patch.quantity=patch.quantity==null?null:parseOrderQuantity(patch.quantity);
 if(Object.prototype.hasOwnProperty.call(patch,'unit')){const u=normalizeOrderQuantityUnit(patch.unit);if(patch.unit!=null&&String(patch.unit).trim()&&!u)throw businessError('INVALID_INPUT','数量单位未识别，请选择明确单位或保留未录。');patch.unit=u;}
}
