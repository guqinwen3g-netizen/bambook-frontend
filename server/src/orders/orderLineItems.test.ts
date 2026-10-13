import { describe, expect, it } from 'vitest';
import { normalizeItemNoForDisplay, nextItemNo } from './orderLineItems';

describe('server order line item helpers', () => {
  it('normalizes imported SAP item numbers for display', () => {
    expect(normalizeItemNoForDisplay('00010')).toBe('0010');
    expect(normalizeItemNoForDisplay('0011')).toBe('0011');
  });

  it('generates next ten-step item number ignoring revisions', () => {
    expect(nextItemNo([])).toBe('0010');
    expect(nextItemNo(['0010', '0011'])).toBe('0020');
    expect(nextItemNo(['00010', '00020'])).toBe('0030');
  });

  it('ignores empty and invalid item numbers when generating the next item number', () => {
    expect(nextItemNo([null])).toBe('0010');
    expect(nextItemNo([null, null])).toBe('0010');
    expect(nextItemNo(['', undefined, '0010'])).toBe('0020');
    expect(nextItemNo(['ABC'])).toBe('0010');
    expect(nextItemNo(['ABC', '0010'])).toBe('0020');
  });
});
