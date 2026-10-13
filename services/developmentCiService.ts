import { apiService } from './apiService';
import { getAuthState, hasPermission, subscribe } from './authService';

export type DevelopmentCiFields = { issueDate: string; dueDate?: string | null; paymentTerms?: string; note: string;
  billTo: { name: string; address: string }; exporter: { nameEn: string; addressEn: string; beneficiary?: string;
    bankName?: string; swiftCode?: string; bankAddress?: string; usdAccountNumber?: string } };
export type DevelopmentCiCommand = { action: 'save' | 'issue'; requestKey: string; billingItemId: string; documentId?: string;
  expectedVersion: number; expectedSourceFingerprint: string; fields?: DevelopmentCiFields };
export type DevelopmentCiSource = { caseId: string; billingItemId: string; sourceFingerprint: string; totalAmount: string; currency: string;
  costs: Array<{ id: string; costType: string; sourceType: string; sourceId: string; amount: string; currency: string; incurredAt: string; notes?: string | null }>;
  totals: Array<{ currency: string; amount: string }>; suggestedFields: DevelopmentCiFields; document: any | null };
export type DevelopmentFinanceProjection = { caseId: string; customerRelationId: string; items: any[]; legacy: any[] };
export type DevelopmentSupplementalBillingScope = { caseId: string; canSupplement: boolean; sourceFingerprint: string;
  occupiedCount: number; costs: DevelopmentCiSource['costs']; totals: DevelopmentCiSource['totals'];
  issued: Array<{ documentId: string; versionId: string; snapshotFingerprint: string }> };
export type DevelopmentSupplementalBillingCommand = { requestKey: string; expectedSourceFingerprint: string;
  costRecordIds: string[]; amount: string; waivedAmount: string; currency: string; note: string };
