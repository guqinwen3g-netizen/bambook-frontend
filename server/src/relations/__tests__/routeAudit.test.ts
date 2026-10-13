import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { syncRelationEntityReferences } from '../../entities/sync';

const RELATIONS = fs.readFileSync(path.resolve(__dirname, '../route.ts'), 'utf-8');
const RELATION_SERVICE = fs.readFileSync(path.resolve(__dirname, '../relationMutationService.ts'), 'utf-8');
const TOOLRUNTIME = fs.readFileSync(path.resolve(__dirname, '../../agent/toolRuntime.ts'), 'utf-8');

// JWT mock for requireRole on write ops (POST/PUT/DELETE). requireAuth=false
// bypasses the module guard, but requireRole always requires a verified JWT.
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, JWT_SECRET);
function auth() {
  return { Authorization: `Bearer ${ownerToken}` };
}

describe('task relations-audit-entitylink-contract: relations service 事务闭环', () => {
  it('3 mutation 都通过 service 内 $transaction', () => {
    const txCount = (RELATION_SERVICE.match(/\.\$transaction/g) || []).length;
    expect(txCount).toBe(3);
  });

  it('无 .catch 吞错残留（sync/cleanup 失败必须传播，不降级 warning）', () => {
    expect(RELATION_SERVICE).not.toContain('.catch(');
  });

  it('create_relation: 业务 upsert + sync(tx) + AuditLog(tx) 全在 $transaction 内', () => {
    const idx = RELATION_SERVICE.indexOf("operation: 'create_relation'");
    const section = RELATION_SERVICE.slice(RELATION_SERVICE.lastIndexOf('$transaction', idx), RELATION_SERVICE.indexOf('return { relation: rel', idx));
    expect(section).toContain('tx.relation.upsert');
    expect(section).toContain('syncRelationEntityReferences');
    expect(section).toContain(', tx);');
    expect(section).toContain('writeRouteAuditLog');
    expect(section).toContain('prisma: tx');
  });

  it('update_relation: existing + update + sync(tx) + AuditLog(tx) 同事务（before+after）', () => {
    const idx = RELATION_SERVICE.indexOf("operation: 'update_relation'");
    const section = RELATION_SERVICE.slice(RELATION_SERVICE.lastIndexOf('$transaction', idx), RELATION_SERVICE.indexOf('return { relation: upd', idx));
    expect(section).toContain('tx.relation.findUnique');
    expect(section).toContain('tx.relation.update');
    expect(section).toContain('syncRelationEntityReferences');
    expect(section).toContain(', tx);');
    expect(section).toContain('before');
    expect(section).toContain('after');
  });

  it('delete_relation: existing + soft delete + EntityLink cleanup + AuditLog(tx) 同事务', () => {
    const idx = RELATION_SERVICE.indexOf("operation: 'delete_relation'");
    const section = RELATION_SERVICE.slice(RELATION_SERVICE.lastIndexOf('$transaction', idx), RELATION_SERVICE.indexOf('return { relation: del', idx));
    expect(section).toContain('tx.relation.findUnique');
    expect(section).toContain('tx.relation.update');
    expect(section).toContain('deletedAt');
    expect(section).toContain('deactivateEntityLinks');
    expect(section).toContain('writeRouteAuditLog');
  });

  it('route 只调用 service，onDataChange 在 service 成功后触发', () => {
    expect(RELATIONS).toContain('createRelation({');
    expect(RELATIONS).toContain('updateRelation({');
    expect(RELATIONS).toContain('deleteRelation({');
    const createStart = RELATIONS.indexOf("router.post('/'");
    const createEnd = RELATIONS.indexOf("router.put('/:id'", createStart);
    const section = RELATIONS.slice(createStart, createEnd);
    expect(section).toContain('if (!result.ok)');
    expect(section.indexOf('onDataChange')).toBeGreaterThan(section.indexOf('if (!result.ok)'));
  });
});

