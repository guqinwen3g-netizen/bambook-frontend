
import { Order, Email, ChatMessage, Relation, ProductAsset, ProductSubCategory, Invoice, PaymentVoucher, Shipment, DevelopmentCase } from '../types';
import { apiService } from './apiService';
import { deviceDataCache } from './deviceDataCache';



const STORAGE_KEYS = {
  EMAILS: 'nexus_emails',
  CHATS: 'nexus_chats',
  MARKET_PRICES: 'nexus_market_prices',
  // UI State Persistence
  HAS_VISITED: 'nexus_has_visited',
  CURRENT_VIEW: 'nexus_current_view',
  SIDEBAR_COLLAPSED: 'nexus_sidebar_collapsed',
};

export type LocalStorageCategoryId = 'business-cache' | 'email-cache' | 'personalization' | 'account' | 'config' | 'other';

export interface LocalStorageCategoryReport {
  id: LocalStorageCategoryId;
  label: string;
  description: string;
  bytes: number;
  keys: string[];
}

export interface DeviceStorageReport {
  localStorageBytes: number;
  indexedDbUsageBytes: number | null;
  quotaBytes: number | null;
  categories: LocalStorageCategoryReport[];
}

const STORAGE_CATEGORY_META: Record<LocalStorageCategoryId, { label: string; description: string }> = {
  'business-cache': { label: '业务缓存', description: '数据中心读取快照、行情。清理后会重新从云端读取。' },
  'email-cache': { label: '邮箱缓存', description: '邮箱列表与正文缓存。清理后邮箱会重新同步。' },
  personalization: { label: '个性化数据', description: '主题、当前页面、侧边栏、数字孪生布局等本机偏好。' },
  account: { label: '账号会话', description: '本机登录 token 与当前用户缓存。清理会退出登录。' },
  config: { label: '连接配置', description: '数据中心、知识库、API key 等当前设备配置。' },
  other: { label: '其他本地数据', description: '尚未归类的本地键值。' },
};

const textBytes = (value: string) => new Blob([value]).size;
const localStorageKeyBytes = (key: string, value: string | null) => textBytes(key) + textBytes(value || '');

function classifyLocalStorageKey(key: string): LocalStorageCategoryId {
  if (key === 'bambook_auth_token' || key === 'bambook_auth_user') return 'account';
  if (key === 'panda_system_config' || key === 'cloudEndpoint' || key === 'aliyun_mail_config') return 'config';
  if (
    key === STORAGE_KEYS.HAS_VISITED ||
    key === STORAGE_KEYS.CURRENT_VIEW ||
    key === STORAGE_KEYS.SIDEBAR_COLLAPSED ||
    key === 'theme_preference' ||
    key === 'bambook:data-twin-layout:v2' ||
    key === 'bambook:assistant-workspace-state:v1' ||
    key.startsWith('bambook_design_tuner_') ||
    key.startsWith('bambook_ui_lab_session:')
  ) return 'personalization';
  if (key === STORAGE_KEYS.EMAILS || key.startsWith('nexus_emails')) return 'email-cache';
  if (
    key === STORAGE_KEYS.MARKET_PRICES ||
    key.startsWith('bambook:last-business-profile:')
  ) return 'business-cache';
  return 'other';
}

const listLocalStorageKeys = () => {
  if (typeof localStorage === 'undefined') return [];
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => Boolean(key));
};

const removeLocalStorageKeys = (predicate: (key: string) => boolean) => {
  if (typeof localStorage === 'undefined') return 0;
  const keys = listLocalStorageKeys().filter(predicate);
  keys.forEach(key => localStorage.removeItem(key));
  return keys.length;
};

const estimateIndexedDbUsage = async () => {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { usage: null, quota: null };
  }
  try {
    const estimate = await navigator.storage.estimate();
    return {
      usage: typeof estimate.usage === 'number' ? estimate.usage : null,
      quota: typeof estimate.quota === 'number' ? estimate.quota : null,
    };
  } catch {
    return { usage: null, quota: null };
  }
};

const deleteIndexedDb = (name: string) => {
  if (typeof indexedDB === 'undefined') return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
    request.onblocked = () => resolve(false);
  });
};

