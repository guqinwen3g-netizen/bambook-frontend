import { normalizeOrderQuantityUnit } from '../server/src/shared/orderQuantitySummary';
import { deriveQuotationOrderTypeFromLines } from '../server/src/quotations/quotationOrderType';
import type { ConversionJson, ConversionResultSelection, ConversionSource as WireSource, ConversionInput, ConversionRowSnapshot, ConversionSourceAnchors as WireAnchors, ConversionContext as WireContext, ConversionContextSelection, ConversionAck as WireAck, ConversionOriginal, ConversionRecovery as WireRecovery } from '../server/src/orders/orderConversionCommandTypes';
type Json = ConversionJson;
export type ConversionSelectedSource = ConversionResultSelection;
export type ConversionSource = WireSource & { type: 'development'; expected: WireSource['expected'] & { quotationVersion: null } };
export type DevelopmentCreateCommand = Extract<ConversionInput, { operation: 'development_create' }> & { source: ConversionSource };
export type DevelopmentLinkCommand = Extract<ConversionInput, { operation: 'development_link' }> & { source: ConversionSource };
export type DevelopmentConversionCommand = DevelopmentCreateCommand | DevelopmentLinkCommand;
export type QuotationCreateCommand = Extract<ConversionInput, { operation: 'quotation_create' }>;
export type OrderConversionCommand = DevelopmentConversionCommand | QuotationCreateCommand;
export type QuotationConversionContext = Omit<WireContext, 'source' | 'selection' | 'defaults' | 'preparation'> & { source: WireSource & { type: 'quotation' }; selection: Extract<ConversionContextSelection, { operation: 'quotation_create' }>; defaults: QuotationCreateCommand['parameters']; preparation: { state: 'prepared'; auditId: string } };
export type QuotationConversionAck = Omit<WireAck, 'operation' | 'sourceType' | 'original'> & { operation: 'quotation_create'; sourceType: 'quotation'; outcome: 'converted'; original: Omit<ConversionOriginal, 'input'> & { input: QuotationCreateCommand } };
export type QuotationConversionRecovery = Omit<WireRecovery, 'operation' | 'sourceType' | 'requestInput' | 'cancellationProof'> & { operation: 'quotation_create'; sourceType: 'quotation'; requestInput: QuotationCreateCommand; cancellationProof: (Omit<NonNullable<WireRecovery['cancellationProof']>, 'requestInput'> & { requestInput: QuotationCreateCommand }) | null };
export type OrderConversionOutcome = ConversionAck | ConversionRecovery | QuotationConversionAck | QuotationConversionRecovery;
type Row = ConversionRowSnapshot;
export type ConversionSourceAnchors = WireAnchors;
export type ConversionContext = Omit<WireContext, 'source' | 'selection' | 'defaults' | 'preparation'> & { source: ConversionSource; selection: Extract<ConversionContextSelection, { operation: 'development_create' | 'development_link' }>; defaults: DevelopmentConversionCommand['parameters']; preparation: { state: 'prepared'; auditId: string } };
export type ConversionAck = Omit<WireAck, 'operation' | 'sourceType' | 'original'> & { operation: 'development_create' | 'development_link'; sourceType: 'development'; original: Omit<ConversionOriginal, 'input'> & { input: DevelopmentConversionCommand } };
export type ConversionRecovery = Omit<WireRecovery, 'operation' | 'sourceType' | 'requestInput' | 'cancellationProof'> & { operation: 'development_create' | 'development_link'; sourceType: 'development'; requestInput: DevelopmentConversionCommand; cancellationProof: (Omit<NonNullable<WireRecovery['cancellationProof']>, 'requestInput'> & { requestInput: DevelopmentConversionCommand }) | null };

