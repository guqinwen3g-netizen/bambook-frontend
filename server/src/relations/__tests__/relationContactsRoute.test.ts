import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRelationsRouter } from '../route';

// JWT mock：owner 拥有全量 scope；viewer 在角色矩阵中无 relations:write（403 用）
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, JWT_SECRET);
const viewerToken = jwt.sign({ userId: 'u2', roles: ['viewer'] }, JWT_SECRET);
function ownerAuth() {
  return { Authorization: `Bearer ${ownerToken}` };
}
function viewerAuth() {
  return { Authorization: `Bearer ${viewerToken}` };
}

function makeApp(prisma: any, onDataChange?: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/relations', createRelationsRouter({ prisma, requireAuth: false, apiKeys: new Set<string>(), onDataChange }));
  return app;
}

function makeContactPrisma(overrides: {
  contacts?: any[];
  relation?: any;
  existingContact?: any;
} = {}) {
  // 可变行集合：create 追加、update 原位替换——供事务内 sync（真源回写）真实查询语义
  const rows: any[] = [...(overrides.contacts ?? [])];
  const existingContact = overrides.existingContact;
  if (existingContact && !rows.some(r => r.id === existingContact.id)) rows.push({ ...existingContact });
  const relation = overrides.relation === undefined
    ? { id: 'SIM-SUP-01', name: '供应商一', isOrganization: true, deletedAt: null }
    : overrides.relation;
  const contactCreate = vi.fn().mockImplementation(async ({ data }: any) => {
    // status 模拟 schema 默认值（Contact.status @default Active）
    const row = { status: 'Active', deletedAt: null, ...data };
    rows.push(row);
    return row;
  });
  const contactUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => {
    const idx = rows.findIndex(r => r.id === where.id);
    const row = { ...(idx >= 0 ? rows[idx] : (existingContact || {})), id: where.id, ...data };
    if (idx >= 0) rows[idx] = row;
    return row;
  });
  // 事务内 sync（syncOrganizationPrimaryContact）的查询语义：在岗（Active+未删）优先 primary
  const contactFindFirstInTx = vi.fn(async ({ where }: any) => {
    return rows.find(r =>
      r.relationId === where.relationId
      && r.deletedAt == null
      && (where.status === undefined || r.status === where.status)
      && (where.isPrimary === undefined || Boolean(r.isPrimary) === where.isPrimary)
    ) ?? null;
  });
  // 真源回写断言锚点：Relation.primaryContact*/contactInfo 冗余刷新
  const relationUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where?.id, ...data }));
  const auditLogCreate = vi.fn().mockResolvedValue({ id: 'AL-1' });
  const txFn = vi.fn(async (fn: any) => fn({
    contact: { create: contactCreate, update: contactUpdate, findFirst: contactFindFirstInTx },
    auditLog: { create: auditLogCreate },
    relation: { update: relationUpdate },
  }));
  const prisma = {
    relation: { findFirst: vi.fn().mockResolvedValue(relation) },
    contact: {
      findMany: vi.fn().mockResolvedValue(rows),
      // 模拟复合 where 语义：id + relationId（跨组织/不存在均返回 null → 404）
      findFirst: vi.fn(async ({ where }: any) => {
        if (!existingContact) return null;
        if (where?.id !== existingContact.id) return null;
        if (where?.relationId && where.relationId !== existingContact.relationId) return null;
        if (where?.deletedAt === null && existingContact.deletedAt != null) return null;
        return existingContact;
      }),
      create: contactCreate,
      update: contactUpdate,
    },
    $transaction: txFn,
  } as any;
  return { prisma, contactCreate, contactUpdate, auditLogCreate, txFn, relationUpdate };
}

describe('GET /api/v1/relations/:id/contacts（Contact 表通讯录列表）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('返回该组织的 Contact 行（isPrimary desc + name asc，排除软删），BigInt 序列化为 number', async () => {
    const { prisma } = makeContactPrisma({
      contacts: [
        { id: 'SIM-CTC-09A', relationId: 'SIM-SUP-01', name: '王建军', title: '销售经理', email: 'sales1@sim-sup-01.example.cn', isPrimary: true, isDecisionMaker: true, tags: ['supplier-sales'], status: 'Active', createdAt: BigInt(1780000000000), updatedAt: BigInt(1780000000000), deletedAt: null },
        { id: 'SIM-CTC-09B', relationId: 'SIM-SUP-01', name: '张伟国', title: '品控主管', email: 'qc1@sim-sup-01.example.cn', isPrimary: false, isDecisionMaker: false, tags: ['supplier-qc'], status: 'Active', createdAt: BigInt(1780000000001), updatedAt: BigInt(1780000000001), deletedAt: null },
      ],
    });
    const res = await request(makeApp(prisma)).get('/api/v1/relations/SIM-SUP-01/contacts');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.contacts).toHaveLength(2);
    expect(res.body.contacts[0]).toMatchObject({ id: 'SIM-CTC-09A', name: '王建军', isPrimary: true });
    expect(res.body.contacts[1]).toMatchObject({ id: 'SIM-CTC-09B', name: '张伟国' });
    expect(res.body.contacts[0].createdAt).toBe(1780000000000);
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { relationId: 'SIM-SUP-01', deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    });
  });
});