// Simple IndexedDB Wrapper for large email storage (Details/Bodies)
// This bypasses the 5MB localStorage limit.
export const EmailDB = {
  dbName: 'PandaEmailDB',
  storeName: 'bodies',
  db: null as IDBDatabase | null,

  // Initialize DB connection
  async init() {
    if (this.db) return;
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onerror = () => {
        console.error("IndexedDB Open Error:", request.error);
        reject(request.error);
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      request.onupgradeneeded = (e: any) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName); // KeyPath is out-of-line (we use put(data, key))
        }
      };
    });
  },

  // Save a single email body/details
  async saveBody(uid: string, data: any) {
    // Old UID-only keys have no actor/account/folder/UIDVALIDITY authority.
    if (!uid.startsWith('mailbody-v3:')) return;
    try {
      await this.init();
      return new Promise<void>((resolve, reject) => {
        const tx = this.db!.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.put(data, uid);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.error("IDB Save Error", err);
    }
  },

  // Get a single email body/details
  async getBody(uid: string) {
    if (!uid.startsWith('mailbody-v3:')) return null;
    try {
      await this.init();
      return new Promise<any>((resolve, reject) => {
        const tx = this.db!.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(uid);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.error("IDB Get Error", err);
      return null;
    }
  }
};

export const storageService = {

  loadOrdersFromDataHub: async (endpoint?: string): Promise<Order[]> => {
    const rows = await apiService.listOrders(endpoint);
    const active = rows.filter((order: any) => !order.deletedAt);
    void deviceDataCache.replaceAll('orders', active);
    return active;
  },

  loadRelationsFromDataHub: async (endpoint?: string): Promise<Relation[]> => {
    const rows = await apiService.listRelations(endpoint);
    const active = rows.filter((relation: any) => !relation.deletedAt);
    void deviceDataCache.replaceAll('relations', active);
    return active;
  },

  saveRelationToDataHub: async (relation: Relation, endpoint?: string): Promise<Relation> => {
    return apiService.saveRelation(relation, endpoint);
  },

  deleteRelationFromDataHub: async (id: string, endpoint?: string): Promise<Relation> => {
    return apiService.deleteRelation(id, endpoint);
  },

  loadProductsFromDataHub: async (endpoint?: string): Promise<ProductAsset[]> => {
    const rows = await apiService.listProducts(endpoint);
    const active = rows.filter((product: any) => !product.deletedAt);
    void deviceDataCache.replaceAll('products', active);
    return active;
  },

  getChats: (): ChatMessage[] => {
    const data = localStorage.getItem(STORAGE_KEYS.CHATS);
    return data ? JSON.parse(data) : [];
  },

  saveChats: (messages: ChatMessage[]) => {
    localStorage.setItem(STORAGE_KEYS.CHATS, JSON.stringify(messages.slice(-50)));
  },

  getEmails: (): Email[] => {
    // Default to Inbox for global state (Dashboard etc)
    const data = localStorage.getItem('nexus_emails_INBOX') || localStorage.getItem(STORAGE_KEYS.EMAILS);
    if (!data) return [];
    try {
      return JSON.parse(data);
    } catch (e) {
      return [];
    }
  },

  saveEmails: (items: Email[]) => {
    // For now we keep the generic key for compatibility, but EmailManager
    // handles box-specific saving itself.
    localStorage.setItem(STORAGE_KEYS.EMAILS, JSON.stringify(items));
  },

  getDailyMarketSnapshot: (dateStr: string) => {
    const data = localStorage.getItem(STORAGE_KEYS.MARKET_PRICES);
    if (!data) return null;
    try {
      const history = JSON.parse(data);
      return history[dateStr] || null;
    } catch (e) { return null; }
  },

  saveDailyMarketSnapshot: (dateStr: string, snapshot: any) => {
    const data = localStorage.getItem(STORAGE_KEYS.MARKET_PRICES);
    let history: any = {};
    try { if (data) history = JSON.parse(data); } catch (e) { }

    history[dateStr] = snapshot;
    localStorage.setItem(STORAGE_KEYS.MARKET_PRICES, JSON.stringify(history));
  },

  // --- UI State Persistence ---
  getUIState: () => ({
    hasVisited: localStorage.getItem(STORAGE_KEYS.HAS_VISITED) === 'true',
    currentView: localStorage.getItem(STORAGE_KEYS.CURRENT_VIEW) || null,
    sidebarCollapsed: localStorage.getItem(STORAGE_KEYS.SIDEBAR_COLLAPSED) === 'true',
  }),

  saveUIState: (state: Partial<{
    hasVisited: boolean;
    currentView: string;
    sidebarCollapsed: boolean;
  }>) => {
    if (state.hasVisited !== undefined) localStorage.setItem(STORAGE_KEYS.HAS_VISITED, String(state.hasVisited));
    if (state.currentView !== undefined) localStorage.setItem(STORAGE_KEYS.CURRENT_VIEW, state.currentView);
    if (state.sidebarCollapsed !== undefined) localStorage.setItem(STORAGE_KEYS.SIDEBAR_COLLAPSED, String(state.sidebarCollapsed));
  },

  getDeviceStorageReport: async (): Promise<DeviceStorageReport> => {
    const categories = new Map<LocalStorageCategoryId, LocalStorageCategoryReport>(
      (Object.keys(STORAGE_CATEGORY_META) as LocalStorageCategoryId[]).map(id => [
        id,
        { id, ...STORAGE_CATEGORY_META[id], bytes: 0, keys: [] },
      ]),
    );
    let localStorageBytes = 0;

    for (const key of listLocalStorageKeys()) {
      const value = localStorage.getItem(key);
      const bytes = localStorageKeyBytes(key, value);
      localStorageBytes += bytes;
      const category = categories.get(classifyLocalStorageKey(key))!;
      category.bytes += bytes;
      category.keys.push(key);
    }

    const estimate = await estimateIndexedDbUsage();
    return {
      localStorageBytes,
      indexedDbUsageBytes: estimate.usage,
      quotaBytes: estimate.quota,
      categories: Array.from(categories.values()),
    };
  },

  clearBusinessCache: async (): Promise<number> => {
    const removedKeys = removeLocalStorageKeys(key => classifyLocalStorageKey(key) === 'business-cache');
    await deviceDataCache.clearBusinessData();
    return removedKeys;
  },

  clearEmailCache: async (): Promise<number> => {
    const removedKeys = removeLocalStorageKeys(key => classifyLocalStorageKey(key) === 'email-cache');
    await deleteIndexedDb(EmailDB.dbName);
    EmailDB.db = null;
    return removedKeys;
  },

  clearDevicePreferences: async (): Promise<number> => {
    return removeLocalStorageKeys(key => classifyLocalStorageKey(key) === 'personalization');
  },

  getCachedProducts: async (): Promise<ProductAsset[]> => {
    return deviceDataCache.list('products');
  },

  saveCachedProducts: async (products: ProductAsset[]): Promise<void> => {
    await deviceDataCache.replaceAll('products', products.filter(product => !product.deletedAt));
  },

  getCachedProductCategories: async (): Promise<ProductSubCategory[]> => {
    return deviceDataCache.list('productCategories');
  },

  saveCachedProductCategories: async (categories: ProductSubCategory[]): Promise<void> => {
    await deviceDataCache.replaceAll('productCategories', categories.filter(category => !category.deletedAt));
  },

  // PDML 庞大原始库缓存已随前端入口退役删除（2026-08-30）：IndexedDB 里同名旧原料缓存 store
  // 不再被读写，存量设备上的旧数据自然失效，无需迁移清理。

  getCachedOrders: async (): Promise<Order[]> => {
    return deviceDataCache.list('orders');
  },

  saveCachedOrders: async (orders: Order[]): Promise<void> => {
    await deviceDataCache.replaceAll('orders', orders.filter(order => !order.deletedAt));
  },

  getCachedRelations: async (): Promise<Relation[]> => {
    return deviceDataCache.list('relations');
  },

  saveCachedRelations: async (relations: Relation[]): Promise<void> => {
    await deviceDataCache.replaceAll('relations', relations.filter(relation => !relation.deletedAt));
  },

  // --- Invoice Cache ---
  loadInvoicesFromDataHub: async (endpoint?: string): Promise<Invoice[]> => {
    const rows = await apiService.listInvoices(endpoint);
    const active = rows.filter((inv: any) => !inv.deletedAt);
    void deviceDataCache.replaceAll('invoices', active);
    return active;
  },
  getCachedInvoices: async (): Promise<Invoice[]> => {
    return deviceDataCache.list('invoices');
  },
  saveCachedInvoices: async (invoices: Invoice[]): Promise<void> => {
    await deviceDataCache.replaceAll('invoices', invoices.filter(inv => !inv.deletedAt));
  },

  // --- PaymentVoucher Cache ---
  loadPaymentVouchersFromDataHub: async (endpoint?: string): Promise<PaymentVoucher[]> => {
    const rows = await apiService.listPaymentVouchers(endpoint);
    const active = rows.filter((v: any) => !v.deletedAt);
    void deviceDataCache.replaceAll('paymentVouchers', active);
    return active;
  },
  getCachedPaymentVouchers: async (): Promise<PaymentVoucher[]> => {
    return deviceDataCache.list('paymentVouchers');
  },
  saveCachedPaymentVouchers: async (vouchers: PaymentVoucher[]): Promise<void> => {
    await deviceDataCache.replaceAll('paymentVouchers', vouchers.filter(v => !v.deletedAt));
  },

  // --- Shipment Cache ---
  loadShipmentsFromDataHub: async (endpoint?: string): Promise<Shipment[]> => {
    const rows = await apiService.listShipments(endpoint);
    const active = rows.filter((s: any) => !s.deletedAt);
    void deviceDataCache.replaceAll('shipments', active);
    return active;
  },
  getCachedShipments: async (): Promise<Shipment[]> => {
    return deviceDataCache.list('shipments');
  },
  saveCachedShipments: async (shipments: Shipment[]): Promise<void> => {
    await deviceDataCache.replaceAll('shipments', shipments.filter(s => !s.deletedAt));
  },

  // --- DevelopmentCase Cache ---
  loadDevelopmentCasesFromDataHub: async (endpoint?: string): Promise<DevelopmentCase[]> => {
    const rows = await apiService.listDevelopmentCases(endpoint);
    const active = rows.filter((c: any) => !c.deletedAt);
    void deviceDataCache.replaceAll('developmentCases', active);
    return active;
  },
  getCachedDevelopmentCases: async (): Promise<DevelopmentCase[]> => {
    return deviceDataCache.list('developmentCases');
  },
  saveCachedDevelopmentCases: async (cases: DevelopmentCase[]): Promise<void> => {
    await deviceDataCache.replaceAll('developmentCases', cases.filter(c => !c.deletedAt));
  },
};
