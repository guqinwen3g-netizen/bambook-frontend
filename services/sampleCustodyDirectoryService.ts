import { apiService } from './apiService';
import { getAuthState, hasPermission, subscribe } from './authService';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';
import { normalizeLibraryMetadata, normalizeLibraryFilters, LIBRARY_FILTER_KEYS, type SampleLibraryMetadata, type SampleLibraryFilters, type LibrarySort, type LibraryFacets } from '../server/src/shared/sampleLibraryMetadata';
export type { SampleLibraryFilters, LibrarySort, LibraryFacets } from '../server/src/shared/sampleLibraryMetadata';

export type CustodyLane = 'fabric' | 'garment' | 'trim' | 'other' | 'review';
export type CustodyVisibility = 'catalog' | 'full';
export type CustodyMaterialFilter = '' | 'fabric' | 'garment' | 'colorcard' | 'trim' | 'other';
export interface CustodyCard {
  id: string; code: string; cardType: string; location: string | null;
  locationDetail?: { zone: string | null; shelf: string | null; level: string | null; bin: string | null } | null;
  quantity: number; availableQty: number; unit: string | null;
  physicalLengthQty?: string | null; availableLengthQty?: string | null;
  photos?: CustodyPhoto[];
  libraryMetadata?: SampleLibraryMetadata | null; customerRelationId?: string | null; customerName?: string | null;
  warehouseId?: string | null; warehouseName?: string | null; sealedStatus?: string;
}
export interface CustodyPhoto { id: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; size: number; uploadedAt: string; signature: string; url: string }
export interface CustodyCatalogItem {
  visibility: 'catalog'; card: CustodyCard;
  businessContext: { status: 'unresolved'; businessLine: null; reasons: ['OWNERSHIP_NOT_RECORDED'] };
}
export interface CustodyFullItem {
  visibility: 'full'; card: CustodyCard & { name: string; status: string };
  businessContext: { status: 'resolved' | 'unresolved' | 'conflict'; businessLine: 'fabric' | 'garment' | null; reasons: string[] };
  receiptStatus: 'verified' | 'legacyUnverified' | 'manual';
  archive?: CustodyFabricArchive;
}
export interface CustodyFabricArchive {
  id: string; identityKind: 'product' | 'development-version' | 'sample' | 'batch' | 'physical-item';
  name: string; code: string; productAssetId: string | null; developmentSampleVersionId: string | null; sourceLabel: string | null;
  forms: Array<{ kind: string; unit: string; total: string | null; available: string | null; locations: Array<{ location: string | null; total: string | null; available: string | null; memberIds: string[] }> }>;
  members: Array<{ id: string; code: string; name: string; cardType: string; status: string; location: string | null; unit: string; total: string | null; available: string | null;
    businessContext: { status: 'resolved' | 'unresolved' | 'conflict'; businessLine: 'fabric' | 'garment' | null; reasons: string[] };
    receiptStatus: 'verified' | 'legacyUnverified' | 'manual' }>;
}
export type CustodyDirectoryItem = CustodyCatalogItem | CustodyFullItem;
export interface CustodyDirectoryPage {
  ok: true; directoryVersion: 3 | 4; lane: CustodyLane;
  pagination: { limit: number; offset: number };
  filters: { search: string; cardType: CustodyMaterialFilter };
  snapshotAt: string; total: number; items: CustodyDirectoryItem[];
  criteria?: SampleLibraryFilters; sort?: LibrarySort; facets?: LibraryFacets;
}
export interface CustodyDirectoryQuery {
  lane: CustodyLane; limit?: number; offset?: number; search?: string; cardType?: CustodyMaterialFilter; filter?: SampleLibraryFilters; sort?: LibrarySort;
}
export interface CustodyDirectoryOptions { signal?: AbortSignal; current?: () => boolean; }
export class CustodyDirectoryError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string) { super(message); }
}

