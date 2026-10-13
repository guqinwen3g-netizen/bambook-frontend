import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./deviceDataCache.ts', import.meta.url), 'utf8');
const storageSource = readFileSync(new URL('./storageService.ts', import.meta.url), 'utf8');

describe('deviceDataCache architecture', () => {
  it('uses per-entity IndexedDB stores instead of one large KV blob', () => {
    for (const store of ['orders', 'relations', 'products', 'productCategories', 'meta']) {
      expect(source).toContain(store);
    }
    expect(source).toContain("db.createObjectStore(storeName, { keyPath: 'id' })");
    expect(source).toContain("db.createObjectStore(META_STORE, { keyPath: 'entity' })");
    expect(source).toContain('replaceAll');
    expect(source).toContain('upsertMany');
    expect(source).toContain('markDeleted');
  });

  it('routes business cache helpers through deviceDataCache, not localStorage snapshots', () => {
    expect(storageSource).toContain("deviceDataCache.list('products')");
    expect(storageSource).toContain("deviceDataCache.replaceAll('products'");
    expect(storageSource).not.toContain('products:all');
    expect(storageSource).not.toContain('pdml:raw:fabrics');
    expect(storageSource).not.toContain('BambookDeviceCacheDB');
  });
});