describe('task relations-audit-entitylink-contract: NOT_FOUND 错误契约（404 不漂成 500）', () => {
  it('update + delete statusCodeMap 识别 NOT_FOUND 返回 404', () => {
    const matches = RELATIONS.match(/NOT_FOUND: 404/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('task relations-audit-entitylink-contract: toolRuntime relation.create 事务闭环', () => {
  it('handleRelationCreate 使用 $transaction（业务+sync+AuditLog 同事务）', () => {
    const fnStart = TOOLRUNTIME.indexOf('async function handleRelationCreate');
    const fnEnd = TOOLRUNTIME.indexOf('\nasync function ', fnStart + 100);
    const fnBody = TOOLRUNTIME.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 1200);
    expect(fnBody).toContain('$transaction');
    expect(fnBody).toContain('tx.relation.upsert');
    expect(fnBody).toContain('syncRelationEntityReferences');
    expect(fnBody).toContain(', tx);');
    expect(fnBody).toContain('writeRouteAuditLog');
    expect(fnBody).toContain("operation: 'create_relation'");
  });

  it('错误码稳定可解释（MISSING_ID/MISSING_NAME/MISSING_CATEGORY/CREATE_FAILED）', () => {
    const fnStart = TOOLRUNTIME.indexOf('async function handleRelationCreate');
    const fnEnd = TOOLRUNTIME.indexOf('\nasync function ', fnStart + 100);
    const fnBody = TOOLRUNTIME.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 1200);
    expect(fnBody).toContain("error: 'MISSING_ID'");
    expect(fnBody).toContain("error: 'MISSING_NAME'");
    expect(fnBody).toContain("error: 'MISSING_CATEGORY'");
    expect(fnBody).toContain("error: 'CREATE_FAILED'");
  });

  it('失败返回含 dataSource（用户可解释消息稳定）', () => {
    const fnStart = TOOLRUNTIME.indexOf('async function handleRelationCreate');
    const fnEnd = TOOLRUNTIME.indexOf('\nasync function ', fnStart + 100);
    const fnBody = TOOLRUNTIME.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 1200);
    expect(fnBody).toContain("dataSource: 'bambook-data-center'");
  });
});


describe('task_mqy2aqkz: category 7 选 1 fail closed（route 与 Agent 口径一致）', () => {
  it('route POST/: 非法 category 返回 400 INVALID_CATEGORY，不写 DB/sync/audit', async () => {
    // 真实 route 集成测试
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { createRelationsRouter } = await import('../route');

    const relationUpsert = vi.fn();
    const entityReferenceUpsert = vi.fn();
    const auditLogCreate = vi.fn();
    const txFn = vi.fn(async (fn: any) => fn({
      relation: { upsert: relationUpsert },
      entityReference: { upsert: entityReferenceUpsert },
      entityLink: { upsert: vi.fn() },
      auditLog: { create: auditLogCreate },
    }));
    const prisma = { $transaction: txFn } as any;

    const app = express();
    app.use(express.json());
    app.use('/api/v1/relations', createRelationsRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    const res = await supertest(app).post('/api/v1/relations').set(auth()).send({
      id: 'REL-X', name: 'Test', category: 'InvalidCategory',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CATEGORY');
    // 不写 DB
    expect(relationUpsert).not.toHaveBeenCalled();
    // 不 sync
    expect(entityReferenceUpsert).not.toHaveBeenCalled();
    // 不 audit
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it('route PUT/:id: 非法 category 返回 400 INVALID_CATEGORY', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { createRelationsRouter } = await import('../route');

    const relationUpdate = vi.fn();
    const txFn = vi.fn(async (fn: any) => fn({ relation: { update: relationUpdate, findUnique: vi.fn() } }));
    const prisma = { $transaction: txFn } as any;

    const app = express();
    app.use(express.json());
    app.use('/api/v1/relations', createRelationsRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    const res = await supertest(app).put('/api/v1/relations/REL-1').set(auth()).send({ category: 'BogusType' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CATEGORY');
    expect(relationUpdate).not.toHaveBeenCalled();
  });

  it('route 缺失 category 默认 Other（合法，不报错）', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { createRelationsRouter } = await import('../route');

    const relationUpsert = vi.fn().mockImplementation(async ({ create }: any) => ({ ...create, category: 'Other' }));
    const txFn = vi.fn(async (fn: any) => fn({
      relation: { upsert: relationUpsert },
      entityReference: { upsert: vi.fn().mockResolvedValue({}) },
      entityLink: { upsert: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    }));
    const prisma = { $transaction: txFn } as any;

    const app = express();
    app.use(express.json());
    app.use('/api/v1/relations', createRelationsRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    const res = await supertest(app).post('/api/v1/relations').set(auth()).send({
      id: 'REL-Y', name: 'No Category',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('service 源码含 VALID_RELATION_CATEGORIES 7 枚举 + INVALID_CATEGORY 错误码', () => {
    expect(RELATION_SERVICE).toContain("export const VALID_RELATION_CATEGORIES = new Set(['Customer', 'Supplier', 'Agent', 'Partner', 'Government', 'Internal', 'Other'])");
    expect(RELATION_SERVICE).toContain("code: 'INVALID_CATEGORY'");
  });

  it('Agent 与 route category 口径一致（缺失默认 Other，显式非法拒绝）', () => {
    // Agent handleRelationCreate 也应缺失默认 Other
    const fnStart = TOOLRUNTIME.indexOf('async function handleRelationCreate');
    const fnEnd = TOOLRUNTIME.indexOf('\nasync function ', fnStart + 100);
    const fnBody = TOOLRUNTIME.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 1400);
    // 缺失默认 Other
    expect(fnBody).toMatch(/rawCategory \|\|.*'Other'/);
    // 显式非法返回 MISSING_CATEGORY
    expect(fnBody).toContain("error: 'MISSING_CATEGORY'");
    expect(fnBody).toContain('VALID_CATEGORIES.has(rawCategory)');
  });
});

describe('task relations-audit-entitylink-contract: syncRelationEntityReferences(tx) 真实分支', () => {
  it('传 tx 时逐个 await tx.entityReference/entityLink upsert，不调 tx.$transaction', async () => {
    const entityReferenceUpsert = vi.fn().mockResolvedValue({});
    const entityLinkUpsert = vi.fn().mockResolvedValue({});
    const txTransaction = vi.fn();

    const tx = {
      entityReference: { upsert: entityReferenceUpsert },
      entityLink: { upsert: entityLinkUpsert },
      $transaction: txTransaction,
    } as any;

    // contact（isOrganization:false + parentId）→ 生成 ops
    const relation = {
      id: 'REL-CONTACT-1', name: 'John Doe',
      isOrganization: false, parentId: 'REL-ORG-1', role: 'Manager',
    };

    await syncRelationEntityReferences({} as any, relation, { source: 'route:test' }, tx);

    expect(txTransaction).not.toHaveBeenCalled();
    expect(entityReferenceUpsert).toHaveBeenCalledTimes(1);
    expect(entityLinkUpsert).toHaveBeenCalledTimes(1);
  });

  it('某个 upsert reject 时整体 reject（事务回滚语义）', async () => {
    const entityReferenceUpsert = vi.fn().mockRejectedValue(new Error('SYNC_FAIL'));
    const entityLinkUpsert = vi.fn().mockResolvedValue({});

    const tx = {
      entityReference: { upsert: entityReferenceUpsert },
      entityLink: { upsert: entityLinkUpsert },
    } as any;

    const relation = {
      id: 'REL-CONTACT-1', name: 'John Doe',
      isOrganization: false, parentId: 'REL-ORG-1',
    };

    await expect(syncRelationEntityReferences({} as any, relation, { source: 'route:test' }, tx))
      .rejects.toThrow('SYNC_FAIL');
  });

  it('无 tx 时保持原 prisma.$transaction(ops) 逻辑（向后兼容）', async () => {
    const entityReferenceUpsert = vi.fn().mockResolvedValue({});
    const entityLinkUpsert = vi.fn().mockResolvedValue({});
    const prismaTransaction = vi.fn().mockResolvedValue([]);

    const prisma = {
      entityReference: { upsert: entityReferenceUpsert },
      entityLink: { upsert: entityLinkUpsert },
      $transaction: prismaTransaction,
    } as any;

    const relation = {
      id: 'REL-CONTACT-1', name: 'John Doe',
      isOrganization: false, parentId: 'REL-ORG-1',
    };

    await syncRelationEntityReferences(prisma, relation, { source: 'route:test' });

    expect(prismaTransaction).toHaveBeenCalledTimes(1);
    const opsArg = prismaTransaction.mock.calls[0][0];
    expect(Array.isArray(opsArg)).toBe(true);
    expect(opsArg.length).toBe(2);  // 1 reference + 1 link
  });

  it('organization（isOrganization:true）跳过 sync（无 belongsTo link）', async () => {
    const entityReferenceUpsert = vi.fn();
    const tx = { entityReference: { upsert: entityReferenceUpsert }, entityLink: { upsert: vi.fn() } } as any;

    const org = { id: 'REL-ORG-1', name: 'Acme Corp', isOrganization: true, parentId: null };

    await syncRelationEntityReferences({} as any, org, { source: 'route:test' }, tx);

    expect(entityReferenceUpsert).not.toHaveBeenCalled();
  });

  it('无 parentId 的 contact 跳过 sync', async () => {
    const entityReferenceUpsert = vi.fn();
    const tx = { entityReference: { upsert: entityReferenceUpsert }, entityLink: { upsert: vi.fn() } } as any;

    const contact = { id: 'REL-C1', name: 'John', isOrganization: false, parentId: null };

    await syncRelationEntityReferences({} as any, contact, { source: 'route:test' }, tx);

    expect(entityReferenceUpsert).not.toHaveBeenCalled();
  });
});
