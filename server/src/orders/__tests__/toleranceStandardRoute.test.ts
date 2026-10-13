/**
 * toleranceStandardRoute HTTP 契约验收（2026-09-29）
 *
 * 判据取向：每条断言都写成「**如果实现偷懒，这条就红**」——
 *   · 未配置 ⇒ 必须 200 + value:null（**不许 500，也不许造默认值**）
 *   · PUT 必须真的过 scope 门（业务员 403 + 越权审计）
 *   · ★ 值以**字符串**存（SystemConfig 的真实存储契约）⇒ 读回时必须仍能归一化
 *   · reason <5 字 / 空档位 ⇒ 400（fail-closed）
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createToleranceStandardRouter } from '../toleranceStandardRoute';
import { INTERNAL_TOLERANCE_KEY, INTERNAL_TOLERANCE_SCOPE } from '../toleranceStandardService';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const adminToken = jwt.sign({ userId: 'u_admin', roles: ['admin'], permissions: [], departmentIds: [] }, SECRET);
const ownerToken = jwt.sign({ userId: 'u_owner', roles: ['owner'], permissions: [], departmentIds: [] }, SECRET);
const salesToken = jwt.sign({ userId: 'u_sales', roles: ['sales'], permissions: [], departmentIds: [] }, SECRET);
const financeToken = jwt.sign({ userId: 'u_fin', roles: ['finance'], permissions: [], departmentIds: [] }, SECRET);

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const VALID_STANDARD = {
  qtyTolerance: [
    { minQty: 1, maxQty: 999, pct: 5 },
    { minQty: 1000, maxQty: 3000, pct: 3 },
  ],
  agreementRef: '内部规定-2026-09',
};

function makeApp(opts: { row?: any; relation?: any } = {}) {
  const audits: any[] = [];
  const historyCreates: any[] = [];
  const relationWrites: any[] = [];
  let stored: any = opts.row ?? null;
  // ★ 客户标准：默认给一个存在的客户；`null` 表示"客户不存在"
  let relation: any = opts.relation === undefined
    ? { id: 'REL_C1', name: 'ACME', customerAgreementTolerance: null, deletedAt: null }
    : opts.relation;

  const txAuditCreate = vi.fn().mockImplementation(async ({ data }: any) => { audits.push(data); return { id: 'AL-TX' }; });
  const txRelationUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => {
    relationWrites.push({ where, data });
    relation = { ...relation, ...data };
    return relation;
  });

  const prisma: any = {
    systemConfig: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        if (!stored) return null;
        if (where?.scope_key) {
          return stored.scope === where.scope_key.scope && stored.key === where.scope_key.key ? stored : null;
        }
        return stored.id === where?.id ? stored : null;
      }),
      upsert: vi.fn().mockImplementation(async ({ create, update }: any) => {
        // update 里已含正确的 version（服务层算好的）⇒ 直接覆盖，别自己再加一
        stored = stored ? { ...stored, ...update } : { ...create };
        return stored;
      }),
    },
    systemConfigHistory: {
      create: vi.fn().mockImplementation(async ({ data }: any) => { historyCreates.push(data); return { ...data }; }),
      findMany: vi.fn().mockResolvedValue([
        { id: 'SCH_1', versionFrom: 1, versionTo: 2, valueFrom: null, valueTo: 'x', actorId: 'u_admin', reason: '首次录入标准', createdAt: new Date('2026-09-29T00:00:00Z') },
      ]),
    },
    relation: {
      findUnique: vi.fn().mockImplementation(async () => relation),
    },
    auditLog: {
      create: vi.fn().mockImplementation(async ({ data }: any) => { audits.push(data); return { id: 'AL-1' }; }),
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'AL-H1',
          createdAt: new Date('2026-09-29T12:00:00Z'),
          actorId: 'u_sales',
          detail: { reason: '按客户 PO 录入 ±1%', from: null, to: { qtyTolerance: [{ minQty: 5001, maxQty: null, pct: 1 }] } },
        },
      ]),
    },
    // ★ 标准写 + 审计必须同事务（见 writeCustomerToleranceStandard 的注释）
    $transaction: vi.fn().mockImplementation(async (fn: any) => fn({ relation: { update: txRelationUpdate }, auditLog: { create: txAuditCreate } })),
  };

  const app = express();
  app.use(express.json());
  app.use('/api/v1/tolerance', createToleranceStandardRouter({ prisma, requireAuth: true }));
  return {
    app, prisma, audits, historyCreates, relationWrites,
    getStored: () => stored,
    getRelation: () => relation,
  };
}

describe('公差标准路由鉴权（仅 JWT，fail-closed）', () => {
  it.each([
    ['GET', '/api/v1/tolerance/internal-standard'],
    ['PUT', '/api/v1/tolerance/internal-standard'],
    ['GET', '/api/v1/tolerance/history'],
    ['GET', '/api/v1/tolerance/customer-standard?relationId=REL_C1'],
    ['PUT', '/api/v1/tolerance/customer-standard'],
  ])('%s %s 无 token → 401', async (method, path) => {
    const { app } = makeApp();
    const res = await request(app)[method.toLowerCase() as 'get'](path);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });
});

describe('GET /internal-standard', () => {
  it('★★ 未配置 ⇒ 200 + value:null + isDefault:true（★ 不是 500，也不造默认值）', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/tolerance/internal-standard').set(auth(adminToken));
    expect(res.status, '未配置是正常状态，不是错误').toBe(200);
    expect(res.body.value, '★ 造默认值 = 继续用系统假设冒充标准').toBeNull();
    expect(res.body.isDefault).toBe(true);
    expect(res.body.version).toBe(0);
  });

  it('★ 已配置（对象形态）⇒ 归一化后返回 + version + isDefault:false', async () => {
    const { app } = makeApp({
      row: {
        id: `${INTERNAL_TOLERANCE_SCOPE}::${INTERNAL_TOLERANCE_KEY}`,
        scope: INTERNAL_TOLERANCE_SCOPE,
        key: INTERNAL_TOLERANCE_KEY,
        valueType: 'json',
        value: VALID_STANDARD,
        encrypted: false,
        version: 3,
        updatedBy: 'u_admin',
        updatedAt: BigInt(1759000000000),
      },
    });
    const res = await request(app).get('/api/v1/tolerance/internal-standard').set(auth(salesToken));
    expect(res.status).toBe(200);
    expect(res.body.isDefault).toBe(false);
    expect(res.body.version).toBe(3);
    expect(res.body.value.qtyTolerance).toHaveLength(2);
    expect(res.body.updatedBy).toBe('u_admin');
    // ★ updatedAt 是 BigInt ⇒ 必须是数字（否则 res.json 会抛 TypeError）
    expect(typeof res.body.updatedAt).toBe('number');
    expect(res.body.updatedAt).toBe(1759000000000);
  });

  it('★★ 值以**字符串**存（SystemConfig 真实存储契约）⇒ 读回仍能归一化', async () => {
    // 真源：config/systemConfigService.ts 的 set()：valueType='json' 时 JSON.stringify(value)
    const { app } = makeApp({
      row: {
        id: `${INTERNAL_TOLERANCE_SCOPE}::${INTERNAL_TOLERANCE_KEY}`,
        scope: INTERNAL_TOLERANCE_SCOPE,
        key: INTERNAL_TOLERANCE_KEY,
        valueType: 'json',
        value: JSON.stringify(VALID_STANDARD), // ← 字符串，不是对象
        encrypted: false,
        version: 1,
        updatedAt: BigInt(1759000000000),
      },
    });
    const res = await request(app).get('/api/v1/tolerance/internal-standard').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.value?.qtyTolerance?.[0].pct, '读不到 ⇒ 门禁永远按「未判定」卡住').toBe(5);
  });
});

describe('PUT /internal-standard', () => {
  it('★ admin 合法写入 ⇒ 200 + version；值被归一化后落库', async () => {
    const { app, getStored } = makeApp();
    const res = await request(app)
      .put('/api/v1/tolerance/internal-standard')
      .set(auth(adminToken))
      .send({ value: VALID_STANDARD, reason: '首次录入内部公差标准' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe(1);

    const s = getStored();
    expect(s.scope).toBe(INTERNAL_TOLERANCE_SCOPE);
    expect(s.key).toBe(INTERNAL_TOLERANCE_KEY);
    expect(s.valueType).toBe('json');
    // ★ 按真实存储契约：json 值存成字符串
    expect(typeof s.value).toBe('string');
    expect(JSON.parse(s.value).qtyTolerance).toHaveLength(2);
    expect(s.updatedBy).toBe('u_admin');
    expect(s.auditReason).toBe('首次录入内部公差标准');
  });

  it('★ owner 也放行（SUPER_ADMIN 代码级全通）', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put('/api/v1/tolerance/internal-standard')
      .set(auth(ownerToken))
      .send({ value: VALID_STANDARD, reason: '超管录入内部标准' });
    expect(res.status).toBe(200);
  });

  it('★★ 业务员（sales）无 scope ⇒ 403 SCOPE_DENIED + 越权审计（不得只靠 UI 灰显）', async () => {
    const { app, audits, getStored } = makeApp();
    const res = await request(app)
      .put('/api/v1/tolerance/internal-standard')
      .set(auth(salesToken))
      .send({ value: VALID_STANDARD, reason: '业务员想自己改标准' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('SCOPE_DENIED');
    expect(res.body.message).toContain('settings:tolerance:write');
    expect(getStored(), '越权请求不许落库').toBeNull();
    expect(audits.length, '越权尝试必须留痕').toBe(1);
    expect(audits[0].action).toBe('TOLERANCE_STANDARD_WRITE_DENIED');
  });

  it('★ 财务（finance）也无 scope ⇒ 403', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put('/api/v1/tolerance/internal-standard')
      .set(auth(financeToken))
      .send({ value: VALID_STANDARD, reason: '财务想改标准' });
    expect(res.status).toBe(403);
  });

  it('★ reason 少于 5 字 ⇒ 400（与 MOQ 配置同口径）', async () => {
    const { app, getStored } = makeApp();
    const res = await request(app)
      .put('/api/v1/tolerance/internal-standard')
      .set(auth(adminToken))
      .send({ value: VALID_STANDARD, reason: '改一下' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_VALUE');
    expect(res.body.message).toContain('5 个字');
    expect(getStored()).toBeNull();
  });

  it('★★ 空档位（qtyTolerance: []）⇒ 400 —— 不许把"没有标准"写成一个空壳', async () => {
    const { app, getStored } = makeApp();
    const res = await request(app)
      .put('/api/v1/tolerance/internal-standard')
      .set(auth(adminToken))
      .send({ value: { qtyTolerance: [] }, reason: '空档位不该被接受' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_VALUE');
    expect(getStored()).toBeNull();
  });

  it('★ value 不是对象 ⇒ 400', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put('/api/v1/tolerance/internal-standard')
      .set(auth(adminToken))
      .send({ value: 'not-an-object', reason: '形状不对' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('value 必填且必须为对象');
  });

  it('★ 坏档位被丢掉、好档位留下（归一化真的生效）', async () => {
    const { app, getStored } = makeApp();
    const res = await request(app)
      .put('/api/v1/tolerance/internal-standard')
      .set(auth(adminToken))
      .send({
        value: { qtyTolerance: [{ minQty: 1, maxQty: 999, pct: 5 }, { minQty: 'bad', pct: 3 }] },
        reason: '坏档位应被丢掉',
      });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(getStored().value);
    expect(parsed.qtyTolerance, '★ 坏档位没被丢掉 ⇒ 标准表会带进脏数据').toHaveLength(1);
    expect(parsed.qtyTolerance[0].pct).toBe(5);
  });

  it('★ 重复写入 ⇒ 走 update 路径、version 递增、写历史', async () => {
    const { app, historyCreates, getStored } = makeApp();
    await request(app).put('/api/v1/tolerance/internal-standard').set(auth(adminToken))
      .send({ value: VALID_STANDARD, reason: '第一次录入标准' });
    const res = await request(app).put('/api/v1/tolerance/internal-standard').set(auth(adminToken))
      .send({ value: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 4 }] }, reason: '第二次调整标准' });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(getStored().version).toBe(2);
    expect(historyCreates.length, '第二次（已有行）必须写变更历史').toBe(1);
  });
});

describe('GET /history', () => {
  it('⇒ 200 + items 数组（append-only 只读，登录即可读）', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/tolerance/history').set(auth(salesToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items[0].reason).toBe('首次录入标准');
  });

  it('★ 只查本 key 的历史（configId = global::tolerance.internal_standard）', async () => {
    const { app, prisma } = makeApp();
    await request(app).get('/api/v1/tolerance/history').set(auth(adminToken));
    expect(prisma.systemConfigHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { configId: `${INTERNAL_TOLERANCE_SCOPE}::${INTERNAL_TOLERANCE_KEY}` } }),
    );
  });
});

/**
 * ★★ 客户公差标准（P0 那一轨）—— 2026-09-29 晚新增。
 *   判据取向与上半同：每条都写成「实现偷懒就会红」。
 *   本组要钉住的三件最容易做错的事：
 *     ① **没有出厂默认**（未录就是未录；我们不许替客户编标准）
 *     ② **改它必须留痕**（标准写与审计同事务；缺操作人直接拒）
 *     ③ **不许把"字段没传"当成"清空"**（一次前端笔误会静默删掉客户的 P0 约束）
 */
