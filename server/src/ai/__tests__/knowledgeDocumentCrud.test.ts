/**
 * ERP 知识文档 CRUD（list/update/delete + joinChunks）测试
 *
 * 覆盖服务端真源通路：
 *   - joinChunks 为 splitChunks 的确定性逆运算（roundtrip 恒等）
 *   - listKnowledgeDocuments：active 文档 + 内容重建 + category，排除软删
 *   - updateKnowledgeDocument：标题/正文/分类更新、版本递增、旧 chunk 软删、审计
 *   - deleteKnowledgeDocument：doc + chunks 软删、审计
 *   - 路由契约：PATCH/DELETE 状态码映射 + GET 双源合并
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  splitChunks,
  joinChunks,
  listKnowledgeDocuments,
  updateKnowledgeDocument,
  deleteKnowledgeDocument,
} from '../knowledgeIngestService';
import { createKnowledgeDocumentsRouter } from '../knowledgeDocumentsRoute';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import jwt from 'jsonwebtoken';

// W-C 权限收口：knowledge-documents 路由已叠加 knowledge:read/write scope 门
// （requirePermission 需 req.actor）。路由契约用例统一注入有效 owner JWT 通过 scope 门。
const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);

// ─── joinChunks roundtrip ───

describe('joinChunks · splitChunks 确定性逆运算', () => {
  it.each([
    ['短文本（单 chunk）', 'hello world'],
    ['恰好一个 CHUNK_SIZE', 'A'.repeat(1200)],
    ['跨 chunk 边界', 'B'.repeat(1201)],
    ['长文本多 chunk', '纺织专业知识'.repeat(800)],
    ['含换行与特殊字符', 'line1\nline2\t€¥$'.repeat(300)],
  ])('%s → split→join 恒等', (_label, text) => {
    expect(joinChunks(splitChunks(text))).toBe(text.trim());
  });

  it('空输入 → 空字符串', () => {
    expect(joinChunks([])).toBe('');
  });
});

// ─── mock helpers ───

const NOW = Date.now();

function makeDoc(overrides: Record<string, any> = {}) {
  return {
    id: 'kd_1',
    title: '原标题',
    sourceType: 'manual',
    checksum: 'cs_old',
    version: 1,
    status: 'active',
    metadata: { category: 'Policy' },
    deletedAt: null,
    createdAt: new Date(NOW - 10000),
    updatedAt: new Date(NOW - 5000),
    chunks: [
      { id: 'kc_kd_1_0', documentId: 'kd_1', chunkIndex: 0, content: '原正文', deletedAt: null },
    ],
    ...overrides,
  };
}

function makeCrudPrisma(doc: any) {
  const state = { doc, chunksDeleted: false, docDeleted: false };
  const auditLogCreate = vi.fn(async () => ({ id: 'alog_crud' }));
  const kdUpdate = vi.fn(async ({ data }: any) => ({ ...state.doc, ...data, updatedAt: new Date(NOW) }));
  const kcUpdateMany = vi.fn(async () => {
    state.chunksDeleted = true;
    return { count: 1 };
  });
  const kcCreate = vi.fn(async () => ({}));
  const tx = {
    knowledgeDocument: {
      findFirst: vi.fn(async () => (state.docDeleted ? null : state.doc)),
      update: kdUpdate,
    },
    knowledgeChunk: { updateMany: kcUpdateMany, create: kcCreate },
    auditLog: { create: auditLogCreate },
  };
  return {
    state,
    knowledgeDocument: tx.knowledgeDocument,
    knowledgeChunk: tx.knowledgeChunk,
    auditLog: tx.auditLog,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  } as any;
}

// ─── listKnowledgeDocuments ───

describe('listKnowledgeDocuments', () => {
  it('返回 active 文档：内容重建 + category + 时间戳转 ms', async () => {
    const doc = makeDoc({
      chunks: [
        { chunkIndex: 0, content: 'A'.repeat(1200), deletedAt: null },
        { chunkIndex: 1, content: 'A'.repeat(100) + 'tail', deletedAt: null },
      ],
    });
    const findMany = vi.fn(async () => [doc]);
    const prisma = { knowledgeDocument: { findMany } } as any;
    const records = await listKnowledgeDocuments({ prisma });
    expect(records).toHaveLength(1);
    expect(records[0].content).toBe('A'.repeat(1200) + 'tail');
    expect(records[0].category).toBe('Policy');
    expect(records[0].updatedAt).toBe(NOW - 5000);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ deletedAt: null, status: 'active' });
  });

  it('软删 chunk 不参与内容重建', async () => {
    const doc = makeDoc({
      chunks: [
        { chunkIndex: 0, content: '保留', deletedAt: null },
        { chunkIndex: 1, content: 'X'.repeat(100) + '已删', deletedAt: NOW },
      ],
    });
    const prisma = { knowledgeDocument: { findMany: vi.fn(async () => [doc]) } } as any;
    const records = await listKnowledgeDocuments({ prisma });
    expect(records[0].content).toBe('保留');
    expect(records[0].chunkCount).toBe(1);
  });
});

// ─── updateKnowledgeDocument ───

describe('updateKnowledgeDocument', () => {
  it('正文更新：旧 chunk 软删 + 新 chunk 重建 + 版本递增 + 审计', async () => {
    const prisma = makeCrudPrisma(makeDoc());
    const result = await updateKnowledgeDocument({
      prisma,
      documentId: 'kd_1',
      input: { title: '新标题', text: '新正文内容', category: undefined, metadata: { category: 'Product' } },
      actorId: 'user_1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.version).toBe(2);
    expect(result.result.chunkCount).toBe(1);
    expect(prisma.state.chunksDeleted).toBe(true);
    // 新 chunk id 携带版本号，避免与软删旧 chunk 主键冲突
    expect(prisma.knowledgeChunk.create.mock.calls[0][0].data.id).toBe('kc_kd_1_2_0');
    // 文档更新：标题 + checksum + version
    expect(prisma.knowledgeDocument.update.mock.calls[0][0].data).toMatchObject({
      title: '新标题',
      version: 2,
    });
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('仅标题更新：不重建 chunk，但版本递增', async () => {
    const prisma = makeCrudPrisma(makeDoc());
    const result = await updateKnowledgeDocument({
      prisma,
      documentId: 'kd_1',
      input: { title: '仅改标题' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.version).toBe(2);
    expect(prisma.state.chunksDeleted).toBe(false);
    expect(prisma.knowledgeChunk.create).not.toHaveBeenCalled();
  });

  it('NOT_FOUND：文档不存在', async () => {
    const prisma = makeCrudPrisma(makeDoc());
    prisma.state.doc = null;
    const result = await updateKnowledgeDocument({
      prisma,
      documentId: 'kd_missing',
      input: { title: 'x' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('INVALID_INPUT：空更新载荷', async () => {
    const result = await updateKnowledgeDocument({
      prisma: makeCrudPrisma(makeDoc()),
      documentId: 'kd_1',
      input: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('INVALID_INPUT：空标题', async () => {
    const result = await updateKnowledgeDocument({
      prisma: makeCrudPrisma(makeDoc()),
      documentId: 'kd_1',
      input: { title: '   ' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});

// ─── deleteKnowledgeDocument ───

describe('deleteKnowledgeDocument', () => {
  it('doc + chunks 同步软删 + 审计留痕', async () => {
    const prisma = makeCrudPrisma(makeDoc());
    const result = await deleteKnowledgeDocument({ prisma, documentId: 'kd_1', actorId: 'user_1' });
    expect(result.ok).toBe(true);
    expect(prisma.state.chunksDeleted).toBe(true);
    const docUpdate = prisma.knowledgeDocument.update.mock.calls[0][0];
    expect(typeof docUpdate.data.deletedAt).toBe('number');
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArg = prisma.auditLog.create.mock.calls[0][0].data;
    expect(auditArg.action).toBe('knowledge_delete');
    expect(auditArg.targetId).toBe('kd_1');
  });

  it('NOT_FOUND：文档不存在或已删除', async () => {
    const prisma = makeCrudPrisma(makeDoc());
    prisma.state.doc = null;
    const result = await deleteKnowledgeDocument({ prisma, documentId: 'kd_missing' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

// ─── 路由契约 ───

describe('knowledge-documents 路由契约（PATCH/DELETE/GET 合并）', () => {
  async function makeApp(prisma: any) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-crud-'));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.headers.authorization = req.headers.authorization || `Bearer ${ownerToken}`;
      next();
    });
    app.use('/api/v1/knowledge-documents', createKnowledgeDocumentsRouter({
      uploadDir: dir,
      requireAuth: false,
      apiKeys: new Set(),
      prisma,
    }));
    return app;
  }

  it('PATCH /:docId 成功 → 200 { ok, version }', async () => {
    const prisma = makeCrudPrisma(makeDoc());
    const app = await makeApp(prisma);
    const res = await request(app)
      .patch('/api/v1/knowledge-documents/kd_1')
      .send({ title: '新标题', text: '新正文', category: 'Product' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe(2);
  });

  it('PATCH 不存在 → 404 NOT_FOUND', async () => {
    const prisma = makeCrudPrisma(makeDoc());
    prisma.state.doc = null;
    const app = await makeApp(prisma);
    const res = await request(app)
      .patch('/api/v1/knowledge-documents/kd_missing')
      .send({ title: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('PATCH 空载荷 → 400 INVALID_INPUT', async () => {
    const app = await makeApp(makeCrudPrisma(makeDoc()));
    const res = await request(app)
      .patch('/api/v1/knowledge-documents/kd_1')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_INPUT');
  });

  it('DELETE 成功 → 200；重复删除 → 404', async () => {
    const prisma = makeCrudPrisma(makeDoc());
    // delete 软删后 findFirst 应返回 null —— 模拟状态联动
    const origUpdate = prisma.knowledgeDocument.update.getMockImplementation();
    prisma.knowledgeDocument.update = vi.fn(async (args: any) => {
      if (args?.data?.deletedAt) prisma.state.docDeleted = true;
      return origUpdate!(args);
    });
    const app = await makeApp(prisma);
    const first = await request(app).delete('/api/v1/knowledge-documents/kd_1');
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    const second = await request(app).delete('/api/v1/knowledge-documents/kd_1');
    expect(second.status).toBe(404);
  });

  it('GET / 合并 upload + erp 双源并标记 origin', async () => {
    const erpDoc = makeDoc();
    const prisma = {
      knowledgeDocument: { findMany: vi.fn(async () => [erpDoc]) },
    } as any;
    const app = await makeApp(prisma);
    const res = await request(app).get('/api/v1/knowledge-documents');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const erp = res.body.documents.find((d: any) => d.origin === 'erp');
    expect(erp).toBeDefined();
    expect(erp.title).toBe('原标题');
    expect(erp.content).toBe('原正文');
    expect(erp.category).toBe('Policy');
  });
});
