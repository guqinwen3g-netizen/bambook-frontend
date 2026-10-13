import { apiService } from './apiService';
import { getAuthState, hasPermission, subscribe } from './authService';
import { dashboardReadIdentity } from './dashboardTaskService';

type CostCommand = { requestKey: string; sourceType: string; sourceId: string; costType: string;
  amount: number | string; currency?: string; incurredAt?: string; notes?: string;
  shippingSource?: { kind: string; id: string; round: number; fingerprint: string } };
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, canonical(value[key])])) : value;
const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
function money(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const raw = String(value).trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(4, '0')}`;
}

/** A submitted request key belongs to its original actor/source. No automatic resubmission. */
export async function registerDevelopmentCostCommand(caseId: string, input: CostCommand, endpoint?: string,
  isCurrent: () => boolean = () => true): Promise<{ costRecord: any }> {
  const auth = getAuthState(), actorId = auth.user?.id;
  if (!auth.isAuthenticated || auth.isLoading || !actorId || !hasPermission('products:write'))
    throw new Error('当前账号没有登记开发支出的权限。');
  const originalIdentity = dashboardReadIdentity();
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  const accepted = JSON.parse(JSON.stringify({ sourceType: input.sourceType?.trim(), sourceId: input.sourceId?.trim(),
    costType: input.costType?.trim(), amount: input.amount, currency: input.currency?.trim(), incurredAt: input.incurredAt?.trim(),
    notes: input.notes?.trim() || undefined, ...(input.shippingSource ? { shippingSource: {
      ...input.shippingSource, id: input.shippingSource.id.trim() } } : {}) }));
  const requestKey = input.requestKey?.trim();
  if (!text(caseId) || !text(requestKey) || !money(input.amount)) throw new Error('开发支出来源、请求编号或金额尚未完整。');
  // Clone the submitted body as well as its expected receipt; caller form changes cannot rewrite either.
  const body = JSON.stringify(input);
  let invalidated = false;
  const observe = () => { try { if (!isCurrent() || dashboardReadIdentity() !== originalIdentity) invalidated = true; } catch { invalidated = true; } };
  const stop = subscribe(observe);
  const check = () => {
    observe();
    if (invalidated) throw new Error('账号、权限、后台或来源已变化，请保留原请求编号并核对原登记结果。');
  };
  if (typeof window !== 'undefined') { window.addEventListener('storage', observe); window.addEventListener('focus', observe); }
  try {
    check();
    const response = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/costs`, base), {
      method: 'POST', headers: { ...apiService.getAuthHeaders(), 'Content-Type': 'application/json' }, body,
    });
    check();
    const data = await response.json();
    check();
    if (!response.ok) throw Object.assign(new Error(data?.error?.message || '费用登记未完成，请保留原请求编号核对。'), {
      status: response.status, code: data?.error?.code,
    });
    const row = data?.costRecord, ack = row?.commandAck;
    if (!row || !text(row.id) || row.deletedAt != null || row.bearerType !== 'internal'
      || row.sourceType !== accepted.sourceType || row.sourceId !== accepted.sourceId || row.costType !== accepted.costType
      || row.currency !== accepted.currency || row.incurredAt !== accepted.incurredAt || money(row.amount) !== money(accepted.amount)
      || (row.notes?.trim() || undefined) !== accepted.notes
      || ack?.caseId !== caseId || ack.actorId !== actorId || ack.requestKey !== requestKey || ack.costRecordId !== row.id
      || !text(ack.auditId) || !/^[a-f0-9]{64}$/.test(ack.requestFingerprint) || !same(ack.inputSnapshot, accepted))
      throw new Error('开发支出回执与原账号、费用或来源不一致，请保留原请求编号核对。');
    const source = row.developmentShippingSource?.source;
    if (accepted.shippingSource ? !source || row.developmentShippingSource.registrationAuditId !== ack.auditId
      || source.caseId !== caseId || source.batchId !== accepted.sourceId
      || !same({ kind: source.kind, id: source.id, round: source.round, fingerprint: source.fingerprint }, accepted.shippingSource)
      : row.developmentShippingSource != null)
      throw new Error('寄样费用回执缺少本次准确寄样依据，请保留原请求编号核对。');
    return data;
  } finally {
    stop();
    if (typeof window !== 'undefined') { window.removeEventListener('storage', observe); window.removeEventListener('focus', observe); }
  }
}