describe('GET /customer-standard（读：P0 那一轨）', () => {
  it('★ 未录 ⇒ 200 + value:null + isUnset:true（★ 客户标准**没有**出厂默认）', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/tolerance/customer-standard?relationId=REL_C1').set(auth(salesToken));
    expect(res.status).toBe(200);
    expect(res.body.value, '客户的约定只能由客户给 —— 不替它编默认').toBeNull();
    expect(res.body.isUnset).toBe(true);
    expect(res.body.customerName).toBe('ACME');
  });

  it('★ 已录 ⇒ 归一化后返回 + 变更历史（审计行即历史，方案 A 的代价由此补齐）', async () => {
    const { app } = makeApp({
      relation: {
        id: 'REL_C1', name: 'ACME', deletedAt: null,
        customerAgreementTolerance: { qtyTolerance: [{ minQty: 5001, maxQty: null, pct: 1 }], agreementRef: 'PO-2026-071' },
      },
    });
    const res = await request(app).get('/api/v1/tolerance/customer-standard?relationId=REL_C1').set(auth(salesToken));
    expect(res.status).toBe(200);
    expect(res.body.isUnset).toBe(false);
    expect(res.body.value.qtyTolerance[0]).toEqual({ minQty: 5001, maxQty: null, pct: 1 });
    expect(res.body.value.agreementRef).toBe('PO-2026-071');
    expect(res.body.history[0].reason).toBe('按客户 PO 录入 ±1%');
  });

  it('★ 缺 relationId ⇒ 400（客户标准挂在客户身上，不是全局配置）', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/tolerance/customer-standard').set(auth(salesToken));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('RELATION_ID_REQUIRED');
  });

  it('★ 客户不存在 ⇒ 404（与 400 分开：界面据此给出不同下一步）', async () => {
    const { app } = makeApp({ relation: null });
    const res = await request(app).get('/api/v1/tolerance/customer-standard?relationId=__NOPE__').set(auth(salesToken));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('RELATION_NOT_FOUND');
  });
});

