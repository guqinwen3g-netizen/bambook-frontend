/** Shared item identity formatting for ledger UI and exports. */
export function displayItemNo(itemNo: string | null | undefined): string {
  const raw = String(itemNo ?? '').trim();
  if (/^\d{5}$/.test(raw) && raw.startsWith('0')) return raw.slice(1);
  if (/^\d{1,4}$/.test(raw)) return raw.padStart(4, '0');
  return raw || '0010';
}

