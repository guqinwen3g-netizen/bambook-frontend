#!/usr/bin/env node
/**
 * 指控轴正对照（v3.77 · B187）—— 让"删了跑前就在的行"这件事**真响一次**
 *
 * 要答的问题很具体：第十四程打出 `删的跑前行=0`。这个 0 有两种成因，日志里形状完全相同：
 *   (a) 本次确实没删任何"跑前就在"的行；
 *   (b) **整根时间轴前移了**（时区 / naive DATETIME / 秒与毫秒换算差一档 ⇒ 每一行都读起来"在起点之后"），
 *       于是 `preexisting` 恒空，这根指控**永远哑** —— 而它哑的时候看起来正好是最干净的样子。
 * 窗口层与本层**共轴**（同一个 `runStart`、同一条 `toMs`）⇒ 那一侧不构成第二证人。
 * ⇒ 唯一的办法：真的埋几行已知时间的行、按显式 id 删掉、看仓内那份判据会不会把它们**分成两档**。
 *
 * 判据不在这里重写：分类直接调 `scripts/lib/acceptance-selfcheck.mjs` 里的 `deletedRowAttribution`
 * （同一个实现 ⇒ 这里不会成了第二套真源）。
 *
 * ★ 写入面红线（本批被自己的尺教过一次）：这些落点（v3.79 起 7 个）全部住在**一个回滚事务**里 ⇒ 这一程没有任何持久写入。
 *   第一版是"造完按显式 id deleteMany 收尾"，root 门禁的 B120 那把尺当场抓住
 *   （`手写 deleteMany 却没被冻结 ⇒ 只许降的基线漏了条目`）——那条基线的规矩是"升就是动删除面，
 *   先过 §12.1 第 27 条"，而红线写着**不擅自动删除面** ⇒ 正解不是把基线抬两格，而是根本不需要删。
 *   被验的对象没缩水：这根轴可疑之处是**写入/读回的时间**（列类型、驱动、会话时区、秒与毫秒），
 *   它们在 INSERT 落列 + SELECT 回读那一步就现形，与提不提交无关。
 * 埋的行 `status` 用哨兵 `drill_axis_control` 而不是 `queued`：实测 `agent/jobs.ts:claimNext()`
 * 会领走任何 `status:'queued'` 的行 ⇒ 未提交行外面本来看不见，但我不去制造那个竞态。
 *
 * 用法：node scripts/accusation-axis-control.mjs [--offsets=120,86400] [--json]
 * 退出码：0 两个方向都分得开；1 任一方向失灵（= 这根轴不可信，`删的跑前行=0` 读不出"没多删"）；
 *         2 环境/用法错（含"库不是本机" ⇒ 由 `openLocalPrisma` 当场拒）。
 */
import { openLocalPrisma, runAccusationAxisControl, axisResolutionCaveat, decompositionPhrase } from './lib/acceptance-selfcheck.mjs';

const OFFSETS = (process.argv.find((a) => a.startsWith('--offsets='))?.slice(10) || '120,86400')
  .split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0);
if (OFFSETS.length < 2) {
  console.error(`!! --offsets 至少两档（实测收到 ${OFFSETS.length} 档）⇒ 分辨率要靠多档撑起来，一档证不了这根轴有分辨力`);
  process.exit(2);
}

const t0 = new Date();
let opened;
try {
  opened = openLocalPrisma();          // fail-closed：非本机 host / 库名不像演练库 ⇒ 直接抛，不猜
} catch (e) {
  console.error(`!! 连库被拒：${String(e.message || e).slice(0, 200)}`);
  process.exit(2);
}
const { prisma, db } = opened;
console.log(`指控轴正对照（B187）· 库=${db.name}@${db.host}:${db.port} · 档=${OFFSETS.join('/')}s · runStart=${t0.toISOString()}`);

let v;
try {
  v = await runAccusationAxisControl({ prisma, db, runStart: t0, offsetsSec: OFFSETS, log: (s) => console.log(s) });
} finally {
  await prisma.$disconnect().catch(() => {});
}

if (process.argv.includes('--json')) console.log(JSON.stringify(v, null, 2));
console.log(v.ok
  ? `⇒ 通过：${v.offsetsSec.join('/')}s 两档 × 早/晚两向 ×（显式 createdAt 与 跑前主键快照）两条通路都分得开`
    // ★ v3.81（B200）：这里原来写的是"与本机起点差 Xms ⇒ 这一侧是零容差"，把**演练耗时**当成了**时钟偏差**。
    + `；"让库自己给 DEFAULT 时间"那一行：落点晚于本机起点 ${v.defaultedDevMs === null ? '未读到' : `${v.defaultedDevMs}ms`}`
    + `（拆开=${decompositionPhrase({ devMs: v.defaultedDevMs, leadMs: v.defaultedLeadMs, inTxMs: v.defaultedInTxMs })}；`
    + `两者相加若不等就不印等式；其中区间宽 ${v.defaultedElapsedMs ?? '未量'}ms、`
    + `到区间外侧的距离（＝应用与库的时钟/时区偏差）${v.defaultedClockDevMs ?? '未量'}ms 才是这一臂量"整轴平移"的那把尺）`
    + `（点名 ${v.preexistingMine} 行、放行 ${v.nonPreMine} 行、判不了 ${v.unknownMine} 行、持久残留 ${v.leftover} 行）`
    + `\n   ⚠️ ${axisResolutionCaveat(v.grid, { defaultedDevMs: v.defaultedDevMs,
      defaultedElapsedMs: v.defaultedElapsedMs, defaultedClockDevMs: v.defaultedClockDevMs,
      defaultedLeadMs: v.defaultedLeadMs, defaultedInTxMs: v.defaultedInTxMs })}`
  : `⇒ 不通过（${v.reasons.length} 条）：这根轴不可信，任何"删的跑前行=0"都不许读成"没多删"`
    + `\n${v.reasons.map((x) => '   · ' + x).join('\n')}`);
process.exit(v.ok ? 0 : 1);
