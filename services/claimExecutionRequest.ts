/** Request recovery cache only. Approval, execution and money remain server facts. */
export type ClaimExecutionParameters = { warehouseId?: string; workStationId?: string; sourceShipmentId?: string; notes?: string };
export type ClaimExecutionRequest = { version: 1; clientRequestId: string; parameters: ClaimExecutionParameters };
export type ClaimExecutionIdentity = { userId: string; endpoint: string; dispositionId: string };

function key(identity: ClaimExecutionIdentity) {
  if (!identity.userId || !identity.endpoint || !identity.dispositionId) throw new Error('请登录并确认当前测试环境后再执行');
  return `bambook:claim-execution:v1:${encodeURIComponent(identity.endpoint)}:${encodeURIComponent(identity.userId)}:${encodeURIComponent(identity.dispositionId)}`;
}
function canonical(parameters: ClaimExecutionParameters) {
  return JSON.stringify(['warehouseId', 'workStationId', 'sourceShipmentId', 'notes'].map(field => parameters[field as keyof ClaimExecutionParameters] ?? null));
}
export function readClaimExecutionRequest(identity: ClaimExecutionIdentity): ClaimExecutionRequest | null {
  let raw: string | null;
  try { raw = localStorage.getItem(key(identity)); } catch { throw new Error('无法读取上次执行记录，请恢复浏览器存储后重试'); }
  if (raw == null) return null;
  try {
    const record = JSON.parse(raw);
    if (record?.version !== 1 || typeof record.clientRequestId !== 'string' || !record.clientRequestId.trim() || record.clientRequestId.length > 200
      || !record.parameters || typeof record.parameters !== 'object' || Array.isArray(record.parameters)
      || Object.entries(record.parameters).some(([field, value]) => !['warehouseId', 'workStationId', 'sourceShipmentId', 'notes'].includes(field) || typeof value !== 'string')) throw Error();
    return record;
  } catch { throw new Error('上次执行记录无法读取，请先核对服务端处置状态，避免重复执行'); }
}
export function beginClaimExecutionRequest(identity: ClaimExecutionIdentity, parameters: ClaimExecutionParameters): ClaimExecutionRequest {
  const previous = readClaimExecutionRequest(identity);
  if (previous) {
    if (canonical(previous.parameters) !== canonical(parameters)) throw new Error('上次执行结果尚未确认，请恢复原执行资源并重试核对');
    return previous;
  }
  const record: ClaimExecutionRequest = { version: 1, clientRequestId: crypto.randomUUID(), parameters };
  try {
    localStorage.setItem(key(identity), JSON.stringify(record));
    if (localStorage.getItem(key(identity)) !== JSON.stringify(record)) throw Error();
  } catch { throw new Error('无法保存执行请求，请恢复浏览器存储后重试'); }
  return record;
}
/** Call only after reading the server's terminal disposition status. */
export function clearConfirmedClaimExecutionRequest(identity: ClaimExecutionIdentity) {
  try { localStorage.removeItem(key(identity)); } catch { /* Retaining a known request is safe; server rejects new execution of a terminal disposition. */ }
}
