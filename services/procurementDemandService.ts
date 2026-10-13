import type { PurchaseLineKind } from '../types';
import { apiService } from './apiService';
import { supplierSession, supplierSessionCurrent, type SupplierSession } from './supplierContractService';
export type ProcurementDemandAllocation = { id: string; quantity: string; purchaseOrderId: string | null; purchaseLineId?: string | null;
  outsourcingOrderId?: string | null; outsourcingLineId?: string | null; poNumber?: string | null; contractNumber?: string | null;
  contractKind?: 'purchase' | 'processing'; nativeContract?: boolean; supplierName: string | null; status: string };
export interface ProcurementDemand {
  kind?: PurchaseLineKind;
  sourceKey?: string;
  id: string; orderId: string; orderLineId: string | null; bomId: string | null; bomLineId: string | null;
  description: string; specification?: string | null; unit: string; requiredQuantity: string | null;
  allocatedQuantity: string; remainingQuantity: string | null; status: string; assigneeId: string | null;
  revision: number; blockReason?: string | null;
  allocations: ProcurementDemandAllocation[];
}
export class ProcurementDemandHttpError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name='ProcurementDemandHttpError'; }
}
async function request<T>(path: string, body?: unknown, original: SupplierSession = supplierSession()): Promise<T> {
  const check = () => { if (!supplierSessionCurrent(original)) throw new Error('账号、权限或数据中心已变化，请重新读取采购需求。'); }; check();
  const res = await fetch(apiService.buildApiUrl(`/v1/procurement/demands${path}`, original.endpoint), {
    method: body === undefined ? 'GET' : 'POST', headers: original.headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  check(); const data = await res.json().catch(() => null); check();
  if (!data) throw new Error('采购服务暂时不可用，请稍后重试');
  if (!res.ok) throw new ProcurementDemandHttpError(data?.error?.message || (typeof data?.error === 'string' ? data.error : '采购需求操作失败，请重试'), res.status, data?.error?.code);
  return data;
}
export const procurementDemandService = {
  list: (offset=0) => request<{ items: ProcurementDemand[]; total?:number; hasMore?:boolean }>(`?offset=${offset}&limit=100`),
  async create(body: {kind?:PurchaseLineKind; orderId:string; orderLineId:string; description:string; unit:string; requestKey:string}) {
    const original = supplierSession(), result = await request<{demand:ProcurementDemand}>('', body, original), demand = result.demand;
    // This endpoint predates commandAck. Its persisted manual source key binds
    // the real current actor and original request, even after later claiming.
    if (!demand || typeof demand.id !== 'string' || !demand.id.trim() || demand.orderId !== body.orderId
      || demand.sourceKey !== `manual:${original.actorId}:${body.requestKey}` || !Number.isSafeInteger(demand.revision) || !Array.isArray(demand.allocations))
      throw new Error('新建需求回执未绑定原准确来源和原请求，请保留原内容核对。');
    return result;
  },
  claim: (id:string, revision:number) => request<{demand:ProcurementDemand}>(`/${encodeURIComponent(id)}/claim`,{revision}),
  release: (id:string, body:{revision:number;reason:string}) => request<{demand:ProcurementDemand}>(`/${encodeURIComponent(id)}/release`,body),
  confirm: (id:string, body:{revision:number; orderLineId:string; requiredQuantity:string}) => request<{demand:ProcurementDemand}>(`/${encodeURIComponent(id)}/confirm`,body),
  /** Historical signature retained for stored intents; new allocations are saved with an exact native contract revision. */
  allocate: async (_id:string, _body:{revision:number; requestKey:string; supplierRelationId:string; quantity:string; unitPrice:string; currency:string}): Promise<{demand:ProcurementDemand; purchaseOrder:{id:string;poNumber:string}}> => {
    throw new ProcurementDemandHttpError('旧分配入口已关闭。请核对历史结果，再从已确认需求建立准确采购或加工合同草稿。', 409, 'NATIVE_SUPPLIER_CONTRACT_REQUIRED');
  },
};
