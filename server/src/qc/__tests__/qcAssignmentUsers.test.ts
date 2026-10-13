import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { createQcRouter } from '../qcRoute';
import { createQcService } from '../qcService';
import { createQcScopedService } from '../qcScopedService';
import { assertQcAssignmentUser, attachQcAssignmentUsers } from '../qcAssignmentUsers';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../../auth/tokenHelpers';
const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
// Storage-only transaction rollback substitute + real HTTP/native auth/business
// helpers. This is not PostgreSQL lock/commit or rendered acceptance evidence.
function makeMockPrisma() {
  let seq = 0;
  const locations: any[] = [];
  const assignments: any[] = [];
  const orders: any[] = [];
  // Current persisted role/grant facts, independent of legacy JWT claims.
  const authUser = (id: string, roleId: string, scopes: string[]) => ({ id, displayName: id, status: 'active', deletedAt: null,
    roles: [{ roleId, role: { id: roleId, name: id, permissions: scopes.map(scope => ({ permission: { scope } })) } }] });
  const userAccounts: any[] = [authUser('u1', 'owner', ['qc:read', 'qc:write', 'qc:inspect', 'qc:fabric_chain:write']),
    authUser('u_qc', 'synthetic-qc-role', ['qc:read', 'qc:write', 'qc:inspect', 'qc:fabric_chain:write']), authUser('u_fin', 'finance', ['qc:read'])];
  const audits: any[] = [];
  const locks: any[] = [];
  const inspectionReports: any[] = [];
  const orderLines: any[] = [];        // ★ 2026-09-29 晚：幅宽实测要校验订单行归属
  const widthMeasurements: any[] = []; // ★ 2026-09-29 晚：幅宽实测（QC 查货登记）

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'AND') return (v as any[]).every(sub => matchWhere(row, sub));
      if (k === 'OR') return (v as any[]).some(sub => matchWhere(row, sub));
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('notIn' in cond) return !cond.notIn.includes(row[k]);
        if ('lt' in cond && !(row[k] < cond.lt)) return false;
        if ('lte' in cond && !(row[k] <= cond.lte)) return false;
        if ('gt' in cond && !(row[k] > cond.gt)) return false;
        if ('gte' in cond && !(row[k] >= cond.gte)) return false;
        return true;
      }
      return row[k] === v;
    });

  const applyOrderBy = (rows: any[], orderBy: any) => {
    if (!orderBy) return rows;
    const orders_ = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((x, y) => {
      for (const o of orders_) {
        const [[field, dir]] = Object.entries(o) as [string, string][];
        const xv = x[field] ?? null;
        const yv = y[field] ?? null;
        if (xv === yv) continue;
        if (xv === null) return 1;
        if (yv === null) return -1;
        if (xv < yv) return dir === 'desc' ? 1 : -1;
        if (xv > yv) return dir === 'desc' ? -1 : 1;
      }
      return 0;
    });
  };

  const applyTakeSkip = (rows: any[], take?: number, skip?: number) =>
    rows.slice(skip || 0, (skip || 0) + (take ?? rows.length));

  const qCLocation = {
    findUnique: async ({ where }: any) =>
      locations.find(l => (where.id !== undefined ? l.id === where.id : l.code === where.code)) || null,
    findMany: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(locations.filter(l => matchWhere(l, where)), orderBy),
    create: async ({ data }: any) => {
      const row = { region: null, focus: null, address: null, notes: null, deletedAt: null, ...data, id: data.id || `QCL__T${++seq}` };
      locations.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = locations.find(l => l.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const withLocation = (row: any, include: any) =>
    include?.location ? { ...row, location: locations.find(l => l.id === row.locationId) ?? null } : row;

  const qCAssignment = {
    findUnique: async ({ where }: any) => assignments.find(a => a.id === where.id) ? { ...assignments.find(a => a.id === where.id) } : null,
    findFirst: async ({ where }: any = {}) => assignments.find(a => matchWhere(a, where)) || null,
    findMany: async ({ where, orderBy, take, skip, include }: any = {}) =>
      applyTakeSkip(applyOrderBy(assignments.filter(a => matchWhere(a, where)), orderBy), take, skip)
        .map(r => withLocation(r, include)),
    count: async ({ where }: any = {}) => assignments.filter(a => matchWhere(a, where)).length,
    create: async ({ data }: any) => {
      const row = { locationId: null, factoryRelationId: null, status: 'Assigned', dueDate: null, assignedById: null, completedAt: null, reportId: null, notes: null, deletedAt: null, ...data, id: data.id || `QCA__T${++seq}` };
      assignments.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = assignments.find(a => a.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const order = {
    findUnique: async ({ where }: any) => orders.find(o => o.id === where.id) || null,
    findFirst: async ({ where }: any) => orders.find(o => matchWhere(o, where)) || null,
    findMany: async ({ where }: any = {}) => orders.filter(o => matchWhere(o, where)),
  };

  const userAccount = {
    findUnique: async ({ where }: any) => userAccounts.find(u => matchWhere(u, where)) || null,
    findFirst: async ({ where }: any) => userAccounts.find(u => matchWhere(u, where)) || null,
  };

  const inspectionReport = {
    findUnique: async ({ where }: any) => inspectionReports.find(r => r.id === where.id) || null,
    findFirst: async ({ where }: any) => inspectionReports.find(r => matchWhere(r, where)) || null,
    // P2 验货报告台账（listReports）：分页 findMany + count
    findMany: async ({ where, orderBy, take, skip }: any = {}) =>
      applyTakeSkip(applyOrderBy(inspectionReports.filter(r => matchWhere(r, where)), orderBy), take, skip),
    count: async ({ where }: any = {}) => inspectionReports.filter(r => matchWhere(r, where)).length,
    create: async ({ data }: any) => {
      // 语义对齐 Prisma：non-nullable Int 字段显式 null → 抛错（防 schema 契约回退）
      for (const f of ['totalUnits', 'passedUnits', 'criticalDefects', 'majorDefects', 'minorDefects']) {
        if (f in data && data[f] === null) {
          throw new Error(`Argument \`${f}\` must not be null.`);
        }
      }
      inspectionReports.push(data);
      return data;
    },
  };

  // REQ2-04 第三方测试管理（安全收口测试用：TestRequest / TestReportFile）
  const testRequests: any[] = [];
  const testReportFiles: any[] = [];
  const testRequest = {
    findFirst: async ({ where }: any = {}) => testRequests.find(r => matchWhere(r, where)) || null,
    findMany: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(testRequests.filter(r => matchWhere(r, where)), orderBy),
    count: async ({ where }: any = {}) => testRequests.filter(r => matchWhere(r, where)).length,
    create: async ({ data }: any) => { testRequests.push(data); return data; },
    update: async ({ where, data }: any) => {
      const row = testRequests.find(r => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };
  const testReportFile = {
    findFirst: async ({ where }: any = {}) => testReportFiles.find(f => matchWhere(f, where)) || null,
    create: async ({ data }: any) => { testReportFiles.push(data); return data; },
    update: async ({ where, data }: any) => {
      const row = testReportFiles.find(f => f.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  /**
   * ★ 2026-09-29 晚：**幅宽实测**（QC 查货登记）+ 订单行。
   *   `completeAssignment` 现在会：① 校验幅宽里的订单行属于本订单（读 `orderLine.findMany`）；
   *   ② 把「报告 + 幅宽实测」放进**同一事务**写（`$transaction`）。
   *   ⇒ 假库必须补这三样，否则那条用例会 500（`db.$transaction is not a function`）。
   */
  const orderLine = {
    findMany: async ({ where }: any = {}) =>
      (orderLines as any[]).filter((l) => {
        const ids: string[] = where?.id?.in ?? [];
        if (ids.length && !ids.includes(l.id)) return false;
        if (where?.orderId && l.orderId !== where.orderId) return false;
        return true;
      }),
  };
  const inspectionWidthMeasurement = {
    findMany: async ({ where }: any = {}) =>
      (widthMeasurements as any[])
        .filter((w) => matchWhere(w, where))
        .map((w) => ({ ...w })),
    createMany: async ({ data }: any) => {
      for (const row of data as any[]) {
        if (widthMeasurements.some((w) => w.reportId === row.reportId && w.orderLineId === row.orderLineId)) {
          throw new Error('duplicate width measurement');
        }
        widthMeasurements.push({ ...row });
      }
      return { count: data.length };
    },
  };

  const client: any = {
    qCLocation,
    qCAssignment,
    order,
    userAccount,
    inspectionReport,
    testRequest,
    testReportFile,
    orderLine,
    inspectionWidthMeasurement,
    userPermissionOverrides: { findMany: async () => [] },
    relation: { findMany: async () => [] }, teamMember: { findMany: async () => [] },
    auditLog: {
      create: async ({ data }: any) => { audits.push(data); return data; },
      findMany: async ({ where }: any = {}) => audits.filter(row => Object.entries(where).every(([key, value]) => row[key] === value)),
    },
    $queryRaw: async (query: any) => {
      const table = query.strings.join(' ').includes('"QCAssignment"') ? assignments
        : query.strings.join(' ').includes('"InspectionReport"') ? inspectionReports : orders;
      locks.push(query.strings.join(' '));
      const row = table.find(item => item.id === query.values[0]); return row ? [{ id: row.id }] : [];
    },
    // Transaction substitute restores rows on failure. Actual SQL atomicity is
    // independently exercised by qcAssignmentAuthorizationRealDb.test.ts.
    $transaction: async (fn: any) => {
      const stores = [locations, assignments, orders, userAccounts, inspectionReports, testRequests, testReportFiles, orderLines, widthMeasurements, audits];
      const before = stores.map(rows => structuredClone(rows));
      try { return await fn(client); } catch (error) { stores.forEach((rows, i) => rows.splice(0, rows.length, ...before[i])); throw error; }
    },
    _stores: { locations, assignments, orders, userAccounts, inspectionReports, testRequests, testReportFiles, orderLines, widthMeasurements, audits, locks },
  };
  return client;
}

function fixture() {
  const db = makeMockPrisma(), stores = db._stores, overrides: any[] = [];
  const add = (id: string, scopes: string[], label = 'finance') => {
    const user = { id, displayName: '同名执行人', email: `${id}@private.invalid`, status: 'active', deletedAt: null,
      primaryDepartment: { name: id === 'eligible' ? '第一组' : '第二组' },
      roles: [{ roleId: 'custom-' + id, role: { id: 'custom-' + id, name: label,
        permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
    stores.userAccounts.push(user); return user;
  };
  const target = add('eligible', ['qc:read', 'qc:inspect', 'qc:fabric_chain:write']);
  const denied = add('label-only', [], 'QC');
  const personal = add('personal', ['qc:read']);
  overrides.push({ userId: personal.id, scope: 'qc:inspect', isActive: true, deletedAt: null, expiresAt: null });
  const source = { id: 'O1', poNumber: 'PO-real', type: 'fabric', ownerId: 'u1', customerRelationId: null,
    deletedAt: null, millRelationId: null, product: 'Synthetic raw fabric', customer: 'Synthetic customer', quantity: 10, updatedAt: 10n };
  stores.orders.push(source); stores.orderLines.push({ id: 'L1', orderId: source.id, lineNumber: 1, materialCode: null,
    quantity: '10.0000', unit: 'M', updatedAt: 10n });
  db.userAccount.findMany = async ({ where = {}, select }: any = {}) => stores.userAccounts.filter((user: any) =>
    (!where.id?.in || where.id.in.includes(user.id)) && (!where.status || user.status === where.status)
    && (where.deletedAt !== null || user.deletedAt === null)).map((user: any) => select
      ? Object.fromEntries(Object.keys(select).filter(key => select[key]).map(key => [key, user[key]])) : user);
  db.userPermissionOverrides.findMany = async ({ where }: any) => overrides.filter(row => row.userId === where.userId
    && row.isActive && row.deletedAt == null && (row.expiresAt == null || row.expiresAt > new Date()));
  db.productionBatch = { findMany: async () => [] };
  db.releaseScope = { findMany: async () => [] }; db.ppSampleRelease = { findMany: async () => [] };
  db.productAsset = { findUnique: async () => null };
  const raw = db.$queryRaw;
  db.$queryRaw = async (query: any) => {
    const sql = query.strings.join(' '); const id = query.values[0];
    if (/FROM "(UserAccount|UserRole|Role|RolePermission|Permission|UserPermissionOverrides)"/.test(sql)) {
      stores.locks.push(sql);
      if (/FROM "UserAccount"/.test(sql)) return stores.userAccounts.some((row: any) => row.id === id) ? [{ id }] : [];
      return [];
    }
    return raw(query);
  };
  const originalUnique = db.qCAssignment.findUnique;
  db.qCAssignment.findUnique = async ({ where }: any) => where.assignedById_requestKey
    ? stores.assignments.find((row: any) => row.assignedById === where.assignedById_requestKey.assignedById
      && row.requestKey === where.assignedById_requestKey.requestKey) ?? null : originalUnique({ where });
  db.auditLog.findFirst = async ({ where }: any) => stores.audits.find((row: any) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null;
  const app = express(); app.use(express.json());
  app.use('/qc', createQcRouter({ prisma: db, requireAuth: true, apiKeys: new Set(['synthetic-key']) }));
  const principal = async (id = 'u1', ceiling?: string[]) => {
    const user = await loadUserWithRoles(db, id); const actor = await buildLoadedAuthTokenPayload(db, user);
    return { ...actor, ...(ceiling !== undefined ? { permissionCeiling: ceiling } : {}) };
  };
  const token = async (id = 'u1', ceiling?: string[]) => `Bearer ${jwt.sign(await principal(id, ceiling), SECRET)}`;
  return { db, stores, overrides, add, target, denied, personal, source, app, principal, token };
}
const input = { orderId: 'O1', inspectionType: 'final' as const, qcUserId: 'eligible' };
const code = (res: any) => res.body.error?.code ?? res.body.error;

describe('QC assignment users current eligibility and actual HTTP boundary', () => {
  it('QC-scoped dispatcher without HR can read only minimal names, including non-QC roles and personal grants', async () => {
    const f = fixture(); const res = await request(f.app).get('/qc/assignment-users').set('Authorization', await f.token('u_qc'));
    expect(res.status).toBe(200); expect(res.body.ok).toBe(true);
    expect(res.body.users.map((row: any) => row.id)).toContain('eligible');
    expect(res.body.users.map((row: any) => row.id)).toContain('personal');
    expect(res.body.users.map((row: any) => row.id)).not.toContain('label-only');
    for (const row of res.body.users) expect(Object.keys(row).sort()).toEqual(['departmentName', 'displayName', 'id']);
    expect(JSON.stringify(res.body)).not.toContain('@private.invalid'); expect(f.stores.assignments).toEqual([]); expect(f.stores.audits).toEqual([]);
  });
  it.each([[[]], [['qc:read']]])('signed ceiling %j cannot borrow current broader stored grants', async ceiling => {
    const f = fixture(); const res = await request(f.app).get('/qc/assignment-users').set('Authorization', await f.token('u1', ceiling));
    expect(res.status).toBe(403); expect(res.body.users).toBeUndefined();
  });
  it('only HR or QC read grants do not authorize the writable-business roster', async () => {
    const f = fixture(); f.add('hr-only', ['hr:read']);
    for (const id of ['hr-only', 'u_fin']) {
      const res = await request(f.app).get('/qc/assignment-users').set('Authorization', await f.token(id));
      expect(res.status).toBe(403); expect(res.body.users).toBeUndefined();
    }
  });
  it('API-key and body actor claims cannot open the users endpoint', async () => {
    const f = fixture();
    expect((await request(f.app).get('/qc/assignment-users').set('X-API-Key', 'synthetic-key').query({ actorId: 'u1', roles: 'owner' })).status).toBe(401);
    expect((await request(f.app).get('/qc/assignment-users').query({ actorId: 'u1' })).status).toBe(401);
  });
  it('current disabled dispatcher is denied although an earlier JWT claimed permission', async () => {
    const f = fixture(), token = await f.token(); f.stores.userAccounts.find((row: any) => row.id === 'u1').status = 'disabled';
    const res = await request(f.app).get('/qc/assignment-users').set('Authorization', token);
    expect(res.status).toBe(401); expect(code(res)).toBe('ACCOUNT_DISABLED'); expect(res.body.users).toBeUndefined();
  });
  it('query failure is safe unavailable, never empty names or raw storage text', async () => {
    const f = fixture(); f.db.userAccount.findMany = async () => { throw Error('private SQL secret@example.invalid'); };
    const res = await request(f.app).get('/qc/assignment-users').set('Authorization', await f.token());
    expect(res.status).toBe(503); expect(code(res)).toBe('AUTHORIZATION_UNAVAILABLE');
    expect(res.body.users).toBeUndefined(); expect(JSON.stringify(res.body)).not.toContain('secret@example.invalid');
  });
  it('late current caller grant withdrawal fails the post-read authority check', async () => {
    const f = fixture(), token = await f.token(), original = f.db.userAccount.findMany;
    f.db.userAccount.findMany = async (args: any) => { const rows = await original(args);
      f.stores.userAccounts.find((row: any) => row.id === 'u1').roles[0].role.permissions = []; return rows; };
    const res = await request(f.app).get('/qc/assignment-users').set('Authorization', token);
    expect(res.status).toBe(403); expect(res.body.users).toBeUndefined();
  });
  it('names on QC-read visible tasks do not enumerate other accounts or require roster writes', async () => {
    const f = fixture(), requests: any[] = [], original = f.db.userAccount.findMany;
    f.db.userAccount.findMany = async (args: any) => { requests.push(args); return original(args); };
    const result = await attachQcAssignmentUsers(f.db, [{ id: 'A1', qcUserId: 'eligible' }]);
    expect(result).toEqual([{ id: 'A1', qcUserId: 'eligible', qcUser: { id: 'eligible', displayName: '同名执行人' } }]);
    expect(requests).toEqual([{ where: { id: { in: ['eligible'] }, deletedAt: null }, select: { id: true, displayName: true } }]);
  });
  it('legacy create with actual read/write grants preserves original identity and locks target after Order', async () => {
    const f = fixture(), actor = await f.principal();
    const row = await createQcService(f.db).createAssignment(input, actor);
    expect(row.qcUserId).toBe('eligible'); expect(row.assignedById).toBe('u1'); expect(f.stores.audits).toHaveLength(1);
    expect(f.stores.locks.findIndex((sql: string) => sql.includes('FROM "Order"'))).toBeLessThan(f.stores.locks.findIndex((sql: string) => sql.includes('FROM "UserAccount"')));
    expect(f.stores.locks.filter((sql: string) => sql.includes('FROM "UserAccount"')).every((sql: string) => sql.includes('FOR SHARE') && !sql.includes('FOR KEY SHARE'))).toBe(true);
  });
  it.each(['disabled', 'deleted', 'no-grant', 'read-only', 'write-only', 'expired-personal'])('new legacy assignment rejects actual target %s with zero task/audit', async variant => {
    const f = fixture(); if (variant === 'disabled') f.target.status = 'disabled';
    else if (variant === 'deleted') f.target.deletedAt = 11n as any;
    else { f.target.roles[0].role.permissions = (variant === 'read-only' ? ['qc:read'] : variant === 'write-only' ? ['qc:write'] : []).map(scope => ({ permission: { scope } }));
      if (variant === 'expired-personal') f.overrides.push({ userId: f.target.id, scope: 'qc:read', isActive: true, expiresAt: new Date(0), deletedAt: null }, { userId: f.target.id, scope: 'qc:write', isActive: true, expiresAt: new Date(0), deletedAt: null }); }
    await expect(createQcService(f.db).createAssignment(input, await f.principal())).rejects.toMatchObject({ code: variant === 'deleted' ? 'NOT_FOUND' : 'VALIDATION_FAILED' });
    expect(f.stores.assignments).toEqual([]); expect(f.stores.audits).toEqual([]);
  });
  it('late target grant withdrawal rolls back a staged task before mandatory audit', async () => {
    const f = fixture(), original = f.db.qCAssignment.create;
    f.db.qCAssignment.create = async (args: any) => { const row = await original(args); f.target.roles[0].role.permissions = []; return row; };
    await expect(createQcService(f.db).createAssignment(input, await f.principal())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(f.stores.assignments).toEqual([]); expect(f.stores.audits).toEqual([]);
  });
  it('target grant query and recipient lock failures are safely unavailable and never create task/audit', async () => {
    for (const failing of ['grant', 'lock']) {
      const f = fixture(), raw = f.db.$queryRaw, grants = f.db.userPermissionOverrides.findMany;
      if (failing === 'lock') f.db.$queryRaw = async (query: any) => query.strings.join(' ').includes('FROM "UserAccount"') ? Promise.reject(Error('private lock SQL')) : raw(query);
      else f.db.userPermissionOverrides.findMany = async (args: any) => args.where.userId === 'eligible' ? Promise.reject(Error('private grant SQL')) : grants(args);
      await expect(createQcService(f.db).createAssignment(input, await f.principal())).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE', statusCode: 503 });
      expect(f.stores.assignments).toEqual([]); expect(f.stores.audits).toEqual([]);
    }
  });
  it('reassignment cannot transfer a successful task to a role-name-only recipient', async () => {
    const f = fixture(), service = createQcService(f.db), actor = await f.principal(); const row = await service.createAssignment(input, actor);
    const before = structuredClone(f.stores.assignments); const audits = f.stores.audits.length;
    await expect(service.updateAssignment(row.id, { qcUserId: 'label-only' }, actor)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(f.stores.assignments).toEqual(before); expect(f.stores.audits).toHaveLength(audits);
  });
  it('mandatory audit failure rolls back a staged eligible assignment in the storage transaction seam', async () => {
    const f = fixture(); f.db.auditLog.create = async () => { throw Error('private audit failure'); };
    await expect(createQcService(f.db).createAssignment(input, await f.principal())).rejects.toThrow('private audit failure');
    expect(f.stores.assignments).toEqual([]); expect(f.stores.audits).toEqual([]);
  });
  it('modern scoped exact key replays original ACK after target later disabled without new facts', async () => {
    const f = fixture(), service = createQcScopedService(f.db), actor = await f.principal();
    const scopes = await service.scopes('O1', actor), command = { ...input, scopeType: 'whole_order' as const,
      productionBatchId: null, expectedScopeFingerprint: scopes.scopes[0].scopeFingerprint, requestKey: 'same-original-key' };
    const first = await service.create(command, actor); expect(first.replayed).toBe(false);
    f.target.status = 'disabled'; const replay = await service.create(command, actor);
    expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(first.receipt); expect(replay.item.id).toBe(first.item.id);
    expect(f.stores.assignments).toHaveLength(1); expect(f.stores.audits).toHaveLength(1);
    await expect(service.create({ ...command, requestKey: 'new-key', inspectionType: 'midline' }, actor)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(f.stores.assignments).toHaveLength(1); expect(f.stores.audits).toHaveLength(1);
  });
  it('a missing scoped ACK remains conflict and cannot be recast as a new eligible request', async () => {
    const f = fixture(), service = createQcScopedService(f.db), actor = await f.principal();
    const scopes = await service.scopes('O1', actor), command = { ...input, scopeType: 'whole_order' as const, productionBatchId: null,
      expectedScopeFingerprint: scopes.scopes[0].scopeFingerprint, requestKey: 'key-unknown' };
    await service.create(command, actor); f.stores.audits.splice(0); f.target.status = 'disabled';
    await expect(service.create(command, actor)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(f.stores.assignments).toHaveLength(1); expect(f.stores.audits).toHaveLength(0);
  });
});
