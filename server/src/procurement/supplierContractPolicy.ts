import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { isValidLocalDateKey } from '../shared/localDate';

export type SupplierContractKind = 'purchase' | 'processing';
export class SupplierContractError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) { super(message); this.name = 'SupplierContractError'; }
}
export const supplierFail = (code: string, message: string, status = 400): never => { throw new SupplierContractError(code, message, status); };
/** Historic reads remain available; generic agent/production approval cannot
 * substitute for an exact native supplier commitment or professional QC. */
export function legacySupplierMutation<Args extends unknown[], Result>(_historical: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
  return async (..._args) => supplierFail('NATIVE_SUPPLIER_COMMAND_REQUIRED', '采购与加工须使用独立合同工作区的准确版本审批和实际交接命令；历史单据保留只读。', 409);
}
export type SupplierLocation = { kind: 'supplier' | 'warehouse' | 'external'; relationId?: string; warehouseId?: string; name?: string; address: string };
export type SupplierContractLine = {
  id?: string; orderLineId: string; kind?: 'Material' | 'FinishedGoods'; category?: string; processType?: string;
  materialCode?: string; description: string; specification?: string; quantity: string; unit: string; unitPrice: string;
  amount: string; requestedDeliveryDate: string | null; notes?: string;
  demandId?: string; demandRevision?: number;
  costItemName?: string; includedInCmtPrice?: boolean; cmtIncludedItemsReviewed?: string[];
  inputSource?: { kind: 'purchase_contract'; contractId: string; lineId: string } | { kind: 'warehouse'; inventoryItemId: string }
    | { kind: 'customer_supplied'; relationId: string };
};
export type SupplierContractDraft = {
  contractKind: SupplierContractKind; supplierRelationId: string; currency: string; paymentTerms: string | null;
  mainDeliveryLocation: SupplierLocation | null; mainDeliveryLocationKey: string | null;
  orderDate: string; deliveryTerms?: string; notes?: string; lines: SupplierContractLine[]; totalAmount: string;
};
export const supplierObject = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function supplierText(value: unknown, label: string, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) return supplierFail('INVALID_INPUT', `请明确${label}。`);
  return value.trim();
}
export const supplierOptionalText = (value: unknown, label: string, max = 1000): string | undefined => value == null || value === '' ? undefined : supplierText(value, label, max);
export function supplierDecimal(value: unknown, label: string, zero = false): Prisma.Decimal {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value))
    return supplierFail('INVALID_QUANTITY', `${label}须为明确十进制字符串，最多14位整数和4位小数。`);
  const decimal = new Prisma.Decimal(value);
  if (zero ? decimal.lt(0) : decimal.lte(0)) return supplierFail('INVALID_QUANTITY', `${label}${zero ? '不能小于零' : '必须大于零'}。`);
  return decimal;
}
export function supplierDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isValidLocalDateKey(value)) return supplierFail('INVALID_INPUT', `请明确${label}（YYYY-MM-DD）。`);
  return value;
}
export function supplierCanonical(value: unknown): string {
  const normalized = (entry: unknown): unknown => {
    if (typeof entry === 'bigint') return entry.toString();
    if (entry instanceof Prisma.Decimal) return entry.toString();
    if (entry instanceof Date) return entry.toISOString();
    if (Array.isArray(entry)) return entry.map(normalized);
    if (entry !== null && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).filter(([, val]) => val !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, normalized(val)]));
    return entry;
  };
  return JSON.stringify(normalized(value));
}
export const supplierFingerprint = (value: unknown): string => createHash('sha256').update(supplierCanonical(value)).digest('hex');
export const supplierJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(supplierCanonical(value)) as Prisma.InputJsonValue;
export function normalizeSupplierLocation(value: unknown): SupplierLocation | null {
  if (value == null) return null;
  const row = supplierObject(value);
  if (row.kind !== 'supplier' && row.kind !== 'warehouse' && row.kind !== 'external') return supplierFail('INVALID_LOCATION', '主要交付地点须明确类型。');
  const result: SupplierLocation = { kind: row.kind, address: supplierText(row.address, '实际交付地址', 2000) };
  if (row.kind === 'supplier') result.relationId = supplierText(row.relationId, '交付供应商身份', 150);
  if (row.kind === 'warehouse') result.warehouseId = supplierText(row.warehouseId, '真实仓库', 150);
  if (row.kind === 'external') result.name = supplierText(row.name, '实际接收对象', 300);
  return result;
}
export function normalizeSupplierContractDraft(kind: SupplierContractKind, value: unknown): SupplierContractDraft {
  const input = supplierObject(value);
  if (kind !== 'purchase' && kind !== 'processing') return supplierFail('INVALID_CONTRACT_KIND', '采购与加工须选择明确独立类型。');
  const supplierRelationId = supplierText(input.supplierRelationId, '供应商', 150);
  const currency = supplierText(input.currency, '币种', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return supplierFail('INVALID_CURRENCY', '币种须为明确三位币种代码。');
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) return supplierFail('LINES_REQUIRED', '请选择1至100条准确来源需求。');
  const lines = input.lines.map((raw): SupplierContractLine => {
    const line = supplierObject(raw);
    const quantity = supplierDecimal(line.quantity, '本行数量'), price = supplierDecimal(line.unitPrice, '本行单价', true);
    const amount = quantity.mul(price).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    if (amount.gte('100000000000000')) return supplierFail('AMOUNT_OVERFLOW', '本行金额超过可记录范围。');
    if (kind === 'purchase' && line.kind != null && line.kind !== 'Material' && line.kind !== 'FinishedGoods') return supplierFail('CONTRACT_KIND_MISMATCH', '加工服务须独立创建加工合同，不能混入采购单。');
    const result: SupplierContractLine = {
      orderLineId: supplierText(line.orderLineId, '准确来源订单条目', 150), description: supplierText(line.description, '本行项目'),
      quantity: quantity.toString(), unit: supplierText(line.unit, '明确单位', 20).toUpperCase(), unitPrice: price.toString(), amount: amount.toString(),
      requestedDeliveryDate: line.requestedDeliveryDate == null || line.requestedDeliveryDate === '' ? null : supplierDate(line.requestedDeliveryDate, '本行要求交付日期'),
      ...(kind === 'purchase' ? { kind: line.kind === 'FinishedGoods' ? 'FinishedGoods' as const : 'Material' as const } : { processType: supplierText(line.processType, '加工工序', 100) }),
    };
    if (line.id != null) result.id = supplierText(line.id, '稳定单据行ID', 150);
    if (line.demandId != null) result.demandId = supplierText(line.demandId, '准确已确认需求', 150);
    if (line.demandRevision != null) {
      if (!Number.isSafeInteger(line.demandRevision) || Number(line.demandRevision) < 1) return supplierFail('DEMAND_CHANGED', '需求版本无效，请重新读取准确需求。', 409);
      result.demandRevision = Number(line.demandRevision);
    }
    for (const key of ['category', 'materialCode', 'specification', 'notes'] as const) {
      const text = supplierOptionalText(line[key], key); if (text !== undefined) result[key] = text;
    }
    if (line.costItemName != null) result.costItemName = supplierText(line.costItemName, '实际费用项目名称', 200);
    if (line.includedInCmtPrice !== undefined) {
      if (typeof line.includedInCmtPrice !== 'boolean') return supplierFail('CMT_SCOPE_REVIEW_REQUIRED', '请明确该实际项目是否已含在加工价内。');
      result.includedInCmtPrice = line.includedInCmtPrice;
    }
    if (line.cmtIncludedItemsReviewed !== undefined) {
      if (!Array.isArray(line.cmtIncludedItemsReviewed) || line.cmtIncludedItemsReviewed.length > 64) return supplierFail('CMT_SCOPE_REVIEW_REQUIRED', '请逐项核对来源条目实际 CMT 包含范围。');
      result.cmtIncludedItemsReviewed = line.cmtIncludedItemsReviewed.map(item => supplierText(item, '已核对 CMT 包含项目', 200));
    }
    if (kind === 'processing' && line.inputSource != null) {
      const source = supplierObject(line.inputSource);
      if (source.kind === 'purchase_contract') result.inputSource = { kind: source.kind, contractId: supplierText(source.contractId, '关联采购合同', 150), lineId: supplierText(source.lineId, '准确采购来源行', 150) };
      else if (source.kind === 'warehouse') result.inputSource = { kind: source.kind, inventoryItemId: supplierText(source.inventoryItemId, '准确库内实物', 150) };
      else if (source.kind === 'customer_supplied') result.inputSource = { kind: source.kind, relationId: supplierText(source.relationId, '真实供料需求方', 150) };
      else return supplierFail('INPUT_SOURCE_REQUIRED', '请明确加工所需原料的真实来源，不从物料名称推定。');
    }
    return result;
  });
  const ids = lines.flatMap(line => line.id ? [line.id] : []);
  if (new Set(ids).size !== ids.length) return supplierFail('DUPLICATE_LINE', '单据行ID不能重复。');
  const total = lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0));
  if (total.gte('100000000000000')) return supplierFail('AMOUNT_OVERFLOW', '合同金额超过可记录范围。');
  const location = normalizeSupplierLocation(input.mainDeliveryLocation);
  return { contractKind: kind, supplierRelationId, currency, paymentTerms: supplierOptionalText(input.paymentTerms, '付款条件') ?? null,
    mainDeliveryLocation: location, mainDeliveryLocationKey: location ? supplierFingerprint(location) : null,
    orderDate: supplierDate(input.orderDate, '下单日期'), lines, totalAmount: total.toString(),
    deliveryTerms: supplierOptionalText(input.deliveryTerms, '交付条款'), notes: supplierOptionalText(input.notes, '备注', 4000) };
}
export function assertSupplierCommonTermsReady(draft: SupplierContractDraft): void {
  if (!draft.paymentTerms || !draft.mainDeliveryLocation || !draft.mainDeliveryLocationKey) supplierFail('COMMON_TERMS_REQUIRED', '合单/提交前须明确付款条件和主要交付地点。');
}
export function assertSupplierContractsCompatible(first: SupplierContractDraft, second: SupplierContractDraft): void {
  assertSupplierCommonTermsReady(first); assertSupplierCommonTermsReady(second);
  if (first.contractKind !== second.contractKind) supplierFail('CONTRACT_KIND_MISMATCH', '采购和加工须分别成单。');
  for (const [field, label] of [['supplierRelationId', '供应商'], ['currency', '币种'], ['paymentTerms', '付款条件'], ['mainDeliveryLocationKey', '主要交付地点']] as const)
    if (first[field] !== second[field]) supplierFail('INCOMPATIBLE_CONTRACT', `${label}不同，不能合单。`, 409);
}
