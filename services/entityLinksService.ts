/**
 * EntityLink graph service.
 *
 * Wraps the cross-module relationship graph endpoints exposed by
 * /api/v1/entities/links and /api/v1/entities/neighbors.
 *
 * Use this from any detail panel that needs "show me everything attached
 * to this entity" — orders attached to a customer, dev cases for a product,
 * contacts for an organization, etc.
 */
import { apiService } from './apiService';

export type LinkDirection = 'out' | 'in';

export interface EntityLinkRow {
  id: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  linkKind: string;
  source?: string | null;
  status?: string;
  updatedAt?: number;
  createdAt?: number;
}

export interface NeighborRow {
  direction: LinkDirection;
  type: string;
  id: string;
  linkKind: string;
  updatedAt?: number;
  label?: string;
}

export interface NeighborsResponse {
  ok: boolean;
  type: string;
  id: string;
  total: number;
  /** keyed by linkKind (e.g. orderedBy, suppliedBy, developFor, aboutProduct) */
  neighbors: Record<string, NeighborRow[]>;
}

export interface LinksResponse {
  ok: boolean;
  total: number;
  links: EntityLinkRow[];
  /** key is `<type>::<id>` of either side */
  snapshots?: Record<string, Record<string, unknown> | null>;
}

/** related-summary 聚合计数（跨模块导航入口卡片用） */
export interface RelatedSummary {
  orders: number;
  developments: number;
  quotations: number;
  purchaseOrders: number;
  invoices: number;
  paymentVouchers: number;
  vatInvoices: number;
  shipments: number;
  customsDeclarations: number;
  taxRefunds: number;
  lettersOfCredit: number;
  fxSettlements: number;
  outwardRemittances: number;
  opportunities: number;
  outsourcingOrders: number;
  /** 产品维度：库存（InventoryItem.productAssetId 精确） */
  inventory: number;
  /** 产品维度：BOM / 成本核算（BOM.productAssetId 精确） */
  boms: number;
}

const headers = (): Record<string, string> => apiService.getAuthHeaders();

export const entityLinksService = {
  /**
   * Fetch all links touching (type,id) — both incoming and outgoing.
   * Pass `expand: true` to also receive snapshot rows so the UI can show
   * human labels without an extra hydrate call.
   */
  async listLinks(params: {
    type: string;
    id: string;
    linkKind?: string;
    limit?: number;
    expand?: boolean;
    endpoint?: string;
  }): Promise<LinksResponse> {
    const base = params.endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/entities/links', base);
    const query = new URLSearchParams({ type: params.type, id: params.id });
    if (params.linkKind) query.set('linkKind', params.linkKind);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.expand) query.set('expand', '1');

    const res = await fetch(`${url}?${query.toString()}`, { headers: headers() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    return data as LinksResponse;
  },

  /**
   * Fetch neighbors grouped by linkKind, with human labels resolved from
   * EntityReference snapshots. Best for sidebar "Related" cards.
   */
  async getNeighbors(params: {
    type: string;
    id: string;
    limit?: number;
    endpoint?: string;
  }): Promise<NeighborsResponse> {
    const base = params.endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/entities/neighbors', base);
    const query = new URLSearchParams({ type: params.type, id: params.id });
    if (params.limit) query.set('limit', String(params.limit));

    const res = await fetch(`${url}?${query.toString()}`, { headers: headers() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    return data as NeighborsResponse;
  },

  /**
   * 跨模块导航计数：该组织在各业务域的关联记录数（按业务表真实字段 count）。
   * 详情页「关联业务」入口卡片的数据源。
   */
  async getRelatedSummary(params: {
    type: string;
    id: string;
    endpoint?: string;
  }): Promise<RelatedSummary> {
    const base = params.endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/entities/related-summary', base);
    const query = new URLSearchParams({ type: params.type, id: params.id });

    const res = await fetch(`${url}?${query.toString()}`, { headers: headers() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    return (data?.summary ?? {}) as RelatedSummary;
  },
};

/**
 * Friendly Chinese label for common linkKinds. Unknown kinds fall back to the
 * raw key so the UI is still usable when new linkKinds are added server-side.
 */
export const LINK_KIND_LABELS: Record<string, string> = {
  orderedBy: '下单客户',
  suppliedBy: '供应工厂',
  shipsTo: '收货方',
  billTo: '结算方',
  handledBy: '负责销售',
  merchandisedBy: '跟单',
  supervisedBy: '主管',
  developFor: '开发客户',
  developBy: '开发供应商',
  aboutProduct: '关联产品',
  sentBy: '往来邮件',
  aboutOrder: '关联订单',
  aboutInvoice: '发票邮件',
  // ── 阶段 D / D1.1a：主链路实体图谱补缺 ──
  quotedFor: '报价客户',
  convertedToOrder: '转化订单',
  forOrder: '所属订单',
  fromQuotation: '来源报价',
  purchasedFrom: '采购供应商',
  fromBom: '来源 BOM',
  clearsShipment: '清关出运',
  declaredFor: '报关客户',
  refundsDeclaration: '退税报关单',
  refundTo: '退税客户',
  opportunityFor: '商机客户',
  // 阶段 D / D2：产品↔Relation FK 图谱
  producedFor: '所属客户',
  manufacturedBy: '生产工厂',
  // 阶段 D / D5：外协图谱
  outsourcedTo: '外协加工厂',
};

export function labelForLinkKind(kind: string): string {
  return LINK_KIND_LABELS[kind] ?? kind;
}
