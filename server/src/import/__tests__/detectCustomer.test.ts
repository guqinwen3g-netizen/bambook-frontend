import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { detectCustomer } from '../detectCustomer';
import { extractPdfText } from '../extractText';

const FIXTURES = [
  'PO#-4500159423-0001.pdf',
  'PO#-4500159154-0001.pdf',
  'PO#-4500159120-0001.pdf',
  'PO#-4500159027-0001.pdf',
  'PO#-4500158987-0001.pdf',
];
const DIR = '/Users/qinwengu/WorkBuddy/Claw/BusinessDocu/00-Entities/Peerless/面料/BULK PO';

describe('detectCustomer', () => {
  it.each(FIXTURES)('detects Peerless in %s with high confidence', async (f) => {
    const buf = fs.readFileSync(`${DIR}/${f}`);
    const { text } = await extractPdfText(buf);
    const r = detectCustomer(text);
    expect(r.customerId).toBe('peerless');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('returns null with 0 confidence on unrelated text', () => {
    const r = detectCustomer('Hello world. Just some random text.');
    expect(r.customerId).toBeNull();
    expect(r.confidence).toBe(0);
  });
});
