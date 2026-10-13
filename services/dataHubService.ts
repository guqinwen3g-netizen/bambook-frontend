import { Insight, KnowledgeItem, Order, ProductAsset, ProductSubCategory, Relation, Invoice, PaymentVoucher, Shipment, DevelopmentCase } from '../types';
import { apiService } from './apiService';
import type { AuthState, AuthUser } from './authService';

export type DataHubMode = 'offline' | 'online' | 'syncing' | 'degraded';

export type DataHubEntity = 'orders' | 'relations' | 'knowledge' | 'products' | 'product-categories' | 'insights' | 'invoices' | 'payment-vouchers' | 'shipments' | 'development';

export interface DataHubSnapshot {
  orders: Order[];
  knowledge: KnowledgeItem[];
  insights: Insight[];
  relations: Relation[];
  products: ProductAsset[];
  productCategories: ProductSubCategory[];
  invoices: Invoice[];
  paymentVouchers: PaymentVoucher[];
  shipments: Shipment[];
  developmentCases: DevelopmentCase[];
  /** 列表分页元信息：orders 快照已逐页拉全（2026-09-03 起，与发票/凭证同 pullAllPages 口径），
   *  ordersTotal=全量总数，订单页「加载更多」自然失效（快照不再截断） */
  meta?: { ordersTotal?: number };
  /** Failed and unrequested domains are never authoritative empty successes. */
  domains: Record<DataHubEntity, DataHubDomainState>;
}

const DATA_CHANGE_ENTITIES = new Set<DataHubEntity>([
  'orders',
  'relations',
  'knowledge',
  'products',
  'product-categories',
  'insights',
  'invoices',
  'payment-vouchers',
  'shipments',
  'development',
]);

export type DataHubDomainState = { status: 'loaded' | 'not_requested' | 'failed'; httpStatus?: number };

type SnapshotActor = Pick<AuthUser, 'id' | 'permissions'> & { permissionCeiling?: string[] };

// Same action scopes as the registered human lists / View matrix. The three
// legacy reads only authenticate on the server; restrict their snapshot use to
// their actual module read contract here, without restoring scopes by role.
export const DATA_HUB_READ_SCOPES: Readonly<Record<DataHubEntity, string>> = Object.freeze({
  orders: 'orders:read', relations: 'relations:read', products: 'products:read',
  'product-categories': 'products:read', development: 'products:read',
  knowledge: 'knowledge:read', insights: 'knowledge:read',
  invoices: 'invoices:read', 'payment-vouchers': 'vouchers:read', shipments: 'shipments:read',
});

export function canReadDataHubDomain(actor: SnapshotActor, domain: DataHubEntity): boolean {
  const scope = DATA_HUB_READ_SCOPES[domain];
  const permits = (scopes: readonly string[]) => scopes.includes('*') || scopes.includes(scope);
  return Array.isArray(actor.permissions) && permits(actor.permissions)
    && (actor.permissionCeiling === undefined || (Array.isArray(actor.permissionCeiling) && permits(actor.permissionCeiling)));
}

/** Private in-memory key; never persist or log credential material. */
export function dataHubContextKey(state: AuthState, endpoint: string, credentials: Readonly<Record<string, string>>): string {
  const user = state.isAuthenticated ? state.user : null;
  const sorted = (value: unknown) => Array.isArray(value) ? [...value].sort() : null;
  return JSON.stringify([endpoint, user?.id ?? null, sorted(user?.permissions), sorted(user?.roles),
    sorted(user?.departmentIds), user?.department ?? null,
    sorted(user?.roleIds), sorted(user?.permissionCeiling), credentials]);
}

/** One boundary for responses and queued persistence, including logout. */
let dataHubCacheQueue: Promise<unknown> = Promise.resolve();
export function createDataHubBoundary() {
  let key: string | null = null;
  let epoch = 0;
  let request = 0;
  const change = (next: string) => {
    if (key === next) return false;
    key = next; epoch += 1; request = 0;
    return true;
  };
  const enqueue = (work: () => Promise<unknown>) => {
    const result = dataHubCacheQueue.then(work, work);
    dataHubCacheQueue = result.catch(() => undefined);
    return result;
  };
  return {
    change,
    currentTicket() { return { key: key ?? '', epoch, request }; },
    capture(next: string) { change(next); return { key: next, epoch, request: ++request }; },
    isCurrent(ticket: { key: string; epoch: number; request: number }, observedKey: string) {
      return ticket.key === observedKey && ticket.key === key && ticket.epoch === epoch && ticket.request === request;
    },
    // Clear is never skipped: an old write already in flight must finish before
    // this clear, and the next actor's writes are queued after it.
    clearCache(work: () => Promise<unknown>) { return enqueue(work); },
    persist(ticket: { key: string; epoch: number; request: number }, currentKey: () => string, work: () => Promise<unknown>) {
      return enqueue(async () => { if (this.isCurrent(ticket, currentKey())) await work(); });
    },
  };
}

