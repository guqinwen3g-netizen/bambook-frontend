import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import path from 'path';
import fs from 'fs';
import { logger } from '../lib/logger';
// ★ 未预期异常不再回显原始错误（Prisma 原文/表名列名）；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';

export interface SystemAssetsRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  uploadDir: string;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

const ALLOWED_KINDS = new Set(['wallpaper']);
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function createSystemAssetsRouter(opts: SystemAssetsRouterOptions): Router {
  const router = Router();

  // ⚠️ 本路由刻意注册在「统一认证守卫」**之前**（2026-09-15 显式化）。
  //
  // 原因：登录页壁纸必须在登录前就能加载（前端 utils/publicAssets.ts 把
  // /api/v1/system-assets/<id>/file 解析为公开素材），套上鉴权会让登录页取不到图。
  //
  // 但原先这里既无注释说明、也不限类型——代码读起来像"忘了挂守卫"，
  // 且**任何未来新增的素材类型都会被顺带公开**。因此收口为：
  //   1. 仅 kind==='wallpaper' 走公开直读；其余类型 next() 交给下方守卫（匿名 401）；
  //   2. 落盘路径做根目录约束，filePath 异常时不得越出 uploadDir。
  router.get('/:id/file', async (req, res, next) => {
    try {
      const asset = await (opts.prisma as any).systemAsset.findFirst({
        where: { id: req.params.id, deletedAt: null, hidden: false },
      });
      if (!asset?.filePath) return res.status(404).json({ error: 'NOT_FOUND', message: 'Asset file not found' });
      if (asset.kind !== 'wallpaper') return next(); // 非公开类型 → 交由鉴权守卫处理

      const uploadRoot = path.resolve(opts.uploadDir);
      const fullPath = path.resolve(uploadRoot, asset.filePath);
      // 纵深防御：filePath 若含 ../ 越出 uploadDir 一律拒绝
      if (fullPath !== uploadRoot && !fullPath.startsWith(uploadRoot + path.sep)) {
        logger.error('[system-assets/file] filePath escapes uploadDir, refused', { id: req.params.id });
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Asset file not found' });
      }
      if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'FILE_MISSING', message: 'Asset file missing on data center' });
      if (asset.mimeType) res.setHeader('Content-Type', asset.mimeType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.sendFile(fullPath);
    } catch (e: any) {
      logger.error('[system-assets/file] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'FILE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // 统一认证守卫：JWT（走 jwt.verify 验签）优先，API-Key 次之；API-Key 限只读
  // （注意：仅对其后注册的路由生效——上面那条 /:id/file 是刻意在前的公开读）
  router.use(createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys }));

  // 写操作必须 JWT（API-Key 不可写）
  const requireWrite = requireJwtForWrite({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const dir = path.join(opts.uploadDir, 'system', 'wallpapers');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const title = sanitizeFileStem(String(req.body?.title || path.parse(file.originalname).name || '未命名壁纸'));
        const ext = normalizeImageExt(file);
        cb(null, `${title}${ext}`);
      },
    }),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (IMAGE_MIME_TYPES.has(file.mimetype)) cb(null, true);
      else cb(new Error('Only image files (jpeg, png, webp, gif) are allowed'));
    },
  });

  router.get('/', async (req, res) => {
    try {
      const kind = String(req.query.kind || 'wallpaper');
      if (!ALLOWED_KINDS.has(kind)) {
        return res.status(400).json({ error: 'INVALID_KIND', message: `Unsupported asset kind: ${kind}` });
      }
      const includeHidden = req.query.includeHidden === 'true';
      const assets = await (opts.prisma as any).systemAsset.findMany({
        where: {
          kind,
          deletedAt: null,
          ...(includeHidden ? {} : { hidden: false }),
        },
        orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
      });
      return res.json({ ok: true, assets: serializeAssets(assets) });
    } catch (e: any) {
      logger.error('[system-assets/list] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'LIST_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.post('/wallpapers', requireWrite, upload.single('file'), async (req, res) => {
    try {
      const now = Date.now();
      const file = req.file;
      const id = String(req.body?.id || `wallpaper-${now}`);
      const requestedTitle = cleanText(req.body?.title);
      const title = requestedTitle || (file ? path.parse(file.originalname).name : '经典渐变');
      const group = cleanText(req.body?.group) || '未分组';
      const sortOrder = Number(req.body?.sortOrder ?? 0);
      const hidden = String(req.body?.hidden || '').toLowerCase() === 'true';
      const filePath = file ? path.join('system', 'wallpapers', file.filename) : null;
      const forceMetadata = String(req.body?.forceMetadata || '').toLowerCase() === 'true';
      const existing = await (opts.prisma as any).systemAsset.findUnique({ where: { id } });

      const asset = await (opts.prisma as any).systemAsset.upsert({
        where: { id },
        create: {
          id,
          kind: 'wallpaper',
          title,
          group,
          filePath,
          fileName: file?.originalname || null,
          mimeType: file?.mimetype || null,
          fileSize: file?.size || null,
          sortOrder,
          hidden,
          metadata: {},
          createdAt: BigInt(now),
          updatedAt: BigInt(now),
          deletedAt: null,
        },
        update: {
          title: forceMetadata || !existing ? title : existing.title,
          group: forceMetadata || !existing ? group : existing.group,
          ...(file ? {
            filePath,
            fileName: file.originalname,
            mimeType: file.mimetype,
            fileSize: file.size,
          } : {}),
          sortOrder: forceMetadata || !existing ? sortOrder : existing.sortOrder,
          hidden: forceMetadata || !existing ? hidden : existing.hidden,
          updatedAt: BigInt(now),
          deletedAt: null,
        },
      });

      opts.onDataChange?.({ entity: 'system-assets', action: 'upsert', ids: [id] });
      return res.status(201).json({ ok: true, asset: serializeAsset(asset) });
    } catch (e: any) {
      logger.error('[system-assets/upload-wallpaper] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'UPLOAD_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.patch('/:id', requireWrite, async (req, res) => {
    try {
      const id = req.params.id;
      const body = req.body || {};
      const data: Record<string, unknown> = { updatedAt: BigInt(Date.now()) };
      if (body.title !== undefined) data.title = cleanText(body.title) || '未命名壁纸';
      if (body.group !== undefined) data.group = cleanText(body.group) || '未分组';
      if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder);
      if (body.hidden !== undefined) data.hidden = Boolean(body.hidden);
      if (body.metadata !== undefined) data.metadata = body.metadata || {};

      const asset = await (opts.prisma as any).systemAsset.update({ where: { id }, data });
      opts.onDataChange?.({ entity: 'system-assets', action: 'update', ids: [id] });
      return res.json({ ok: true, asset: serializeAsset(asset) });
    } catch (e: any) {
      logger.error('[system-assets/update] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'UPDATE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.delete('/:id', requireWrite, async (req, res) => {
    try {
      const id = req.params.id;
      await (opts.prisma as any).systemAsset.update({
        where: { id },
        data: { deletedAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) },
      });
      opts.onDataChange?.({ entity: 'system-assets', action: 'delete', ids: [id] });
      return res.json({ ok: true, deleted: id });
    } catch (e: any) {
      logger.error('[system-assets/delete] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'DELETE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  return router;
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim();
}

function sanitizeFileStem(value: string): string {
  return cleanText(value)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '')
    .slice(0, 48) || '未命名壁纸';
}

function normalizeImageExt(file: Express.Multer.File): string {
  const ext = path.extname(file.originalname).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return ext;
  if (file.mimetype === 'image/png') return '.png';
  if (file.mimetype === 'image/webp') return '.webp';
  if (file.mimetype === 'image/gif') return '.gif';
  return '.jpg';
}

function serializeAsset(asset: any) {
  return {
    ...asset,
    createdAt: Number(asset.createdAt),
    updatedAt: Number(asset.updatedAt),
    deletedAt: asset.deletedAt == null ? null : Number(asset.deletedAt),
    fileUrl: asset.filePath ? `/api/v1/system-assets/${encodeURIComponent(asset.id)}/file` : '',
  };
}

function serializeAssets(assets: any[]) {
  return assets.map(serializeAsset);
}
