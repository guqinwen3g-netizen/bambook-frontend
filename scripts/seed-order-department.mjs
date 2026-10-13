#!/usr/bin/env node
/**
 * 给走查数据补上「订单归属部门」这一维（v3.237 补 27）。
 *
 * 为什么要补：M3 的 xlsx 那臂一直挂着一条**缺口** ——
 *   「筛选态导出 departmentId=… 的分母造不出来：库里 69 张在用单的 `departmentId` 全为 null」
 * ⇒ 这一格没有区分力 ⇒ 按部门筛选（以及它背后那条行级隔离 dataScope）在屏面上是**筛不出任何东西**的。
 *
 * 关键判断（先量后写，别把数据洞当产品洞修）：
 *   · 库里 8 个部门、14 条 `UserRole` 带部门、3 个在用单负责人**全部有部门**
 *   · 产品创建单时本来就会自动填：`server/src/orders/orderServiceV2.ts:472`
 *     `input.departmentId || actor.departmentIds?.[0] || null`
 *   ⇒ **不是产品没有通道，是这批演示数据是绕过创建路径灌进来的**（所以列留空了）。
 *   ⇒ 修法只有一条合规的路：**值取每个负责人自己的部门**（与产品自动填充同一来源），
 *     写入**走 `PUT /api/v2/orders/:id`**（走白名单、走权限），不直写库。
 *
 * 用法（口令只从 env 来，本件一个字都不打印它）：
 *   BAMBOOK_API=http://127.0.0.1:8090 SEED_DEPT_PASSWORD=… node scripts/seed-order-department.mjs --status
 *   … --apply     把「在用且部门为空」的单按负责人部门回填（逐条打印改的是哪张、改成哪个部门）
 *   … --revert    按本次跑留下的清单还原成 null（没有清单就拒绝动）
 *
 * ★ 写之前先量、写完必回读：还原不依赖"这次跑成功"（清单落盘在 logs/，红一次也不会漏）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const API = (process.env.BAMBOOK_API ?? 'http://127.0.0.1:8090').replace(/\/+$/, '');
const EMAIL = process.env.SEED_DEPT_EMAIL ?? 'jason.shen@bambook.local';
const PASSWORD = process.env.SEED_DEPT_PASSWORD ?? '';
const STATE = path.join(REPO, 'logs', 'seed-order-department.json');
const MODE = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--revert') ? 'revert' : 'status';

function dbUrl() {
  const raw = process.env.DATABASE_URL ?? '';
  if (!raw) throw new Error('REJECTED: 本件需要 DATABASE_URL（只读那一趟取"负责人→部门"的真源；不直写库）');
  return raw.split('?')[0];   // psql 不认 ?schema=
}

/** 只读：每个负责人的部门（取该产品自己用来做行级隔离的那张表，不另起一套口径） */
function ownerDeptMap() {
  const sql = `
    select o."ownerId", array_agg(distinct ur."departmentId") filtered
    from "Order" o join "UserRole" ur on ur."userId" = o."ownerId" and ur."departmentId" is not null
    group by o."ownerId";`;
  const out = execFileSync('psql', [dbUrl(), '-tA', '-F|', '-c', sql], { encoding: 'utf8' });
  const map = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [owner, arr] = line.split('|');
    const depts = (arr ?? '').replace(/[{}"]/g, '').split(',').filter(Boolean);
    if (owner && depts.length === 1) map.set(owner, depts[0]);   // 多部门的负责人**跳过**（不许我替他挑）
  }
  return map;
}

async function login() {
  if (!PASSWORD) throw new Error('REJECTED: 没给 SEED_DEPT_PASSWORD ⇒ 本件不跑（也不许把"没跑"读成"没改动"）');
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  const j = await res.json();
  const token = j?.token ?? j?.data?.token ?? j?.accessToken;
  if (!token) throw new Error('登录响应里没有 token');
  return token;
}

async function listOrders(token) {
  const res = await fetch(`${API}/api/v2/orders?limit=500`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`列表 HTTP ${res.status}`);
  const j = await res.json();
  return j?.items ?? [];
}

async function main() {
  const token = await login();
  const orders = await listOrders(token);
  const active = orders.filter(o => !o.deletedAt);
  const nulls = active.filter(o => o.departmentId == null);
  console.log(`[SEED-DEPT:${MODE}] 列表 ${orders.length} 张 · 在用 ${active.length} · 部门为空 ${nulls.length}`);

  if (MODE === 'status') {
    const map = ownerDeptMap();
    const fillable = nulls.filter(o => map.has(o.ownerId));
    console.log(`  负责人→部门可解析（单一部门那条）：${map.size} 个负责人 · 本批能回填 ${fillable.length} 张（其余负责人多部门/无部门 ⇒ 我不动它们）`);
    console.log(`  若跑 --apply：这 ${fillable.length} 张会各带走**自己负责人**的那个部门（不是我分配的）`);
    return;
  }

  if (MODE === 'revert') {
    if (!existsSync(STATE)) { console.log('REJECTED: 没有本次回填留下的清单 ⇒ 不知道改过哪些张，拒绝动'); process.exitCode = 2; return; }
    const ids = JSON.parse(readFileSync(STATE, 'utf8'));
    let back = 0;
    for (const it of ids) {
      const cur = await fetch(`${API}/api/v2/orders/${it.id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!cur.ok) { console.log(`  跳过 ${it.poNumber}：详情 HTTP ${cur.status}`); continue; }
      const body = await cur.json();
      const order = body?.order ?? body?.data ?? body;
      const r = await fetch(`${API}/api/v2/orders/${it.id}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...order, departmentId: null }),
      });
      if (r.ok) back++; else console.log(`  ✗ 还原 ${it.poNumber} 失败 HTTP ${r.status}`);
    }
    writeFileSync(STATE, '[]');
    console.log(`  还原成 null：${back}/${ids.length} 张`);
    return;
  }

  const map = ownerDeptMap();
  const targets = nulls.filter(o => map.has(o.ownerId));
  if (targets.length === 0) { console.log('  没有可回填的张（负责人部门解析不出）⇒ 本件不改任何东西'); return; }
  const touched = [];
  for (const o of targets) {
    const dept = map.get(o.ownerId);
    // 以**详情**为 PUT 的体（列表项的字段形状不是更新契约的输入，拿它整张回写会被当成缺字段）
    const cur = await fetch(`${API}/api/v2/orders/${o.id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!cur.ok) { console.log(`  ✗ ${o.poNumber} 详情 HTTP ${cur.status}`); continue; }
    const jb = await cur.json();
    const order = jb?.order ?? jb?.data ?? jb;
    const r = await fetch(`${API}/api/v2/orders/${o.id}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...order, departmentId: dept }),
    });
    if (!r.ok) { console.log(`  ✗ ${o.poNumber} HTTP ${r.status} ${(await r.text()).slice(0, 90)}`); continue; }
    touched.push({ id: o.id, poNumber: o.poNumber, dept });
    console.log(`  ✓ ${o.poNumber} ← ${dept}（来自该负责人的 UserRole，非我指定）`);
  }
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(touched, null, 2));
  // 回读：以产品侧再取一次为准（写成功 ≠ 读得到）
  const after = await listOrders(token);
  const withDept = after.filter(o => !o.deletedAt && o.departmentId != null);
  console.log(`[SEED-DEPT:apply] 写入 ${touched.length} 张 · 回读：在用单里有部门的是 ${withDept.length} 张（清单落在 ${path.relative(REPO, STATE)}）`);
}

main().catch(e => { console.log(`✗ ${e.message}`); process.exitCode = 1; });
