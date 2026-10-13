/**
 * post-deploy-verify
 * ==================
 *
 * 部署后自检脚本，用于消除"工程做了但没部署"这类隐性技术债。
 *
 * 设计原则（系统思维）：
 *   - 单一信任源：本地源码 `agent/mcp/manifest.ts` 的 MANIFEST_SEEDS 是工具清单的权威；
 *     远程 `/api/v1/agent/mcp/manifest` 必须等于它。任何不等就是部署链路漂移。
 *   - 不假设结果：不预设"正确"，把 diff 直接打印给人看（远程缺什么、远程多什么）。
 *   - 通用而非特例：REST 探针走配置，不写死路径；新增模块只要补 router 即可被覆盖。
 *   - 失败可观测：每项失败给出具体动作建议，不是只说 "FAIL"。
 *
 * 执行模式：
 *   tsx scripts/post-deploy-verify.ts                          # 默认远程（生产）
 *   tsx scripts/post-deploy-verify.ts --host=http://localhost:3001
 *   tsx scripts/post-deploy-verify.ts --api-key=xxx            # 携带 X-Bambook-Api-Key
 *   tsx scripts/post-deploy-verify.ts --strict                 # 任意 FAIL 退出码非 0
 *
 * 检查项（MVP 三项）：
 *   1. REST 探针 — 核心 router 各发一个 GET，期望 2xx
 *   2. Manifest 工具数 + ID 集合 — 远程 vs 本地源码 MANIFEST_SEEDS
 *   3. （可选）远程 byDomain 分布
 *
 * 退出码：
 *   0 — 全部通过（或非 strict 下仅有警告）
 *   1 — strict 模式下任意检查失败
 *   2 — 网络/参数错误
 */

import { getMcpManifest } from '../src/agent/mcp/manifest';

// ─── 参数解析 ───────────────────────────────────────────────────
type Args = {
  host: string;
  apiKey?: string;
  strict: boolean;
  endpointPrefix: string;
};

function parseArgs(argv: string[]): Args {
  const get = (key: string): string | undefined => {
    const hit = argv.find(a => a.startsWith('--' + key + '='));
    return hit ? hit.slice(key.length + 3) : undefined;
  };
  const has = (key: string) => argv.includes('--' + key);
  return {
    host: (get('host') || 'https://jiangsupanda.com').replace(/\/+$/, ''),
    apiKey: get('api-key') || process.env.BAMBOOK_API_KEY,
    strict: has('strict'),
    // 远程线上挂在 /bambook 子路径下；本地通常是裸 /api。可以用参数覆盖
    endpointPrefix: get('prefix') ?? (
      // 默认根据 host 智能推断：jiangsupanda.com → /bambook/api/v1，其它 → /api/v1
      /jiangsupanda\.com/i.test(get('host') || 'https://jiangsupanda.com') ? '/bambook/api/v1' : '/api/v1'
    ),
  };
}

// ─── 检查框架 ───────────────────────────────────────────────────
type CheckResult = {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  durationMs: number;
  detail: string;
  hint?: string;
};

const results: CheckResult[] = [];

async function check(id: string, fn: () => Promise<{ status: 'pass' | 'warn' | 'fail'; detail: string; hint?: string }>): Promise<void> {
  const t0 = Date.now();
  try {
    const r = await fn();
    results.push({ id, durationMs: Date.now() - t0, ...r });
  } catch (e: any) {
    results.push({
      id,
      durationMs: Date.now() - t0,
      status: 'fail',
      detail: 'EXCEPTION: ' + (e?.message || String(e)).slice(0, 200),
      hint: '检查脚本本身抛错，先排除网络/凭证问题再追业务问题',
    });
  }
}

// ─── HTTP 工具 ───────────────────────────────────────────────────
async function httpGet(url: string, args: Args): Promise<{ status: number; body: any; raw: string }> {
  const headers: Record<string, string> = { 'accept': 'application/json' };
  if (args.apiKey) headers['x-bambook-api-key'] = args.apiKey;
  const res = await fetch(url, { headers, redirect: 'manual' });
  const raw = await res.text();
  let body: any = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* leave raw */ }
  return { status: res.status, body, raw };
}

