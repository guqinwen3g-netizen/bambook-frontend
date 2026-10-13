/**
 * uploadsGuard.ts — 上传目录敏感子树拒绝直读
 *
 * ## 背景（2026-09-15 实测发现的绕过）
 *
 * `/api/uploads` 由 `express.static` **无鉴权**直读，原先用 5 条字面量挂载拦截：
 *   app.use('/api/uploads/trade-documents', 404) ...
 *
 * 问题在于**匹配视角不一致**：`app.use` 拿原始 URL 做前缀匹配，
 * 而 `express.static` 会先解码、再把重复斜杠当单个处理，然后才落盘查找。
 * 于是以下写法全部绕过拦截、匿名拿到 200（实测 248,896 字节的商业发票 PDF）：
 *   - `/api/uploads//trade-documents/xxx.pdf`        重复斜杠
 *   - `/api/uploads/trade%2Ddocuments/xxx.pdf`       URL 编码的连字符
 *   - `/api/uploads/trade-documents%2Fxxx.pdf`       编码的斜杠
 *
 * 这些 PDF（CO 商业发票 / PL 装箱单 / 提单）含客户与价格数据，属高敏。
 *
 * ## 本守卫的口径
 *
 * 站在**与 static 相同的视角**比对：先解码 → 归一化重复斜杠 → 取首段 → 小写比较。
 * 另对含 `..` 的路径一律拒绝（fail-closed，合法 URL 从不含 `..`）。
 */
import type { Request, Response, NextFunction } from 'express';

/**
 * 敏感子树：只允许经带权限门的下载路由读取。
 * 按**首段目录名小写**比较。
 */
export const SENSITIVE_UPLOAD_SUBTREES: ReadonlySet<string> = new Set([
    'test-reports',
    'email-attachments',
    'trade-documents',
    'quotations',
    'knowledge-documents',
    'invoices',
]);

/**
 * 把请求路径归一化到与 express.static 落盘查找一致的形态。
 * 解码失败（非法百分号编码）时保留原样，交由后续判定。
 */
export function normalizeUploadSubpath(rawPath: string): string {
    let decoded = rawPath;
    try {
        decoded = decodeURIComponent(rawPath);
    } catch {
        decoded = rawPath;
    }
    // 重复斜杠折叠为单个（static 也是这么处理的）
    return decoded.replace(/\/{2,}/g, '/');
}

/** 判定该子路径是否命中敏感子树（含 `..` 一律视为可疑） */
export function isSensitiveUploadPath(rawPath: string): boolean {
    const normalized = normalizeUploadSubpath(rawPath || '');
    const segments = normalized.split('/').filter(Boolean);
    // 路径穿越：合法 URL 不会出现，直接拒绝，避免 ../ 绕过首段判定
    if (segments.some((s) => s === '..')) return true;
    const first = (segments[0] || '').toLowerCase();
    return SENSITIVE_UPLOAD_SUBTREES.has(first);
}

/** Express 中间件：命中敏感子树 → 404（不暴露文件是否存在的差异） */
export function createUploadsGuard() {
    return (req: Request, res: Response, next: NextFunction) => {
        if (isSensitiveUploadPath(req.path || '')) {
            return res.status(404).end();
        }
        return next();
    };
}
