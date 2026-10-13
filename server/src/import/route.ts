import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { parseOrderPdf } from './parseOrderPdf';

export interface ImportRouterOptions {
  /** When false, all requests pass through (local-friendly). */
  requireAuth: boolean;
  /** Accepted API keys for `X-Bambook-API-Key` header. */
  apiKeys: Set<string>;
  /** Per-file size cap in bytes. Default 10 MB. */
  maxFileBytes?: number;
  /** Max files per request. Default 20. */
  maxFiles?: number;
}

/**
 * Express router exposing PDF-import endpoints.
 *
 *   POST /order   multipart, field "files" (1+ PDFs)  → { count, results[] }
 *
 * Each result is `{ filename, pages, detection, order|null, error|null }`.
 * Per-file failures do NOT fail the whole request.
 *
 * ★★ 2026-09-25 下线（Kevin 拍板）：**本 router 已不再被挂载**（见 `server/src/index.ts`
 *    `/api/v1/import` 挂载点原位注释）⇒ `POST /api/v1/import/order` 现在返回 404。
 *    模块与单测全部保留（`__tests__/route.test.ts` 自建 app 直接测本 router），
 *    撤销下线时在 index.ts 取消两处注释即可。防回挂守卫见
 *    `server/src/__tests__/erpCrossModuleSmoke.test.ts` 的 Import 一条（方向为"必须不挂载"）。
 */
export function createImportRouter(opts: ImportRouterOptions): Router {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: opts.maxFileBytes ?? 10 * 1024 * 1024,
      files: opts.maxFiles ?? 20,
    },
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!opts.requireAuth) return next();
    const k = req.headers['x-bambook-api-key'] as string | undefined;
    if (!k) {
      return res
        .status(401)
        .json({ error: 'UNAUTHORIZED', message: 'X-Bambook-API-Key header required' });
    }
    if (!opts.apiKeys.has(k)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid API key' });
    }
    next();
  });

  router.post('/order', upload.array('files'), async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      return res.status(400).json({
        error: 'NO_FILES',
        message: 'Attach 1+ PDFs under multipart field name "files"',
      });
    }

    const results = await Promise.all(
      files.map(async (f) => {
        try {
          const r = await parseOrderPdf(f.buffer);
          return {
            filename: f.originalname,
            pages: r.pages,
            detection: r.detection,
            order: r.order ?? null,
            error: r.error ?? null,
          };
        } catch (e: any) {
          return {
            filename: f.originalname,
            pages: 0,
            detection: { customerId: null, confidence: 0, reasons: [] as string[] },
            order: null,
            error: String(e?.message ?? e),
          };
        }
      }),
    );

    return res.json({ count: results.length, results });
  });

  return router;
}
