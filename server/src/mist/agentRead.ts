/**
 * 工作助手业务读取（bambook_query / bambook_get / bambook_expand）。
 * 只在“按当前执行者权限裁剪后的工作区状态”上运行：仓储先按账号权限 ∩ 委托上限投影，这里再按对象类型的读权限复核一次。
 * 结果只含业务字段摘要与站内链接；大字段（图片数据、长文本、嵌套明细）截短，不返回附件内容。
 */
import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import type { MistState } from '../shared/mistWorkspace';
import { MistApiError } from './errors';

type ObjectType = { type: string; label: string; scope: PermissionScope; path: string[]; view: string; linkId?: (row: any) => string | undefined };

/** 首批可读对象。view 与前端路由一致，链接由页面用 go(view, id) 打开。 */
export const AGENT_OBJECT_TYPES: ObjectType[] = [
  { type: 'customer', label: '客户', scope: 'relations:read', path: ['customers'], view: 'crm' },
  { type: 'contact', label: '联系人', scope: 'relations:read', path: ['contacts'], view: 'crm', linkId: r => r.customerId },
  { type: 'order', label: '订单', scope: 'orders:read', path: ['orders'], view: 'orders/detail' },
  { type: 'order_line', label: '订单行', scope: 'orders:read', path: ['orderLines'], view: 'orders/detail', linkId: r => r.orderId },
  { type: 'development', label: '开发单', scope: 'products:read', path: ['devs'], view: 'development/detail' },
  { type: 'dev_version', label: '开发版本', scope: 'products:read', path: ['versions'], view: 'development/detail', linkId: r => r.devId },
  { type: 'product', label: '产品档案', scope: 'products:read', path: ['market', 'products'], view: 'products' },
  { type: 'sample', label: '样品', scope: 'products:read', path: ['fulfillment', 'samples'], view: 'samples' },
  { type: 'quotation', label: '报价', scope: 'quotations:read', path: ['market', 'quotations'], view: 'quotations' },
  { type: 'supplier', label: '供应商', scope: 'suppliers:read', path: ['market', 'suppliers'], view: 'suppliers' },
  { type: 'purchase', label: '采购合同', scope: 'procurement:read', path: ['fulfillment', 'purchases'], view: 'procurement' },
  { type: 'production', label: '生产', scope: 'production:read', path: ['productions'], view: 'production-board' },
  { type: 'shipment', label: '出运', scope: 'shipments:read', path: ['fulfillment', 'shipments'], view: 'shipments' },
  { type: 'invoice', label: '发票', scope: 'invoices:read', path: ['invoices'], view: 'invoices' },
  { type: 'risk', label: '风险', scope: 'risk:read', path: ['platform', 'risks'], view: 'risks' },
  { type: 'claim', label: '售后案件', scope: 'aftersales:read', path: ['platform', 'claims'], view: 'claims' },
];

const LABEL_FIELDS = ['code', 'sku', 'name', 'title', 'label', 'style'];
const TEXT_LIMIT = 300;
const GET_LIMIT = 16_000;
export const QUERY_LIMIT_MAX = 20;
export const RELATED_LIMIT = 30;
const QUERY_RESULT_MAX = 20_000; // 留出工作区等字段的空间，低于本机 Harness 的 24k 单工具上限。

function deny(code: string, message: string, status = 400): never { throw new MistApiError(code, message, status); }

function rows(state: MistState, type: ObjectType): any[] {
  let value: any = state;
  for (const key of type.path) value = value?.[key];
  return Array.isArray(value) ? value.filter(r => r && typeof r === 'object' && typeof r.id === 'string') : [];
}
function readable(actor: TokenPayload) { return AGENT_OBJECT_TYPES.filter(t => hasScope(actor, t.scope)); }
function typeOf(name: unknown, actor: TokenPayload): ObjectType {
  const type = AGENT_OBJECT_TYPES.find(t => t.type === name);
  if (!type) deny('INVALID_INPUT', `不支持的对象类型；可用：${AGENT_OBJECT_TYPES.map(t => t.type).join(', ')}`);
  if (!hasScope(actor, type!.scope)) deny('FORBIDDEN', `当前账号无权读取${type!.label}`, 403);
  return type!;
}
function labelOf(row: any): string {
  for (const key of LABEL_FIELDS) if (typeof row[key] === 'string' && row[key].trim()) return row[key].trim().slice(0, 120);
  return row.id;
}
/** 去掉图片数据、截短长文本；嵌套对象只保留到给定深度。 */
function compact(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.startsWith('data:') ? '[图片数据已省略]' : value.length > TEXT_LIMIT ? value.slice(0, TEXT_LIMIT) + '…' : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth <= 0) return Array.isArray(value) ? `[${value.length} 项]` : '[对象]';
  if (Array.isArray(value)) { const head = value.slice(0, 20).map(v => compact(v, depth - 1)); return value.length > 20 ? [...head, `…另有 ${value.length - 20} 项`] : head; }
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'img').map(([k, v]) => [k, compact(v, depth - 1)]));
}
function summary(row: any) {
  return Object.fromEntries(Object.entries(row).filter(([k, v]) => k !== 'img' && (v === null || ['string', 'number', 'boolean'].includes(typeof v))).slice(0, 14).map(([k, v]) => [k, compact(v, 0)]));
}
function link(type: ObjectType, row: any) {
  const id = type.linkId ? type.linkId(row) : row.id;
  return typeof id === 'string' && id ? `bambook://open?view=${encodeURIComponent(type.view)}&id=${encodeURIComponent(id)}` : null;
}
function ref(type: ObjectType, row: any) { return { type: type.type, id: row.id as string, label: labelOf(row), link: link(type, row) }; }

