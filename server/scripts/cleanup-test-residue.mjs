/**
 * cleanup-test-residue.mjs — 清理本会话演练在**本地开发库**的残留（2026-09-18 起；v2.65 可注入；v2.66 补 CLI 与待批轴）
 *
 * 背景（浏览器走查发现的真问题）：D6 远期合约列表里全是 `TEST_D6FX_...` ⇒ 演练漏数据了。
 * 根因：演练的清理与「零残留」断言按 **id 前缀** 查，而**服务生成的 id 不带演练前缀**
 *   （`createForwardFxContract` → `FFX__...`）⇒ 断言永远看到 0 ⇒ **空过**（假绿）。共漏 98 行。
 *
 * 用法：cd server && node scripts/cleanup-test-residue.mjs                       # 默认 dry-run
 *      cd server && node scripts/cleanup-test-residue.mjs --apply                # 真删（仍需人工批准，§12.1 第 5 条）
 *      cd server && node scripts/cleanup-test-residue.mjs --apply --approved     # ★ v2.66：承认「待批族已获点头」，否则拒绝执行
 *      cd server && node scripts/cleanup-test-residue.mjs --apply --allow-sensitive
 *                                                                                # ★ 才允许动 sensitive（演练账号＝带真凭据的主体）
 *
 * ★★ 为什么结构要能注入（两批连续踩同一个坑，这次被复核抓到）：
 *   v2.63 的守卫匹配"循环写法" ⇒ 换一种写法（`forEach` / 换变量名）就绕过（BLOCK-1）。
 *   v2.65 换成"断言到达 deleteMany 的 (model, where) 集合"，**但只驱动 `runDeletePlan` 这一个函数**
 *     ⇒ 复核在 CLI 段插一句 `prisma.userAccount.deleteMany({ where: {} })`，11 例仍全绿
 *     ⇒ **判据类型换对了，覆盖面没换够**（本仓自己的规矩：结构守卫的覆盖面必须 ≥ 代码的写法面）。
 *   ⇒ v2.66：① CLI 壳也抽成可注入的 `runCli({prisma, argv, log})`，守卫两个都驱动；
 *            ② 再加一道**调用点普查**：两个消费者文件里的 `deleteMany(` 出现次数必须等于登记的站点数（多一处就红，逼人来表态）。
 *   ⚠️ 本文件被 import 时**不得构造 PrismaClient**。
 */
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { drillTargets, derivedLinkTargets, APPROVAL_REQUIRED_MODELS } from '../../scripts/lib/drill-residue.mjs';

/** 删除顺序：先删引用方（link / 审计），最后删被引用方；账号面排最后 */
const ORDER = ['forwardFxSettlementLink', 'auditLog', 'invoice', 'fxSettlement', 'paymentVoucher', 'forwardFxContract', 'shipment', 'order', 'inventoryItem', 'fabricShipmentSample', 'pricingCalculation', 'commissionRule', 'creditNote', 'userAccount'];

/**
 * ★ v2.63（复核 2）：交割关联的 `contractId` 是**服务生成的合同 id** ⇒ 前缀认领结构上够不到。
 *   ⇒ 两段式：先按合同目标取 id，再产 `in` 目标。**只读阶段也走同一条路**，否则 dry-run 的"命中 N 行"是假的。
 */
export async function withDerivedLinks(prisma, base) {
  const ids = [];
  for (const t of base.filter((x) => x.model === 'forwardFxContract')) {
    const rows = await prisma.forwardFxContract.findMany({ where: t.where, select: { id: true } }).catch(() => []);
    for (const r of rows ?? []) if (r?.id) ids.push(r.id);
  }
  return [...base, ...derivedLinkTargets(ids)];
}

/**
 * 删除计划。@returns {{mode:string, hit:number, deleted:number, remain:number, calls:Array, skippedSensitiveTargets:number, failures:number}}
 * ⚠️ `hit` 是**按目标求和**（同一张表被两条认领覆盖时会重复计数）⇒ 打印里带重叠标注；
 *    `skippedSensitiveTargets` 数的是**条**（不是行）——v2.66 特意与 lib 侧的 `skippedSensitiveRows`（行）分名（复核 IMPORTANT-4）。
 */
