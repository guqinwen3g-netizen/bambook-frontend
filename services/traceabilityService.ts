/**
 * traceabilityService.ts — 一键溯源 V2 API 服务
 *
 * 封装 /api/v2/trace 下的溯源查询端点：
 *   GET /api/v2/trace/:scenario/:rootId
 *
 * 6 大溯源场景：
 *   1. customerPanorama    — 客户全景
 *   2. orderFulfillment    — 订单履约链
 *   3. quoteToShip         — 报价到发货链
 *   4. supplierPanorama    — 供应商全景
 *   5. productCostChain    — 产品成本链
 *   6. taxRefundChain      — 退税链
 */
import { apiService } from './apiService';

const BASE_PATH = '/v2/trace';

function buildUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`${BASE_PATH}${path}`, base);
}

function authHeaders(): Record<string, string> {
  return apiService.getAuthHeaders();
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data?.message) return data.message;
    if (data?.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    return `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ────────────────────────────────────────────────────────────────────
// 类型定义（镜像后端 traceabilityService.ts）
// ────────────────────────────────────────────────────────────────────

export type TraceScenario =
  | 'customerPanorama'
  | 'orderFulfillment'
  | 'quoteToShip'
  | 'supplierPanorama'
  | 'productCostChain'
  | 'taxRefundChain'
  | 'purchaseToStock';

export interface TraceNode {
  id: string;
  type: string;
  label: string;
  data: Record<string, any>;
}

export interface TraceEdge {
  from: string;
  to: string;
  relation: string;
}

export interface TraceResult {
  scenario: TraceScenario;
  rootId: string;
  rootType: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  summary: Record<string, any>;
}

// ────────────────────────────────────────────────────────────────────
// 场景元数据（UI 展示用）
// ────────────────────────────────────────────────────────────────────

export interface ScenarioMeta {
  id: TraceScenario;
  label: string;
  labelEn: string;
  rootType: string;
  rootLabel: string;
  description: string;
}

export const TRACE_SCENARIOS: ScenarioMeta[] = [
  {
    id: 'customerPanorama',
    label: '客户全景',
    labelEn: 'Customer Panorama',
    rootType: 'Relation',
    rootLabel: '客户 ID',
    description: '客户 → 订单 → 发票 → 收款 → 应收汇总',
  },
  {
    id: 'orderFulfillment',
    label: '订单履约链',
    labelEn: 'Order Fulfillment',
    rootType: 'Order',
    rootLabel: '订单 ID',
    description: '订单 → 生产 → 检验 → 出货 → 报关',
  },
  {
    id: 'quoteToShip',
    label: '报价到发货链',
    labelEn: 'Quote to Ship',
    rootType: 'Quotation',
    rootLabel: '报价单 ID',
    description: '报价单 → PI → 商业发票 → 装箱单 → 提单',
  },
  {
    id: 'supplierPanorama',
    label: '供应商全景',
    labelEn: 'Supplier Panorama',
    rootType: 'Relation',
    rootLabel: '供应商 ID',
    description: '供应商 → 采购单 → 发票 → 付款 → 应付汇总',
  },
  {
    id: 'productCostChain',
    label: '产品成本链',
    labelEn: 'Product Cost Chain',
    rootType: 'Product',
    rootLabel: '产品 ID',
    description: '产品 → BOM → 成本 → 报价 → 订单',
  },
  {
    id: 'taxRefundChain',
    label: '退税链',
    labelEn: 'Tax Refund Chain',
    rootType: 'TaxRefund',
    rootLabel: '退税 ID',
    description: '退税 → 报关单 → 出口发票 → 收汇凭证',
  },
  {
    id: 'purchaseToStock',
    label: '采购库存链',
    labelEn: 'Purchase to Stock',
    rootType: 'PurchaseOrder',
    rootLabel: '采购单 / 库存物料 ID',
    description: '采购单 → 收货 → 库存变动 → 库存物料（双入口正反向）',
  },
];

// ────────────────────────────────────────────────────────────────────
// API 方法
// ────────────────────────────────────────────────────────────────────

export const traceabilityService = {
  async trace(scenario: TraceScenario, rootId: string, endpoint?: string): Promise<TraceResult> {
    const res = await fetch(
      buildUrl(`/${encodeURIComponent(scenario)}/${encodeURIComponent(rootId)}`, endpoint),
      { headers: authHeaders() },
    );
    if (!res.ok) throw new Error(await parseError(res));
    const data = await res.json();
    // 后端返回 { ok, scenario, rootId, rootType, nodes, edges, summary }
    return {
      scenario: data.scenario,
      rootId: data.rootId,
      rootType: data.rootType,
      nodes: data.nodes || [],
      edges: data.edges || [],
      summary: data.summary || {},
    };
  },
};