export type ConversionPrincipal = { actorId: string; endpoint: string; generation: string; headers: Record<string, string> };
export type ConversionPending<I extends OrderConversionCommand = DevelopmentConversionCommand> = { version: 1; actorId: string; endpoint: string; input: I };
export class ConversionClientError extends Error {
  constructor(public code: string, message: string, public approvalRequestId?: string, public blockCode?: string) { super(message); }
}
const fail = (code = 'UNVERIFIED_REPLY'): never => { throw new ConversionClientError(code, '转单状态未能核验，请保留原请求继续核对。'); };
const protocol = 'order_conversion_command_v1';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
export function conversionClientCanonical(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(conversionClientCanonical).join(',') + ']';
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return '{' + Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => JSON.stringify(k) + ':' + conversionClientCanonical(value)).join(',') + '}';
  return fail('INVALID_INPUT');
}
export async function conversionClientDigest(v: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(conversionClientCanonical(v));
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const same = (a: unknown, b: unknown) => conversionClientCanonical(a) === conversionClientCanonical(b);
function shape(v: any, keys: string[]) { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.prototype.hasOwnProperty.call(v, k))) fail('INVALID_INPUT'); }
function id(v: unknown): string { if (typeof v !== 'string' || !v || v !== v.trim() || v.length > 200 || /[\u0000-\u001f]/.test(v)) fail('INVALID_INPUT'); return v as string; }
function decimal(v: unknown, zero = false): string {
  if (typeof v !== 'string' || !/^\d+(?:\.\d{1,4})?$/.test(v.trim()) || v.length > 256) return fail('INVALID_INPUT');
  const [whole, part = ''] = v.trim().split('.'); const a = whole.replace(/^0+/, '') || '0', b = part.replace(/0+$/, '');
  if (a.length > 14 || (!zero && a === '0' && !b)) return fail('INVALID_INPUT');
  return b ? a + '.' + b : a;
}
const QUANTITY_SCALE = 10_000n;
const MAX_SCALED_ORDER_QUANTITY = 999_999_999_999_999_999n;
const MAX_LEGACY_ORDER_QUANTITY = 2_147_483_647n;
const CONVERSION_UNITS = ['M', 'YD', 'KG', 'G', 'PC', 'SET', 'ROLL', 'DOZEN'] as const;
function quantityScaled(v: unknown, zero = false): bigint {
  const value = decimal(v, zero), [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole) * QUANTITY_SCALE + BigInt(fraction.padEnd(4, '0'));
  if (scaled > MAX_SCALED_ORDER_QUANTITY) fail();
  return scaled;
}
function quantityText(scaled: bigint): string {
  if (scaled < 0n || scaled > MAX_SCALED_ORDER_QUANTITY) fail();
  const whole = String(scaled / QUANTITY_SCALE), fraction = String(scaled % QUANTITY_SCALE).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
function expectedQuantityHeader(lines: any[]): { quantity: string | null; unit: string | null; groups: Map<string, bigint>; unresolved: boolean } {
  if (!Array.isArray(lines)) fail();
  const groups = new Map<string, bigint>(); let unresolved = false;
  for (const line of lines) {
    const record = line?.record ?? line;
    if (!record || typeof record !== 'object') fail();
    const amount = quantityScaled(record.quantity, true), unit = normalizeOrderQuantityUnit(record.unit);
    if (!unit) { unresolved = true; continue; }
    const total = (groups.get(unit) ?? 0n) + amount;
    if (total > MAX_SCALED_ORDER_QUANTITY) fail();
    groups.set(unit, total);
  }
  if (unresolved || groups.size !== 1) return { quantity: null, unit: null, groups, unresolved };
  const [[unit, total]] = [...groups.entries()];
  return { quantity: quantityText(total), unit, groups, unresolved };
}
/** Check new Decimal(18,4) headers exactly, while retaining only verifiable legacy integer receipts. */
function verifyQuantityHeader(order: any, lines: any[], options: { preserveUnprojectedLegacyHeader?: boolean } = {}): void {
  const expected = expectedQuantityHeader(lines);
  if (Object.prototype.hasOwnProperty.call(order, 'unit')) {
    if (order.quantity === expected.quantity && order.unit === expected.unit) return;
    if (!(options.preserveUnprojectedLegacyHeader && order.unit === null && isLegacyIntegerQuantity(order.quantity))) fail();
    return;
  }
  // Existing linked orders predate the unit-aware projection and may have a stale header;
  // link is read-only for that order, so validate its stored scalar without rewriting it.
  if (options.preserveUnprojectedLegacyHeader) { if (!isLegacyIntegerQuantity(order.quantity)) fail(); return; }
  if (expected.unresolved || expected.groups.size !== 1 || expected.quantity === null) fail();
  const [unitTotal] = [...expected.groups.values()];
  if (unitTotal % QUANTITY_SCALE !== 0n || unitTotal / QUANTITY_SCALE > MAX_LEGACY_ORDER_QUANTITY || decimal(order.quantity) !== expected.quantity) fail();
}
function isLegacyIntegerQuantity(value: unknown): boolean {
  try {
    const scaled = quantityScaled(value, true);
    return scaled % QUANTITY_SCALE === 0n && scaled / QUANTITY_SCALE <= MAX_LEGACY_ORDER_QUANTITY;
  } catch { return false; }
}
export function parseDevelopmentCreateCommand(raw: unknown): DevelopmentCreateCommand {
  conversionClientCanonical(raw); const r = raw as any;
  shape(r, ['conversionVersion', 'requestKey', 'source', 'operation', 'parameters']); shape(r.source, ['type', 'id', 'expected']); shape(r.source.expected, ['updatedAt', 'quotationVersion', 'contentFingerprint']);
  if (r.conversionVersion !== 1 || r.operation !== 'development_create' || r.source.type !== 'development' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(r.requestKey) || typeof r.requestKey !== 'string' || typeof r.source.expected.updatedAt !== 'string' || !/^\d+$/.test(r.source.expected.updatedAt) || r.source.expected.quotationVersion !== null || !/^[a-f0-9]{64}$/.test(r.source.expected.contentFingerprint)) fail('INVALID_INPUT');
  id(r.source.id); const p = r.parameters;
  shape(p, ['quantity', 'unit', 'dueDate', 'quoteAmount', 'selectedSource', 'millRelationId', 'orderPo']); shape(p.selectedSource, ['type', 'id']);
  // Strict wire input; no implicit quantity, unit, source or factory defaults.
  if (!['Asset', 'primary_asset', 'SealSample', 'Sample'].includes(p.selectedSource.type) || !['M', 'YD', 'KG', 'G', 'PC', 'SET', 'ROLL', 'DOZEN'].includes(p.unit)) fail('UNSUPPORTED_COMMAND');
  id(p.selectedSource.id); id(p.millRelationId); if (p.orderPo !== null) id(p.orderPo);
  if (typeof p.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate) || !Number.isFinite(Date.parse(p.dueDate + 'T00:00:00Z')) || new Date(p.dueDate + 'T00:00:00Z').toISOString().slice(0, 10) !== p.dueDate) fail('INVALID_INPUT');
  const input = clone(r); input.parameters.quantity = decimal(p.quantity); input.parameters.quoteAmount = p.quoteAmount === null ? null : decimal(p.quoteAmount, true); return input;
}
export function parseDevelopmentConversionCommand(raw: unknown): DevelopmentConversionCommand {
  if ((raw as any)?.operation === 'development_create') return parseDevelopmentCreateCommand(raw);
  conversionClientCanonical(raw); const r = raw as any;
  shape(r, ['conversionVersion', 'requestKey', 'source', 'operation', 'parameters']); shape(r.source, ['type', 'id', 'expected']); shape(r.source.expected, ['updatedAt', 'quotationVersion', 'contentFingerprint']);
  if (r.conversionVersion !== 1 || r.operation !== 'development_link' || r.source.type !== 'development' || typeof r.requestKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(r.requestKey) || typeof r.source.expected.updatedAt !== 'string' || !/^\d+$/.test(r.source.expected.updatedAt) || r.source.expected.quotationVersion !== null || typeof r.source.expected.contentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(r.source.expected.contentFingerprint)) fail('INVALID_INPUT');
  id(r.source.id); const p = r.parameters; shape(p, ['orderId', 'expectedTarget', 'selectedSource', 'millRelationId']); shape(p.expectedTarget, ['updatedAt', 'contentFingerprint']); shape(p.selectedSource, ['type', 'id']);
  if (!['Asset', 'primary_asset', 'Sample', 'SealSample'].includes(p.selectedSource.type) || typeof p.expectedTarget.updatedAt !== 'string' || !/^\d+$/.test(p.expectedTarget.updatedAt) || typeof p.expectedTarget.contentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(p.expectedTarget.contentFingerprint)) fail('INVALID_INPUT');
  id(p.orderId); id(p.millRelationId); id(p.selectedSource.id); return clone(r);
}
export function parseQuotationCreateCommand(raw: unknown): QuotationCreateCommand {
  conversionClientCanonical(raw); const r = raw as any;
  shape(r, ['conversionVersion', 'requestKey', 'source', 'operation', 'parameters']); shape(r.source, ['type', 'id', 'expected']); shape(r.source.expected, ['updatedAt', 'quotationVersion', 'contentFingerprint']);
  if (r.conversionVersion !== 1 || r.operation !== 'quotation_create' || r.source.type !== 'quotation' || typeof r.requestKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(r.requestKey) || typeof r.source.expected.updatedAt !== 'string' || !/^\d+$/.test(r.source.expected.updatedAt) || !Number.isSafeInteger(r.source.expected.quotationVersion) || r.source.expected.quotationVersion < 1 || typeof r.source.expected.contentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(r.source.expected.contentFingerprint)) fail('INVALID_INPUT');
  id(r.source.id); const p = r.parameters; shape(p, ['poNumber', 'millRelationId', 'type', 'dueDate', 'paymentInstrument']);
  for (const field of ['poNumber', 'millRelationId', 'paymentInstrument']) if (p[field] !== null) id(p[field]);
  if (p.type !== null && !['Fabric', 'Garment', 'Other'].includes(p.type)) fail('INVALID_INPUT');
  if (p.dueDate !== null && (typeof p.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate) || !Number.isFinite(Date.parse(p.dueDate + 'T00:00:00Z')) || new Date(p.dueDate + 'T00:00:00Z').toISOString().slice(0, 10) !== p.dueDate)) fail('INVALID_INPUT');
  return clone(r);
}
function parseOrderConversionCommand(raw: unknown): OrderConversionCommand { return (raw as any)?.operation === 'quotation_create' ? parseQuotationCreateCommand(raw) : parseDevelopmentConversionCommand(raw); }
const validMoq = (s: any) => s && ['fabricDefaultMoq', 'garmentDefaultMoq', 'capsuleMoq'].every(k => typeof s[k] === 'number' && Number.isFinite(s[k]) && s[k] > 0);
const fallback = { fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20 };
async function verifyMoq(a: ConversionSourceAnchors, completedAt: string) {
  const prior = a.source.record.moqSnapshot ?? null, snapshot: any = a.moq.snapshot, config = a.moq.config;
  const basis = validMoq(prior) ? { kind: 'source_snapshot', sourceId: a.source.id, snapshot: prior } : config ? { kind: 'active_config', config } : { kind: 'fallback_constant', version: 1, thresholds: fallback };
  if (!validMoq(snapshot) || a.moq.basisFingerprint !== await conversionClientDigest(basis)) fail();
  if (validMoq(prior)) { if (config !== null || !same(snapshot, prior)) fail(); return; }
  if (!Number.isFinite(Date.parse(snapshot.snapshotAt)) || new Date(snapshot.snapshotAt).toISOString() !== snapshot.snapshotAt || Date.parse(snapshot.snapshotAt) > Date.parse(completedAt)) fail();
  if (config ? config.record.id !== config.id || config.record.isActive !== true || snapshot.source !== 'moq_config' || snapshot.configId !== config.id || Object.keys(fallback).some(k => snapshot[k] !== config.record[k]) : snapshot.source !== 'fallback_constant' || snapshot.configId !== null || Object.entries(fallback).some(([k, v]) => snapshot[k] !== v)) fail();
}
function liveSpec(a: ConversionSourceAnchors) {
  if (!a.asset || !a.profile || a.selectedResultEvidence !== null) return fail();
  const asset = a.asset.record, p = a.profile.record;
  const spec: any = { sku: asset.sku ?? null, name: asset.name ?? null, mainCategory: asset.mainCategory ?? null };
  const fields = a.profile.family === 'fabric' ? ['articleNo', 'construction', 'yarnCount', 'pattern', 'weightValue', 'weightValueGsm', 'weightUnit', 'widthValue', 'widthUnit', 'millQuality', 'millColorCode'] : ['styleNo', 'silhouette', 'fit', 'mainFabric', 'liningFabric', 'sizeRange', 'baseSize', 'sizeSpec'];
  spec[a.profile.family] = Object.fromEntries(fields.map(k => [k, p[k]])); return spec;
}
async function confirmedSpec(a: ConversionSourceAnchors, input: DevelopmentConversionCommand): Promise<unknown> {
  const e: any = a.selectedResultEvidence, accepted = e?.confirmedSpecification, selected = input.parameters.selectedSource;
  if (!a.asset || !accepted || !['Sample', 'SealSample'].includes(accepted.sourceType) || accepted.sourceType !== selected.type || accepted.sourceId !== selected.id || accepted.caseId !== input.source.id || accepted.factoryRelationId !== input.parameters.millRelationId || !Array.isArray(accepted.origins) || !accepted.origins.length) fail();
  const checkedAsset = a.asset; if (!checkedAsset) return fail();
  const origins = [...accepted.origins].sort((x: any, y: any) => x.snapshot.batch.id.localeCompare(y.snapshot.batch.id));
  if (new Set(origins.map(o => o.snapshot.batch.id)).size !== origins.length) fail();
  for (const o of origins) {
    const x = o.snapshot, v = x?.version;
    if (x?.schemaVersion !== 1 || x.batch.caseId !== accepted.caseId || x.batch.factoryId !== accepted.factoryRelationId || !Number.isSafeInteger(x.batch.sourceRound) || x.batch.sourceRound < 1 || !v || typeof v.updatedAt !== 'string' || !/^\d+$/.test(v.updatedAt) || v.historyRevision !== null && (!Number.isSafeInteger(v.historyRevision) || v.historyRevision < 0) || v.eventId !== null && (typeof v.eventId !== 'string' || !v.eventId) || !Array.isArray(o.evidenceAuditIds) || !o.evidenceAuditIds.length || o.evidenceAuditIds.some((value: unknown) => typeof value !== 'string' || !value) || o.sourceFingerprint !== await conversionClientDigest({ schemaVersion: x.schemaVersion, batch: x.batch, content: x.content })) fail();
  }
  const c = origins[0].snapshot.content.caseContent;
  if (!c || !['fabric', 'garment'].includes(c.type) || String(checkedAsset.record.mainCategory).toLowerCase() !== c.type || origins.some(o => !same(o.snapshot.content.caseContent, c))) fail();
  const basis = { schemaVersion: 1, sourceType: selected.type, sourceId: selected.id, caseId: input.source.id, factoryRelationId: input.parameters.millRelationId, family: c.type, caseContent: c, origins: origins.map(o => ({ snapshot: o.snapshot, sourceFingerprint: o.sourceFingerprint, evidenceAuditIds: [...new Set<string>(o.evidenceAuditIds)].sort() })) };
  const rebuilt = { ...basis, contentFingerprint: await conversionClientDigest(basis) }; if (!same(rebuilt, accepted)) fail();
  const asset = checkedAsset.record;
  const spec: any = { sku: asset.sku, name: asset.name, mainCategory: asset.mainCategory, catalogIdentity: { productAssetId: checkedAsset.id, sku: asset.sku, name: asset.name } };
  const raw = (v: unknown) => v ?? null;
  const measure = (v: unknown, family: string) => { const m = typeof v === 'string' ? v.trim().match(/^(\d+(?:\.\d+)?)\s*(.*?)$/) : null, token = m?.[2].toLowerCase() ?? ''; return { value: m && Number.isFinite(Number(m[1])) ? Number(m[1]) : null, unit: family === 'weight' ? /^(gsm|g\/m²|g\/m2|g\/m\^2)$/.test(token) ? 'gsm' : null : /^(cm|mm|m)$/.test(token) ? token : /^(in|inch|inches|")$/.test(token) ? 'inch' : null }; };
  if (c.type === 'fabric') { const w = measure(c.specWeight, 'weight'), width = measure(c.specWidth, 'width'); spec.fabric = { composition: raw(c.specComposition), construction: raw(c.specWeave), finish: raw(c.specFinish), weightText: raw(c.specWeight), weightValue: w.value, weightUnit: w.unit, weightValueGsm: w.unit === 'gsm' ? w.value : null, widthText: raw(c.specWidth), widthValue: width.value, widthUnit: width.unit, articleNo: null, yarnCount: null, pattern: null, millQuality: null, millColorCode: null }; }
  else spec.garment = { styleNo: raw(c.styleSpec), sizeSpec: raw(c.sizeSpec), mainFabric: raw(c.fabricSpec), constructionNote: raw(c.processSpec), processSpec: raw(c.processSpec), silhouette: null, fit: null, liningFabric: null, sizeRange: null, baseSize: null };
  spec.confirmedSpecification = rebuilt; if (e.sampleOriginProof) spec.sampleOriginProof = e.sampleOriginProof;
  if (!same(spec, e.confirmedSpecSnapshot)) fail(); return spec;
}
/** Browser semantic verification of the original immutable Dev-create receipt. */
export async function verifyDevelopmentCreateOutcome(raw: unknown, actorId: string, inputRaw: DevelopmentCreateCommand): Promise<ConversionAck | ConversionRecovery> {
  const input = parseDevelopmentCreateCommand(inputRaw), r = raw as any;
  const hash = await conversionClientDigest({ protocol, actorId: id(actorId), input });
  const receipt = 'OCMD_' + await conversionClientDigest({ protocol, actorId, requestKey: input.requestKey });
  if (!r || r.conversionVersion !== 1 || r.actorId !== actorId || r.requestKey !== input.requestKey || r.operation !== input.operation || r.sourceType !== input.source.type || r.sourceId !== input.source.id || r.commandHash !== hash) fail();
  if (r.outcome !== 'converted') {
    if (!same(r.requestInput, input)) fail();
    if (r.outcome === 'not_confirmed') { if (r.receiptAuditId !== null || r.legacyOrderId !== null || r.cancellationProof !== null || r.legacyProof !== null) fail(); }
    else if (r.outcome === 'cancelled') { const p = r.cancellationProof; if (!p || r.receiptAuditId !== receipt || p.auditId !== receipt || p.actorId !== actorId || p.commandHash !== hash || !same(p.requestInput, input) || !Number.isFinite(Date.parse(p.cancelledAt)) || new Date(p.cancelledAt).toISOString() !== p.cancelledAt || r.legacyOrderId !== null || r.legacyProof !== null) fail(); }
    else if (r.outcome === 'legacy_unverified') { const p = r.legacyProof, audit = p?.businessAudit; if (!p || r.receiptAuditId !== null || r.cancellationProof !== null || !r.legacyOrderId || p.source.id !== input.source.id || p.source.record.id !== p.source.id || p.order.id !== r.legacyOrderId || p.order.record.id !== p.order.id || p.order.record.sourceCaseId !== p.source.id || p.order.record.clientRequestId !== input.requestKey || !audit || audit.id !== audit.record.id || audit.record.actorId !== actorId || audit.record.action !== 'convert_dev_case' || audit.record.targetType !== 'DevelopmentCase' || audit.record.targetId !== p.source.id || audit.record.detail?.after?.orderId !== p.order.id) fail(); }
    else fail();
    return clone(r);
  }
  const o = r.original, a: ConversionSourceAnchors = o?.sourceAnchors, p = input.parameters;
  if (r.receiptAuditId !== receipt || !o || !same(o.input, input) || !a || !same(a.source, o.sourceBefore) || await conversionClientDigest(a) !== input.source.expected.contentFingerprint || String(o.sourceBefore.record.updatedAt) !== input.source.expected.updatedAt) fail();
  const row = (v: any) => { if (!v || !v.record || v.id !== v.record.id) fail(); conversionClientCanonical(v); };
  for (const rows of [o.lines, o.productionStages, o.businessAudits]) { if (!Array.isArray(rows) || new Set(rows.map((x: any) => x.id)).size !== rows.length) fail(); rows.forEach(row); }
  [o.sourceBefore, o.sourceAfter, o.orderAfter, a.source, a.asset, a.profile, a.selectedResult, a.factory].forEach(row);
  [a.customer, a.moq?.config, a.moq?.approvedExemption].filter(Boolean).forEach(row);
  if (!Array.isArray(a.quotationLines) || a.quotationLines.length || !a.asset || !a.profile || !a.selectedResult || !a.factory) fail();
  const asset = a.asset!, profile = a.profile!, selected = a.selectedResult!, order = o.orderAfter.record, line = o.lines[0]?.record;
  if (!Number.isFinite(Date.parse(o.completedAt)) || new Date(o.completedAt).toISOString() !== o.completedAt) fail();
  await verifyMoq(a, o.completedAt);
  const family = o.sourceBefore.record.type === 'fabric' ? 'fabric' : ['garment', 'pp'].includes(o.sourceBefore.record.type) ? 'garment' : null;
  if (!family || profile.family !== family || String(asset.record.mainCategory).toLowerCase() !== family || asset.record.deletedAt !== null || profile.record.deletedAt !== null || profile.record.productAssetId !== asset.id || (['Asset', 'primary_asset'].includes(p.selectedSource.type) && asset.id !== p.selectedSource.id) || selected.id !== p.selectedSource.id || a.factory!.id !== p.millRelationId || (p.selectedSource.type === 'primary_asset' && o.sourceBefore.record.productAssetId !== asset.id)) fail();
  if (p.selectedSource.type === 'SealSample' && (selected.record.developmentCaseId !== r.sourceId || selected.record.convertedProductAssetId !== asset.id || selected.record.supplierRelationId !== p.millRelationId) || p.selectedSource.type === 'Sample' && (selected.record.sourceCaseId !== r.sourceId || selected.record.productAssetId !== asset.id || selected.record.supplierRelationId !== p.millRelationId)) fail();
  const expectedSpec = ['Sample', 'SealSample'].includes(p.selectedSource.type) ? await confirmedSpec(a, input) : liveSpec(a);
  const factory = family === 'garment' ? profile.record.factoryRelationId : profile.record.millOrganizationId;
  if (factory !== null && factory !== undefined && factory !== p.millRelationId) fail();
  if (o.sourceBefore.id !== r.sourceId || o.sourceAfter.id !== r.sourceId || o.sourceAfter.record.linkedOrderId !== r.orderId || o.orderAfter.id !== r.orderId || o.orderBefore !== null || o.targetBefore !== null || o.lines.length !== 1 || !line || line.orderId !== r.orderId || line.materialCode !== asset.record.sku || !same(line.specSnapshot, expectedSpec) || !same(order.moqSnapshot, a.moq.snapshot)) fail();
  verifyQuantityHeader(order, [line]);
  if ((a.customer?.id ?? null) !== (o.sourceBefore.record.customerRelationId ?? null) || order.customerRelationId !== (a.customer?.id ?? null) || order.sourceCaseId !== r.sourceId || order.millRelationId !== p.millRelationId || order.dueDate !== p.dueDate || order.status !== 'Pending' || decimal(order.quoteAmount, true) !== (p.quoteAmount ?? '0') || p.orderPo !== null && order.poNumber !== p.orderPo || decimal(line.quantity) !== p.quantity || normalizeOrderQuantityUnit(line.unit) !== p.unit) fail();
  if (p.selectedSource.type === 'primary_asset' ? ['confirmedSourceType', 'confirmedSourceId', 'confirmedAt', 'confirmedBy'].some(k => line[k] !== null) : line.confirmedSourceType !== p.selectedSource.type || line.confirmedSourceId !== p.selectedSource.id || line.confirmedBy !== actorId || typeof line.confirmedAt !== 'string' || !/^\d+$/.test(line.confirmedAt)) fail();
  const keys = ['order_placed', 'materials_confirmed', 'production_planned', 'in_production', 'materials_arrived', 'pre_cut_checked', 'pp_sample_approved', 'manufacturing', 'final_review', 'qc_shipped'];
  if (o.productionStages.length !== 10 || new Set(o.productionStages.map((s: any) => s.record.createdAt)).size !== 1 || keys.some((key, i) => o.productionStages.filter((s: any) => s.record.stageKey === key && s.record.stageSeq === i + 1).length !== 1)) fail();
  for (const s of o.productionStages) { const t = s.record; if (t.orderId !== r.orderId || t.id !== `PST__${r.orderId}__${t.stageKey}` || t.status !== (t.stageSeq === 1 ? 'done' : 'pending') || typeof t.createdAt !== 'string' || !/^\d+$/.test(t.createdAt) || t.updatedAt !== t.createdAt || (t.stageSeq === 1 ? t.doneAt !== t.createdAt || Number(t.doneAt) > Date.parse(o.completedAt) : t.doneAt !== null)) fail(); }
  const transitions = o.businessAudits.filter((x: any) => x.record.actorId === actorId && x.record.action === 'convert_dev_case' && x.record.targetType === 'DevelopmentCase' && x.record.targetId === r.sourceId);
  if (transitions.length !== 1 || o.businessAudits.some((x: any) => x.record.actorId !== actorId || !['convert_dev_case', 'convert_quotation_to_order', 'create_order_from_quotation'].includes(x.record.action) || ![r.sourceId, r.orderId].includes(x.record.targetId))) fail();
  const audit = transitions[0].record; if (audit.detail?.after?.orderId !== r.orderId || !Number.isFinite(Date.parse(audit.createdAt)) || Date.parse(audit.createdAt) > Date.parse(o.completedAt)) fail();
  const { receiptFingerprint, ...body } = r; if (receiptFingerprint !== await conversionClientDigest({ protocol, ack: body })) fail();
  return clone(r);
}
/** Link verifies preserved actual target, lines and stages; it never infers creation. */
export async function verifyDevelopmentConversionOutcome(raw: unknown, actorId: string, inputRaw: DevelopmentConversionCommand): Promise<ConversionAck | ConversionRecovery> {
  const input = parseDevelopmentConversionCommand(inputRaw);
  if (input.operation === 'development_create') return verifyDevelopmentCreateOutcome(raw, actorId, input);
  const r = raw as any, hash = await conversionClientDigest({ protocol, actorId: id(actorId), input }), receipt = 'OCMD_' + await conversionClientDigest({ protocol, actorId, requestKey: input.requestKey });
  if (!r || r.conversionVersion !== 1 || r.actorId !== actorId || r.requestKey !== input.requestKey || r.operation !== input.operation || r.sourceType !== input.source.type || r.sourceId !== input.source.id || r.commandHash !== hash) fail();
  if (r.outcome !== 'linked') {
    if (!same(r.requestInput, input)) fail();
    if (r.outcome === 'not_confirmed') { if (r.receiptAuditId !== null || r.legacyOrderId !== null || r.cancellationProof !== null || r.legacyProof !== null) fail(); }
    else if (r.outcome === 'cancelled') { const p = r.cancellationProof; if (!p || r.receiptAuditId !== receipt || p.auditId !== receipt || p.actorId !== actorId || p.commandHash !== hash || !same(p.requestInput, input) || !Number.isFinite(Date.parse(p.cancelledAt)) || new Date(p.cancelledAt).toISOString() !== p.cancelledAt || r.legacyOrderId !== null || r.legacyProof !== null) fail(); }
    else if (r.outcome === 'legacy_unverified') { const p = r.legacyProof, audit = p?.businessAudit; if (!p || r.receiptAuditId !== null || r.cancellationProof !== null || !r.legacyOrderId || p.source.id !== input.source.id || p.source.record.id !== p.source.id || p.order.id !== r.legacyOrderId || p.order.record.id !== p.order.id || p.order.record.sourceCaseId !== p.source.id || p.order.record.clientRequestId !== input.requestKey || !audit || audit.id !== audit.record.id || audit.record.actorId !== actorId || audit.record.action !== 'convert_dev_case' || audit.record.targetType !== 'DevelopmentCase' || audit.record.targetId !== p.source.id || audit.record.detail?.after?.orderId !== p.order.id) fail(); }
    else fail(); return clone(r);
  }
  const o = r.original, a: ConversionSourceAnchors = o?.sourceAnchors, p = input.parameters;
  if (r.receiptAuditId !== receipt || !o || !same(o.input, input) || !a || !same(a.source, o.sourceBefore) || await conversionClientDigest(a) !== input.source.expected.contentFingerprint || String(o.sourceBefore.record.updatedAt) !== input.source.expected.updatedAt) fail();
  const row = (v: any) => { if (!v || !v.record || v.id !== v.record.id) fail(); conversionClientCanonical(v); };
  for (const rows of [o.lines, o.productionStages, o.businessAudits]) { if (!Array.isArray(rows) || new Set(rows.map((x: any) => x.id)).size !== rows.length) fail(); rows.forEach(row); }
  [o.sourceBefore, o.sourceAfter, o.orderBefore, o.orderAfter, a.source, a.asset, a.profile, a.selectedResult, a.factory].forEach(row);
  [a.customer, a.moq?.config, a.moq?.approvedExemption].filter(Boolean).forEach(row);
  if (!a.asset || !a.profile || !a.selectedResult || !a.factory || !Array.isArray(a.quotationLines) || a.quotationLines.length || !Number.isFinite(Date.parse(o.completedAt)) || new Date(o.completedAt).toISOString() !== o.completedAt) fail();
  await verifyMoq(a, o.completedAt);
  const asset = a.asset!, profile = a.profile!, selected = a.selectedResult!, order = o.orderAfter.record;
  const family = o.sourceBefore.record.type === 'fabric' ? 'fabric' : ['garment', 'pp'].includes(o.sourceBefore.record.type) ? 'garment' : null;
  if (!family || profile.family !== family || String(asset.record.mainCategory).toLowerCase() !== family || asset.record.deletedAt !== null || profile.record.deletedAt !== null || profile.record.productAssetId !== asset.id || (['Asset', 'primary_asset'].includes(p.selectedSource.type) && asset.id !== p.selectedSource.id) || selected.id !== p.selectedSource.id || a.factory!.id !== p.millRelationId || p.selectedSource.type === 'primary_asset' && o.sourceBefore.record.productAssetId !== asset.id) fail();
  if (p.selectedSource.type === 'SealSample' && (selected.record.developmentCaseId !== r.sourceId || selected.record.convertedProductAssetId !== asset.id || selected.record.supplierRelationId !== p.millRelationId) || p.selectedSource.type === 'Sample' && (selected.record.sourceCaseId !== r.sourceId || selected.record.productAssetId !== asset.id || selected.record.supplierRelationId !== p.millRelationId)) fail();
  if (['Sample', 'SealSample'].includes(p.selectedSource.type)) await confirmedSpec(a, input);
  const factory = family === 'garment' ? profile.record.factoryRelationId : profile.record.millOrganizationId;
  if (factory !== null && factory !== undefined && factory !== p.millRelationId) fail();
  if (o.sourceBefore.id !== r.sourceId || o.sourceAfter.id !== r.sourceId || o.sourceAfter.record.linkedOrderId !== r.orderId || o.orderAfter.id !== r.orderId || r.orderId !== p.orderId || o.orderBefore.id !== p.orderId || String(o.orderBefore.record.updatedAt) !== p.expectedTarget.updatedAt || !o.targetBefore || await conversionClientDigest({ order: o.orderBefore, ...o.targetBefore }) !== p.expectedTarget.contentFingerprint || !same(o.orderBefore, o.orderAfter) || !same(o.targetBefore.lines, o.lines) || !same(o.targetBefore.productionStages, o.productionStages)) fail();
  if ((a.customer?.id ?? null) !== (o.sourceBefore.record.customerRelationId ?? null) || order.customerRelationId !== (a.customer?.id ?? null) || !(order.quantity === null || typeof order.quantity === 'string') || typeof order.quoteAmount !== 'string' || ['quantity', 'customerRelationId', 'millRelationId', 'dueDate', 'quoteAmount', 'poNumber', 'sourceCaseId', 'status'].some(k => !Object.prototype.hasOwnProperty.call(order, k)) || o.lines.some((l: any) => l.record.orderId !== r.orderId) || o.productionStages.some((s: any) => s.record.orderId !== r.orderId)) fail();
  verifyQuantityHeader(order, o.targetBefore.lines, { preserveUnprojectedLegacyHeader: true });
  const transitions = o.businessAudits.filter((x: any) => x.record.actorId === actorId && x.record.action === 'convert_dev_case' && x.record.targetType === 'DevelopmentCase' && x.record.targetId === r.sourceId);
  if (transitions.length !== 1 || o.businessAudits.some((x: any) => x.record.actorId !== actorId || !['convert_dev_case', 'convert_quotation_to_order', 'create_order_from_quotation'].includes(x.record.action) || ![r.sourceId, r.orderId].includes(x.record.targetId))) fail();
  const audit = transitions[0].record; if (audit.detail?.after?.orderId !== r.orderId || !Number.isFinite(Date.parse(audit.createdAt)) || Date.parse(audit.createdAt) > Date.parse(o.completedAt)) fail();
  const { receiptFingerprint, ...body } = r; if (receiptFingerprint !== await conversionClientDigest({ protocol, ack: body })) fail(); return clone(r);
}
/** Quote receipt binds every source row, commercial override and actual line. */
export async function verifyQuotationConversionOutcome(raw: unknown, actorId: string, inputRaw: QuotationCreateCommand): Promise<QuotationConversionAck | QuotationConversionRecovery> {
  const input = parseQuotationCreateCommand(inputRaw), r = raw as any;
  const hash = await conversionClientDigest({ protocol, actorId: id(actorId), input }), receipt = 'OCMD_' + await conversionClientDigest({ protocol, actorId, requestKey: input.requestKey });
  if (!r || r.conversionVersion !== 1 || r.actorId !== actorId || r.requestKey !== input.requestKey || r.operation !== input.operation || r.sourceType !== input.source.type || r.sourceId !== input.source.id || r.commandHash !== hash) fail();
  if (r.outcome !== 'converted') {
    if (!same(r.requestInput, input)) fail();
    if (r.outcome === 'not_confirmed') { if (r.receiptAuditId !== null || r.legacyOrderId !== null || r.cancellationProof !== null || r.legacyProof !== null) fail(); }
    else if (r.outcome === 'cancelled') { const p = r.cancellationProof; if (!p || r.receiptAuditId !== receipt || p.auditId !== receipt || p.actorId !== actorId || p.commandHash !== hash || !same(p.requestInput, input) || !Number.isFinite(Date.parse(p.cancelledAt)) || new Date(p.cancelledAt).toISOString() !== p.cancelledAt || r.legacyOrderId !== null || r.legacyProof !== null) fail(); }
    else if (r.outcome === 'legacy_unverified') { const p = r.legacyProof; if (!p || r.receiptAuditId !== null || r.cancellationProof !== null || !r.legacyOrderId || p.source.id !== input.source.id || p.source.record.id !== p.source.id || p.order.id !== r.legacyOrderId || p.order.record.id !== p.order.id || p.source.record.convertedOrderId !== p.order.id) fail(); }
    else fail(); return clone(r);
  }
  const o = r.original, a: ConversionSourceAnchors = o?.sourceAnchors, p = input.parameters;
  if (r.receiptAuditId !== receipt || !o || !same(o.input, input) || !a || !same(a.source, o.sourceBefore) || await conversionClientDigest(a) !== input.source.expected.contentFingerprint || String(o.sourceBefore.record.updatedAt) !== input.source.expected.updatedAt || o.sourceBefore.record.version !== input.source.expected.quotationVersion || o.sourceAfter.record.convertedOrderId !== r.orderId) fail();
  const row = (v: any) => { if (!v || !v.record || v.id !== v.record.id) fail(); conversionClientCanonical(v); };
  for (const rows of [o.lines, o.productionStages, o.businessAudits, a.quotationLines]) { if (!Array.isArray(rows) || new Set(rows.map((x: any) => x.id)).size !== rows.length) fail(); rows.forEach(row); }
  [o.sourceBefore, o.sourceAfter, o.orderAfter, a.source].forEach(row); [a.customer, a.factory, a.asset, a.profile, a.selectedResult, a.moq?.config, a.moq?.approvedExemption].filter(Boolean).forEach(row);
  if (!Number.isFinite(Date.parse(o.completedAt)) || new Date(o.completedAt).toISOString() !== o.completedAt) fail(); await verifyMoq(a, o.completedAt);
  const order = o.orderAfter.record, source = o.sourceBefore.record;
  if ((a.customer?.id ?? null) !== (source.customerRelationId ?? null) || order.customerRelationId !== (a.customer?.id ?? null) || o.sourceBefore.id !== r.sourceId || o.sourceAfter.id !== r.sourceId || o.orderAfter.id !== r.orderId || o.orderBefore !== null || o.targetBefore !== null || o.lines.some((l: any) => l.record.orderId !== r.orderId) || o.productionStages.some((stage: any) => stage.record.orderId !== r.orderId)) fail();
  if (p.millRelationId === null ? a.factory !== null : a.factory?.id !== p.millRelationId || a.factory.record.deletedAt !== null || order.millName !== a.factory.record.name) fail();
  const qlines = [...a.quotationLines].sort((x, y) => Number(x.record.lineNumber) - Number(y.record.lineNumber)), lines = [...o.lines].sort((x: any, y: any) => x.record.lineNumber - y.record.lineNumber);
  const expectedOrderType = p.type ?? deriveQuotationOrderTypeFromLines(qlines.map((line: any) => ({ unit: line.record.unit })));
  // New unrecorded dates stay empty; old receipts may retain their frozen source's validUntil.
  const hasExpectedDueDate = order.dueDate === (p.dueDate ?? '') || (p.dueDate === null && order.dueDate === (source.validUntil ?? ''));
  if (!qlines.length || qlines.length !== lines.length || order.poNumber !== (p.poNumber ?? source.quotationNumber) || !hasExpectedDueDate || order.sourceCaseId !== (source.developmentCaseId ?? null) || order.millRelationId !== p.millRelationId || order.quoteAmount !== decimal(source.totalAmount, true) || order.status !== 'Pending' || order.paymentInstrument !== (p.paymentInstrument ?? source.paymentInstrument ?? null) || order.type !== expectedOrderType || !same(order.moqSnapshot, a.moq.snapshot) || validMoq(source.moqSnapshot) && !same(a.moq.snapshot, source.moqSnapshot)) fail();
  for (let i = 0; i < qlines.length; i++) { const q = qlines[i].record, l = lines[i].record, quantity = decimal(q.quantity, true); const unit = normalizeOrderQuantityUnit(q.unit);
    if (!unit || !CONVERSION_UNITS.includes(unit) || decimal(l.quantity, true) !== quantity || normalizeOrderQuantityUnit(l.unit) !== unit || l.lineNumber !== i + 1 || l.materialCode !== q.fabricCode || l.description !== q.description || l.unitPrice !== q.unitPrice || l.netValue !== q.amount) fail();
  }
  verifyQuantityHeader(order, lines);
  const keys = ['order_placed', 'materials_confirmed', 'production_planned', 'in_production', 'materials_arrived', 'pre_cut_checked', 'pp_sample_approved', 'manufacturing', 'final_review', 'qc_shipped'];
  if (o.productionStages.length !== 10 || new Set(o.productionStages.map((stage: any) => stage.record.createdAt)).size !== 1 || keys.some((key, i) => o.productionStages.filter((stage: any) => stage.record.stageKey === key && stage.record.stageSeq === i + 1).length !== 1)) fail();
  for (const stage of o.productionStages) { const t = stage.record; if (t.id !== `PST__${r.orderId}__${t.stageKey}` || t.status !== (t.stageSeq === 1 ? 'done' : 'pending') || typeof t.createdAt !== 'string' || !/^\d+$/.test(t.createdAt) || t.updatedAt !== t.createdAt || (t.stageSeq === 1 ? t.doneAt !== t.createdAt || Number(t.doneAt) > Date.parse(o.completedAt) : t.doneAt !== null)) fail(); }
  const audits = o.businessAudits, transitions = audits.filter((x: any) => x.record.actorId === actorId && x.record.action === 'convert_quotation_to_order' && x.record.targetType === 'Quotation' && x.record.targetId === r.sourceId), creates = audits.filter((x: any) => x.record.action === 'create_order_from_quotation' && x.record.targetType === 'Order' && x.record.targetId === r.orderId && x.record.detail?.after?.quotationId === r.sourceId);
  if (transitions.length !== 1 || creates.length !== 1 || audits.some((x: any) => x.record.actorId !== actorId || !['convert_dev_case', 'convert_quotation_to_order', 'create_order_from_quotation'].includes(x.record.action) || ![r.sourceId, r.orderId].includes(x.record.targetId))) fail();
  const audit = transitions[0].record; if (audit.detail?.after?.orderId !== r.orderId || !Number.isFinite(Date.parse(audit.createdAt)) || Date.parse(audit.createdAt) > Date.parse(o.completedAt)) fail();
  const { receiptFingerprint, ...body } = r; if (receiptFingerprint !== await conversionClientDigest({ protocol, ack: body })) fail(); return clone(r);
}
function verifyPreparedContextShape(r: any, selection: any) {
  shape(r, ['conversionVersion', 'protocolInstalled', 'preparation', 'source', 'selection', 'anchors', 'defaults', 'capabilities', 'quantityCapabilities', 'priorConversion']);
  shape(r.source, ['type', 'id', 'expected']); shape(r.source.expected, ['updatedAt', 'quotationVersion', 'contentFingerprint']);
  if (r.source.expected.quotationVersion !== null || typeof r.source.expected.updatedAt !== 'string' || !/^\d+$/.test(r.source.expected.updatedAt) || typeof r.source.expected.contentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(r.source.expected.contentFingerprint) || r.anchors?.source?.id !== r.source.id || r.anchors.source.record?.id !== r.source.id || String(r.anchors.source.record.updatedAt) !== r.source.expected.updatedAt || !same(r.defaults?.selectedSource, selection.selectedSource) || r.defaults?.millRelationId !== r.anchors?.factory?.id) fail();
  const q = r.quantityCapabilities;
  const legacyQuantityContract = q?.writeSchema === 'legacy_integer' && q.supportsFractional === false && q.mixedQuotationUnits === false;
  const decimalQuantityContract = q?.writeSchema === 'decimal18_4' && q.supportsFractional === true && q.mixedQuotationUnits === true;
  if (!q || q.protocol !== 'decimal18_4' || (!legacyQuantityContract && !decimalQuantityContract) || !same(q.supportedUnits, [...CONVERSION_UNITS]) || !['none', 'legacy_unverified', 'immutable_receipt'].includes(r.priorConversion?.kind) || !(r.priorConversion.orderId === null || typeof r.priorConversion.orderId === 'string') || !(r.capabilities?.reason === null || typeof r.capabilities?.reason === 'string')) fail();
  if (selection.operation === 'development_create') {
    shape(r.defaults, ['quantity', 'unit', 'dueDate', 'quoteAmount', 'selectedSource', 'millRelationId', 'orderPo']);
    if (typeof r.defaults.quantity !== 'string' || typeof r.defaults.dueDate !== 'string' || !q.supportedUnits.includes(r.defaults.unit) || !(r.defaults.quoteAmount === null || typeof r.defaults.quoteAmount === 'string') || !(r.defaults.orderPo === null || typeof r.defaults.orderPo === 'string')) fail();
  } else shape(r.defaults, ['orderId', 'expectedTarget', 'selectedSource', 'millRelationId']);
}
export type ConversionServiceOptions = {
  principal: () => ConversionPrincipal; /** Pass sessionStorage; business requests and keys must survive a page refresh. */ storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  fetch?: typeof fetch; timeoutMs?: number;
  /** Must invalidate on every auth/endpoint change, including A → B → A. */
  subscribe?: (invalidate: () => void) => () => void;
};
/** No requests on construction. The host owns auth headers and its active context generation. */
function createBoundConversionCommandService<I extends OrderConversionCommand, O extends OrderConversionOutcome>(options: ConversionServiceOptions, family: 'development' | 'quotation') {
  let epoch = 0, disposed = false; const stop = options.subscribe?.(() => { epoch++; });
  const principal = () => { if (disposed) return fail('STALE_CONTEXT'); const p = options.principal(); id(p.actorId); if (!p.endpoint || !p.generation) fail('UNBOUND_CONTEXT'); return { ...p, endpoint: p.endpoint.replace(/\/$/, ''), headers: { ...p.headers } }; };
  const namespace = (p: ConversionPrincipal) => 'bambook-conversion-pending-v1:' + encodeURIComponent(JSON.stringify([p.actorId, p.endpoint]));
  const take = () => { const p = principal(), version = epoch; return { p, current() { const now = principal(); if (version !== epoch || now.actorId !== p.actorId || now.endpoint !== p.endpoint || now.generation !== p.generation || !same(now.headers, p.headers)) fail('STALE_CONTEXT'); } }; };
  const parse = (raw: unknown): I => { const input = parseOrderConversionCommand(raw); if (input.source.type !== family) return fail('UNSUPPORTED_COMMAND'); return input as I; };
  const read = (p: ConversionPrincipal): ConversionPending<I> | null => {
    let value: string | null; try { value = options.storage.getItem(namespace(p)); } catch { return fail('STORAGE_UNAVAILABLE'); }
    if (value === null) return null;
    try { const pending = JSON.parse(value); shape(pending, ['version', 'actorId', 'endpoint', 'input']); if (pending.version !== 1 || pending.actorId !== p.actorId || pending.endpoint !== p.endpoint) fail('CORRUPT_PENDING'); return { ...pending, input: parse(pending.input) }; } catch { return fail('CORRUPT_PENDING'); }
  };
  const write = (p: ConversionPrincipal, pending: ConversionPending<I>) => { try { options.storage.setItem(namespace(p), conversionClientCanonical(pending)); if (!same(read(p), pending)) fail('STORAGE_UNAVAILABLE'); } catch { return fail('STORAGE_UNAVAILABLE'); } };
  const retire = (p: ConversionPrincipal, input: I) => { const pending = read(p); if (!pending || !same(pending.input, input)) fail('PENDING_CHANGED'); try { options.storage.removeItem(namespace(p)); if (options.storage.getItem(namespace(p)) !== null) fail('STORAGE_UNAVAILABLE'); } catch { return fail('STORAGE_UNAVAILABLE'); } };
  const post = async (ticket: ReturnType<typeof take>, sourceId: string, action: string, body: unknown) => {
    ticket.current(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(ticket.p.endpoint + (family === 'development' ? '/v1/development/' : '/v1/quotations/') + encodeURIComponent(sourceId) + '/convert-command/' + action, { method: 'POST', credentials: 'include', headers: { ...ticket.p.headers, 'Content-Type': 'application/json' }, body: conversionClientCanonical(body), signal: controller.signal });
      const wire = await response.json(); ticket.current();
      if (!response.ok || wire?.ok !== true) { const e = wire?.error; throw new ConversionClientError(typeof e?.code === 'string' ? e.code : 'REQUEST_FAILED', typeof e?.message === 'string' ? e.message : '转单请求失败，请保留原请求。', typeof e?.approvalRequestId === 'string' ? e.approvalRequestId : undefined, typeof e?.blockCode === 'string' ? e.blockCode : undefined); }
      shape(wire, ['ok', 'result']); return wire.result;
    } finally { clearTimeout(timer); }
  };
  const command = async (ticket: ReturnType<typeof take>, action: string, input: I) => { const raw = await post(ticket, input.source.id, action, input); const outcome = (input.operation === 'quotation_create' ? await verifyQuotationConversionOutcome(raw, ticket.p.actorId, input) : await verifyDevelopmentConversionOutcome(raw, ticket.p.actorId, input)) as O; ticket.current(); if (outcome.outcome === 'converted' || outcome.outcome === 'linked' || outcome.outcome === 'cancelled') retire(ticket.p, input); return outcome; };
  return {
    pending: () => clone(read(principal())),
    dispose() { disposed = true; epoch++; stop?.(); },
    async context(sourceId: string, selectedSource: DevelopmentCreateCommand['parameters']['selectedSource']): Promise<ConversionContext> {
      if (family !== 'development') fail('UNSUPPORTED_COMMAND'); const ticket = take(); if (read(ticket.p)) fail('PENDING_EXISTS'); id(sourceId); shape(selectedSource, ['type', 'id']); id(selectedSource.id); if (!['Asset', 'primary_asset', 'SealSample', 'Sample'].includes(selectedSource.type)) fail('UNSUPPORTED_COMMAND');
      const r = await post(ticket, sourceId, 'context', { operation: 'development_create', selectedSource });
      if (r?.conversionVersion !== 1 || r.protocolInstalled !== true || r.preparation?.state !== 'prepared' || r.source?.type !== 'development' || r.source.id !== sourceId || !same(r.selection, { operation: 'development_create', selectedSource }) || await conversionClientDigest(r.anchors) !== r.source.expected.contentFingerprint || r.preparation.auditId !== 'OCTX_' + await conversionClientDigest({ protocol, actorId: ticket.p.actorId, sourceType: r.source.type, sourceId, contentFingerprint: r.source.expected.contentFingerprint }) || typeof r.capabilities?.canExecute !== 'boolean' || typeof r.capabilities?.canRecover !== 'boolean' || typeof r.capabilities?.canCancelUnexecuted !== 'boolean') fail();
      verifyPreparedContextShape(r, r.selection); ticket.current(); return clone(r);
    },
    async contextLink(sourceId: string, orderId: string, selectedSource: ConversionSelectedSource): Promise<ConversionContext> {
      if (family !== 'development') fail('UNSUPPORTED_COMMAND'); const ticket = take(); if (read(ticket.p)) fail('PENDING_EXISTS'); id(sourceId); id(orderId); shape(selectedSource, ['type', 'id']); id(selectedSource.id); if (!['Asset', 'primary_asset', 'SealSample', 'Sample'].includes(selectedSource.type)) fail('UNSUPPORTED_COMMAND');
      const selection = { operation: 'development_link', orderId, selectedSource }, r = await post(ticket, sourceId, 'context', selection), target = r?.defaults?.expectedTarget;
      if (!target || typeof target.updatedAt !== 'string' || !/^\d+$/.test(target.updatedAt) || typeof target.contentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(target.contentFingerprint) || r.defaults.orderId !== orderId || !same(r.defaults.selectedSource, selectedSource) || r.defaults.millRelationId !== r.anchors?.factory?.id || r?.conversionVersion !== 1 || r.protocolInstalled !== true || r.preparation?.state !== 'prepared' || r.source?.type !== 'development' || r.source.id !== sourceId || !same(r.selection, selection) || await conversionClientDigest(r.anchors) !== r.source.expected.contentFingerprint || r.preparation.auditId !== 'OCTX_' + await conversionClientDigest({ protocol, actorId: ticket.p.actorId, sourceType: r.source.type, sourceId, contentFingerprint: r.source.expected.contentFingerprint, linkTarget: { orderId, contentFingerprint: target.contentFingerprint } }) || typeof r.capabilities?.canExecute !== 'boolean' || typeof r.capabilities?.canRecover !== 'boolean' || typeof r.capabilities?.canCancelUnexecuted !== 'boolean') fail();
      verifyPreparedContextShape(r, r.selection); ticket.current(); return clone(r);
    },
    async contextQuotation(sourceId: string, overrides: QuotationCreateCommand['parameters']): Promise<QuotationConversionContext> {
      if (family !== 'quotation') fail('UNSUPPORTED_COMMAND'); const ticket = take(); if (read(ticket.p)) fail('PENDING_EXISTS'); id(sourceId);
      const checked = parseQuotationCreateCommand({ conversionVersion: 1, requestKey: 'context-validate', source: { type: 'quotation', id: sourceId, expected: { updatedAt: '1', quotationVersion: 1, contentFingerprint: '0'.repeat(64) } }, operation: 'quotation_create', parameters: overrides });
      const selection = { operation: 'quotation_create', overrides: checked.parameters }, r = await post(ticket, sourceId, 'context', selection);
      shape(r, ['conversionVersion', 'protocolInstalled', 'preparation', 'source', 'selection', 'anchors', 'defaults', 'capabilities', 'quantityCapabilities', 'priorConversion']);
      if (r.conversionVersion !== 1 || r.protocolInstalled !== true || r.preparation?.state !== 'prepared' || r.source?.type !== 'quotation' || r.source.id !== sourceId || typeof r.source.expected?.updatedAt !== 'string' || !/^\d+$/.test(r.source.expected.updatedAt) || !Number.isSafeInteger(r.source.expected.quotationVersion) || r.source.expected.quotationVersion < 1 || r.anchors?.source?.id !== sourceId || r.anchors.source.record.id !== sourceId || String(r.anchors.source.record.updatedAt) !== r.source.expected.updatedAt || r.anchors.source.record.version !== r.source.expected.quotationVersion || !same(r.selection, selection) || !same(r.defaults, checked.parameters) || await conversionClientDigest(r.anchors) !== r.source.expected.contentFingerprint || r.preparation.auditId !== 'OCTX_' + await conversionClientDigest({ protocol, actorId: ticket.p.actorId, sourceType: r.source.type, sourceId, contentFingerprint: r.source.expected.contentFingerprint }) || typeof r.capabilities?.canExecute !== 'boolean' || typeof r.capabilities?.canRecover !== 'boolean' || typeof r.capabilities?.canCancelUnexecuted !== 'boolean') fail();
      const factory = r.anchors.factory, factoryId = checked.parameters.millRelationId;
      if (factoryId === null ? factory !== null : factory?.id !== factoryId || factory.record?.id !== factoryId || factory.record.deletedAt !== null || ('category' in factory.record && factory.record.category !== 'Supplier') || ('isOrganization' in factory.record && factory.record.isOrganization !== true)) fail();
      const q = r.quantityCapabilities, supportedUnits = ['M', 'YD', 'KG', 'G', 'PC', 'SET', 'ROLL', 'DOZEN'];
      const legacyQuantityContract = q?.writeSchema === 'legacy_integer' && q.supportsFractional === false && q.mixedQuotationUnits === false;
      const decimalQuantityContract = q?.writeSchema === 'decimal18_4' && q.supportsFractional === true && q.mixedQuotationUnits === true;
      if (!q || q.protocol !== 'decimal18_4' || (!legacyQuantityContract && !decimalQuantityContract) || !same(q.supportedUnits, supportedUnits)) fail();
      ticket.current(); return clone(r);
    },
    async execute(raw: I) {
      const ticket = take(), input = parse(raw), pending = read(ticket.p);
      if (pending) { if (!same(pending.input, input)) fail('PENDING_EXISTS'); const recovery = await command(ticket, 'recover', pending.input); if (recovery.outcome !== 'not_confirmed') return recovery; }
      else write(ticket.p, { version: 1, actorId: ticket.p.actorId, endpoint: ticket.p.endpoint, input });
      return command(ticket, 'execute', input);
    },
    async recover() { const ticket = take(), pending = read(ticket.p); if (!pending) return fail('NO_PENDING'); return command(ticket, 'recover', pending.input); },
    async cancel() { const ticket = take(), pending = read(ticket.p); if (!pending) return fail('NO_PENDING'); return command(ticket, 'cancel', pending.input); },
  };
}

/** Existing Dev API stays narrowly typed and unchanged. */
export function createOrderConversionCommandService(options: ConversionServiceOptions) { return createBoundConversionCommandService<DevelopmentConversionCommand, ConversionAck | ConversionRecovery>(options, 'development'); }
export function createQuotationConversionCommandService(options: ConversionServiceOptions) { return createBoundConversionCommandService<QuotationCreateCommand, QuotationConversionAck | QuotationConversionRecovery>(options, 'quotation'); }
