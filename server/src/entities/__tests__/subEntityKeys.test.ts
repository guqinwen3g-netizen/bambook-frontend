import { describe, expect, it } from 'vitest';
import { ensureStableAddressIds, ensureStableContactIds, relationTargetPath } from '../subEntityKeys';

describe('sub entity stable keys', () => {
  it('generates stable address ids without relying on JSON array position alone', () => {
    const first = ensureStableAddressIds([{ address: '8888 PIE IX Boulevard', city: 'Montreal' }]);
    const second = ensureStableAddressIds([{ address: '8888 PIE IX Boulevard', city: 'Montreal' }]);

    expect(first[0].id).toMatch(/^addr_/);
    expect(first[0].id).toBe(second[0].id);
    expect(relationTargetPath('shipToAddresses', first[0].id!)).toBe(`shipToAddresses.${first[0].id}`);
  });

  it('preserves existing contact ids while filling missing ids', () => {
    const contacts = ensureStableContactIds([
      { id: 'contact_existing', name: 'Jane' },
      { name: 'John', email: 'john@example.com' },
    ]);

    expect(contacts[0].id).toBe('contact_existing');
    expect(contacts[1].id).toMatch(/^contact_/);
  });
});
