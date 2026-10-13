/**
 * crossModuleNav — 跨模块导航协议（产品化 Links 的核心基建）
 *
 * 设计（复用 RelationsManager preview state 已验证的三段式模式）：
 *   1. prime（切换前写）：源页面在调用 onNavigate(view) 之前，把导航上下文
 *      （目标 View + 筛选条件）写入 sessionStorage；
 *   2. consume（挂载时读+清）：目标 Manager 挂载时一次性消费——读出筛选上下文
 *      预填本地筛选 state，随即清除（保证刷新/再次进入回到默认视图）；
 *   3. 优雅降级：目标页未接入协议时上下文被静默丢弃，退化为普通视图切换。
 *
 * App.tsx 冻结纪律下的零侵入方案：不经过 App 层 state/props 传递，
 * 与 handleViewChange / handleReportNavigate 现有通道并存互不干扰。
 */
import { View } from '../types';

/** 关联锚点类型：客户/供应商组织、产品档案、订单或开发案 */
export type NavAnchorKind = 'relation' | 'product' | 'order' | 'development';

/**
 * 关联筛选上下文：目标页按锚实体过滤业务记录。
 * 兼容三锚——relation（客户/供应商组织）、product（产品档案）或 order（订单）。
 * 锚点由 `anchor` 判别：relation 用 relationId/relationRole；product 用 productId/productName/productCodes；
 * order 用 orderId/orderNumber（订单详情「全链路阶段」点击下游模块时，目标页只显示该订单的记录）。
 */
export interface CrossModuleNavFilter {
  /** 锚点类型（缺省 = relation，兼容既有调用） */
  anchor?: NavAnchorKind;
  /** ── Relation 锚（客户/供应商组织）── */
  relationId?: string;
  /** 展示名（筛选提示 chip 用，如「Atlas Outfitters」） */
  relationName?: string;
  /** 关系语义（决定目标页用客户侧还是供应商侧字段过滤） */
  relationRole?: 'customer' | 'supplier';
  /** ── 产品锚（产品档案 ProductAsset）── */
  /** 产品档案 id */
  productId?: string;
  /** 产品展示名（chip 用） */
  productName?: string;
  /** 产品关联编码集合（sku ∪ articleNo ∪ clientCode），用于单据行编码匹配 */
  productCodes?: string[];
  /** ── 订单锚（Order）── */
  /** 订单 id（如 SIM-ORD-038） */
  orderId?: string;
  /** 订单展示名（chip 用，缺省回退 orderId） */
  orderNumber?: string;
  /** ── 开发案锚：筛选关联记录，不能把 Case ID 当目标 Sample ID ── */
  developmentCaseId?: string;
  developmentCaseName?: string;
  developmentCaseCode?: string;
  /** 仅供目标页选择初始工作区，记录业务归属仍由服务端判定。 */
  developmentCaseType?: string;
}

export interface CrossModuleNavContext {
  view: View;
  /** 目标模块内部 tab（如 FinanceManager 的 'vatInvoices'、CustomsManager 的 'taxRefunds'） */
  tab?: string;
  filter?: CrossModuleNavFilter;
  /**
   * 实体聚焦 id（与 filter 并存的直达锚）。
   * 当目标页需要直接打开某条具体记录的详情面板，而非仅做列表筛选时使用：
   *   - Products：focusEntityId = productAssetId，进入档案详情；
   *   - Development：focusEntityId = devCaseId，进入开发单详情；
   *   - Orders：focusEntityId = orderId，进入订单详情。
   * filter 仍可同时携带（如 product 锚用于列表过滤 + focusEntityId 精确定位）。
   */
  focusEntityId?: string;
  /**
   * 动作/预填参数（fix.target 深链通道，如 { create: '1', sku, name }、{ focus, action: 'link-product' }）。
   * 值恒为非空字符串——目标页只作纯文本消费（预填输入框/触发动作），不做 HTML/URL 注入面。
   */
  params?: Record<string, string>;
  /** 写入时间戳（调试用） */
  primedAt: number;
}

const CROSS_MODULE_NAV_KEY = 'bambook_cross_module_nav';

