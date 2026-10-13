/**
 * C7 SOP 模板服务测试：CRUD / 校验分支 / 版本递增规则 / 软删除 / 实例化渲染 / 幂等种子。
 * 内存 mock prisma（auditLog.create 透传，ingest 管线同 mock 落库）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSopTemplate,
  updateSopTemplate,
  deleteSopTemplate,
  listSopTemplates,
  instantiateSopTemplate,
  renderSopTemplateText,
  ensureSopTemplateSeed,
} from '../sopTemplateService';

function createMockPrisma() {
  const store = {
    sopTemplates: [] as any[],
    knowledgeDocuments: [] as any[],
    knowledgeChunks: [] as any[],
    auditLogs: [] as any[],
  };
  const prisma: any = {
    sopTemplate: {
      count: async () => store.sopTemplates.filter(t => t.deletedAt == null).length,
      findMany: async ({ where }: any = {}) => {
        let rows = store.sopTemplates;
        if (where?.deletedAt === null) rows = rows.filter(t => t.deletedAt == null);
        if (where?.status) rows = rows.filter(t => t.status === where.status);
        if (where?.category) rows = rows.filter(t => t.category === where.category);
        return rows;
      },
      findFirst: async ({ where }: any) =>
        store.sopTemplates.find(t => t.id === where.id && (where.deletedAt === undefined ? true : t.deletedAt == null)) ?? null,
      create: async ({ data }: any) => { store.sopTemplates.push({ ...data }); return data; },
      update: async ({ where, data }: any) => {
        const row = store.sopTemplates.find(t => t.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    knowledgeDocument: {
      findFirst: async ({ where }: any) =>
        store.knowledgeDocuments.find(d => d.checksum === where.checksum && d.deletedAt === null) ?? null,
      create: async ({ data }: any) => { store.knowledgeDocuments.push({ ...data }); return data; },
    },
    knowledgeChunk: {
      create: async ({ data }: any) => { store.knowledgeChunks.push({ ...data }); return data; },
    },
    knowledgeAcl: { create: async ({ data }: any) => data },
    auditLog: {
      create: async ({ data }: any) => { store.auditLogs.push(data); return data; },
    },
  };
  prisma.$transaction = async (fn: any) => fn(prisma);
  return { prisma, store };
}

const validInput = {
  title: '测试 SOP',
  category: 'Production',
  content: '正文内容：适用范围与判定标准。',
  steps: [{ title: '第一步', detail: '细节' }, { title: '第二步' }],
};

describe('SOP template service', () => {
  let mock: ReturnType<typeof createMockPrisma>;
  beforeEach(() => { mock = createMockPrisma(); });

  it('creates a template with defaults (active, version 1) and writes audit', async () => {
    const r = await createSopTemplate({ prisma: mock.prisma, input: validInput, actorId: 'tester' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.status).toBe('active');
    expect(r.result.version).toBe(1);
    expect(r.result.steps).toHaveLength(2);
    expect(mock.store.auditLogs.some(l => l.action === 'sop_template_create')).toBe(true);
  });

  it('rejects missing title/category/content and malformed steps', async () => {
    expect((await createSopTemplate({ prisma: mock.prisma, input: { ...validInput, title: '' } })).ok).toBe(false);
    expect((await createSopTemplate({ prisma: mock.prisma, input: { ...validInput, category: '' } })).ok).toBe(false);
    expect((await createSopTemplate({ prisma: mock.prisma, input: { ...validInput, content: ' ' } })).ok).toBe(false);
    const badSteps = await createSopTemplate({ prisma: mock.prisma, input: { ...validInput, steps: [{ detail: '无标题' } as any] } });
    expect(badSteps.ok).toBe(false);
    const badStatus = await createSopTemplate({ prisma: mock.prisma, input: { ...validInput, status: 'weird' } });
    expect(badStatus.ok).toBe(false);
  });

  it('lists active by default; status=all includes archived; category filter applies', async () => {
    await createSopTemplate({ prisma: mock.prisma, input: validInput });
    await createSopTemplate({ prisma: mock.prisma, input: { ...validInput, title: '归档模板', category: 'Policy', status: 'archived' } });
    const activeOnly = await listSopTemplates(mock.prisma);
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0].title).toBe('测试 SOP');
    const all = await listSopTemplates(mock.prisma, { status: 'all' });
    expect(all).toHaveLength(2);
    const policy = await listSopTemplates(mock.prisma, { status: 'all', category: 'Policy' });
    expect(policy).toHaveLength(1);
    expect(policy[0].status).toBe('archived');
  });

  it('bumps version only when content/steps change', async () => {
    const created = await createSopTemplate({ prisma: mock.prisma, input: validInput });
    if (!created.ok) throw new Error('create failed');
    const id = created.result.id;

    const metaOnly = await updateSopTemplate({ prisma: mock.prisma, id, input: { summary: '仅摘要' } });
    expect(metaOnly.ok && metaOnly.result.version).toBe(1);

    const contentChange = await updateSopTemplate({ prisma: mock.prisma, id, input: { content: '新正文' } });
    expect(contentChange.ok && contentChange.result.version).toBe(2);

    const stepsChange = await updateSopTemplate({ prisma: mock.prisma, id, input: { steps: [{ title: '唯一步骤' }] } });
    expect(stepsChange.ok && stepsChange.result.version).toBe(3);
  });

  it('soft-deletes and then 404s on update/delete', async () => {
    const created = await createSopTemplate({ prisma: mock.prisma, input: validInput });
    if (!created.ok) throw new Error('create failed');
    const id = created.result.id;
    const del = await deleteSopTemplate({ prisma: mock.prisma, id });
    expect(del.ok).toBe(true);
    expect((await listSopTemplates(mock.prisma))).toHaveLength(0);
    const upd = await updateSopTemplate({ prisma: mock.prisma, id, input: { title: 'x' } });
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.error.code).toBe('NOT_FOUND');
  });

  it('renders template text as summary + numbered steps + content (single render source)', () => {
    const text = renderSopTemplateText({ title: 'T', summary: '摘要', content: '正文', steps: [{ title: 'A', detail: 'a' }, { title: 'B' }] });
    expect(text).toBe('摘要\n\n1. A\n   a\n2. B\n\n正文');
  });

  it('instantiates active template into a knowledge document with sop sourceType and metadata', async () => {
    const created = await createSopTemplate({ prisma: mock.prisma, input: validInput });
    if (!created.ok) throw new Error('create failed');
    const r = await instantiateSopTemplate({ prisma: mock.prisma, id: created.result.id, actorId: 'tester' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.templateVersion).toBe(1);
    const doc = mock.store.knowledgeDocuments.find(d => d.id === r.result.documentId);
    expect(doc.sourceType).toBe('sop');
    expect(doc.title).toBe('SOP：测试 SOP');
    expect(doc.metadata.sopTemplateId).toBe(created.result.id);
    expect(mock.store.knowledgeChunks.filter(c => c.documentId === doc.id).length).toBeGreaterThan(0);
  });

  it('rejects instantiation of archived template', async () => {
    const created = await createSopTemplate({ prisma: mock.prisma, input: { ...validInput, status: 'archived' } });
    if (!created.ok) throw new Error('create failed');
    const r = await instantiateSopTemplate({ prisma: mock.prisma, id: created.result.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ARCHIVED');
  });

  it('seed writes preset templates only when table is empty (idempotent)', async () => {
    const first = await ensureSopTemplateSeed(mock.prisma);
    expect(first).toBe(true);
    expect(await listSopTemplates(mock.prisma)).toHaveLength(4);
    const second = await ensureSopTemplateSeed(mock.prisma);
    expect(second).toBe(false);
    expect(await listSopTemplates(mock.prisma)).toHaveLength(4);
  });
});
