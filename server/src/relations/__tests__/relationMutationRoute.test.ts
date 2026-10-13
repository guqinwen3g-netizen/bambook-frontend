import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createRelationsRouter } from '../route';

// JWT mock for requireRole on write ops (POST/PUT/DELETE). requireAuth=false
// bypasses the module guard, but requireRole always requires a verified JWT.
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, JWT_SECRET);
function auth() {
  return { Authorization: `Bearer ${ownerToken}` };
}

function makeApp(opts: {
  existing?: any;
  syncFail?: boolean;
  auditFail?: boolean;
  cleanupFail?: boolean;
  onDataChange?: any;
} = {}) {
  const existing = opts.hasOwnProperty('existing') ? opts.existing : { id: 'REL-1', name: 'Acme', category: 'Customer', type: 'Customer', isOrganization: false, deletedAt: null };
  const relationUpsert = vi.fn().mockImplementation(async ({ create, update }: any) => ({ ...create, ...update, id: create?.id || update?.id || 'REL-1', name: create?.name || update?.name || 'Acme', category: create?.category || update?.category || 'Customer', type: create?.type || update?.type || 'Customer', isOrganization: create?.isOrganization ?? update?.isOrganization ?? false, lastInteraction: BigInt(1000), deletedAt: null }));
  const relationUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...(existing || {}), ...data, id: where.id, lastInteraction: BigInt(1000) }));
  const relationFindUnique = vi.fn().mockResolvedValue(existing);
  const entityReferenceUpsert = opts.syncFail ? vi.fn().mockRejectedValue(new Error('SYNC_REJECT')) : vi.fn().mockResolvedValue({});
  const entityLinkUpsert = vi.fn().mockResolvedValue({});
  const entityLinkFindMany = vi.fn().mockResolvedValue([{ id: 'LINK-1' }]);
  const entityReferenceFindMany = vi.fn().mockResolvedValue([{ id: 'REF-1' }]);
  const entityLinkUpdate = opts.cleanupFail ? vi.fn().mockRejectedValue(new Error('CLEANUP_REJECT')) : vi.fn().mockResolvedValue({});
  const entityReferenceUpdate = vi.fn().mockResolvedValue({});
  const auditCreate = opts.auditFail ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT')) : vi.fn().mockResolvedValue({ id: 'AL-1' });
  const tx = {
    relation: { upsert: relationUpsert, update: relationUpdate, findUnique: relationFindUnique },
    entityReference: { upsert: entityReferenceUpsert, findMany: entityReferenceFindMany, update: entityReferenceUpdate },
    entityLink: { upsert: entityLinkUpsert, findMany: entityLinkFindMany, update: entityLinkUpdate },
    auditLog: { create: auditCreate },
  } as any;
  const prisma = {
    relation: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn(), updateMany: vi.fn(), findUnique: relationFindUnique },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  } as any;
  const onDataChange = opts.onDataChange || vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/relations', createRelationsRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange }));
  return { app, prisma, relationUpsert, relationUpdate, relationFindUnique, entityReferenceUpsert, entityLinkUpsert, entityLinkFindMany, entityLinkUpdate, entityReferenceFindMany, entityReferenceUpdate, auditCreate, onDataChange };
}