// ─── 检查 1：REST 探针 ─────────────────────────────────────────
async function checkRestProbes(args: Args): Promise<void> {
  // 选择"读取列表"风格的端点；这些路由命中即说明 router 已挂载。
  // 路径与 server/src/index.ts + 各模块 route.ts 的根 GET 对齐。
  const probes = [
    { id: 'rest:development', path: '/development?limit=1' },
    { id: 'rest:finance', path: '/finance?limit=1' },          // finance/route.ts: router.get('/')
    { id: 'rest:shipping', path: '/shipping?limit=1' },
    { id: 'rest:email', path: '/email?limit=1' },
  ];
  // 旧版根 /api（非 /api/v1）的兼容路径 — 401 也算路由 OK
  const legacyProbes = [
    { id: 'rest:legacy.orders', path: '/orders?limit=1', useLegacyPrefix: true },
    { id: 'rest:legacy.relations', path: '/relations?limit=1', useLegacyPrefix: true },
  ];
  for (const p of [...probes, ...legacyProbes]) {
    await check(p.id, async () => {
      // legacy 探针走 /api（不带 v1），因为 orders/relations 在 index.ts 是 /api/orders 直挂
      const prefix = (p as any).useLegacyPrefix
        ? args.endpointPrefix.replace(/\/v1$/, '')
        : args.endpointPrefix;
      const url = args.host + prefix + p.path;
      const r = await httpGet(url, args);
      if (r.status >= 200 && r.status < 300) {
        return { status: 'pass', detail: `${url} → ${r.status}` };
      }
      if (r.status === 401 || r.status === 403) {
        return {
          status: 'warn',
          detail: `${url} → ${r.status}（路由已挂载，未携带凭证 — 视为路由层 OK）`,
          hint: '通过 --api-key=xxx 或 BAMBOOK_API_KEY 环境变量传入',
        };
      }
      if (r.status === 404) {
        return {
          status: 'fail',
          detail: `${url} → 404`,
          hint: '路由未挂载或前缀错：检查 server/src/index.ts 的 app.use 路径',
        };
      }
      return { status: 'fail', detail: `${url} → ${r.status}` };
    });
  }
}