export function agentCatalog(actor: TokenPayload) {
  return readable(actor).map(t => ({ type: t.type, label: t.label }));
}

export function agentQuery(state: MistState, actor: TokenPayload, input: { type?: unknown; q?: unknown; limit?: unknown }) {
  if (input.q !== undefined && typeof input.q !== 'string') deny('INVALID_INPUT', 'q 须为查询文字');
  const q = typeof input.q === 'string' ? input.q.trim().toLowerCase().slice(0, 200) : '';
  const limitRaw = input.limit === undefined ? 10 : Number(input.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) deny('INVALID_INPUT', 'limit 须为正整数');
  const limit = Math.min(limitRaw, QUERY_LIMIT_MAX);
  const types = input.type === undefined || input.type === '' ? readable(actor) : [typeOf(input.type, actor)];
  const terms = q.split(/\s+/).filter(Boolean);
  const matches: Array<ReturnType<typeof ref> & { summary: Record<string, unknown> }> = [];
  let total = 0, size = 0;
  for (const type of types) for (const row of rows(state, type)) {
    if (terms.length) {
      const hay = JSON.stringify(summary(row)).toLowerCase();
      if (!terms.every(term => hay.includes(term))) continue;
    }
    total++;
    if (matches.length < limit) {
      const result = { ...ref(type, row), summary: summary(row) }, length = JSON.stringify(result).length + 1;
      if (size + length <= QUERY_RESULT_MAX) { matches.push(result); size += length; }
    }
  }
  return { results: matches, total, truncated: total > matches.length, readableTypes: types.map(t => t.type) };
}

function find(state: MistState, actor: TokenPayload, typeName: unknown, id: unknown) {
  const type = typeOf(typeName, actor);
  if (typeof id !== 'string' || !id || id.length > 200) deny('INVALID_INPUT', '对象编号无效');
  const row = rows(state, type).find(r => r.id === id || r.code === id || r.sku === id);
  if (!row) deny('NOT_FOUND', `${type.label}不存在或当前账号不可见`, 404);
  return { type, row };
}

export function agentGet(state: MistState, actor: TokenPayload, typeName: unknown, id: unknown) {
  const { type, row } = find(state, actor, typeName, id);
  let data = compact(row, 3) as Record<string, unknown>;
  let text = JSON.stringify(data);
  let truncated = false;
  if (text.length > GET_LIMIT) { data = compact(row, 1) as Record<string, unknown>; text = JSON.stringify(data); truncated = true; }
  if (text.length > GET_LIMIT) { data = summary(row); truncated = true; }
  return { ...ref(type, row), data, truncated };
}

/** 关联对象：本对象字段直接引用的对象，以及字段引用了本对象的其它对象（均限当前可读类型）。 */
export function agentRelated(state: MistState, actor: TokenPayload, typeName: unknown, id: unknown) {
  const { type, row } = find(state, actor, typeName, id);
  const scalarRefs = (r: any) => new Set(Object.entries(r).flatMap(([k, v]) => !/(Id|Ids)$/.test(k) ? [] : typeof v === 'string' && v ? [v] : Array.isArray(v) ? v.filter(x => typeof x === 'string') : []));
  const own = scalarRefs(row);
  const results: Array<ReturnType<typeof ref> & { relation: 'references' | 'referenced_by' }> = [];
  let total = 0;
  for (const other of readable(actor)) for (const candidate of rows(state, other)) {
    if (other === type && candidate.id === row.id) continue;
    const relation = own.has(candidate.id) ? 'references' : scalarRefs(candidate).has(row.id) ? 'referenced_by' : null;
    if (!relation) continue;
    total++;
    if (results.length < RELATED_LIMIT) results.push({ ...ref(other, candidate), relation });
  }
  return { ...ref(type, row), related: results, total, truncated: total > results.length };
}
