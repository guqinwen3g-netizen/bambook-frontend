/**
 * C7 知识关联（图谱）只读查询测试：文档正向关联 / 实体反向关联 / 实体双向链接。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  listDocumentRelations,
  listEntityKnowledgeRelations,
  listEntityLinks,
} from '../knowledgeGraphService';

function createMockPrisma() {
  const store = {
    documents: [
      { id: 'kd_1', title: '面料开发流程', deletedAt: null },
      { id: 'kd_2', title: '验货报告模板', deletedAt: null },
      { id: 'kd_deleted', title: '已删文档', deletedAt: 1720000000000 },
    ] as any[],
    relations: [
      { id: 'kr_1', documentId: 'kd_1', chunkId: null, relationType: 'mentions', targetType: 'Product', targetId: 'prod_1', confidence: 0.9, createdAt: new Date('2026-08-01') },
      { id: 'kr_2', documentId: 'kd_1', chunkId: 'kc_1', relationType: 'defines', targetType: 'Order', targetId: 'ord_1', confidence: 0.6, createdAt: new Date('2026-08-02') },
      { id: 'kr_3', documentId: 'kd_2', chunkId: null, relationType: 'mentions', targetType: 'Product', targetId: 'prod_1', confidence: 0.7, createdAt: new Date('2026-08-03') },
    ] as any[],
    entityLinks: [
      { id: 'el_1', fromType: 'Order', fromId: 'ord_1', fromPath: null, toType: 'Product', toId: 'prod_1', toPath: null, linkKind: 'order-line', confidence: 1, source: 'system', status: 'active', deletedAt: null },
      { id: 'el_2', fromType: 'Order', fromId: 'ord_2', fromPath: null, toType: 'Product', toId: 'prod_1', toPath: null, linkKind: 'order-line', confidence: 0.8, source: 'agent', status: 'active', deletedAt: null },
      { id: 'el_inactive', fromType: 'Product', fromId: 'prod_9', fromPath: null, toType: 'Product', toId: 'prod_1', toPath: null, linkKind: 'similar', confidence: 0.5, source: 'agent', status: 'revoked', deletedAt: null },
    ] as any[],
  };
  const prisma: any = {
    knowledgeRelation: {
      findMany: async ({ where, orderBy }: any) => {
        let rows = store.relations;
        if (where?.documentId) rows = rows.filter(r => r.documentId === where.documentId);
        if (where?.targetType) rows = rows.filter(r => r.targetType === where.targetType && r.targetId === where.targetId);
        return [...rows].sort((a, b) => b.confidence - a.confidence);
      },
    },
    knowledgeDocument: {
      findMany: async ({ where }: any) =>
        store.documents.filter(d => where.id.in.includes(d.id) && d.deletedAt === null),
    },
    entityLink: {
      findMany: async ({ where }: any) =>
        store.entityLinks.filter(l => {
          if (l.status !== 'active' || l.deletedAt != null) return false;
          const t = where.OR[0].fromType;
          const i = where.OR[0].fromId;
          return (l.fromType === t && l.fromId === i) || (l.toType === t && l.toId === i);
        }),
    },
  };
  return { prisma, store };
}

describe('knowledge graph service', () => {
  let mock: ReturnType<typeof createMockPrisma>;
  beforeEach(() => { mock = createMockPrisma(); });

  it('lists relations for a document with document title joined, confidence desc', async () => {
    const rows = await listDocumentRelations(mock.prisma, 'kd_1');
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('kr_1'); // 0.9 > 0.6
    expect(rows[0].documentTitle).toBe('面料开发流程');
    expect(rows[1].targetType).toBe('Order');
  });

  it('reverse-lookup: relations pointing at an entity include document titles', async () => {
    const rows = await listEntityKnowledgeRelations(mock.prisma, 'Product', 'prod_1');
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('kr_1');
    expect(rows.map(r => r.documentTitle).sort()).toEqual(['面料开发流程', '验货报告模板'].sort());
  });

  it('soft-deleted documents resolve to null title', async () => {
    mock.store.relations.push({ id: 'kr_9', documentId: 'kd_deleted', chunkId: null, relationType: 'mentions', targetType: 'X', targetId: 'x1', confidence: 0.9, createdAt: new Date() });
    const rows = await listDocumentRelations(mock.prisma, 'kd_deleted');
    expect(rows).toHaveLength(1);
    expect(rows[0].documentTitle).toBeNull();
  });

  it('entity links are bidirectional and exclude non-active rows', async () => {
    // prod_1 作为 to 端命中两条 active；revoked 的不返回
    const rows = await listEntityLinks(mock.prisma, 'Product', 'prod_1');
    expect(rows.map(r => r.id).sort()).toEqual(['el_1', 'el_2']);
    // ord_1 作为 from 端命中一条
    const fromRows = await listEntityLinks(mock.prisma, 'Order', 'ord_1');
    expect(fromRows).toHaveLength(1);
    expect(fromRows[0].linkKind).toBe('order-line');
  });
});
