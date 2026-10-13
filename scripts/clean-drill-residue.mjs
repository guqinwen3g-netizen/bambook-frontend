// 真库「演练/测试残留」清理（2026-09-18 立 · **2026-09-19 升级覆盖面**）
//
// ── 纪律（逐条照做，见 skill/记忆）────────────────────────
//   ① **先备份**：把受影响行 dump 成 JSON（可回溯 ✓）
//   ② **精确 ID 删**（不用通配 ✗）
//   ③ **清联动副作用**：EntityLink / EntityReference / AuditLog / ApprovalRequest
//   ④ **独立复核零残留**（不信回滚自述 ✗）
//   ⑤ **默认 dry-run**：`--apply` 才真删 ✓
//
// ── ★★ 2026-09-19 升级：覆盖面从「8 个模型 × 名称字段」→「**全部模型 × 全部字符串字段**」
//
// 旧版只扫 8 个模型、且只扫**人可读名称字段**（故意不扫 id）。实测代价：
// 验收第 5–7 批的演练累计留下 **416+ 行**，横跨
//   `creditNote` / `productionStage` / `notification` / `agentJob` / `order` / `orderLine`
// —— **旧版与行数守卫（硬编码 23 个模型）双双看不见** ⇒ 假绿。
//
// 判据（本仓 REFERENCE.md）：**结构守卫的覆盖面必须 ≥ 代码的写法面**。
// 手写清单必然随 schema 漂移 ⇒ 改为从 **Prisma DMMF 枚举全部模型与字段**
// （引擎见 `scripts/lib/drill-residue.mjs`），并补上**级联**：
// `entityLink`/`entityReference`/`auditLog`/`approvalRequest` 只存 id、不含标识，
// 必须用「已命中实体的 id 集合」再扫一轮。
//
// ── ⚠️ 宽词改为**显式开关**（升级带来的必要收紧）──────────
// 全模型扫描会把 `验收` / `冒烟` 这类**中文常用词**也扫到
// （`auditLog.detail` / `notification.body` 里可能出现在**正常**内容中）
// ⇒ 默认只扫**明确人造**的标识；宽词要 `--broad` 显式打开，且务必先 dry-run 看清单。
//
// 用法：
//   node scripts/clean-drill-residue.mjs                    # dry-run（默认标识）
//   node scripts/clean-drill-residue.mjs --apply            # 真删
//   node scripts/clean-drill-residue.mjs --broad            # 额外纳入宽词（验收/冒烟）
//   node scripts/clean-drill-residue.mjs DRILLVAR --apply   # 只清指定标识
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { sweepResidue, cleanResidue, fetchAllResidue, RESIDUE_MARKERS } from './lib/drill-residue.mjs';
import { openLocalPrisma } from './lib/acceptance-selfcheck.mjs';

/**
 * ★ 这是**会删数据**的脚本（--apply → deleteMany）。原先它写死主目录的 env ⇒
 *   目标库由"上一个碰巧留在仓库里的绝对路径"决定，而不是由调用者所在的工作树决定。
 *   现走 `openLocalPrisma()`：本仓无 env ⇒ 抛错退出，**不猜**。
 *   ⚠️ 刻意**只吃 RESIDUE_MARKERS**：`SIM-` 是 company-sim 的常驻演示数据集，不是残留 ⇒ 绝不可进删除清单。
 */
const { Prisma, prisma } = openLocalPrisma();

