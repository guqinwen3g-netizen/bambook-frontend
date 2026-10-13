/**
 * DR-029 服装/面料样品 QC 双链 + DR-014 出运资格 + DR-027 开发样排除 + 双签 路由测试
 *
 * 验收场景映射：
 *   - QC-29-B3  链路由/权限隔离          → describe「路由隔离与链边界」
 *   - QC-29-A1  服装链非二值评审          → 「服装链评审」
 *   - QC-29-A3 / QC-008-C1 寄送门禁      → 「寄送门禁」
 *   - QC-29-A4  直接打回工厂重做          → 「直接打回」
 *   - QC-29-B2 / REL-14-A5 面料链评审    → 「面料链评审」
 *   - REL-14-A1 每轮独立报告不可覆盖      → 「同轮重复提交 → 409」
 *   - DR-027 / QC-29-B1 开发样排除       → 「开发样排除」
 *   - QC-014-C2 出运三条件并行           → 「DR-014 出运资格」
 *   - 质量门禁 §9.3-② 双签               → 「signatures 双签」
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createQcRouter } from '../qcRoute';
import { createQcService } from '../qcService';
import { logger } from '../../lib/logger';

// roles 仅作 legacy fallback；链 scope 走 permissions 数组直查
const ownerToken = jwt.sign({ userId: 'u-owner', roles: ['owner'], permissions: [], departmentIds: [] }, SECRET);
const garmentQcToken = jwt.sign(
  { userId: 'QC-G1', roles: ['sales'], permissions: ['qc:read', 'qc:inspect', 'qc:garment_chain:write'], departmentIds: [] },
  SECRET,
);
const fabricQcToken = jwt.sign(
  { userId: 'QC-F1', roles: ['sales'], permissions: ['qc:read', 'qc:inspect', 'qc:fabric_chain:write'], departmentIds: [] },
  SECRET,
);
const salesToken = jwt.sign({ userId: 'SALES-1', roles: ['sales'], permissions: ['qc:read'], departmentIds: [] }, SECRET);
const businessSignerToken = jwt.sign({ userId: 'SALES-1', roles: ['sales'], permissions: ['qc:read', 'qc:write'], authorizationLoaded: true, departmentIds: [] }, SECRET);
const financeToken = jwt.sign({ userId: 'FIN-1', roles: ['finance'], permissions: ['qc:read'], departmentIds: [] }, SECRET);

const asOwner = () => ({ Cookie: `bambook_token=${ownerToken}` });
const asGarmentQc = () => ({ Cookie: `bambook_token=${garmentQcToken}` });
const asFabricQc = () => ({ Cookie: `bambook_token=${fabricQcToken}` });
const asSales = () => ({ Cookie: `bambook_token=${salesToken}` });
const asFinance = () => ({ Cookie: `bambook_token=${financeToken}` });

// ────────────────────────────────────────────────────────────────
// Mock Prisma（语义对齐本测试用到的 client 子集 + $transaction 直通）
// ────────────────────────────────────────────────────────────────
function makeMockPrisma() {
  const orders: any[] = [];
  const inspectionReports: any[] = [];
  const productionBatches: any[] = [];
  // DR-054 阶段 G：大货生产样统一 Sample（ship/head/pioneer）挂 sourceOrderId
  const samples: any[] = [];
  const departments: any[] = [];
  const auditLogs: any[] = [];
  const notifications: any[] = [];
  const assignments: any[] = [], relations: any[] = [];
  const authUser = (id: string, roleId: string, scopes: string[]) => ({ id, displayName: id, status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId, departmentId: null, role: { id: roleId, permissions: scopes.map(scope => ({ permission: { scope } })) } }] });
  // Current persisted grants, not the token's old role label, certify report access.
  const userAccounts = [authUser('u-owner', 'owner', ['qc:read', 'qc:write', 'qc:inspect', 'qc:garment_chain:write', 'qc:fabric_chain:write']),
    authUser('QC-G1', 'role-qc', ['qc:read', 'qc:inspect', 'qc:garment_chain:write']),
    authUser('QC-F1', 'role-qc', ['qc:read', 'qc:inspect', 'qc:fabric_chain:write']),
    authUser('SALES-1', 'role-sales', ['qc:read', 'qc:write']),
    authUser('FIN-1', 'role-finance', ['qc:read']), authUser('MGR-1', 'role-sales-manager', ['qc:read', 'qc:write'])];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'AND') return (v as any[]).every(sub => matchWhere(row, sub));
      if (k === 'OR') return (v as any[]).some(sub => matchWhere(row, sub));
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('has' in cond) return Array.isArray(row[k]) && row[k].includes(cond.has);
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

  const projectUserAccount = (row: any, select: any): any => {
    if (!select) return row;
    return Object.fromEntries(Object.entries(select).map(([field, selected]: [string, any]) => {
      const value = row[field];
      if (selected === true) return [field, value];
      if (!selected?.select) throw new Error(`unsupported current-account projection ${field}`);
      return [field, Array.isArray(value)
        ? value.map(item => projectUserAccount(item, selected.select))
        : value == null ? value : projectUserAccount(value, selected.select)];
    }));
  };

  const client: any = {
    order: {
      findUnique: async ({ where }: any) => orders.find(o => o.id === where.id) || null,
      findFirst: async ({ where }: any) => orders.find(o => matchWhere(o, where)) || null,
      findMany: async ({ where }: any = {}) => orders.filter(o => matchWhere(o, where)),
    },
    productionBatch: { count: async ({ where }: any = {}) => productionBatches.filter(row => matchWhere(row, where)).length },
    inspectionReport: {
      findUnique: async ({ where }: any) => inspectionReports.find(r => r.id === where.id) || null,
      findFirst: async ({ where }: any) => inspectionReports.find(r => matchWhere(r, where)) || null,
      findMany: async ({ where, orderBy }: any = {}) =>
        applyOrderBy(inspectionReports.filter(r => matchWhere(r, where)), orderBy),
      create: async ({ data }: any) => {
        const row = { ...data };
        inspectionReports.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = inspectionReports.find(r => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
    orderSampleSource: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) },
    sample: {
      findFirst: async ({ where }: any = {}) => samples.find(s => matchWhere(s, where)) || null,
      findMany: async ({ where, orderBy }: any = {}) =>
        applyOrderBy(samples.filter(s => matchWhere(s, where)), orderBy),
      update: async ({ where, data }: any) => {
        const row = samples.find(s => s.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        auditLogs.push(data);
        return data;
      },
    },
    department: {
      findUnique: async ({ where }: any) => departments.find(d => d.id === where.id) || null,
    },
    notificationPreference: {
      findMany: async () => [],
    },
    notification: {
      create: async ({ data }: any) => {
        const row = { ...data };
        notifications.push(row);
        return row;
      },
    },
    userAccount: {
      findFirst: async ({ where }: any) => userAccounts.find(u => matchWhere(u, where)) || null,
      findUnique: async ({ where, select }: any) => {
        const user = userAccounts.find(u => matchWhere(u, where));
        return user ? projectUserAccount(user, select) : null;
      },
    },
    userPermissionOverrides: { findMany: async () => [] },
    relation: { findMany: async ({ where }: any) => relations.filter(r => matchWhere(r, where)) },
    teamMember: { findMany: async () => [] },
    qCAssignment: { findMany: async ({ where }: any) => assignments.filter(r => matchWhere(r, where)) },
    $queryRaw: async (query: any) => {
      const rows = query.strings.join(' ').includes('"InspectionReport"') ? inspectionReports : orders;
      return rows.filter(r => r.id === query.values[0]).map(r => ({ id: r.id }));
    },
    $transaction: async (fn: any) => {
      const stores = [orders, inspectionReports, samples, departments, auditLogs, notifications];
      const before = stores.map(rows => structuredClone(rows));
      try { return await fn(client); } catch (error) { stores.forEach((rows, i) => rows.splice(0, rows.length, ...before[i])); throw error; }
    },
    _stores: { orders, inspectionReports, samples, departments, auditLogs, notifications, userAccounts, relations, assignments, productionBatches },
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

// ────────────────────────────────────────────────────────────────
// 种子辅助
// ────────────────────────────────────────────────────────────────
function seedGarmentOrder(prisma: any, over: Record<string, any> = {}) {
  const row = {
    id: over.id ?? 'ORD-G1',
    poNumber: 'PO-G-1001',
    customer: 'Acme',
    product: 'Tee',
    status: 'InProduction',
    businessLine: 'garment',
    type: 'Garment',
    ownerId: 'SALES-1',
    departmentId: 'DEPT-1',
    customerRelationId: 'CUSTOMER-G1',
    deletedAt: null,
    ...over,
  };
  prisma._stores.relations.push({ id: row.customerRelationId, deletedAt: null, ownerId: 'SALES-1', salesRepIds: ['QC-G1', 'MGR-1'] });
  prisma._stores.orders.push(row);
  return row;
}

function seedFabricOrder(prisma: any, over: Record<string, any> = {}) {
  const row = {
    id: over.id ?? 'ORD-F1',
    poNumber: 'PO-F-1001',
    customer: 'Acme',
    product: 'Cotton Poplin',
    status: 'InProduction',
    businessLine: 'fabric',
    type: 'Fabric',
    ownerId: 'SALES-1',
    customerRelationId: `CUSTOMER-${over.id ?? 'ORD-F1'}`,
    fabricSampleSentDate: null,
    fabricSampleConfirmedDate: null,
    deletedAt: null,
    ...over,
  };
  prisma._stores.relations.push({ id: row.customerRelationId, deletedAt: null, ownerId: row.ownerId, salesRepIds: [] });
  prisma._stores.orders.push(row);
  return row;
}

// DR-054 阶段 G：船样统一 Sample(type='ship') 挂 sourceOrderId
function seedSsSample(prisma: any, over: Record<string, any> = {}) {
  const row = {
    id: over.id ?? 'SMP-SS-1',
    code: 'SMP-20260801-001',
    type: 'ship',
    sourceOrderId: 'ORD-F1',
    customerStatus: 'pending',
    customerFeedbackDate: null,
    qcInspectionReportId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    deletedAt: null,
    ...over,
  };
  prisma._stores.samples.push(row);
  return row;
}

const GARMENT_REVIEW_BODY = {
  sampleLevel: 'pp',
  round: 1,
  conclusion: 'pass',
  opinion: '左右袖长度差 0.5cm，需修正后可寄客户',
  criticalDefects: 0,
  majorDefects: 1,
  minorDefects: 3,
  defectSummary: '跳线x3',
  evidence: ['ev-photo-1', 'ev-photo-2'],
  inspectionDate: '2026-08-10',
};

// ════════════════════════════════════════════════════════════════
// QC-29-B3 路由隔离与链边界（4 维独立中的路由 + 权限校验两维）
// ════════════════════════════════════════════════════════════════
describe('DR-029 · 路由隔离与链边界（QC-29-B3）', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    seedGarmentOrder(prisma);
    seedFabricOrder(prisma);
  });

  it('链写端点：无链 scope（业务员）→ 403 INSUFFICIENT_SCOPE；跨链 scope → 403', async () => {
    const app = makeApp(prisma);
    // 业务员（仅 qc:read，fallback SALES 矩阵也无链写 scope）→ 服装链 403
    const salesRes = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asSales())
      .send(GARMENT_REVIEW_BODY);
    expect(salesRes.status).toBe(403);
    expect(salesRes.body.message ?? salesRes.body.error?.message ?? '').toContain('INSUFFICIENT_SCOPE');

    // 面料 scope 调服装端点 → 403
    const crossRes = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asFabricQc())
      .send(GARMENT_REVIEW_BODY);
    expect(crossRes.status).toBe(403);

    // 服装 scope 调面料端点 → 403
    const crossRes2 = await request(app)
      .post('/api/v1/qc/chain/fabric/ORD-F1/review')
      .set(asGarmentQc())
      .send({ sampleKind: 'SS', sampleId: 'SMP-SS-1', conclusion: 'pass', opinion: 'x' });
    expect(crossRes2.status).toBe(403);
  });

  it('链写端点：API key 通道 → 401（写 scope 强制 JWT）；无 token → 401', async () => {
    const app = makeApp(prisma);
    const apiKeyRes = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set('X-Bambook-API-Key', validApiKey)
      .send(GARMENT_REVIEW_BODY);
    expect(apiKeyRes.status).toBe(401);

    const noAuthRes = await request(app)
      .post('/api/v1/qc/chain/fabric/ORD-F1/review')
      .send({ sampleKind: 'SS', sampleId: 'SMP-SS-1', conclusion: 'pass', opinion: 'x' });
    expect(noAuthRes.status).toBe(401);
  });

  it('服务层链别校验：服装端点打面料订单 → 400 INVALID_CHAIN_SCOPE；面料端点打服装订单同理', async () => {
    const app = makeApp(prisma);
    const wrongChain = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-F1/review')
      .set(asGarmentQc())
      .send(GARMENT_REVIEW_BODY);
    expect(wrongChain.status).toBe(400);
    expect(wrongChain.body.error.code).toBe('INVALID_CHAIN_SCOPE');

    seedSsSample(prisma, { id: 'SMP-SS-X', sourceOrderId: 'ORD-G1' });
    const wrongChain2 = await request(app)
      .post('/api/v1/qc/chain/fabric/ORD-G1/review')
      .set(asFabricQc())
      .send({ sampleKind: 'SS', sampleId: 'SMP-SS-X', conclusion: 'pass', opinion: 'x' });
    expect(wrongChain2.status).toBe(400);
    expect(wrongChain2.body.error.code).toBe('INVALID_CHAIN_SCOPE');
  });
});

// ════════════════════════════════════════════════════════════════
// 服装链评审（QC-29-A1 非二值评审 / REL-14-A1 每轮独立 / DR-027 开发样排除）
// ════════════════════════════════════════════════════════════════
describe('DR-029 · 服装链评审（QC-29-A1 / REL-14-A1 / DR-027）', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    seedGarmentOrder(prisma);
  });

  it('QC-29-A1：PP 评审落库非二值字段（文本意见 + 三级疵点 + 证据 + chain 元数据）→ 201', async () => {
    const app = makeApp(prisma);
    const res = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asGarmentQc())
      .send(GARMENT_REVIEW_BODY);
    expect(res.status).toBe(201);
    const report = res.body.report;
    expect(report.id).toBe('INR__ORD-G1__smp__pp__r1');
    expect(report.inspectionType).toBe('sample_pp__r1');
    expect(report.result).toBe('pass');
    // 非压缩二值：文本意见 + 三级疵点 + 证据引用完整保留
    expect(report.notes).toBe(GARMENT_REVIEW_BODY.opinion);
    expect(report.criticalDefects).toBe(0);
    expect(report.majorDefects).toBe(1);
    expect(report.minorDefects).toBe(3);
    expect(report.defectSummary).toBe('跳线x3');
    expect(report.signatures.chain).toMatchObject({
      chain: 'garment',
      sampleLevel: 'pp',
      round: 1,
      disposition: 'STANDARD',
      qcReviewerId: 'QC-G1',
      evidence: ['ev-photo-1', 'ev-photo-2'],
    });
    // gate 一并返回：该轮已评审且通过
    expect(res.body.gate).toMatchObject({ reviewed: true, passed: true, blockedCode: null });
    // 审计留痕
    expect(prisma._stores.auditLogs.some((l: any) => l.action === 'garment_sample_review' && l.targetId === report.id)).toBe(true);
  });

  it('评审输入校验：缺 opinion → 400；非法疵点计数 → 400；非法 round → 400', async () => {
    const app = makeApp(prisma);
    const noOpinion = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asGarmentQc())
      .send({ ...GARMENT_REVIEW_BODY, opinion: '' });
    expect(noOpinion.status).toBe(400);
    expect(noOpinion.body.error.message).toContain('opinion');

    const badDefects = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asGarmentQc())
      .send({ ...GARMENT_REVIEW_BODY, majorDefects: -1 });
    expect(badDefects.status).toBe(400);

    const badRound = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asGarmentQc())
      .send({ ...GARMENT_REVIEW_BODY, round: 0 });
    expect(badRound.status).toBe(400);
  });

  it('DR-027：开发样级别（fit / confirmation）不进入 QC 门禁 → 400 DEV_SAMPLE_EXCLUDED', async () => {
    const app = makeApp(prisma);
    for (const level of ['fit', 'confirmation', 'FIT-Sample']) {
      const res = await request(app)
        .post('/api/v1/qc/chain/garment/ORD-G1/review')
        .set(asGarmentQc())
        .send({ ...GARMENT_REVIEW_BODY, sampleLevel: level });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DEV_SAMPLE_EXCLUDED');
    }
    // 服务直测：开发样类型归一化判定
    const svc = createQcService(prisma);
    expect(svc.shouldExcludeFromQc('handloom')).toBe(true);
    expect(svc.shouldExcludeFromQc('Lab Dip')).toBe(true);
    expect(svc.shouldExcludeFromQc('strike-off')).toBe(true);
    expect(svc.shouldExcludeFromQc('pp')).toBe(false);
    expect(svc.shouldExcludeFromQc('top')).toBe(false);
    expect(svc.shouldExcludeFromQc(null)).toBe(false);
  });

  it('REL-14-A1：同轮重复提交 → 409 ROUND_ALREADY_REVIEWED；新一轮 round=2 → 独立报告并存', async () => {
    const app = makeApp(prisma);
    const r1 = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asGarmentQc())
      .send(GARMENT_REVIEW_BODY);
    expect(r1.status).toBe(201);

    const dup = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asGarmentQc())
      .send(GARMENT_REVIEW_BODY);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ROUND_ALREADY_REVIEWED');

    const r2 = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asGarmentQc())
      .send({ ...GARMENT_REVIEW_BODY, round: 2, conclusion: 'fail', opinion: '第 2 轮袖长仍偏差' });
    expect(r2.status).toBe(201);
    expect(r2.body.report.id).toBe('INR__ORD-G1__smp__pp__r2');
    expect(r2.body.report.inspectionType).toBe('sample_pp__r2');

    // 两条独立报告并存，Round 1 未被覆盖
    const reports = prisma._stores.inspectionReports.filter((r: any) => r.orderId === 'ORD-G1');
    expect(reports).toHaveLength(2);
    expect(reports.find((r: any) => r.id === 'INR__ORD-G1__smp__pp__r1').result).toBe('pass');
  });
});

// ════════════════════════════════════════════════════════════════
// 寄送门禁（DR-008 / QC-008-C1 / QC-29-A3：fail-closed 三态）
// ════════════════════════════════════════════════════════════════
describe('DR-008 · 服装样品寄送门禁（QC-008-C1 / QC-29-A3）', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    seedGarmentOrder(prisma);
  });

  it('无报告 → RE_INSPECTION_REQUIRED；fail → SAMPLE_QC_GATE_NOT_PASSED；pass → 放行', async () => {
    const app = makeApp(prisma);
    // QC-29-A3：新一轮未评审 → 拦截
    const noReport = await request(app)
      .get('/api/v1/qc/chain/garment/ORD-G1/gate?sampleLevel=pp&round=1')
      .set(asSales());
    expect(noReport.status).toBe(200);
    expect(noReport.body.gate).toMatchObject({
      reviewed: false,
      passed: false,
      blockedCode: 'RE_INSPECTION_REQUIRED',
    });

    // QC-008-C1：QC fail → 内部门禁拦截
    await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asGarmentQc())
      .send({ ...GARMENT_REVIEW_BODY, conclusion: 'fail', opinion: 'major 超标，不可寄' });
    const failed = await request(app)
      .get('/api/v1/qc/chain/garment/ORD-G1/gate?sampleLevel=pp&round=1')
      .set(asSales());
    expect(failed.body.gate).toMatchObject({
      reviewed: true,
      passed: false,
      conclusion: 'fail',
      blockedCode: 'SAMPLE_QC_GATE_NOT_PASSED',
    });

    // 第 2 轮 pass → 放行
    await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asGarmentQc())
      .send({ ...GARMENT_REVIEW_BODY, round: 2 });
    const passed = await request(app)
      .get('/api/v1/qc/chain/garment/ORD-G1/gate?sampleLevel=pp&round=2')
      .set(asSales());
    expect(passed.body.gate).toMatchObject({ reviewed: true, passed: true, blockedCode: null });
  });
});

// ════════════════════════════════════════════════════════════════
// QC-29-A4 直接打回工厂重做
// ════════════════════════════════════════════════════════════════
describe('DR-029 · 直接打回（QC-29-A4）', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    seedGarmentOrder(prisma);
  });

  it('缺 rejectReason → 400 REJECT_REASON_REQUIRED', async () => {
    const app = makeApp(prisma);
    const res = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/direct-reject')
      .set(asGarmentQc())
      .send({ sampleLevel: 'pp', round: 3, opinion: '返工重做', criticalDefects: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REJECT_REASON_REQUIRED');
  });

  it('正常打回 → disposition=DIRECT_REJECT + 通知业务员 + gate=SAMPLE_DIRECTLY_REJECTED + 工厂重做要求快照', async () => {
    const app = makeApp(prisma);
    const res = await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/direct-reject')
      .set(asGarmentQc())
      .send({
        sampleLevel: 'pp',
        round: 3,
        opinion: '返工重做；领型与面料全错，建议重新对封样',
        rejectReason: '领型完全错误且面料用错，即使寄客户也必被拒',
        criticalDefects: 2,
        majorDefects: 3,
        minorDefects: 5,
      });
    expect(res.status).toBe(201);
    const report = res.body.report;
    expect(report.result).toBe('fail');
    expect(report.signatures.chain).toMatchObject({
      disposition: 'DIRECT_REJECT',
      rejectReason: '领型完全错误且面料用错，即使寄客户也必被拒',
    });
    // 工厂重做要求（关联 QC 评审 ID 与意见快照）
    expect(report.signatures.chain.factoryRework).toMatchObject({
      required: true,
      issuedBy: 'QC-G1',
      status: 'pending',
    });

    // 通知业务员（订单 ownerId），含打回原因
    const ntfs = prisma._stores.notifications.filter((n: any) => n.type === 'qc_sample_direct_reject');
    expect(ntfs).toHaveLength(1);
    expect(ntfs[0].userId).toBe('SALES-1');
    expect(ntfs[0].body).toContain('领型完全错误且面料用错');
    expect(ntfs[0].metadata).toMatchObject({ orderId: 'ORD-G1', disposition: 'DIRECT_REJECT', round: 3 });

    // 该批不得寄客户（fail-closed）
    const gate = await request(app)
      .get('/api/v1/qc/chain/garment/ORD-G1/gate?sampleLevel=pp&round=3')
      .set(asSales());
    expect(gate.body.gate.blockedCode).toBe('SAMPLE_DIRECTLY_REJECTED');

    // 审计：direct_reject 操作独立留痕
    expect(prisma._stores.auditLogs.some((l: any) => l.action === 'garment_sample_direct_reject')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// 面料链评审（QC-29-B2 / REL-14-A5）
// ════════════════════════════════════════════════════════════════
describe('DR-029 · 面料链评审（QC-29-B2 / REL-14-A5）', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    seedFabricOrder(prisma);
    seedSsSample(prisma);
  });

  it('原生订单样品禁止旧 QC 链回写报告，保留来源、事件和样品原记录', async () => {
    prisma.orderSampleSource.findUnique.mockResolvedValue({ id: 'NATIVE-SOURCE', sampleId: 'SMP-SS-1' });
    const res = await request(makeApp(prisma)).post('/api/v1/qc/chain/fabric/ORD-F1/review').set(asFabricQc())
      .send({ sampleKind: 'SS', sampleId: 'SMP-SS-1', conclusion: 'pass', opinion: '旧链不得修改原生样品' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEVELOPMENT_SOURCE_CHANGED');
    expect(prisma._stores.inspectionReports).toHaveLength(0);
    expect(prisma._stores.auditLogs).toHaveLength(0);
    expect(prisma._stores.samples[0].qcInspectionReportId).toBeNull();
  });

  it('S/S 评审 pass → 201 + 回写样品 qcInspectionReportId + inspectionType 面料链命名空间', async () => {
    const app = makeApp(prisma);
    const res = await request(app)
      .post('/api/v1/qc/chain/fabric/ORD-F1/review')
      .set(asFabricQc())
      .send({ sampleKind: 'SS', sampleId: 'SMP-SS-1', conclusion: 'pass', opinion: '色泽与手感一致', inspectionDate: '2026-08-12' });
    expect(res.status).toBe(201);
    const report = res.body.report;
    expect(report.id).toBe('INR__ORD-F1__fqc__SMP-SS-1__1');
    expect(report.inspectionType).toBe('fabric_ss__r1');
    expect(report.signatures.chain).toMatchObject({
      chain: 'fabric',
      sampleKind: 'SS',
      sampleId: 'SMP-SS-1',
      disposition: 'STANDARD',
    });
    // DR-029 面料链关联位回写
    const sample = prisma._stores.samples.find((s: any) => s.id === 'SMP-SS-1');
    expect(sample.qcInspectionReportId).toBe(report.id);
    expect(prisma._stores.auditLogs.some((l: any) => l.action === 'fabric_sample_review')).toBe(true);
  });

  it('QC-29-B2：非 pass 缺 factoryAdjustment.requirement → 400；带技术调整要求 → 201 disposition=REQUIRES_FACTORY_TECH_ADJUST', async () => {
    const app = makeApp(prisma);
    const missing = await request(app)
      .post('/api/v1/qc/chain/fabric/ORD-F1/review')
      .set(asFabricQc())
      .send({ sampleKind: 'SS', sampleId: 'SMP-SS-1', conclusion: 'fail', opinion: '偏蓝 0.5 级' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('FACTORY_ADJUSTMENT_REQUIRED');

    const okRes = await request(app)
      .post('/api/v1/qc/chain/fabric/ORD-F1/review')
      .set(asFabricQc())
      .send({
        sampleKind: 'SS',
        sampleId: 'SMP-SS-1',
        conclusion: 'fail',
        opinion: '偏蓝 0.5 级，需加黄调整',
        factoryAdjustment: {
          requirement: '染整加黄 0.5 级调整',
          parameters: { dye: 'yellow', level: 0.5 },
          factoryName: '某染厂',
          followUpBy: 'QC-F1',
        },
      });
    expect(okRes.status).toBe(201);
    expect(okRes.body.report.signatures.chain.disposition).toBe('REQUIRES_FACTORY_TECH_ADJUST');
    expect(okRes.body.report.signatures.chain.factoryAdjustment).toMatchObject({
      requirement: '染整加黄 0.5 级调整',
      factoryName: '某染厂',
      followUpBy: 'QC-F1',
      issuedBy: 'QC-F1',
    });
  });

  it('样品归属校验：样品不存在 → 404；样品不属于订单 → 400 SAMPLE_ORDER_MISMATCH', async () => {
    const app = makeApp(prisma);
    const notFound = await request(app)
      .post('/api/v1/qc/chain/fabric/ORD-F1/review')
      .set(asFabricQc())
      .send({ sampleKind: 'SS', sampleId: 'FSS-NOPE', conclusion: 'pass', opinion: 'x' });
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe('SAMPLE_NOT_FOUND');

    seedFabricOrder(prisma, { id: 'ORD-F2' });
    seedSsSample(prisma, { id: 'SMP-SS-2', sourceOrderId: 'ORD-F2' });
    const mismatch = await request(app)
      .post('/api/v1/qc/chain/fabric/ORD-F1/review')
      .set(asFabricQc())
      .send({ sampleKind: 'SS', sampleId: 'SMP-SS-2', conclusion: 'pass', opinion: 'x' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('SAMPLE_ORDER_MISMATCH');
  });

  it('REL-14-A5：同样品二次评审 → 独立 seq=2 报告，不覆盖首条', async () => {
    const app = makeApp(prisma);
    const first = await request(app)
      .post('/api/v1/qc/chain/fabric/ORD-F1/review')
      .set(asFabricQc())
      .send({ sampleKind: 'SS', sampleId: 'SMP-SS-1', conclusion: 'fail', opinion: '偏蓝', factoryAdjustment: { requirement: '加黄' } });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/qc/chain/fabric/ORD-F1/review')
      .set(asFabricQc())
      .send({ sampleKind: 'SS', sampleId: 'SMP-SS-1', conclusion: 'pass', opinion: '调整后合格' });
    expect(second.status).toBe(201);
    expect(second.body.report.id).toBe('INR__ORD-F1__fqc__SMP-SS-1__2');
    expect(second.body.report.inspectionType).toBe('fabric_ss__r2');

    const reports = prisma._stores.inspectionReports.filter((r: any) => r.orderId === 'ORD-F1');
    expect(reports).toHaveLength(2);
    expect(reports[0].result).toBe('fail');
    expect(reports[1].result).toBe('pass');
  });

  it('链报告列表：仅返回样品链报告（大货 final/midline 天然隔离），chain 过滤生效', async () => {
    const app = makeApp(prisma);
    await request(app)
      .post('/api/v1/qc/chain/fabric/ORD-F1/review')
      .set(asFabricQc())
      .send({ sampleKind: 'SS', sampleId: 'SMP-SS-1', conclusion: 'pass', opinion: 'ok' });
    // 混入大货 final 报告（非链命名空间）
    prisma._stores.inspectionReports.push({
      id: 'INR__ORD-F1',
      orderId: 'ORD-F1',
      inspectionType: 'final',
      result: 'pass',
      createdAt: BigInt(1),
    });

    const all = await request(app).get('/api/v1/qc/chain/ORD-F1/reports').set(asSales());
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(1);
    expect(all.body.items[0].chain).toBe('fabric');

    const garmentOnly = await request(app).get('/api/v1/qc/chain/ORD-F1/reports?chain=garment').set(asSales());
    expect(garmentOnly.body.items).toHaveLength(0);

    const badChain = await request(app).get('/api/v1/qc/chain/ORD-F1/reports?chain=bulk').set(asSales());
    expect(badChain.status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════
// DR-014 出运资格三条件并行（QC-014-C2）
// ════════════════════════════════════════════════════════════════
describe('DR-014 · 出运资格三条件并行（QC-014-C2）', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    seedFabricOrder(prisma);
  });

  const eligibility = (app: any, orderId = 'ORD-F1') =>
    request(app).get(`/api/v1/qc/orders/${orderId}/shipment-eligibility`).set(asSales());

  it('三条件全缺 → eligible=false，missingGates 分别列出 3 条链（非完成度百分比）', async () => {
    const app = makeApp(prisma);
    const res = await eligibility(app);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      orderId: 'ORD-F1',
      applicable: true,
      eligible: false,
      missingGates: ['BULK_QC_NOT_PASSED', 'SS_NOT_CONFIRMED'],
    });
    expect(res.body.conditions.bulkQc.satisfied).toBe(false);
    expect(res.body.conditions.ss.satisfied).toBe(false);
    // RC 未启用（未寄匹头样）→ 不计门禁
    expect(res.body.conditions.rc).toMatchObject({ enabled: false, satisfied: true });
  });

  it('并行顺序无关：仅 QC pass → 缺 S/S；仅 S/S approved → 缺 bulkQc（互不前置）', async () => {
    const app = makeApp(prisma);
    // 场景①：先完成大货 QC（D8 统一口径：合格数量达标 + 致命疵点 0 + 业务批准）
    prisma._stores.inspectionReports.push({
      id: 'INR__ORD-F1',
      orderId: 'ORD-F1',
      inspectionType: 'final',
      scopeType: 'whole_order', scopeKey: 'whole_order', revision: 1,
      result: 'pass',
      totalUnits: 100,
      passedUnits: 98,
      criticalDefects: 0,
      approvedByBusiness: true,
      inspectedBy: 'QC-F1',
      inspectionDate: '2026-08-10',
      createdAt: BigInt(1),
    });
    const afterQc = await eligibility(app);
    expect(afterQc.body.conditions.bulkQc.satisfied).toBe(true);
    expect(afterQc.body.eligible).toBe(false);
    expect(afterQc.body.missingGates).toEqual(['SS_NOT_CONFIRMED']);

    // 场景②：换成仅 S/S 确认，QC 未做（重开库模拟反向顺序）
    const prisma2 = makeMockPrisma();
    seedFabricOrder(prisma2);
    seedSsSample(prisma2, { customerStatus: 'approved', customerFeedbackDate: '2026-08-05' });
    const app2 = makeApp(prisma2);
    const afterSs = await eligibility(app2);
    expect(afterSs.body.conditions.ss.satisfied).toBe(true);
    expect(afterSs.body.eligible).toBe(false);
    expect(afterSs.body.missingGates).toEqual(['BULK_QC_NOT_PASSED']);
  });

  it('RC 启用未确认 → RC_NOT_CONFIRMED；三条件齐全 → eligible=true', async () => {
    prisma._stores.orders[0].fabricSampleSentDate = '2026-08-08';
    const app = makeApp(prisma);
    prisma._stores.inspectionReports.push({
      id: 'INR__ORD-F1',
      orderId: 'ORD-F1',
      inspectionType: 'final',
      scopeType: 'whole_order', scopeKey: 'whole_order', revision: 1,
      result: 'pass',
      totalUnits: 100,
      passedUnits: 98,
      criticalDefects: 0,
      approvedByBusiness: true,
      createdAt: BigInt(1),
    });
    seedSsSample(prisma, { customerStatus: 'approved' });

    const withRcMissing = await eligibility(app);
    expect(withRcMissing.body.conditions.rc).toMatchObject({ enabled: true, satisfied: false });
    expect(withRcMissing.body.missingGates).toEqual(['RC_NOT_CONFIRMED']);
    expect(withRcMissing.body.eligible).toBe(false);

    prisma._stores.orders[0].fabricSampleConfirmedDate = '2026-08-11';
    const allDone = await eligibility(app);
    expect(allDone.body.eligible).toBe(true);
    expect(allDone.body.missingGates).toEqual([]);
    expect(allDone.body.conditions.rc).toMatchObject({ enabled: true, satisfied: true, confirmedDate: '2026-08-11' });
  });

  it('legacy whole-order Final qualifies only while its order has no active physical batch', async () => {
    const report = { id: 'LEGACY-FINAL', orderId: 'ORD-F1', inspectionType: 'final',
      scopeType: 'whole_order', scopeKey: 'whole_order', revision: 1, scopeFingerprint: null,
      result: 'pass', totalUnits: 100, passedUnits: 98, criticalDefects: 0, approvedByBusiness: true };
    prisma._stores.inspectionReports.push(report);
    seedSsSample(prisma, { customerStatus: 'approved' });
    const app = makeApp(prisma);
    prisma._stores.productionBatches.push({ id: 'FOREIGN', orderId: 'OTHER-ORDER', state: 'active' },
      { id: 'RETIRED', orderId: 'ORD-F1', state: 'superseded' });
    const before = await eligibility(app);
    expect(before.status).toBe(200); expect(before.body.eligible).toBe(true);
    expect(before.body.conditions.bulkQc).toMatchObject({ satisfied: true, reportId: report.id });
    prisma._stores.productionBatches.push({ id: 'CURRENT', orderId: 'ORD-F1', state: 'active' });
    const after = await eligibility(app);
    expect(after.status).toBe(200); expect(after.body.eligible).toBe(false);
    expect(after.body.conditions.bulkQc).toMatchObject({ satisfied: false, reportId: null });
    expect(after.body.missingGates).toEqual(['BULK_QC_NOT_PASSED']);
    expect(prisma._stores.inspectionReports).toEqual([report]);
  });

  it('大货 QC fail 不算通过；服装订单 → applicable=false（链边界）；订单不存在 → 404', async () => {
    prisma._stores.inspectionReports.push({
      id: 'INR__ORD-F1',
      orderId: 'ORD-F1',
      inspectionType: 'final',
      result: 'fail',
      createdAt: BigInt(1),
    });
    seedSsSample(prisma, { customerStatus: 'approved' });
    const app = makeApp(prisma);
    const res = await eligibility(app);
    expect(res.body.eligible).toBe(false);
    expect(res.body.missingGates).toContain('BULK_QC_NOT_PASSED');

    seedGarmentOrder(prisma);
    const garmentRes = await eligibility(app, 'ORD-G1');
    expect(garmentRes.status).toBe(200);
    expect(garmentRes.body.applicable).toBe(false);
    expect(garmentRes.body.reason).toContain('面料');

    const notFound = await eligibility(app, 'ORD-NOPE');
    expect(notFound.status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════
// DR-014 出运资格「真源负向判定」（T1 证伪 A/B）
//
// 目的不是再验一次「得对的时候就对」，而是证明：**按三条死路去改实现，这些用例会转红**。
//   死路一：登记写旧表 FabricShipmentSample（samples/fabricShipmentSampleService 全套）
//   死路二：登记写订单上的 sampleSentDate / sampleConfirmedDate（watchdog 读、门禁不读）
//   死路三：把别的类型的样品（head/pioneer/pp）当成船样登记进来
// 真源只有一个：Sample(type='ship', sourceOrderId, deletedAt=null).customerStatus === 'approved'
// ════════════════════════════════════════════════════════════════
describe('DR-014 · 出运资格真源负向判定（T1 证伪 A/B）', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    seedFabricOrder(prisma);
  });

  const elig = () => request(makeApp(prisma)).get('/api/v1/qc/orders/ORD-F1/shipment-eligibility').set(asSales());

  it('证伪 A：旧表 FabricShipmentSample 有「客户已批准」记录，ss 仍判 SS_NOT_CONFIRMED', async () => {
    // 行为侧：旧表里塞一条已经 approved 的记录（业务口径等价于「船样确认过了」）
    (prisma._stores.fabricShipmentSamples ??= []).push({
      id: 'FSS-1', orderId: 'ORD-F1', customerStatus: 'approved', deletedAt: null,
    });
    const res = await elig();
    expect(res.body.conditions.ss.satisfied).toBe(false);
    expect(res.body.missingGates).toContain('SS_NOT_CONFIRMED');

    // 源码侧：真源函数体不得引用任何旧表模型（挡住将来有人往判定里塞第二个数据源）
    const src = readFileSync(new URL('../qcService.ts', import.meta.url), 'utf8');
    const start = src.indexOf('async function checkShipmentEligibility');
    const end = src.indexOf('// 3B. REL-14-A4');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).not.toContain('fabricShipmentSample');
    expect(body).not.toContain('earlyProductionSample');
    expect(body).toContain("type: 'ship'");
  });

  it('证伪 B：订单 sampleSentDate/sampleConfirmedDate 填齐，ss 仍判 SS_NOT_CONFIRMED', async () => {
    prisma._stores.orders[0].sampleSentDate = '2026-08-01';
    prisma._stores.orders[0].sampleConfirmedDate = '2026-08-05';
    const res = await elig();
    // 这两个字段确实存在（防止用例本身拿了一个不存在字段名，做成空跑的假测试）
    expect(prisma._stores.orders[0]).toHaveProperty('sampleSentDate');
    expect(res.body.conditions.ss).toMatchObject({ satisfied: false, sampleId: null });
    expect(res.body.missingGates).toContain('SS_NOT_CONFIRMED');
  });

  it('真源正例：Sample(type=ship).customerStatus=approved 才让 ss 转绿', async () => {
    seedSsSample(prisma, { customerStatus: 'pending' });
    expect((await elig()).body.conditions.ss.satisfied).toBe(false);
    prisma._stores.samples[0].customerStatus = 'rejected';
    expect((await elig()).body.conditions.ss.satisfied).toBe(false);
    prisma._stores.samples[0].customerStatus = 'approved';
    const ok = await elig();
    expect(ok.body.conditions.ss).toMatchObject({ satisfied: true, sampleId: 'SMP-SS-1' });
    expect(ok.body.missingGates).not.toContain('SS_NOT_CONFIRMED');
  });

  it('软删的船样不计入（deletedAt 非空的 Sample 不被读）', async () => {
    seedSsSample(prisma, { customerStatus: 'approved', deletedAt: '2026-08-09T00:00:00.000Z' });
    const res = await elig();
    expect(res.body.conditions.ss.satisfied).toBe(false);
    expect(res.body.conditions.ss.sampleId).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// signatures 双签（质量门禁 §9.3-②）
// ════════════════════════════════════════════════════════════════
describe('InspectionReport signatures 双签（§9.3-②）', () => {
  let prisma: any;
  beforeEach(async () => {
    prisma = makeMockPrisma();
    seedGarmentOrder(prisma);
    // 建一条含 chain 命名空间的样品链报告（验证双签与 chain 共存互不覆盖）
    const app = makeApp(prisma);
    await request(app)
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asGarmentQc())
      .send(GARMENT_REVIEW_BODY);
  });

  const REPORT_ID = 'INR__ORD-G1__smp__pp__r1';

  it('qc 签 → qcSignedAt/qcSignerId 写入且 chain 命名空间保留；同角色重复签 → 400', async () => {
    const app = makeApp(prisma);
    const res = await request(app)
      .post(`/api/v1/qc/reports/${REPORT_ID}/sign`)
      .set(asGarmentQc())
      .send({ role: 'qc' });
    expect(res.status).toBe(200);
    expect(res.body.item.signatures.qcSignedAt).toBeTypeOf('number');
    expect(res.body.item.signatures.qcSignerId).toBe('QC-G1');
    // chain 命名空间不被覆盖
    expect(res.body.item.signatures.chain).toMatchObject({ chain: 'garment', round: 1 });

    // 字段级审计
    expect(
      prisma._stores.auditLogs.some(
        (l: any) => l.action === 'inspection_report_sign_qc' && l.fieldPath === 'signatures.qcSignedAt',
      ),
    ).toBe(true);

    const dup = await request(app)
      .post(`/api/v1/qc/reports/${REPORT_ID}/sign`)
      .set(asGarmentQc())
      .send({ role: 'qc' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('已签署');
  });

  it('business 签 → businessSignedAt 写入；双签齐全后两字段共存', async () => {
    const app = makeApp(prisma);
    await request(app).post(`/api/v1/qc/reports/${REPORT_ID}/sign`).set(asGarmentQc()).send({ role: 'qc' });
    const biz = await request(app)
      .post(`/api/v1/qc/reports/${REPORT_ID}/sign`)
      .set({ Cookie: `bambook_token=${businessSignerToken}` })
      .send({ role: 'business' });
    expect(biz.status).toBe(200);
    const sig = biz.body.item.signatures;
    expect(sig.businessSignedAt).toBeTypeOf('number');
    expect(sig.businessSignerId).toBe('SALES-1');
    expect(sig.qcSignedAt).toBeTypeOf('number');
    expect(sig.chain).toMatchObject({ chain: 'garment' });
  });

  it('只读销售不能靠角色默认值恢复 business 签署写权，报告与审计均不变化', async () => {
    // This particular current account is genuinely read-only (default Sales in
    // the application can have qc:write; a stale token is not a revocation fact).
    prisma._stores.userAccounts.find((u: any) => u.id === 'SALES-1').roles[0].role.permissions = [{ permission: { scope: 'qc:read' } }];
    const before = structuredClone(prisma._stores.inspectionReports);
    const auditBefore = structuredClone(prisma._stores.auditLogs);
    const response = await request(makeApp(prisma)).post(`/api/v1/qc/reports/${REPORT_ID}/sign`)
      .set(asSales()).send({ role: 'business' });
    expect(response.status).toBe(403);
    expect(prisma._stores.inspectionReports).toEqual(before);
    expect(prisma._stores.auditLogs).toEqual(auditBefore);
  });

  it('非法 role → 400；报告不存在 → 404；无 qc:write（财务）→ 403；API key → 401', async () => {
    const app = makeApp(prisma);
    const badRole = await request(app)
      .post(`/api/v1/qc/reports/${REPORT_ID}/sign`)
      .set(asGarmentQc())
      .send({ role: 'admin' });
    expect(badRole.status).toBe(400);
    expect(badRole.body.error.message).toContain('非法签署角色');

    const notFound = await request(app)
      .post('/api/v1/qc/reports/INR__NOPE/sign')
      .set(asGarmentQc())
      .send({ role: 'qc' });
    expect(notFound.status).toBe(404);

    const forbidden = await request(app)
      .post(`/api/v1/qc/reports/${REPORT_ID}/sign`)
      .set(asFinance())
      .send({ role: 'qc' });
    expect(forbidden.status).toBe(403);

    const apiKeyRes = await request(app)
      .post(`/api/v1/qc/reports/${REPORT_ID}/sign`)
      .set('X-Bambook-API-Key', validApiKey)
      .send({ role: 'qc' });
    expect(apiKeyRes.status).toBe(401);
  });

  it('QCG-EXC-2 场景①：QC 容器代签业务侧 → 403 PP_SIGN_BUSINESS_ROLE_REQUIRED；部门主管可签', async () => {
    const app = makeApp(prisma);
    // QC-G1 非订单负责人、非部门主管 → 403（双签职责分离 fail-closed）
    const qcProxySign = await request(app)
      .post(`/api/v1/qc/reports/${REPORT_ID}/sign`)
      .set(asGarmentQc())
      .send({ role: 'business' });
    expect(qcProxySign.status).toBe(403);
    expect(qcProxySign.body.error.message).toContain('PP_SIGN_BUSINESS_ROLE_REQUIRED');
    // 未写入任何签字（fail-closed 不留半成品）
    expect(prisma._stores.inspectionReports.find((r: any) => r.id === REPORT_ID).signatures.businessSignedAt).toBeUndefined();

    // 订单归属部门主管（DEPT-1.headId=MGR-1）→ 放行
    prisma._stores.departments.push({ id: 'DEPT-1', status: 'active', headId: 'MGR-1' });
    const mgrToken = jwt.sign(
      { userId: 'MGR-1', roles: ['sales'], permissions: ['qc:read', 'qc:write'], departmentIds: ['DEPT-1'] },
      SECRET,
    );
    const mgrSign = await request(app)
      .post(`/api/v1/qc/reports/${REPORT_ID}/sign`)
      .set('Cookie', `bambook_token=${mgrToken}`)
      .send({ role: 'business' });
    expect(mgrSign.status).toBe(200);
    expect(mgrSign.body.item.signatures.businessSignerId).toBe('MGR-1');
  });

  it('报告读取端点：GET /reports/:id 返回 signatures；GET /orders/:orderId/reports 列表', async () => {
    const app = makeApp(prisma);
    await request(app).post(`/api/v1/qc/reports/${REPORT_ID}/sign`).set(asGarmentQc()).send({ role: 'qc' });

    const single = await request(app).get(`/api/v1/qc/reports/${REPORT_ID}`).set(asSales());
    expect(single.status).toBe(200);
    expect(single.body.item.signatures.qcSignerId).toBe('QC-G1');

    const list = await request(app).get('/api/v1/qc/orders/ORD-G1/reports').set(asSales());
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].id).toBe(REPORT_ID);

    const list404 = await request(app).get('/api/v1/qc/orders/ORD-NOPE/reports').set(asSales());
    expect(list404.status).toBe(404);
  });
});

/**
 * §9 **B39** · 位置参数内插原文的执行覆盖（R3 / §6 S1）
 *
 * 本批把 `qcChainService.ts:381/:553` 两处 ``fail('CREATE_FAILED', `…失败: ${String(e?.message ?? e)}`, 500)``
 * 换成字面中文，**并补上该文件原本没有的 `logger.error`**（原先只有 info/warn，实测 `logger.error` 计数为 0）。
 * 出口链已核：`qcRoute.ts:120` 用 `res.status(result.error.status).json({ error: { code, message: result.error.message } })`
 * 原样转发 ⇒ 服务层文案就是用户看到的东西。
 *
 * ★ 两处的文案**故意不同**：服装那处（`:381`）的 catch 还覆盖**事务之后**的 `getGarmentSampleGate` 读
 *   ⇒ 报告可能已落库而只是门禁没取到 ⇒ **不许承诺写入状态**；面料那处（`:553`）事务之后只有 logger + return
 *   ⇒ 才可以承诺"本次未确认任何改动"。下面两条断言把这个差别钉住。
 */