const requireArray = <T>(value: T[] | null, entity: DataHubEntity): T[] => {
  if (!Array.isArray(value)) throw new Error(`${entity} data center request failed`);
  return value;
};

const SNAPSHOT_PAGE_SIZE = 200;
const pullAllPages = async <T>(fetchPage: (limit: number, offset: number) => Promise<{ items: T[]; total: number }>): Promise<T[]> => {
  const all: T[] = [];
  let offset = 0;
  for (let page = 0; page < 500; page += 1) {
    const { items, total } = await fetchPage(SNAPSHOT_PAGE_SIZE, offset);
    if (!Array.isArray(items) || !Number.isSafeInteger(total) || total < 0) throw new Error('Invalid snapshot page');
    all.push(...items);
    if (all.length >= total) return all;
    if (items.length === 0) throw new Error('Incomplete snapshot page');
    offset += items.length;
  }
  throw new Error('Snapshot pagination limit reached');
};

export const dataHubService = {
  async pullSnapshot(endpoint: string, actor: SnapshotActor): Promise<DataHubSnapshot> {
    const domains = {} as Record<DataHubEntity, DataHubDomainState>;
    async function load<T>(domain: DataHubEntity, pull: () => Promise<T[]>): Promise<T[]> {
      if (!actor?.id || !canReadDataHubDomain(actor, domain)) {
        domains[domain] = { status: 'not_requested' }; return [];
      }
      try {
        const rows = requireArray(await pull(), domain);
        domains[domain] = { status: 'loaded' }; return rows;
      } catch (error: unknown) {
        const status = (error as { status?: unknown })?.status;
        domains[domain] = { status: 'failed', ...(typeof status === 'number' ? { httpStatus: status } : {}) };
        return [];
      }
    }
    const [orders, knowledge, insights, relations, products, productCategories, invoices, paymentVouchers, shipments, developmentCases] = await Promise.all([
      load('orders', () => pullAllPages((limit, offset) => apiService.listOrdersPage(endpoint, { limit, offset }))),
      load('knowledge', async () => requireArray(await apiService.fetchCloudData<KnowledgeItem[]>('/api/knowledge', endpoint), 'knowledge')),
      load('insights', async () => requireArray(await apiService.fetchCloudData<Insight[]>('/api/insights', endpoint), 'insights')),
      load('relations', () => pullAllPages((limit, offset) => apiService.listRelationsPage(endpoint, { limit, offset }))),
      // Formal source: a legitimate empty asset collection must stay empty;
      // listProducts' legacy fallback is not an authoritative empty read.
      load('products', () => pullAllPages(async (limit, offset) => {
        const page = await apiService.listProductAssetsPage(endpoint, { limit, offset });
        return { items: page.assets, total: page.total };
      })),
      load('product-categories', async () => requireArray(await apiService.fetchCloudData<ProductSubCategory[]>('/api/product-categories', endpoint), 'product-categories')),
      load('invoices', () => pullAllPages((limit, offset) => apiService.listInvoicesPage(endpoint, { limit, offset }))),
      load('payment-vouchers', () => pullAllPages((limit, offset) => apiService.listPaymentVouchersPage(endpoint, { limit, offset }))),
      load('shipments', () => pullAllPages((limit, offset) => apiService.listShipmentsPage(endpoint, { limit, offset }))),
      load('development', () => pullAllPages((limit, offset) => apiService.listDevelopmentCasesPage(endpoint, { limit, offset }))),
    ]);
    return { orders, knowledge, insights, relations, products, productCategories, invoices, paymentVouchers, shipments, developmentCases,
      domains, meta: { ...(domains.orders.status === 'loaded' ? { ordersTotal: orders.length } : {}) } };
  },

  async loadOrders(endpoint?: string): Promise<Order[]> {
    const rows = await apiService.listOrders(endpoint);
    return rows.filter((order: any) => !order.deletedAt);
  },

  async loadRelations(endpoint?: string): Promise<Relation[]> {
    const rows = await apiService.listRelations(endpoint);
    return rows.filter((relation: any) => !relation.deletedAt);
  },

  async pushLegacyData(path: string, endpoint: string, data: unknown): Promise<boolean> {
    return apiService.postCloudData(path, endpoint, data);
  },

  subscribe(
    endpoint: string | undefined,
    onDataChange: () => void,
    options: { debounceMs?: number } = {},
  ): () => void {
    const debounceMs = options.debounceMs ?? 800;
    let timer: number | undefined;
    const stop = apiService.subscribeToDataChanges(endpoint, (event) => {
      if (!DATA_CHANGE_ENTITIES.has(event.entity as DataHubEntity)) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(onDataChange, debounceMs);
    });
    return () => {
      if (timer) window.clearTimeout(timer);
      stop();
    };
  },
};
