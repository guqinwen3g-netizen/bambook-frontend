import { getAuthApiBase } from './authService';
import { BUSINESS_CLOCK_DATABASE, FIXED_BUSINESS_TIME_ISO, BUSINESS_TIME_ZONE, beginBusinessClockVerification, failBusinessClockVerification, installBusinessClock, parseBusinessClock, type BusinessClock } from '../lib/businessClock';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const normalize = (value: string) => value.trim().replace(/\/+$/, '');
let generation = 0;
function checkedStatus(data: unknown): BusinessClock {
  if (!isRecord(data) || data.ok !== true || typeof data.currentDb !== 'string' || !isRecord(data.env)
    || typeof data.env.nodeEnv !== 'string' || !data.env.nodeEnv.trim() || typeof data.env.devPanel !== 'boolean') {
    throw new Error('业务时间状态无法核验，请检查当前开发服务。');
  }
  const clock = parseBusinessClock(data.businessClock);
  if (clock.database !== data.currentDb || clock.mode === 'fixed' && (
    data.devPanelEnabled !== true || data.currentDb !== BUSINESS_CLOCK_DATABASE || data.env.nodeEnv === 'production' || data.env.devPanel !== true
    || clock.nowIso !== FIXED_BUSINESS_TIME_ISO || clock.timeZone !== BUSINESS_TIME_ZONE)) {
    throw new Error('业务时间不属于已核验的 panda_hub_dev 开发环境。');
  }
  return clock;
}
/** Await before importing App: several business form defaults are evaluated
 * during module loading. Failure is visible to bootstrap, never pretend fixed. */
export async function initializeDevBusinessClock(options: { endpoint?: string; fetchImpl?: typeof fetch } = {}): Promise<BusinessClock> {
  const epoch = ++generation, endpoint = normalize(options.endpoint ?? getAuthApiBase());
  beginBusinessClockVerification();
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
  const current = () => epoch === generation && (options.endpoint !== undefined || normalize(getAuthApiBase()) === endpoint);
  try {
    if (!endpoint) throw new Error('业务时间服务地址未配置。');
    const response = await (options.fetchImpl ?? fetch)(`${endpoint}/dev/status`, { method: 'GET', cache: 'no-store', credentials: 'include', signal: controller.signal });
    if (!current()) throw new Error('业务时间服务地址或初始化请求已变化，请重新读取。');
    // The dev-only endpoint is absent in production by design.
    if (response.status === 404) return installBusinessClock({ mode: 'wall', nowIso: new Date().toISOString(),
      timeZone: BUSINESS_TIME_ZONE, database: '(dev status unavailable)' }, current);
    if (!response.ok) throw new Error(`业务时间读取失败（HTTP ${response.status}）。`);
    const data: unknown = await response.json();
    if (!current()) throw new Error('业务时间服务地址或初始化请求已变化，请重新读取。');
    return installBusinessClock(checkedStatus(data), current);
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : '服务返回无法读取。';
    const message = `业务时间尚未核验，应用启动已暂停：${detail}`;
    if (current()) failBusinessClockVerification(message);
    throw new Error(message);
  } finally { clearTimeout(timeout); }
}