type JsonObject = Record<string, unknown>;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: unknown, expected: string[]): v is JsonObject => object(v) && Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const identifier = (v: unknown): v is string => typeof v === 'string' && !!v && v.trim() === v && v.length <= 200;
const nullableText = (v: unknown) => v === null || typeof v === 'string';
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const custodyQuantity = (v: unknown, unit: unknown): v is number => count(v)
  || typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER
    && typeof unit === 'string' && /^(?:m|米)$/i.test(unit.trim())
    && /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(String(v));
const lane = (v: unknown): v is CustodyLane => v === 'fabric' || v === 'garment' || v === 'trim' || v === 'other' || v === 'review';
const material = (v: unknown): v is CustodyMaterialFilter => ['', 'fabric', 'garment', 'colorcard', 'trim', 'other'].includes(v as string);
const fail = (message = '样品目录暂时无法加载，请刷新重试；若仍失败，请联系管理员。'): never => { throw new CustodyDirectoryError(message); };

/** Only held in memory; never persist or log tokens, ceilings or endpoint credentials. */
export const custodyDirectoryIdentity = () => JSON.stringify([getAuthState(), apiService.getStoredConfig().cloudEndpoint, apiService.getAuthHeaders()]);

function query(input: CustodyDirectoryQuery) {
  if (!object(input) || Object.keys(input).some(k => !['lane', 'limit', 'offset', 'search', 'cardType', 'filter', 'sort'].includes(k)) || !lane(input.lane)) return fail('请选择有效的实物分类');
  const limit = input.limit === undefined ? 50 : input.limit, offset = input.offset === undefined ? 0 : input.offset;
  if (!count(limit) || limit > 100 || !count(offset) || input.search !== undefined && typeof input.search !== 'string' || input.cardType !== undefined && !material(input.cardType)) return fail('实物台账筛选或分页参数不正确');
  let filter: SampleLibraryFilters; try { filter = normalizeLibraryFilters(input.filter); } catch { return fail('样品筛选条件不正确'); }
  const sort = input.sort ?? 'newest'; if (!['newest','oldest','name','code','available_desc','available_asc'].includes(sort)) return fail('请选择有效的排序方式');
  return { lane: input.lane, limit, offset, search: input.search?.trim() || '', cardType: input.cardType || '', filter, sort, extended: input.filter !== undefined || input.sort !== undefined };
}

function checkedBusinessContext(value: unknown): boolean {
  return keys(value, ['status','businessLine','reasons'])
    && ['resolved','unresolved','conflict'].includes(value.status as string)
    && (value.businessLine === null || value.businessLine === 'fabric' || value.businessLine === 'garment')
    && Array.isArray(value.reasons) && value.reasons.every(reason => typeof reason === 'string');
}
const decimalText = (value: unknown): value is string | null => value === null || typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value);
function checkedFabricArchive(value: unknown): value is CustodyFabricArchive {
  if (!keys(value, ['id','identityKind','name','code','productAssetId','developmentSampleVersionId','sourceLabel','forms','members'])
    || !identifier(value.id) || !['product','development-version','sample','batch','physical-item'].includes(value.identityKind as string)
    || typeof value.name !== 'string' || typeof value.code !== 'string' || !nullableText(value.productAssetId)
    || !nullableText(value.developmentSampleVersionId) || !nullableText(value.sourceLabel)
    || !Array.isArray(value.forms) || !Array.isArray(value.members) || !value.members.length) return false;
  const memberIds = new Set<string>();
  for (const member of value.members) {
    if (!keys(member, ['id','code','name','cardType','status','location','unit','total','available','businessContext','receiptStatus'])
      || !identifier(member.id) || !identifier(member.code) || typeof member.name !== 'string' || typeof member.cardType !== 'string'
      || typeof member.status !== 'string' || !nullableText(member.location) || typeof member.unit !== 'string'
      || !decimalText(member.total) || !decimalText(member.available) || !checkedBusinessContext(member.businessContext)
      || !['verified','legacyUnverified','manual'].includes(member.receiptStatus as string) || memberIds.has(member.id)) return false;
    memberIds.add(member.id);
  }
  if (value.identityKind === 'product' && (!identifier(value.productAssetId) || value.developmentSampleVersionId !== null)
    || value.identityKind === 'development-version' && (!identifier(value.developmentSampleVersionId) || value.productAssetId !== null)
    || !['product','development-version'].includes(value.identityKind as string) && (value.productAssetId !== null || value.developmentSampleVersionId !== null)) return false;
  const representedMembers = new Set<string>();
  for (const form of value.forms) {
    if (!keys(form, ['kind','unit','total','available','locations']) || typeof form.kind !== 'string' || typeof form.unit !== 'string'
      || !decimalText(form.total) || !decimalText(form.available) || !Array.isArray(form.locations)) return false;
    for (const location of form.locations) {
      if (!keys(location, ['location','total','available','memberIds']) || !nullableText(location.location)
        || !decimalText(location.total) || !decimalText(location.available) || !Array.isArray(location.memberIds)
        || !location.memberIds.length || location.memberIds.some(id => typeof id !== 'string' || !memberIds.has(id))) return false;
      for (const id of location.memberIds as string[]) {
        if (representedMembers.has(id)) return false;
        representedMembers.add(id);
      }
    }
  }
  if (representedMembers.size !== memberIds.size || [...memberIds].some(id => !representedMembers.has(id))) return false;
  return true;
}

