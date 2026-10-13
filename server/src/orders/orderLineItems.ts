export function normalizeItemNoForDisplay(itemNo: string | null | undefined): string {
  const raw = String(itemNo ?? '').trim();
  if (/^\d{5}$/.test(raw) && raw.startsWith('0')) return raw.slice(1);
  if (/^\d{1,4}$/.test(raw)) return raw.padStart(4, '0');
  return raw || '0010';
}

export function nextItemNo(existing: Array<string | null | undefined>): string {
  const mainNumbers = existing
    .map((value) => {
      const raw = String(value ?? '').trim();
      if (!raw) return null;
      return normalizeItemNoForDisplay(raw);
    })
    .filter((v): v is string => !!v && /^\d{4}$/.test(v))
    .map((v) => Math.floor(Number(v) / 10) * 10);
  const next = mainNumbers.length === 0 ? 10 : Math.max(...mainNumbers) + 10;
  return String(next).padStart(4, '0');
}
