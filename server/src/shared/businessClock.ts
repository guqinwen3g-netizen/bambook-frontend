import { getActiveDb } from '../devPanel/activeDb';

/** A business as-of time, never a replacement for process time. Authentication,
 * request durations, IDs, retry windows and optimistic versions stay on Date. */
export const FIXED_BUSINESS_TIME_ISO = '2026-10-08T00:18:00.000Z';
export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
export const BUSINESS_CLOCK_DATABASE = 'panda_hub_dev';
export type BusinessClock = { mode: 'fixed' | 'wall'; nowIso: string; timeZone: typeof BUSINESS_TIME_ZONE; database: string };

const configuredValue = () => (process.env.BAMBOOK_DEV_BUSINESS_TIME || '').trim();
const configurationError = (message: string): never => { throw new Error(`DEV_BUSINESS_CLOCK_INVALID: ${message}`); };
function checkInstant(value: string): void {
  if (![FIXED_BUSINESS_TIME_ISO, '2026-10-08T00:18:00Z', '2026-10-08T00:18Z'].includes(value)) {
    configurationError('BAMBOOK_DEV_BUSINESS_TIME must be 2026-10-08T00:18:00.000Z.');
  }
}
function checkDatabaseUrl(): void {
  let url: URL;
  try { url = new URL(process.env.DATABASE_URL || ''); }
  catch { return configurationError('A loopback PostgreSQL panda_hub_dev DATABASE_URL is required.'); }
  let database: string;
  try { database = decodeURIComponent(url.pathname.slice(1)); }
  catch { return configurationError('The development database name is invalid.'); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase())
    || database !== BUSINESS_CLOCK_DATABASE
    || [...url.searchParams.keys()].some(key => ['host', 'hostaddr', 'dbname', 'database', 'service'].includes(key.toLowerCase()))) {
    configurationError('Only the exact loopback PostgreSQL panda_hub_dev database may use fixed business time.');
  }
}
/** Call after dotenv has loaded and before the server starts. Do not silently
 * accept a configured freeze that failed its environment/database guards. */
export function assertBusinessClockConfiguration(): void {
  const value = configuredValue();
  if (!value) return;
  checkInstant(value);
  if (process.env.NODE_ENV === 'production') configurationError('Fixed business time is forbidden in production.');
  if (process.env.BAMBOOK_DEV_PANEL !== '1') configurationError('BAMBOOK_DEV_PANEL=1 is required.');
  if (getActiveDb() !== BUSINESS_CLOCK_DATABASE) configurationError('The current database must be exactly panda_hub_dev.');
  checkDatabaseUrl();
  // Existing business schedulers use native getHours/getDay. Apply the business
  // timezone only after all dev-only guards passed; epoch time remains native.
  if (process.env.TZ !== BUSINESS_TIME_ZONE) process.env.TZ = BUSINESS_TIME_ZONE;
}
export function getBusinessClock(): BusinessClock {
  const database = getActiveDb(), value = configuredValue();
  // A dev pointer must never cause another database or production to freeze.
  // Startup assertion separately reports attempted unsafe configurations.
  if (!value || process.env.NODE_ENV === 'production' || database !== BUSINESS_CLOCK_DATABASE) {
    return { mode: 'wall', nowIso: new Date().toISOString(), timeZone: BUSINESS_TIME_ZONE, database };
  }
  assertBusinessClockConfiguration();
  return { mode: 'fixed', nowIso: FIXED_BUSINESS_TIME_ISO, timeZone: BUSINESS_TIME_ZONE, database };
}
export function businessNowMs(): number { return Date.parse(getBusinessClock().nowIso); }
export function businessNowDate(): Date { return new Date(businessNowMs()); }
