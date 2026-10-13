import { describe, it, expect } from 'vitest';
import { isLatinNameSearch, matchesNameSearch } from './nameSearch';

describe('name search', () => {
  it.each(['L', 'l', 'lu', 'LU', 'Lu'])('%s matches 路', search => {
    expect(matchesNameSearch('路港服装', search)).toBe(true);
  });
  it.each(['bc', 'BC', 'bC', 'beichen', 'BEICHEN'])('%s matches 北辰', search => {
    expect(matchesNameSearch('上海北辰服装', search)).toBe(true);
  });
  it('uses first letters rather than multi-letter consonant initials', () => {
    expect(matchesNameSearch('辰州', 'cz')).toBe(true);
  });
  it('preserves literal English and Chinese substrings', () => {
    expect(matchesNameSearch('Acme Textiles', 'ACME')).toBe(true);
    expect(matchesNameSearch('上海北辰服装', '北辰')).toBe(true);
    expect(matchesNameSearch('北辰ACME', 'AcMe')).toBe(true);
    expect(matchesNameSearch('Acme Textiles', 'AT')).toBe(false);
    expect(matchesNameSearch('路港服装', 'xyz')).toBe(false);
  });
  it('does not treat percent or underscore as wildcards', () => {
    expect(matchesNameSearch('Acme%_北辰', '%_')).toBe(true);
    expect(matchesNameSearch('Acme北辰', '%')).toBe(false);
    expect(matchesNameSearch('Acme北辰', '_')).toBe(false);
    expect(matchesNameSearch('北辰', 'bc%')).toBe(false);
    expect(isLatinNameSearch('%_needle')).toBe(false);
  });
});
