import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { addVolcKnowledgeDocument } from './volcKnowledge';
import { PrismaClient } from '@prisma/client';
import { ingestKnowledgeDocument, listKnowledgeDocuments, updateKnowledgeDocument, deleteKnowledgeDocument } from './knowledgeIngestService';
import { actorIdFromRequest } from '../audit/routeAudit';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';

type KnowledgeDocumentsRouterOptions = {
  uploadDir: string;
  requireAuth: boolean;
  apiKeys: Set<string>;
  prisma: PrismaClient;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
};

type StoredKnowledgeDocument = {
  docId: string;
  docName: string;
  docType: string;
  collectionName: string;
  project: string;
  filePath: string;
  token: string;
  originalName: string;
  mimeType?: string;
  size: number;
  volcRequestId?: string;
  volcResourceId?: string;
  createdAt: string;
};

type DocumentIndex = Record<string, StoredKnowledgeDocument>;

/**
 * 知识库文档上传类型白名单（2026-09-15 补）。
 *
 * 此前本路由的 multer **没有 fileFilter**——任意类型、最大 50MB 都能传上来
 * （`resolveDocType` 只是给文件打标签，不做限制）。而代码库里其它上传路径
 * （印章图 ALLOWED_SEAL_MIME、产品图、技术包、QC 报告、报价图、壁纸）
 * **都有类型白名单**，本路由是唯一例外，不符合自身约定。
 *
 * 缓解现状：落盘目录 `knowledge-documents` 已被 uploadsGuard 拦掉匿名静态读取，
 * 下载走 `res.download`（attachment，不渲染），所以并非可直接利用的漏洞；
 * 但"任意类型可落盘"仍应收敛——脚本/可执行文件不该进知识库。
 *
 * 判定只看**扩展名**（mimetype 由客户端提供，不可信）。
 */
export const KNOWLEDGE_DOC_EXT_ALLOWLIST: ReadonlySet<string> = new Set([
  // 文档
  'pdf', 'doc', 'docx', 'rtf', 'txt', 'md', 'markdown', 'odt', 'ods', 'odp',
  'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'vsdx', 'epub',
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff',
  // 归档 / 数据交换（归档不解压，仅存储）
  'zip', 'rar', '7z', 'tar', 'gz', 'json', 'xml', 'yaml', 'yml', 'log', 'eml', 'msg',
]);

export function isAllowedKnowledgeDocumentFile(filename: string): boolean {
  const ext = path.extname(String(filename || '')).replace(/^\./, '').toLowerCase();
  return ext.length > 0 && KNOWLEDGE_DOC_EXT_ALLOWLIST.has(ext);
}

/** multer fileFilter：拒绝白名单外的类型（含 .html/.svg/.js/.exe/.php 等）。 */
export function knowledgeDocumentFileFilter(
  _req: unknown,
  file: { originalname?: string },
  cb: (err: Error | null, accept?: boolean) => void,
): void {
  if (isAllowedKnowledgeDocumentFile(file?.originalname || '')) return cb(null, true);
  return cb(new Error(`不支持的文件类型：${path.extname(file?.originalname || '').toLowerCase() || '未知'}（知识库仅接受文档/图片/归档）`));
}