describe('PUT /customer-standard（写：scope relations:write + 审计同事务）', () => {
  const VALID = { qtyTolerance: [{ minQty: 5001, maxQty: null, pct: 1 }], agreementRef: 'PO-2026-071' };

  it('★ 业务员（有 relations:write）合法写入 ⇒ 200 + 落库 + 审计一条', async () => {
    const { app, getRelation, audits } = makeApp();
    const res = await request(app)
      .put('/api/v1/tolerance/customer-standard')
      .set(auth(salesToken))
      .send({ relationId: 'REL_C1', value: VALID, reason: '按客户 2026 年 PO 录入 ±1%' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cleared).toBe(false);

    const rel = getRelation();
    expect(rel.customerAgreementTolerance.qtyTolerance[0].pct, '落库的是归一化后的标准').toBe(1);
    expect(audits.length, '★ 改了 P0 约束却查不到谁改的 = 本仓最不该发生的事').toBe(1);
    expect(audits[0].action).toBe('relation_tolerance_standard_change');
    expect(audits[0].actorId, '★ 必须是真人 —— 不许用 system 占位').toBe('u_sales');
    expect(audits[0].targetId).toBe('REL_C1');
    expect(audits[0].detail.reason).toBe('按客户 2026 年 PO 录入 ±1%');
    expect(audits[0].detail.to).toEqual(expect.objectContaining({ agreementRef: 'PO-2026-071' }));
  });

  it('★★ 标准写与审计**同一事务**（$transaction 必须真的被用上）', async () => {
    const { app, prisma } = makeApp();
    await request(app).put('/api/v1/tolerance/customer-standard').set(auth(salesToken))
      .send({ relationId: 'REL_C1', value: VALID, reason: '验证事务边界' });
    expect(prisma.$transaction, '不走事务 ⇒ 可能出现"标准改了但没留痕"').toHaveBeenCalled();
  });

  it('★★ 财务（无 relations:write）⇒ 403 SCOPE_DENIED + 越权审计 + **不落库**', async () => {
    const { app, audits, getRelation } = makeApp();
    const res = await request(app)
      .put('/api/v1/tolerance/customer-standard')
      .set(auth(financeToken))
      .send({ relationId: 'REL_C1', value: VALID, reason: '财务想改客户标准' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('SCOPE_DENIED');
    expect(res.body.message).toContain('relations:write');
    expect(getRelation().customerAgreementTolerance, '越权请求不许落库').toBeNull();
    expect(audits.length, '越权尝试必须留痕').toBe(1);
    expect(audits[0].action).toBe('CUSTOMER_TOLERANCE_WRITE_DENIED');
    expect(audits[0].targetId).toBe('REL_C1');
  });

  it('★ owner / admin 代码级全通', async () => {
    for (const t of [ownerToken, adminToken]) {
      const { app } = makeApp();
      const res = await request(app).put('/api/v1/tolerance/customer-standard').set(auth(t))
        .send({ relationId: 'REL_C1', value: VALID, reason: '超管录入客户标准' });
      expect(res.status).toBe(200);
    }
  });

  it('★ reason < 5 字 ⇒ 400 且不落库', async () => {
    const { app, getRelation } = makeApp();
    const res = await request(app).put('/api/v1/tolerance/customer-standard').set(auth(salesToken))
      .send({ relationId: 'REL_C1', value: VALID, reason: '改一下' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('5 个字');
    expect(getRelation().customerAgreementTolerance).toBeNull();
  });

  it('★★★ value **没传**（undefined）⇒ 400 —— 绝不许把"字段没传"当成"清空"', async () => {
    const { app, getRelation } = makeApp({
      relation: { id: 'REL_C1', name: 'ACME', deletedAt: null, customerAgreementTolerance: { qtyTolerance: [{ minQty: 0, maxQty: null, pct: 1 }] } },
    });
    const res = await request(app).put('/api/v1/tolerance/customer-standard').set(auth(salesToken))
      .send({ relationId: 'REL_C1', reason: '忘了带 value' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_VALUE');
    expect(getRelation().customerAgreementTolerance, '★ 一次前端笔误不许静默删掉客户的 P0 约束').not.toBeNull();
  });

  it('★ 显式清空（value=null）⇒ 200 + cleared + 落库为 null（并留痕）', async () => {
    const { app, getRelation, audits } = makeApp({
      relation: { id: 'REL_C1', name: 'ACME', deletedAt: null, customerAgreementTolerance: { qtyTolerance: [{ minQty: 0, maxQty: null, pct: 1 }] } },
    });
    const res = await request(app).put('/api/v1/tolerance/customer-standard').set(auth(salesToken))
      .send({ relationId: 'REL_C1', value: null, reason: '客户取消该条款，故清空' });
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
    expect(getRelation().customerAgreementTolerance).toBeNull();
    expect(audits[0].detail.from, '清空也要留下"从什么变成什么"').not.toBeNull();
  });

  it('★★ 空壳 / 坏形状 ⇒ 400 且不落库（★ 落进去会让取数链当"有标准但读不出"⇒ 反而卡死出运）', async () => {
    for (const bad of [{ qtyTolerance: [] }, { qtyTolerance: [{ minQty: 'bad', pct: 3 }] }, 'not-an-object']) {
      const { app, getRelation } = makeApp();
      const res = await request(app).put('/api/v1/tolerance/customer-standard').set(auth(salesToken))
        .send({ relationId: 'REL_C1', value: bad as any, reason: '坏形状不该被接受' });
      expect(res.status, `坏形状 ${JSON.stringify(bad)} 必须 400`).toBe(400);
      expect(getRelation().customerAgreementTolerance).toBeNull();
    }
  });

  it('★ 客户不存在 ⇒ 404（不写、不留痕）', async () => {
    const { app, audits } = makeApp({ relation: null });
    const res = await request(app).put('/api/v1/tolerance/customer-standard').set(auth(salesToken))
      .send({ relationId: '__NOPE__', value: VALID, reason: '客户不存在' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('RELATION_NOT_FOUND');
    expect(audits.length).toBe(0);
  });
});