function parseContext(raw: string | null): CrossModuleNavContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CrossModuleNavContext;
    // View 是字符串枚举（types.ts：View.Orders = 'orders'），按非空字符串校验
    if (!parsed || typeof parsed.view !== 'string' || !parsed.view) return null;
    const ctx: CrossModuleNavContext = {
      view: parsed.view,
      tab: typeof parsed.tab === 'string' && parsed.tab ? parsed.tab : undefined,
      focusEntityId:
        typeof parsed.focusEntityId === 'string' && parsed.focusEntityId
          ? parsed.focusEntityId
          : undefined,
      primedAt: Number(parsed.primedAt) || Date.now(),
    };
    if (parsed.filter) {
      // A development anchor describes a list relationship, never a Sample
      // detail ID. Ambiguous/invalid stored anchors must not fall through to GET.
      if (parsed.filter.anchor === 'development') ctx.focusEntityId = undefined;
      const anchor: NavAnchorKind =
        parsed.filter.anchor === 'product' ? 'product'
          : parsed.filter.anchor === 'order' ? 'order'
            : parsed.filter.anchor === 'development' ? 'development'
              : 'relation';
      if (anchor === 'product' && typeof parsed.filter.productId === 'string' && parsed.filter.productId) {
        ctx.filter = {
          anchor: 'product',
          productId: parsed.filter.productId,
          productName: typeof parsed.filter.productName === 'string' ? parsed.filter.productName : undefined,
          productCodes: Array.isArray(parsed.filter.productCodes)
            ? parsed.filter.productCodes.filter((c: unknown): c is string => typeof c === 'string')
            : undefined,
        };
      } else if (anchor === 'order' && typeof parsed.filter.orderId === 'string' && parsed.filter.orderId) {
        ctx.filter = {
          anchor: 'order',
          orderId: parsed.filter.orderId,
          orderNumber: typeof parsed.filter.orderNumber === 'string' ? parsed.filter.orderNumber : undefined,
        };
      } else if (anchor === 'development' && typeof parsed.filter.developmentCaseId === 'string' && parsed.filter.developmentCaseId.trim()) {
        ctx.filter = {
          anchor: 'development',
          developmentCaseId: parsed.filter.developmentCaseId,
          developmentCaseName: typeof parsed.filter.developmentCaseName === 'string' ? parsed.filter.developmentCaseName : undefined,
          developmentCaseCode: typeof parsed.filter.developmentCaseCode === 'string' ? parsed.filter.developmentCaseCode : undefined,
          developmentCaseType: typeof parsed.filter.developmentCaseType === 'string' ? parsed.filter.developmentCaseType : undefined,
        };
      } else if (anchor !== 'development' && typeof parsed.filter.relationId === 'string' && parsed.filter.relationId) {
        ctx.filter = {
          anchor: 'relation',
          relationId: parsed.filter.relationId,
          relationName: typeof parsed.filter.relationName === 'string' ? parsed.filter.relationName : undefined,
          relationRole: parsed.filter.relationRole === 'supplier' ? 'supplier' : 'customer',
        };
      }
    }
    if (parsed.params && typeof parsed.params === 'object') {
      const entries = Object.entries(parsed.params).filter(
        ([key, value]) => typeof key === 'string' && key !== '' && typeof value === 'string' && value !== '',
      );
      if (entries.length > 0) ctx.params = Object.fromEntries(entries);
    }
    return ctx;
  } catch {
    return null;
  }
}

/**
 * 写入导航上下文（在 onNavigate(view) 之前调用）。
 * 典型用法：primeCrossModuleNav({ view: View.Orders, filter: { relationId, relationName } });
 *           onNavigate(View.Orders);
 */
export function primeCrossModuleNav(context: Omit<CrossModuleNavContext, 'primedAt'>): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(CROSS_MODULE_NAV_KEY, JSON.stringify({ ...context, primedAt: Date.now() }));
  } catch {
    // 导航预填是增强体验，存储失败静默降级为普通切换
  }
}

