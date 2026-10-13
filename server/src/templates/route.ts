/**
 * 模板渲染 API — /api/templates
 *
 * ⚠️ DEPRECATED（2026-09-15 B4 冗余收敛）：本族 4 个端点**前端零消费**
 * （模板渲染实际走前端 osCompiler / osVNext 原语，不经此 API）。
 * 暂保留（待业务方确认无人调用后删除）——**新代码不要再依赖本路由**。
 *
 * 由 Phase 6 Compiled Templates 引入。低风险只读端点：
 *   GET  /              — 列出所有可用模板
 *   GET  /:id/meta      — 模板元数据
 *   POST /:id/render    — 用提交的 data 渲染 HTML
 *
 * 鉴权：复用 server 现有 API key / actor，不放公网无鉴权（虽然纯函数，但
 *      模板内嵌公司/银行信息属于敏感视图，登录后可见）。
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  listTemplates,
  getTemplateMeta,
  renderTemplate,
  readTemplateRefusalTuple,
  type TemplateId,
  TemplateNotFoundError,
  TemplateRenderError,
} from './render';
import { renderHtmlToPdf } from './pdf';
import { saveRenderedDoc, savePdfFile } from './store';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { writeRouteAuditLog, actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { GENERIC_ROUTE_ERROR_MESSAGE } from '../shared/routeError';

export interface TemplatesRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

const KNOWN_TEMPLATE_IDS: ReadonlySet<TemplateId> = new Set([
  'invoice.sample.pdas',
  'invoice.sample.fabric',
]);

const isKnownTemplateId = (value: string): value is TemplateId =>
  KNOWN_TEMPLATE_IDS.has(value as TemplateId);

export function createTemplatesRouter(options: TemplatesRouterOptions): Router {
  const { prisma, requireAuth, apiKeys } = options;
  const router = Router();

  // 模块级 auth guard: JWT or API key
  const guard = createModuleAuthGuard({ requireAuth, apiKeys });
  router.use(guard);

  // 写操作需要 JWT (API key 不足以执行写操作)
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });

  router.get('/', (_req: Request, res: Response) => {
    res.json({
      schemaVersion: 1,
      templates: listTemplates(),
    });
  });

  router.get('/:id/meta', (req: Request, res: Response) => {
    if (!isKnownTemplateId(req.params.id)) {
      return res.status(404).json({ error: 'TemplateNotFound', id: req.params.id });
    }
    const meta = getTemplateMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'TemplateNotFound', id: req.params.id });
    res.json({ template: meta });
  });

  router.post('/:id/render', requireWrite, async (req: Request, res: Response) => {
    if (!isKnownTemplateId(req.params.id)) {
      return res.status(404).json({ error: 'TemplateNotFound', id: req.params.id });
    }
    const data = req.body?.data;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'InvalidPayload', message: 'body.data must be an object' });
    }
    try {
      const result = renderTemplate(req.params.id, data);
      // 异步落库，不阻塞返回
      saveRenderedDoc({
        prisma,
        templateId: result.templateId,
        schemaVersion: result.schemaVersion,
        inputJson: data,
        htmlSha: result.sha,
        htmlBytes: result.bytes,
        source: 'api',
      }).catch((err: unknown) => {
        logger.error('[templates] saveRenderedDoc error', { error: err instanceof Error ? err.message : String(err) });
      });
      // 审计渲染操作（fail-closed：审计失败 → 抛出 → route catch 转 500）
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:templates:render',
        operation: 'render_template',
        targetType: 'Template',
        targetId: result.templateId,
        after: {
          templateId: result.templateId,
          schemaVersion: result.schemaVersion,
          sha: result.sha,
          bytes: result.bytes,
          generatedAt: result.generatedAt,
        },
        ip: req.ip || null,
      });
      const accept = String(req.headers['accept'] || '');
      if (accept.includes('text/html') && !accept.includes('application/json')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Template-Sha', result.sha);
        res.setHeader('X-Template-Schema-Version', String(result.schemaVersion));
        res.setHeader('X-Rendered-Doc-Id', 'pending');
        return res.send(result.html);
      }
      return res.json({
        renderedDocId: 'pending',
        templateId: result.templateId,
        schemaVersion: result.schemaVersion,
        sha: result.sha,
        bytes: result.bytes,
        generatedAt: result.generatedAt,
        html: result.html,
      });
    } catch (err) {
      if (err instanceof TemplateNotFoundError) {
        return res.status(404).json({ error: 'TemplateNotFound', id: req.params.id });
      }
      if (err instanceof TemplateRenderError) {
        return res.status(422).json({ error: 'TemplateRenderFailed', message: err.message });
      }
      logger.error('[templates] render error', { error: err instanceof Error ? err.message : String(err) });
      return res.status(500).json({ error: 'InternalError' });
    }
  });

  router.post('/:id/render.pdf', requireWrite, async (req: Request, res: Response) => {
    if (!isKnownTemplateId(req.params.id)) {
      return res.status(404).json({ error: 'TemplateNotFound', id: req.params.id });
    }
    const data = req.body?.data;
    const format = (req.body?.format as 'A4' | 'A5' | 'Letter' | undefined) ?? 'A4';
    const landscape = Boolean(req.body?.landscape);
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'InvalidPayload', message: 'body.data must be an object' });
    }
    try {
      const html = renderTemplate(req.params.id, data);
      const pdf = await renderHtmlToPdf(html.html, { format, landscape });
      // 同步落库 + PDF 文件存储
      let renderedDocId: string | undefined;
      try {
        const pdfPath = savePdfFile(pdf.pdf, `rnd-pdf-${Date.now()}`);
        renderedDocId = await saveRenderedDoc({
          prisma,
          templateId: html.templateId,
          schemaVersion: html.schemaVersion,
          inputJson: data,
          htmlSha: html.sha,
          htmlBytes: html.bytes,
          pdfSha: pdf.sha,
          pdfBytes: pdf.bytes,
          pdfPath,
          format,
          landscape,
          source: 'api',
        });
      } catch (storeErr) {
        try { logger.error('[templates] saveRenderedDoc error', { error: storeErr }); } catch { /* Diagnostics cannot replace the best-effort store outcome. */ }
      }
      // 审计渲染操作（fail-closed：审计失败 → 抛出 → route catch 转 500）
      await writeRouteAuditLog({
        prisma,
        actorId: actorIdFromRequest(req),
        source: 'route:templates:renderPdf',
        operation: 'render_template_pdf',
        targetType: 'RenderedDoc',
        targetId: renderedDocId || html.templateId,
        after: {
          renderedDocId: renderedDocId ?? null,
          templateId: html.templateId,
          schemaVersion: html.schemaVersion,
          htmlSha: html.sha,
          pdfSha: pdf.sha,
          pdfBytes: pdf.bytes,
          format: pdf.format,
          landscape,
          generatedAt: pdf.generatedAt,
        },
        ip: req.ip || null,
      });
      const accept = String(req.headers['accept'] || '');
      if (accept.includes('application/pdf')) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('X-Template-Sha', html.sha);
        res.setHeader('X-Pdf-Sha', pdf.sha);
        res.setHeader('X-Rendered-Doc-Id', renderedDocId ?? '');
        res.setHeader('Content-Length', String(pdf.bytes));
        return res.end(pdf.pdf);
      }
      return res.json({
        renderedDocId: renderedDocId ?? null,
        templateId: html.templateId,
        schemaVersion: html.schemaVersion,
        htmlSha: html.sha,
        pdfSha: pdf.sha,
        pdfBytes: pdf.bytes,
        pdfBase64: pdf.pdf.toString('base64'),
        format: pdf.format,
        landscape,
        generatedAt: pdf.generatedAt,
      });
    } catch (err) {
      const refusal = readTemplateRefusalTuple(err);
      if (refusal?.code === 'TemplateNotFound') {
        return res.status(refusal.statusCode).json({ error: refusal.code, id: req.params.id });
      }
      if (refusal?.code === 'TemplateRenderFailed') {
        return res.status(refusal.statusCode).json({ error: refusal.code, message: refusal.message });
      }
      try { logger.error('[templates] pdf error', { error: err }); } catch { /* Diagnostics cannot replace the failure response. */ }
      return res.status(500).json({ error: 'InternalError', message: GENERIC_ROUTE_ERROR_MESSAGE });
    }
  });

  return router;
}
