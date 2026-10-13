import { apiService } from './apiService';
import { getAuthState } from './authService';

type Recovery<T> = { version: 1; requestId: string; payload: T };
function cacheKey(operation: string, endpoint?: string) {
  const userId = getAuthState().user?.id;
  if (!userId) throw new Error('请重新登录后继续');
  const base = apiService.buildApiUrl('/v1', endpoint ?? apiService.getStoredConfig().cloudEndpoint);
  return `bambook:business-request:v1:${encodeURIComponent(base)}:${encodeURIComponent(userId)}:${encodeURIComponent(operation)}`;
}
const canonical = (value: unknown): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function readBusinessRequest<T>(operation: string, endpoint?: string): Recovery<T> | null {
  let value: string | null;
  try { value = localStorage.getItem(cacheKey(operation, endpoint)); } catch { throw new Error('无法读取上次请求，请恢复浏览器存储后重试'); }
  if (value == null) return null;
  try {
    const record = JSON.parse(value);
    if (record?.version !== 1 || typeof record.requestId !== 'string' || !record.requestId.trim() || record.requestId.length > 128
      || !record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) throw Error();
    return record;
  } catch { throw new Error('上次请求记录损坏，请先核对服务端状态，避免重复提交'); }
}
/** Recover only the current actor's requests for this endpoint and operation.
 * Cached data is an unresolved intent, never a server balance or approval fact. */
export function listBusinessRequests<T>(operationPrefix: string, endpoint?: string): Array<{ operation: string; record: Recovery<T> }> {
  const prefix = cacheKey('', endpoint), matching = prefix + encodeURIComponent(operationPrefix);
  const result: Array<{ operation: string; record: Recovery<T> }> = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(matching)) continue;
      const operation = decodeURIComponent(key.slice(prefix.length));
      const record = readBusinessRequest<T>(operation, endpoint);
      if (record) result.push({ operation, record });
    }
  } catch (error) { throw new Error('无法恢复待确认请求，请先核对服务端状态，避免重复提交', { cause: error }); }
  return result;
}
export function beginBusinessRequest<T extends object>(operation: string, payload: T, endpoint?: string): Recovery<T> {
  const prior = readBusinessRequest<T>(operation, endpoint);
  if (prior) {
    if (canonical(prior.payload) !== canonical(payload)) throw new Error('上次请求结果尚未确认，请恢复原内容后重试');
    return prior;
  }
  const record: Recovery<T> = { version: 1, requestId: crypto.randomUUID(), payload };
  try {
    localStorage.setItem(cacheKey(operation, endpoint), JSON.stringify(record));
    if (localStorage.getItem(cacheKey(operation, endpoint)) !== JSON.stringify(record)) throw Error();
  } catch { throw new Error('无法保存请求，请恢复浏览器存储后重试'); }
  return record;
}
/** Acknowledged server facts, not elapsed time, end recovery. */
export function clearAcknowledgedBusinessRequest(operation: string, requestId: string, endpoint?: string) {
  try { if (readBusinessRequest(operation, endpoint)?.requestId === requestId) localStorage.removeItem(cacheKey(operation, endpoint)); } catch { /* The server still enforces immutable request identity. */ }
}
