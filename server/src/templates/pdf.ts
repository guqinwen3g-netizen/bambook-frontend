/**
 * HTML → PDF 渲染（Phase 6 — Compiled Templates）
 *
 * 设计：
 *   - 复用项目根已有的 playwright（^1.60.0），不引入新依赖
 *   - 单例 Browser，进程退出时自动关
 *   - 输入 html，输出 PDF Buffer + 元数据
 *   - channel='chrome' 复用系统已装 Google Chrome，不需额外下载 Chromium
 */

import crypto from 'crypto';

let browserPromise: Promise<any> | null = null;

async function getBrowser(): Promise<any> {
  if (browserPromise) return browserPromise;
  // 动态加载，避免主进程在不渲染 PDF 时也启动浏览器
  browserPromise = (async () => {
    let chromium: any;
    try {
      // playwright 在仓库根（apps/Bambook/node_modules/playwright）
      // server tsconfig 默认 NodeNext —— Node 自身的解析能找到顶层 node_modules
      chromium = (await import('playwright')).chromium;
    } catch (err) {
      throw new Error(`Playwright not available: ${err instanceof Error ? err.message : err}`);
    }
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
    });
    process.once('beforeExit', () => browser.close().catch(() => {}));
    return browser;
  })();
  try {
    return await browserPromise;
  } catch (err) {
    browserPromise = null;
    throw err;
  }
}

export interface PdfRenderOptions {
  /** A4 / A5 / Letter，默认 A4。Fabric 模板内嵌 @page A5 landscape，给 A4 也兼容 */
  format?: 'A4' | 'A5' | 'Letter';
  landscape?: boolean;
  /** 上下左右页边，默认 12mm */
  margin?: { top?: string; bottom?: string; left?: string; right?: string };
  /** 打印背景色（模板内嵌的 @media print 已用 -webkit-print-color-adjust:exact） */
  printBackground?: boolean;
}

export interface PdfRenderResult {
  pdf: Buffer;
  /** Complete SHA-256 of the returned bytes, used for protected archive proof. */
  sha: string;
  bytes: number;
  generatedAt: string;
  format: string;
}

export async function renderHtmlToPdf(
  html: string,
  options: PdfRenderOptions = {},
): Promise<PdfRenderResult> {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdfBuffer: Buffer = await page.pdf({
      format: options.format ?? 'A4',
      landscape: options.landscape ?? false,
      printBackground: options.printBackground ?? true,
      margin: {
        top: options.margin?.top ?? '12mm',
        bottom: options.margin?.bottom ?? '12mm',
        left: options.margin?.left ?? '12mm',
        right: options.margin?.right ?? '12mm',
      },
    });
    const sha = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    return {
      pdf: pdfBuffer,
      sha,
      bytes: pdfBuffer.length,
      generatedAt: new Date().toISOString(),
      format: options.format ?? 'A4',
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