/**
 * 目标页挂载时消费导航上下文（读 + 一次性清除）。
 * 返回 null 表示无跨模块导航（常规进入页面）。
 * 必须在 useState 初始化函数中调用（仅挂载时执行一次）。
 */
export function consumeCrossModuleNav(): CrossModuleNavContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(CROSS_MODULE_NAV_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(CROSS_MODULE_NAV_KEY);
    return parseContext(raw);
  } catch {
    return null;
  }
}

/** 调试/测试用：窥视当前上下文但不消费 */
export function peekCrossModuleNav(): CrossModuleNavContext | null {
  if (typeof window === 'undefined') return null;
  try {
    return parseContext(sessionStorage.getItem(CROSS_MODULE_NAV_KEY));
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 通知 link 解析（通知中心点击跳转）
// ═══════════════════════════════════════════════════════════════════

/**
 * 通知 link 路径段 → View 映射。
 * 路径段全集与后端 notificationTemplateEngine.DEFAULT_TEMPLATES 的 link 模板对齐
 * （server/src/notifications/notificationTemplateEngine.ts）。
 */
const NOTIFICATION_LINK_VIEW_MAP: Record<string, View> = {
  orders: View.Orders,
  production: View.Orders,
  quotations: View.Quotations,
  procurement: View.Procurement,
  shipments: View.Shipments,
  finance: View.Invoices,
  development: View.Development,
  relations: View.Relations,
  inventory: View.Inventory,
  bom: View.BOM,
  crm: View.CRM,
  customs: View.Customs,
  suppliers: View.Suppliers,
  hr: View.HR,
};

/** 通知 link 解析结果 */
export interface ParsedNotificationLink {
  /** 目标视图 */
  view: View;
  /** 模块内部 tab（如 finance 的 invoices/vatInvoices、customs 的 taxRefunds） */
  tab?: string;
  /** 源单据/实体 id（订单/报价/发票等详情定位用） */
  id?: string;
  /** 其余 query 参数（relationId/itemId 等） */
  params: Record<string, string>;
}

/**
 * 解析通知 link（后端模板渲染产物，形如 `/orders?id=xxx&tab=production`、
 * `/finance?tab=invoices&id=xxx`、`/crm?relationId=xxx&tab=credit`）为结构化导航目标。
 * App 侧消费：orders 带 id → handleOpenOrderById 直达详情；其余 → 切 view + tab 定位。
 * 返回 null = link 空或路径段不在映射表内（调用方应忽略，不执行导航）。
 */
export function parseNotificationLink(link: string | null | undefined): ParsedNotificationLink | null {
  if (!link || typeof link !== 'string') return null;
  const cleaned = link.replace(/^#/, '');
  const [rawPath, rawQuery] = cleaned.split('?');
  const path = (rawPath ?? '').replace(/^\/+/, '').toLowerCase();
  if (!path) return null;
  let view: View | undefined = NOTIFICATION_LINK_VIEW_MAP[path];
  if (!view) return null;
  const params = new URLSearchParams(rawQuery ?? '');
  const tab = params.get('tab') ?? undefined;
  const id = params.get('id') ?? undefined;
  // finance 路径按 tab 细分：vouchers → PaymentVouchers（App 双 View 挂同一 FinanceManager）
  if (path === 'finance' && tab === 'vouchers') view = View.PaymentVouchers;
  const rest: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key !== 'tab' && key !== 'id' && value) rest[key] = value;
  });
  if (path === 'production') {
    const orderId = params.get('orderId');
    if (!orderId?.trim() || (id && id !== orderId) || (tab && tab !== 'production')) return null;
    return { view, tab: 'production', id: orderId, params: rest };
  }
  return { view, tab: tab || undefined, id: id || undefined, params: rest };
}

/**
 * 业务记录 → 是否命中关联筛选（目标页 filtered useMemo 链统一消费）。
 * relation 锚：按 customerRelationId/supplierRelationId/relationId 匹配；
 * product 锚：按 productAssetId 精确或 entries 编码（itemNo/materialCode/fabricCode/productCode）∈ productCodes 匹配。
 */
