import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
// S3-δ：scope 门禁测试身份——finance 角色无 qc:write（矩阵 FINANCE_BASE 仅 qc:read）；
// QC 角色 legacy 映射 viewer，scope 经 JWT permissions 直查（与登录签发契约一致）
const financeToken = jwt.sign({ userId: 'u_fin', roles: ['finance'] }, SECRET);
const qcToken = jwt.sign({ userId: 'u_qc', roles: ['viewer'], permissions: ['qc:read', 'qc:write'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createQcRouter } from '../qcRoute';
import { setDefaultAgentApiKeyActors } from '../../auth/agentPrincipal';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mock Prisma：内存存储 QCLocation / QCAssignment + 关联真源
 * （Order / UserAccount / InspectionReport）。
 * 语义对齐真实 client 的本测试用到的子集（where 条件、orderBy、
 * qCAssignment.findMany 的 include: { location: true }）。
 */
function makeMockPrisma() {
  let seq = 0;
  const locations: any[] = [];
  const assignments: any[] = [];
  const orders: any[] = [];
  // Current persisted role/grant facts, independent of legacy JWT claims.
  const authUser = (id: string, roleId: string, scopes: string[]) => ({ id, displayName: id, status: 'active', deletedAt: null,
    roles: [{ id: `UR-${id}-${roleId}`, userId: id, roleId, role: { id: roleId, name: id,
      permissions: scopes.map(scope => ({ id: `RP-${roleId}-${scope}`, roleId, permissionId: `P-${scope}`,
        permission: { id: `P-${scope}`, scope } })) } }] });
  const userAccounts: any[] = [authUser('u1', 'owner', ['qc:read', 'qc:write']),
    authUser('u_qc', 'synthetic-qc-role', ['qc:read', 'qc:write']), authUser('u_fin', 'finance', ['qc:read'])];
  const personalOverrides: any[] = [];
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

  const project = (row: any, select: any) => select
    ? Object.fromEntries(Object.entries(select).filter(([, chosen]) => chosen === true).map(([key]) => [key, row[key]]))
    : row;
  const userAccount = {
    findUnique: async ({ where }: any) => userAccounts.find(u => matchWhere(u, where)) || null,
    findFirst: async ({ where }: any) => userAccounts.find(u => matchWhere(u, where)) || null,
    findMany: async ({ where, select, orderBy }: any = {}) =>
      applyOrderBy(userAccounts.filter(u => matchWhere(u, where)), orderBy).map(u => project(u, select)),
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
    userPermissionOverrides: { findMany: async ({ where, select }: any) =>
      personalOverrides.filter(row => matchWhere(row, where)).map(row => project(row, select)) },
    relation: { findMany: async () => [] }, teamMember: { findMany: async () => [] },
    auditLog: { create: async ({ data }: any) => { audits.push(data); return data; } },
    $queryRaw: async (query: any) => {
      const sql = query.strings.join(' ');
      // Bind the outer FROM to its actual stored table; nested grant SELECTs
      // must not fall through to Order or turn a missing target into a match.
      const table = /FROM\s+"([A-Za-z]+)"/.exec(sql)?.[1];
      const id = query.values[0];
      locks.push(sql);
      if (table === 'Order' || table === 'QCAssignment' || table === 'InspectionReport' || table === 'UserAccount') {
        const rows = table === 'Order' ? orders : table === 'QCAssignment' ? assignments
          : table === 'InspectionReport' ? inspectionReports : userAccounts;
        return rows.filter(row => row.id === id).map(row => ({ id: row.id }));
      }
      const user = userAccounts.find(row => row.id === id);
      const memberships = user?.roles ?? [];
      if (table === 'UserRole') return memberships.map((row: any) => ({ id: row.id }));
      if (table === 'Role') return memberships.map((row: any) => ({ id: row.role.id }));
      const relevant = memberships.flatMap((row: any) => row.role.permissions)
        .filter((row: any) => ['qc:read', 'qc:write', '*'].includes(row.permission.scope));
      if (table === 'RolePermission') return relevant.map((row: any) => ({ id: row.id }));
      if (table === 'Permission') return [...new Set(relevant.map((row: any) => row.permission.id))].map(id => ({ id }));
      if (table === 'UserPermissionOverrides') return personalOverrides
        .filter(row => row.userId === id && ['qc:read', 'qc:write', '*'].includes(row.scope)).map(row => ({ id: row.id }));
      throw new Error(`Fixture has no storage table for ${table ?? 'unknown query'}`);
    },
    // Transaction substitute restores rows on failure. Actual SQL atomicity is
    // independently exercised by qcAssignmentAuthorizationRealDb.test.ts.
    $transaction: async (fn: any) => {
      const stores = [locations, assignments, orders, userAccounts, personalOverrides, inspectionReports, testRequests, testReportFiles, orderLines, widthMeasurements, audits];
      const before = stores.map(rows => structuredClone(rows));
      try { return await fn(client); } catch (error) { stores.forEach((rows, i) => rows.splice(0, rows.length, ...before[i])); throw error; }
    },
    _stores: { locations, assignments, orders, userAccounts, personalOverrides, inspectionReports, testRequests, testReportFiles, orderLines, widthMeasurements, audits, locks },
  };
  return client;
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (req.headers.cookie) {
      const cookies: Record<string, string> = {};
      req.headers.cookie.split(';').forEach((c: string) => {
        const [k, v] = c.trim().split('=');
        cookies[k] = v;
      });
      req.cookies = cookies;
    }
    next();
  });
  app.use('/api/v1/qc', createQcRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const auth = () => ({ Cookie: `bambook_token=${ownerToken}` });

function seedOrder(prisma: any, over: Record<string, any> = {}) {
  const row = {
    id: over.id ?? `ORD-${prisma._stores.orders.length + 1}`,
    poNumber: 'PO-1001',
    ownerId: 'u_qc', customerRelationId: null,
    customer: 'Acme',
    product: 'Tee',
    quantity: 1000,
    status: 'InProduction',
    dueDate: '2026-09-01',
    clientDate: '2026-08-20',
    businessLine: 'garment',
    millRelationId: 'REL-MILL-1',
    deletedAt: null,
    ...over,
  };
  prisma._stores.orders.push(row);
  return row;
}

function seedUser(prisma: any, over: Record<string, any> = {}) {
  const id = over.id ?? `QC-U${prisma._stores.userAccounts.length + 1}`;
  const roleId = `synthetic-executor-${id}`;
  const row = { id, displayName: ' QC 甲', status: 'active', deletedAt: null,
    roles: [{ id: `UR-${id}-${roleId}`, userId: id, roleId, role: { id: roleId, name: 'synthetic executor',
      permissions: ['qc:read', 'qc:write'].map(scope => ({ id: `RP-${roleId}-${scope}`, roleId, permissionId: `P-${scope}`,
        permission: { id: `P-${scope}`, scope } })) } }], ...over };
  prisma._stores.userAccounts.push(row);
  return row;
}

// Storage-only regression controls for the adapted original factory. Actual
// route/auth/source helpers remain real; this is not PG row-lock evidence.
function setup() {
  const db = makeMockPrisma();
  seedOrder(db, { id: 'ORD-FACTORY' });
  seedUser(db, { id: 'QC-FACTORY' });
  const target = () => db._stores.userAccounts.find((row: any) => row.id === 'QC-FACTORY');
  const app = makeApp(db);
  const create = () => request(app).post('/api/v1/qc/assignments').set(auth())
    .send({ orderId: 'ORD-FACTORY', inspectionType: 'final', qcUserId: 'QC-FACTORY' });
  return { db, app, target, create };
}
function noFacts(db: any) {
  expect(db._stores.assignments).toEqual([]);
  expect(db._stores.inspectionReports).toEqual([]);
  expect(db._stores.widthMeasurements).toEqual([]);
  expect(db._stores.audits).toEqual([]);
}

describe('original QC factory current stored recipient authorization seams', () => {
  it('actual custom-role read/write grants allow the native route; outer grant lock rows bind to the target account', async () => {
    const f = setup();
    expect(f.target().roles[0].role.name).toBe('synthetic executor');
    const result = await f.create();
    expect(result.status).toBe(201);
    expect(result.body.item.qcUserId).toBe('QC-FACTORY');
    expect(f.db._stores.assignments).toHaveLength(1);
    expect(f.db._stores.audits).toHaveLength(1);
    for (const table of ['UserAccount', 'UserRole', 'Role', 'RolePermission', 'Permission', 'UserPermissionOverrides']) {
      expect(f.db._stores.locks.some((sql: string) => new RegExp(`FROM\\s+"${table}"`).test(sql))).toBe(true);
    }
  });

  it('QC role label without the actual execution grant is refused with zero task/report/audit writes', async () => {
    const f = setup(), target = f.target();
    target.roles[0].role.name = 'QC';
    target.roles[0].role.permissions = target.roles[0].role.permissions.filter((row: any) => row.permission.scope !== 'qc:write');
    const result = await f.create();
    expect(result.status).toBe(400);
    expect(result.body.error.message).toContain('查看和执行权限');
    noFacts(f.db);
  });

  it('only a current active undeleted unexpired personal grant complements a stored role; withdrawn variants never write', async () => {
    for (const variant of ['inactive', 'deleted', 'expired', 'current'] as const) {
      const f = setup();
      f.target().roles[0].role.permissions = f.target().roles[0].role.permissions.filter((row: any) => row.permission.scope !== 'qc:write');
      f.db._stores.personalOverrides.push({ id: 'PO-FACTORY', userId: 'QC-FACTORY', scope: 'qc:write',
        isActive: variant !== 'inactive', deletedAt: variant === 'deleted' ? 1n : null,
        expiresAt: variant === 'expired' ? new Date(0) : null });
      const result = await f.create();
      expect(result.status).toBe(variant === 'current' ? 201 : 400);
      if (variant === 'current') {
        expect(f.db._stores.assignments).toHaveLength(1);
        expect(f.db._stores.audits).toHaveLength(1);
      } else noFacts(f.db);
    }
  });

  it('actual post-lock role reload observes removal of execution permission and leaves no business or audit facts', async () => {
    const f = setup(), query = f.db.$queryRaw;
    f.db.$queryRaw = async (sql: any) => {
      const result = await query(sql);
      if (/FROM\s+"UserPermissionOverrides"/.test(sql.strings.join(' ')) && sql.values[0] === 'QC-FACTORY') {
        f.target().roles[0].role.permissions = f.target().roles[0].role.permissions.filter((row: any) => row.permission.scope !== 'qc:write');
      }
      return result;
    };
    const result = await f.create();
    expect(result.status).toBe(400);
    expect(result.body.error.message).toContain('查看和执行权限');
    noFacts(f.db);
  });

  it.each(['account-lock', 'role-load', 'personal-grants'] as const)('%s storage failure stays unknown safe503, never an eligible target or a committed task', async variant => {
    const f = setup(), fault = new Error('RAW_STORAGE_FAULT_MARKER SELECT private driver detail');
    if (variant === 'account-lock') {
      const query = f.db.$queryRaw;
      f.db.$queryRaw = async (sql: any) => {
        if (/FROM\s+"UserAccount"/.test(sql.strings.join(' ')) && sql.values[0] === 'QC-FACTORY') throw fault;
        return query(sql);
      };
    } else if (variant === 'role-load') {
      const load = f.db.userAccount.findFirst;
      f.db.userAccount.findFirst = async (args: any) => {
        if (args.where.id === 'QC-FACTORY') throw fault;
        return load(args);
      };
    } else {
      const grants = f.db.userPermissionOverrides.findMany;
      f.db.userPermissionOverrides.findMany = async (args: any) => {
        if (args.where.userId === 'QC-FACTORY') throw fault;
        return grants(args);
      };
    }
    const result = await f.create();
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe('AUTHORIZATION_UNAVAILABLE');
    expect(result.body.error.message).toBe('暂时无法核验执行人员，请稍后重试。');
    expect(JSON.stringify(result.body)).not.toContain('RAW_STORAGE_FAULT_MARKER');
    noFacts(f.db);
  });

  it('visible assignment names use the actual exact-id native projection and expose no unrelated directory fields', async () => {
    const f = setup();
    seedUser(f.db, { id: 'QC-HIDDEN', displayName: 'unrelated-directory-account', email: 'synthetic-private-field' });
    f.target().email = 'synthetic-private-target-field';
    expect((await f.create()).status).toBe(201);
    const reads: any[] = [], find = f.db.userAccount.findMany;
    f.db.userAccount.findMany = async (args: any) => { reads.push(args); return find(args); };
    const result = await request(f.app).get('/api/v1/qc/assignments').set(auth());
    expect(result.status).toBe(200);
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0].qcUser).toEqual({ id: 'QC-FACTORY', displayName: 'QC 甲' });
    expect(reads).toEqual([{ where: { id: { in: ['QC-FACTORY'] }, deletedAt: null }, select: { id: true, displayName: true } }]);
    expect(JSON.stringify(result.body)).not.toContain('synthetic-private');
    expect(JSON.stringify(result.body)).not.toContain('unrelated-directory-account');
  });
});
