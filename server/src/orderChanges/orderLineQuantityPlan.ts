import {isOrderShipped,isShipmentShipped} from '../shared/shippingLock';
import {createHash} from 'node:crypto';
import {Prisma} from '@prisma/client';
import type {TokenPayload} from '../auth/service';
import {loadUserWithRoles,buildLoadedAuthTokenPayload} from '../auth/tokenHelpers';
import {hasScope} from '../auth/permissionService';
import {freshOrderLineScope} from '../orders/orderLineWriteAccess';
import {parseOrderQuantity,normalizeOrderQuantityUnit,summarizeOrderQuantity} from '../shared/orderQuantitySummary';
import {refreshOrderQuantityHeader} from '../shared/orderQuantityProjection';
import {businessError} from '../shared/errorCodes';
import {quantityCredentialCeiling} from './quantityPlanCredential';
import {canonicalClaimJson} from '../claims/claimApprovalFact';
export interface OrderLineQuantityPlan {version:1|2;orderId:string;expectedUpdatedAt:string;lines:{lineId:string;beforeQuantity:string;unit:string;afterQuantity:string;beforeUnitPrice?:string|null;beforeNetValue?:string|null;afterNetValue?:string|null}[];}
/** Quantity and monetary columns both use Decimal(18,4); never round an approved fact. */
export function exactPlanAmount(value:unknown):string {try{return parseOrderQuantity(value,{allowZero:true});}catch{throw businessError('INVALID_INPUT','金额必须为非负精确十进制，最多十四位整数和四位小数，不允许舍入或推算');}}
function amountScaled(value:unknown):bigint {const [whole,fraction='']=exactPlanAmount(value).split('.');return BigInt(whole)*BigInt(10000)+BigInt(fraction.padEnd(4,'0'));}
function scaledAmountText(value:bigint):string {const fraction=(value%BigInt(10000)).toString().padStart(4,'0').replace(/0+$/,'');return exactPlanAmount((value/BigInt(10000)).toString()+(fraction?'.'+fraction:''));}
/** Local integer arithmetic only; never configure Decimal globally or round a product. */
export function exactQuantityUnitPriceAmount(quantity:string,unitPrice:string):string {const product=amountScaled(quantity)*amountScaled(unitPrice);if(product%BigInt(10000)!==BigInt(0))throw businessError('INVALID_INPUT','数量乘实际单价的金额超过四位小数，须明确审批逐行净额，不能舍入');return scaledAmountText(product/BigInt(10000));}
export function sumExactPlanAmounts(values:string[]):string {return scaledAmountText(values.reduce((sum,value)=>sum+amountScaled(value),BigInt(0)));}
export function validateProposedQuantityPlanMoney(validated:{plan:OrderLineQuantityPlan;actual:any[]}):void {
 const amounts:string[]=[];
 for(const item of validated.plan.lines){const old=validated.actual.find((l:any)=>l.id===item.lineId);const amount=validated.plan.version===2?item.afterNetValue:item.afterQuantity!==item.beforeQuantity&&old.unitPrice!=null?exactQuantityUnitPriceAmount(item.afterQuantity,old.unitPrice.toString()):old.netValue?.toString();if(amount!=null)amounts.push(exactPlanAmount(amount));}
 sumExactPlanAmounts(amounts);
}
export function canonicalQuantityPlan(value:unknown):OrderLineQuantityPlan {
 if(!value||typeof value!=='object'||Array.isArray(value))throw businessError('INVALID_INPUT','必须提供明确的逐行数量变更计划');
 const p=value as any;if(Object.keys(p).sort().join(',')!=='expectedUpdatedAt,lines,orderId,version'||![1,2].includes(p.version)||typeof p.orderId!=='string'||!p.orderId.trim()||typeof p.expectedUpdatedAt!=='string'||!/^\d+$/.test(p.expectedUpdatedAt)||!Array.isArray(p.lines)||!p.lines.length)throw businessError('INVALID_INPUT','数量计划结构或订单版本无效');
 const keys=p.version===2?'afterNetValue,afterQuantity,beforeNetValue,beforeQuantity,beforeUnitPrice,lineId,unit':'afterQuantity,beforeQuantity,lineId,unit';
 const ids=new Set<string>();const lines=p.lines.map((l:any)=>{if(!l||typeof l!=='object'||Object.keys(l).sort().join(',')!==keys||typeof l.lineId!=='string'||!l.lineId.trim()||ids.has(l.lineId))throw businessError('INVALID_INPUT','数量计划行不可重复或缺少原件');ids.add(l.lineId);const unit=normalizeOrderQuantityUnit(l.unit);if(!unit)throw businessError('CONFLICT','数量计划必须核对每行明确单位');return{lineId:l.lineId,beforeQuantity:parseOrderQuantity(l.beforeQuantity,{allowZero:true}),unit,afterQuantity:parseOrderQuantity(l.afterQuantity),...(p.version===2?{beforeUnitPrice:l.beforeUnitPrice===null?null:exactPlanAmount(l.beforeUnitPrice),beforeNetValue:l.beforeNetValue===null?null:exactPlanAmount(l.beforeNetValue),afterNetValue:l.afterNetValue===null?null:exactPlanAmount(l.afterNetValue)}:{})};}).sort((a:any,b:any)=>a.lineId.localeCompare(b.lineId));
 if(p.version===2)for(const line of lines){if(line.afterQuantity===line.beforeQuantity&&line.afterNetValue!==line.beforeNetValue)throw businessError('INVALID_INPUT','数量变更计划不能夹带单独行金额变更');if(line.afterQuantity!==line.beforeQuantity&&line.afterNetValue===null)throw businessError('INVALID_INPUT','数量变化的行必须明确填写变更后净额');}
 return{version:p.version,orderId:p.orderId,expectedUpdatedAt:BigInt(p.expectedUpdatedAt).toString(),lines};
}
export const quantityPlanHash=(plan:OrderLineQuantityPlan)=>createHash('sha256').update(JSON.stringify(plan)).digest('hex');
export const quantityPlanApprovalHash=(plan:OrderLineQuantityPlan,commercialFacts:unknown)=>plan.version===1?quantityPlanHash(plan):createHash('sha256').update(canonicalClaimJson({plan,commercialFacts})).digest('hex');
const QUANTITY_SCALE=BigInt(10000),MAX_SCALED_QUANTITY=BigInt('999999999999999999');
function scaledQuantity(value:unknown):bigint {const exact=parseOrderQuantity(value,{allowZero:true}),[whole,fraction='']=exact.split('.');return BigInt(whole)*QUANTITY_SCALE+BigInt(fraction.padEnd(4,'0'));}
/** Already allocated supply cannot be reduced by a later approved quantity plan. */
export function assertInternalFabricAllocationCapacity(plan:OrderLineQuantityPlan,allocations:any[]):void {
 const totals=new Map<string,bigint>();
 for(const row of allocations){
  if(row.status==='cancelled')continue;
  const item=plan.lines.find(line=>line.lineId===row.fabricOrderLineId);
  if(row.status!=='active'||!item||row.fabricOrderId!==plan.orderId)throw businessError('CONFLICT','内部面料分配来源无法核实，请先核对原分配');
  if(item.unit!=='M')throw businessError('CONFLICT','已分配的内部面料必须保持明确的米数单位');
  const amount=scaledQuantity(typeof row.metres==='string'?row.metres:row.metres?.toString());
  if(amount<=BigInt(0))throw businessError('CONFLICT','内部面料分配米数无法核实');
  const total=(totals.get(item.lineId)??BigInt(0))+amount;
  if(total>MAX_SCALED_QUANTITY)throw businessError('CONFLICT','内部面料分配总量超出可核验精度');
  totals.set(item.lineId,total);
 }
 for(const item of plan.lines)if(scaledQuantity(item.afterQuantity)<(totals.get(item.lineId)??BigInt(0)))throw businessError('CONFLICT','变更后面料供给米数不能低于已分配给成衣条目的累计米数');
}
/** Caller holds the source Order and OrderLine locks used by allocation commands. */
export async function assertInternalFabricAllocationCapacityInTx(tx:any,plan:OrderLineQuantityPlan):Promise<void>{
 const allocations=await tx.fabricLineAllocation.findMany({where:{fabricOrderId:plan.orderId,fabricOrderLineId:{in:plan.lines.map(line=>line.lineId)},status:'active'},select:{fabricOrderId:true,fabricOrderLineId:true,metres:true,status:true}});
 assertInternalFabricAllocationCapacity(plan,allocations);
}
/** Fail closed unless every shipped shipment has exact per-line quantity facts. */
export function assertShippedQuantityFacts(orderStatus:string,plan:OrderLineQuantityPlan,shipments:any[],allocations:any[],shipmentLines:any[]):void {
 const shipped=shipments.filter(ship=>isShipmentShipped(ship.status)),shippedIds=new Set(shipped.map(ship=>ship.id));
 if(isOrderShipped(orderStatus)&&shipped.length===0)throw businessError('CONFLICT','订单已进入出运/交付状态，但没有可核验的已发运数量原件，不能变更数量');
 const totals=new Map<string,bigint>();
 const add=(lineId:unknown,rawQuantity:unknown,rawUnit:unknown)=>{
  const item=plan.lines.find(line=>line.lineId===lineId);
  if(!item||rawQuantity==null||normalizeOrderQuantityUnit(rawUnit)!==item.unit)throw businessError('CONFLICT','已出运数量无法明确归属同单位订单行，请先核对出运原件');
  const total=(totals.get(item.lineId)??BigInt(0))+scaledQuantity(String(rawQuantity));
  if(total>MAX_SCALED_QUANTITY)throw businessError('CONFLICT','已出运行数量超出可核验精度，请先核对出运原件');
  totals.set(item.lineId,total);
 };
 for(const shipment of shipped){
  const allAllocations=allocations.filter(row=>row.shipmentId===shipment.id);
  if(allAllocations.length){
   if(allAllocations.some(row=>row.status==='Cancelled'))throw businessError('CONFLICT','已发运运单仍存在已取消分配，数量事实冲突，请先核对出运原件');
   for(const row of allAllocations)add(row.orderLineId??(plan.lines.length===1?plan.lines[0].lineId:null),row.actualQty,row.unit);
   continue;
  }
  const rows=shipmentLines.filter(row=>row.shipmentId===shipment.id);
  if(!rows.length||rows.some(row=>!row.orderLineId||!plan.lines.some(line=>line.lineId===row.orderLineId)))throw businessError('CONFLICT','已发运运单缺少完整订单行数量分配，不能变更数量');
  for(const row of rows)add(row.orderLineId,row.quantity,row.unit);
 }
 for(const item of plan.lines)if(scaledQuantity(item.afterQuantity)<(totals.get(item.lineId)??BigInt(0)))throw businessError('CONFLICT','变更后行数量不能低于同单位实际已出运数量');
}
export async function lockAndValidateQuantityPlan(tx:any,orderId:string,raw:unknown,prior:TokenPayload|undefined,scope:'order:change_request:create'|'order:change_request:apply'){
 if(!prior?.userId)throw businessError('UNAUTHORIZED','数量计划需要有效用户登录主体');
 const ceiling=quantityCredentialCeiling(prior);
 const user=await loadUserWithRoles(tx,prior.userId);if(!user||user.deletedAt!=null||user.status!=='active')throw businessError('ACCOUNT_DISABLED','当前账号已失效');
 let actor=await buildLoadedAuthTokenPayload(tx,user);if(ceiling!==undefined)actor.permissionCeiling=[...ceiling];if(!hasScope(actor,scope))throw businessError('FORBIDDEN','当前账号没有数量计划操作权限');
 const where=await freshOrderLineScope(tx,actor);let order=await tx.order.findFirst({where:{AND:[{id:orderId,deletedAt:null},where]}});if(!order)throw businessError('NOT_FOUND','订单不存在或不可操作');
 await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${orderId} FOR UPDATE`);order=await tx.order.findFirst({where:{AND:[{id:orderId,deletedAt:null},await freshOrderLineScope(tx,actor)]}});if(!order)throw businessError('NOT_FOUND','订单已不在当前范围');
 const latestUser=await loadUserWithRoles(tx,prior.userId);if(!latestUser||latestUser.status!=='active'||latestUser.deletedAt!=null)throw businessError('ACCOUNT_DISABLED','锁后账号已失效');actor=await buildLoadedAuthTokenPayload(tx,latestUser);if(ceiling!==undefined)actor.permissionCeiling=[...ceiling];if(!hasScope(actor,scope))throw businessError('FORBIDDEN','锁后数量计划权限已撤销');
 const p=canonicalQuantityPlan(raw);if(p.orderId!==orderId||p.expectedUpdatedAt!==order.updatedAt?.toString())throw businessError('CONFLICT','数量计划原订单版本已变化，请重新核对');
 await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "orderId"=${orderId} ORDER BY "id" FOR UPDATE`);const actual=await tx.orderLine.findMany({where:{orderId},orderBy:{id:'asc'}});if(actual.length!==p.lines.length)throw businessError('CONFLICT','数量计划必须完整绑定当前全部订单行');
 for(const line of actual){const item=p.lines.find(l=>l.lineId===line.id);if(!item||item.beforeQuantity!==parseOrderQuantity(line.quantity.toString(),{allowZero:true})||item.unit!==normalizeOrderQuantityUnit(line.unit))throw businessError('CONFLICT','数量计划原行数量或单位已变化');if(p.version===2&&(item.beforeUnitPrice!==(line.unitPrice?.toString()??null)||item.beforeNetValue!==(line.netValue?.toString()??null)))throw businessError('CONFLICT','数量金额计划原行价格或金额已变化');}
 let changed=false;
 for(const item of p.lines){const line=actual.find((l:any)=>l.id===item.lineId);if(p.version===2&&item.afterQuantity===item.beforeQuantity&&item.afterNetValue!==item.beforeNetValue)throw businessError('INVALID_INPUT','数量变更计划不能夹带单独行金额变更');if(item.afterQuantity===item.beforeQuantity)continue;changed=true;
 if(p.version===2&&item.afterNetValue===null)throw businessError('INVALID_INPUT','数量变化的行必须明确填写变更后净额');
 if(p.version===1){if(line.netValue!=null&&(line.unitPrice==null||exactQuantityUnitPriceAmount(item.beforeQuantity,line.unitPrice.toString())!==exactPlanAmount(line.netValue.toString())))throw businessError('CONFLICT','实际行金额没有明确一致的单价依据，请在数量金额计划中明确逐行变更后金额');if(line.unitPrice!=null)exactQuantityUnitPriceAmount(item.afterQuantity,line.unitPrice.toString());}}
 if(!changed)throw businessError('INVALID_INPUT','逐行数量计划没有实际数量变化');
 const allocations=await tx.shipmentOrderAllocation.findMany({where:{orderId},select:{shipmentId:true,orderLineId:true,actualQty:true,unit:true,status:true}});
 const directShips=await tx.shipment.findMany({where:{orderId,deletedAt:null},select:{id:true,status:true}});
 const relatedShipIds=[...new Set(allocations.map((row:any)=>row.shipmentId))];
 const relatedShips=relatedShipIds.length?await tx.shipment.findMany({where:{id:{in:relatedShipIds},deletedAt:null},select:{id:true,status:true}}):[];
 const shipmentMap=new Map<string,any>();for(const ship of [...directShips,...relatedShips])shipmentMap.set(ship.id,ship);
 const shipments=[...shipmentMap.values()],shippedIds=shipments.filter((ship:any)=>isShipmentShipped(ship.status)).map((ship:any)=>ship.id);
 const shipmentLines=shippedIds.length?await tx.shipmentLine.findMany({where:{shipmentId:{in:shippedIds}},select:{shipmentId:true,orderLineId:true,quantity:true,unit:true}}):[];
 assertShippedQuantityFacts(order.status,p,shipments,allocations,shipmentLines);
 await assertInternalFabricAllocationCapacityInTx(tx,p);
 const proposed=summarizeOrderQuantity({activeOrderLines:p.lines.map(l=>({quantity:l.afterQuantity,unit:l.unit}))});const commercialFacts=quantityPlanCommercialFacts({plan:p,actual,order});return{plan:p,hash:quantityPlanApprovalHash(p,commercialFacts),actual,order,proposed,actor};
}
export function quantityPlanCommercialFacts(validated:{plan:OrderLineQuantityPlan;actual:any[];order:any}){return validated.plan.lines.map(item=>{const line=validated.actual.find((l:any)=>l.id===item.lineId),order=validated.order;return{lineId:item.lineId,unitPrice:line.unitPrice?.toString()??null,netValue:line.netValue?.toString()??null,...(validated.plan.version===2?{source:{confirmedSourceType:line.confirmedSourceType??null,confirmedSourceId:line.confirmedSourceId??null,confirmedAt:line.confirmedAt?.toString()??null,confirmedBy:line.confirmedBy??null,specSnapshot:line.specSnapshot??null},orderSource:{source:order.source??null,customerRelationId:order.customerRelationId??null,millRelationId:order.millRelationId??null,type:order.type,businessLine:order.businessLine??null,currency:order.currency??null,salesCurrency:order.salesCurrency??null}}:{})};});}
export async function applyExactQuantityPlan(tx:any,validated:Awaited<ReturnType<typeof lockAndValidateQuantityPlan>>){
 await assertInternalFabricAllocationCapacityInTx(tx,validated.plan);
 for(const item of validated.plan.lines){const old=validated.actual.find((l:any)=>l.id===item.lineId);if(item.afterQuantity===item.beforeQuantity&&(validated.plan.version===1||item.afterNetValue===item.beforeNetValue))continue;const data:any={quantity:item.afterQuantity};if(validated.plan.version===2)data.netValue=item.afterNetValue;else if(old.unitPrice!=null)data.netValue=exactQuantityUnitPriceAmount(item.afterQuantity,old.unitPrice.toString());await tx.orderLine.update({where:{id:item.lineId},data});}
 const summary=await refreshOrderQuantityHeader(tx,validated.plan.orderId);
 const actual=await tx.orderLine.findMany({where:{orderId:validated.plan.orderId},select:{netValue:true}});if(actual.every((l:any)=>l.netValue!=null)){const amount=sumExactPlanAmounts(actual.map((l:any)=>l.netValue.toString()));await tx.order.update({where:{id:validated.plan.orderId},data:{totalNet:amount,contractAmount:amount,quoteAmount:amount}});}
 return summary;
}
