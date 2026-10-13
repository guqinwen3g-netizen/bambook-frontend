#!/usr/bin/env node
/**
 * ① 看得到 · 「面料工序级委外链（REQ2-05 / DR-047）」这一站的可点开数据播种件。
 *
 * 为什么需要它：现读 `OrderProcessNode` 表 **0 行**，而走查脚本里"工序链"出现 **0 次**
 *   ⇒ 这一站在走查环境里根本点不开（不是"点了有问题"，是"没有东西可点"）。
 *
 * ★ 全部经**产品自己的 HTTP 接口**（POST create / start / complete / DELETE），不走 SQL 直写：
 *   这条链上的 `amount`、`status`、`lossPct` 都由服务端算，直写库会造出产品自己造不出的形状。
 *   顺带这也把"这一站真的能用"当场证了一次。
 *
 * 可回滚（★ 这一条被我改过两次，原因写在下面）：每行 notes 都以 `MARKER` 开头 ⇒ 删除谓词**不宽于本件写入面**。
 *   · 产品规则现读：`processChainService.deleteNode` 对**已开工/已完工**节点回 `409 NOT_PLANNED`（"核算留痕"）
 *     ⇒ 所以本件**默认只造 planned 节点**：那三种状态里，只有"计划"是产品允许撤销的那一档。
 *     想看"在制/完工"两态请直接在屏上点「开工」「完工登记」——那正是这一站要演示的动作；
 *     点完之后产品就不让删了（这是它对的地方），要清场用 `--revert-db`（只按本件标记逐 id 删，且库名必须在白名单内）。
 *
 * 用法（默认后端 :8090）：
 *   node scripts/seed-process-chain-walkthrough.mjs --status | --apply | --revert | --revert-db
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/** 与 scripts/seed-walkthrough-gaps.mjs 同形：只跑一条语句、失败即抛（不接受多语句注入） */
const psql = (text, env) => execFileSync('psql', ['-tAc', text], { encoding: 'utf8', env }).trim();
/** SQL 字面量转义（单引号翻倍）：id/标记都走这一道，不拼裸串 */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const BASE = process.env.PC_WALK_API ?? 'http://127.0.0.1:8090';
const EMAIL = process.env.PC_WALK_EMAIL ?? 'jason.shen@bambook.local';
const PO = process.env.PC_WALK_PO ?? 'FO-260612';
const MARKER = 'WALK-PC-2026-09-28';

/** 业务形状：坯布 → 染色 → 后整理（单位 M＝米，投入>产出＝有损耗，符合染厂实际） */
const NODES = [
  { seq: 1, processType: 'gray_fabric', inputQty: 2000, unit: 'M', unitPrice: 3.20, supplierId: 'SIM-SUP-03', note: '坯布投产' },
  { seq: 2, processType: 'dyeing', inputQty: 1980, unit: 'M', unitPrice: 6.80, supplierId: 'SIM-SUP-03', note: '染色（一缸）' },
  { seq: 3, processType: 'finishing', inputQty: 1950, unit: 'M', unitPrice: 2.40, supplierId: 'SIM-SUP-03', note: '定型后整理' },
];
/** 让三种状态各有一格：seq1 完工（投入 2000 → 产出 1980 ⇒ 服务端算损耗 1%）、seq2 在制中、seq3 仍是计划 */
const OUTS = {};        // 默认不完工：完工节点产品拒删（409 核算留痕）
const START_ONLY = [];  // 同上：开工即不可逆，留给使用方在屏上点

/**
 * 口令：优先取环境变量 `PC_WALK_PASSWORD`（现场工具包里没有 `server/scripts/seed-rbac.ts`，
 * 那条从仓里取法只在本仓可用）；两条都拿不到就拒跑，绝不回落成写死的默认值。
 */
function password() {
  const fromEnv = (process.env.PC_WALK_PASSWORD ?? '').trim();
  if (fromEnv) return fromEnv;
  const file = new URL('../server/scripts/seed-rbac.ts', import.meta.url);
  if (!fs.existsSync(file)) throw new Error('ENV_MISSING: 现场没有 seed-rbac.ts ⇒ 请给 PC_WALK_PASSWORD（不打印口令）');
  const m = fs.readFileSync(file, 'utf8').match(/DEMO_ACCOUNT_PASSWORD\s*=\s*'([^']+)'/);
  if (!m) throw new Error('ENV_MISSING: 口令取不到（不打印内容）');
  return m[1];
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应：由 status 判 */ }
  return { status: res.status, json };
}

