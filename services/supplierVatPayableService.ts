import { apiService } from './apiService';
import { getAuthState, hasPermission, subscribe } from './authService';
import { runFinanceCommand, type PendingFinanceCommand } from './financeCommandRecovery';
import type { Invoice, VatInvoice } from '../types';
import { settlementAmountUnits } from '../lib/settlementMoney';
import { financeContextIdentity } from './financeContextIdentity';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';

export type SupplierVatAmountBasis = 'net' | 'gross';
export interface SupplierVatSelectedLine {
  contractKind: 'purchase' | 'processing';
  contractId: string;
  commitmentRevisionId: string;
  lineId: string;
  contractAmount: string;
}
export interface SupplierVatSelection {
  amountBasis: SupplierVatAmountBasis;
  dueDate: string | null;
  sources: SupplierVatSelectedLine[];
}
export interface SupplierVatCandidate extends Omit<SupplierVatSelectedLine, 'contractAmount'> {
  contractNumber: string;
  orderId: string;
  orderLineId: string;
  approvedLineAmount: string;
  paymentTerms: string | null;
  registeredAmount: string;
  remainingAmount: string;
  registeredAmountBasis: SupplierVatAmountBasis | null;
  selectable: boolean;
  unavailableReason?: string;
}
export interface SupplierVatSnapshot {
  schemaVersion: 1;
  sourceType: 'SupplierVatPayable';
  vatOriginal: { id: string; vatNumber: string; vatCode: string | null; relationId: string;
    sellerName: string; currency: string; netAmount: string; taxAmount: string; totalAmount: string };
  amountBasis: SupplierVatAmountBasis;
  dueDate: string | null;
  sources: Array<SupplierVatSelectedLine & { contractNumber: string; orderId: string; orderLineId: string;
    approvedLineAmount: string; paymentTerms: string | null }>;
  orderIds: string[];
  sourceFingerprint: string;
}
export interface SupplierVatPreview {
  snapshot: SupplierVatSnapshot;
  sourceFingerprint: string;
  vatUpdatedAt: string;
  capacities: Array<{ contractKind: string; contractId: string; lineId: string;
    approvedLineAmount: string; registeredAmount: string; remainingAmount: string }>;
}
export interface SupplierVatPayableOriginal {
  invoice: Invoice;
  vatInvoice: VatInvoice;
  snapshot: SupplierVatSnapshot;
  receipt: { invoiceId: string; vatInvoiceId: string; sourceFingerprint: string; requestKey: string };
}
const amount = (value: unknown): value is string => typeof value === 'string' && /^\d+(?:\.\d{1,4})?$/.test(value);
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const supplierVatLineKey = (row: Pick<SupplierVatSelectedLine, 'contractKind' | 'contractId' | 'lineId'>) =>
  `${row.contractKind}:${row.contractId}:${row.lineId}`;