/** Length stays independent of the physical item count; an unknown pair stays unknown. */
function checkedLengthBalance(card: JsonObject): boolean {
  const hasTotal = Object.hasOwn(card, 'physicalLengthQty'), hasAvailable = Object.hasOwn(card, 'availableLengthQty');
  if (!hasTotal && !hasAvailable) return true;
  if (hasTotal !== hasAvailable) return false;
  const total = card.physicalLengthQty, available = card.availableLengthQty;
  if (total === null || available === null) return total === null && available === null;
  const valid = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value);
  if (!valid(total) || !valid(available)) return false;
  const scaled = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0')); };
  return scaled(available) <= scaled(total);
}

function checkedItem(item: unknown, requested: CustodyLane, directoryVersion: 3 | 4): item is CustodyDirectoryItem {
  if (!object(item) || item.visibility !== 'catalog' && item.visibility !== 'full') return false;
  const catalog = item.visibility === 'catalog';
  const hasArchive = !catalog && Object.hasOwn(item, 'archive');
  if (!keys(item, catalog ? ['visibility', 'card', 'businessContext'] : ['visibility', 'card', 'businessContext', 'receiptStatus', ...(hasArchive ? ['archive'] : [])])) return false;
  const archiveRequired = !catalog && directoryVersion === 4 && requested === 'fabric';
  if (hasArchive !== archiveRequired) return false;
  const archive = hasArchive && checkedFabricArchive(item.archive) ? item.archive : null;
  if (hasArchive && !archive) return false;
  const c = item.card, b = item.businessContext;
  if (!keys(c, ['id', 'code', 'cardType', 'location', 'quantity', 'availableQty', 'unit', ...(catalog ? [] : ['name', 'status', 'photos', 'locationDetail', ...['physicalLengthQty','availableLengthQty','libraryMetadata','customerRelationId','customerName','warehouseId','warehouseName','sealedStatus'].filter(key => object(c) && Object.hasOwn(c,key))])]) || !identifier(c.id) || !identifier(c.code) || typeof c.cardType !== 'string' || !nullableText(c.location) || !nullableText(c.unit) || !custodyQuantity(c.quantity, c.unit) || !custodyQuantity(c.availableQty, c.unit) || c.availableQty > c.quantity
    || !keys(b, ['status', 'businessLine', 'reasons']) || !Array.isArray(b.reasons) || !b.reasons.every(r => typeof r === 'string')) return false;
  if (archive && !archive.members.some(member => member.id === c.id)) return false;
  if (catalog) {
    const belongsToLane = requested === 'review' || requested === 'fabric' && (c.cardType === 'fabric' || c.cardType === 'colorcard')
      || requested === 'garment' && c.cardType === 'garment' || requested === 'trim' && c.cardType === 'trim' || requested === 'other' && c.cardType === 'other';
    return belongsToLane && b.status === 'unresolved' && b.businessLine === null && b.reasons.length === 1 && b.reasons[0] === 'OWNERSHIP_NOT_RECORDED';
  }
  if (!checkedLengthBalance(c) || typeof c.name !== 'string' || typeof c.status !== 'string' || !['verified', 'legacyUnverified', 'manual'].includes(item.receiptStatus as string)) return false;
  if (!Array.isArray(c.photos) || !c.photos.every(p => keys(p, ['id', 'mimeType', 'size', 'uploadedAt', 'signature', 'url']) && identifier(p.id) && ['image/jpeg', 'image/png', 'image/webp'].includes(p.mimeType as string) && count(p.size) && typeof p.uploadedAt === 'string' && Number.isFinite(Date.parse(p.uploadedAt)) && identifier(p.signature) && /^[a-f0-9]{64}$/.test(p.signature) && typeof p.url === 'string' && p.url === `/api/v1/samples/room/items/${encodeURIComponent(c.id as string)}/photos/${encodeURIComponent(p.id)}?sig=${encodeURIComponent(p.signature)}`)) return false;
  if (!Object.hasOwn(c, 'locationDetail') || c.locationDetail !== null && (!keys(c.locationDetail, ['zone', 'shelf', 'level', 'bin']) || !['zone', 'shelf', 'level', 'bin'].every(key => nullableText((c.locationDetail as any)[key])))) return false;
  for (const key of ['customerRelationId','customerName','warehouseId','warehouseName']) if (Object.hasOwn(c,key) && !nullableText(c[key])) return false;
  if (Object.hasOwn(c,'sealedStatus') && !['sealed','unsealed'].includes(c.sealedStatus as string)) return false;
  if (Object.hasOwn(c,'libraryMetadata')) { try { normalizeLibraryMetadata(c.libraryMetadata, c.cardType as string); } catch { return false; } }
  // Physical lanes classify the card itself. Its business owner remains an independent label.
  if (requested === 'review') return (b.status === 'unresolved' || b.status === 'conflict') && b.businessLine === null;
  // The physical lane comes from the card itself. Ownership can remain unresolved
  // or conflicted while the authorized holder still needs to find the real item.
  if (!['resolved', 'unresolved', 'conflict'].includes(b.status as string) || b.businessLine !== null && b.businessLine !== 'fabric' && b.businessLine !== 'garment') return false;
  if (requested === 'fabric') return c.cardType === 'fabric' || c.cardType === 'colorcard';
  if (requested === 'garment') return c.cardType === 'garment';
  if (requested === 'trim') return c.cardType === 'trim';
  return c.cardType === 'other';
}

