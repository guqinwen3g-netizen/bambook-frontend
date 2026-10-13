import { afterAll, expect, it } from 'vitest';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createPrivateAllocationClients } from '../../../acceptance-tests/allocationPrivatePgHarness';
const nativeRoot = path.join('/private/tmp', 'bambook-allocation-conflict-native-' + randomBytes(6).toString('hex'));
const directory = path.join(nativeRoot, 'postgres'); mkdirSync(directory, { recursive: true });
const escape = path.join(nativeRoot, 'escape'); mkdirSync(escape); symlinkSync(escape, path.join(nativeRoot, 'alias'));
afterAll(() => rmSync(nativeRoot, { recursive: true }));
const valid: NodeJS.ProcessEnv = { NODE_ENV: 'test', BAMBOOK_NO_SCHEDULER: '1', BAMBOOK_ACCEPTANCE_NO_DATABASE: '0',
  DATABASE_URL: 'postgresql://acceptance@127.0.0.1:65432/bambook_acceptance_aabb?schema=public',
  BAMBOOK_ACCEPTANCE_SANDBOX: process.env.BAMBOOK_ACCEPTANCE_SANDBOX,
  BAMBOOK_ACCEPTANCE_DB_NAME: 'bambook_acceptance_aabb', BAMBOOK_ACCEPTANCE_DB_PORT: '65432', BAMBOOK_ACCEPTANCE_DB_DIR: directory,
  NODE_OPTIONS: process.env.NODE_OPTIONS };
it.each([
  ['missing URL', { DATABASE_URL: undefined }], ['foreign host', { DATABASE_URL: valid.DATABASE_URL!.replace('127.0.0.1', 'company.example') }],
  ['default URL', { DATABASE_URL: 'postgresql://acceptance@127.0.0.1:5432/company?schema=public' }], ['wrong port', { BAMBOOK_ACCEPTANCE_DB_PORT: '5432' }],
  ['foreign name', { BAMBOOK_ACCEPTANCE_DB_NAME: 'company' }], ['missing sandbox', { BAMBOOK_ACCEPTANCE_SANDBOX: undefined }],
  ['missing directory', { BAMBOOK_ACCEPTANCE_DB_DIR: undefined }], ['escaped directory', { BAMBOOK_ACCEPTANCE_DB_DIR: path.join(nativeRoot, 'alias') }],
  ['missing guard', { NODE_OPTIONS: undefined }], ['database disabled', { BAMBOOK_ACCEPTANCE_NO_DATABASE: '1' }],
  ['scheduler enabled', { BAMBOOK_NO_SCHEDULER: '0' }], ['non-test environment', { NODE_ENV: 'production' }],
] as const)('private PG harness rejects %s before any client construction or possible connection', (_name, change) => {
  let constructions = 0, connections = 0;
  class Client { constructor(_options: any) { constructions++; } $connect() { connections++; } }
  expect(() => createPrivateAllocationClients(Client, { ...valid, ...change })).toThrow('Reviewed private allocation PG inputs are required');
  expect(constructions).toBe(0); expect(connections).toBe(0);
});
it('private PG harness passes the exact validated explicit URL to both client constructors without connecting', () => {
  const options: unknown[] = []; let connections = 0;
  class Client { constructor(option: any) { options.push(option); } $connect() { connections++; } }
  const clients = createPrivateAllocationClients(Client, valid);
  expect(clients).toHaveLength(2); expect(options).toEqual(Array.from({ length: 2 }, () => ({ datasources: { db: { url: valid.DATABASE_URL } } }))); expect(connections).toBe(0);
});
