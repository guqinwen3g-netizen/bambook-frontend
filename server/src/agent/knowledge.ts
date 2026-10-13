import { ActorContext, KnowledgeHit } from './types';
import { createPolicyService } from './policy';

type IngestDocumentInput = {
  id: string;
  title: string;
  sourceType: string;
  content: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
};

type StoredChunk = KnowledgeHit & {
  documentId: string;
  chunkIndex: number;
};

type KnowledgeServiceOptions = {
  policy?: ReturnType<typeof createPolicyService>;
};

export function createKnowledgeService(options: KnowledgeServiceOptions = {}) {
  const policy = options.policy ?? createPolicyService();
  const chunks: StoredChunk[] = [];

  async function ingestDocument(input: IngestDocumentInput) {
    const pieces = splitIntoChunks(input.content);
    pieces.forEach((content, index) => {
      chunks.push({
        documentId: input.id,
        chunkIndex: index,
        title: input.title,
        category: input.sourceType,
        content,
        source: `knowledge-document:${input.id}`,
        scopes: input.scopes?.length ? input.scopes : ['company'],
      });
    });

    return {
      documentId: input.id,
      chunks: pieces.length,
    };
  }

  async function search(input: { actor: ActorContext; query: string }) {
    const terms = tokenize(input.query);
    return chunks
      .filter(chunk => policy.canAccessKnowledge(input.actor, { scopes: chunk.scopes }))
      .filter(chunk => matches(chunk, terms))
      .map(chunk => ({
        title: chunk.title,
        category: chunk.category,
        content: chunk.content,
        source: chunk.source,
        scopes: chunk.scopes,
      }));
  }

  function stats() {
    return {
      documents: new Set(chunks.map(chunk => chunk.documentId)).size,
      chunks: chunks.length,
    };
  }

  return { ingestDocument, search, stats };
}

function splitIntoChunks(content: string) {
  return content
    .split(/\n{2,}|\r?\n/)
    .map(chunk => chunk.trim())
    .filter(Boolean);
}

function tokenize(query: string) {
  return query
    .split(/[\s,，。！？!?;；:：]+/)
    .map(term => term.trim().toLowerCase())
    .filter(term => term.length >= 2);
}

function matches(chunk: StoredChunk, terms: string[]) {
  if (!terms.length) return true;
  const haystack = `${chunk.title}\n${chunk.content}`.toLowerCase();
  return terms.some(term => haystack.includes(term));
}
