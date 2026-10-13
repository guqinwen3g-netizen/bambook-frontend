import { apiService } from './apiService';
export type FulfillmentMode = 'cmt' | 'trims_cmt' | 'full_package';
export interface InternalPersonnel { canWrite: boolean; creatorFamilies: string[]; teams: { id: string; name: string; businessFamily: string | null; businessFamilies?: string[]; members: { id: string; name: string }[] }[] }
export interface FabricAllocation { id: string; fabricOrderId: string; fabricOrderLineId: string; garmentOrderId: string; garmentOrderLineId: string; metres: string; revision: number; status: 'active' | 'cancelled'; auditId: string }
export interface FabricAllocationContext { orderId: string; lineId: string; fulfillmentMode: FulfillmentMode | null; cmtIncludedItems: string[] | null; canWrite: boolean; allocation: FabricAllocation | null;
  outgoingAllocations?: FabricAllocation[]; sourceQuantity?: string; remaining?: string;
  candidates: { orderId: string; code: string | null; lineId: string; itemNo: string; description: string | null; quantity: string; allocated: string; remaining: string; internalPurpose: string }[] }
export type AllocationCommand = { requestKey: string; fabricOrderLineId: string; metres: string; expectedRevision: number };
export type AllocationResult = { allocation: FabricAllocation; commandAck: { protocolVersion: 1; actorId: string; requestKey: string; allocationId: string; revision: number; auditId: string; fabricOrderLineId: string; garmentOrderLineId: string; metres: string; status: string } };
const base = (orderId: string, lineId: string) => `/v1/orders/${encodeURIComponent(orderId)}/lines/${encodeURIComponent(lineId)}`;
async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(apiService.buildApiUrl(path), { method: body === undefined ? 'GET' : 'POST', headers: apiService.getAuthHeaders(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(value?.error?.message || value?.message || `操作未完成（HTTP ${response.status}）`), { status: response.status });
  if (value?.ok !== true || !value.data) throw new Error('结果暂时无法核对，请保留原请求重新核对。');
  return value.data;
}
export async function getInternalPersonnel(): Promise<InternalPersonnel> { return await request('/v1/orders/internal-demand/personnel') as InternalPersonnel; }
export async function getFabricAllocationContext(orderId: string, lineId: string): Promise<FabricAllocationContext> {
  const data = await request(`${base(orderId, lineId)}/fabric-allocation-context`) as FabricAllocationContext;
  if (data.orderId !== orderId || data.lineId !== lineId || !Array.isArray(data.candidates)) throw new Error('材料来源读回身份不符，请重新打开条目。');
  return data;
}
function checked(data: AllocationResult, key: string, lineId: string, status: string, allocationId?: string): AllocationResult {
  const ack = data?.commandAck, row = data?.allocation;
  if (!ack || ack.protocolVersion !== 1 || ack.requestKey !== key || !ack.auditId || !row?.id
    || ack.allocationId !== row.id || allocationId && row.id !== allocationId || ack.revision !== row.revision || ack.auditId !== row.auditId
    || ack.garmentOrderLineId !== lineId || row.garmentOrderLineId !== lineId || ack.status !== status || row.status !== status
    || ack.metres !== row.metres || ack.fabricOrderLineId !== row.fabricOrderLineId) throw new Error('原分配回执无法核对，请保留原请求重新核对。');
  return data;
}
export async function allocateInternalFabric(orderId: string, lineId: string, command: AllocationCommand): Promise<AllocationResult> {
  const data = checked(await request(`${base(orderId, lineId)}/fabric-allocations`, command) as AllocationResult, command.requestKey, lineId, 'active');
  const decimal = (value: string) => { const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(value.trim()); if (!match) return null; const fraction = (match[2] ?? '').replace(/0+$/, ''); return `${match[1].replace(/^0+/, '') || '0'}${fraction ? '.' + fraction : ''}`; };
  if (data.commandAck.fabricOrderLineId !== command.fabricOrderLineId || data.allocation.garmentOrderId !== orderId
    || decimal(command.metres) !== decimal(data.allocation.metres) || data.commandAck.revision !== command.expectedRevision + 1) throw new Error('原分配来源或米数无法核对，请保留请求。');
  return data;
}
export async function cancelInternalFabric(row: FabricAllocation, command: { requestKey: string; expectedRevision: number }): Promise<AllocationResult> {
  const data = checked(await request(`/v1/fabric-allocations/${encodeURIComponent(row.id)}/cancel`, command) as AllocationResult, command.requestKey, row.garmentOrderLineId, 'cancelled', row.id);
  if (data.commandAck.revision !== command.expectedRevision + 1 || data.commandAck.metres !== row.metres || data.commandAck.fabricOrderLineId !== row.fabricOrderLineId) throw new Error('原取消分配依据无法核对，请保留请求。');
  return data;
}