describe('relationMutationService route POST/PUT/DELETE', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create success → upsert + sync + audit 同事务，onDataChange 成功后触发', async () => {
    const { app, relationUpsert, entityReferenceUpsert, entityLinkUpsert, auditCreate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/relations').set(auth()).send({ id: 'REL-C1', name: 'John', category: 'Customer', type: 'Contact', parentId: 'REL-ORG-1' });
    expect(res.status).toBe(200);
    expect(relationUpsert).toHaveBeenCalledTimes(1);
    expect(entityReferenceUpsert).toHaveBeenCalled();
    expect(entityLinkUpsert).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('create invalid category → 400 INVALID_CATEGORY，不进 transaction/audit/onDataChange', async () => {
    const { app, prisma, auditCreate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/relations').set(auth()).send({ id: 'REL-X', name: 'Bad', category: 'Bad' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CATEGORY');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('create validation failed → 400 VALIDATION_FAILED', async () => {
    const { app, prisma } = makeApp();
    const res = await request(app).post('/api/v1/relations').set(auth()).send({ id: 'REL-X', category: 'Customer' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('create sync reject → 500 CREATE_FAILED，audit/onDataChange 不触发', async () => {
    const { app, auditCreate, onDataChange } = makeApp({ syncFail: true });
    const res = await request(app).post('/api/v1/relations').set(auth()).send({ id: 'REL-C1', name: 'John', category: 'Customer', parentId: 'REL-ORG-1' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('CREATE_FAILED');
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('update success → 只写显式 patch 字段，不清空未传 ERP 主数据', async () => {
    const { app, relationUpdate, auditCreate, onDataChange } = makeApp({ existing: { id: 'REL-1', name: 'Old', category: 'Customer', type: 'Customer', isOrganization: true, tags: ['vip'], contactInfo: 'contact', parentId: 'REL-PARENT', deletedAt: null } });
    const res = await request(app).put('/api/v1/relations/REL-1').set(auth()).send({ name: 'New', category: 'Supplier' });
    expect(res.status).toBe(200);
    expect(relationUpdate).toHaveBeenCalledTimes(1);
    const data = relationUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: 'New', category: 'Supplier' });
    expect(data).not.toHaveProperty('type');
    expect(data).not.toHaveProperty('isOrganization');
    expect(data).not.toHaveProperty('tags');
    expect(data).not.toHaveProperty('contactInfo');
    expect(data).not.toHaveProperty('parentId');
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('update not found/deleted → 404 NOT_FOUND', async () => {
    const { app, auditCreate, onDataChange } = makeApp({ existing: { id: 'REL-1', deletedAt: BigInt(1) } });
    const res = await request(app).put('/api/v1/relations/REL-1').set(auth()).send({ name: 'New', category: 'Customer' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('update reportsToId → 组织架构拖拽汇报线持久化契约（值更新 / null 清空 / 未传不动）', async () => {
    const { app, relationUpdate } = makeApp({ existing: { id: 'REL-1', name: 'John', category: 'Customer', type: 'Contact', isOrganization: false, reportsToId: 'REL-OLD-BOSS', deletedAt: null } });
    // 拖到新汇报对象：白名单含 reportsToId，值透传落库
    const res = await request(app).put('/api/v1/relations/REL-1').set(auth()).send({ reportsToId: 'REL-BOSS-1' });
    expect(res.status).toBe(200);
    expect(relationUpdate.mock.calls[0][0].data.reportsToId).toBe('REL-BOSS-1');
    // 拖到组织根：显式 null 清空汇报线（前端以 null 表达"挂根"——JSON 序列化丢弃 undefined 键）
    const res2 = await request(app).put('/api/v1/relations/REL-1').set(auth()).send({ reportsToId: null });
    expect(res2.status).toBe(200);
    expect(relationUpdate.mock.calls[1][0].data.reportsToId).toBeNull();
    // 未传 reportsToId：hasOwn 语义不动该列（普通表单保存不会误清汇报线）
    const res3 = await request(app).put('/api/v1/relations/REL-1').set(auth()).send({ name: 'Jane' });
    expect(res3.status).toBe(200);
    expect(relationUpdate.mock.calls[2][0].data).not.toHaveProperty('reportsToId');
  });

  it('update audit reject → 500 UPDATE_FAILED，onDataChange 不触发', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).put('/api/v1/relations/REL-1').set(auth()).send({ name: 'New', category: 'Customer' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('UPDATE_FAILED');
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('delete success → soft delete + EntityReference/EntityLink cleanup + audit，同事务成功后 onDataChange', async () => {
    const { app, relationUpdate, entityLinkFindMany, entityLinkUpdate, entityReferenceFindMany, entityReferenceUpdate, auditCreate, onDataChange } = makeApp({ existing: { id: 'REL-1', name: 'Old', category: 'Customer', type: 'Contact', isOrganization: false, deletedAt: null } });
    const res = await request(app).delete('/api/v1/relations/REL-1').set(auth());
    expect(res.status).toBe(200);
    expect(relationUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(BigInt) }) }));
    expect(entityLinkFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ fromType: 'relation.contact', fromId: 'REL-1', status: 'active' }) }));
    expect(entityLinkUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'LINK-1' }, data: expect.objectContaining({ status: 'inactive' }) }));
    expect(entityReferenceFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerType: 'relation.contact', ownerId: 'REL-1', status: 'active' }) }));
    expect(entityReferenceUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'REF-1' }, data: expect.objectContaining({ status: 'inactive' }) }));
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('delete cleanup reject → 500 DELETE_FAILED，audit/onDataChange 不触发', async () => {
    const { app, auditCreate, onDataChange } = makeApp({ cleanupFail: true });
    const res = await request(app).delete('/api/v1/relations/REL-1').set(auth());
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DELETE_FAILED');
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });
});