export function matchesRelationFilter(
  item: NavMatchable,
  filter: CrossModuleNavFilter | null,
): boolean {
  if (!filter) return true;
  if (filter.anchor === 'product') {
    return matchesProductAnchor(item, filter);
  }
  if (filter.anchor === 'order') {
    return matchesOrderAnchor(item, filter);
  }
  if (filter.anchor === 'development') {
    return !!filter.developmentCaseId && (item.sourceCaseId === filter.developmentCaseId || item.developmentCaseId === filter.developmentCaseId);
  }
  const id = filter.relationId;
  if (filter.relationRole === 'supplier') {
    return item.supplierRelationId === id || item.relationId === id;
  }
  return item.customerRelationId === id || item.relationId === id;
}

/**
 * 订单锚匹配（B1-③ 订单详情「全链路阶段」→ 下游模块）：
 * 记录直接挂该订单（orderId），或由该订单转化而来（convertedOrderId，报价/开发案）。
 * 目标模块无需新增服务端参数——列表已在本地持有 orderId，按此做客户端筛选即可。
 */
export function matchesOrderAnchor(item: NavMatchable, filter: CrossModuleNavFilter): boolean {
  const id = filter.orderId;
  if (!id) return true;
  return item.orderId === id || item.convertedOrderId === id;
}

/** 筛选提示条文案（relation / product / order 三锚统一出口，避免各页各写一套） */
export function navFilterDisplay(filter: CrossModuleNavFilter): { name: string; suffix: string } {
  if (filter.anchor === 'product') {
    return { name: filter.productName || filter.productId || '', suffix: '（产品档案）' };
  }
  if (filter.anchor === 'order') {
    return { name: filter.orderNumber || filter.orderId || '', suffix: '（订单）' };
  }
  if (filter.anchor === 'development') {
    return { name: filter.developmentCaseCode || filter.developmentCaseName || filter.developmentCaseId || '', suffix: '（开发案）' };
  }
  return {
    name: filter.relationName || filter.relationId || '',
    suffix: filter.relationRole === 'supplier' ? '（供应商）' : '',
  };
}

/** 单据/业务行的产品编码集合（供 product 锚匹配） */
export type NavLineCodes = {
  itemNo?: string | null;
  materialCode?: string | null;
  fabricCode?: string | null;
  productCode?: string | null;
  productAssetId?: string | null;
};

/** 可参与导航匹配的业务记录：顶层关系字段 + 可选子行（order line / quotation line 等） */
export type NavMatchable = {
  sourceCaseId?: string | null;
  developmentCaseId?: string | null;
  customerRelationId?: string | null;
  supplierRelationId?: string | null;
  relationId?: string | null;
  productAssetId?: string | null;
  /** 顶层编码字段（站 order 等多字段场景） */
  itemNo?: string | null;
  materialCode?: string | null;
  fabricCode?: string | null;
  productCode?: string | null;
  /** 订单锚：记录自身挂的订单（采购单/运单/发票/生产计划等） */
  orderId?: string | null;
  /** 订单锚：报价/开发案转出的订单（quotation.convertedOrderId、devCase.convertedOrderId） */
  convertedOrderId?: string | null;
  /** 子行编码（例如 order.lines 的 itemNo/materialCode） */
  lines?: NavLineCodes[] | null;
};

/** 单行编码是否命中产品编码集合 */
export function lineMatchesProductCodes(line: NavLineCodes, codes: string[]): boolean {
  if (!codes.length) return false;
  return [line.itemNo, line.materialCode, line.fabricCode, line.productCode]
    .some((c) => !!c && codes.includes(c));
}

/** product 锚匹配：顶层 productAssetId 精确，否则匹配顶层/子行编码 ∈ productCodes */
export function matchesProductAnchor(item: NavMatchable, filter: CrossModuleNavFilter): boolean {
  const codes = filter.productCodes as string[] | undefined;
  if (filter.productId && item.productAssetId === filter.productId) return true;
  if (!codes || !codes.length) return false;
  if (lineMatchesProductCodes(item, codes)) return true;
  if (item.lines && item.lines.some((l) => lineMatchesProductCodes(l, codes))) return true;
  return false;
}
