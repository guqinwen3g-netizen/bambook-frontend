import { extractPdfText } from './extractText';
import { detectCustomer } from './detectCustomer';
import { parsersByCustomer } from './registry';
import { ParseResult } from './types';

/**
 * Top-level entry: PDF buffer -> ParseResult.
 *
 *   1. Extract raw text via pdf-parse.
 *   2. Detect customer (rule-based scoring).
 *   3. If a parser is registered for the detected customer, run it.
 *   4. Otherwise return detection-only ParseResult; caller decides UX.
 *
 * Errors are caught and surfaced via `error` field rather than thrown.
 */
export async function parseOrderPdf(buffer: Buffer): Promise<ParseResult> {
  try {
    const { text, pages } = await extractPdfText(buffer);
    const detection = detectCustomer(text);
    if (!detection.customerId) {
      return { detection, rawText: text, pages };
    }
    const parser = parsersByCustomer[detection.customerId];
    if (!parser) {
      return {
        detection,
        rawText: text,
        pages,
        error: `No parser registered for ${detection.customerId}`,
      };
    }
    const order = parser(text);
    return { detection, order, rawText: text, pages };
  } catch (e: any) {
    return {
      detection: { customerId: null, confidence: 0, reasons: [] },
      rawText: '',
      pages: 0,
      error: String(e?.message ?? e),
    };
  }
}