export class DevelopmentCiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const segment = encodeURIComponent;
export function developmentCiContext() {
  const auth = getAuthState(), base = apiService.getStoredConfig().cloudEndpoint, headers = apiService.getAuthHeaders();
  if (!auth.isAuthenticated || !auth.user?.id) throw new DevelopmentCiError('请重新登录后核对开发 CI。', 401);
  const identity = [base, auth.user.id, auth.user.roles, auth.user.roleIds, auth.user.permissions, auth.user.permissionCeiling ?? null];
  return { base, headers, userId: auth.user.id, key: JSON.stringify([headers, identity]), storageKey: JSON.stringify(identity) };
}
function current(context: ReturnType<typeof developmentCiContext>, permission: string) {
  if (!hasPermission(permission as any) || developmentCiContext().key !== context.key) throw new DevelopmentCiError('账号、权限或服务地址已变化，请重新读取原票。', 403);
}
async function call(path: string, body?: unknown, permission = 'products:read') {
  const context = developmentCiContext(); current(context, permission);
  const response = await fetch(apiService.buildApiUrl(path, context.base), { method: body === undefined ? 'GET' : 'POST',
    headers: { ...context.headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  current(context, permission);
  const data = await response.json().catch(() => null);
  current(context, permission);
  if (!response.ok) throw new DevelopmentCiError(data?.error?.message || '操作未完成，请核对原票。', response.status);
  if (!data || data.error) throw new DevelopmentCiError('回执未确认，请保留原请求重试。', 0);
  return data;
}
const money = (value: any) => typeof value === 'string' && /^\d+(?:\.\d{1,4})?$/.test(value);
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
async function hash(value: any) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value))));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const trim = (value: any) => typeof value === 'string' ? value.trim() : '';
function fixedMoney(value: string) {
  if (!money(value)) throw new DevelopmentCiError('请填写最多四位小数的明确金额。', 400);
  const [whole, fraction = ''] = value.split('.'); return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(4, '0')}`;
}
function normalized(command: DevelopmentCiCommand) {
  const input = command.fields;
  return { action: command.action, requestKey: trim(command.requestKey), billingItemId: trim(command.billingItemId),
    expectedVersion: command.expectedVersion, expectedSourceFingerprint: trim(command.expectedSourceFingerprint),
    documentId: command.documentId == null ? null : trim(command.documentId), fields: command.action === 'issue' ? null : {
      issueDate: trim(input?.issueDate), dueDate: trim(input?.dueDate) || null, paymentTerms: trim(input?.paymentTerms), note: trim(input?.note),
      billTo: { name: trim(input?.billTo.name), address: trim(input?.billTo.address) }, exporter: {
        ...Object.fromEntries(['nameEn', 'addressEn', 'beneficiary', 'bankName', 'swiftCode', 'bankAddress', 'usdAccountNumber'].map(key => [key, trim((input?.exporter as any)?.[key])])),
      } } };
}
export const developmentCiService = {
  watch: subscribe,
  async uncoveredCosts(caseId: string): Promise<DevelopmentSupplementalBillingScope> {
    const data = await call(`/v1/development/${segment(caseId)}/ci-uncovered-costs`);
    if (data.caseId !== caseId || typeof data.canSupplement !== 'boolean' || !/^[a-f0-9]{64}$/.test(data.sourceFingerprint)
      || !Number.isSafeInteger(data.occupiedCount) || data.occupiedCount < 0 || !Array.isArray(data.costs) || !Array.isArray(data.totals)
      || data.costs.some((row: any) => !row.id || !money(row.amount) || !row.sourceType || !row.sourceId)
      || new Set(data.costs.map((row: any) => row.id)).size !== data.costs.length
      || !Array.isArray(data.issued) || data.issued.some((row: any) => !row.documentId || !row.versionId))
      throw new DevelopmentCiError('补充收费的未覆盖费用尚未读实。', 0);
    return data;
  },
  async supplement(caseId: string, command: DevelopmentSupplementalBillingCommand) {
    const context = developmentCiContext();
    const normalized = { requestKey: trim(command.requestKey), expectedSourceFingerprint: trim(command.expectedSourceFingerprint),
      costRecordIds: command.costRecordIds.map(trim).sort(), amount: fixedMoney(trim(command.amount)),
      waivedAmount: fixedMoney(trim(command.waivedAmount)), currency: command.currency, note: trim(command.note) };
    const commandHash = await hash(normalized); current(context, 'products:write');
    const data = await call(`/v1/development/${segment(caseId)}/ci-supplemental-billings`, command, 'products:write');
    current(context, 'products:write');
    const receipt = data.receipt;
    if (typeof data.replayed !== 'boolean' || receipt?.operation !== 'create_development_supplemental_billing'
      || receipt.caseId !== caseId || receipt.actorId !== context.userId || receipt.requestKey !== command.requestKey
      || receipt.commandHash !== commandHash || receipt.expectedSourceFingerprint !== command.expectedSourceFingerprint
      || JSON.stringify(receipt.costRecordIds) !== JSON.stringify(normalized.costRecordIds) || !receipt.auditId || !receipt.billingItemId
      || data.billingItem?.id !== receipt.billingItemId || data.billingItem?.sourceType !== 'DevelopmentCase' || data.billingItem?.sourceId !== caseId)
      throw new DevelopmentCiError('补充收费原请求回执尚未确认，请保留原内容重试。', 0);
    return data;
  },
  async source(caseId: string, billingId: string): Promise<DevelopmentCiSource> {
    const data = await call(`/v1/development/${segment(caseId)}/ci-source/${segment(billingId)}`);
    if (data.caseId !== caseId || data.billingItemId !== billingId || !/^[a-f0-9]{64}$/.test(data.sourceFingerprint)
      || !money(data.totalAmount) || !Array.isArray(data.costs) || !Array.isArray(data.totals) || !data.suggestedFields?.billTo || !data.suggestedFields?.exporter)
      throw new DevelopmentCiError('开发 CI 来源回执不完整，请重新读取。', 0);
    return data;
  },
  async projection(caseId: string): Promise<DevelopmentFinanceProjection> {
    const data = await call(`/v1/development/${segment(caseId)}/ci-finance`);
    if (data.caseId !== caseId || !Array.isArray(data.items) || !Array.isArray(data.legacy)
      || data.items.some((row: any) => !row.documentId || !row.versionId || !money(row.amount) || !Array.isArray(row.receipts)
        || row.invoice && (!money(row.invoice.appliedAmount) || !money(row.invoice.openAmount))))
      throw new DevelopmentCiError('账款余额尚未读实，请重新读取。', 0);
    return data;
  },
  async command(caseId: string, command: DevelopmentCiCommand) {
    const context = developmentCiContext(), commandHash = await hash(normalized(command)); current(context, 'products:write');
    const data = await call(`/v1/development/${segment(caseId)}/ci-commands`, command, 'products:write');
    current(context, 'products:write');
    const receipt = data.receipt;
    if (typeof data.replayed !== 'boolean' || receipt?.caseId !== caseId || receipt?.requestKey !== command.requestKey
      || receipt.billingItemId !== command.billingItemId || receipt.action !== command.action || receipt.version !== command.expectedVersion + 1
      || receipt.commandHash !== commandHash || receipt.actorId !== context.userId || !receipt.auditId
      || !receipt.documentId || data.document?.document?.id !== receipt.documentId || data.document?.version?.documentId !== receipt.documentId
      || command.documentId != null && receipt.documentId !== command.documentId
      || data.document?.version?.id !== receipt.versionId || data.document?.version?.version !== receipt.version
      || data.document?.snapshot?.sourceFingerprint !== command.expectedSourceFingerprint
      || Boolean(data.document?.snapshot?.issuedAt) !== (command.action === 'issue'))
      throw new DevelopmentCiError('原操作回执未确认，请保留原请求重试。', 0);
    return data;
  },
  async pending() {
    const data = await call('/v1/finance/development-ci-pending', undefined, 'invoices:read');
    if (!Array.isArray(data.items) || data.items.some((row: any) => row.sourceKind !== 'development' || !row.caseId || !row.documentId
      || !row.versionId || !money(row.amount))) throw new DevelopmentCiError('待登记开发 CI 来源未确认。', 0);
    return data.items;
  },
  async register(documentId: string, command: { requestKey: string; expectedVersionId: string }) {
    const context = developmentCiContext();
    const data = await call(`/v1/finance/development-ci/${segment(documentId)}/register`, command, 'invoices:write');
    current(context, 'invoices:write');
    const originalHash = data.receipt?.requestKey && await hash({ documentId, versionId: command.expectedVersionId, requestKey: data.receipt.requestKey });
    current(context, 'invoices:write');
    if (typeof data.replayed !== 'boolean' || data.receipt?.documentId !== documentId || data.receipt?.versionId !== command.expectedVersionId
      || !data.receipt.auditId || !data.receipt.requestKey || data.receipt.commandHash !== originalHash
      || !data.replayed && data.receipt.requestKey !== command.requestKey || data.invoice?.id !== data.receipt.invoiceId
      || data.invoice?.sourceType !== 'BusinessDevelopmentCI' || data.invoice?.sourceId !== command.expectedVersionId
      || !['Issued', 'PartiallyPaid', 'Paid'].includes(data.invoice?.status)) throw new DevelopmentCiError('原登记回执尚未确认，请重试原请求。', 0);
    return data;
  },
  async preview(caseId: string, documentId: string, version: number) {
    const context = developmentCiContext(); current(context, 'products:read');
    const response = await fetch(apiService.buildApiUrl(`/v1/development/${segment(caseId)}/ci/${segment(documentId)}/preview.html?version=${version}`, context.base), { headers: context.headers });
    current(context, 'products:read');
    if (!response.ok) throw new DevelopmentCiError((await response.json().catch(() => null))?.error?.message || '原票暂不可读取。', response.status);
    const html = await response.text(); current(context, 'products:read');
    if (!response.headers.get('content-type')?.includes('text/html') || !/COMMERCIAL INVOICE/i.test(html)) throw new DevelopmentCiError('原票预览回执尚未确认。', 0);
    return html;
  },
  async file(caseId: string, documentId: string, version: number, kind: 'preview.html' | 'render.pdf', name: string) {
    const context = developmentCiContext(); current(context, 'products:read');
    const response = await fetch(apiService.buildApiUrl(`/v1/development/${segment(caseId)}/ci/${segment(documentId)}/${kind}?version=${version}`, context.base), { headers: context.headers });
    current(context, 'products:read');
    if (!response.ok) throw new DevelopmentCiError((await response.json().catch(() => null))?.error?.message || '原票暂不可读取。', response.status);
    const blob = await response.blob(); current(context, 'products:read');
    const href = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = href; anchor.download = name;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
  },
};
