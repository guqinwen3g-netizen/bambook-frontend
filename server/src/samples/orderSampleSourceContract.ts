import { createHash } from 'node:crypto';
import { assertProductionLineIdentity } from '../production/productionLineIdentity';
import { isValidLocalDateKey } from '../shared/localDate';


/** Pure order-domain facts only. Callers must obtain actual parents and audit
 * records from trusted storage; this module does not authenticate them. */
export type OrderSampleFamily = 'fabric_ss' | 'fabric_rc' | 'fabric_eps' | 'garment_pp' | 'garment_top' | 'garment_ship';
export type OrderSampleUnit = 'M' | 'YD' | 'PC' | 'KG';
/** Caller-supplied persistence classification, never inferred/authenticated by
 * this pure module. Historical modes cannot restore native event eligibility. */
export type OrderSampleProvenance = 'native_new' | 'current_link_recorded' | 'legacy_recorded';
export type OrderSampleJson = null | boolean | number | string | OrderSampleJson[] | { [key: string]: OrderSampleJson };
export type OrderSampleOwner = { orderId: string; businessLine: 'fabric' | 'garment'; factoryRelationId: string };
export type OrderSampleMeasure = { quantity: string; unit: OrderSampleUnit; cuttingDate: string };
export type OrderSampleCoverage = {
  orderId: string; orderLineId: string; factoryRelationId: string;
  scopeKind: 'order_line' | 'production_batch'; productionBatchId: string | null; productionBatchRevision: number | null;
  rangeStart: string; quantity: string; unit: OrderSampleUnit; lineQuantity: string;
  batchRangeStart: string | null; batchQuantity: string | null; specFingerprint: string; sourceFingerprint: string; lineFingerprint: string;
  materialProof?: OrderSampleJson;
  productionLineIdentity?: OrderSampleJson;
};
export type OrderSampleSource = {
  domain: 'order'; sourceId: string; sampleId: string; family: OrderSampleFamily; owner: OrderSampleOwner;
  chainId: string; round: number; previousSourceId: string | null; provenance: OrderSampleProvenance;
  specSnapshot: OrderSampleJson; sampleFacts: OrderSampleMeasure; coverage: OrderSampleCoverage[];
  contentFingerprint: string; coverageFingerprint: string;
};
export type OrderSampleLineSnapshot = {
  id: string; orderId: string; factoryRelationId: string; quantity: string; unit: string;
  /** lineFingerprint is the real line read token, not an invented revision.
   * sourceFingerprint is the neutral batch-compatible origin token. */
  specSnapshot: OrderSampleJson; sourceFingerprint: string; lineFingerprint: string;
  materialProof?: OrderSampleJson;
};
export type OrderSampleBatchSnapshot = {
  id: string; orderId: string; orderLineId: string; factoryRelationId: string;
  rangeStart: string; quantity: string; unit: string; revision: number; state: string;
  specSnapshot: OrderSampleJson; sourceFingerprint: string;
  productionLineIdentity?: OrderSampleJson;
};
export type OrderSampleCoverageRequest = {
  orderLineId: string; expectedLineFingerprint: string; productionBatchId?: string | null; expectedBatchRevision?: number | null;
  rangeStart: string; quantity: string; unit: string;
};
export type OrderSampleSourceInput = {
  domain: 'order'; sourceId: string; sampleId: string; family: OrderSampleFamily; owner: OrderSampleOwner;
  chainId: string; round: number; previousSourceId: string | null; provenance: OrderSampleProvenance;
  specSnapshot: OrderSampleJson; sampleFacts: { quantity: string; unit: string; cuttingDate: string };
  coverage: OrderSampleCoverageRequest[]; lines: OrderSampleLineSnapshot[]; batches: OrderSampleBatchSnapshot[];
};

export class OrderSampleContractError extends Error {
  readonly code = 'ORDER_SAMPLE_CONTRACT_INVALID';
  constructor(message: string) { super(message); this.name = 'OrderSampleContractError'; }
}
function reject(message: string): never { throw new OrderSampleContractError(message); }
const families: Record<OrderSampleFamily, OrderSampleOwner['businessLine']> = {
  fabric_ss: 'fabric', fabric_rc: 'fabric', fabric_eps: 'fabric', garment_pp: 'garment', garment_top: 'garment', garment_ship: 'garment',
};
function object(value: unknown, keys: string[], label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject(`${label}须为明确对象。`);
  if (Object.keys(value).some(key => !keys.includes(key))) reject(`${label}含未定义字段。`);
  return value as Record<string, any>;
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || value.trim() !== value || /[\u0000-\u001f]/.test(value)) reject(`${label}须为准确身份。`);
  return value;
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) reject(`${label}须为正整数。`);
  return value;
}
function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) reject('来源指纹不完整。');
  return value;
}
export function orderSampleDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === '0000') reject('事实日期须为有效YYYY-MM-DD。');
  if (!isValidLocalDateKey(value)) reject('事实日期无效。');
  return value;
}

