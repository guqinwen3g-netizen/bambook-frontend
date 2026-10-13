type TtsAnnotationType =
  | 'date'
  | 'po'
  | 'sku'
  | 'invoice'
  | 'code'
  | 'spell'
  | 'money'
  | 'quantity'
  | 'percent';

const TTS_TAG_RE = /<\/?tts\b[^>]*>/gi;
const TTS_ANNOTATION_RE = /<tts\b([^>]*)>([\s\S]*?)<\/tts>/gi;
const DIGIT_SPEECH: Record<string, string> = {
  '0': '零',
  '1': '一',
  '2': '二',
  '3': '三',
  '4': '四',
  '5': '五',
  '6': '六',
  '7': '七',
  '8': '八',
  '9': '九',
};

const LETTER_SPEECH: Record<string, string> = {
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D',
  E: 'E',
  F: 'F',
  G: 'G',
  H: 'H',
  I: 'I',
  J: 'J',
  K: 'K',
  L: 'L',
  M: 'M',
  N: 'N',
  O: 'O',
  P: 'P',
  Q: 'Q',
  R: 'R',
  S: 'S',
  T: 'T',
  U: 'U',
  V: 'V',
  W: 'W',
  X: 'X',
  Y: 'Y',
  Z: 'Z',
};

export function stripTtsAnnotationsForDisplay(input: string) {
  return String(input || '').replace(TTS_TAG_RE, '');
}

export function createTtsAnnotationStripper() {
  let pending = '';
  return {
    push(chunk: string) {
      const combined = pending + String(chunk || '');
      pending = '';
      const { output, rest } = stripCompleteTtsTags(combined);
      pending = rest;
      return output;
    },
    flush() {
      const output = stripTtsAnnotationsForDisplay(pending);
      pending = '';
      return output;
    },
  };
}