const B39_RAW = 'PrismaClientKnownRequestError: Invalid `prisma.$transaction()` invocation in '
  + '/srv/app/server/src/qc/qcChainService.ts:302 — Unique constraint failed on the fields: (`id`)';
const B39_FRAGMENTS = ['PrismaClient', 'prisma.$transaction', 'qcChainService.ts:302', 'Unique constraint', '/srv/app', 'P2002'];

describe('§9 B39 · QC 链评审事务失败时用户收到的是中文', () => {
  it('服装链：500 + 码名不变 + 中文 + 零原文，且**不承诺写入状态**', async () => {
    const prisma = makeMockPrisma();
    seedGarmentOrder(prisma);
    prisma.$transaction = async () => { throw new Error(B39_RAW); };
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const res = await request(makeApp(prisma))
      .post('/api/v1/qc/chain/garment/ORD-G1/review')
      .set(asGarmentQc())
      .send(GARMENT_REVIEW_BODY);

    expect(res.status).toBe(500);
    expect(res.body.error.code, '码名不得随文案一起改').toBe('CREATE_FAILED');
    const raw = JSON.stringify(res.body);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expect(res.body.error.message, '必须含中文').toMatch(/[\u4e00-\u9fa5]/);
    expect(res.body.error.message, '必须说清对象').toContain('服装样品 QC');
    expect(res.body.error.message, '必须给下一步').toMatch(/(稍后重试|联系管理员)/);
    expect(res.body.error.message.match(/[A-Za-z]{3,}/g) ?? [], '混入拉丁词 = 原文上屏的指纹').toEqual([]);
    // ★ 服装这处 catch 覆盖到事务之后的门禁读 ⇒ 不得声称零写入（改文案的人不许"统一模板"）
    expect(res.body.error.message, '服装链出口不得承诺写入状态').not.toMatch(/(没有写入任何数据|本次未确认任何改动|本次改动未生效)/);
    expect(spy, '原文必须仍进日志').toHaveBeenCalledWith(
      expect.stringContaining('[QcChainService]'), expect.objectContaining({ error: B39_RAW }));
    spy.mockRestore();
  });

  it('面料链：500 + 码名不变 + 中文 + 零原文，且**明确承诺本次未确认任何改动**', async () => {
    const prisma = makeMockPrisma();
    seedFabricOrder(prisma);
    seedSsSample(prisma);
    prisma.$transaction = async () => { throw new Error(B39_RAW); };
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const res = await request(makeApp(prisma))
      .post('/api/v1/qc/chain/fabric/ORD-F1/review')
      .set(asFabricQc())
      .send({ sampleKind: 'SS', sampleId: 'SMP-SS-1', conclusion: 'pass', opinion: '色泽与手感一致', inspectionDate: '2026-08-15' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CREATE_FAILED');
    const raw = JSON.stringify(res.body);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expect(res.body.error.message).toMatch(/[\u4e00-\u9fa5]/);
    expect(res.body.error.message).toContain('面料样品 QC');
    expect(res.body.error.message, '写路径唯一（单个 $transaction）⇒ 可以承诺').toContain('本次未确认任何改动');
    expect(res.body.error.message.match(/[A-Za-z]{3,}/g) ?? []).toEqual([]);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('[QcChainService]'), expect.objectContaining({ error: B39_RAW }));
    spy.mockRestore();
  });
});
