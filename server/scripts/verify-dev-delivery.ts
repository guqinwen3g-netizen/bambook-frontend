/**
 * verify-dev-delivery —— 开发环境交付核验：前端与服务端两个服务都健康，且部署的提交与 main 一致。
 *
 *   npx tsx scripts/verify-dev-delivery.ts --frontend=http://127.0.0.1:5173 --server=http://127.0.0.1:3001 \
 *     [--mist=http://127.0.0.1:8082] [--expected=<main 提交 SHA>]
 *
 * 检查项：
 *   1. 前端：首页 2xx；`mist-version.json` 的 commit 与 main 一致，且 localChanges = 0（构建时没有未提交改动）；
 *   2. 服务端：`/api/health` 为 status=ok、database=ok，`build` 与 main 一致；
 *   3. （可选）Mist 工作空间服务：`/api/health` 为 status=ok、database=ok。
 * main 的 SHA：--expected / EXPECTED_MAIN_SHA 优先，否则读本地 `git rev-parse origin/main`（先 git fetch）。
 * 安全门：拒绝正式环境主机（默认 jiangsupanda.com，可用 BAMBOOK_PRODUCTION_HOSTS 追加，逗号分隔）。只发 GET，不写任何数据。
 * 退出码：0 全部通过；1 有检查失败；2 参数错误或拒绝运行。
 */
import { execFileSync } from 'node:child_process';

export type DeliveryCheck = { name: string; ok: boolean; detail: string };
export type DeliveryOptions = { frontend: string; server: string; mist?: string; expected: string; fetchImpl?: typeof fetch; timeoutMs?: number };

const DEFAULT_PRODUCTION_HOSTS = ['jiangsupanda.com'];
export function productionHost(url: string, extra = process.env.BAMBOOK_PRODUCTION_HOSTS || ''): string | null {
  const host = new URL(url).hostname.toLowerCase();
  const denied = [...DEFAULT_PRODUCTION_HOSTS, ...extra.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)];
  return denied.find(item => host === item || host.endsWith('.' + item)) ?? null;
}
/** 短 SHA 与完整 SHA 互相前缀匹配即视为同一提交；至少 7 位，避免空值或过短误判。 */
export const sameCommit = (actual: unknown, expected: string) => typeof actual === 'string' && actual.length >= 7 && expected.length >= 7
  && (expected.toLowerCase().startsWith(actual.toLowerCase()) || actual.toLowerCase().startsWith(expected.toLowerCase()));

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs: number) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
  let body: any = null; try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

export async function verifyDelivery(options: DeliveryOptions): Promise<DeliveryCheck[]> {
  const fetchImpl = options.fetchImpl ?? fetch, timeoutMs = options.timeoutMs ?? 10_000, checks: DeliveryCheck[] = [];
  const base = (url: string) => url.replace(/\/+$/, '');
  const guard = async (name: string, run: () => Promise<DeliveryCheck>) => { try { checks.push(await run()); } catch (error: any) { checks.push({ name, ok: false, detail: `请求失败：${error?.message || error}` }); } };
  await guard('前端首页可访问', async () => { const r = await fetchImpl(base(options.frontend) + '/', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) } as RequestInit); return { name: '前端首页可访问', ok: r.status >= 200 && r.status < 300, detail: `HTTP ${r.status}` }; });
  await guard('前端版本与 main 一致', async () => {
    const r = await getJson(fetchImpl, base(options.frontend) + '/mist-version.json', timeoutMs), v = r.body || {};
    const ok = r.status === 200 && sameCommit(v.commit, options.expected) && v.localChanges === 0;
    return { name: '前端版本与 main 一致', ok, detail: `HTTP ${r.status}；commit=${v.commit ?? '缺失'}，branch=${v.branch ?? '缺失'}，localChanges=${v.localChanges ?? '缺失'}；main=${options.expected.slice(0, 12)}` };
  });
  await guard('服务端健康且版本与 main 一致', async () => {
    const r = await getJson(fetchImpl, base(options.server) + '/api/health', timeoutMs), h = r.body || {};
    const ok = r.status === 200 && h.status === 'ok' && h.database === 'ok' && sameCommit(h.build, options.expected);
    return { name: '服务端健康且版本与 main 一致', ok, detail: `HTTP ${r.status}；status=${h.status ?? '缺失'}，database=${h.database ?? '缺失'}，build=${h.build ?? '缺失'}；main=${options.expected.slice(0, 12)}` };
  });
  if (options.mist) await guard('Mist 工作空间服务健康', async () => {
    const r = await getJson(fetchImpl, base(options.mist!) + '/api/health', timeoutMs), h = r.body || {};
    return { name: 'Mist 工作空间服务健康', ok: r.status === 200 && h.status === 'ok' && (h.database === 'ok' || h.storage === 'local-file'), detail: `HTTP ${r.status}；status=${h.status ?? '缺失'}，database=${h.database ?? h.storage ?? '缺失'}` };
  });
  return checks;
}

function mainSha(): string {
  const explicit = process.env.EXPECTED_MAIN_SHA;
  if (explicit) return explicit.trim();
  try { execFileSync('git', ['fetch', '--quiet', 'origin', 'main'], { stdio: 'ignore' }); } catch { /* 离线时退回本地已知的 origin/main */ }
  return execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
}

async function cli() {
  const arg = (key: string) => process.argv.find(item => item.startsWith(`--${key}=`))?.slice(key.length + 3);
  const frontend = arg('frontend') || process.env.DEV_FRONTEND_URL, server = arg('server') || process.env.DEV_SERVER_URL, mist = arg('mist') || process.env.DEV_MIST_URL;
  if (!frontend || !server) { console.error('需要 --frontend 与 --server（或 DEV_FRONTEND_URL / DEV_SERVER_URL）'); process.exit(2); }
  for (const url of [frontend, server, mist].filter(Boolean) as string[]) { const hit = productionHost(url); if (hit) { console.error(`拒绝：${url} 属于正式环境主机 ${hit}；本脚本只核验开发环境`); process.exit(2); } }
  let expected = arg('expected');
  try { expected = expected || mainSha(); } catch { console.error('无法确定 main 的提交 SHA，请用 --expected 或 EXPECTED_MAIN_SHA 指定'); process.exit(2); }
  const checks = await verifyDelivery({ frontend, server, mist, expected: expected! });
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}：${c.detail}`);
  const ok = checks.every(c => c.ok); console.log(ok ? `交付核验通过（main=${expected}）` : `交付核验失败：${checks.filter(c => !c.ok).length} / ${checks.length} 项`);
  process.exit(ok ? 0 : 1);
}
if (require.main === module) void cli();
