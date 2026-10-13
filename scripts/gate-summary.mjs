#!/usr/bin/env node
/**
 * 门禁读数汇总（v3.72 · B185；v3.74 升六元组；v3.76 升**八元组 + 三条对账**）
 *
 * 病（三批实测，不是设想）：
 *   B185 —— 取证链把 vitest 的**退出码丢掉**，只数 `numFailedTests` ⇒ 一次文件级错误（transform 失败）
 *            读成 `文件=1 用例=5 失败=0`，用例数从 6 掉到 5 而"失败=0"照旧。
 *   B188/I-2 —— `用例=` 只加 passed+failed ⇒ 13 条 `skipped` 在**任何一格读数里都不存在**（"跑了但没执行"）。
 *   v3.74 事故 —— 文件级错误第一版要求"该文件没有通过的用例"，而真实事故是**7 条全 passed、文件 failed、
 *            success=false** ⇒ 读成 `文件级错误=0`，只差"保留退出码"那一道就写进台账。
 *   复核 #18 —— ①`--check` 不是默认 ⇒ `失败=9` 也退 0（而我那批证人全走默认分支）；
 *            ②`status=passed` 而该文件 0 条用例（或 `todo`/缺 status）仍读成六格全零 + 退 0。
 * ⇒ 结论：**"绿"必须由若干条互不替代的对账共同成立**，任何一条维度缺席都不许把汇总行读成通过。
 *
 * 用法：node scripts/gate-summary.mjs [--check] <vitest-json>
 *   `--check` 保留为兼容别名（v3.76 起默认就拦：失败>0 一律非零退出）。
 * 输出（一行汇总 + 若干条原因行）：
 *   `文件=N 用例=M 失败=K 文件级错误=E 跳过=S 其他状态=X 空文件=F 注册=T runner未成功=R`
 *   ★ 非绿时这一行以 `!! ` 开头 ⇒ 人眼扫过也不会把"跑不起来"读成"全绿"。
 * 退出码：0 全绿；1 任一前提不成立（原因**逐条打全**，不再先 exit 吞掉后面的诊断）；2 用法错。
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const check = argv[0] === '--check';
const path = check ? argv[1] : argv[0];
if (!path) { console.error('用法：gate-summary.mjs [--check] <vitest-json>'); process.exit(2); }

const d = JSON.parse(readFileSync(path, 'utf8'));
const files = Array.isArray(d.testResults) ? d.testResults : [];
const KNOWN = new Set(['passed', 'failed', 'skipped', 'pending']);

// 文件级错误只看**文件自身是否 failed**（v3.74 收窄；不再要求"该文件没有通过的用例"）
const brokenFiles = files.filter((f) => f.status === 'failed');
// 空文件：一条注册用例都没有的文件。★ 与 brokenFiles 是**两回事**：
//   v3.74 我犯的错正是把它当成"文件级错误"的**定义**（于是"7 条全过但文件失败"那种漏掉）；
//   这里它只做**自己那一格**，且被 brokenFiles 覆盖的那些文件不重复计（否则同一件事在两个单位里各冒一次）。
const emptyFiles = files.filter((f) => f.status !== 'failed'
  && (!Array.isArray(f.assertionResults) || f.assertionResults.length === 0));
const statusCount = {};
for (const f of files) for (const a of (Array.isArray(f.assertionResults) ? f.assertionResults : [])) {
  statusCount[a.status] = (statusCount[a.status] || 0) + 1;
}
const passedTests = statusCount.passed || 0;
const failedTests = statusCount.failed || 0;
const skipped = (statusCount.skipped || 0) + (statusCount.pending || 0);
const otherStatus = Object.entries(statusCount).reduce((n, [k, v]) => n + (KNOWN.has(k) ? 0 : v), 0);
const registered = (typeof d.numTotalTests === 'number' && Number.isFinite(d.numTotalTests)) ? d.numTotalTests : -1;
const runnerUnsuccessful = d.success === false ? 1 : (d.success === undefined ? -1 : 0);

const summary = `文件=${files.length} 用例=${passedTests + failedTests} 失败=${failedTests}`
  + ` 文件级错误=${brokenFiles.length} 跳过=${skipped} 其他状态=${otherStatus} 空文件=${emptyFiles.length}`
  + ` 注册=${registered} runner未成功=${runnerUnsuccessful}`;

// ★ 一次算清所有不成立的原因，**全部**打出来，再统一退出（旧版顺序 exit 会让"分母塌了"那句永远不响）
const reasons = [];
if (failedTests > 0) reasons.push({ t: `失败=${failedTests} 条用例（v3.76 起无条件拦，不再要 --check）`, rows: [] });
if (brokenFiles.length > 0) reasons.push({
  t: '文件级错误：这些文件里有钩子/未捕获错误，"失败=0"不是绿',
  rows: brokenFiles.slice(0, 8).map((f) => `   !! ${String(f.name || '?').split('/').pop()} ⇒ ${String(f.message || f.name || '').split('\n').slice(0, 2).join(' / ').slice(0, 220)}`),
});
// ★ 跳过**只出声、不拦截**：那 13→8 条是降范围表第 46/47 条登记过的刻意不做，
//   把它设成硬失败等于替业务方推翻已拍板的范围（红线）；它的作用是让"全绿"必须连带看见这一格。
const notes = [];
if (skipped > 0) notes.push(`跳过=${skipped} 条：注册了却没执行（刻意不做，见 docs/降范围决策登记-2026-09-20.md 第 46/47 条）⇒ 不许从读数里消失，但也不许据此判红`);
if (otherStatus > 0) reasons.push({ t: `其他状态=${otherStatus} 条不属于 passed/failed/skipped/pending 任何一档（例如 todo）⇒ 分母里有人不在账上`, rows: [] });
if (emptyFiles.length > 0) reasons.push({ t: `空文件=${emptyFiles.length} 个：文件跑到了却一条用例都没注册（B185"跑不起来"、B188"没执行"之外的第三种隐身）`,
  rows: emptyFiles.slice(0, 8).map((f) => `   !! ${String(f.name || '?').split('/').pop()} ⇒ status=${JSON.stringify(f.status)}`) });
if (files.length === 0) reasons.push({ t: '一个测试文件都没有 ⇒ 分母塌了，不算通过', rows: [] });
if (runnerUnsuccessful !== 0) reasons.push({ t: `runner 顶层 success 不是 true（=${JSON.stringify(d.success)}）：退出码 1 背后一定有东西坏了，即使每个用例都显示通过`, rows: [] });
// 对账：注册数 = 跑过的 + 跳过的 + 不认识的（缺 numTotalTests 时不做这条，也不许假装"对过"）
if (registered >= 0 && registered !== passedTests + failedTests + skipped + otherStatus) {
  reasons.push({ t: `对账不平：注册=${registered} ≠ 用例 ${passedTests + failedTests} + 跳过 ${skipped} + 其他状态 ${otherStatus} = ${passedTests + failedTests + skipped + otherStatus} ⇒ 有落点不在任何一档上`, rows: [] });
}

console.log((reasons.length ? '!! ' : '') + summary);
for (const t of notes) console.log(`   · ${t}`);
for (const r of reasons) {
  for (const line of r.rows) console.log(line);
  console.log(`   ⇒ ${r.t}`);
}
if (reasons.length) {
  console.log(`⇒ 本次不绿：${reasons.length} 条前提不成立（每条都单独出声，不合并、不替代）`);
  process.exit(1);
}
console.log('⇒ 八元组与三条对账全部成立 ⇒ 这才叫绿');
process.exit(0);
