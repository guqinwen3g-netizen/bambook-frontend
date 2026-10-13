/** Real Express/auth/current-RBAC/customer/team/service producers over explicit
 * storage. No authorization/service mocks, real database writes, or PG lock proof. */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createAuthService } from '../../auth/service';
import { createAuthorizationSnapshotGuard } from '../../auth/authorizationSnapshotGuard';
import { createQuotationRouter } from '../quotationRoute';

const clone = <T>(value: T): T => structuredClone(value);
function fixture() {
  const scopes = ['quotations:read', 'quotations:write'];
  const user = (id: string, roleId = 'role-sales') => ({ id, displayName: id, status: 'active', deletedAt: null,
    primaryDeptId: null, roles: [{ roleId, departmentId: null, role: { id: roleId, permissions: scopes.map(scope => ({ permission: { scope } })) } }] });
  const customer = (id: string, ownerId: string) => ({ id, name: id, ownerId, salesRepIds: [], deletedAt: null, departmentId: null });
  const quote = (id: string, customerRelationId: string | null, ownerId: string) => ({ id, quotationNumber: id,
    quotationType: 'Fabric', customerRelationId, customerName: customerRelationId, ownerId, departmentId: null,
    currency: 'USD', baseCurrency: 'CNY', exchangeRate: null, totalAmount: 100, version: 2, status: 'Draft',
    issueDate: '2026-10-01', validUntil: '2099-01-01', notes: null, deliveryTerms: 'FOB', paymentTerms: 'Initial',
    deletedAt: null, createdAt: 1, updatedAt: 2, developmentCaseId: 'CASE', orderId: null, orderLineId: null,
    moqSnapshot: { fabricDefaultMoq: 1, garmentDefaultMoq: 1, capsuleMoq: 1, snapshotAt: '2026-10-01', configId: null } });
  const tables: Record<string, any[]> = {
    userAccount: [user('sales'), user('peer'), user('outsider'), user('leader', 'role-sales-manager'), user('boss', 'role-super-admin')],
    userPermissionOverrides: [], relation: [customer('OWN', 'sales'), customer('TEAM', 'peer'), customer('OTHER', 'outsider')],
    team: [{ id: 'T', deletedAt: null, status: 'active', leaderId: 'leader' }],
    teamMember: ['sales', 'peer', 'leader'].map(userId => ({ id: 'TM_' + userId, userId, teamId: 'T', leftAt: null })),
    teamDataGrant: [], quotation: [quote('Q_OWN', 'OWN', 'sales'), quote('Q_TEAM', 'TEAM', 'peer'), quote('Q_OTHER', 'OTHER', 'outsider'), quote('Q_LEGACY', null, 'outsider')],
    quotationLine: [], quotationVersion: [], approvalRequest: [], auditLog: [], entityReference: [], entityLink: [],
    customerTier: [], moqThresholdConfig: [], systemConfig: [], productAsset: [], order: [], tradeDocument: [], agentJob: [],
  };
  for (const q of tables.quotation) {
    const line = { id: q.id + '_L', quotationId: q.id, lineNumber: 1, productAssetId: 'P', productType: 'Fabric',
      fabricCode: 'FAB-1', description: 'Cloth', specification: 'Frozen cloth specification', moq: 1,
      quantity: 10, unit: 'M', unitPrice: 10, amount: 100, imageUrl: null, notes: null, moqOverride: null };
    tables.quotationLine.push(line);
    tables.quotationVersion.push({ id: q.id + '_V1', quotationId: q.id, version: 1, totalAmount: 100, currency: 'USD',
      headerSnapshot: { ...q, version: 1, status: 'Sent' }, linesSnapshot: [{ ...line }], createdAt: 1 });
  }
  const calls: Array<{ model: string; operation: string; args: any }> = [], writes: Array<{ model: string; operation: string }> = [];
  const faults = new Set<string>();
  const attached = (model: string, row: any) => model === 'teamMember' || model === 'teamDataGrant'
    ? { ...row, team: tables.team.find(team => team.id === row.teamId) } : row;
  function matches(row: any, where: any): boolean {
    return Object.entries(where ?? {}).every(([key, value]: any) => {
      if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((part: any) => matches(row, part));
      if (key === 'OR') return value.some((part: any) => matches(row, part));
      if (value == null) return row[key] == null;
      if (typeof value !== 'object' || value instanceof Date) return row[key] === value;
      if ('in' in value) return value.in.includes(row[key]);
      if ('has' in value) return (row[key] ?? []).includes(value.has);
      if ('hasSome' in value) return value.hasSome.some((id: string) => (row[key] ?? []).includes(id));
      if ('not' in value) return row[key] !== value.not;
      if ('notIn' in value) return !value.notIn.includes(row[key]);
      if (key === 'team') return matches(row.team ?? {}, value);
      throw Error('UNSUPPORTED_QUERY:' + key);
    });
  }
  const db: any = {};
  for (const model of Object.keys(tables)) {
    const record = (operation: string, args: any) => {
      calls.push({ model, operation, args: clone(args ?? {}) });
      if (faults.has(model)) throw Error('STORAGE_FAULT:' + model);
    };
    const find = (args: any = {}) => {
      let rows = tables[model].map(row => attached(model, row)).filter(row => matches(row, args.where));
      const order = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
      for (const entry of order) for (const [key, direction] of Object.entries(entry))
        rows = rows.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (direction === 'desc' ? -1 : 1));
      return rows.map(row => {
        let result = clone(row);
        if (model === 'quotation' && args.include?.lines) result.lines = clone(tables.quotationLine.filter(line => line.quotationId === row.id));
        if (args.select) result = Object.fromEntries(Object.keys(args.select).filter(key => args.select[key]).map(key => [key, result[key]]));
        return result;
      });
    };
    db[model] = {
      findFirst: async (args: any = {}) => { record('findFirst', args); return find(args)[0] ?? null; },
      findUnique: async (args: any = {}) => { record('findUnique', args); return find(args)[0] ?? null; },
      findMany: async (args: any = {}) => { record('findMany', args); return find(args); },
      count: async (args: any = {}) => { record('count', args); return find(args).length; },
      create: async (args: any) => { record('create', args); writes.push({ model, operation: 'create' }); tables[model].push(clone(args.data)); return clone(args.data); },
      update: async (args: any) => {
        record('update', args); writes.push({ model, operation: 'update' });
        const row = tables[model].find(row => matches(attached(model, row), args.where)); if (!row) throw Error('ROW_MISSING');
        Object.assign(row, clone(Object.fromEntries(Object.entries(args.data).filter(([, value]) => value !== undefined))));
        return find({ where: args.where, include: args.include })[0];
      },
      upsert: async (args: any) => {
        record('upsert', args); writes.push({ model, operation: 'upsert' });
        const row = tables[model].find(row => matches(row, args.where));
        if (row) Object.assign(row, clone(args.update)); else tables[model].push(clone(args.create));
        return clone(row ?? args.create);
      },
    };
  }
  db.$queryRaw = async () => [{ id: 'source-lock' }];
  db.$transaction = async (work: any) => {
    const before = clone(tables), count = writes.length;
    try { return await work(db); } catch (error) { Object.assign(tables, before); writes.splice(count); throw error; }
  };
  const auth = createAuthService(), app = express(), changes: any[] = [];
  app.use(express.json());
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: db }));
  app.use('/api/v1/quotations', createQuotationRouter({ prisma: db, requireAuth: true, apiKeys: new Set(), onDataChange: change => changes.push(change) }));
  const token = (id = 'sales') => auth.signToken({ userId: id, roles: id === 'leader' ? ['manager'] : id === 'boss' ? ['owner'] : ['sales'], permissionCeiling: scopes });
  const call = (method: 'get' | 'post' | 'put' | 'delete', url: string, id = 'sales', body?: any) => {
    const pending = request(app)[method]('/api/v1/quotations' + url).set('Authorization', 'Bearer ' + token(id));
    return body ? pending.send(body) : pending;
  };
  const share = (permission = 'read') => tables.teamDataGrant.push({ id: 'G', teamId: 'T', entityType: 'relation', entityId: 'TEAM', permission, revokedAt: null, grantedAt: new Date() });
  return { tables, db, calls, writes, changes, faults, call, share };
}

