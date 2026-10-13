// 签字表第 5 条 · 「越权被判拦」的**运行时探针**（只读型：用不存在的 id 发越权请求，谁也删不掉东西）
//
// 判据（§11 第 5 条）：**六角色 × 关键写操作，须从 RBAC 派生**（派生侧见 `scripts/derive-rbac-matrix.ts`）。
// 本件补的是**实测侧**：真的发一次越权请求，看守卫拦不拦。
//
// ★ 为什么这样发是安全的：目标 id **故意不存在** ⇒
//     · 守卫生效  → 403（连 handler 都没进）
//     · 守卫失效  → handler 拿到一个不存在的 id ⇒ 404/400（**依然没有任何行被改/被删**）
//   ⇒ 两种结果都不写库，**不需要回滚**；这正是"探针也敢在生产跑"的形状（本脚本仍只在测试环境跑）。
//
// ★ 正面对照（本仓规矩：没有对照的"通过"不算通过）：
//    同一个请求，用**老板（超管）**的身份发 ⇒ 必须**不是 403**（该进 handler）。
//    若老板也被 403 ⇒ 说明这 403 是因为"整个端点坏了/没挂"，而不是"门禁拦住了" ⇒ 本探针的结论作废。
//
// 用法：npx tsx scripts/acceptance-rbac-deny-probe.ts
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';

loadEnvForScript();

const BASE = process.env.BAMBOOK_API ?? 'http://127.0.0.1:8090';
const PW = 'Bambook@2026';
const GHOST = 'NO_SUCH_ORDER__RBAC_PROBE';   // ← 故意不存在

// 六业务角色 + 老板（超管，不在六角色内，只作对照）
const ROLES = [
  { label: '业务员', role: 'role-sales', email: 'chloe.su@bambook.local' },
  { label: '销售主管', role: 'role-sales-manager', email: 'vivian.chen@bambook.local' },
  { label: '财务', role: 'role-finance', email: 'charlie.qian@bambook.local' },
  { label: '领导', role: 'role-admin', email: 'raymond.lin@bambook.local' },
  { label: 'QC', role: 'role-qc', email: 'wilson.wu@bambook.local' },
  { label: '后勤', role: 'role-logistics', email: 'hank.zheng@bambook.local' },
];
const CONTROL = { label: '老板(超管·对照)', role: 'role-super-admin', email: 'jason.shen@bambook.local' };

const results: { ok: boolean; n: string; d?: string }[] = [];
const say = (s: string) => console.log(s);
const pass = (n: string, d = '') => { results.push({ ok: true, n, d }); say(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n: string, d = '') => { results.push({ ok: false, n, d }); say(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

async function login(email: string): Promise<string | null> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  const d: any = await r.json().catch(() => ({}));
  return r.ok && d?.ok ? (d.token ?? d.data?.token ?? null) : null;
}

/** 发一次越权请求，返回 {status, body前 120 字} */
async function probe(token: string, method: string, path: string) {
  const r = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${token}` } });
  const t = await r.text();
  return { status: r.status, body: t.slice(0, 120).replace(/\s+/g, ' ') };
}

// 派生表里「六角色**全体拒绝**」的 4 格，各挑一条**按 id 删**的出口（安全形状：id 故意不存在）
const CELLS = [
  { scope: 'orders:delete', method: 'DELETE', path: `/api/v2/orders/${GHOST}` },
  { scope: 'relations:delete', method: 'DELETE', path: `/api/v2/relations/${GHOST}` },
  { scope: 'suppliers:write', method: 'DELETE', path: `/api/v2/suppliers/${GHOST}` },
  { scope: 'marketing:write', method: 'DELETE', path: `/api/v2/marketing/campaigns/${GHOST}` },
];

async function main() {
  say('════════════════════════════════════════════════════════');
  say(' 第 5 条 · 越权被判拦 · 运行时探针');
  say(` 端点 ${BASE}`);
  say('════════════════════════════════════════════════════════');

  const tokens = new Map<string, string | null>();
  for (const r of [...ROLES, CONTROL]) tokens.set(r.email, await login(r.email));

  for (const OP of CELLS) {
    say(`\n【格】scope=${OP.scope} · ${OP.method} ${OP.path}`);
    for (const r of ROLES) {
      const token = tokens.get(r.email);
      if (!token) { fail(`${r.label} 登录`, r.email); continue; }
      const { status, body } = await probe(token, OP.method, OP.path);
      if (status === 403) pass(`${r.label} 被拦(403)`, body.slice(0, 62));
      else fail(`${r.label} **没被拦**`, `status=${status} body=${body}`);
    }
    // ★ 正面对照：老板必须不是 403，且响应体必须是 JSON（无此路由会返回 HTML `Cannot GET`）
    const ct = tokens.get(CONTROL.email);
    if (!ct) { fail('对照账号登录', CONTROL.email); continue; }
    const { status, body } = await probe(ct, OP.method, OP.path);
    const isJson = body.trimStart().startsWith('{');
    if (status !== 403 && isJson) pass('对照：老板没被 403 且响应是 JSON（＝handler 到了）', `status=${status} body=${body.slice(0, 56)}`);
    else fail('对照不成立', `status=${status} isJson=${isJson} ⇒ 这一格的 403 归因不成立，上面 6 个"被拦"不算证据`);
  }

  const failed = results.filter((x) => !x.ok);
  say('\n════════════════════════════════════════════════════════');
  say(` 通过 ${results.length - failed.length} · 失败 ${failed.length}`);
  say(' ⚠️ 本探针覆盖「4 个全体拒绝格 × 6 个业务身份」；"部分拒绝"格（如 orders:write 业务员可写、财务被拒）**未探**。');
  say('    派生侧见 docs/签字表第5条-派生表-2026-09-25.md');
  say('════════════════════════════════════════════════════════');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { say(`✗ 异常：${e?.message || e}`); process.exit(1); });
