// 真库「行数快照 / 对撞」—— 运行时兜住"任何原因造成的残留" ✗
//
// ── 为什么不用静态扫描 ─────────────────────────────────────
// 第一版想做「静态扫：会写但没 finally 的脚本」✗ —— **不可靠** ✗：
//   · 把 `POST /api/auth/login`（每个脚本都有的登录）误判成写 ✗ ⇒ 40 个假阳性 ✗
//   · 修正后只剩 3 个 —— 但 **`req2-*` 那批（真留下残留的）不在里面** ✗
//     因为它们的写走的是 `api('POST', path)` 这类**封装** ✗ ⇒ 静态抓不到 ✗
// ⇒ ★ **换个判据：不看写法，看结果** ✓
//   跑前数一遍行数 → 跑后再数一遍 → **涨了就报警** ✗（与怎么写无关 ✓）
//
// 用法：
//   node scripts/db-rowcount.mjs --snapshot            # 存快照到 /tmp
//   node scripts/db-rowcount.mjs --compare             # 与最近快照对撞
//   node scripts/db-rowcount.mjs --compare <快照路径>   # 与指定快照对撞
import fs from 'node:fs';
import { openLocalPrisma, REPO_ROOT } from './lib/acceptance-selfcheck.mjs';

/**
 * ★★ G-3b（复核抓到的一条"修了入口没修子步骤"）：这里原先写死
 *   `createRequire('/Users/.../apps/Bambook/server/')` + 主目录的 `.env.local`。
 *   而本脚本是 `run-all-acceptance.mjs` 「跑前快照 / 跑后对撞」的**唯一来源**
 *   ⇒ 入口即使改对了，安全网仍在数**另一个 checkout 的库**：矩阵变成"测 A 库、对撞 B 库"。
 *   现走统一入口：库由**本仓 env** 决定，取不到就 fail-closed 抛错（不猜、不回退）。
 */
const { Prisma, prisma, db } = openLocalPrisma();
console.log(`· db-rowcount 连库：${db.name}@${db.host} ← ${REPO_ROOT}`);

const SNAP = '/tmp/bambook-rowcount.json';

/**
 * ★★ 2026-09-19 修：原为**硬编码 23 个模型**的清单 —— 那是**覆盖漏洞** ✗
 *
 * 实测代价：验收第 5–7 批的演练实际留下 **416 行**，横跨 5 个模型
 * （`creditNote` 14 · `productionStage` 200 · `notification` 200 · `order` 1 · `orderLine` 1），
 * **全部在清单之外** ⇒ 守卫一路报「✓ 没有任何模型增长」，
 * 而演练脚本自己的复核清单又漏记子实体 ⇒ **两边同时漏报**，形成假绿 ✗
 *
 * 判据（本仓 `REFERENCE.md`）：**结构守卫的覆盖面必须 ≥ 代码的写法面**。
 * 硬编码清单**必然随 schema 漂移** ⇒ 改为**从 Prisma DMMF 枚举全部模型**：
 * 加表/改表后覆盖面自动跟上，不会再落后。
 * （DMMF 不可用时退回旧清单兜底，保证脚本不因元数据缺失而崩。）
 */
const FALLBACK_MODELS = [
  'order', 'orderLine', 'relation', 'quotation', 'quotationLine', 'opportunity',
  'developmentCase', 'shipment', 'purchaseOrder', 'invoice', 'paymentVoucher',
  'materialReturn', 'sampleColorBatch', 'bom', 'productionPlan', 'outsourcingOrder',
  'customsDeclaration', 'taxRefund', 'tradeDocument', 'qcAssignment',
  'entityLink', 'entityReference', 'auditLog',
];

const MODELS = (() => {
  try {
    const all = Prisma?.dmmf?.datamodel?.models?.map(
      (m) => m.name.charAt(0).toLowerCase() + m.name.slice(1),
    );
    if (Array.isArray(all) && all.length > 0) return all;
  } catch { /* 退回兜底清单 */ }
  return FALLBACK_MODELS;
})();

async function counts() {
  const out = {};
  for (const m of MODELS) {
    try { out[m] = await prisma[m].count(); } catch { out[m] = null; }
  }
  return out;
}

const argv = process.argv.slice(2);
const isSnapshot = argv.includes('--snapshot');
const isCompare = argv.includes('--compare');

if (isSnapshot) {
  const c = await counts();
  fs.writeFileSync(SNAP, JSON.stringify({ at: new Date().toISOString(), counts: c }, null, 2));
  console.log(`✓ 快照已存 ${SNAP}（${new Date().toLocaleTimeString()}）`);
  const nonZero = Object.entries(c).filter(([, v]) => v > 0);
  console.log(`  ${nonZero.map(([k, v]) => `${k}=${v}`).join(' · ')}`);
} else if (isCompare) {
  const path = argv[argv.indexOf('--compare') + 1] || SNAP;
  if (!fs.existsSync(path)) { console.log(`✗ 找不到快照 ${path} —— 先跑 --snapshot`); process.exit(2); }
  const base = JSON.parse(fs.readFileSync(path, 'utf8'));
  const now = await counts();
  const grew = [];
  const shrank = [];
  for (const m of MODELS) {
    const a = base.counts[m];
    const b = now[m];
    if (a == null || b == null) continue;
    if (b > a) grew.push({ m, a, b, d: b - a });
    if (b < a) shrank.push({ m, a, b, d: a - b });
  }
  console.log(`基线：${path}（${base.at}）`);
  if (grew.length) {
    console.log('\n✗ **有模型行数增长 ⇒ 本次运行在真库留下了数据** ✗');
    grew.forEach((g) => console.log(`   ${g.m}: ${g.a} → ${g.b}  (+${g.d})`));
  } else {
    console.log('\n✓ 没有任何模型增长 ⇒ **零残留** ✓');
  }
  if (shrank.length) {
    console.log('\n⚠️ 有模型行数**减少**（可能是脚本清了自己的数据 ✓，也可能是误删 ✗ —— 需人看）：');
    shrank.forEach((s) => console.log(`   ${s.m}: ${s.a} → ${s.b}  (-${s.d})`));
  }
  process.exit(grew.length ? 1 : 0);
} else {
  console.log('用法：--snapshot | --compare [快照路径]');
}

await prisma.$disconnect();