describe('POST /api/v1/relations/:id/contacts（创建联系人）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('缺 name → 400 VALIDATION_FAILED，不进事务/审计', async () => {
    const { prisma, txFn } = makeContactPrisma();
    const res = await request(makeApp(prisma))
      .post('/api/v1/relations/SIM-SUP-01/contacts')
      .set(ownerAuth())
      .send({ title: '销售经理' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(txFn).not.toHaveBeenCalled();
  });

  it('owner 创建成功 → Contact.create（CTC_ 前缀）+ AuditLog 同事务，onDataChange 触发', async () => {
    const { prisma, contactCreate, auditLogCreate, txFn, relationUpdate } = makeContactPrisma();
    const onDataChange = vi.fn();
    const res = await request(makeApp(prisma, onDataChange))
      .post('/api/v1/relations/SIM-SUP-01/contacts')
      .set(ownerAuth())
      .send({ name: '测试联系人', title: '销售经理', email: 'test@sim-sup-01.example.cn', tags: ['test'], isPrimary: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.contact).toMatchObject({ name: '测试联系人', title: '销售经理', isPrimary: true });
    expect(txFn).toHaveBeenCalledTimes(1);
    expect(contactCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        relationId: 'SIM-SUP-01',
        name: '测试联系人',
        title: '销售经理',
        isPrimary: true,
      }),
    }));
    const createdId = contactCreate.mock.calls[0][0].data.id as string;
    expect(createdId.startsWith('CTC_')).toBe(true);
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledWith({ entity: 'relations', action: 'upsert', ids: ['SIM-SUP-01'] });
    // 真源回写（2026-08-31）：新 primary 同事务刷新组织冗余字段，旧轨消费点即时保鲜
    expect(relationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'SIM-SUP-01' },
      data: expect.objectContaining({
        primaryContactName: '测试联系人',
        primaryContactEmail: 'test@sim-sup-01.example.cn',
        contactInfo: '测试联系人 / test@sim-sup-01.example.cn',
      }),
    }));
  });

  it('挂靠组织不存在 → 404 NOT_FOUND，不进事务', async () => {
    const { prisma, txFn } = makeContactPrisma({ relation: null });
    const res = await request(makeApp(prisma))
      .post('/api/v1/relations/REL-MISSING/contacts')
      .set(ownerAuth())
      .send({ name: '张三' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(txFn).not.toHaveBeenCalled();
  });

  it('无 relations:write（viewer JWT）→ 403 FORBIDDEN；无 JWT → 401', async () => {
    const { prisma } = makeContactPrisma();
    const forbidden = await request(makeApp(prisma))
      .post('/api/v1/relations/SIM-SUP-01/contacts')
      .set(viewerAuth())
      .send({ name: '张三' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('FORBIDDEN');

    const unauthorized = await request(makeApp(prisma))
      .post('/api/v1/relations/SIM-SUP-01/contacts')
      .send({ name: '张三' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.error).toBe('UNAUTHORIZED');
  });
});

describe('PATCH/DELETE /api/v1/relations/:id/contacts/:contactId（部分更新与软删）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PATCH 部分更新 → 只写显式字段 + updatedAt，审计 before/after 留痕', async () => {
    const { prisma, contactUpdate, auditLogCreate } = makeContactPrisma({
      existingContact: { id: 'SIM-CTC-09A', relationId: 'SIM-SUP-01', name: '王建军', title: '销售经理', email: 'sales1@sim-sup-01.example.cn', isPrimary: true, deletedAt: null },
    });
    const res = await request(makeApp(prisma))
      .patch('/api/v1/relations/SIM-SUP-01/contacts/SIM-CTC-09A')
      .set(ownerAuth())
      .send({ title: '大客户经理' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(contactUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'SIM-CTC-09A' },
      data: expect.objectContaining({ title: '大客户经理' }),
    }));
    const data = contactUpdate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('name');
    expect(data).not.toHaveProperty('email');
    expect(typeof data.updatedAt).toBe('bigint');
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
  });

  it('PATCH name 置空 → 400；PATCH/DELETE 目标不存在或跨组织 → 404', async () => {
    const { prisma } = makeContactPrisma({
      existingContact: { id: 'SIM-CTC-09A', relationId: 'SIM-SUP-01', name: '王建军', deletedAt: null },
    });
    const app = makeApp(prisma);

    const emptyName = await request(app)
      .patch('/api/v1/relations/SIM-SUP-01/contacts/SIM-CTC-09A')
      .set(ownerAuth())
      .send({ name: '   ' });
    expect(emptyName.status).toBe(400);
    expect(emptyName.body.error).toBe('VALIDATION_FAILED');

    const missing = await request(app)
      .patch('/api/v1/relations/SIM-SUP-01/contacts/CTC-GONE')
      .set(ownerAuth())
      .send({ title: 'x' });
    expect(missing.status).toBe(404);

    const crossOrg = await request(app)
      .delete('/api/v1/relations/SIM-SUP-02/contacts/SIM-CTC-09A')
      .set(ownerAuth());
    expect(crossOrg.status).toBe(404);
  });

  it('DELETE → 软删（deletedAt=BigInt）而非物理删除，onDataChange 触发', async () => {
    const { prisma, contactUpdate, txFn, relationUpdate } = makeContactPrisma({
      existingContact: { id: 'SIM-CTC-09A', relationId: 'SIM-SUP-01', name: '王建军', deletedAt: null },
    });
    const onDataChange = vi.fn();
    const res = await request(makeApp(prisma, onDataChange))
      .delete('/api/v1/relations/SIM-SUP-01/contacts/SIM-CTC-09A')
      .set(ownerAuth());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(txFn).toHaveBeenCalledTimes(1);
    expect(contactUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'SIM-CTC-09A' },
    }));
    const deletedData = contactUpdate.mock.calls[0][0].data;
    expect(typeof deletedData.deletedAt).toBe('bigint');
    expect(typeof res.body.contact.deletedAt).toBe('number');
    expect(onDataChange).toHaveBeenCalledWith({ entity: 'relations', action: 'delete', ids: ['SIM-SUP-01'] });
    // 真源回写（2026-08-31）：删除唯一联系人后组织冗余字段清空（全员离岗 → 空主联系人）
    expect(relationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'SIM-SUP-01' },
      data: expect.objectContaining({ primaryContactName: null, contactInfo: '' }),
    }));
  });
});

