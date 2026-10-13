import { apiService } from './apiService';

export interface ClaimReturnBatch {
  receivedEventId: string; itemId: string; batchNumber?: string | null;
  quantity: string; unit: string; disposedEventIds: string[];
}
export interface ClaimReturnLine {
  id: string; claimDispositionId: string; materialCode: string; expectedQuantity: string;
  receivedQuantity: string; unit: string; disposition: string; status: string; actualBatches: ClaimReturnBatch[];
}
export interface ClaimReturnReceipt {
  id: string; receiptNumber: string; warehouseId: string; status: string; lines: ClaimReturnLine[];
}
export interface ClaimRepairInspection {
  id: string; inspectionNumber: string; result: string; inspectedQuantity: string; passedQuantity: string;
  unit: string; inspectionDate: string; defectSummary?: string | null;
}
export interface ClaimRepairOrder {
  id: string; dispositionId: string; workOrderNumber: string; status: string; quantity: string; unit: string;
  needsReinspection: boolean; reshipmentId?: string | null; inspections: ClaimRepairInspection[];
}
export interface ClaimStockBinding {
  shipmentId: string; shipmentStatus: string; currentRevision: number; revision: number;
  scope: { claimDispositionId: string; warehouseId: string; materialCode: string; quantity: string; unit: string };
  items: Array<{ itemId: string; quantity: string; unit: string; batchNumber?: string | null }>;
}

async function request(path: string, input?: object): Promise<any> {
  const url = apiService.buildApiUrl(`/v1/${path}`, apiService.getStoredConfig().cloudEndpoint);
  const response = await fetch(url, { method: input ? 'POST' : 'GET', headers: {
    ...apiService.getAuthHeaders(), ...(input ? { 'Content-Type': 'application/json' } : {}),
  }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.message || '售后履约请求未完成，请刷新核对后重试'), { status: response.status, code: data?.error });
  if (!data || typeof data !== 'object') throw Error('服务端结果尚未确认，请沿用原请求重试');
  return data;
}
const invalid = (): never => { throw Error('服务端结果尚未确认，请沿用原请求重试'); };
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const quantity = (value: unknown, allowZero = true) => (typeof value === 'string' || typeof value === 'number')
  && /^\d+(\.\d+)?$/.test(String(value)) && Number.isFinite(Number(value)) && (allowZero ? Number(value) >= 0 : Number(value) > 0);
const movements = (rows: any, expectedTypes: string[]) => Array.isArray(rows) && rows.length === expectedTypes.length
  && rows.every((row, index) => id(row?.id) && row.type === expectedTypes[index])
  && new Set(rows.map(row => row.id)).size === rows.length;
export const claimFulfillmentService = {
  async receipt(receiptId: string): Promise<ClaimReturnReceipt> {
    const { returnReceipt: receipt } = await request(`return-receipts/${encodeURIComponent(receiptId)}`);
    if (receipt?.id !== receiptId || !id(receipt.warehouseId) || !id(receipt.receiptNumber) || !Array.isArray(receipt.lines)) invalid();
    for (const line of receipt.lines) {
      if (!id(line.id) || !id(line.claimDispositionId) || !id(line.materialCode) || !id(line.unit)
        || !quantity(line.expectedQuantity, false) || !quantity(line.receivedQuantity) || !Array.isArray(line.actualBatches)) invalid();
      for (const batch of line.actualBatches) if (!id(batch.receivedEventId) || !id(batch.itemId) || !quantity(batch.quantity, false)
        || !id(batch.unit) || !Array.isArray(batch.disposedEventIds) || !batch.disposedEventIds.every(id)) invalid();
    }
    return receipt;
  },
  async repair(workOrderId: string): Promise<ClaimRepairOrder> {
    const { workOrder } = await request(`repair-work-orders/${encodeURIComponent(workOrderId)}`);
    if (workOrder?.id !== workOrderId || !id(workOrder.dispositionId) || !quantity(workOrder.quantity, false) || !id(workOrder.unit)
      || typeof workOrder.needsReinspection !== 'boolean' || !Array.isArray(workOrder.inspections)) invalid();
    for (const report of workOrder.inspections) if (!id(report.id) || !id(report.unit) || !quantity(report.inspectedQuantity, false)
      || !quantity(report.passedQuantity) || !['pass', 'conditional', 'fail'].includes(report.result)) invalid();
    return workOrder;
  },
  async stock(shipmentId: string): Promise<ClaimStockBinding> {
    const binding = await request(`claim-shipments/${encodeURIComponent(shipmentId)}/stock`);
    if (binding.shipmentId !== shipmentId || !['Draft', 'Booked', 'Loading', 'Shipped', 'Arrived', 'Cleared', 'Delivered', 'Cancelled'].includes(binding.shipmentStatus)
      || !Number.isInteger(binding.currentRevision) || binding.currentRevision < 0
      || binding.revision !== binding.currentRevision || !Array.isArray(binding.items) || !id(binding.scope?.claimDispositionId)
      || !id(binding.scope.warehouseId) || !id(binding.scope.materialCode) || !id(binding.scope.unit) || !quantity(binding.scope.quantity, false)
      || (binding.currentRevision === 0 ? binding.items.length !== 0 : binding.items.length === 0)) invalid();
    if (binding.items.some((item: any) => !id(item.itemId) || !id(item.unit) || !quantity(item.quantity, false))
      || new Set(binding.items.map((item: any) => item.itemId)).size !== binding.items.length) invalid();
    return binding;
  },
  /** Clear recovery only after the actual domain resource/event is acknowledged. */
  async submit(path: string, input: object): Promise<void> {
    const data = await request(path, input);
    const parts = path.split('/'), resourceId = decodeURIComponent(parts[1]), action = parts[2];
    if (typeof data.replayed !== 'boolean') invalid();
    if (parts[0] === 'return-receipt-lines') {
      if (!['receive', 'scrap'].includes(action) || data.line?.id !== resourceId || !id(data.returnReceipt?.id)
        || !id(action === 'receive' ? data.receivedEventId : data.disposedEventId)
        || !movements(data.movements, action === 'receive' ? ['Inbound', 'Lock'] : ['Unlock', 'Outbound'])) invalid();
    } else if (parts[0] === 'repair-work-orders') {
      if (action === 'inspections') { if (data.inspection?.repairWorkOrderId !== resourceId || !id(data.inspectionEventId)) invalid(); }
      else if (action === 'return-shipment') { if (!id(data.shipment?.id) || !id(data.returnShipmentEventId)) invalid(); }
      else if (data.workOrder?.id !== resourceId || !id(data.repairEventId)) invalid();
    } else if (parts[0] === 'claim-shipments') {
      if (data.shipmentId !== resourceId || !Number.isInteger(data.currentRevision) || data.currentRevision < 1 || !id(data.stockBindingEventId)) invalid();
    } else invalid();
  },
};
