import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createPricingRouter } from '../pricingRoute';

/**
 * P2a 佣金规则测试。Mock Prisma 内存存储 CommissionRule + Relation（中间人真源），
 * 语义对齐真实 client 的本测试用到的子集。
 */
function makeMockPrisma() {
  let seq = 0;
  const rules: any[] = [];
  const relations: any[] = [
    { id: 'REL__AGENT_A', name: '某中间商 A', deletedAt: null },
    { id: 'REL__AGENT_B', name: '某中间商 B', deletedAt: null },
    { id: 'REL__DELETED', name: '已删中间商', deletedAt: 1n },
  ];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
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

  const commissionRule = {
    findUnique: async ({ where }: any) => rules.find(r => r.id === where.id) || null,
    findFirst: async ({ where }: any = {}) => rules.find(r => matchWhere(r, where)) || null,
    findMany: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(rules.filter(r => matchWhere(r, where)), orderBy),
    count: async ({ where }: any = {}) => rules.filter(r => matchWhere(r, where)).length,
    create: async ({ data }: any) => {
      const row = { isActive: true, notes: null, deletedAt: null, ...data, id: data.id || `CR__T${++seq}` };
      rules.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = rules.find(r => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const relation = {
    findUnique: async ({ where }: any) => relations.find(r => r.id === where.id) || null,
  };

  return { commissionRule, relation, _stores: { rules, relations } };
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
  app.use('/api/v1/pricing', createPricingRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const auth = () => ({ Cookie: `bambook_token=${ownerToken}` });

describe('P2a · 佣金规则守卫', () => {
  it('POST /commission-rules API-Key → 401（写必须 JWT）；GET API-Key → 401（W-C：读端点挂 pricing:read scope 门，无 actor 拒）', async () => {
    const app = makeApp(makeMockPrisma());
    const write = await request(app)
      .post('/api/v1/pricing/commission-rules')
      .set('x-bambook-api-key', validApiKey)
      .send({ name: '默认 E5', rate: 5 });
    expect(write.status).toBe(401);

    const read = await request(app)
      .get('/api/v1/pricing/commission-rules')
      .set('x-bambook-api-key', validApiKey);
    expect(read.status).toBe(401);
  });
});

describe('P2a · CommissionRule CRUD + 占位唯一', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  const createRule = (app: any, body: Record<string, any>) =>
    request(app).post('/api/v1/pricing/commission-rules').set(auth()).send(body);

  it('创建校验：名称必填 / 佣金率任意百分比（0 < rate ≤ 100，J2）/ 中间人须存在（且未软删）', async () => {
    const app = makeApp(prisma);
    expect((await createRule(app, { name: ' ', rate: 5 })).status).toBe(400);
    expect((await createRule(app, { name: 'X', rate: 0 })).status).toBe(400);
    expect((await createRule(app, { name: 'X', rate: -3 })).status).toBe(400);
    expect((await createRule(app, { name: 'X', rate: 101 })).status).toBe(400);

    // J2：任意百分比（如 7.5%）可表达
    const custom = await createRule(app, { name: '自定义费率', rate: 7.5 });
    expect(custom.status).toBe(201);
    expect(custom.body.item.rate).toBe(7.5);

    const ghost = await createRule(app, { name: 'X', rate: 5, intermediaryRelationId: 'REL__GHOST' });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error.message).toContain('中间人不存在');

    const deletedRel = await createRule(app, { name: 'X', rate: 5, intermediaryRelationId: 'REL__DELETED' });
    expect(deletedRel.status).toBe(404);
  });

  it('创建成功：中间人名称快照落库；同中间人启用中规则唯一（幂等占位）', async () => {
    const app = makeApp(prisma);
    const ok = await createRule(app, { name: 'A 代理 E5', rate: 5, intermediaryRelationId: 'REL__AGENT_A' });
    expect(ok.status).toBe(201);
    expect(ok.body.item.intermediaryRelationId).toBe('REL__AGENT_A');
    expect(ok.body.item.intermediaryName).toBe('某中间商 A');

    const dup = await createRule(app, { name: 'A 代理 E10', rate: 10, intermediaryRelationId: 'REL__AGENT_A' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('已存在启用中');

    // 默认规则（intermediaryRelationId 为空）同样唯一
    const def1 = await createRule(app, { name: '默认 E10', rate: 10 });
    expect(def1.status).toBe(201);
    const def2 = await createRule(app, { name: '默认 E5', rate: 5 });
    expect(def2.status).toBe(400);

    // 停用后允许再建同中间人规则
    const idA = ok.body.item.id;
    await request(app).patch(`/api/v1/pricing/commission-rules/${idA}`).set(auth()).send({ isActive: false });
    const again = await createRule(app, { name: 'A 代理 E10 新', rate: 10, intermediaryRelationId: 'REL__AGENT_A' });
    expect(again.status).toBe(201);
  });

  it('更新：切换中间人刷新名称快照；启用态冲突 → 400；软删后 404', async () => {
    const app = makeApp(prisma);
    await createRule(app, { name: 'B 代理 E5', rate: 5, intermediaryRelationId: 'REL__AGENT_B' });
    const a = await createRule(app, { name: 'A 代理 E5', rate: 5, intermediaryRelationId: 'REL__AGENT_A' });
    const idA = a.body.item.id;

    // 切到 B → 与 B 既有启用规则冲突
    const conflict = await request(app)
      .patch(`/api/v1/pricing/commission-rules/${idA}`)
      .set(auth())
      .send({ intermediaryRelationId: 'REL__AGENT_B' });
    expect(conflict.status).toBe(400);

    // 停用 A 后切 B 仍冲突（B 规则仍启用）；先停 B 再切成功
    const list = await request(app).get('/api/v1/pricing/commission-rules').set(auth());
    const bRule = list.body.items.find((r: any) => r.intermediaryRelationId === 'REL__AGENT_B');
    await request(app).patch(`/api/v1/pricing/commission-rules/${bRule.id}`).set(auth()).send({ isActive: false });
    const ok = await request(app)
      .patch(`/api/v1/pricing/commission-rules/${idA}`)
      .set(auth())
      .send({ intermediaryRelationId: 'REL__AGENT_B', rate: 10 });
    expect(ok.status).toBe(200);
    expect(ok.body.item.intermediaryName).toBe('某中间商 B');
    expect(ok.body.item.rate).toBe(10);

    await request(app).delete(`/api/v1/pricing/commission-rules/${idA}`).set(auth());
    const gone = await request(app).patch(`/api/v1/pricing/commission-rules/${idA}`).set(auth()).send({ rate: 5 });
    expect(gone.status).toBe(404);
  });
});

describe('P2a · lookup 命中口径', () => {
  it('中间人精确命中优先；无精确命中回退默认规则；均无 → null', async () => {
    const prisma = makeMockPrisma();
    const app = makeApp(prisma);
    const createRule = (body: Record<string, any>) =>
      request(app).post('/api/v1/pricing/commission-rules').set(auth()).send(body);

    await createRule({ name: '默认 E10', rate: 10 });
    await createRule({ name: 'A 代理 E5', rate: 5, intermediaryRelationId: 'REL__AGENT_A' });

    const exact = await request(app)
      .get('/api/v1/pricing/commission-rules/lookup?intermediaryRelationId=REL__AGENT_A')
      .set(auth());
    expect(exact.body.hit.rate).toBe(5);

    const fallback = await request(app)
      .get('/api/v1/pricing/commission-rules/lookup?intermediaryRelationId=REL__AGENT_B')
      .set(auth());
    expect(fallback.body.hit.rate).toBe(10);

    const blank = await request(app)
      .get('/api/v1/pricing/commission-rules/lookup')
      .set(auth());
    expect(blank.body.hit.rate).toBe(10); // 默认规则兜底
  });

  it('精确规则停用后回退默认；默认也停用 → null', async () => {
    const prisma = makeMockPrisma();
    const app = makeApp(prisma);
    const createRule = (body: Record<string, any>) =>
      request(app).post('/api/v1/pricing/commission-rules').set(auth()).send(body);

    const def = await createRule({ name: '默认 E10', rate: 10 });
    const a = await createRule({ name: 'A 代理 E5', rate: 5, intermediaryRelationId: 'REL__AGENT_A' });

    await request(app).patch(`/api/v1/pricing/commission-rules/${a.body.item.id}`).set(auth()).send({ isActive: false });
    const hit = await request(app)
      .get('/api/v1/pricing/commission-rules/lookup?intermediaryRelationId=REL__AGENT_A')
      .set(auth());
    expect(hit.body.hit.rate).toBe(10); // 回退默认

    await request(app).patch(`/api/v1/pricing/commission-rules/${def.body.item.id}`).set(auth()).send({ isActive: false });
    const none = await request(app)
      .get('/api/v1/pricing/commission-rules/lookup?intermediaryRelationId=REL__AGENT_A')
      .set(auth());
    expect(none.body.hit).toBeNull();
  });
});

describe('P2a · 定价计算接入佣金规则快照', () => {
  it('createCalculation 传 commissionRuleId：佣金率取规则值快照，覆盖显式 commissionRate', async () => {
    // 需要 taxRefundRate/exchangeRate/pricingCalculation 最小存储配合
    const prisma = makeMockPrisma() as any;
    const calculations: any[] = [];
    prisma.taxRefundRate = {
      findUnique: async () => null,
      findMany: async () => [],
      count: async () => 0,
    };
    prisma.exchangeRate = {
      findFirst: async () => ({ id: 'FXR__1', currency: 'USD', rate: 7.2 }),
      findMany: async () => [],
    };
    prisma.pricingCalculation = {
      findUnique: async ({ where }: any) => calculations.find(c => c.id === where.id) || null,
      findMany: async () => calculations,
      count: async () => calculations.length,
      create: async ({ data }: any) => {
        const row = { deletedAt: null, ...data };
        calculations.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = calculations.find(c => c.id === where.id);
        Object.assign(row, data);
        return row;
      },
    };

    const app = makeApp(prisma);
    const rule = await request(app)
      .post('/api/v1/pricing/commission-rules')
      .set(auth())
      .send({ name: '默认 E10', rate: 10 });
    const ruleId = rule.body.item.id;

    const res = await request(app)
      .post('/api/v1/pricing/calculations')
      .set(auth())
      .send({
        purchaseCostCny: 80, refundRate: 13, profitMargin: 25,
        commissionRate: 0, // 显式 0 应被规则快照覆盖为 10
        commissionRuleId: ruleId,
      });
    expect(res.status).toBe(201);
    expect(res.body.item.commissionRate).toBe(10);
    expect(res.body.item.commissionRuleId).toBe(ruleId);
    // 终价 = net × 1.25 + net × 0.10
    expect(res.body.item.finalUnitPrice).toBeCloseTo(9.6667 * 1.35, 2);

    // 停用规则后引用 → 400
    await request(app).patch(`/api/v1/pricing/commission-rules/${ruleId}`).set(auth()).send({ isActive: false });
    const blocked = await request(app)
      .post('/api/v1/pricing/calculations')
      .set(auth())
      .send({ purchaseCostCny: 80, refundRate: 13, profitMargin: 25, commissionRuleId: ruleId });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toContain('佣金规则');
  });
});
