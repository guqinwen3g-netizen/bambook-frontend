import { Order, ProductAsset, ProductSubCategory, Relation, Invoice, PaymentVoucher, Shipment, DevelopmentCase } from '../types';

export type DeviceCacheEntity =
  | 'orders'
  | 'relations'
  | 'products'
  | 'productCategories'
  | 'invoices'
  | 'paymentVouchers'
  | 'shipments'
  | 'developmentCases';

export interface DeviceCacheMeta {
  entity: DeviceCacheEntity;
  lastSyncedAt: number;
  total: number;
  sourceEndpoint?: string;
  cacheVersion: number;
}

type EntityRecordMap = {
  orders: Order;
  relations: Relation;
  products: ProductAsset;
  productCategories: ProductSubCategory;
  invoices: Invoice;
  paymentVouchers: PaymentVoucher;
  shipments: Shipment;
  developmentCases: DevelopmentCase;
};

type CacheableRecord = EntityRecordMap[DeviceCacheEntity] & { id: string; deletedAt?: number | null };

const DB_NAME = 'BambookDeviceDataCache';
const DB_VERSION = 3;
const META_STORE = 'meta';
const ENTITY_STORES: DeviceCacheEntity[] = [
  'orders',
  'relations',
  'products',
  'productCategories',
  'invoices',
  'paymentVouchers',
  'shipments',
  'developmentCases',
];

const hasIndexedDb = () => typeof indexedDB !== 'undefined';

const sanitizeRows = <T extends CacheableRecord>(rows: T[]) => rows.filter(row => Boolean(row?.id));

class DeviceDataCache {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase | null> | null = null;

  private async open(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    if (!hasIndexedDb()) return null;
    if (this.opening) return this.opening;

    this.opening = new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => {
        console.warn('[DeviceDataCache] open failed:', request.error);
        this.opening = null;
        resolve(null);
      };
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onversionchange = () => {
          this.db?.close();
          this.db = null;
        };
        resolve(this.db);
      };
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const storeName of ENTITY_STORES) {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: 'id' });
          }
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'entity' });
        }
      };
    });

    return this.opening;
  }

  private async transact<T>(stores: string | string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => T): Promise<T | null> {
    const db = await this.open();
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      const tx = db.transaction(stores, mode);
      let result: T | null = null;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => {
        console.warn('[DeviceDataCache] transaction failed:', tx.error);
        resolve(null);
      };
      tx.onabort = () => {
        console.warn('[DeviceDataCache] transaction aborted:', tx.error);
        resolve(null);
      };
      result = work(tx);
    });
  }

  async list<K extends DeviceCacheEntity>(entity: K, options: { includeDeleted?: boolean } = {}): Promise<EntityRecordMap[K][]> {
    const db = await this.open();
    if (!db) return [];
    return new Promise<EntityRecordMap[K][]>((resolve) => {
      const tx = db.transaction(entity, 'readonly');
      const request = tx.objectStore(entity).getAll();
      request.onsuccess = () => {
        const rows = Array.isArray(request.result) ? request.result : [];
        resolve(options.includeDeleted ? rows : rows.filter(row => !row?.deletedAt));
      };
      request.onerror = () => {
        console.warn(`[DeviceDataCache] list ${entity} failed:`, request.error);
        resolve([]);
      };
    });
  }

  async replaceAll<K extends DeviceCacheEntity>(
    entity: K,
    rows: EntityRecordMap[K][],
    meta: Partial<Omit<DeviceCacheMeta, 'entity' | 'total' | 'lastSyncedAt' | 'cacheVersion'>> = {},
  ): Promise<void> {
    const cleanRows = sanitizeRows(rows as CacheableRecord[]);
    await this.transact([entity, META_STORE], 'readwrite', (tx) => {
      const store = tx.objectStore(entity);
      store.clear();
      for (const row of cleanRows) store.put(row);
      tx.objectStore(META_STORE).put({
        entity,
        total: cleanRows.filter(row => !row.deletedAt).length,
        lastSyncedAt: Date.now(),
        cacheVersion: DB_VERSION,
        ...meta,
      });
    });
  }

  async upsertMany<K extends DeviceCacheEntity>(
    entity: K,
    rows: EntityRecordMap[K][],
    meta: Partial<Omit<DeviceCacheMeta, 'entity' | 'total' | 'lastSyncedAt' | 'cacheVersion'>> = {},
  ): Promise<void> {
    const cleanRows = sanitizeRows(rows as CacheableRecord[]);
    await this.transact([entity, META_STORE], 'readwrite', (tx) => {
      const store = tx.objectStore(entity);
      for (const row of cleanRows) store.put(row);
      tx.objectStore(META_STORE).put({
        entity,
        total: cleanRows.filter(row => !row.deletedAt).length,
        lastSyncedAt: Date.now(),
        cacheVersion: DB_VERSION,
        ...meta,
      });
    });
  }

  async upsertOne<K extends DeviceCacheEntity>(entity: K, row: EntityRecordMap[K]): Promise<void> {
    if (!row?.id) return;
    await this.transact(entity, 'readwrite', (tx) => {
      tx.objectStore(entity).put(row);
    });
  }

  async markDeleted<K extends DeviceCacheEntity>(entity: K, row: EntityRecordMap[K]): Promise<void> {
    if (!row?.id) return;
    await this.upsertOne(entity, { ...(row as any), deletedAt: (row as any).deletedAt || Date.now() });
  }

  async deleteOne(entity: DeviceCacheEntity, id: string): Promise<void> {
    if (!id) return;
    await this.transact(entity, 'readwrite', (tx) => {
      tx.objectStore(entity).delete(id);
    });
  }

  async getMeta(entity: DeviceCacheEntity): Promise<DeviceCacheMeta | null> {
    const db = await this.open();
    if (!db) return null;
    return new Promise<DeviceCacheMeta | null>((resolve) => {
      const tx = db.transaction(META_STORE, 'readonly');
      const request = tx.objectStore(META_STORE).get(entity);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }

  async clearEntity(entity: DeviceCacheEntity): Promise<void> {
    await this.transact([entity, META_STORE], 'readwrite', (tx) => {
      tx.objectStore(entity).clear();
      tx.objectStore(META_STORE).delete(entity);
    });
  }

  async clearBusinessData(): Promise<void> {
    await this.transact([...ENTITY_STORES, META_STORE], 'readwrite', (tx) => {
      for (const entity of ENTITY_STORES) tx.objectStore(entity).clear();
      tx.objectStore(META_STORE).clear();
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.opening = null;
  }
}

export const deviceDataCache = new DeviceDataCache();

