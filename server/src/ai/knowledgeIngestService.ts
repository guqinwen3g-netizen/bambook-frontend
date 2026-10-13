import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { writeRouteAuditLog } from '../audit/routeAudit';

export type KnowledgeIngestErrorCode =
  | 'INVALID_INPUT'
  | 'DUPLICATE_CHECKSUM'
  | 'CREATE_FAILED'
  | 'AUDIT_FAILED';

export type KnowledgeDocumentErrorCode =
  | KnowledgeIngestErrorCode
  | 'NOT_FOUND'
  | 'UPDATE_FAILED'
  | 'DELETE_FAILED';

export interface KnowledgeIngestError {
  code: KnowledgeIngestErrorCode;
  message: string;
}

export interface KnowledgeIngestInput {
  title: string;
  text: string;
  sourceType?: string;
  sourceUri?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  scopes?: string[];
}

export interface KnowledgeIngestResult {
  documentId: string;
  checksum: string;
  chunkCount: number;
  auditId: string;
}

export interface IngestParams {
  prisma: PrismaClient;
  input: KnowledgeIngestInput;
  actorId?: string;
  ip?: string | null;
  auditSource?: string;
  auditOperation?: string;
}

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 100;
const MAX_TEXT_BYTES = 500_000;
const MAX_TITLE_LEN = 500;

export function computeChecksum(title: string, text: string): string {
  return crypto.createHash('sha256').update(`${title}\n${text}`).digest('hex');
}

function validateInput(input: KnowledgeIngestInput): KnowledgeIngestError | null {
  const title = (input.title || '').trim();
  if (!title) return { code: 'INVALID_INPUT', message: 'title is required' };
  if (title.length > MAX_TITLE_LEN) return { code: 'INVALID_INPUT', message: `title exceeds ${MAX_TITLE_LEN} chars` };

  const text = (input.text || '').trim();
  if (!text) return { code: 'INVALID_INPUT', message: 'text is required' };

  const byteLen = Buffer.byteLength(text, 'utf-8');
  if (byteLen > MAX_TEXT_BYTES) return { code: 'INVALID_INPUT', message: `text exceeds ${MAX_TEXT_BYTES} bytes` };

  return null;
}