/** Decimal(18,4) strings, with no rounding or Number conversion. */
export function canonicalOrderSampleDecimal(value: unknown, allowZero = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value)) reject('数量须为精确十进制字符串，最多14位整数和4位小数。');
  const [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole) * BigInt(10000) + BigInt(fraction.padEnd(4, '0'));
  if (!allowZero && scaled === BigInt(0)) reject('数量须大于零。');
  const tail = fraction.replace(/0+$/, '');
  return tail ? `${whole}.${tail}` : whole;
}
function scaled(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * BigInt(10000) + BigInt(fraction.padEnd(4, '0'));
}
export function canonicalOrderSampleUnit(value: unknown): OrderSampleUnit {
  const aliases: Record<string, OrderSampleUnit> = {
    m: 'M', meter: 'M', meters: 'M', metre: 'M', metres: 'M', yd: 'YD', yard: 'YD', yards: 'YD',
    pc: 'PC', pcs: 'PC', piece: 'PC', pieces: 'PC', kg: 'KG', kilogram: 'KG', kilograms: 'KG',
  };
  if (typeof value !== 'string' || !aliases[value.trim().toLowerCase()]) reject('单位未明确支持；不能推断或换算。');
  return aliases[value.trim().toLowerCase()];
}
export function canonicalOrderSampleJson(value: unknown, ancestors = new Set<object>()): OrderSampleJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value)) reject('摘要只接受完整、无循环的JSON事实。');
  const next = new Set(ancestors); next.add(value);
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) reject('JSON数组不能携带范围外事实。');
    const result: OrderSampleJson[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) reject('JSON事实不能含空数组位置。');
      if (!('value' in descriptor)) reject('JSON事实不能含访问器。');
      result.push(canonicalOrderSampleJson(descriptor.value, next));
    }
    return result;
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) reject('摘要不能隐式转换对象。');
  const result: { [key: string]: OrderSampleJson } = Object.create(null);
  for (const key of Object.getOwnPropertyNames(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) reject('JSON事实不能含访问器或隐藏字段。');
    result[key] = canonicalOrderSampleJson(descriptor.value, next);
  }
  return result;
}
export function orderSampleDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalOrderSampleJson(value))).digest('hex');
}
function measure(value: unknown): OrderSampleMeasure {
  const input = object(value, ['quantity', 'unit', 'cuttingDate'], '取样事实');
  return { quantity: canonicalOrderSampleDecimal(input.quantity), unit: canonicalOrderSampleUnit(input.unit), cuttingDate: orderSampleDate(input.cuttingDate) };
}
function sourceBody(source: OrderSampleSource) {
  const { coverage, contentFingerprint, coverageFingerprint, ...body } = source;
  return body;
}
function validateCoverage(source: OrderSampleSource): void {
  if (!Array.isArray(source.coverage) || !source.coverage.length) reject('须明确至少一个真实代表范围。');
  const specFingerprint = orderSampleDigest(source.specSnapshot);
  for (const c of source.coverage) {
    object(c, ['orderId', 'orderLineId', 'factoryRelationId', 'scopeKind', 'productionBatchId', 'productionBatchRevision', 'rangeStart', 'quantity', 'unit', 'lineQuantity', 'batchRangeStart', 'batchQuantity', 'specFingerprint', 'sourceFingerprint', 'lineFingerprint', 'materialProof', 'productionLineIdentity'], '代表范围');
    if (c.materialProof !== undefined) canonicalOrderSampleJson(c.materialProof);
    if (c.productionLineIdentity !== undefined) { assertProductionLineIdentity(c.productionLineIdentity); if (c.scopeKind !== 'production_batch' || c.productionLineIdentity.factoryRelationId !== c.factoryRelationId) reject('实际生产线必须来自本工厂的准确生产分支。'); }
    id(c.orderLineId, '订单行');
    if (c.orderId !== source.owner.orderId || c.factoryRelationId !== source.owner.factoryRelationId || c.specFingerprint !== specFingerprint) reject('代表范围跨订单、工厂或规格。');
    if (c.unit !== canonicalOrderSampleUnit(c.unit) || c.rangeStart !== canonicalOrderSampleDecimal(c.rangeStart, true) || c.quantity !== canonicalOrderSampleDecimal(c.quantity) || c.lineQuantity !== canonicalOrderSampleDecimal(c.lineQuantity)) reject('代表范围不是规范事实。');
    fingerprint(c.sourceFingerprint); fingerprint(c.lineFingerprint);
    const start = scaled(c.rangeStart), end = start + scaled(c.quantity);
    if (end > scaled(c.lineQuantity)) reject('代表范围超出订单行实际数量。');
    if (c.scopeKind === 'production_batch') {
      id(c.productionBatchId, '生产批次'); integer(c.productionBatchRevision, '生产批次修订');
      const batchRangeStart = canonicalOrderSampleDecimal(c.batchRangeStart, true), batchQuantity = canonicalOrderSampleDecimal(c.batchQuantity);
      if (c.batchRangeStart !== batchRangeStart || c.batchQuantity !== batchQuantity) reject('生产批次范围不完整。');
      const batchStart = scaled(batchRangeStart), batchEnd = batchStart + scaled(batchQuantity);
      if (start < batchStart || end > batchEnd || batchEnd > scaled(c.lineQuantity)) reject('代表范围不在真实生产批次之内。');
    } else if (c.scopeKind !== 'order_line' || source.family !== 'garment_pp' || c.productionBatchId !== null || c.productionBatchRevision !== null || c.batchRangeStart !== null || c.batchQuantity !== null) reject('只有直接订单PP可用订单行范围；其他族须真实生产批次。');
  }
  for (let index = 1; index < source.coverage.length; index++) {
    const before = source.coverage[index - 1], current = source.coverage[index];
    if (before.orderLineId > current.orderLineId || (before.orderLineId === current.orderLineId && scaled(before.rangeStart) > scaled(current.rangeStart))) reject('代表范围须按准确身份和区间规范排序。');
    if (before.orderLineId === current.orderLineId && (before.lineFingerprint !== current.lineFingerprint || before.lineQuantity !== current.lineQuantity || before.unit !== current.unit || before.sourceFingerprint !== current.sourceFingerprint)) reject('同一订单行不能混合不同版本的实际事实。');
    if (before.orderLineId === current.orderLineId && scaled(before.rangeStart) + scaled(before.quantity) > scaled(current.rangeStart)) reject('代表范围重复或重叠。');
  }
}
export function assertOrderSampleSource(value: unknown): asserts value is OrderSampleSource {
  canonicalOrderSampleJson(value);
  const source = object(value, ['domain', 'sourceId', 'sampleId', 'family', 'owner', 'chainId', 'round', 'previousSourceId', 'provenance', 'specSnapshot', 'sampleFacts', 'coverage', 'contentFingerprint', 'coverageFingerprint'], '订单样品来源') as OrderSampleSource;
  if (source.domain !== 'order') reject('Case来源不属于订单样品合同。');
  id(source.sourceId, '来源'); id(source.sampleId, '样品'); id(source.chainId, '链'); integer(source.round, '轮次');
  object(source.owner, ['orderId', 'businessLine', 'factoryRelationId'], '订单父身份');
  id(source.owner.orderId, '订单'); id(source.owner.factoryRelationId, '工厂');
  if (!Object.prototype.hasOwnProperty.call(families, source.family) || families[source.family] !== source.owner.businessLine) reject('业务族与显式订单业务线不符。');
  if (!['native_new', 'current_link_recorded', 'legacy_recorded'].includes(source.provenance)) reject('来源证明层级未明确。');
  if (source.round === 1 ? source.previousSourceId !== null : (!source.previousSourceId || source.previousSourceId === source.sourceId)) reject('来源轮次与前轮身份不一致。');
  if (source.previousSourceId) id(source.previousSourceId, '前轮来源');
  if (orderSampleDigest(source.sampleFacts) !== orderSampleDigest(measure(source.sampleFacts))) reject('取样事实不是规范值。');
  canonicalOrderSampleJson(source.specSnapshot);
  validateCoverage(source);
  if (source.contentFingerprint !== orderSampleDigest(sourceBody(source)) || source.coverageFingerprint !== orderSampleDigest(source.coverage)) reject('来源内容或代表范围摘要已变化。');
}