export function supplierVatContext(endpoint?: string) {
  const auth = getAuthState(), base = endpoint ?? apiService.getStoredConfig().cloudEndpoint;
  if (!auth.isAuthenticated || !auth.user?.id) throw new Error('请登录后核对应付原票。');
  const headers = apiService.getAuthHeaders();
  return { base, headers, key: JSON.stringify([base, apiService.getStoredConfig().cloudEndpoint, headers, auth.user.id,
    auth.user.roles, auth.user.roleIds, auth.user.permissions, auth.user.permissionCeiling ?? null, auth.user.departmentIds ?? [], financeContextIdentity()]) };
}
function assertCurrent(session: ReturnType<typeof supplierVatContext>, endpoint?: string) {
  if (!hasPermission('invoices:read') || !hasPermission('vat:read') || supplierVatContext(endpoint).key !== session.key)
    throw new Error('账号、权限或服务地址已变化，请重新读取原票。');
}
async function read(path: string, endpoint?: string, body?: unknown): Promise<any> {
  const session = supplierVatContext(endpoint); assertCurrent(session, endpoint);
  const response = await fetch(apiService.buildApiUrl(`/v1/finance/supplier-vat-payables${path}`, session.base), {
    headers: { ...session.headers, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  assertCurrent(session, endpoint);
  const result = await response.json().catch(() => null); assertCurrent(session, endpoint);
  if (!response.ok) throw new Error(result?.error?.message || '供应商原票暂不可核对，请重新读取。');
  if (result?.ok !== true) throw new Error('原票回执未读实，请重新读取。');
  return result;
}
function checkedSnapshot(value: any, vatInvoiceId: string): SupplierVatSnapshot {
  if (value?.schemaVersion !== 1 || value.sourceType !== 'SupplierVatPayable'
    || value.vatOriginal?.id !== vatInvoiceId || !text(value.vatOriginal?.relationId)
    || !text(value.vatOriginal?.sellerName) || !text(value.vatOriginal?.vatNumber)
    || !/^[A-Z]{3}$/.test(value.vatOriginal?.currency ?? '')
    || !['netAmount', 'taxAmount', 'totalAmount'].every(key => amount(value.vatOriginal[key]))
    || !['net', 'gross'].includes(value.amountBasis) || !fingerprint(value.sourceFingerprint)
    || !Array.isArray(value.sources) || !value.sources.length || !Array.isArray(value.orderIds)
    || value.sources.some((line: any) => !['purchase', 'processing'].includes(line.contractKind)
      || !['contractId', 'commitmentRevisionId', 'lineId', 'contractNumber', 'orderId', 'orderLineId'].every(key => text(line[key]))
      || !amount(line.contractAmount) || !amount(line.approvedLineAmount))
    || new Set(value.sources.map(supplierVatLineKey)).size !== value.sources.length)
    throw new Error('原票与准确合同来源尚未核实，请重新核对。');
  return value;
}

export const supplierVatPayableService = {
  async sources(vatInvoiceId: string, options: { amountBasis: SupplierVatAmountBasis; search?: string; cursor?: string }, endpoint?: string) {
    const query = new URLSearchParams({ amountBasis: options.amountBasis, limit: '30' });
    if (options.search?.trim()) query.set('search', options.search.trim());
    if (options.cursor) query.set('cursor', options.cursor);
    const data = await read(`/${encodeURIComponent(vatInvoiceId)}/sources?${query}`, endpoint);
    if (!Array.isArray(data.items) || typeof data.hasMore !== 'boolean'
      || !(data.nextCursor === null || text(data.nextCursor)) || data.hasMore !== (data.nextCursor !== null)
      || data.items.some((line: any) => !['purchase', 'processing'].includes(line.contractKind)
        || !['contractId', 'commitmentRevisionId', 'lineId', 'contractNumber', 'orderId', 'orderLineId'].every(key => text(line[key]))
        || !['approvedLineAmount', 'registeredAmount'].every(key => amount(line[key]))
        || typeof line.remainingAmount !== 'string' || !/^-?\d+(?:\.\d{1,4})?$/.test(line.remainingAmount)
        || typeof line.selectable !== 'boolean' || ![null, 'net', 'gross'].includes(line.registeredAmountBasis))
      || new Set(data.items.map(supplierVatLineKey)).size !== data.items.length)
      throw new Error('已批准合同行清单未核实，请重新读取。');
    return data as { items: SupplierVatCandidate[]; nextCursor: string | null; hasMore: boolean };
  },
  async preview(vatInvoiceId: string, selection: SupplierVatSelection, endpoint?: string): Promise<SupplierVatPreview> {
    const data = await read(`/${encodeURIComponent(vatInvoiceId)}/preview`, endpoint, selection);
    checkedSnapshot(data.snapshot, vatInvoiceId);
    if (data.sourceFingerprint !== data.snapshot.sourceFingerprint || !/^\d+$/.test(data.vatUpdatedAt)
      || !Array.isArray(data.capacities) || data.capacities.length !== data.snapshot.sources.length)
      throw new Error('原票版本与已批来源尚未核实，请重新核对。');
    return data;
  },
  async original(vatInvoiceId: string, endpoint?: string): Promise<SupplierVatPayableOriginal> {
    const data = await read(`/${encodeURIComponent(vatInvoiceId)}`, endpoint);
    checkedSnapshot(data.snapshot, vatInvoiceId);
    if (!text(data.invoice?.id) || data.invoice.type !== 'Payable' || data.invoice.sourceType !== 'SupplierVatPayable'
      || data.invoice.sourceId !== vatInvoiceId || data.vatInvoice?.id !== vatInvoiceId || data.vatInvoice.invoiceId !== data.invoice.id
      || data.receipt?.invoiceId !== data.invoice.id || data.receipt.vatInvoiceId !== vatInvoiceId
      || data.receipt.sourceFingerprint !== data.snapshot.sourceFingerprint)
      throw new Error('原应付与供应商原票尚未核实，请核对原账。');
    return data;
  },
  async register(vatInvoiceId: string, selection: SupplierVatSelection, preview: SupplierVatPreview, endpoint?: string): Promise<Invoice> {
    checkedSnapshot(preview.snapshot, vatInvoiceId);
    const normalized: SupplierVatSelection = { amountBasis: selection.amountBasis, dueDate: selection.dueDate || null,
      sources: selection.sources.map(line => {
        const units = settlementAmountUnits(line.contractAmount);
        if (units === null || units <= 0n) throw new Error('本票合同行金额尚未明确。');
        return { contractKind: line.contractKind, contractId: line.contractId, commitmentRevisionId: line.commitmentRevisionId,
          lineId: line.lineId, contractAmount: `${units / 10000n}.${String(units % 10000n).padStart(4, '0')}` };
      }).sort((a, b) => supplierVatLineKey(a).localeCompare(supplierVatLineKey(b))) };
    const originalSelection = { amountBasis: preview.snapshot.amountBasis, dueDate: preview.snapshot.dueDate,
      sources: preview.snapshot.sources.map(({ contractKind, contractId, commitmentRevisionId, lineId, contractAmount }) => ({
        contractKind, contractId, commitmentRevisionId, lineId, contractAmount,
      })).sort((a, b) => supplierVatLineKey(a).localeCompare(supplierVatLineKey(b))) };
    if (JSON.stringify(normalized) !== JSON.stringify(originalSelection)) throw new Error('登记内容已偏离核对的原票来源，请重新核对。');
    return runFinanceCommand({ kind: 'supplier_vat_payable.register', targetId: vatInvoiceId,
      path: `/v1/finance/supplier-vat-payables/${encodeURIComponent(vatInvoiceId)}/register`, method: 'POST', permission: 'invoices:write',
      input: { ...normalized, expectedVatUpdatedAt: preview.vatUpdatedAt, expectedSourceFingerprint: preview.sourceFingerprint },
      hashExtra: { vatInvoiceId }, entity: 'invoice' }, endpoint);
  },
  watch(listener: () => void) {
    const stop = subscribe(listener); window.addEventListener('storage', listener); window.addEventListener('focus', listener); window.addEventListener(EMAIL_CONTEXT_EVENT, listener);
    return () => { stop(); window.removeEventListener('storage', listener); window.removeEventListener('focus', listener); window.removeEventListener(EMAIL_CONTEXT_EVENT, listener); };
  },
};

export const isSupplierVatPending = (row: PendingFinanceCommand, vatInvoiceId: string) =>
  row.record.payload.intent.kind === 'supplier_vat_payable.register' && row.record.payload.intent.targetId === vatInvoiceId;
