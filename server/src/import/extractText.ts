export interface ExtractResult {
  text: string;
  pages: number;
}

/**
 * Thin async wrapper over pdf-parse v2 (ESM-only).
 * Uses dynamic import so this CJS-compiled module can still consume it.
 */
export async function extractPdfText(buffer: Buffer): Promise<ExtractResult> {
  const mod = await import('pdf-parse');
  const PDFParse = (mod as any).PDFParse;
  if (!PDFParse) throw new Error('pdf-parse: PDFParse export not found');
  const parser = new PDFParse({ data: buffer });
  const r = await parser.getText();
  const pages = Array.isArray(r.pages)
    ? r.pages.length
    : typeof r.pages === 'number'
      ? r.pages
      : typeof r.numpages === 'number'
        ? r.numpages
        : 0;
  return { text: String(r.text ?? ''), pages };
}