function checkedPage(value: unknown, q: ReturnType<typeof query>): CustodyDirectoryPage {
  const expectedVersion = q.lane === 'fabric' ? 4 : 3;
  if (!keys(value, ['ok', 'directoryVersion', 'lane', 'pagination', 'filters', 'snapshotAt', 'total', 'items', ...['criteria','sort','facets'].filter(key => object(value) && Object.hasOwn(value,key))]) || value.ok !== true || value.directoryVersion !== expectedVersion || value.lane !== q.lane
    || !keys(value.pagination, ['limit', 'offset']) || value.pagination.limit !== q.limit || value.pagination.offset !== q.offset
    || !keys(value.filters, ['search', 'cardType']) || value.filters.search !== q.search || value.filters.cardType !== q.cardType
    || typeof value.snapshotAt !== 'string' || !/^\d+$/.test(value.snapshotAt) || !count(value.total) || !Array.isArray(value.items)
    || value.items.length !== Math.min(q.limit, Math.max(0, value.total - q.offset))) return fail();
  if (q.extended && (!Object.hasOwn(value,'criteria') || !Object.hasOwn(value,'sort') || !Object.hasOwn(value,'facets'))) return fail();
  if (Object.hasOwn(value,'criteria')) { try { if (JSON.stringify(normalizeLibraryFilters(value.criteria)) !== JSON.stringify(q.filter)) return fail(); } catch { return fail(); } }
  if (Object.hasOwn(value,'sort') && value.sort !== q.sort) return fail();
  if (Object.hasOwn(value,'facets')) {
    if (!object(value.facets) || Object.keys(value.facets).some(key => !(LIBRARY_FILTER_KEYS as readonly string[]).includes(key))) return fail();
    for (const choices of Object.values(value.facets)) { if (!Array.isArray(choices) || choices.some(choice => !keys(choice,['value','label','count']) || !identifier(choice.value) || typeof choice.label !== 'string' || !count(choice.count)) || new Set(choices.map(choice=>choice.value)).size !== choices.length) return fail(); }
  }
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!checkedItem(item, q.lane, expectedVersion) || ids.has(item.card.id)) return fail();
    ids.add(item.card.id);
  }
  return value as unknown as CustodyDirectoryPage;
}

