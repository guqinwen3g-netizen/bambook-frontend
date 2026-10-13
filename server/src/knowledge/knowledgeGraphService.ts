/**
 * C7 知识库深化：知识关联（图谱）只读查询。
 *
 * 复用既有两张表，零新增模型：
 * - KnowledgeRelation：知识文档/块 → 业务实体（relationType + confidence）
 * - EntityLink：业务实体 ↔ 业务实体（linkKind）
 * 本服务只做结构化关联读取，支撑前端「关联」区块；不做全图可视化。
 */
import { PrismaClient } from '@prisma/client';

export interface KnowledgeRelationView {
  id: string;
  documentId: string | null;
  documentTitle: string | null;
  chunkId: string | null;
  relationType: string;
  targetType: string;
  targetId: string;
  confidence: number;
  createdAt: number;
}

export interface EntityLinkView {
  id: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  linkKind: string;
  confidence: number | null;
  source: string | null;
}

const toNumber = (v: unknown): number => {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.getTime();
  return Number(v);
};

function toRelationView(row: any, docTitleById: Map<string, string>): KnowledgeRelationView {
  return {
    id: row.id,
    documentId: row.documentId ?? null,
    documentTitle: row.documentId ? docTitleById.get(row.documentId) ?? null : null,
    chunkId: row.chunkId ?? null,
    relationType: row.relationType,
    targetType: row.targetType,
    targetId: row.targetId,
    confidence: row.confidence,
    createdAt: toNumber(row.createdAt),
  };
}

async function loadDocTitles(prisma: PrismaClient, rows: any[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map(r => r.documentId).filter(Boolean))] as string[];
  if (ids.length === 0) return new Map();
  const docs = await (prisma as any).knowledgeDocument.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, title: true },
  });
  return new Map((docs as any[]).map(d => [d.id, d.title]));
}

/** 某知识文档建立的全部实体关联（按置信度降序）。 */
export async function listDocumentRelations(prisma: PrismaClient, documentId: string): Promise<KnowledgeRelationView[]> {
  const rows = await (prisma as any).knowledgeRelation.findMany({
    where: { documentId },
    orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }],
    take: 200,
  });
  const titles = await loadDocTitles(prisma, rows);
  return (rows as any[]).map(r => toRelationView(r, titles));
}

/** 指向某业务实体的全部知识关联（反向检索：哪些文档提到了这个实体）。 */
export async function listEntityKnowledgeRelations(
  prisma: PrismaClient,
  targetType: string,
  targetId: string,
): Promise<KnowledgeRelationView[]> {
  const rows = await (prisma as any).knowledgeRelation.findMany({
    where: { targetType, targetId },
    orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }],
    take: 200,
  });
  const titles = await loadDocTitles(prisma, rows);
  return (rows as any[]).map(r => toRelationView(r, titles));
}

/** 某业务实体的双向实体链接（from 或 to 命中即返回）。 */
export async function listEntityLinks(prisma: PrismaClient, entityType: string, entityId: string): Promise<EntityLinkView[]> {
  const rows = await (prisma as any).entityLink.findMany({
    where: {
      status: 'active',
      deletedAt: null,
      OR: [
        { fromType: entityType, fromId: entityId },
        { toType: entityType, toId: entityId },
      ],
    },
    orderBy: [{ confidence: 'desc' }],
    take: 200,
  });
  return (rows as any[]).map(r => ({
    id: r.id,
    fromType: r.fromType,
    fromId: r.fromId,
    toType: r.toType,
    toId: r.toId,
    linkKind: r.linkKind,
    confidence: r.confidence ?? null,
    source: r.source ?? null,
  }));
}
