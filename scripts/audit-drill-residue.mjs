// 真库「演练/测试残留」普查（只读 · 不删）· ★ v3.13 收编版
//
// 背景不变：验收脚本崩在中途 ⇒ 建的单留在库里。本脚本**只报告**，清理必须另行确认（有些是有意演示数据）。
//
// ★★ 为什么要收编（B120 未闭环的那一半，本批量出来的账）
//   这一份原先自带一张手写的 `TARGETS`（12 个模型 / 19 个列）与一张手写 `PAIRS`，而基座里早就有
//   同一问题的唯一读数口 `sweepResidue()`（全模型 · String + Json 双通道 · 族检测 · 不可数显式带出）。
//   现量（2026-09-23，只读 DMMF）：库里 **225 个模型 / 2282 个 String 列**，
//   而手写清单只看 19 个列名，其中真落在 DMMF String 列上的是 **17 列 = 0.74%**（另 2 个列名跟着那两条死条目一起废）；
//   那两条（`customerRelation`/`supplierRelation`）**在 DMMF 里根本没有对应模型** ⇒ 每次跑都是
//   "查不到就 `catch {}` 掉"，账面看起来是"这两类查过且干净"。
//   ⇒ 与 B109/B-1 同一条病：**"数不了"被翻译成"干净"**。所以本批不只换清单，还换掉那个吞错的 catch。
//   ⚠️ 措辞纪律：这里的 225/2282 是**本树跑出来的生成物**，而 `server/node_modules` 与主 checkout 共享（B122）
//      ⇒ 严格说是"主 checkout 那份生成物的 DMMF"。复核实测三处 schema 哈希互不相等（本树 / 生成物 / 主目录），
//      所以"本树 schema 有几个模型"这句话今天**不能断言**，只能断言"这个客户端认识 225 个模型"。
//
// ★ 三条硬约束（改这份脚本时不许破）
//   ① 只读：不出现任何写动词（守卫钉：`drill-cleanup-scope` / 本文件的形状断言）；
//   ② 不许把"零命中"说成"干净" ⇒ 只要有任何一张表数不了，`exitCode` 非零且打印出来；
//   ③ 路径由 `import.meta.url` 派生（B85 那一课：写手与守卫必须同树，否则拿主目录的源码普查结果覆盖本树基线）。
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  sweepResidue, RESIDUE_MARKERS, BROAD_MARKERS, SIM_DATASET_MARKERS, allModels, stringFields, jsonFields, JSON_SCAN_LIMIT, delegateKey,
} from './lib/drill-residue.mjs';
import { isCliEntry } from './lib/acceptance-selfcheck.mjs';
// ★ 复核 I-1（第二轮）：带点的 targetType 到底指哪张表，**产品侧已经有一份真源**（实体注册表的 type → sourceModel）。
//   我上一版自己定了条「取点号前第一段」的规则，被守卫当场证伪：注册表里 `product.asset→ProductAsset`、
//   `order.line→OrderLine`、`knowledge.document→KnowledgeDocument` 全都对不上那条规则，只有 `relation.*` 碰巧对。
//   ⇒ 解析必须**问注册表**，规则不留在工具里。（注册表是 `.ts` ⇒ 跑这份脚本要用能解析 TS 的 runner：
//     `npx tsx scripts/audit-drill-residue.mjs`；守卫里按同一份注册表对撞，两边不再各写一套映射。）
let ENTITY_TYPES = [];
let REGISTRY_LOAD_ERROR = '';
try {
  ({ ENTITY_TYPES } = await import('../server/src/entities/registry'));
} catch (e) {
  // 读不到真源就**不许退回到我自己发明的规则**（那正是上一版犯的错）⇒ 只记一句，下面计入 unreadable
  REGISTRY_LOAD_ERROR = String(e?.message || e).slice(0, 160);
}

const R = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 标记集：基座那份是唯一出处；这里只**追加本审计器自己的两条历史拼写**，并写明为什么（不是偷偷加宽）：
 * `smoke` 小写、`TEST-` 连字符形都是老库里真出现过的写法（`detectResidueMarker` 认的是族，不认这两种字面）。
 *
 * ★★ `SIM-` **刻意不在残留集里**（与删除器同一立场，见 `clean-drill-residue.mjs:42` 那句"绝不可进删除清单"）：
 *   它是 company-sim 的常驻演示数据集，不是崩在中途留下的垃圾。混进"残留"这个数会让人学会忽略这个脚本，
 *   所以它被**单列一节**报出来（看得见，但不与残留相加 —— 两个口径不许互相加减）。
 *   现量（2026-09-23，只读，同一把 `sweepResidue`）：残留口径 **1307 条**，`SIM-` 另计 **36786 条**。
 */
export const AUDIT_MARKERS = [...RESIDUE_MARKERS, ...BROAD_MARKERS, 'smoke', 'TEST-'];
/** 演示数据集（只单列，不进残留总数） */
export const DEMO_DATASET_MARKERS = [...SIM_DATASET_MARKERS];