export function createKnowledgeDocumentsRouter(options: KnowledgeDocumentsRouterOptions) {
  const router = Router();
  const storageDir = path.join(options.uploadDir, 'knowledge-documents');
  fs.mkdirSync(storageDir, { recursive: true });

  // Shared module-level auth guard: JWT (cookie/Bearer) or API-key header.
  // Replaces the previous per-route inline `auth()` helper so the download
  // route is no longer reachable without authentication (it previously relied
  // only on a per-doc random token query param).
  const guard = createModuleAuthGuard({ requireAuth: options.requireAuth, apiKeys: options.apiKeys });
  router.use(guard);

  // W-C 权限收口：本路由虽物理位于 ai/ 目录，业务上是知识库文档域（挂载 /api/v1/knowledge-documents，
  // 前端 DataCenter 视图 ↔ knowledge scopes）——读端点挂 knowledge:read，
  // 写端点（上传/ingest/编辑/软删）挂 knowledge:write（:write 后缀由 permissionGuard 强制 JWT，API-Key 拒）。

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, storageDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
      },
    }),
    limits: { fileSize: Number(process.env.BAMBOOK_KNOWLEDGE_UPLOAD_MAX_BYTES || 50 * 1024 * 1024) },
    fileFilter: knowledgeDocumentFileFilter,
  });

  router.get('/:docId/download', requirePermission('knowledge:read'), (req, res) => {
    const index = readIndex(storageDir);
    const record = index[req.params.docId];
    if (!record) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Knowledge document not found.' });
    }
    if (!fs.existsSync(record.filePath)) {
      return res.status(404).json({ error: 'FILE_MISSING', message: 'Knowledge document file is missing.' });
    }
    res.download(record.filePath, record.originalName);
  });

  router.post(
    '/',
    requirePermission('knowledge:write'),
    // 手动包一层：把 multer 的错误（类型不合规 / 超限）明确成 400，
    // 而不是丢给全局错误处理变成 500（勿再踩 #11：错误分类靠类型不靠文案）。
    (req: Request, res: Response, next: () => void) => {
      upload.single('file')(req, res, (err: any) => {
        if (!err) return next();
        const tooLarge = err?.code === 'LIMIT_FILE_SIZE';
        return res.status(400).json({
          ok: false,
          error: tooLarge ? 'FILE_TOO_LARGE' : 'INVALID_FILE_TYPE',
          message: tooLarge ? '文件超过大小上限。' : String(err?.message || '不支持的文件类型。'),
        });
      });
    },
    async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'file is required' });
    }

    const collectionName = String(req.body?.collectionName || process.env.BAMBOOK_KNOWLEDGE_DEFAULT_COLLECTION || '').trim();
    if (!collectionName) {
      fs.unlink(file.path, () => undefined);
      return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'collectionName is required' });
    }

    const project = String(req.body?.project || process.env.BAMBOOK_KNOWLEDGE_PROJECT || 'default').trim();
    const docName = String(req.body?.docName || req.body?.title || file.originalname).trim();
    const docType = resolveDocType(file.originalname);
    const docId = normalizeDocId(String(req.body?.docId || docName));
    const token = crypto.randomBytes(24).toString('hex');
    const publicUrl = buildPublicDownloadUrl(req, docId, token);

    // 云侧（火山知识库）推送为非致命增强通道：未配置/失败时本地索引照常落盘，
    // volcSync 状态显式返回（不再因云侧未配置而 502 阻断上传）
    let volcSync: 'synced' | 'skipped_not_configured' | 'failed' = 'failed';
    let volcRequestId: string | undefined;
    let volcResourceId: string | undefined;
    try {
      const volc = await addVolcKnowledgeDocument({
        collectionName,
        project,
        docId,
        docName,
        docType,
        url: publicUrl,
        meta: buildMeta(req.body),
      });
      if (volc.skipped === 'not_configured') {
        volcSync = 'skipped_not_configured';
      } else {
        volcSync = 'synced';
        volcRequestId = volc.response.request_id;
        volcResourceId = volc.response.data?.resource_id;
      }
    } catch (error: any) {
      volcSync = 'failed';
      console.warn('[KnowledgeDocuments] volc push failed (local index continues)', { docId, error: error?.message });
    }

    const index = readIndex(storageDir);
    const previous = index[docId];
    if (previous?.filePath && previous.filePath !== file.path && fs.existsSync(previous.filePath)) {
      fs.unlink(previous.filePath, () => undefined);
    }

    index[docId] = {
      docId,
      docName,
      docType,
      collectionName,
      project,
      filePath: file.path,
      token,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      volcRequestId,
      volcResourceId,
      createdAt: new Date().toISOString(),
    };
    writeIndex(storageDir, index);

    return res.json({
      ok: true,
      docId,
      docName,
      docType,
      collectionName,
      project,
      volcSync,
      requestId: volcRequestId,
      volc: volcResourceId ? { resource_id: volcResourceId } : undefined,
    });
    },
  );

  // ─── ERP manual ingest: text → KnowledgeDocument + KnowledgeChunk (Prisma, audit) ───
  router.post('/ingest-text', requirePermission('knowledge:write'), async (req: Request, res: Response) => {
    const outcome = await ingestKnowledgeDocument({
      prisma: options.prisma,
      input: {
        title: String(req.body?.title || ''),
        text: String(req.body?.text || ''),
        sourceType: req.body?.sourceType ? String(req.body.sourceType) : undefined,
        sourceUri: req.body?.sourceUri ? String(req.body.sourceUri) : undefined,
        tags: Array.isArray(req.body?.tags) ? req.body.tags : undefined,
        metadata: typeof req.body?.metadata === 'object' && req.body.metadata ? req.body.metadata : undefined,
        scopes: Array.isArray(req.body?.scopes) ? req.body.scopes : undefined,
      },
      actorId: actorIdFromRequest(req),
      ip: req.ip,
    });

    if (!outcome.ok) {
      const statusMap: Record<string, number> = {
        INVALID_INPUT: 400,
        DUPLICATE_CHECKSUM: 409,
        CREATE_FAILED: 500,
        AUDIT_FAILED: 500,
      };
      const error = outcome.error;
      return res.status(statusMap[error.code] || 500).json({ ok: false, error: error.code, message: error.message });
    }

    if (options.onDataChange) options.onDataChange({ entity: 'knowledge-document', action: 'ingest', ids: [outcome.result.documentId] });
    return res.status(201).json({ ok: true, ...outcome.result });
  });

  // 列表 = 文件索引（upload 通道）+ Prisma（ERP ingest 通道）双源合并，origin 字段区分来源。
  // Prisma 查询失败时降级为仅 upload 列表并显式标记，不静默吞错。
  router.get('/', requirePermission('knowledge:read'), async (_req, res) => {
    const uploadRecords = Object.values(readIndex(storageDir)).map(({ token: _token, filePath: _filePath, ...record }) => ({
      ...record,
      origin: 'upload' as const,
    }));
    try {
      const erpRecords = (await listKnowledgeDocuments({ prisma: options.prisma })).map(record => ({
        ...record,
        origin: 'erp' as const,
      }));
      res.json({ ok: true, documents: [...erpRecords, ...uploadRecords] });
    } catch (e: any) {
      res.json({ ok: true, documents: uploadRecords, erpListError: String(e?.message ?? e) });
    }
  });

  // 编辑 ERP 知识文档（标题/正文/分类）。正文变更 = 软删旧 chunk + 重建 + 版本递增 + 审计。
  router.patch('/:docId', requirePermission('knowledge:write'), async (req: Request, res: Response) => {
    const category = req.body?.category != null ? String(req.body.category) : undefined;
    const outcome = await updateKnowledgeDocument({
      prisma: options.prisma,
      documentId: String(req.params.docId || ''),
      input: {
        title: req.body?.title != null ? String(req.body.title) : undefined,
        text: req.body?.text != null ? String(req.body.text) : undefined,
        metadata: category !== undefined ? { category } : undefined,
      },
      actorId: actorIdFromRequest(req),
      ip: req.ip,
    });

    if (!outcome.ok) {
      const statusMap: Record<string, number> = { INVALID_INPUT: 400, NOT_FOUND: 404, UPDATE_FAILED: 500, AUDIT_FAILED: 500 };
      return res.status(statusMap[outcome.error.code] || 500).json({ ok: false, error: outcome.error.code, message: outcome.error.message });
    }

    if (options.onDataChange) options.onDataChange({ entity: 'knowledge-document', action: 'update', ids: [outcome.result.documentId] });
    return res.json({ ok: true, ...outcome.result });
  });

  // 软删除 ERP 知识文档（doc + chunks 打 deletedAt，审计留痕）。
  router.delete('/:docId', requirePermission('knowledge:write'), async (req: Request, res: Response) => {
    const outcome = await deleteKnowledgeDocument({
      prisma: options.prisma,
      documentId: String(req.params.docId || ''),
      actorId: actorIdFromRequest(req),
      ip: req.ip,
    });

    if (!outcome.ok) {
      const statusMap: Record<string, number> = { NOT_FOUND: 404, DELETE_FAILED: 500, AUDIT_FAILED: 500 };
      return res.status(statusMap[outcome.error.code] || 500).json({ ok: false, error: outcome.error.code, message: outcome.error.message });
    }

    if (options.onDataChange) options.onDataChange({ entity: 'knowledge-document', action: 'delete', ids: [outcome.result.documentId] });
    return res.json({ ok: true, ...outcome.result });
  });

  return router;
}