function jsonSafe(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object') return null;
  try {
    JSON.parse(JSON.stringify(value));
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function splitChunks(text: string): { content: string; chunkIndex: number }[] {
  const clean = text.trim();
  if (!clean) return [];
  const chunks: { content: string; chunkIndex: number }[] = [];
  let pos = 0;
  let idx = 0;
  while (pos < clean.length) {
    const end = Math.min(pos + CHUNK_SIZE, clean.length);
    chunks.push({ content: clean.slice(pos, end), chunkIndex: idx });
    pos = end === clean.length ? end : pos + CHUNK_SIZE - CHUNK_OVERLAP;
    idx++;
  }
  return chunks;
}

/**
 * splitChunks 的确定性逆运算：首个 chunk 全量 + 后续 chunk 去掉 CHUNK_OVERLAP 前缀。
 * 与 splitChunks 共用同一组常量，保证 roundtrip 恒等（split→join === 原文）。
 */
export function joinChunks(chunks: { content: string; chunkIndex: number }[]): string {
  const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  if (sorted.length === 0) return '';
  let text = sorted[0].content;
  for (let i = 1; i < sorted.length; i++) {
    text += sorted[i].content.slice(CHUNK_OVERLAP);
  }
  return text;
}

async function withTx<T>(prisma: PrismaClient, tx: any | undefined, fn: (t: any) => Promise<T>): Promise<T> {
  return tx ? await fn(tx) : await (prisma as any).$transaction(fn);
}

export async function ingestKnowledgeDocument(params: IngestParams): Promise<{ ok: true; result: KnowledgeIngestResult } | { ok: false; error: KnowledgeIngestError }> {
  const { prisma, input, actorId, ip } = params;
  const auditSource = params.auditSource || 'route:knowledge-documents:ingest-text';
  const auditOperation = params.auditOperation || 'knowledge_ingest';

  const valErr = validateInput(input);
  if (valErr) return { ok: false, error: valErr };

  const title = input.title.trim();
  const text = input.text.trim();
  const sourceType = (input.sourceType || 'manual').trim();
  const sourceUri = input.sourceUri?.trim() || null;
  const tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
  const metadata = jsonSafe(input.metadata);
  const checksum = computeChecksum(title, text);

  try {
    const result = await withTx(prisma, undefined, async (t: any) => {
      const existing = await t.knowledgeDocument.findFirst({
        where: { checksum, deletedAt: null },
        select: { id: true },
      });
      if (existing) {
        throw { code: 'DUPLICATE_CHECKSUM', message: `document with same checksum already exists: ${existing.id}` };
      }

      const documentId = `kd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const doc = await t.knowledgeDocument.create({
        data: {
          id: documentId,
          title,
          sourceType,
          sourceUri,
          checksum,
          status: 'active',
          metadata: metadata ?? undefined,
        },
      });

      const chunks = splitChunks(text);
      if (chunks.length === 0) {
        throw { code: 'INVALID_INPUT', message: 'text produces no chunks' };
      }

      for (const chunk of chunks) {
        await t.knowledgeChunk.create({
          data: {
            id: `kc_${documentId}_${chunk.chunkIndex}`,
            documentId: doc.id,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            tags,
            metadata: metadata ?? undefined,
          },
        });
      }

      const scopes = Array.isArray(input.scopes) ? input.scopes.map(String).filter(Boolean) : [];
      for (const scope of scopes) {
        await t.knowledgeAcl.create({
          data: {
            id: `kacl_${documentId}_${scope}`,
            documentId: doc.id,
            scope,
            access: 'read',
          },
        });
      }

      let auditId: string;
      try {
        auditId = await writeRouteAuditLog({
          prisma: t,
          actorId: actorId || 'system',
          operation: auditOperation,
          targetType: 'KnowledgeDocument',
          targetId: doc.id,
          source: auditSource,
          after: { documentId: doc.id, title, checksum, chunkCount: chunks.length, sourceType },
          ip: ip ?? null,
        });
      } catch (auditErr: any) {
        throw { code: 'AUDIT_FAILED', message: `audit log write failed: ${String(auditErr?.message ?? auditErr)}` };
      }

      return { documentId: doc.id, checksum, chunkCount: chunks.length, auditId };
    });

    return { ok: true, result };
  } catch (e: any) {
    if (e?.code && ['DUPLICATE_CHECKSUM', 'INVALID_INPUT', 'AUDIT_FAILED'].includes(e.code)) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    return { ok: false, error: { code: 'CREATE_FAILED', message: String(e?.message ?? e) } };
  }
}

// ─── ERP knowledge document read/update/delete (Prisma 真源) ───

export interface KnowledgeDocumentRecord {
  id: string;
  title: string;
  content: string;
  category: string | null;
  sourceType: string;
  version: number;
  chunkCount: number;
  checksum: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeDocumentError {
  code: KnowledgeDocumentErrorCode;
  message: string;
}

type CrudOutcome<T> = { ok: true; result: T } | { ok: false; error: KnowledgeDocumentError };

function toRecord(doc: any): KnowledgeDocumentRecord {
  const activeChunks = (doc.chunks || []).filter((c: any) => c.deletedAt == null);
  const metadata = (doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {}) as Record<string, unknown>;
  return {
    id: doc.id,
    title: doc.title,
    content: joinChunks(activeChunks),
    category: typeof metadata.category === 'string' ? metadata.category : null,
    sourceType: doc.sourceType,
    version: doc.version,
    chunkCount: activeChunks.length,
    checksum: doc.checksum ?? null,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.getTime() : Number(doc.createdAt),
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.getTime() : Number(doc.updatedAt),
  };
}

export async function listKnowledgeDocuments(params: { prisma: PrismaClient }): Promise<KnowledgeDocumentRecord[]> {
  const docs = await (params.prisma as any).knowledgeDocument.findMany({
    where: { deletedAt: null, status: 'active' },
    include: { chunks: { where: { deletedAt: null }, orderBy: { chunkIndex: 'asc' } } },
    orderBy: { updatedAt: 'desc' },
  });
  return (docs as any[]).map(toRecord);
}

export interface KnowledgeUpdateInput {
  title?: string;
  text?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeUpdateResult {
  documentId: string;
  version: number;
  checksum: string | null;
  chunkCount: number;
  updatedAt: number;
  auditId: string;
}

export async function updateKnowledgeDocument(params: {
  prisma: PrismaClient;
  documentId: string;
  input: KnowledgeUpdateInput;
  actorId?: string;
  ip?: string | null;
}): Promise<CrudOutcome<KnowledgeUpdateResult>> {
  const { prisma, documentId, input, actorId, ip } = params;

  const title = input.title != null ? input.title.trim() : undefined;
  if (title !== undefined && (!title || title.length > MAX_TITLE_LEN)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: `title must be 1..${MAX_TITLE_LEN} chars` } };
  }
  const text = input.text != null ? input.text.trim() : undefined;
  if (text !== undefined) {
    if (!text) return { ok: false, error: { code: 'INVALID_INPUT', message: 'text is required' } };
    if (Buffer.byteLength(text, 'utf-8') > MAX_TEXT_BYTES) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: `text exceeds ${MAX_TEXT_BYTES} bytes` } };
    }
  }
  const metadata = jsonSafe(input.metadata);
  if (title === undefined && text === undefined && metadata === null) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'nothing to update' } };
  }

  try {
    const result = await (prisma as any).$transaction(async (t: any) => {
      const doc = await t.knowledgeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
      if (!doc) throw { code: 'NOT_FOUND', message: `knowledge document not found: ${documentId}` };

      const nextTitle = title ?? doc.title;
      const mergedMetadata = metadata ? { ...(doc.metadata as Record<string, unknown> | null ?? {}), ...metadata } : undefined;

      let nextChecksum: string | null = doc.checksum ?? null;
      let chunkCount: number | undefined;

      if (text !== undefined) {
        nextChecksum = computeChecksum(nextTitle, text);
        const chunks = splitChunks(text);
        if (chunks.length === 0) throw { code: 'INVALID_INPUT', message: 'text produces no chunks' };

        const now = Date.now();
        await t.knowledgeChunk.updateMany({ where: { documentId, deletedAt: null }, data: { deletedAt: now } });
        for (const chunk of chunks) {
          await t.knowledgeChunk.create({
            data: {
              id: `kc_${documentId}_${doc.version + 1}_${chunk.chunkIndex}`,
              documentId,
              chunkIndex: chunk.chunkIndex,
              content: chunk.content,
              tags: [],
              metadata: mergedMetadata ?? doc.metadata ?? undefined,
            },
          });
        }
        chunkCount = chunks.length;
      }

      const updated = await t.knowledgeDocument.update({
        where: { id: documentId },
        data: {
          title: nextTitle,
          checksum: nextChecksum,
          version: doc.version + 1,
          ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
        },
      });

      let auditId: string;
      try {
        auditId = await writeRouteAuditLog({
          prisma: t,
          actorId: actorId || 'system',
          operation: 'knowledge_update',
          targetType: 'KnowledgeDocument',
          targetId: documentId,
          source: 'route:knowledge-documents:update',
          before: { title: doc.title, version: doc.version, checksum: doc.checksum },
          after: { title: nextTitle, version: updated.version, checksum: nextChecksum, chunkCount },
          ip: ip ?? null,
        });
      } catch (auditErr: any) {
        throw { code: 'AUDIT_FAILED', message: `audit log write failed: ${String(auditErr?.message ?? auditErr)}` };
      }

      return {
        documentId,
        version: updated.version as number,
        checksum: nextChecksum,
        chunkCount: chunkCount ?? 0,
        updatedAt: (updated.updatedAt as Date).getTime(),
        auditId,
      };
    });

    return { ok: true, result };
  } catch (e: any) {
    if (e?.code && ['NOT_FOUND', 'INVALID_INPUT', 'AUDIT_FAILED'].includes(e.code)) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    return { ok: false, error: { code: 'UPDATE_FAILED', message: String(e?.message ?? e) } };
  }
}

export async function deleteKnowledgeDocument(params: {
  prisma: PrismaClient;
  documentId: string;
  actorId?: string;
  ip?: string | null;
}): Promise<CrudOutcome<{ documentId: string; auditId: string }>> {
  const { prisma, documentId, actorId, ip } = params;

  try {
    const result = await (prisma as any).$transaction(async (t: any) => {
      const doc = await t.knowledgeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
      if (!doc) throw { code: 'NOT_FOUND', message: `knowledge document not found: ${documentId}` };

      const now = Date.now();
      await t.knowledgeChunk.updateMany({ where: { documentId, deletedAt: null }, data: { deletedAt: now } });
      await t.knowledgeDocument.update({ where: { id: documentId }, data: { deletedAt: now } });

      let auditId: string;
      try {
        auditId = await writeRouteAuditLog({
          prisma: t,
          actorId: actorId || 'system',
          operation: 'knowledge_delete',
          targetType: 'KnowledgeDocument',
          targetId: documentId,
          source: 'route:knowledge-documents:delete',
          before: { title: doc.title, version: doc.version, checksum: doc.checksum },
          ip: ip ?? null,
        });
      } catch (auditErr: any) {
        throw { code: 'AUDIT_FAILED', message: `audit log write failed: ${String(auditErr?.message ?? auditErr)}` };
      }

      return { documentId, auditId };
    });

    return { ok: true, result };
  } catch (e: any) {
    if (e?.code && ['NOT_FOUND', 'AUDIT_FAILED'].includes(e.code)) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    return { ok: false, error: { code: 'DELETE_FAILED', message: String(e?.message ?? e) } };
  }
}
