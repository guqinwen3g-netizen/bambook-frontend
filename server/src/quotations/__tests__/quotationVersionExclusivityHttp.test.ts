/** Actual Express/current-auth/quotation/exclusivity producers, explicit storage.
 * No PostgreSQL/browser/native lock proof and no domain/auth helper mock. */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthService } from '../../auth/service';
import { createAuthorizationSnapshotGuard } from '../../auth/authorizationSnapshotGuard';
import { createQuotationRouter } from '../quotationRoute';

const auth = createAuthService();
const patch = { lines: [{ fabricCode: 'F-1', description: 'fabric', quantity: 100, unit: 'YD', unitPrice: 9 }] };
const clone = <T>(value: T): T => structuredClone(value);
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]: any) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((part: any) => matches(row, part));
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (value == null) return row[key] == null;
    if (typeof value !== 'object' || value instanceof Date) return row[key] === value;
    if ('in' in value) return value.in.includes(row[key]);
    if ('gt' in value) return row[key] > value.gt;
    throw new Error('UNSUPPORTED_STORAGE_OPERATOR:' + key);
  });
}
function validateWhere(where: any): void {
  for (const [key, value] of Object.entries(where ?? {})) {
    if (key === 'AND' || key === 'OR') (Array.isArray(value) ? value : [value]).forEach(validateWhere);
    else if (value && typeof value === 'object' && !(value instanceof Date)) {
      if (Object.keys(value).length !== 1 || !('in' in value || 'gt' in value)) throw Error('UNSUPPORTED_STORAGE_QUERY:' + key);
    }
  }
}
function fixture(ceiling?: string[]) {
  const tables: Record<string, any[]> = {
    userAccount: [{ id: 'sales', displayName: 'Sales', status: 'active', deletedAt: null, primaryDeptId: 'company',
      roles: [{ roleId: 'synthetic-quote-writer', role: { permissions: [{ permission: { scope: 'quotations:write' } }] } }] }],
    userPermissionOverrides: [],
    quotation: [{ id: 'QT', quotationNumber: 'QT-001', status: 'Draft', currency: 'USD', totalAmount: 1000, version: 1,
      customerRelationId: 'REL-1', customerName: 'Peerless', issueDate: '2026-08-20', deletedAt: null,
      moqSnapshot: { fabricDefaultMoq: 50, garmentDefaultMoq: 50, capsuleMoq: 10, snapshotAt: '2026-08-20', configId: null } }],
    quotationLine: [{ id: 'QL', quotationId: 'QT', lineNumber: 1, fabricCode: 'F-1', description: 'fabric', quantity: 100, unit: 'YD', unitPrice: 10, amount: 1000 }],
    quotationVersion: [], productAsset: [], fabricProfile: [], fabricCustomerCode: [], auditLog: [], entityReference: [], entityLink: [],
    relation: [{ id: 'REL-1', name: 'Peerless', deletedAt: null, customerTier: null }], customerTier: [], garmentProfile: [],
  };
  const calls: Array<{ model: string; operation: string; args: any }> = [], changes: any[] = [], lockCalls: string[] = [];
  const faults = new Set<string>();
  const written = ['quotation', 'quotationLine', 'quotationVersion', 'auditLog', 'entityReference', 'entityLink'];
  function database(working?: Record<string, any[]>) {
    const db: any = {}, rows = (model: string) => working && written.includes(model) ? working[model] : tables[model];
    for (const model of Object.keys(tables)) {
      const record = (operation: string, args: any) => {
        calls.push({ model, operation, args: clone(args) });
        if (faults.has(model)) throw Error('SYNTHETIC_RELATION_QUERY_FAULT:' + model);
      };
      const find = (args: any = {}) => {
        validateWhere(args.where);
        let found = rows(model).filter(row => matches(row, args.where));
        if (args.orderBy) for (const [key, direction] of Object.entries(args.orderBy))
          found = [...found].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (direction === 'desc' ? -1 : 1));
        return found.map(row => {
          let result = clone(row);
          if (model === 'quotation' && args.include?.lines) result.lines = rows('quotationLine').filter(line => line.quotationId === row.id).map(clone);
          if (args.select) result = Object.fromEntries(Object.keys(args.select).filter(key => args.select[key]).map(key => [key, result[key]]));
          return result;
        });
      };
      db[model] = {
        findMany: async (args: any = {}) => { record('findMany', args); return find(args); },
        findFirst: async (args: any = {}) => { record('findFirst', args); return find(args)[0] ?? null; },
        findUnique: async (args: any = {}) => { record('findUnique', args); return find(args)[0] ?? null; },
        create: async ({ data }: any) => { record('create', { data }); rows(model).push(clone(data)); return clone(data); },
        createMany: async ({ data }: any) => { record('createMany', { data }); rows(model).push(...clone(data)); return { count: data.length }; },
        deleteMany: async ({ where }: any) => {
          record('deleteMany', { where }); validateWhere(where); const before = rows(model).length;
          const kept = rows(model).filter(row => !matches(row, where)); rows(model).splice(0, before, ...kept); return { count: before - kept.length };
        },
        update: async (args: any) => {
          record('update', args); const row = rows(model).find(row => matches(row, args.where)); if (!row) throw Error('ROW_MISSING');
          Object.assign(row, clone(Object.fromEntries(Object.entries(args.data).filter(([, value]) => value !== undefined))));
          return find({ where: args.where, include: args.include })[0];
        },
        upsert: async (args: any) => {
          record('upsert', args); const row = rows(model).find(row => matches(row, args.where));
          if (row) Object.assign(row, clone(args.update)); else rows(model).push(clone(args.create));
          return clone(row ?? args.create);
        },
      };
    }
    db.$queryRaw = async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join('?');
      if (sql !== 'SELECT "id" FROM "Quotation" WHERE "id" = ? FOR UPDATE' || values.length !== 1 || values[0] !== 'QT') throw Error('UNSUPPORTED_LOCK_QUERY');
      lockCalls.push('Quotation:QT'); return rows('quotation').filter(row => row.id === values[0]).map(row => ({ id: row.id }));
    };
    return db;
  }
  const db = database();
  db.$transaction = async (work: any) => {
    if (typeof work !== 'function') throw Error('UNSUPPORTED_TRANSACTION');
    const working = Object.fromEntries(written.map(model => [model, clone(tables[model])]));
    const result = await work(database(working));
    for (const model of written) tables[model] = working[model];
    return result;
  };
  const app = express(), token = auth.signToken({ userId: 'sales', roles: ['sales'], permissions: ['quotations:write'], departmentIds: ['company'], authorizationLoaded: true, ...(ceiling !== undefined ? { permissionCeiling: ceiling } : {}) });
  app.use(express.json());
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: db }));
  app.use('/api/v1/quotations', createQuotationRouter({ prisma: db, requireAuth: true, apiKeys: new Set(), onDataChange: event => changes.push(event) }));
  const put = (body: any) => request(app).put('/api/v1/quotations/QT').set('Authorization', 'Bearer ' + token).send(body);
  const businessSnapshot = () => JSON.stringify(written.filter(model => model !== 'auditLog').map(model => tables[model]), (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  return { tables, db, calls, changes, lockCalls, faults, put, businessSnapshot };
}
function material(f: ReturnType<typeof fixture>, owner?: string) {
  f.tables.productAsset.push({ id: 'PA', sku: 'F-1', name: 'fabric', deletedAt: null });
  f.tables.fabricProfile.push({ productAssetId: 'PA', articleNo: 'F-1', millQuality: 'MILL-1', deletedAt: null });
  if (owner) f.tables.fabricCustomerCode.push({ productAssetId: 'PA', clientCode: 'OWNER-CODE', customerOrganizationId: owner,
    customerNameSnapshot: owner === 'REL-1' ? 'Peerless' : 'Other Buyer', isExclusive: true, deletedAt: null });
}
function assertRepriced(f: ReturnType<typeof fixture>, response: any) {
  expect(response.status).toBe(200);
  expect(response.body.quotation).toMatchObject({ id: 'QT', version: 2, totalAmount: 900 });
  expect(response.body.quotation.moqCheck.ok).toBe(true);
  expect(f.tables.quotationVersion).toHaveLength(1);
  expect(f.tables.quotationVersion[0]).toMatchObject({ quotationId: 'QT', version: 1, totalAmount: 1000, changedBy: 'sales' });
  expect(f.tables.quotationVersion[0].linesSnapshot).toEqual([{ lineNumber: 1, fabricCode: 'F-1', description: 'fabric', quantity: 100, unit: 'YD', unitPrice: 10, amount: 1000 }]);
  expect(f.tables.quotationLine).toHaveLength(1); expect(f.tables.quotationLine[0]).toMatchObject({ quotationId: 'QT', unitPrice: 9, amount: 900 });
  expect(f.tables.quotation[0]).toMatchObject({ totalAmount: 900, version: 2 });
  expect(f.tables.auditLog.map(row => row.action)).toEqual(['update_quotation']);
  expect(f.lockCalls).toEqual(['Quotation:QT']); expect(f.changes).toEqual([{ entity: 'Quotation', action: 'update', ids: ['QT'] }]);
}

describe('quotation version with actual material exclusivity — real HTTP, explicit storage', () => {
  it('resolved non-exclusive material snapshots old1000/price10 and persists new900/price9 exactly once', async () => {
    const f = fixture(); material(f); assertRepriced(f, await f.put(patch));
  });
  it('known empty native ownership tables allow unmatched public F-1 without unknown fallback', async () => {
    const f = fixture(); assertRepriced(f, await f.put(patch));
    expect(f.calls.filter(call => ['productAsset', 'fabricProfile', 'fabricCustomerCode'].includes(call.model) && call.operation === 'findMany').map(call => call.model))
      .toEqual(['productAsset', 'fabricProfile', 'fabricCustomerCode']);
  });
  it('exclusive material owned by current quotation customer remains legal', async () => {
    const f = fixture(); material(f, 'REL-1'); assertRepriced(f, await f.put(patch));
  });
  it('foreign exclusive material blocks409 before version/line/quote writes, retaining independent refusal audit', async () => {
    const f = fixture(); material(f, 'REL-OTHER'); const before = f.businessSnapshot(), response = await f.put(patch);
    expect(response.status).toBe(409); expect(response.body.error).toContain('专属面料阻断');
    expect(f.businessSnapshot()).toBe(before); expect(f.changes).toEqual([]); expect(f.lockCalls).toEqual([]);
    expect(f.tables.auditLog).toHaveLength(1); expect(f.tables.auditLog[0]).toMatchObject({ action: 'exclusive_fabric_violation_attempt', actorId: 'sales' });
    expect(f.tables.auditLog[0].detail.after.violations[0].ownerRelationId).toBe('REL-OTHER');
  });
  it.each(['productAsset', 'fabricProfile', 'fabricCustomerCode'])('%s relation query fault is500, never permission or version progress', async model => {
    const f = fixture(); f.faults.add(model); const before = f.businessSnapshot(), response = await f.put(patch);
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('面料专属使用权限暂时无法核验，本次操作未执行，请稍后重试。');
    expect(f.businessSnapshot()).toBe(before); expect(f.tables.auditLog).toEqual([]);
    expect(f.changes).toEqual([]); expect(f.lockCalls).toEqual([]);
    expect(f.calls.filter(call => ['create', 'createMany', 'update', 'deleteMany', 'upsert'].includes(call.operation))).toEqual([]);
  });
  it('unrelated customer-code collision is filtered to REL-1/null and never global-fallbacks to other customer', async () => {
    const f = fixture(); f.tables.productAsset.push({ id: 'FOREIGN', sku: 'OTHER-SKU', name: 'other material', deletedAt: null });
    f.tables.fabricCustomerCode.push({ productAssetId: 'FOREIGN', clientCode: 'F-1', customerOrganizationId: 'REL-OTHER', customerNameSnapshot: 'Other Buyer', isExclusive: true, deletedAt: null });
    assertRepriced(f, await f.put(patch));
    const reads = f.calls.filter(call => call.model === 'fabricCustomerCode');
    expect(reads).toHaveLength(1); expect(reads[0].args.where).toEqual({ clientCode: 'F-1', deletedAt: null, OR: [{ customerOrganizationId: null }, { customerOrganizationId: 'REL-1' }] });
  });
  it('notes-only neither rechecks material nor snapshots a new version', async () => {
    const f = fixture(); for (const model of ['productAsset', 'fabricProfile', 'fabricCustomerCode']) f.faults.add(model);
    const response = await f.put({ notes: 'original draft note' });
    expect(response.status).toBe(200); expect(f.tables.quotation[0]).toMatchObject({ version: 1, totalAmount: 1000, notes: 'original draft note' });
    expect(f.tables.quotationVersion).toEqual([]);
    expect(f.calls.filter(call => ['productAsset', 'fabricProfile', 'fabricCustomerCode'].includes(call.model))).toEqual([]);
  });
  it('current stored write withdrawal denies old signed scope before quotation lookup', async () => {
    const f = fixture(); f.tables.userAccount[0].roles[0].role.permissions = []; const before = f.businessSnapshot();
    const response = await f.put(patch); expect(response.status).toBe(403); expect(f.businessSnapshot()).toBe(before);
    expect(f.calls.filter(call => call.model === 'quotation')).toEqual([]); expect(f.tables.auditLog).toEqual([]);
  });
  it('signed empty ceiling and forged body owner cannot submit repricing', async () => {
    const f = fixture([]), before = f.businessSnapshot();
    const response = await f.put({ ...patch, actor: { userId: 'owner', roles: ['owner'], permissions: ['quotations:write'] } });
    expect(response.status).toBe(403); expect(f.businessSnapshot()).toBe(before);
    expect(f.calls.filter(call => call.model === 'quotation')).toEqual([]); expect(f.changes).toEqual([]);
  });
});