const APPLY = process.argv.includes('--apply');
const BROAD = process.argv.includes('--broad');
const BACKUP = `/tmp/bambook-drill-residue-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;

/** 明确人造的标识（默认扫这些） */
const SAFE_PATTERNS = RESIDUE_MARKERS; // ← 唯一出处 lib/drill-residue.mjs（集合与旧字面量逐字相同，行为不变）
/** ⚠️ 宽词：中文常用词，可能命中**正常**内容（auditLog.detail / notification.body）⇒ 需 --broad */
const BROAD_PATTERNS = ['验收', '冒烟'];

const cliPatterns = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const PATTERNS = cliPatterns.length ? cliPatterns : [...SAFE_PATTERNS, ...(BROAD ? BROAD_PATTERNS : [])];

console.log('══ 真库演练/测试残留清理 ══');
console.log(`  标识：${PATTERNS.join(' / ')}${BROAD ? '（含宽词）' : ''}`);
console.log(`  模式：${APPLY ? '★ APPLY（真删）' : 'dry-run（只列不删）'}`);
console.log(`  覆盖面：Prisma DMMF 全部模型（旧版硬编码 8 个模型 ⇒ 已升级）\n`);

// ── ① 扫描（只读）──
// ★ v3.13（复核 I-2）：这一遍原先**不接 `unreadableOut`** ⇒ 有表数不了时也照样打印"零残留"，
//   而本批的主题恰恰是"别把数不了当干净"。现在：数不了 ⇒ 明说"不可判"并以退出码 2 结束。
//   ⚠️ 这只改**报不报得出"零残留"**与退出码，不改删哪些行（删除仍由 ③ 的 `cleanResidue(markers)` 决定）。
const beforeUnreadable = [];
const hits = await sweepResidue({ prisma, Prisma, markers: PATTERNS, unreadableOut: beforeUnreadable });
// ★ 复核 I-4：盲区必须**无条件**报出来。原先只在 `hits.length === 0` 那支里看它 ⇒
//   只要任意一张表有命中，其余数不了的表就被丢掉，然后照常往下删 —— 那是"部分看不见"，不是"看得见"。
const reportBlind = (stage) => {
  if (!beforeUnreadable.length) return;
  console.log(`✗ 【${stage}】有 ${beforeUnreadable.length} 张表**数不了**（这些表既没被证明干净、也没被清过）：`);
  for (const u of beforeUnreadable) console.log(`   · ${u.model}：${u.why}`);
};
reportBlind('扫描');
if (hits.length === 0) {
  console.log(beforeUnreadable.length
    ? '✗ 命中为零但**不可判**（上面那些表没被数到）⇒ 不许说"零残留"，也不据此认为无需清理'
    : '✅ 全模型扫描：零残留');
  await prisma.$disconnect();
  process.exit(beforeUnreadable.length ? 2 : 0);
}
let totalRows = 0;
for (const h of hits) {
  totalRows += h.count;
  console.log(`── ${h.model}：${h.count}${h.count >= 1000 ? '+' : ''} 条`);
  for (const s of h.sample) {
    console.log('     ' + JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 170));
  }
}
console.log(`\n合计：**${totalRows} 条**（命中模型 ${hits.length} 个）`);

if (!APPLY) {
  console.log('\n（dry-run 结束 · 加 --apply 才真删 ✓；宽词需 --broad ✓）');
  await prisma.$disconnect();
  process.exit(0);
}

// ── ② 备份（删之前 · **全量**，不是抽样 —— 抽样无法回溯 ✗）──
const backupUnreadable = [];
const backup = await fetchAllResidue({ prisma, Prisma, markers: PATTERNS, unreadableOut: backupUnreadable });
fs.writeFileSync(BACKUP, JSON.stringify(backup, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
const backedUp = Object.values(backup).reduce((s, rows) => s + rows.length, 0);
console.log(`\n✓ 已备份 ${backedUp} 行到 ${BACKUP}（${fs.statSync(BACKUP).size} 字节）`
  + (backupUnreadable.length ? ` ✗ **但不完整**：${backupUnreadable.length} 张表取不到行 ⇒ 回溯不了那几张` : '（全模型）'));
for (const u of backupUnreadable) console.log(`   · ${u.model}：${u.why}`);

// ── ③ 删（多轮 + 级联，见 lib 注释）──
console.log('\n清本体 + 联动副作用（多轮 · 自动处理 FK 顺序与级联）…');
const r = await cleanResidue({ prisma, Prisma, markers: PATTERNS, log: console.log });
console.log(`\n共删除 ${r.deleted} 行：`);
for (const [m, c] of Object.entries(r.byModel).sort((a, b) => b[1] - a[1])) console.log(`  ${m}: ${c}`);

// ── ④ 独立复核（重新扫一遍，不信上面的自述）──
console.log('\n★ 独立复核（重新全模型扫一遍）…');
const afterUnreadable = [];
const after = await sweepResidue({ prisma, Prisma, markers: PATTERNS, unreadableOut: afterUnreadable });
if (afterUnreadable.length) {
  console.log(`✗ 复核这一遍也**不可判**：${afterUnreadable.length} 张表数不了 ⇒ "删干净了"这句话不许说（退出码 3，与"还有残留"分开）`);
  for (const u of afterUnreadable) console.log(`   · ${u.model}：${u.why}`);
  await prisma.$disconnect();
  process.exit(3);
}
if (after.length === 0) console.log('✓ 零残留');
else {
  console.log(`⚠️ 仍有命中（可能是新产生的 / 或删不掉的）：`);
  for (const h of after) console.log(`  ${h.model}: ${h.count}`);
}
console.log(`\n备份文件：${BACKUP}`);
await prisma.$disconnect();
