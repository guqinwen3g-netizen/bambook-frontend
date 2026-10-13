#!/usr/bin/env node
/**
 * acceptance-data-scope.mjs —— 报告"这次读数算的是哪一批数据"（B35 对策，G-3 批）
 *
 * B35 原话（权威基准 §9）：演练数据与存量**分不开** ⇒ 任何"统计/对账"读数无法证明只算了演练集
 * ⇒ M3（模拟整链验收）开跑前必须先隔离。
 *
 * ★★ 2026-09-21 复核后的三处自我更正（都写在这里）：
 *  1. **不再自带标识清单**。原先这里写死 `['SIM-','DRILL']`，而仓内已有 `clean-drill-residue` 6 个、
 *     `audit-drill-residue` 10 个 ⇒ 我在制造**第三套并行真源**（本仓头号病）。
 *     现全部从 `lib/drill-residue.mjs` 导入，并按语义分族报告：
 *       · `RESIDUE`（残留，清扫器认这些）  · `SIM`（company-sim 常驻数据集，**不是残留、绝不可删**）
 *  2. **不再用 `sweepResidue` 的计数做分母**。它 `count = stringCount + jsonRows.length` **不去重**
 *     （同一行 String+Json 双命中会被数两次），且 Json 侧只取 5000 行近期切片
 *     ⇒ 用它算出来的"演练集占比"分子分母不是同一口径，可为负、可被系统性低估。
 *     现改为**本模块自己按 String 字段精确 `count()`**，与清扫器的字符串侧同语义（同样大小写敏感），
 *     并**明写 Json 未计入 ⇒ 演练数是下界**。
 *  3. **两族分开报**，不合成一个 `drill` 数（合成后"清扫器认的那批"与"报告说的那批"又不是一回事）。
 *
 * 只读：全程 count，不写一行；库名/host 不像演练库 ⇒ **拒绝连**（fail-closed）。
 * 用法：node scripts/acceptance-data-scope.mjs [--json]
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO_ROOT, readDbTarget, loadEnvForScript, isCliEntry, retainedRowsCell } from './lib/acceptance-selfcheck.mjs';
import {
  allModels, markerOr,
  RESIDUE_MARKERS, SIM_DATASET_MARKERS,
} from './lib/drill-residue.mjs';

/** 取本仓 env（**不回退去借别的 worktree** —— 那正是 B35/B48 的放大器） */
function connect() {
  const db = readDbTarget(REPO_ROOT);
  if (!db.envFile) {
    return { error: `本仓找不到 env 文件（找过 server/.env.local、server/.env）⇒ 不知道要连哪个库。`
      + `★ 刻意**不**回退读别的 worktree 的 env —— 那会让"我以为在测这个分支"变成"其实连的是别人的库"。` };
  }
  if (!db.name) return { error: `${path.relative(REPO_ROOT, db.envFile)} 里解析不出 DATABASE_URL` };
  if (!['127.0.0.1', 'localhost', '::1'].includes(db.host ?? '')) return { error: `host=${db.host} 非本机 ⇒ 拒绝连（验收禁止碰远端库）` };
  if (!/(local|dev|test)/i.test(db.name)) return { error: `库名 ${db.name} 不像演练库 ⇒ 拒绝连` };

  const req = createRequire(path.join(REPO_ROOT, 'server', 'noop.js'));
  req('dotenv').config({ path: db.envFile, override: true });
// ★ G-3c 第 11 批复核处置（BLOCK-2）：构造 client 之前先把**本仓**那份 env 装上；取不到就抛 ENV_MISSING，
//   宁可拒跑也不让 Prisma 去借别的 worktree 的 env（此前 19/21 是这么被借走的）。
loadEnvForScript();
  const { PrismaClient } = req('@prisma/client');
  return { db, prisma: new PrismaClient(), Prisma: req('@prisma/client').Prisma };
}

/** 一族的精确计数（只数 String 字段；与清扫器同语义：`contains` 大小写敏感 —— 本仓 datasource 是 postgresql） */
async function countFamily(prisma, modelDef, markers) {
  const delegate = prisma[modelDef.name.charAt(0).toLowerCase() + modelDef.name.slice(1)];
  if (!delegate?.count) return 0;
  // ★ v3.02（复核 IMP-3）：这里原本自己抄了一遍 `for f … for m … {contains}` ⇒ 基座那份 `markerOr` 之外
  //   的第 5 份"标记落在哪些列"。收成调用 ⇒ 列知识只有一处，守卫也不再只能盯着基座一个文件。
  const OR = markerOr(modelDef, markers);
  if (OR.length === 0 || markers.length === 0) return 0;
  try { return await delegate.count({ where: { OR } }); } catch { return 0; }
}