async function main() {
  const mode = process.argv[2] ?? '--status';
  if (!['--status', '--apply', '--revert', '--revert-db'].includes(mode)) {
    console.error('用法：--status | --apply | --revert | --revert-db');
    process.exit(1);
  }
  const login = await api(null, 'POST', '/auth/login', { email: EMAIL, password: password() });
  const token = login.json?.token;
  if (!token) throw new Error(`登录失败 http=${login.status}（不打印响应体）`);

  const orders = await api(token, 'GET', `/v1/orders?limit=500&search=${encodeURIComponent(PO)}`);
  const list = orders.json?.items ?? orders.json?.orders ?? [];
  const order = list.find((o) => (o.poNumber ?? '').includes(PO));
  if (!order) throw new Error(`找不到订单 ${PO}（http=${orders.status}）`);

  const shown = async (label) => {
    const r = await api(token, 'GET', `/v1/mes/order-processes?orderId=${encodeURIComponent(order.id)}`);
    const nodes = r.json?.nodes ?? [];
    const s = r.json?.summary ?? {};
    console.log(`${label} 订单=${order.poNumber}(${order.id}) 节点=${nodes.length} ` +
      `计划/在制/完工=${nodes.filter(n => n.status === 'planned').length}/${nodes.filter(n => n.status === 'in_progress').length}/${nodes.filter(n => n.status === 'done').length} ` +
      `委外成本合计=${s.totalAmount ?? s.sumAmount ?? '—'}（服务端算的，不是我加的）`);
    for (const n of nodes) console.log(`   · seq${n.seq} ${n.processType} ${n.status} 投入${n.inputQty}${n.unit ?? ''} 产出${n.outputQty ?? '—'} 单价${n.unitPrice} 金额${n.amount} notes=${(n.notes ?? '').slice(0, 26)}`);
    return nodes;
  };

  if (mode === '--status') { await shown('状态：'); return; }

  if (mode === '--revert') {
    const nodes = await shown('清场前：');
    const mine = nodes.filter((n) => String(n.notes ?? '').startsWith(MARKER));
    const refused = [];
    for (const n of mine) {
      const r = await api(token, 'DELETE', `/v1/mes/order-processes/${encodeURIComponent(n.id)}`);
      if (r.status !== 200 && r.status !== 204) refused.push({ seq: n.seq, http: r.status, code: r.json?.error ?? null });
    }
    const left = await shown('清场后：');
    const leftMine = left.filter((n) => String(n.notes ?? '').startsWith(MARKER)).length;
    console.log(`JSON ${JSON.stringify({ 走产品接口删除: mine.length - refused.length, 被产品拒删: refused, 本件标记残留: leftMine })}`);
    if (leftMine !== 0) {
      console.error(`⚠️ 仍有 ${leftMine} 行标记载体删不掉——产品对已开工/完工节点拒删（409 NOT_PLANNED，这是它对的地方）。` +
        `\n   要清这些**本件自己造的**行：node scripts/seed-process-chain-walkthrough.mjs --revert-db`);
      process.exitCode = 1;
    }
    return;
  }

  if (mode === '--revert-db') {
    // 只按"本件标记 + 本件那张订单"逐 id 删；库名不在白名单就整批拒（与 seed-walkthrough-gaps 同一道闸）
    const { parseDatabaseUrl } = await import('./lib/drill-db.mjs');
    const raw = (process.env.DATABASE_URL ?? '').replace(/^["']|["']$/g, '');
    if (!raw) throw new Error('ENV_MISSING: --revert-db 需要 DATABASE_URL（不借别的 worktree 的默认值）');
    const src2 = parseDatabaseUrl(raw);
    if (!['panda_hub_local', 'pandahub'].includes(src2.db)) throw new Error(`REJECTED: 库名 ${src2.db} 不在白名单，拒删`);
    const env2 = { ...process.env, PGHOST: src2.host, PGPORT: src2.port, PGUSER: src2.user, PGPASSWORD: src2.password, PGDATABASE: src2.db };
    const ids = psql("select id from \"OrderProcessNode\" where \"orderId\" = " + q(order.id) + ' and notes like ' + q(MARKER + '%') + ';', env2)
      .split('\n').map((s) => s.trim()).filter(Boolean);
    for (const id of ids) {
      psql("delete from \"AuditLog\" where \"targetId\" = " + q(id) + ';', env2);
      psql("delete from \"OrderProcessNode\" where id = " + q(id) + ';', env2);
    }
    console.log('JSON ' + JSON.stringify({ 库: src2.db, 按标记逐id删: ids.length, 谓词: 'notes 以 ' + MARKER + ' 开头 且 orderId=' + order.id }));
    await shown('清场后：');
    return;
  }

  // --apply：已存在标记行就先拒（幂等要靠 --revert，不静默叠加）
  const existing = await shown('播种前：');
  if (existing.some((n) => String(n.notes ?? '').startsWith(MARKER))) {
    throw new Error('本件已播过（有标记行）⇒ 先 --revert 再 --apply');
  }
  const made = [];
  for (const n of NODES) {
    const r = await api(token, 'POST', '/v1/mes/order-processes', {
      orderId: order.id, seq: n.seq, processType: n.processType, supplierId: n.supplierId,
      inputQty: n.inputQty, unit: n.unit, unitPrice: n.unitPrice,
      notes: `${MARKER} ${n.note}（走查播种件 scripts/seed-process-chain-walkthrough.mjs，跑完 --revert 自清）`,
    });
    if (r.status !== 201 && r.status !== 200) throw new Error(`创建 seq${n.seq} 失败 http=${r.status} ${JSON.stringify(r.json?.error ?? r.json?.message ?? null)}`);
    const node = r.json.node;
    made.push(node);
    if (OUTS[n.seq] !== undefined || START_ONLY.includes(n.seq)) {
      const st = await api(token, 'POST', `/v1/mes/order-processes/${encodeURIComponent(node.id)}/start`, {});
      if (st.status !== 200 && st.status !== 201) throw new Error(`开工 seq${n.seq} 失败 http=${st.status}`);
      if (OUTS[n.seq] === undefined) continue;
      const cp = await api(token, 'POST', `/v1/mes/order-processes/${encodeURIComponent(node.id)}/complete`, { outputQty: OUTS[n.seq] });
      if (cp.status !== 200 && cp.status !== 201) throw new Error(`完工 seq${n.seq} 失败 http=${cp.status}`);
    }
  }
  await shown('播种后：');
  console.log(`JSON ${JSON.stringify({ 建了: made.length, 标记: MARKER, 撤销: 'node scripts/seed-process-chain-walkthrough.mjs --revert' })}`);
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
