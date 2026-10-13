/**
 * diag-test-residue.mjs — 只读诊断：本会话演练数据在真库的残留
 *
 * 为什么需要：浏览器走查时看到远期合约列表里全是 `TEST_D6FX_...` ——
 * **演练漏数据了**，而演练自己的「零残留」断言**是空过的**：
 * 它按 `id startsWith MARK` 查，但**服务生成的 id 是 `FFX__...`**（MARK 只加在 contractNumber 上）
 * ⇒ 断言永远看到 0 ⇒ 假绿。
 *
 * 本脚本按**业务号/编码前缀**清点（而不是 id），把"按 id 前缀查"这个盲区一次性照出来。
 * 只读，不删任何东西。
 */
import { createRequire } from 'node:module';
import { drillTargets, DRILL_PROBE_FX } from '../../scripts/lib/drill-residue.mjs';
import { withDerivedLinks } from './cleanup-test-residue.mjs';   // ★ v2.65（复核 IMPORTANT-5）：反查腿要**两边都算**，否则诊断总数与删除器总数只是"恰好相等"

const req = createRequire(import.meta.url);
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient();

/** 各演练用的业务号/编码前缀（与 id 前缀可能不同 —— 这正是盲区所在） */
/** ★ v2.62（B35 第二刀）：目标清单**唯一出处在基座**，本脚本只派生、不再手抄 */
const CHECKS = drillTargets();

const main = async () => {
  console.log('\n=== 演练数据残留清点（只读）===');
  // ★ v2.65：补反查腿（合同存在时关联行才认得到）⇒ 诊断与删除器从此看同一份计划
  const LIST = await withDerivedLinks(prisma, CHECKS);
  let total = 0;
  let failures = 0;
  for (const c of LIST) {
    const n = await prisma[c.model].count({ where: c.where }).catch(() => { failures += 1; return -1; });
    if (n > 0) total += n;
    console.log(`${n > 0 ? '⚠️ ' : '   '}${c.label}: ${n < 0 ? '查询失败' : n}`);
  }
  // ★ v2.65（复核 MINOR-4）：查询失败不许悄悄不计数 —— 有失败时这个合计是**下界**，要标出来
  console.log(`\n合计命中：${total} 行${failures ? `（⚠️ ${failures} 条查询失败 ⇒ 这是**下界**，不是准确数）` : ''}`);

  // 远期合约按 id 前缀再查一次（对照：证明「按 id 前缀查」会漏）—— 前缀取自基座，本脚本不再自己拼
  const P = DRILL_PROBE_FX;
  const byIdPrefix = await prisma[P.model].count({ where: { [P.fieldA]: { startsWith: P.prefix } } });
  const byNumberPrefix = await prisma[P.model].count({ where: { [P.fieldB]: { startsWith: P.prefix } } });
  console.log(`\n★ 对照：远期合约 id 前缀命中 ${byIdPrefix} 行 vs contractNumber 前缀命中 ${byNumberPrefix} 行`);
  // ★ v2.63：这里原来是**二分支**，`(0, >0)` 之外的所有情况都掉进"两种前缀都有命中" ⇒ 两侧都是 0 时
  //   它也照样打印"有命中"（正好是这把尺的老病：**把没数清的情况说成有结论**）。改成三分支。
  if (byIdPrefix === 0 && byNumberPrefix > 0) {
    console.log('⇒ 证实：演练的「零残留」断言按 id 前缀查 ⇒ **空过**（服务生成的 id 不带演练前缀）');
  } else if (byIdPrefix > 0 && byNumberPrefix > 0) {
    console.log('⇒ 两种前缀都有命中（情况更复杂，需逐条看）');
  } else if (byIdPrefix > 0) {
    console.log('⇒ 只有 id 侧命中、业务号侧 0 ⇒ 这批行是**直接拿 id 打标**写进来的，与 D6FX 那族形状不同（★ v2.65：原来这一档只看 id 侧就下"两种都有命中"的结论 = 单边证据）');
  } else {
    console.log('⇒ 两侧都是 0：**本对照今天没有证据可下**（这张表当前无该族演练行，不代表判据是对的）');
  }
};

main()
  .catch(e => { console.error('诊断失败：', e?.message || e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
