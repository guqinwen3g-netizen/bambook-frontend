/** 往来冻结：关系档案冻结后，关联客户不能新建报价 / 发送报价 / 转订单 / 新建订单，关联供应商不能新建采购单。只读类型依赖，不引入循环。 */
type HoldRelation = { customerId: string; supplierId: string; name: string; hold?: { reason: string; at: string; actor: string } | null };
type HoldState = { market?: { relations?: HoldRelation[] } };
export function relationHoldReason(state: HoldState, ref: { customerId?: string; supplierId?: string }): string {
  const r = (state.market?.relations || []).find(x => x.hold && ((ref.customerId && x.customerId === ref.customerId) || (ref.supplierId && x.supplierId === ref.supplierId)));
  return r?.hold ? `${r.name} 往来已冻结：${r.hold.reason}` : '';
}
