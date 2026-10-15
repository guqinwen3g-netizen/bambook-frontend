import { describe, expect, it } from 'vitest';
import { assertDevelopmentDatabase, DEV_TEST_ACCOUNTS } from './testAccounts';

describe('development environment password guard', () => {
  const url = 'postgresql://bambook_dev:x@localhost:5432/panda_hub_dev';
  it('accepts only the dedicated local development database with explicit opt-in', () => {
    expect(() => assertDevelopmentDatabase({ BAMBOOK_DEV_ENVIRONMENT: '1', DATABASE_URL: url })).not.toThrow();
    expect(() => assertDevelopmentDatabase({ DATABASE_URL: url })).toThrow('BAMBOOK_DEV_ENVIRONMENT');
    expect(() => assertDevelopmentDatabase({ BAMBOOK_DEV_ENVIRONMENT: '1', DATABASE_URL: url.replace('localhost', 'db.example.com') })).toThrow('localhost');
    expect(() => assertDevelopmentDatabase({ BAMBOOK_DEV_ENVIRONMENT: '1', DATABASE_URL: url.replace('panda_hub_dev', 'panda_hub') })).toThrow('panda_hub_dev');
  });
  it('covers one owner and each tested role without duplicates', () => {
    const emails = DEV_TEST_ACCOUNTS.map(account => account.email);
    expect(new Set(emails).size).toBe(emails.length);
    expect(emails).toContain('owner@bambook.local');
  });
});
