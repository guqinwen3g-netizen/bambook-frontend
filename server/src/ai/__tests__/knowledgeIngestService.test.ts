import { describe, it, expect, vi } from 'vitest';
import { ingestKnowledgeDocument, splitChunks, computeChecksum } from '../knowledgeIngestService';
import express from 'express';
import request from 'supertest';
import { createKnowledgeDocumentsRouter } from '../knowledgeDocumentsRoute';
import jwt from 'jsonwebtoken';

// W-C 权限收口：knowledge-documents 路由已叠加 knowledge:read/write scope 门
// （requirePermission 需 req.actor）。路由契约用例统一注入有效 owner JWT 通过 scope 门。
const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

function makeMockPrisma(overrides: Record<string, any> = {}) {
  const auditLogCreate = vi.fn(async () => ({ id: 'alog_test' }));
  const kdCreate = vi.fn(async (args: any) => ({ id: args.data.id, ...args.data }));
  const kcCreate = vi.fn(async () => ({}));
  const kdFindFirst = vi.fn(async () => null);
  const kaclCreate = vi.fn(async () => ({}));
  return {
    knowledgeDocument: { findFirst: kdFindFirst, create: kdCreate },
    knowledgeChunk: { create: kcCreate },
    knowledgeAcl: { create: kaclCreate },
    auditLog: { create: auditLogCreate },
    $transaction: vi.fn(async (fn: any) => fn({
      knowledgeDocument: { findFirst: kdFindFirst, create: kdCreate },
      knowledgeChunk: { create: kcCreate },
      knowledgeAcl: { create: kaclCreate },
      auditLog: { create: auditLogCreate },
    })),
    ...overrides,
  } as any;
}

describe('knowledgeIngestService · chunk split', () => {
  it('splitChunks: short text → 1 chunk', () => {
    const chunks = splitChunks('hello world');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
  });

  it('splitChunks: long text → multiple chunks with overlap', () => {
    const long = 'A'.repeat(3000);
    const chunks = splitChunks(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].chunkIndex).toBe(1);
  });

  it('splitChunks: empty → []', () => {
    expect(splitChunks('')).toEqual([]);
  });

  it('computeChecksum: deterministic', () => {
    expect(computeChecksum('t', 'x')).toBe(computeChecksum('t', 'x'));
    expect(computeChecksum('t', 'x')).not.toBe(computeChecksum('t', 'y'));
  });
});

describe('knowledgeIngestService · ingestKnowledgeDocument', () => {
  it('success: document + chunks + audit in same transaction', async () => {
    const prisma = makeMockPrisma();
    const result = await ingestKnowledgeDocument({
      prisma,
      input: { title: 'Test Doc', text: 'Some content here.' },
      actorId: 'user_1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.documentId).toMatch(/^kd_/);
    expect(result.result.chunkCount).toBeGreaterThanOrEqual(1);
    expect(prisma.knowledgeDocument.create).toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('scopes → KnowledgeAcl created in same tx', async () => {
    const prisma = makeMockPrisma();
    const result = await ingestKnowledgeDocument({
      prisma,
      input: { title: 'Scoped', text: 'content', scopes: ['public', 'team'] },
    });
    expect(result.ok).toBe(true);
    expect((prisma as any).knowledgeAcl.create).toHaveBeenCalledTimes(2);
  });

  it('INVALID_INPUT: missing title', async () => {
    const result = await ingestKnowledgeDocument({
      prisma: makeMockPrisma(),
      input: { title: '', text: 'content' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('INVALID_INPUT: missing text', async () => {
    const result = await ingestKnowledgeDocument({
      prisma: makeMockPrisma(),
      input: { title: 'Title', text: '' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('DUPLICATE_CHECKSUM: same title+text exists', async () => {
    const prisma = makeMockPrisma({
      $transaction: vi.fn(async (fn: any) => fn({
        knowledgeDocument: { findFirst: vi.fn(async () => ({ id: 'kd_existing' })), create: vi.fn() },
        knowledgeChunk: { create: vi.fn() },
        knowledgeAcl: { create: vi.fn() },
        auditLog: { create: vi.fn() },
      })),
    });
    const result = await ingestKnowledgeDocument({
      prisma,
      input: { title: 'Dup', text: 'same' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.error.code).toBe('DUPLICATE_CHECKSUM');
  });

  it('AUDIT_FAILED: audit throws → rollback', async () => {
    const prisma = makeMockPrisma({
      $transaction: vi.fn(async (fn: any) => fn({
        knowledgeDocument: { findFirst: vi.fn(async () => null), create: vi.fn(async (a: any) => ({ id: a.data.id })) },
        knowledgeChunk: { create: vi.fn(async () => ({})) },
        auditLog: { create: vi.fn(async () => { throw new Error('DB down'); }) },
      })),
    });
    const result = await ingestKnowledgeDocument({
      prisma,
      input: { title: 'Audit Fail', text: 'content' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.error.code).toBe('AUDIT_FAILED');
  });

  it('CREATE_FAILED: unexpected error', async () => {
    const prisma = makeMockPrisma({
      $transaction: vi.fn(async () => { throw new Error('connection lost'); }),
    });
    const result = await ingestKnowledgeDocument({
      prisma,
      input: { title: 'Fail', text: 'content' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.error.code).toBe('CREATE_FAILED');
  });
});

describe('knowledgeDocumentsRoute · /ingest-text route→service contract', () => {
  it('POST /ingest-text → 201 with documentId', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kd-test-'));
    const prisma = makeMockPrisma();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.headers.authorization = req.headers.authorization || `Bearer ${ownerToken}`;
      next();
    });
    app.use('/api/v1/knowledge-documents', createKnowledgeDocumentsRouter({
      uploadDir: tmpDir, requireAuth: false, apiKeys: new Set(), prisma,
    }));
    const res = await request(app)
      .post('/api/v1/knowledge-documents/ingest-text')
      .send({ title: 'Route Test', text: 'Via REST' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.documentId).toMatch(/^kd_/);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('POST /ingest-text → 400 on missing title', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kd-test-'));
    const prisma = makeMockPrisma();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.headers.authorization = req.headers.authorization || `Bearer ${ownerToken}`;
      next();
    });
    app.use('/api/v1/knowledge-documents', createKnowledgeDocumentsRouter({
      uploadDir: tmpDir, requireAuth: false, apiKeys: new Set(), prisma,
    }));
    const res = await request(app)
      .post('/api/v1/knowledge-documents/ingest-text')
      .send({ text: 'no title' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_INPUT');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('POST /ingest-text with scopes → knowledgeAcl.create called (route→service→acl)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kd-test-'));
    const prisma = makeMockPrisma();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.headers.authorization = req.headers.authorization || `Bearer ${ownerToken}`;
      next();
    });
    app.use('/api/v1/knowledge-documents', createKnowledgeDocumentsRouter({
      uploadDir: tmpDir, requireAuth: false, apiKeys: new Set(), prisma,
    }));
    const res = await request(app)
      .post('/api/v1/knowledge-documents/ingest-text')
      .send({ title: 'Scoped Route', text: 'content', scopes: ['public', 'team'] });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect((prisma as any).knowledgeAcl.create).toHaveBeenCalledTimes(2);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('existing Volc upload route not broken (source contract)', async () => {
    const src = await import('fs').then(m => m.readFileSync(
      path.resolve(__dirname, '..', 'knowledgeDocumentsRoute.ts'), 'utf-8'
    ));
    expect(src).toContain('addVolcKnowledgeDocument');
    expect(src).toContain("upload.single('file')");
  });
});