describe('GET /:id/expand profileContacts 联系人体系统一', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Contact 表有行 → profileContacts 来源标记 contact（name/title/email/phone/mobile/isPrimary/decisionMaker）', async () => {
    const { prisma } = makeContactPrisma({
      contacts: [
        { id: 'SIM-CTC-09A', relationId: 'SIM-SUP-01', name: '王建军', title: '销售经理', email: 'sales1@sim-sup-01.example.cn', mobile: '138-1000-0000', isPrimary: true, isDecisionMaker: true, deletedAt: null },
      ],
      relation: { id: 'SIM-SUP-01', name: '供应商一', isOrganization: true, deletedAt: null, primaryContactName: '旧文本主联系人', contactInfo: 'legacy@example.cn' },
    });
    const res = await request(makeApp(prisma)).get('/api/v1/relations/SIM-SUP-01/expand?include=contacts');

    expect(res.status).toBe(200);
    expect(res.body.profileContacts).toEqual([
      expect.objectContaining({
        source: 'contact',
        name: '王建军',
        title: '销售经理',
        email: 'sales1@sim-sup-01.example.cn',
        mobile: '138-1000-0000',
        isPrimary: true,
        decisionMaker: true,
      }),
    ]);
    // Contact 表命中时不再拼接 contactInfo 文本兜底
    expect(res.body.profileContacts).toHaveLength(1);
  });

  it('Contact 表零行 → 保留 contactInfo 文本兜底（旧数据兼容）', async () => {
    const { prisma } = makeContactPrisma({
      contacts: [],
      relation: {
        id: 'panda001', name: 'Panda', isOrganization: true, deletedAt: null,
        primaryContactName: '王经理',
        primaryContactEmail: 'wang@pandaclothing.cn',
        contactInfo: 'contact@pandaclothing.cn',
        backupContacts: [{ name: '李助理', email: 'li@pandaclothing.cn' }],
      },
    });
    const res = await request(makeApp(prisma)).get('/api/v1/relations/panda001/expand?include=contacts');

    expect(res.status).toBe(200);
    expect(res.body.profileContacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'primaryContact', name: '王经理' }),
      expect.objectContaining({ source: 'contactInfo', text: 'contact@pandaclothing.cn' }),
      expect.objectContaining({ source: 'backupContacts', name: '李助理' }),
    ]));
  });
});
