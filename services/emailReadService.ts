import { getApiBaseUrl } from './apiBase';

/** Mail transport only: the caller supplies the existing ERP authentication headers. */
export const emailApiUrl = (path: string) => `${getApiBaseUrl().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
export async function emailRequestJson(path: string, init: RequestInit = {}, fetchImpl: typeof fetch = globalThis.fetch): Promise<any> {
  const response = await fetchImpl(emailApiUrl(path), { ...init, credentials: 'include' });
  if (!response.ok) throw Object.assign(new Error(`邮件请求未完成（HTTP ${response.status}），请重新核对。`), { status: response.status });
  let data: any;
  try { data = await response.json(); } catch { throw new Error('邮件响应格式不完整，请重新读取。'); }
  return data;
}
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export function checkedDbEmail(row: any, expectedId?: string) {
  if (!row || !text(row.id) || (expectedId !== undefined && row.id !== expectedId)
    || typeof row.subject !== 'string' || typeof row.fromAddress !== 'string'
    || !['inbound', 'outbound', 'draft'].includes(row.direction) || !text(row.mailbox)
    || !(row.bodyHtml === null || typeof row.bodyHtml === 'string') || !(row.bodyText === null || typeof row.bodyText === 'string')
    || !(row.sentAt === null || (typeof row.sentAt === 'string' && Number.isFinite(Date.parse(row.sentAt))))
    || !/^[1-9]\d*$/.test(String(row.createdAt)) || !Number.isFinite(new Date(Number(row.createdAt)).getTime())
    || !Array.isArray(row.attachments)) throw new Error('邮件记录未能完整核验，请重新读取。');
  for (const a of row.attachments) if (!a || !text(a.id) || !text(a.filename)
    || !(a.contentType === null || typeof a.contentType === 'string')
    || !Number.isSafeInteger(a.fileSize) || a.fileSize < 0) throw new Error('邮件附件记录不完整，请重新读取。');
  return row;
}
export async function fetchDbEmailDetail(id: string, headers: Record<string, string>, signal?: AbortSignal) {
  if (!text(id)) throw new Error('请先选择真实邮件记录。');
  const json = await emailRequestJson(`/v1/email/${encodeURIComponent(id)}`, { headers, signal });
  if (json?.ok !== true) throw new Error('邮件详情未能读取，请重新核对。');
  return checkedDbEmail(json.data, id);
}
export function checkedImapDetail(json: any, box: string, uid: string) {
  const row = json?.data;
  if (json?.status !== 'success' || !row || row.id !== `${box}-${uid}` || String(row.uid) !== uid || row.box !== box
    || typeof row.body !== 'string' || !Array.isArray(row.attachments)) throw new Error('邮箱正文来源未能核验，请重新读取。');
  for (const a of row.attachments) if (!a || !text(a.filename) || !Number.isSafeInteger(a.size) || a.size < 0)
    throw new Error('邮箱附件响应不完整，请重新读取。');
  return json;
}
export async function fetchImapEmailDetail(config: any, box: string, uid: string, headers: Record<string, string>, signal?: AbortSignal) {
  return checkedImapDetail(await emailRequestJson('/email/detail', { method: 'POST', headers, signal, body: JSON.stringify({ ...config, box, uid }) }), box, uid);
}
export async function fetchImapEmailPage(config: any, box: string, offset: number, limit: number, headers: Record<string, string>, signal?: AbortSignal) {
  const json = await emailRequestJson('/email/fetch', { method: 'POST', headers, signal, body: JSON.stringify({ ...config, box, offset, limit }) });
  if (json?.status !== 'success' || !Array.isArray(json.data) || !Number.isSafeInteger(json.total) || json.total < 0
    || json.data.length > limit || (json.data.length > 0 && offset + json.data.length > json.total)) throw new Error('邮箱分页响应不完整，请重新读取。');
  const ids = new Set<string>();
  for (const row of json.data) {
    if (!row || !text(row.id) || ids.has(row.id) || !/^[1-9]\d*$/.test(String(row.uid)) || row.id !== `${box}-${row.uid}`
      || row.box !== box || !text(row.realBox) || typeof row.sender !== 'string' || typeof row.subject !== 'string'
      || !Number.isFinite(Date.parse(row.date)) || !Array.isArray(row.attachments)) throw new Error('邮箱列表来源不完整，请重新读取。');
    ids.add(row.id);
  }
  return json as { status: 'success'; data: any[]; total: number };
}