function readIndex(storageDir: string): DocumentIndex {
  const indexPath = path.join(storageDir, 'index.json');
  if (!fs.existsSync(indexPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as DocumentIndex;
  } catch {
    return {};
  }
}

function writeIndex(storageDir: string, index: DocumentIndex) {
  fs.writeFileSync(path.join(storageDir, 'index.json'), JSON.stringify(index, null, 2));
}

function resolveDocType(filename: string) {
  const ext = path.extname(filename).replace(/^\./, '').toLowerCase();
  if (!ext) return 'txt';
  if (ext === 'md') return 'markdown';
  return ext;
}

function normalizeDocId(input: string) {
  const cleaned = input
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  const hash = crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
  const base = cleaned || 'document';
  const prefixed = /^[a-zA-Z_]/.test(base) ? base : `doc_${base}`;
  return `${prefixed}_${hash}`.slice(0, 128);
}

function buildPublicDownloadUrl(req: Request, docId: string, token: string) {
  const configured = process.env.BAMBOOK_KNOWLEDGE_PUBLIC_BASE_URL || process.env.BAMBOOK_PUBLIC_BASE_URL;
  const base = configured?.trim()
    ? configured.trim().replace(/\/$/, '')
    : `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
  return `${base}/api/v1/knowledge-documents/${encodeURIComponent(docId)}/download?token=${encodeURIComponent(token)}`;
}

function buildMeta(body: any) {
  const rawTags = typeof body?.tags === 'string' ? body.tags.split(',') : [];
  const tags = rawTags.map((tag: string) => tag.trim()).filter(Boolean);
  if (!tags.length) return undefined;
  return tags.map((tag: string) => ({
    field_name: 'tag',
    field_type: 'string',
    field_value: tag,
  }));
}
