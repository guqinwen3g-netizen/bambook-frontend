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

// ════════════════════════════════════════════════════════════════
// 驻地 CRUD
// ════════════════════════════════════════════════════════════════

describe('P0 · QC 驻地 CRUD', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  const createLoc = (app: any, body: Record<string, any>) =>
    request(app).post('/api/v1/qc/locations').set(auth()).send(body);

  it('创建：code 归一小写；缺 code/name → 400；重复 → 400', async () => {
    const app = makeApp(prisma);
    const ok = await createLoc(app, { code: 'WenZhou', name: '温州驻场', focus: 'garment' });
    expect(ok.status).toBe(201);
    expect(ok.body.item.code).toBe('wenzhou');

    expect((await createLoc(app, { name: '苏州驻场' })).status).toBe(400);
    expect((await createLoc(app, { code: 'suzhou' })).status).toBe(400);
    const dup = await createLoc(app, { code: 'WENZHOU', name: '温州二场' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('驻地代码已存在');
  });

  it('更新：code 不可改 → 400；删除：有任务引用 → 400，无引用软删后不列出', async () => {
    const app = makeApp(prisma);
    const wz = (await createLoc(app, { code: 'wenzhou', name: '温州驻场' })).body.item;
    const sz = (await createLoc(app, { code: 'suzhou', name: '苏州驻场' })).body.item;

    const codeChange = await request(app).patch(`/api/v1/qc/locations/${wz.id}`).set(auth()).send({ code: 'other' });
    expect(codeChange.status).toBe(400);

    // 有未删除任务引用 → 禁删
    seedOrder(prisma, { id: 'ORD-L1' });
    seedUser(prisma, { id: 'QC-1' });
    await request(app).post('/api/v1/qc/assignments').set(auth())
      .send({ orderId: 'ORD-L1', inspectionType: 'final', qcUserId: 'QC-1', locationId: wz.id });
    const blocked = await request(app).delete(`/api/v1/qc/locations/${wz.id}`).set(auth());
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toContain('仍有验货任务引用此驻地，不可删除');

    expect((await request(app).delete(`/api/v1/qc/locations/${sz.id}`).set(auth())).status).toBe(200);
    const list = await request(app).get('/api/v1/qc/locations').set(auth());
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].code).toBe('wenzhou');
  });

  // P3-1（2026-09-13 定案）：API-Key 通道不旁路 qc:read——读也要看主体权限。
  // 主体权限来自其绑定账号的角色（auth/agentPrincipal.loadPrincipal，§10.4.1「把 AI 当员工看」），
  // 测试经 setDefaultAgentApiKeyActors 注入（与真实启动装载同通道）。
  const withApiKeyPrincipal = (permissions: string[]) =>
    setDefaultAgentApiKeyActors(new Map([[validApiKey, {
      userId: 'u_agent', displayName: 'QC Agent', roles: ['role-sales'],
      permissions, departmentIds: ['company'],
    }]]));

  it('API-Key 写操作 → 401；读操作按主体权限放行（有 qc:read → 200）', async () => {
    withApiKeyPrincipal(['qc:read']);
    try {
      const app = makeApp(prisma);
      await createLoc(app, { code: 'wenzhou', name: '温州驻场' });
      expect((await request(app).post('/api/v1/qc/locations').set('X-Bambook-API-Key', validApiKey)
        .send({ code: 'suzhou', name: '苏州驻场' })).status).toBe(401);
      expect((await request(app).get('/api/v1/qc/locations').set('X-Bambook-API-Key', validApiKey)).status).toBe(200);
    } finally {
      setDefaultAgentApiKeyActors(new Map());
    }
  });

  it('API-Key 主体无 qc:read → 读操作 403（权限不被旁路）', async () => {
    withApiKeyPrincipal(['orders:read']);
    try {
      const app = makeApp(prisma);
      const res = await request(app).get('/api/v1/qc/locations').set('X-Bambook-API-Key', validApiKey);
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('qc:read');
    } finally {
      setDefaultAgentApiKeyActors(new Map());
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 验货任务：创建校验 + 状态机
// ════════════════════════════════════════════════════════════════

describe('P0 · QC 验货任务', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    seedOrder(prisma, { id: 'ORD-1' });
    seedOrder(prisma, { id: 'ORD-2' });
    seedUser(prisma, { id: 'QC-1' });
    seedUser(prisma, { id: 'QC-2' });
  });

  const createAssignment = (app: any, body: Record<string, any>) =>
    request(app).post('/api/v1/qc/assignments').set(auth()).send(body);

  it('创建校验：订单 404 / 非法类型 400 / QC 人员 404 / 非 active 400 / 驻地 404；factoryRelationId 冗余自订单', async () => {
    const app = makeApp(prisma);
    seedUser(prisma, { id: 'QC-OFF', status: 'disabled' });

    expect((await createAssignment(app, { orderId: 'ORD-NOPE', inspectionType: 'final', qcUserId: 'QC-1' })).status).toBe(404);
    expect((await createAssignment(app, { orderId: 'ORD-1', inspectionType: 'inline', qcUserId: 'QC-1' })).status).toBe(400);
    expect((await createAssignment(app, { orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-NOPE' })).status).toBe(404);
    const inactive = await createAssignment(app, { orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-OFF' });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error.message).toContain('必须是 active');
    expect((await createAssignment(app, { orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-1', locationId: 'QCL__NOPE' })).status).toBe(404);
    expect((await createAssignment(app, { orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-1', dueDate: '2026/08/01' })).status).toBe(400);

    const ok = await createAssignment(app, { orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-1', dueDate: '2026-08-15' });
    expect(ok.status).toBe(201);
    expect(ok.body.item.status).toBe('Assigned');
    expect(ok.body.item.factoryRelationId).toBe('REL-MILL-1');
    expect(ok.body.item.assignedAt).toBeTypeOf('number');
  });

  it('同订单同类型已有进行中任务 → 400；Cancelled 后可再派', async () => {
    const app = makeApp(prisma);
    const first = (await createAssignment(app, { orderId: 'ORD-1', inspectionType: 'midline', qcUserId: 'QC-1' })).body.item;

    const dup = await createAssignment(app, { orderId: 'ORD-1', inspectionType: 'midline', qcUserId: 'QC-2' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('已有进行中任务');

    // 不同类型不受限
    expect((await createAssignment(app, { orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-2' })).status).toBe(201);

    // 取消后可再派同类型
    await request(app).post(`/api/v1/qc/assignments/${first.id}/cancel`).set(auth());
    expect((await createAssignment(app, { orderId: 'ORD-1', inspectionType: 'midline', qcUserId: 'QC-2' })).status).toBe(201);
  });

  it('状态机：start/complete/cancel 合法流转与非法拒绝；report 订单不匹配 400；已完成不可取消', async () => {
    const app = makeApp(prisma);
    prisma._stores.inspectionReports.push({ id: 'INR__ORD-1', orderId: 'ORD-1', inspectionType: 'final' });
    prisma._stores.inspectionReports.push({ id: 'INR__ORD-2', orderId: 'ORD-2', inspectionType: 'final' });

    const a = (await createAssignment(app, { orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-1' })).body.item;

    // start：Assigned → InProgress；重复 start → 400
    const started = await request(app).post(`/api/v1/qc/assignments/${a.id}/start`).set(auth());
    expect(started.status).toBe(200);
    expect(started.body.item.status).toBe('InProgress');
    expect((await request(app).post(`/api/v1/qc/assignments/${a.id}/start`).set(auth())).status).toBe(400);

    // complete：report 订单不匹配 → 400；不存在 → 404
    const mismatch = await request(app).post(`/api/v1/qc/assignments/${a.id}/complete`).set(auth()).send({ reportId: 'INR__ORD-2' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.message).toContain('报告与任务订单不匹配');
    expect((await request(app).post(`/api/v1/qc/assignments/${a.id}/complete`).set(auth()).send({ reportId: 'INR__NOPE' })).status).toBe(404);

    const completed = await request(app).post(`/api/v1/qc/assignments/${a.id}/complete`).set(auth()).send({ reportId: 'INR__ORD-1' });
    expect(completed.status).toBe(200);
    expect(completed.body.item.status).toBe('Completed');
    expect(completed.body.item.reportId).toBe('INR__ORD-1');
    expect(completed.body.item.completedAt).toBeTypeOf('number');

    // Completed 不可取消 / 不可修改
    const cancelCompleted = await request(app).post(`/api/v1/qc/assignments/${a.id}/cancel`).set(auth());
    expect(cancelCompleted.status).toBe(400);
    expect(cancelCompleted.body.error.message).toContain('已完成任务不可取消');
    expect((await request(app).patch(`/api/v1/qc/assignments/${a.id}`).set(auth()).send({ notes: 'x' })).status).toBe(400);

    // cancel：Assigned → Cancelled；Cancelled 不可修改
    const b = (await createAssignment(app, { orderId: 'ORD-2', inspectionType: 'midline', qcUserId: 'QC-2' })).body.item;
    const cancelled = await request(app).post(`/api/v1/qc/assignments/${b.id}/cancel`).set(auth());
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.item.status).toBe('Cancelled');
    expect((await request(app).patch(`/api/v1/qc/assignments/${b.id}`).set(auth()).send({ notes: 'x' })).status).toBe(400);
  });

  it('complete 携带 report 数据 → 自动创建大货报告：final 锚定 INR__{orderId}，midline 锚定 __mid；必填 Int 缺省为 0 非 null', async () => {
    const app = makeApp(prisma);

    // final：report.result 非法 → 400
    const a = (await createAssignment(app, { orderId: 'ORD-2', inspectionType: 'final', qcUserId: 'QC-1' })).body.item;
    const badResult = await request(app).post(`/api/v1/qc/assignments/${a.id}/complete`).set(auth())
      .send({ report: { result: 'conditional' } });
    expect(badResult.status).toBe(400);
    expect(badResult.body.error.message).toContain('result 必须是 pass 或 fail');

    // final 正常路径：仅传必填 result（其余缺省）→ 报告创建 + 锚点 + 必填 Int 默认 0（非 null）
    const completed = await request(app).post(`/api/v1/qc/assignments/${a.id}/complete`).set(auth())
      .send({ report: { result: 'pass' } });
    expect(completed.status).toBe(200);
    expect(completed.body.item.reportId).toBe('INR__ORD-2');
    const finalReport = prisma._stores.inspectionReports.find((r: any) => r.id === 'INR__ORD-2');
    expect(finalReport).toMatchObject({
      orderId: 'ORD-2',
      inspectionType: 'final',
      result: 'pass',
      inspectedBy: 'u1', // Actual management operator, not the assigned inspector.
      totalUnits: 0,
      passedUnits: 0,
      majorDefects: 0,
      minorDefects: 0,
    });

    expect(prisma._stores.audits.find((audit: any) => audit.action === 'complete_assignment')).toMatchObject({ actorId: 'u1', detail: { after: { assignedQcUserId: 'QC-1', actualActorId: 'u1', delegated: true } } });

    // 重复报告防重：预置既有 final 报告（如直插 DB），完成新任务带 report → 400
    seedOrder(prisma, { id: 'ORD-3' });
    prisma._stores.inspectionReports.push({ id: 'INR__ORD-3', orderId: 'ORD-3', inspectionType: 'final' });
    const dupAssignment = (await createAssignment(app, { orderId: 'ORD-3', inspectionType: 'final', qcUserId: 'QC-2' })).body.item;
    const dup = await request(app).post(`/api/v1/qc/assignments/${dupAssignment.id}/complete`).set(auth())
      .send({ report: { result: 'pass' } });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('验货报告已存在');

    // midline：锚点 INR__{orderId}__mid，与 final 锚点不冲突
    const m = (await createAssignment(app, { orderId: 'ORD-2', inspectionType: 'midline', qcUserId: 'QC-1' })).body.item;
    const mid = await request(app).post(`/api/v1/qc/assignments/${m.id}/complete`).set(auth())
      .send({ report: { result: 'fail', totalUnits: 500, passedUnits: 400, majorDefects: 3, minorDefects: 12, aqlLevel: '2.5/4.0 II' } });
    expect(mid.status).toBe(200);
    expect(mid.body.item.reportId).toBe('INR__ORD-2__mid');
    const midReport = prisma._stores.inspectionReports.find((r: any) => r.id === 'INR__ORD-2__mid');
    expect(midReport).toMatchObject({ inspectionType: 'midline', result: 'fail', totalUnits: 500, majorDefects: 3 });
  });

  it('改派 qcUserId 同样校验 UserAccount；列表过滤 + Order 快照 + location include', async () => {
    const app = makeApp(prisma);
    const loc = (await request(app).post('/api/v1/qc/locations').set(auth()).send({ code: 'wenzhou', name: '温州驻场' })).body.item;
    const a = (await createAssignment(app, { orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-1', locationId: loc.id })).body.item;

    const reassignBad = await request(app).patch(`/api/v1/qc/assignments/${a.id}`).set(auth()).send({ qcUserId: 'QC-NOPE' });
    expect(reassignBad.status).toBe(404);
    const reassign = await request(app).patch(`/api/v1/qc/assignments/${a.id}`).set(auth()).send({ qcUserId: 'QC-2', notes: '改派' });
    expect(reassign.status).toBe(200);
    expect(reassign.body.item.qcUserId).toBe('QC-2');

    const list = await request(app).get('/api/v1/qc/assignments?qcUserId=QC-2&status=Assigned').set(auth());
    expect(list.body.total).toBe(1);
    const item = list.body.items[0];
    expect(item.location.code).toBe('wenzhou');
    expect(item.order).toMatchObject({ poNumber: 'PO-1001', customer: 'Acme', product: 'Tee', businessLine: 'garment' });
  });
});

// ════════════════════════════════════════════════════════════════
// QC 工作台
// ════════════════════════════════════════════════════════════════

describe('P0 · QC 工作台', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    seedOrder(prisma, { id: 'ORD-1' });
    seedUser(prisma, { id: 'QC-1' });
    seedUser(prisma, { id: 'QC-2' });
  });

  it('按状态分组；completed 仅近 30 天；qcUserId 过滤', async () => {
    const app = makeApp(prisma);
    const create = (body: Record<string, any>) => request(app).post('/api/v1/qc/assignments').set(auth()).send(body);

    const assigned = (await create({ orderId: 'ORD-1', inspectionType: 'midline', qcUserId: 'QC-1' })).body.item;
    const inProgress = (await create({ orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-1' })).body.item;
    await request(app).post(`/api/v1/qc/assignments/${inProgress.id}/start`).set(auth());

    // 直接造数：QC-2 的近 30 天内已完成 + 40 天前已完成（应被窗口排除）
    const now = Date.now();
    prisma._stores.assignments.push(
      { id: 'QCA__OLD1', orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-2', locationId: null, factoryRelationId: null, status: 'Completed', dueDate: null, assignedAt: BigInt(now - 35 * DAY_MS), assignedById: 'u1', completedAt: BigInt(now - 5 * DAY_MS), reportId: null, notes: null, createdAt: BigInt(now - 35 * DAY_MS), updatedAt: BigInt(now - 5 * DAY_MS), deletedAt: null },
      { id: 'QCA__OLD2', orderId: 'ORD-1', inspectionType: 'midline', qcUserId: 'QC-2', locationId: null, factoryRelationId: null, status: 'Completed', dueDate: null, assignedAt: BigInt(now - 60 * DAY_MS), assignedById: 'u1', completedAt: BigInt(now - 40 * DAY_MS), reportId: null, notes: null, createdAt: BigInt(now - 60 * DAY_MS), updatedAt: BigInt(now - 40 * DAY_MS), deletedAt: null },
    );

    const wb = await request(app).get('/api/v1/qc/workbench?qcUserId=QC-1').set(auth());
    expect(wb.body.assigned.map((a: any) => a.id)).toEqual([assigned.id]);
    expect(wb.body.inProgress.map((a: any) => a.id)).toEqual([inProgress.id]);
    expect(wb.body.completed).toEqual([]);
    expect(wb.body.assigned[0].order.poNumber).toBe('PO-1001');

    const wb2 = await request(app).get('/api/v1/qc/workbench?qcUserId=QC-2').set(auth());
    expect(wb2.body.assigned).toEqual([]);
    expect(wb2.body.completed.map((a: any) => a.id)).toEqual(['QCA__OLD1']); // 40 天前的被排除

    // 不传 qcUserId → 全部分组
    const wbAll = await request(app).get('/api/v1/qc/workbench').set(auth());
    expect(wbAll.body.assigned.length).toBe(1);
    expect(wbAll.body.inProgress.length).toBe(1);
    expect(wbAll.body.completed.length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════
// P2 · 验货报告台账（GET /reports 全局分页列表，质量复盘入口）
// ════════════════════════════════════════════════════════════════

describe('P2 · 验货报告台账 GET /reports', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    seedOrder(prisma, { id: 'ORD-1', poNumber: 'PO-1001' });
    seedOrder(prisma, { id: 'ORD-2', poNumber: 'PO-1002' });
    prisma._stores.inspectionReports.push(
      { id: 'INR__ORD-1', orderId: 'ORD-1', inspectionType: 'final', result: 'pass', totalUnits: 100, passedUnits: 98, criticalDefects: 0, majorDefects: 1, minorDefects: 2, defectSummary: null, inspectedBy: 'QC-1', createdAt: 1000n, updatedAt: 1000n },
      { id: 'INR__ORD-1__midline', orderId: 'ORD-1', inspectionType: 'midline', result: 'conditional', totalUnits: 100, passedUnits: 95, criticalDefects: 0, majorDefects: 3, minorDefects: 5, defectSummary: null, inspectedBy: 'QC-1', createdAt: 2000n, updatedAt: 2000n },
      { id: 'INR__ORD-2', orderId: 'ORD-2', inspectionType: 'final', result: 'fail', totalUnits: 100, passedUnits: 80, criticalDefects: 1, majorDefects: 5, minorDefects: 10, defectSummary: '色差', inspectedBy: 'QC-2', createdAt: 3000n, updatedAt: 3000n },
    );
  });

  it('全局列表：createdAt 倒序 + 订单快照（poNumber/customer）+ total', async () => {
    const app = makeApp(prisma);
    const res = await request(app).get('/api/v1/qc/reports').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items.map((r: any) => r.id)).toEqual(['INR__ORD-2', 'INR__ORD-1__midline', 'INR__ORD-1']);
    expect(res.body.items[0].order.poNumber).toBe('PO-1002');
    expect(res.body.items[2].order.customer).toBe('Acme');
  });

  it('inspectionType 筛选 + 分页（limit/offset）', async () => {
    const app = makeApp(prisma);
    const finals = await request(app).get('/api/v1/qc/reports?inspectionType=final').set(auth());
    expect(finals.body.total).toBe(2);
    expect(finals.body.items.every((r: any) => r.inspectionType === 'final')).toBe(true);

    const page = await request(app).get('/api/v1/qc/reports?limit=2&offset=2').set(auth());
    expect(page.body.total).toBe(3);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0].id).toBe('INR__ORD-1');
  });

  it('orderId 筛选（软删父单不再暴露报告，历史事实保留）', async () => {
    prisma._stores.orders[0].deletedAt = 1n;
    const app = makeApp(prisma);
    const res = await request(app).get('/api/v1/qc/reports?orderId=ORD-1').set(auth());
    // Explicit contract migration: old total=2/order=null exposed deleted-parent
    // reports in the ordinary business list. No archive authority is implied.
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
    const before = structuredClone(prisma._stores.inspectionReports);
    const detail = await request(app).get('/api/v1/qc/reports/INR__ORD-1').set(auth());
    expect(detail.status).toBe(404);
    const sign = await request(app).post('/api/v1/qc/reports/INR__ORD-1/sign').set(auth()).send({ role: 'qc', delegationReason: '历史报告试读' });
    expect(sign.status).toBe(404);
    const generated = await request(app).post('/api/v1/qc/reports/INR__ORD-1/generate-document').set(auth());
    expect(generated.status).toBe(404);
    expect(prisma._stores.inspectionReports).toEqual(before);
  });
});

// ════════════════════════════════════════════════════════════════
// S3-δ · 驻地/验货任务写端点 qc:write scope 门禁
//   修复前仅 requireWrite（JWT）单闸；修复后与 sign/test-requests 一致
//   requireWrite + requirePermission('qc:write') 双闸
// ════════════════════════════════════════════════════════════════

describe('S3-δ · QC 写端点 qc:write scope 门禁', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    seedOrder(prisma, { id: 'ORD-1' });
    seedUser(prisma, { id: 'QC-1' });
  });

  const finAuth = () => ({ Cookie: `bambook_token=${financeToken}` });
  const qcAuth = () => ({ Cookie: `bambook_token=${qcToken}` });

  it('未持 qc:write 角色（finance）写 locations 三端点 → 403 FORBIDDEN', async () => {
    const app = makeApp(prisma);
    prisma._stores.locations.push({ id: 'QCL__X', code: 'wenzhou', name: '温州驻场', region: null, focus: null, address: null, notes: null, deletedAt: null });

    const create = await request(app).post('/api/v1/qc/locations').set(finAuth()).send({ code: 'suzhou', name: '苏州驻场' });
    expect(create.status).toBe(403);
    expect(create.body.error).toBe('FORBIDDEN');
    expect(create.body.message).toContain('qc:write');

    const update = await request(app).patch('/api/v1/qc/locations/QCL__X').set(finAuth()).send({ name: '改名' });
    expect(update.status).toBe(403);

    const del = await request(app).delete('/api/v1/qc/locations/QCL__X').set(finAuth());
    expect(del.status).toBe(403);

    // 读端点不受写 scope 影响（finance 持 qc:read，仅验证不被 403 拦截到写闸）
    const list = await request(app).get('/api/v1/qc/locations').set(finAuth());
    expect(list.status).toBe(200);
  });

  it('未持 qc:write 角色（finance）写 assignments 系列（建单/状态机） → 403', async () => {
    const app = makeApp(prisma);
    prisma._stores.assignments.push({
      id: 'QCA__X', orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-1', locationId: null,
      factoryRelationId: null, status: 'Assigned', dueDate: null, assignedAt: BigInt(Date.now()),
      assignedById: 'u1', completedAt: null, reportId: null, notes: null, deletedAt: null,
    });

    const create = await request(app).post('/api/v1/qc/assignments').set(finAuth())
      .send({ orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-1' });
    expect(create.status).toBe(403);
    expect(create.body.error).toBe('FORBIDDEN');

    const start = await request(app).post('/api/v1/qc/assignments/QCA__X/start').set(finAuth());
    expect(start.status).toBe(403);

    const update = await request(app).patch('/api/v1/qc/assignments/QCA__X').set(finAuth()).send({ notes: 'x' });
    expect(update.status).toBe(403);

    const del = await request(app).delete('/api/v1/qc/assignments/QCA__X').set(finAuth());
    expect(del.status).toBe(403);
  });

  it('QC 角色（permissions 含 qc:write）→ 过门禁到业务校验：合法建单 201 / 缺 name 400', async () => {
    const app = makeApp(prisma);

    const ok = await request(app).post('/api/v1/qc/locations').set(qcAuth()).send({ code: 'WenZhou', name: '温州驻场' });
    expect(ok.status).toBe(201);
    expect(ok.body.item.code).toBe('wenzhou');

    // 过门禁后落到业务校验（缺 name → 400 而非 403）
    const bad = await request(app).post('/api/v1/qc/locations').set(qcAuth()).send({ code: 'suzhou' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('QC_LOCATION_CREATE_FAILED');

    // assignments 建单同样过闸到业务（201）
    const created = await request(app).post('/api/v1/qc/assignments').set(qcAuth())
      .send({ orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'u_qc' });
    expect(created.status).toBe(201);
    expect(created.body.item.status).toBe('Assigned');

    // 状态机端点过闸（start → 200）
    const started = await request(app).post(`/api/v1/qc/assignments/${created.body.item.id}/start`).set(qcAuth());
    expect(started.status).toBe(200);
    expect(started.body.item.status).toBe('InProgress');
  });

  it('current qc:write does not permit inspecting another current assignee; no mutation or audit', async () => {
    const app = makeApp(prisma);
    const created = await request(app).post('/api/v1/qc/assignments').set(auth())
      .send({ orderId: 'ORD-1', inspectionType: 'final', qcUserId: 'QC-1' });
    const before = structuredClone({ rows: prisma._stores.assignments, audits: prisma._stores.audits });
    for (const action of ['start', 'complete']) {
      const response = await request(app).post(`/api/v1/qc/assignments/${created.body.item.id}/${action}`).set(qcAuth())
        .send(action === 'complete' ? { report: { result: 'pass' } } : {});
      expect(response.status).toBe(403);
    }
    expect({ rows: prisma._stores.assignments, audits: prisma._stores.audits }).toEqual(before);
    expect(prisma._stores.inspectionReports).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// REQ2-04 安全收口：测试报告 PDF 落盘私有根（不进 /api/uploads 静态服务），
// 下载只走 qc:read 门 + 私有根优先、旧静态根兜底回读
// ═══════════════════════════════════════════════════════════════
describe('REQ2-04 · 测试报告私有落盘 + 双根回读', () => {
  let prisma: any;
  let privateDir: string;
  let legacyDir: string;

  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._stores.testRequests.push({
      id: 'TR__X1', trNo: 'TR-20260901-001', orderId: 'ORD-1', testItems: ['ph'], agency: 'sgs',
      result: 'pending', failItems: [], deletedAt: null,
    });
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-qc-private-'));
    legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-qc-legacy-'));
  });
  afterEach(() => {
    fs.rmSync(privateDir, { recursive: true, force: true });
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });

  function makeAppWithDirs() {
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
    app.use('/api/v1/qc', createQcRouter({
      prisma, requireAuth: true, apiKeys,
      privateFilesDir: privateDir, uploadDir: legacyDir,
    }));
    return app;
  }

  it('上传 PDF → 落盘私有根 test-reports/{id}/，不落在旧静态根', async () => {
    const app = makeAppWithDirs();
    const res = await request(app).post('/api/v1/qc/test-requests/TR__X1/files').set(auth())
      .attach('files', Buffer.from('%PDF-1.4 private-store'), 'sgs.pdf');
    expect(res.status).toBe(201);
    expect(res.body.files).toHaveLength(1);

    const row = prisma._stores.testReportFiles[0];
    expect(row.filePath.startsWith(path.join('test-reports', 'TR__X1'))).toBe(true);
    expect(fs.existsSync(path.join(privateDir, row.filePath))).toBe(true);
    expect(fs.existsSync(path.join(legacyDir, row.filePath))).toBe(false);
  });

  it('下载：私有根命中 → 200 返回文件内容', async () => {
    prisma._stores.testReportFiles.push({
      id: 'TRF__P1', testRequestId: 'TR__X1',
      filePath: path.join('test-reports', 'TR__X1', 'a.pdf'), fileName: 'SGS.pdf', deletedAt: null,
    });
    fs.mkdirSync(path.join(privateDir, 'test-reports', 'TR__X1'), { recursive: true });
    fs.writeFileSync(path.join(privateDir, 'test-reports', 'TR__X1', 'a.pdf'), '%PDF-1.4 private-hit');

    const res = await request(makeAppWithDirs()).get('/api/v1/qc/test-requests/TR__X1/files/TRF__P1').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain('private-hit');
  });

  it('下载：私有根缺失 → 回退旧静态根（迁移前存量文件）→ 200', async () => {
    prisma._stores.testReportFiles.push({
      id: 'TRF__L1', testRequestId: 'TR__X1',
      filePath: path.join('test-reports', 'TR__X1', 'legacy.pdf'), fileName: '存量报告.pdf', deletedAt: null,
    });
    fs.mkdirSync(path.join(legacyDir, 'test-reports', 'TR__X1'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'test-reports', 'TR__X1', 'legacy.pdf'), '%PDF-1.4 legacy-hit');

    const res = await request(makeAppWithDirs()).get('/api/v1/qc/test-requests/TR__X1/files/TRF__L1').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain('legacy-hit');
  });

  it('下载：两根均无文件 → 404 FILE_MISSING', async () => {
    prisma._stores.testReportFiles.push({
      id: 'TRF__M1', testRequestId: 'TR__X1',
      filePath: path.join('test-reports', 'TR__X1', 'gone.pdf'), fileName: '丢失.pdf', deletedAt: null,
    });
    const res = await request(makeAppWithDirs()).get('/api/v1/qc/test-requests/TR__X1/files/TRF__M1').set(auth());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FILE_MISSING');
  });
});

// ════════════════════════════════════════════════════════════════════
// 幅宽实测（2026-09-29 晚）—— QC 查货时登记，窄幅索赔的输入事实
// ════════════════════════════════════════════════════════════════════

describe('幅宽实测 — 完成验货时登记（★ 使用方口径：我们自己的 QC 在查货过程里记）', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    seedOrder(prisma, { id: 'ORD-W1' });
    seedOrder(prisma, { id: 'ORD-W2' });
    seedOrder(prisma, { id: 'ORD-W3' });
    seedUser(prisma, { id: 'QC-1' });
  });

  it('★★ 携带 widthMeasurements ⇒ 与报告同一事务落库', async () => {
    prisma._stores.orderLines.push(
      { id: 'OL-1', orderId: 'ORD-W1' },
      { id: 'OL-2', orderId: 'ORD-W1' },
    );
    const app = makeApp(prisma);
    const a = await request(app).post('/api/v1/qc/assignments').set(auth()).send({
      orderId: 'ORD-W1', inspectionType: 'final', qcUserId: 'QC-1',
    });
    const res = await request(app).post(`/api/v1/qc/assignments/${a.body.item.id}/complete`).set(auth()).send({
      report: {
        result: 'pass', totalUnits: 100, passedUnits: 100,
        widthMeasurements: [
          { orderLineId: 'OL-1', measuredWidthCm: 141.12, basisWidthCm: 147, note: '第一支布' },
          { orderLineId: 'OL-2', measuredWidthCm: 147, basisWidthCm: 147 },
        ],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = prisma._stores.widthMeasurements;
    expect(rows).toHaveLength(2);
    expect(rows[0].orderLineId).toBe('OL-1');
    expect(rows[0].basisWidthCm).toBe(147);
    expect(rows[0].note).toBe('第一支布');
    expect(String(rows[0].id).startsWith('IWM__'), 'id 前缀与仓内约定一致').toBe(true);
    expect(rows[0].reportId).toBe('INR__ORD-W1');
  });

  it('★★ 订单行不属于本订单 ⇒ 拒绝，且**一个字都不落库**（报告也不建）', async () => {
    prisma._stores.orderLines.push({ id: 'OL-OTHER', orderId: 'ORD-OTHER' });
    const app = makeApp(prisma);
    const a = await request(app).post('/api/v1/qc/assignments').set(auth()).send({
      orderId: 'ORD-W2', inspectionType: 'final', qcUserId: 'QC-1',
    });
    const res = await request(app).post(`/api/v1/qc/assignments/${a.body.item.id}/complete`).set(auth()).send({
      report: { result: 'pass', widthMeasurements: [{ orderLineId: 'OL-OTHER', measuredWidthCm: 141, basisWidthCm: 147 }] },
    });
    expect(res.status).not.toBe(200);
    expect(prisma._stores.widthMeasurements).toHaveLength(0);
    expect(prisma._stores.inspectionReports, '★ 坏数据不该留下半截报告（重试会撞"报告已存在"）').toHaveLength(0);
  });

  it('★ 缺基准幅宽 / 实测 ≤ 0 / 同一行重复 ⇒ 拒绝（不猜、不覆盖）', async () => {
    prisma._stores.orderLines.push({ id: 'OL-1', orderId: 'ORD-W3' });
    const app = makeApp(prisma);
    const a = await request(app).post('/api/v1/qc/assignments').set(auth()).send({
      orderId: 'ORD-W3', inspectionType: 'final', qcUserId: 'QC-1',
    });
    const bad = [
      [{ orderLineId: 'OL-1', measuredWidthCm: 141 }],                                     // 缺基准
      [{ orderLineId: 'OL-1', measuredWidthCm: 141, basisWidthCm: 0 }],                     // 基准 0
      [{ orderLineId: 'OL-1', measuredWidthCm: 0, basisWidthCm: 147 }],                     // 实测 0
      [{ orderLineId: 'OL-1', measuredWidthCm: 141, basisWidthCm: 147 }, { orderLineId: 'OL-1', measuredWidthCm: 142, basisWidthCm: 147 }], // 重复行
    ];
    for (const widthMeasurements of bad) {
      const res = await request(app).post(`/api/v1/qc/assignments/${a.body.item.id}/complete`).set(auth()).send({
        report: { result: 'pass', widthMeasurements },
      });
      expect(res.status, JSON.stringify(widthMeasurements)).not.toBe(200);
    }
    expect(prisma._stores.widthMeasurements).toHaveLength(0);
    expect(prisma._stores.inspectionReports).toHaveLength(0);
  });
});