/** One read-only protocol. No legacy reader, detail request, or business write is used as a fallback. */
async function list(input: CustodyDirectoryQuery, options: CustodyDirectoryOptions = {}): Promise<CustodyDirectoryPage> {
  const q = query(input), a = getAuthState(), endpoint = apiService.getStoredConfig().cloudEndpoint;
  if (a.isLoading || !a.isAuthenticated || !identifier(a.user?.id) || typeof endpoint !== 'string' || !endpoint.trim() || !hasPermission('products:read')) throw new CustodyDirectoryError('当前账号无法读取实物台账', 403, 'FORBIDDEN');
  const identity = custodyDirectoryIdentity(), headers = apiService.getAuthHeaders(), controller = new AbortController(); let stale = false;
  const observe = () => { if (identity !== custodyDirectoryIdentity() || options.current?.() === false || options.signal?.aborted || !hasPermission('products:read')) { stale = true; controller.abort(); } };
  const invalidate = () => { stale = true; controller.abort(); };
  const check = () => { observe(); if (stale) throw new CustodyDirectoryError('账号、权限、业务范围或服务已变化，请重新读取实物台账'); };
  const stop = subscribe(observe);
  if (typeof window !== 'undefined') { window.addEventListener('storage', observe); window.addEventListener('focus', observe); window.addEventListener(EMAIL_CONTEXT_EVENT, invalidate); }
  options.signal?.addEventListener('abort', invalidate, { once: true });
  try {
    check();
    const params = new URLSearchParams({ lane: q.lane, limit: String(q.limit), offset: String(q.offset), search: q.search, cardType: q.cardType });
    if (q.extended) { params.set('filter', JSON.stringify(q.filter)); params.set('sort',q.sort); }
    const response = await fetch(apiService.buildApiUrl('/v1/samples/room/custody-directory?' + params, endpoint), { method: 'GET', headers, signal: controller.signal }); check();
    const value = await response.json(); check();
    if (!response.ok) throw new CustodyDirectoryError(object(value) && object(value.error) && typeof value.error.message === 'string' && value.error.message.trim() ? value.error.message : '实物台账暂时无法读取，请重试', response.status, object(value) && object(value.error) && typeof value.error.code === 'string' ? value.error.code : undefined);
    const result = checkedPage(value, q); check(); return result;
  } catch (cause) {
    check();
    if (cause instanceof CustodyDirectoryError) throw cause;
    throw new CustodyDirectoryError('实物台账暂时无法读取，请重试');
  } finally {
    stop(); options.signal?.removeEventListener('abort', invalidate);
    if (typeof window !== 'undefined') { window.removeEventListener('storage', observe); window.removeEventListener('focus', observe); window.removeEventListener(EMAIL_CONTEXT_EVENT, invalidate); }
  }
}

export const sampleCustodyDirectoryService = { list };