// ─── 检查 2：Manifest 工具数 + ID 集合 ─────────────────────────
async function checkManifest(args: Args): Promise<void> {
  // 本地权威源
  const local = getMcpManifest();
  const localIds = new Set(local.map(t => t.id));
  const localCount = local.length;
  const localByDomain = local.reduce<Record<string, number>>((acc, t) => {
    acc[t.domain] = (acc[t.domain] || 0) + 1;
    return acc;
  }, {});

  await check('manifest:fetch', async () => {
    // 注意：agent router 挂在 /api/agent（不是 /api/v1/agent），见 server/src/index.ts:321
    const agentPrefix = args.endpointPrefix.replace(/\/v1$/, '');
    const url = args.host + agentPrefix + '/agent/mcp/manifest';
    const r = await httpGet(url, args);
    if (r.status === 401 || r.status === 403) {
      return {
        status: 'warn',
        detail: `${url} → ${r.status}（manifest 路由已挂载，但未携带凭证 — 工具集对账被跳过）`,
        hint: '提供 --api-key=xxx 或 BAMBOOK_API_KEY 后才能完成本地 vs 远程对账',
      };
    }
    if (r.status !== 200) {
      return { status: 'fail', detail: `${url} → ${r.status}, body: ${r.raw.slice(0, 120)}` };
    }
    const remoteTools: Array<{ id: string; domain?: string }> = Array.isArray(r.body?.tools) ? r.body.tools : [];
    const remoteIds = new Set(remoteTools.map(t => t.id));
    const remoteCount = remoteTools.length;

    const missingOnRemote = Array.from(localIds).filter(id => !remoteIds.has(id)).sort();
    const extraOnRemote = Array.from(remoteIds).filter(id => !localIds.has(id)).sort();

    // 打印诊断信息（不只是 pass/fail，让人能看清漂移）
    console.log('  ┌─ Manifest diagnostic');
    console.log('  │  local source MANIFEST_SEEDS: ' + localCount);
    console.log('  │  remote /agent/mcp/manifest:  ' + remoteCount);
    console.log('  │  byDomain (local):  ' + JSON.stringify(localByDomain));
    if (r.body?.summary?.byDomain) console.log('  │  byDomain (remote): ' + JSON.stringify(r.body.summary.byDomain));
    if (missingOnRemote.length) console.log('  │  ⚠ missing on remote (' + missingOnRemote.length + '): ' + missingOnRemote.join(', '));
    if (extraOnRemote.length) console.log('  │  ⚠ extra on remote (' + extraOnRemote.length + '): ' + extraOnRemote.join(', '));
    console.log('  └────');

    if (missingOnRemote.length === 0 && extraOnRemote.length === 0) {
      return { status: 'pass', detail: `工具集完全一致 (${remoteCount} 个)` };
    }
    if (missingOnRemote.length > 0 && extraOnRemote.length === 0) {
      return {
        status: 'fail',
        detail: `远程缺 ${missingOnRemote.length} 个工具：${missingOnRemote.slice(0, 3).join(', ')}${missingOnRemote.length > 3 ? '...' : ''}`,
        hint: '远程后端代码落后于本地：rsync server/ → npm install → npm run build → launchctl kickstart',
      };
    }
    if (extraOnRemote.length > 0 && missingOnRemote.length === 0) {
      return {
        status: 'warn',
        detail: `远程多 ${extraOnRemote.length} 个工具：${extraOnRemote.slice(0, 3).join(', ')}${extraOnRemote.length > 3 ? '...' : ''}`,
        hint: '本地源码落后于远程；如果是预期分支差异可忽略，否则 git pull origin main',
      };
    }
    return {
      status: 'fail',
      detail: `工具集双向漂移：远程缺 ${missingOnRemote.length}、远程多 ${extraOnRemote.length}`,
      hint: '本地与远程都有独有工具，确认分支后重新部署',
    };
  });
}

// ─── 主流程 ─────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('========= POST-DEPLOY VERIFY =========');
  console.log('host:           ' + args.host);
  console.log('prefix:         ' + args.endpointPrefix);
  console.log('apiKey:         ' + (args.apiKey ? '(provided)' : '(none, will warn on auth-protected routes)'));
  console.log('strict:         ' + args.strict);
  console.log('');

  console.log('── [1/2] REST 探针');
  await checkRestProbes(args);

  console.log('── [2/2] Manifest 一致性（本地源码 vs 远程响应）');
  await checkManifest(args);

  // ─── 报告 ───
  console.log('\n========= RESULTS =========\n');
  console.log('| Check | Status | Duration | Detail |');
  console.log('|-------|--------|----------|--------|');
  for (const r of results) {
    const icon = r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : '✗';
    console.log(`| ${r.id} | ${icon} ${r.status} | ${r.durationMs}ms | ${r.detail} |`);
  }

  const fails = results.filter(r => r.status === 'fail');
  const warns = results.filter(r => r.status === 'warn');
  const passes = results.filter(r => r.status === 'pass');

  console.log('\nSummary:');
  console.log('  ✓ pass:  ' + passes.length);
  console.log('  ⚠ warn:  ' + warns.length);
  console.log('  ✗ fail:  ' + fails.length);

  if (fails.length || warns.length) {
    console.log('\n动作建议：');
    for (const r of [...fails, ...warns]) {
      if (r.hint) console.log('  · [' + r.status + '] ' + r.id + ' → ' + r.hint);
    }
  }

  if (args.strict && fails.length > 0) {
    console.log('\n[strict] 存在 fail，退出码 1');
    process.exit(1);
  }
  if (fails.length > 0) {
    console.log('\n非 strict 模式：fail 视为可观察缺陷但不阻塞退出');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
