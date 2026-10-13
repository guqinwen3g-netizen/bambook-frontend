/**
 * 火山方舟知识库 — 文档写入通道。
 *
 * 2026-08-19 处置（批次1-1d）：
 *   - 删除 searchVolcKnowledge / searchCollection / parseCollections 死代码
 *     （全库无调用方：检索权威路径是自托管 RAG pgvector，见 toolRuntime.searchRagKnowledge；
 *     写入火山但永不检索 = 不可达资产，此检索函数删除收口）
 *   - addVolcKnowledgeDocument 未配置 key 时返回显式 skip 结果（不抛错），
 *     上传路由据此继续本地索引（volcSync: 'skipped_not_configured'），
 *     不再因云侧未配置而 502 阻断整个知识文档上传
 */

type AddVolcKnowledgeDocumentInput = {
  collectionName: string;
  project?: string;
  docId: string;
  docName: string;
  docType: string;
  url: string;
  meta?: Array<Record<string, unknown>>;
  signal?: AbortSignal;
};

type AddVolcKnowledgeDocumentResponse = {
  code?: number;
  message?: string;
  request_id?: string;
  data?: {
    collection_name?: string;
    resource_id?: string;
    project?: string;
    doc_id?: string;
    dedup_info?: unknown;
  };
};

export type AddVolcKnowledgeDocumentOutcome =
  | { skipped: 'not_configured' }
  | { skipped: false; response: AddVolcKnowledgeDocumentResponse };

export async function addVolcKnowledgeDocument(input: AddVolcKnowledgeDocumentInput): Promise<AddVolcKnowledgeDocumentOutcome> {
  const apiKey = process.env.BAMBOOK_KNOWLEDGE_API_KEY;
  if (!apiKey) return { skipped: 'not_configured' };

  const baseUrl = (process.env.BAMBOOK_KNOWLEDGE_BASE_URL || 'https://api-knowledgebase.mlp.cn-beijing.volces.com').replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/api/knowledge/doc/add`, {
    method: 'POST',
    signal: input.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      collection_name: input.collectionName,
      project: input.project || process.env.BAMBOOK_KNOWLEDGE_PROJECT || 'default',
      add_type: 'url',
      doc_id: input.docId,
      doc_name: input.docName,
      doc_type: input.docType,
      url: input.url,
      ...(input.meta?.length ? { meta: input.meta } : {}),
    }),
  });

  const data = await res.json().catch(() => ({})) as AddVolcKnowledgeDocumentResponse;
  if (!res.ok || data.code !== 0) {
    const message = data.message || `Volc knowledge document add failed with ${res.status}`;
    throw new Error(message);
  }
  return { skipped: false, response: data };
}
