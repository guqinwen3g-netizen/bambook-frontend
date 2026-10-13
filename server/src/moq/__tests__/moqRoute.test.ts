import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createMoqRouter } from '../moqRoute';

/**
 * MOQ 路由 HTTP 契约验收（§15.1 / §15.3）：
 *   - 全部端点仅 JWT（无 token → 401）
 *   - GET /config：无 active → 兜底常量 + fallback 标记
 *   - PUT /config：无 scope → 403 SCOPE_DENIED + 越权审计；changeReason <5 字 → 400；正常 → 200 + 历史留痕
 *   - GET /history：append-only 只读
 *   - POST /validate：dry-run（不写库不建审批单）；Capsule 面料 403；override 越权 403
 */

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const adminToken = jwt.sign({ userId: 'u_admin', roles: ['admin'], permissions: [], departmentIds: [] }, SECRET);
const ownerToken = jwt.sign({ userId: 'u_owner', roles: ['owner'], permissions: [], departmentIds: [] }, SECRET);
const salesToken = jwt.sign({ userId: 'u_sales', roles: ['sales'], permissions: [], departmentIds: [] }, SECRET);
const financeToken = jwt.sign({ userId: 'u_fin', roles: ['finance'], permissions: [], departmentIds: [] }, SECRET);
const managerToken = jwt.sign({ userId: 'u_mgr', roles: ['manager'], permissions: [], departmentIds: [] }, SECRET);

const ACTIVE_ROW = {
  id: 'MOQCFG__active1',
  fabricDefaultMoq: 800,
  garmentDefaultMoq: 200,
  capsuleMoq: 20,
  isActive: true,
  effectiveFrom: new Date('2026-08-01T00:00:00Z'),
  effectiveTo: null,
  changedBy: 'usr_admin',
  changeReason: '首次初始化种子值',
};

function makeApp(opts: { activeRow?: any } = {}) {
  const activeRow = opts.activeRow === undefined ? ACTIVE_ROW : opts.activeRow;
  const audits: any[] = [];
  const historyCreates: any[] = [];

  const prisma: any = {
    moqThresholdConfig: {
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => (where?.isActive === true ? activeRow : null)),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...activeRow, ...data, id: where.id })),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
    },
    moqThresholdConfigHistory: {
      create: vi.fn().mockImplementation(async ({ data }: any) => { historyCreates.push(data); return { ...data }; }),
      findMany: vi.fn().mockResolvedValue([{ id: 'H1', changeReason: '首次初始化种子值' }]),
    },
    auditLog: { create: vi.fn().mockImplementation(async ({ data }: any) => { audits.push(data); return { id: 'AL-1' }; }) },
    // resolution 档案查询默认未命中
    fabricProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    garmentProfile: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) },
    relation: { findUnique: vi.fn().mockResolvedValue(null) },
    customerTier: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn().mockImplementation(async (ops: any[]) => Promise.all(ops)),
  };

  const app = express();
  app.use(express.json());
  app.use('/api/v1/moq', createMoqRouter({ prisma, requireAuth: true }));
  return { app, prisma, audits, historyCreates };
}

describe('MOQ 路由鉴权（仅 JWT，fail-closed）', () => {
  it.each([
    ['GET', '/api/v1/moq/config'],
    ['PUT', '/api/v1/moq/config'],
    ['GET', '/api/v1/moq/history'],
    ['POST', '/api/v1/moq/validate'],
  ])('%s %s 无 token → 401', async (method, path) => {
    const { app } = makeApp();
    const res = await request(app)[method.toLowerCase() as 'get'](path);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });
});

describe('GET /config', () => {
  it('有 active 配置 → item + fallback=null', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/moq/config').set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe(ACTIVE_ROW.id);
    expect(res.body.item.fabricDefaultMoq).toBe(800);
    expect(res.body.fallback).toBeNull();
  });

  it('无 active 配置 → item=null + fallback 兜底常量 + 提示信息（A5）', async () => {
    const { app } = makeApp({ activeRow: null });
    const res = await request(app).get('/api/v1/moq/config').set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(200);
    expect(res.body.item).toBeNull();
    expect(res.body.fallback).toEqual({ fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20 });
    expect(res.body.message).toContain('兜底常量');
  });
});