/** Actual snapshots must be supplied explicitly. No latest/sole-parent lookup,
 * quantity copying, persistent writes, approval, or Case PP projection. */
export function buildOrderSampleSource(value: unknown): OrderSampleSource {
  canonicalOrderSampleJson(value);
  const input = object(value, ['domain', 'sourceId', 'sampleId', 'family', 'owner', 'chainId', 'round', 'previousSourceId', 'provenance', 'specSnapshot', 'sampleFacts', 'coverage', 'lines', 'batches'], '来源输入') as OrderSampleSourceInput;
  const owner = object(input.owner, ['orderId', 'businessLine', 'factoryRelationId'], '订单父身份') as OrderSampleOwner;
  const specSnapshot = canonicalOrderSampleJson(input.specSnapshot), specFingerprint = orderSampleDigest(specSnapshot);
  if (!Array.isArray(input.lines) || !Array.isArray(input.batches) || !Array.isArray(input.coverage)) reject('须传入明确解析的行、批次及范围。');
  const keyed = <T extends { id: string }>(rows: T[], keys: string[]) => {
    const result = new Map<string, T>();
    for (const row of rows) { object(row, keys, '实际父记录'); const key = id(row.id, '父记录'); if (result.has(key)) reject('实际父记录身份重复。'); result.set(key, row); }
    return result;
  };
  const lines = keyed(input.lines, ['id', 'orderId', 'factoryRelationId', 'quantity', 'unit', 'specSnapshot', 'sourceFingerprint', 'lineFingerprint', 'materialProof']);
  const batches = keyed(input.batches, ['id', 'orderId', 'orderLineId', 'factoryRelationId', 'rangeStart', 'quantity', 'unit', 'revision', 'state', 'specSnapshot', 'sourceFingerprint', 'productionLineIdentity']);
  const coverage = input.coverage.map((raw: unknown): OrderSampleCoverage => {
    const request = object(raw, ['orderLineId', 'expectedLineFingerprint', 'productionBatchId', 'expectedBatchRevision', 'rangeStart', 'quantity', 'unit'], '范围请求');
    const line = lines.get(id(request.orderLineId, '订单行'));
    if (!line || line.orderId !== owner.orderId || line.factoryRelationId !== owner.factoryRelationId || orderSampleDigest(line.specSnapshot) !== specFingerprint) reject('实际订单行与订单、工厂或规格不一致。');
    if (fingerprint(line.lineFingerprint) !== fingerprint(request.expectedLineFingerprint)) reject('实际订单行读取版本已变化。');
    const unit = canonicalOrderSampleUnit(request.unit);
    if (canonicalOrderSampleUnit(line.unit) !== unit) reject('代表范围与订单行单位不同；不能换算。');
    const base: OrderSampleCoverage = { orderId: line.orderId, orderLineId: line.id, factoryRelationId: line.factoryRelationId,
      scopeKind: 'order_line', productionBatchId: null, productionBatchRevision: null,
      rangeStart: canonicalOrderSampleDecimal(request.rangeStart, true), quantity: canonicalOrderSampleDecimal(request.quantity), unit,
      lineQuantity: canonicalOrderSampleDecimal(line.quantity), batchRangeStart: null, batchQuantity: null, specFingerprint,
      sourceFingerprint: fingerprint(line.sourceFingerprint), lineFingerprint: line.lineFingerprint,
      ...(line.materialProof !== undefined ? { materialProof: canonicalOrderSampleJson(line.materialProof) } : {}) };
    if (request.productionBatchId !== undefined && request.productionBatchId !== null) {
      const batch = batches.get(id(request.productionBatchId, '生产批次'));
      if (!batch || batch.orderId !== owner.orderId || batch.orderLineId !== line.id || batch.factoryRelationId !== owner.factoryRelationId || batch.state !== 'active' || integer(batch.revision, '实际修订') !== integer(request.expectedBatchRevision, '读取修订') || orderSampleDigest(batch.specSnapshot) !== specFingerprint || batch.sourceFingerprint !== base.sourceFingerprint) reject('生产批次归属、工厂、内容或修订不一致。');
      if (canonicalOrderSampleUnit(batch.unit) !== unit) reject('生产批次单位不同；不能换算。');
      return { ...base, scopeKind: 'production_batch', productionBatchId: batch.id, productionBatchRevision: batch.revision,
        batchRangeStart: canonicalOrderSampleDecimal(batch.rangeStart, true), batchQuantity: canonicalOrderSampleDecimal(batch.quantity),
        ...(batch.productionLineIdentity === undefined ? {} : { productionLineIdentity: canonicalOrderSampleJson(batch.productionLineIdentity) }) };
    }
    if (request.expectedBatchRevision !== undefined && request.expectedBatchRevision !== null) reject('行范围不能带生产批次修订。');
    return base;
  }).sort((a: OrderSampleCoverage, b: OrderSampleCoverage) => (a.orderLineId < b.orderLineId ? -1 : a.orderLineId > b.orderLineId ? 1 : 0) || (scaled(a.rangeStart) < scaled(b.rangeStart) ? -1 : scaled(a.rangeStart) > scaled(b.rangeStart) ? 1 : 0));
  const source: OrderSampleSource = { domain: input.domain, sourceId: input.sourceId, sampleId: input.sampleId, family: input.family,
    owner: { orderId: owner.orderId, businessLine: owner.businessLine, factoryRelationId: owner.factoryRelationId },
    chainId: input.chainId, round: input.round, previousSourceId: input.previousSourceId, provenance: input.provenance,
    specSnapshot, sampleFacts: measure(input.sampleFacts), coverage, contentFingerprint: '', coverageFingerprint: '' };
  source.contentFingerprint = orderSampleDigest(sourceBody(source)); source.coverageFingerprint = orderSampleDigest(coverage);
  assertOrderSampleSource(source);
  return source;
}
