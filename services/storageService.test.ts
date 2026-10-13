import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./apiService', () => ({
  apiService: {
    listOrders: vi.fn(),
    listRelations: vi.fn(),
    listProducts: vi.fn(),
  },
}));

import { apiService } from './apiService';
import { storageService } from './storageService';

const makeLocalStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    get length() {
      return store.size;
    },
  };
};

describe('storageService data hub reads', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'localStorage', {
      value: makeLocalStorage(),
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
    });
  });

  it('does not fall back to local orders when the data center is unavailable', async () => {
    vi.mocked(apiService.listOrders).mockRejectedValue(new Error('remote down'));

    await expect(storageService.loadOrdersFromDataHub('https://jiangsupanda.com/bambook')).rejects.toThrow('remote down');
  });

  it('does not fall back to local relations when the data center is unavailable', async () => {
    vi.mocked(apiService.listRelations).mockRejectedValue(new Error('remote down'));

    await expect(storageService.loadRelationsFromDataHub('https://jiangsupanda.com/bambook')).rejects.toThrow('remote down');
  });

  it('reports local storage categories and protects account keys when clearing business cache', async () => {
    localStorage.setItem('nexus_market_prices', JSON.stringify([{ symbol: 'COTTON' }]));
    localStorage.setItem('bambook_auth_token', 'secret-token');
    localStorage.setItem('theme_preference', 'dark');

    const report = await storageService.getDeviceStorageReport();
    const business = report.categories.find(category => category.id === 'business-cache');
    const account = report.categories.find(category => category.id === 'account');

    expect(business?.keys).toContain('nexus_market_prices');
    expect(account?.keys).toContain('bambook_auth_token');

    const removed = await storageService.clearBusinessCache();

    expect(removed).toBe(1);
    expect(localStorage.getItem('nexus_market_prices')).toBeNull();
    expect(localStorage.getItem('bambook_auth_token')).toBe('secret-token');
    expect(localStorage.getItem('theme_preference')).toBe('dark');
  });

  it('clears email cache keys without touching device preferences', async () => {
    localStorage.setItem('nexus_emails_INBOX', JSON.stringify([{ uid: 'm-1' }]));
    localStorage.setItem('theme_preference', 'light');

    const removed = await storageService.clearEmailCache();

    expect(removed).toBe(1);
    expect(localStorage.getItem('nexus_emails_INBOX')).toBeNull();
    expect(localStorage.getItem('theme_preference')).toBe('light');
  });
});
