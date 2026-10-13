/**
 * 千单级性能观察（handoff §三 #5）
 *
 * 不等真实业务跑到千单才观察——现在就灌到 1000 单量级，测关键列表端点的延迟，
 * 看有没有随数据量线性劣化（N+1 / 缺索引 / 全表扫描）。
 *
 * 流程：登录 → 测基线 → 灌数据到 TARGET 单 → 复测 → finally 硬删 → 校验零残留。
 * 所有灌注数据带 PERF- 前缀标记，删除按 marker 精确清理，不动既有业务数据。
 *
 * 用法：node scripts/perf-1000-orders.mjs [目标单数，默认 1000]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const API = 'http://127.0.0.1:8081';
const TARGET = Number(process.argv[2] || 1000);
const LINES_PER_ORDER = 3;
const ROUNDS = 5;

const serverRoot = path.resolve(import.meta.dirname, '..', 'server');
const requireFromServer = createRequire(path.join(serverRoot, 'package.json'));
const { PrismaClient } = requireFromServer('@prisma/client');

let databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  const envFile = path.join(serverRoot, '.env');
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*DATABASE_URL\s*=\s*(.+)\s*$/.exec(line);
    if (m) { databaseUrl = m[1].trim().replace(/^["']|["']$/g, ''); break; }
  }
}
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

// ── 登录 ──
const loginRes = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'jason.shen@bambook.local', password: 'Bambook@2026' }),
});
const { token } = await loginRes.json();
if (!token) { console.log('✗ 登录失败'); process.exit(1); }

// limit 字段用于判断「基线样本是否足够」——基线库里只有几十单时，
// 拿 limit=500 的基线去比是不可比的（那时只返回得出来几十条），别据此报劣化。
const ENDPOINTS = [
  { name: 'orders  limit=50', path: '/api/v2/orders?limit=50', limit: 50 },
  { name: 'orders  limit=500', path: '/api/v2/orders?limit=500', limit: 500 },
  { name: 'relations', path: '/api/v2/relations' },
  { name: 'finance', path: '/api/v1/finance' },
  { name: 'finance/vouchers', path: '/api/v1/finance/vouchers' },
];

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function measureOnce(pathname) {
  const t0 = performance.now();
  const res = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  const ms = performance.now() - t0;
  return { ms, status: res.status, bytes: text.length };
}

async function measureAll(label) {
  console.log(`\n── ${label} ──`);
  const out = {};
  for (const ep of ENDPOINTS) {
    const runs = [];
    let status = 0, bytes = 0;
    for (let i = 0; i < ROUNDS; i += 1) {
      const r = await measureOnce(ep.path);
      runs.push(r.ms);
      status = r.status;
      bytes = r.bytes;
    }
    const median = pct(runs, 50);
    const p95 = pct(runs, 95);
    out[ep.name] = median;
    const warn = status !== 200 ? '  ⚠ 非 200' : median > 1000 ? '  ⚠ 慢' : '';
    console.log(
      `  ${ep.name.padEnd(18)} 中位 ${median.toFixed(0).padStart(5)}ms  p95 ${p95.toFixed(0).padStart(5)}ms  max ${Math.max(...runs).toFixed(0).padStart(5)}ms  status=${status} ${(bytes / 1024).toFixed(0)}KB${warn}`,
    );
  }
  return out;
}

// ── 基线 ──
const before = await prisma.order.count();
console.log(`当前订单数: ${before}（目标 ${TARGET}）`);
const baseline = await measureAll(`基线（${before} 单）`);

// ── 灌注 ──
const toCreate = Math.max(0, TARGET - before);
const marker = `PERF-${Date.now()}`;
const createdOrderIds = [];

if (toCreate > 0) {
  console.log(`\n灌入 ${toCreate} 单（每单 ${LINES_PER_ORDER} 行）…`);
  const t0 = performance.now();
  const BATCH = 200;
  for (let done = 0; done < toCreate; done += BATCH) {
    const size = Math.min(BATCH, toCreate - done);
    const rows = Array.from({ length: size }, (_, i) => {
      const n = done + i;
      return {
        id: `ORD__${marker}-${n}`,
        customer: `压测客户-${n % 20}`,
        product: `压测产品-${n % 50}`,
        type: 'Bulk',
        quantity: 100 + (n % 900),
        status: ['Draft', 'Confirmed', 'InProduction', 'Shipped'][n % 4],
        dueDate: '2026-12-31',
        quoteAmount: 1000 + (n % 5000),
        poNumber: `${marker}-${n}`,
        currency: 'USD',
        updatedAt: BigInt(Date.now()),
        deletedAt: null,
      };
    });
    await prisma.order.createMany({ data: rows });
    createdOrderIds.push(...rows.map((r) => r.id));

    const lines = rows.flatMap((r, i) =>
      Array.from({ length: LINES_PER_ORDER }, (_, k) => ({
        id: `ORDL__${marker}-${done + i}-${k}`,
        orderId: r.id,
        lineNumber: k + 1,
        quantity: 100,
        description: `压测行 ${done + i}-${k}`,
      })),
    );
    await prisma.orderLine.createMany({ data: lines });
    process.stdout.write(`  …${done + size}/${toCreate}\r`);
  }
  console.log(`\n灌入完成，用时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

const after = await prisma.order.count();
const loaded = await measureAll(`千单级（${after} 单）`);

// ── 伸缩曲线：区分「载荷线性增长（正常）」与「N+1（超线性）」──
console.log('\n── orders 伸缩曲线（1000 单下，按 limit 取样）──');
const curve = [];
for (const limit of [25, 50, 100, 200, 400]) {
  const runs = [];
  let bytes = 0;
  for (let i = 0; i < ROUNDS; i += 1) {
    const r = await measureOnce(`/api/v2/orders?limit=${limit}`);
    runs.push(r.ms);
    bytes = r.bytes;
  }
  const median = pct(runs, 50);
  curve.push({ limit, median, bytes });
  console.log(`  limit=${String(limit).padStart(4)}  中位 ${median.toFixed(0).padStart(5)}ms  ${(bytes / 1024).toFixed(0).padStart(5)}KB  ${(median / limit).toFixed(3)} ms/条`);
}
const first = curve[0];
const last = curve[curve.length - 1];
const perItemGrowth = (last.median / last.limit) / (first.median / first.limit);
console.log(
  `  单条成本 ${(first.median / first.limit).toFixed(3)} → ${(last.median / last.limit).toFixed(3)} ms/条（×${perItemGrowth.toFixed(2)}）` +
  (perItemGrowth > 2 ? '  ⚠ 超线性，疑似 N+1' : '  ✓ 基本持平，属载荷线性增长'),
);

// ── 导出压测：exportAll 会 limit 置空 + include lines，全量载入内存 ──
console.log('\n── xlsx 导出（全量，含所有行明细）──');
{
  const runs = [];
  let bytes = 0, status = 0;
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    const res = await fetch(`${API}/api/v2/orders?format=xlsx`, { headers: { Authorization: `Bearer ${token}` } });
    const buf = await res.arrayBuffer();
    runs.push(performance.now() - t0);
    bytes = buf.byteLength;
    status = res.status;
  }
  console.log(`  ${after} 单：中位 ${pct(runs, 50).toFixed(0)}ms  max ${Math.max(...runs).toFixed(0)}ms  产物 ${(bytes / 1024).toFixed(0)}KB  status=${status}`);
  console.log('  注：exportAll 时 limit 置空且 include:{lines:true} → 全表 + 全行明细进内存，');
  console.log('      当前量级无压力；量级再涨 10× 需改成分批游标或只 select 导出所需列。');
}

// ── 对比 ──
console.log('\n── 延迟变化（基线 → 千单）──');
for (const ep of ENDPOINTS) {
  const b = baseline[ep.name];
  const l = loaded[ep.name];
  const ratio = b > 0 ? l / b : 0;
  // 基线库里的单数少于该端点的 limit → 基线根本没取满，比值只反映「返回条数变多了」，
  // 不是性能劣化。这种情况不可比，明确标注而不是拉警报（否则每次都狼来了）。
  if (ep.limit && before < ep.limit) {
    console.log(`  ${ep.name.padEnd(18)} ${b.toFixed(0).padStart(5)}ms → ${l.toFixed(0).padStart(5)}ms  ×${ratio.toFixed(2)}  （基线仅 ${before} 单 < limit ${ep.limit}，未取满，不可比——看上方伸缩曲线定性）`);
    continue;
  }
  const flag = ratio > 3 ? '  ⚠ 劣化超 3×，查 N+1 / 索引' : ratio > 1.8 ? '  · 轻度劣化' : '';
  console.log(`  ${ep.name.padEnd(18)} ${b.toFixed(0).padStart(5)}ms → ${l.toFixed(0).padStart(5)}ms  ×${ratio.toFixed(2)}${flag}`);
}

// ── 清理 ──
console.log(`\n清理 ${createdOrderIds.length} 单…`);
try {
  const dl = await prisma.orderLine.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  const doo = await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  console.log(`  删除 orderLine ${dl.count} / order ${doo.count}`);
} catch (e) {
  console.log(`  ⚠ 删除失败: ${e?.message || e}`);
}

const residue = await prisma.order.count({ where: { id: { startsWith: `ORD__${marker}` } } });
const residue2 = await prisma.order.count({ where: { poNumber: { startsWith: 'PERF-' } } });
console.log(`  残留检查: id 前缀 ${residue}，poNumber PERF- ${residue2}`);

const finalCount = await prisma.order.count();
await prisma.$disconnect();
console.log(`\n最终订单数: ${finalCount}`);