/**
 * 核心：跑一次全库只读普查。
 * @returns {hits, unreadable, demoTotal, modelsScanned, stringColsScanned, jsonColsScanned,
 *            dangling, unmappedTargetTypes, undeclaredUnmapped, exitCode}
 */
export async function runAudit({ prisma, Prisma, markers = AUDIT_MARKERS }) {
  const unreadable = [];
  if (REGISTRY_LOAD_ERROR) {
    unreadable.push({ model: 'EntityReference（targetType→模型 的解析）',
      why: `读不到产品侧实体注册表（${REGISTRY_LOAD_ERROR}）⇒ 悬挂面一律不查。这份读数**不完整**，请用 npx tsx 跑` });
  }
  const hits = await sweepResidue({ prisma, Prisma, markers, unreadableOut: unreadable });
  /** 演示数据集单独一遍：数不了也记进同一个 `unreadable`（同一份"别把数不了当干净"的纪律） */
  const demoUnreadable = [];
  const demo = await sweepResidue({ prisma, Prisma, markers: DEMO_DATASET_MARKERS, withFamily: false, unreadableOut: demoUnreadable });
  for (const u of demoUnreadable) unreadable.push({ model: `${u.model}（演示数据集通道）`, why: u.why });
  const demoTotal = demo.reduce((a, h) => a + h.count, 0);
  const modelDefs = allModels(Prisma);
  const stringColsScanned = modelDefs.reduce((a, m) => a + stringFields(m).length, 0);
  const jsonColsScanned = modelDefs.reduce((a, m) => a + (jsonFields(m) ?? []).length, 0);

  /**
   * 悬挂引用：targetType 的**全集与行数都由库派生**，不再手写五对（原先手写的 PAIRS 会悄悄漏掉新类型）。
   * ★ 解析规则（复核 BLOCKER 的处置 —— 我上一版在这里写了一张「已知映射不到」的表，被证伪后删掉）：
   *   ① 直接按委托键 / 首字母大写去 DMMF 找；
   *   ② 带点的嵌套类型（`relation.organization`）取**第一段**再找 —— 这条规则由 `server/src/entities/registry.ts`
   *      当**对照物**钉住（守卫 `drill-sweep-unreadable.test.ts` 里逐条比对 `type → sourceModel`），
   *      规则哪天不成立了守卫就红，而不是像上一版那样由我手写一句「它不是模型」当结论。
   *   ③ 仍然解析不到的 ⇒ 报出来 + **退出码非零**（上一版我给这类发过一张"已表态"的通行证，
   *      结果把库里**最大的一族悬挂**（`relation.organization`，现量 1080 行引用）压成了 0 退出 ⇒ 那正是本批要修的病）。
   */
  const dangling = [];
  const unmappedTargetTypes = [];
  // `targetType` 存的是**小写驼峰**（旧脚本那对 `['order','Order']` 就是这条事实），而 DMMF 给的是 PascalCase
  // ⇒ 两边靠 lowerFirst 对上，表名一律取 `dbName ?? name`（有 `@@map` 时不能拿模型名当表名）。
  const byKey = new Map(modelDefs.map((m) => [delegateKey(m.name), m]));
  const modelByName = new Map(modelDefs.map((m) => [m.name, m]));
  /** 注册表是第一手真源：`type` 直接给 `sourceModel`（模型名），点号规则一概不用 */
  const typeToModel = new Map(ENTITY_TYPES.map((e) => [e.type, e.sourceModel]));
  try {
    const types = await prisma.$queryRawUnsafe(
      `SELECT "targetType" AS t, COUNT(*)::int AS n FROM "EntityReference" GROUP BY 1 ORDER BY 1`);
    const resolve = (t) => {
      const declared = typeToModel.get(t);
      const named = declared ?? t ?? String(t).charAt(0).toUpperCase() + String(t).slice(1);
      const cands = declared ? [declared] : [String(t).charAt(0).toUpperCase() + String(t).slice(1), t];
      for (const c of cands) { const d = modelByName.get(c) ?? byKey.get(delegateKey(c)); if (d) return d; }
      void named;
      return null;
    };
    for (const { t, n } of types) {
      const rows = Number(n ?? 0);
      // 空 targetType 也是一面（引用没有类型 ⇒ 谁都查不到它）；上一版 `if (!t) continue` 把它静默吃掉
      if (!t) { unmappedTargetTypes.push('<空字符串或 NULL>'); continue; }
      const def = resolve(t);
      if (!def) { unmappedTargetTypes.push(`${t}（${rows} 行引用）`); continue; }
      const table = def.dbName ?? def.name;
      // 归因要分得开：模型存在但表名形状奇怪 ⇒ 是**解析/白名单**问题，不是"它没有模型"
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
        unreadable.push({ model: `EntityReference→${t}`, why: `模型 ${def.name} 的表名不在安全标识符白名单内 ⇒ 这一类悬挂没查（不等于干净）` });
        continue;
      }
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS n FROM "EntityReference" r WHERE r."targetType" = $1 `
          + `AND NOT EXISTS (SELECT 1 FROM "${table}" x WHERE x."id" = r."targetId")`, t);
        dangling.push({ type: t, n: Number(rows?.[0]?.n ?? 0) });
      } catch (e) {
        unreadable.push({ model: `EntityReference→${t}`, why: `悬挂检查失败（${String(e.message || e).slice(0, 100)}）⇒ 这一类的"无悬挂"不可信` });
      }
    }
  } catch (e) {
    unreadable.push({ model: 'EntityReference', why: `targetType 全集取不到（${String(e.message || e).slice(0, 100)}）⇒ 悬挂面未检查` });
  }

  return {
    hits, unreadable, demoTotal,
    modelsScanned: modelDefs.length,
    stringColsScanned, jsonColsScanned,
    dangling, unmappedTargetTypes,
    // ★ 复核 BLOCKER 的处置：**没被数到的面就是失败**，不发通行证。
    //   （悬挂条数本身不算失败 —— 那是已知存量、根因在代码层，拿它当退出码会让人忽略退出码。）
    exitCode: (unreadable.length || unmappedTargetTypes.length) ? 2 : 0,
  };
}

const isMain = isCliEntry(import.meta.url);
if (isMain) {
  const req = createRequire(join(R, 'server', 'noop.js'));
  let envFile = join(R, 'server', '.env.local');
  if (!existsSync(envFile)) {
    const alt = join(R, '..', 'Bambook', 'server', '.env.local');
    if (existsSync(alt)) { envFile = alt; console.log(`⚠️ 本树没有 server/.env.local ⇒ 回落到 ${alt}（只报路径与库名，不打印内容）`); }
    else sysExit(`ABORT: 找不到 env（试过 ${join(R, 'server', '.env.local')}）⇒ 读不到库就不能报"零残留"`);
  }
  req('dotenv').config({ path: envFile, override: true });
  const { PrismaClient, Prisma } = req('@prisma/client');
  const prisma = new PrismaClient();
  const db = String(process.env.DATABASE_URL || '').replace(/^.*@/, '').split('?')[0];
  console.log(`════ 真库「演练/测试残留」普查（只读 · 不删）════`);
  console.log(`数据源：${envFile}  ⇒ 库名/主机 ${db || '(未配置)'}\n`);
  const r = await runAudit({ prisma, Prisma });
  // 分母为 0 的情况由基座 `sweepResidue` 自己抛（B109），这里不再写一条永远走不到的 sysExit
  console.log(`分母：扫了 ${r.modelsScanned} 个模型（String 列 ${r.stringColsScanned} · Json 列 ${r.jsonColsScanned}）`);
  console.log('  ⚠️ 这句话断言的是**当前生成的客户端认识多少模型**；`server/node_modules` 与主 checkout 共享（B122）⇒ 不许据此说"本树 schema 有 N 个模型"。');
  let total = 0;
  for (const h of r.hits) {
    total += h.count;
    console.log(`  ${String(h.count).padStart(5)} 条  ${h.model}（串 ${h.stringCount} / Json ${h.jsonCount}）`
      + (h.family ? ` · 族下界 ${h.family.realLowerBound}${h.family.sliced ? '（已截断，是下界）' : ''}` : ''));
    (h.sample ?? []).slice(0, 2).forEach((x) => console.log(`          ${x.id}`));
  }
  console.log(`\n★ 残留合计 ${total} 条（按模型去重后相加；同一行跨列只算一次 —— 口径见 sweepResidue 的 B110 注释）`);
  console.log(`  ⚠️ 这是**下界**：Json 通道每张表只切最近 ${JSON_SCAN_LIMIT} 行且不报 sliced ⇒ 极端情况下会少算（串列通道不受影响）`);
  console.log('  另：常驻演示数据集（' + DEMO_DATASET_MARKERS.join('/') + '）' + r.demoTotal + ' 条 —— 不是残留，不与上面的数相加（与删除器同一立场）');
  console.log('\n════ 悬挂引用（引用指向已不存在的实体）════');
  for (const d of r.dangling.filter((x) => x.n > 0)) console.log(`  ✗ ${d.type}：**${d.n} 条悬挂**（根因在代码层：删实体不清引用）`);
  if (!r.dangling.some((x) => x.n > 0)) console.log('  ✓ 本次派生出的 targetType 全都没有悬挂');
  for (const t of r.unmappedTargetTypes) {
    console.log(`  ✗ targetType=${t} 解析不到任何模型 ⇒ **这一面的悬挂没查**（退出码非零，等于本读数不完整）`);
  }
  console.log('\n════ 数不了的表（★ 有输出就不许说"零残留"）════');
  if (!r.unreadable.length) console.log('  ✓ 无');
  for (const u of r.unreadable) console.log(`  ✗ ${u.model}：${u.why}`);
  console.log('\n★ 本脚本只报告不删 ✓ —— 清理需另行确认（部分可能是有意的演示数据）');
  await prisma.$disconnect();
  process.exitCode = r.exitCode;
}

function sysExit(msg) { console.error(msg); process.exit(1); }
