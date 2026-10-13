import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { extractPdfText } from '../extractText';

const FIXTURE =
  '/Users/qinwengu/WorkBuddy/Claw/BusinessDocu/00-Entities/Peerless/面料/BULK PO/PO#-4500159423-0001.pdf';

describe('extractPdfText', () => {
  it('extracts text and page count from a Peerless BULK PO', async () => {
    const buf = fs.readFileSync(FIXTURE);
    const { text, pages } = await extractPdfText(buf);
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(text).toContain('Vêtements Peerless Clothing Inc.');
    expect(text).toContain('PO number / season / date');
    expect(text).toContain('4500159423');
  });
});
