/** Business calendar only. Native Date, Date.now, timers, stored event dates,
 * IDs and technical versions are intentionally independent of this module. */
export const FIXED_BUSINESS_TIME_ISO = '2026-10-08T00:18:00.000Z';
export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
export const BUSINESS_CLOCK_DATABASE = 'panda_hub_dev';
export type BusinessClock = { mode: 'fixed' | 'wall'; nowIso: string; timeZone: typeof BUSINESS_TIME_ZONE; database: string };

let installed: BusinessClock | null = null;
let installationIsCurrent: (() => boolean) | null = null;
let verificationState: 'idle' | 'pending' | 'failed' = 'idle';
let verificationError = '';
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseBusinessClock(value: unknown): BusinessClock {
  if (!isRecord(value) || value.mode !== 'fixed' && value.mode !== 'wall' || value.timeZone !== BUSINESS_TIME_ZONE
    || typeof value.database !== 'string' || !value.database.trim() || typeof value.nowIso !== 'string'
    || !Number.isFinite(Date.parse(value.nowIso)) || new Date(value.nowIso).toISOString() !== value.nowIso
    || value.mode === 'fixed' && (value.nowIso !== FIXED_BUSINESS_TIME_ISO || value.database !== BUSINESS_CLOCK_DATABASE)) {
    throw new Error('业务时间读回不完整或不符合当前开发环境，请重新核对服务。');
  }
  return { mode: value.mode, nowIso: value.nowIso, timeZone: BUSINESS_TIME_ZONE, database: value.database };
}
/** Caller must first verify the server runtime's status guards. */
export function installBusinessClock(value: unknown, isCurrent?: () => boolean): BusinessClock {
  installed = parseBusinessClock(value); installationIsCurrent = isCurrent ?? null;
  verificationState = 'idle'; verificationError = ''; return getBusinessClock();
}
export function beginBusinessClockVerification(): void { verificationState = 'pending'; verificationError = ''; }
export function failBusinessClockVerification(message: string): void { verificationState = 'failed'; verificationError = message; }
export function resetBusinessClock(): void { installed = null; installationIsCurrent = null; verificationState = 'idle'; verificationError = ''; }
export function getBusinessClock(): BusinessClock {
  if (verificationState === 'pending') throw new Error('业务时间正在核验，请等待当前服务读回。');
  if (verificationState === 'failed') throw new Error(verificationError || '业务时间尚未核验，请刷新应用。');
  if (installed && installationIsCurrent && !installationIsCurrent()) {
    throw new Error('业务时间服务地址已变化，请刷新应用后重新核验。');
  }
  if (installed?.mode === 'fixed') return { ...installed };
  return { mode: 'wall', nowIso: new Date().toISOString(), timeZone: BUSINESS_TIME_ZONE, database: installed?.database ?? '(unknown)' };
}
export function businessNowMs(): number { return Date.parse(getBusinessClock().nowIso); }
export function businessNowDate(): Date { return new Date(businessNowMs()); }
/** A business calendar projection is explicit about Asia/Shanghai even when
 * the browser happens to use a different system timezone. */
export function businessDateKey(value: number | string | Date = businessNowMs()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('业务日期无效。');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(row => row.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function businessTodayKey(): string { return businessDateKey(businessNowMs()); }

/** Compatibility for frontend callers formerly importing the server's date
 * helpers. Historical epochs keep their explicit business-zone projection. */
export function localDateKey(value: Date): string {
  return businessDateKey(value);
}
export const todayLocalKey = businessTodayKey;
export function isValidLocalDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number), date = new Date(0);
  date.setUTCHours(12, 0, 0, 0); date.setUTCFullYear(year, month - 1, day);
  const roundtrip = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  return Number.isFinite(date.getTime()) && roundtrip === value;
}
