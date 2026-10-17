/** 往来冻结：关系档案冻结后，关联客户不能新建报价 / 发送报价 / 转订单 / 新建订单，关联供应商不能新建采购单。只读类型依赖，不引入循环。 */
type HoldRelation = { id?: string; customerId: string; supplierId: string; name: string; hold?: { reason: string; at: string; actor: string } | null };
type HoldState = { market?: { relations?: HoldRelation[] } };
export function relationHoldReason(state: HoldState, ref: { customerId?: string; supplierId?: string }): string {
  const r = (state.market?.relations || []).find(x => x.hold && ((ref.customerId && x.customerId === ref.customerId) || (ref.supplierId && x.supplierId === ref.supplierId)));
  return r?.hold ? `${r.name} 往来已冻结：${r.hold.reason}` : '';
}

/** 信用冻结下的出运放行：冻结客户的出运须有部门主管批准、尚未用过的「带风险放行」，每次批准只放行一票。 */
type ReleaseRisk = { id: string; signalKey?: string; state: string; release?: { escalationId: string; approvedBy: string; at: string; note: string; shipmentId?: string } };
export function heldShipmentRelease(state: HoldState & { platform?: { risks?: ReleaseRisk[] } }, customerId: string): { held: string; risk?: ReleaseRisk } {
  const r = (state.market?.relations || []).find(x => x.hold && x.customerId === customerId);
  if (!r?.hold) return { held: '' };
  const risk = (state.platform?.risks || []).find(x => x.signalKey === 'relation-hold:' + r.id && x.state !== 'Resolved' && !!x.release && !x.release.shipmentId);
  return { held: `${r.name} 往来已冻结：${r.hold.reason}`, risk };
}