export function normalizeTextForTts(input: string) {
  let text = String(input || '');
  text = replaceLabeledAnnotatedCodes(text);
  text = text.replace(TTS_ANNOTATION_RE, (_match, attrs, value) => {
    const type = parseTtsType(attrs);
    return speakAnnotatedValue(type, stripTtsAnnotationsForDisplay(value).trim());
  });
  text = stripTtsAnnotationsForDisplay(text);
  text = applyFallbackRules(text);
  return text
    .replace(/[*#`_~[\]()]/g, '')
    .replace(/\s*\n\s*/g, '，')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripCompleteTtsTags(input: string) {
  let output = '';
  let cursor = 0;

  while (cursor < input.length) {
    const open = input.indexOf('<', cursor);
    if (open < 0) {
      output += input.slice(cursor);
      break;
    }
    output += input.slice(cursor, open);
    const close = input.indexOf('>', open + 1);
    if (close < 0) {
      return { output, rest: input.slice(open) };
    }

    const tag = input.slice(open, close + 1);
    if (/^<\/?tts\b/i.test(tag)) {
      cursor = close + 1;
      continue;
    }
    output += tag;
    cursor = close + 1;
  }

  return { output, rest: '' };
}

function replaceLabeledAnnotatedCodes(input: string) {
  return input.replace(
    /\b(PO|P\/O|SKU|STYLE|INV|INVOICE|CODE)\s*[:#：-]?\s*<tts\b([^>]*)>([\s\S]*?)<\/tts>/gi,
    (_match, label, attrs, value) => {
      const type = parseTtsType(attrs);
      const cleanValue = stripTtsAnnotationsForDisplay(value).trim();
      return `${speakCode(String(label).replace(/\//g, ''))} ${speakAnnotatedValue(type, cleanValue, { suppressCodePrefix: true })}`;
    },
  );
}

function parseTtsType(attrs: string): TtsAnnotationType {
  const match = String(attrs || '').match(/\btype\s*=\s*["']?([a-zA-Z_-]+)["']?/);
  const raw = String(match?.[1] || 'spell').toLowerCase();
  if (['date', 'po', 'sku', 'invoice', 'code', 'spell', 'money', 'quantity', 'percent'].includes(raw)) {
    return raw as TtsAnnotationType;
  }
  return 'spell';
}

function speakAnnotatedValue(type: TtsAnnotationType, value: string, options: { suppressCodePrefix?: boolean } = {}) {
  if (!value) return '';
  if (type === 'date') return speakDate(value) || value;
  if (type === 'percent') return speakPercent(value) || value;
  if (type === 'money') return speakMoney(value) || value;
  if (type === 'quantity') return value;
  if (type === 'po' && !options.suppressCodePrefix) return `P O ${speakCode(value)}`.trim();
  return speakCode(value);
}

function applyFallbackRules(input: string) {
  let text = input;
  text = text.replace(
    /\b((?:20|19)\d{2})[-/.年](0?[1-9]|1[0-2])[-/.月](0?[1-9]|[12]\d|3[01])日?\b/g,
    (match, year, month, day) => speakDateParts(year, month, day) || match,
  );
  text = text.replace(
    /\b((?:20|19)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/g,
    (match, year, month, day) => speakDateParts(year, month, day) || match,
  );
  text = text.replace(
    /\b(PO|P\/O|SKU|STYLE|INV|INVOICE|CODE)\s*[:#：-]?\s*([A-Z0-9][A-Z0-9-]{2,})\b/gi,
    (_match, label, code) => `${speakCode(String(label).replace(/\//g, ''))} ${speakCode(code)}`,
  );
  text = text.replace(
    /(订单号|编号|客户编号|发票号|代码|客户码|款号|辅料编码)\s*[:#：-]?\s*([A-Za-z0-9][A-Za-z0-9-]{2,})/g,
    (_match, label, code) => `${label}${speakCode(code)}`,
  );
  text = spellStandaloneUppercaseAcronyms(text);
  text = text.replace(/\b[A-Z]{2,}[-]?[A-Z0-9-]*\d[A-Z0-9-]*\b/g, match => speakCode(match));
  text = text.replace(/\b\d{5,}\b(?!\s*(?:%|码|米|件|条|yards?|pcs|kg|千克|克))/gi, match => speakDigits(match));
  return text;
}

function spellStandaloneUppercaseAcronyms(input: string) {
  return input.replace(
    /(^|[^A-Za-z0-9-])([A-Z]{2,}(?:[/-][A-Z]{2,})*)(?![A-Za-z0-9-])/g,
    (_match, prefix, acronym) => `${prefix}${speakCode(acronym)}`,
  );
}

function speakDate(value: string) {
  const clean = value.trim();
  let match = clean.match(/^((?:20|19)\d{2})[-/.年](0?[1-9]|1[0-2])[-/.月](0?[1-9]|[12]\d|3[01])日?$/);
  if (!match) {
    match = clean.match(/^((?:20|19)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/);
  }
  return match ? speakDateParts(match[1], match[2], match[3]) : '';
}

function speakDateParts(year: string, month: string, day: string) {
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (!monthNum || monthNum > 12 || !dayNum || dayNum > 31) return '';
  return `${speakDigits(year, '')}年${speakSmallNumber(monthNum)}月${speakSmallNumber(dayNum)}日`;
}

function speakCode(value: string) {
  return String(value || '')
    .trim()
    .replace(/[_/]+/g, '-')
    .split('')
    .map(char => {
      if (DIGIT_SPEECH[char]) return DIGIT_SPEECH[char];
      const upper = char.toUpperCase();
      if (LETTER_SPEECH[upper]) return LETTER_SPEECH[upper];
      if (char === '-') return '，';
      return char;
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s+，\s+/g, '，')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function speakDigits(value: string, separator = ' ') {
  return String(value || '')
    .split('')
    .map(char => DIGIT_SPEECH[char] || char)
    .join(separator);
}

function speakSmallNumber(value: number) {
  if (value <= 10) return value === 10 ? '十' : DIGIT_SPEECH[String(value)];
  if (value < 20) return `十${DIGIT_SPEECH[String(value - 10)]}`;
  const ten = Math.floor(value / 10);
  const one = value % 10;
  return `${DIGIT_SPEECH[String(ten)]}十${one ? DIGIT_SPEECH[String(one)] : ''}`;
}

function speakPercent(value: string) {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)%$/);
  return match ? `百分之${speakDecimal(match[1])}` : '';
}

function speakMoney(value: string) {
  const clean = value.trim();
  const currency = clean.includes('$') ? '美元' : clean.includes('¥') || clean.includes('￥') ? '元' : '';
  const number = clean.replace(/[$¥￥,\s]/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(number)) return '';
  return `${speakDecimal(number)}${currency}`;
}

function speakDecimal(value: string) {
  const [integer, decimal] = value.split('.');
  if (!decimal) return integer;
  return `${integer}点${speakDigits(decimal, '')}`;
}