describe('PUT /config（§15.3 权限链：仅管理员可调）', () => {
  const body = { fabricDefaultMoq: 900, garmentDefaultMoq: 210, capsuleMoq: 21, changeReason: '旺季产能调整阈值' };

  it('业务员 sales → 403 SCOPE_DENIED + 越权审计留痕', async () => {
    const { app, audits } = makeApp();
    const res = await request(app).put('/api/v1/moq/config').set('Authorization', `Bearer ${salesToken}`).send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('SCOPE_DENIED');
    expect(audits.some((a) => a.action === 'MOQ_CONFIG_WRITE_DENIED' && a.actorId === 'u_sales')).toBe(true);
  });

  it('销售主管 manager（无配置写 scope）→ 403', async () => {
    const { app } = makeApp();
    const res = await request(app).put('/api/v1/moq/config').set('Authorization', `Bearer ${managerToken}`).send(body);
    expect(res.status).toBe(403);
  });

  it('admin + changeReason < 5 字 → 400 MOQ_INVALID_REASON', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put('/api/v1/moq/config').set('Authorization', `Bearer ${adminToken}`)
      .send({ ...body, changeReason: '短' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MOQ_INVALID_REASON');
  });

  it('admin + 非正整数 → 400 MOQ_INVALID_VALUE', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put('/api/v1/moq/config').set('Authorization', `Bearer ${adminToken}`)
      .send({ ...body, fabricDefaultMoq: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MOQ_INVALID_VALUE');
  });

  it('admin 正常变更 → 200 + 新配置 + history append（同事务）', async () => {
    const { app, historyCreates } = makeApp();
    const res = await request(app).put('/api/v1/moq/config').set('Authorization', `Bearer ${adminToken}`).send(body);
    expect(res.status).toBe(200);
    expect(res.body.item.fabricDefaultMoq).toBe(900);
    expect(res.body.item.isActive).toBe(true);
    expect(historyCreates).toHaveLength(1);
    expect(historyCreates[0]).toMatchObject({ beforeFabricDefaultMoq: 800, afterFabricDefaultMoq: 900 });
  });

  it('owner（超级管理员）→ 200', async () => {
    const { app } = makeApp();
    const res = await request(app).put('/api/v1/moq/config').set('Authorization', `Bearer ${ownerToken}`).send(body);
    expect(res.status).toBe(200);
  });
});

describe('GET /history', () => {
  it('登录即可读 → items 列表', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/moq/history').set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items[0].id).toBe('H1');
  });
});

describe('POST /validate（dry-run：不写库不建审批单）', () => {
  it('lines 缺失 → 400 MOQ_INVALID_VALUE', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/moq/validate').set('Authorization', `Bearer ${salesToken}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MOQ_INVALID_VALUE');
  });

  it('quantity 非正数 → 400', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/moq/validate').set('Authorization', `Bearer ${salesToken}`)
      .send({ businessLine: 'fabric', lines: [{ quantity: 0 , unit: 'M' }] });
    expect(res.status).toBe(400);
  });

  it('面料订单勾选 capsuleExemption → 403 CAPSULE_NOT_ALLOWED', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/moq/validate').set('Authorization', `Bearer ${salesToken}`)
      .send({ type: 'Fabric', businessLine: 'fabric', capsuleExemption: true, lines: [{ quantity: 900 , unit: 'M' }] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CAPSULE_NOT_ALLOWED');
  });

  it('行级 override 无 scope（finance 角色）→ 403 SCOPE_DENIED', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/moq/validate').set('Authorization', `Bearer ${financeToken}`)
      .send({ businessLine: 'fabric', lines: [{ quantity: 900, moqOverride: 300 , unit: 'M' }] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('SCOPE_DENIED');
  });

  it('行级 override 持 scope（业务员 sales 为 DR-007 申请侧）→ 200 + line_override 命中', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/moq/validate').set('Authorization', `Bearer ${salesToken}`)
      .send({ businessLine: 'fabric', lines: [{ quantity: 300, moqOverride: 300 , unit: 'M' }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.lines[0].source).toBe('line_override');
  });

  it('合规行 → 200 ok=true；低于 MOQ → ok=false + blockedLineIndexes + 缺口分级（dry-run 不建审批单）', async () => {
    const { app, prisma } = makeApp();
    const ok = await request(app)
      .post('/api/v1/moq/validate').set('Authorization', `Bearer ${salesToken}`)
      .send({ businessLine: 'fabric', lines: [{ quantity: 900 , unit: 'M' }] });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.snapshot.fabricDefaultMoq).toBe(800);

    const blocked = await request(app)
      .post('/api/v1/moq/validate').set('Authorization', `Bearer ${salesToken}`)
      .send({ businessLine: 'fabric', lines: [{ quantity: 500 , unit: 'M' }, { quantity: 100 , unit: 'M' }] });
    expect(blocked.status).toBe(200);
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body.blockedLineIndexes).toEqual([0, 1]);
    expect(blocked.body.lines[0].severity).toBe('low');   // 37.5% 缺口
    expect(blocked.body.lines[1].severity).toBe('high');  // 87.5% 缺口
    // dry-run：永不写审批单（prisma 无 approvalRequest.create 调用面）
    expect(prisma.approvalRequest).toBeUndefined();
  });

  it('行级 businessLine 透传：无单据级业务线时逐行推导（报价单载体场景）', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/moq/validate').set('Authorization', `Bearer ${salesToken}`)
      .send({
        // 无单据级 type/businessLine —— 报价单等载体逐行携带业务线
        lines: [
          { quantity: 300, businessLine: 'garment' , unit: 'PC' }, // 行级 garment → MOQ 200 → 合规
          { quantity: 300, businessLine: 'fabric' , unit: 'M' },  // 行级 fabric → MOQ 800 → 不合规
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.lines[0].effectiveMoq).toBe(200);
    expect(res.body.lines[0].compliant).toBe(true);
    expect(res.body.lines[1].effectiveMoq).toBe(800);
    expect(res.body.lines[1].compliant).toBe(false);
    expect(res.body.blockedLineIndexes).toEqual([1]);
  });

  it('行级 businessLine 优先于单据级：行级 garment 不被单据级 fabric 覆盖', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/moq/validate').set('Authorization', `Bearer ${salesToken}`)
      .send({
        businessLine: 'fabric', // 单据级 fabric（MOQ 800）
        lines: [{ quantity: 300, businessLine: 'garment' , unit: 'PC' }], // 行级 garment（MOQ 200）优先 → 合规
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.lines[0].effectiveMoq).toBe(200);
    expect(res.body.lines[0].compliant).toBe(true);
  });

  it('行级 businessLine 缺省回退单据级（既有语义不回归）', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/moq/validate').set('Authorization', `Bearer ${salesToken}`)
      .send({ businessLine: 'fabric', lines: [{ quantity: 300 , unit: 'M' }] }); // 行级缺省 → 单据级 fabric MOQ 800
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.lines[0].effectiveMoq).toBe(800);
    expect(res.body.lines[0].compliant).toBe(false);
  });
});