export async function dataScope() {
  const c = connect();
  if (c.error) return { error: c.error };
  const { prisma, Prisma, db } = c;
  try {
    const rows = [];
    for (const m of allModels(Prisma)) {
      const delegate = prisma[m.name.charAt(0).toLowerCase() + m.name.slice(1)];
      if (!delegate?.count) continue;
      let total = 0;
      try { total = await delegate.count(); } catch { continue; }
      const residue = await countFamily(prisma, m, RESIDUE_MARKERS);
      const sim = await countFamily(prisma, m, SIM_DATASET_MARKERS);
      if (total === 0) continue;
      rows.push({ model: m.name, total, residue, sim, attributable: residue + sim });
    }
    const total = rows.reduce((s, r) => s + r.total, 0);
    const residue = rows.reduce((s, r) => s + r.residue, 0);
    const sim = rows.reduce((s, r) => s + r.sim, 0);
    const attributable = residue + sim;
    return {
      db: { name: db.name, host: db.host, envFile: path.relative(REPO_ROOT, db.envFile) },
      markers: { residue: RESIDUE_MARKERS, sim: SIM_DATASET_MARKERS },
      // ★ Json 字段内的标识未计入（清扫器那侧只扫近期 5000 行切片，也不是同一分母）⇒ 本数是**下界**
      scopeNote: '只统计 String 字段（与清扫器字符串侧同语义，大小写敏感）；Json 字段内的标识未计入 ⇒ 演练数是下界',
      total, residue, sim, attributable,
      share: total ? attributable / total : 0,
      rows: rows.sort((a, b) => b.total - a.total),
    };
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 结论（三态）。★ 判的是"能不能把读数归属到人造数据集上"，不是"数据好不好"。
 * 注意 `attributable` 是**下界** ⇒ 任何"占比高"的结论都只会偏保守，不会偏乐观。
 */
export function verdict(sc) {
  if (sc.error) return [`✗ 无法出数：${sc.error}`];
  if (sc.total === 0) return ['⚠️ 库里一张表都没有数据 ⇒ 整链验收**没有数据可测**（既不是通过也不是失败）'];
  if (sc.attributable === 0) return [
    `✗ **B35 未清**：全库 ${sc.total} 行里可归属到人造数据集的行 = **0**`,
    `   ⇒ 任何统计/对账读数都是"人造 + 存量"混算，不得署名"只算了演练集"，M3 的数没有资格被信任。`,
  ];
  if (sc.share < 0.5) return [
    `⚠️ 可归属 ${sc.attributable}/${sc.total}（${(sc.share * 100).toFixed(1)}%，下界）⇒ 读数以**不可归属的存量/迁移数据**为主，`,
    `   验收脚本若不带范围谓词，结果主要由这批数据决定 ⇒ 必须逐脚本补范围。`,
  ];
  return [
    `✓ 可归属占比 ${(sc.share * 100).toFixed(1)}%（下界；残留 ${sc.residue} + SIM ${sc.sim}）⇒ 读数多数落在人造集内`,
    `   （仍须在报告里写明范围与"Json 未计入"这条口径限定）。`,
  ];
}

function formatReport(sc) {
  const L = ['── 验收数据范围（B35 自证）────────────────────────'];
  if (sc.error) { L.push(`  ${sc.error}`); L.push('────────────────────────────────────────────────'); return L.join('\n'); }
  L.push(`  库      ${sc.db.name} @ ${sc.db.host}  ← ${sc.db.envFile}`);
  L.push(`  标识    残留族 ${sc.markers.residue.join('/')} ｜ 演示数据集族 ${sc.markers.sim.join('/')}（均取自 lib/drill-residue 唯一出处）`);
  L.push(`  ${sc.scopeNote}`);
  L.push(`  合计    ${sc.total} 行 ｜ 残留 ${sc.residue} ｜ SIM 数据集 ${sc.sim} ｜ 可归属 ${sc.attributable}（占比 ${(sc.share * 100).toFixed(1)}%，下界）`);
  // ★ v3.87：Kevin 拍定的「承认来源合法的保留行」——**单列一格**，且只认**有独立机制证据**的族。
  //   这里把 SIM 常驻数据集作为唯一的 arm：它的证据是"由生成器写出来的、族名取自 lib 的唯一出处"，
  //   不是"我觉得它干净"。该格**不参与**任何判定/退出码（本脚本的退出码只看 sc.error / attributable）。
  L.push('  ' + retainedRowsCell({ arms: [
    { label: 'company-sim 常驻数据集（SIM-）', count: sc.sim, evidence: '生成器 server/scripts/company-sim/*；族名取自 lib/drill-residue 的 SIM_DATASET_MARKERS（唯一出处）' },
  ] }).text);
  for (const r of sc.rows.slice(0, 14)) {
    L.push(`    ${r.model.padEnd(24)} total=${String(r.total).padStart(7)}  residue=${String(r.residue).padStart(5)}  SIM=${String(r.sim).padStart(5)}  不可归属=${String(r.total - r.attributable).padStart(7)}`);
  }
  if (sc.rows.length > 14) L.push(`    …另 ${sc.rows.length - 14} 张表（--json 看全量）`);
  L.push(...verdict(sc).map((x) => `  ${x}`));
  L.push('────────────────────────────────────────────────');
  return L.join('\n');
}

if (isCliEntry(import.meta.url)) {
  const sc = await dataScope();
  if (process.argv.includes('--json')) console.log(JSON.stringify(sc, null, 2));
  else console.log(formatReport(sc));
  // fail-closed：出不了数、或一行都归属不到人造集 ⇒ 非零（不许"没测到"被当成"没问题"）
  if (sc.error) process.exitCode = 2;
  else if (sc.attributable === 0) process.exitCode = 2;
}