export async function runDeletePlan(prisma, { apply = false, allowSensitive = false, approved = false, log = () => {} } = {}) {
  const LIST = await withDerivedLinks(prisma, drillTargets());
  const skipped = LIST.filter((t) => t.sensitive && !allowSensitive);
  const deletable = LIST.filter((t) => !t.sensitive || allowSensitive);
  const calls = [];
  let failures = 0;

  let hit = 0;
  for (const t of LIST) {
    const n = await prisma[t.model].count({ where: t.where }).catch(() => { failures += 1; return -1; });
    if (n > 0) hit += n;
    log(`${n > 0 ? '⚠️ ' : '   '}${t.label}${t.sensitive ? '【sensitive：默认不删】' : ''}: ${n < 0 ? '查询失败' : n}`);
  }
  const dup = [...new Set(LIST.map((t) => t.model))].filter((m) => LIST.filter((t) => t.model === m).length > 1).join('/');
  log(`\n合计命中：${hit} 行（按目标求和；同表多认领的表：${dup || '无'}${failures ? `；⚠️ ${failures} 条查询失败 ⇒ **下界**` : ''}）`);
  if (skipped.length) log(`（其中 ${skipped.length} **条** sensitive 目标默认不动 ⇒ 要 --allow-sensitive，且仍需人工批准）`);
  if (!apply) return { mode: 'dry-run', hit, deleted: 0, remain: 0, calls, skippedSensitiveTargets: skipped.length, failures };

  // ★ v2.66（复核 IMPORTANT-3）：待批族命中 > 0 而没带 --approved ⇒ **拒绝执行**（不是跳过：半删半留更难收拾）
  if (!approved) {
    const pending = LIST.filter((t) => APPROVAL_REQUIRED_MODELS.includes(t.model) && !t.sensitive);
    let touched = 0;
    for (const t of pending) touched += await prisma[t.model].count({ where: t.where }).catch(() => 0);
    if (touched > 0) {
      const ms = [...new Set(pending.map((t) => t.model))].join('/');
      throw new Error(`待批族命中 ${touched} 行（${ms}）⇒ 未带 --approved 拒绝执行；删不删归 §12.1 第 5/22 条，不由脚本替人决定`);
    }
  }
  const missing = [...new Set(deletable.filter((t) => !ORDER.includes(t.model)).map((t) => t.model))];
  if (missing.length) throw new Error(`模型不在删除顺序表里：${missing.join(', ')} ⇒ 引用方先删的保证失效，拒绝执行`);
  const sorted = [...deletable].sort((a, b) => ORDER.indexOf(a.model) - ORDER.indexOf(b.model));

  let deleted = 0;
  for (const t of sorted) {
    calls.push([t.model, t.where]);
    const r = await prisma[t.model].deleteMany({ where: t.where }).catch((e) => { log(`  ✗ ${t.label} 删除失败：${e?.message}`); failures += 1; return null; });
    if (r) { deleted += r.count; if (r.count > 0) log(`  已删 ${t.label}: ${r.count}`); }
  }
  log(`\n共删除 ${deleted} 行`);

  // ★ 独立复核：与删除**同判据、同集合**（关联行判据是删前的 id 快照；删后再反查得空集 = 恒真复核）
  let remain = 0;
  for (const t of deletable) {
    const n = await prisma[t.model].count({ where: t.where }).catch(() => { failures += 1; return -1; });
    if (n > 0) { remain += n; log(`  ✗ ${t.label} 仍剩 ${n} 行`); }
  }
  if (skipped.length) log(`  ⓘ 按设计未动的 sensitive 目标 ${skipped.length} 条（账号面，见 §12.1 第 5/22 条）`);
  log(remain === 0 ? '  ✓ 已尝试的范围内全部为 0（清理干净）' : `  ✗ 仍剩 ${remain} 行`);
  return { mode: 'apply', hit, deleted, remain, calls, skippedSensitiveTargets: skipped.length, failures };
}

/** ★ v2.66（复核 BLOCK-1）：CLI 壳做成可注入 ⇒ 守卫能驱动"整条真跑路径"，而不只是中间那个函数 */
export async function runCli({ prisma, argv = [], log = (...a) => console.log(...a) } = {}) {
  const apply = argv.includes('--apply');
  const allowSensitive = argv.includes('--allow-sensitive');
  const approved = argv.includes('--approved');
  log(`\n=== 演练残留清理（${apply ? '真删' : 'DRY-RUN（加 --apply 才真删）'}${allowSensitive ? ' · 含 sensitive 面' : ''}${approved ? ' · 已带 --approved' : ''}）===\n`);
  const r = await runDeletePlan(prisma, { apply, allowSensitive, approved, log });
  if (r.mode === 'dry-run') log('（DRY-RUN，未做任何修改）');
  return r.remain > 0 || r.failures > 0 ? 1 : 0;
}

/** 只有"被当脚本直接跑"时才连库（软链路径进来也要认得出 ⇒ 两边取 realpath，复核 MINOR-8） */
/** CLI-entry 判定并进共用实现（★ v3.77 复核 #19 BLOCKER-1：这一族原先各自手写字符串比较，
 *  经符号链接的调用路径会让整块 CLI 静默不跑并退 0。本文件是**唯一一个已经做对了的**，
 *  现在由 `isCliEntry` 承接 ⇒ 一族一份实现，不再有两套真源。） */
import { isCliEntry } from '../../scripts/lib/acceptance-selfcheck.mjs';
const isMain = isCliEntry(import.meta.url);
if (isMain) {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { PrismaClient } = req('@prisma/client');
  const prisma = new PrismaClient();
  try {
    process.exitCode = await runCli({ prisma, argv: process.argv.slice(2) });
  } catch (e) {
    console.error(`✗ ${e?.message}`);   // 拒绝执行（缺删除顺序 / 待批族未带 --approved）⇒ 一行都不删
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
