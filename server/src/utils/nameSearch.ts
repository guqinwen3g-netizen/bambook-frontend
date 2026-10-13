import { pinyin } from 'pinyin-pro';

/** Only alphabetic queries opt into pinyin; punctuation stays literal. */
export function isLatinNameSearch(search: string): boolean {
  return /^[a-z]+$/i.test(search);
}

/** Case-insensitive literal, full pinyin and pinyin-first-letter substrings. */
export function matchesNameSearch(name: string, search: string): boolean {
  const needle = search.toLowerCase();
  if (name.toLowerCase().includes(needle)) return true;
  if (!isLatinNameSearch(search) || !/\p{Script=Han}/u.test(name)) return false;
  const full = pinyin(name, { toneType: 'none', type: 'array' }).join('').toLowerCase();
  if (full.includes(needle)) return true;
  const first = pinyin(name, { pattern: 'first', toneType: 'none', type: 'array' }).join('').toLowerCase();
  return first.includes(needle);
}
