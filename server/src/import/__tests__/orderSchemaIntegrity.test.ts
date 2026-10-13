/**
 * Cross-package smoke test: load the front-end ORDER_FIELDS dictionary and
 * make sure its runtime integrity guard does not throw on the current data.
 *
 * If someone adds a duplicate key, dangling cluster, or required-but-hidden
 * field, this test catches it in CI before the bug ever reaches the UI.
 */
import { describe, it, expect } from 'vitest';

describe('lib/orderSchema runtime integrity guard', () => {
  it('loads ORDER_FIELDS without tripping the IIFE assertion', async () => {
    const mod = await import('../../../../lib/orderSchema');
    expect(Array.isArray(mod.ORDER_FIELDS)).toBe(true);
    expect(mod.ORDER_FIELDS.length).toBeGreaterThan(0);
    expect(mod.ORDER_CLUSTERS.length).toBeGreaterThan(0);
  });

  it('every field in ORDER_FIELDS has a unique key', async () => {
    const { ORDER_FIELDS } = await import('../../../../lib/orderSchema');
    const seen = new Set<string>();
    for (const f of ORDER_FIELDS) {
      expect(seen.has(String(f.key)), `duplicate key ${String(f.key)}`).toBe(false);
      seen.add(String(f.key));
    }
  });

  it('requiredKeysForManual returns at least poNumber/customer/quantity', async () => {
    const { requiredKeysForManual } = await import('../../../../lib/orderSchema');
    const required = new Set(requiredKeysForManual().map(String));
    expect(required.has('poNumber')).toBe(true);
    expect(required.has('customer')).toBe(true);
    expect(required.has('quantity')).toBe(true);
  });
});