describe('quotation objects use current authenticated customer authority', () => {
  it.each(['/Q_OTHER', '/Q_OTHER/preview.html', '/Q_OTHER/versions', '/Q_OTHER/versions/1/preview.html', '/Q_OTHER/approval-status'])('rejects known unrelated object %s without source writes', async url => {
    const f = fixture(), res = await f.call('get', url);
    expect(res.status).toBe(404); expect(f.writes).toEqual([]); expect(res.text).not.toContain('Frozen cloth specification');
  });
  it.each(['/Q_OTHER', '/Q_OTHER/generate-document', '/Q_OTHER/send', '/Q_OTHER/reject', '/Q_OTHER/expire', '/Q_OTHER/revise',
    '/Q_OTHER/lines/Q_OTHER_L/request-approval', '/Q_OTHER/request-total-approval', '/Q_OTHER/accept', '/Q_OTHER/convert-to-order'])('rejects unrelated old write %s before mutation', async url => {
    const f = fixture(), method = url === '/Q_OTHER' ? 'put' : 'post', res = await f.call(method, url, 'sales', { paymentTerms: 'Changed' });
    expect(res.status).toBe(404); expect(f.writes).toEqual([]); expect(f.changes).toEqual([]);
  });
  it('rejects unrelated deletion before mutation', async () => {
    const f = fixture(); expect((await f.call('delete', '/Q_OTHER')).status).toBe(404); expect(f.writes).toEqual([]);
  });
  it('keeps own detail, actual rendered preview, and actual draft update usable', async () => {
    const f = fixture(); expect((await f.call('get', '/Q_OWN')).status).toBe(200);
    const preview = await f.call('get', '/Q_OWN/preview.html'); expect(preview.status).toBe(200); expect(preview.text).toContain('Frozen cloth specification');
    const updated = await f.call('put', '/Q_OWN', 'sales', { paymentTerms: '30% deposit' });
    expect(updated.status).toBe(200); expect(updated.body.quotation.paymentTerms).toBe('30% deposit');
    expect(f.tables.quotation.find(q => q.id === 'Q_OWN').version).toBe(3); expect(f.changes).toHaveLength(1);
  });
  it('distinguishes team read sharing from current follow-up writing', async () => {
    const f = fixture(); f.share(); expect((await f.call('get', '/Q_TEAM/preview.html')).status).toBe(200);
    expect((await f.call('put', '/Q_TEAM', 'sales', { notes: 'Blocked' })).status).toBe(404); expect(f.writes).toEqual([]);
    f.tables.teamDataGrant[0].permission = 'read+followup';
    expect((await f.call('put', '/Q_TEAM', 'sales', { notes: 'Allowed' })).status).toBe(200);
  });
  it('allows the real team leader while rejecting another team customer', async () => {
    const f = fixture(); expect((await f.call('get', '/Q_TEAM', 'leader')).status).toBe(200);
    expect((await f.call('put', '/Q_TEAM', 'leader', { notes: 'Leader checked' })).status).toBe(200);
    expect((await f.call('get', '/Q_OTHER', 'leader')).status).toBe(404);
  });
  it('uses the same current team boundary for the leader list', async () => {
    const f = fixture(), res = await f.call('get', '/', 'leader');
    expect(res.status).toBe(200); expect(res.body.items.map((q: any) => q.id).sort()).toEqual(['Q_OWN', 'Q_TEAM']);
  });
  it('rechecks changed customer ownership rather than trusting quotation ownership', async () => {
    const f = fixture(); expect((await f.call('get', '/Q_OWN')).status).toBe(200);
    f.tables.relation.find(r => r.id === 'OWN').ownerId = 'outsider';
    expect((await f.call('get', '/Q_OWN')).status).toBe(404); expect((await f.call('get', '/Q_OWN/preview.html')).status).toBe(404);
    expect((await f.call('put', '/Q_OWN', 'sales', { notes: 'Stale ownership' })).status).toBe(404); expect(f.writes).toEqual([]);
  });
  it('does not use cached shared grants after revocation', async () => {
    const f = fixture(); f.share('read+followup'); expect((await f.call('get', '/Q_TEAM')).status).toBe(200);
    f.tables.teamDataGrant[0].revokedAt = new Date();
    expect((await f.call('get', '/Q_TEAM')).status).toBe(404); expect((await f.call('put', '/Q_TEAM', 'sales', { notes: 'Revoked' })).status).toBe(404);
  });
  it('does not retain team access after leaving the recorded team', async () => {
    const f = fixture(); f.share('read+followup'); expect((await f.call('get', '/Q_TEAM')).status).toBe(200);
    f.tables.teamMember.find(m => m.userId === 'sales').leftAt = new Date();
    expect((await f.call('get', '/Q_TEAM')).status).toBe(404); expect((await f.call('put', '/Q_TEAM', 'sales', { notes: 'Former member' })).status).toBe(404);
  });
  it('does not restore withdrawn action grants from the signed token', async () => {
    const f = fixture(); f.tables.userAccount.find(u => u.id === 'sales').roles[0].role.permissions = [{ permission: { scope: 'quotations:read' } }];
    expect((await f.call('get', '/Q_OWN')).status).toBe(200); expect((await f.call('put', '/Q_OWN', 'sales', { notes: 'No write grant' })).status).toBe(403);
    expect(f.writes).toEqual([]);
  });
  it('requires writable target customer when patching a currently writable quote', async () => {
    const f = fixture(); const res = await f.call('put', '/Q_OWN', 'sales', { customerRelationId: 'OTHER', customerName: 'OTHER' });
    expect(res.status).toBe(404); expect(f.tables.quotation[0].customerRelationId).toBe('OWN'); expect(f.writes).toEqual([]);
  });
  it('permits changing to a currently followed customer', async () => {
    const f = fixture(); f.tables.relation.find(r => r.id === 'TEAM').salesRepIds = ['sales'];
    const res = await f.call('put', '/Q_OWN', 'sales', { customerRelationId: 'TEAM', customerName: 'TEAM' });
    expect(res.status).toBe(200); expect(res.body.quotation.customerRelationId).toBe('TEAM');
  });
  it('rejects creating a new quotation for an unrelated existing customer', async () => {
    const f = fixture(), res = await f.call('post', '/', 'sales', { quotationType: 'Fabric', customerRelationId: 'OTHER', currency: 'USD',
      lines: [{ productAssetId: 'P', description: 'Cloth', quantity: 10, unit: 'M', unitPrice: 10 }] });
    expect(res.status).toBe(404); expect(f.writes).toEqual([]);
  });
  it.each(['preview', 'commit'])('blocks importing another customer by name in %s mode', async mode => {
    const f = fixture(), res = await f.call('post', '/import', 'sales', { mode, rows: [{ quotationNumber: 'IMPORT', customerName: 'OTHER', issueDate: '2026-10-01' }] });
    expect(res.status).toBe(404); expect(f.writes).toEqual([]);
  });
  it('retains the owned historical import preview contract', async () => {
    const f = fixture(), res = await f.call('post', '/import', 'sales', { mode: 'preview', rows: [{ quotationNumber: 'IMPORT', customerName: 'OWN', issueDate: '2026-10-01' }] });
    expect(res.status).toBe(200); expect(res.body).toMatchObject({ mode: 'preview', valid: 1, created: 0, errors: [] }); expect(f.writes).toEqual([]);
  });
  it('scopes by-target queries before returning their original DTO', async () => {
    const f = fixture(); f.share(); const res = await f.call('get', '/by-target?developmentCaseId=CASE');
    expect(res.status).toBe(200); expect(res.body.data.items.map((q: any) => q.id).sort()).toEqual(['Q_OWN', 'Q_TEAM']);
    const query = f.calls.filter(c => c.model === 'quotation' && c.operation === 'findMany').at(-1)!;
    expect(query.args.where.AND).toHaveLength(2);
  });
  it('blocks unrelated customer price-profile and allows owned/shared profile', async () => {
    const f = fixture(); expect((await f.call('get', '/price-profile?relationId=OTHER')).status).toBe(404);
    expect((await f.call('get', '/price-profile?relationId=OWN')).status).toBe(200);
    f.share(); expect((await f.call('get', '/price-profile?relationId=TEAM')).status).toBe(200);
  });
  it('does not expose a customerless quote to another salesperson', async () => {
    const f = fixture(); expect((await f.call('get', '/Q_LEGACY')).status).toBe(404);
    expect((await f.call('put', '/Q_LEGACY', 'sales', { notes: 'Blocked' })).status).toBe(404);
    expect((await f.call('get', '/Q_LEGACY', 'boss')).status).toBe(200);
  });
  it('fails closed on current customer storage failure', async () => {
    const f = fixture(); f.faults.add('relation'); expect((await f.call('put', '/Q_OWN', 'sales', { notes: 'Unavailable' })).status).toBe(503);
    expect(f.writes).toEqual([]);
  });
});
