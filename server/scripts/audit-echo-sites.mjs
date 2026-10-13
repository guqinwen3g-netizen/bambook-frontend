#!/usr/bin/env node
/**
 * §9 B33 / B36 / B37 / B39 清理前的**逐处盘点**（只读，不改文件）
 *
 * 为什么要这个文件：上一批我自己报"17 处里 16 处有日志"，独立复核纠正为 **15** 处 ——
 * 错在**脑内估算 catch 里有没有 logger**。本脚本把这件事打成事实清单。
 *
 * ⚠️ 本脚本已有三处自身错误，全部记在这里防再犯：
 *   ① 计数用了比守卫更严的正则 ⇒ 数到 34 而守卫数到 53。
 *      ⇒ **测量工具与判据必须同一份代码**，现在直接 import `lib/errorDebtScanners.mjs`（守卫也 import 它），
 *        两边不可能再分叉；本脚本末尾还会把总数与守卫基线对一遍。
 *   ② 判断"有没有日志"只看该行之**后**，而本仓惯例是 `logger.error(...)` 写在响应行的**上一行** ⇒ 大面积误报"缺"。
 *      现在：向上找到本 `catch (` 行为止（不借用上一个 catch 的日志）。
 *   ③ 行号漂移：自己实现的"剥注释"里行注释那条写成了 `(^|[^:]):\/\/`（要求 `//` 前有冒号）
 *      ⇒ **真注释根本没被剥掉**，而块注释被整段删除 ⇒ 报出来的 `文件:行号` 与原文件错位
 *        （例：报 `finance/forwardFxService.ts:369`，那处实际在 :149）。
 *      现在：判据侧用 lib 的**行号保真** strip，并额外用原始文件文本二次确认行号（下面 lineOf 干的就是这件事）。
 *
 * 用法（`server/` 下）：node scripts/audit-echo-sites.mjs [--missing-log|--bad-copy|--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b33Sites, b36Sites, b37Sites, b39Sites, scanSources } from './lib/errorDebtScanners.mjs';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITERAL = /'([A-Z][A-Z0-9_]{2,})'[\s\S]*?'([^']{2,})'/;

/** 命中点在**原始文件**里的真实行号：剥注释保住了行数，所以 stripped 的行号 == raw 的行号；
 *  这里再用原文那一行反查确认（对不上就报错，绝不信一个没核对过的行号）。 */
function lineOf(rawLines, strippedSrc, index, fragment, where) {
  const line = strippedSrc.slice(0, index).split('\n').length;
  const text = rawLines[line - 1] ?? '';
  const probe = fragment.split('\n')[0].trim().slice(0, 14);
  if (probe && !text.includes(probe)) {
    throw new Error(`${where}: 行号核对失败 —— 报 ${line} 行，但原文是「${text.trim()}」`);
  }
  return { line, text };
}

const entries = scanSources(SERVER);
const rows = [];
for (const { rel, abs, src } of entries) {
  const rawLines = fs.readFileSync(abs, 'utf8').split('\n');
  const catchLines = new Set();
  src.split('\n').forEach((l, i) => { if (/\bcatch\s*\(/.test(l)) catchLines.add(i + 1); });
  const sortedCatches = [...catchLines].sort((a, b) => a - b);

  const add = (kind, index, fragment) => {
    const { line } = lineOf(rawLines, src, index, fragment, `${rel}`);
    // 本 catch 的起点 = 不晚于本行的最后一个 `catch (`
    const start = sortedCatches.filter((c) => c <= line).pop() ?? Math.max(1, line - 6);
    const window = rawLines.slice(Math.max(0, start - 1), line + 3).join('\n');
    const hasLog = /logger\.(error|warn|info)/.test(window);
    // 码与文案取**上下文**而不是命中片段：判据只 matched 到 `fail('CODE', e?.message ||`，
    // 后半句中文兜底在命中区之外（初版从这里取 ⇒ 51 行全是 码=? 兜底=""，等于没有清单）
    const lit = (LITERAL.exec(window) ?? []);
    rows.push({
      file: rel, line, kind,
      code: lit[1] ?? '?', copy: (lit[2] ?? '').slice(0, 48), log: hasLog ? '有' : '缺',
      text: window.trim().slice(0, 160).replace(/\s+/g, ' '),
    });
  };

  for (const h of b33Sites(src)) add('B33', h.index, h[0]);
  for (const h of b36Sites(src, 'stringCopy')) add('B36①', h.index, h[0]);
  for (const h of b36Sites(src, 'codePassthrough')) add('B36②', h.index, h[0]);
  for (const h of b37Sites(src)) add('B37', h.index, h[0]);
  for (const h of b39Sites(src)) add('B39', h.index, h[0]);
}

const sum = (k) => rows.filter((r) => r.kind === k).length;
const filesOf = (k) => new Set(rows.filter((r) => r.kind === k).map((r) => r.file)).size;
const noLog = rows.filter((r) => r.kind === 'B33' && r.log === '缺');
const badCopy = rows.filter((r) => r.kind === 'B33' && (!/[一-龥]/.test(r.copy) || r.copy.length < 6));
// ← 守卫基线（改了基线要同步这里）。
// 7a 批：B33 51/21 → 46/20（清 procurement/materialReturnService.ts 5 处）→ 42/19（清 credit/creditRoute.ts 4 处）。
// 7b 批：新立 B39（位置参数内插，五条判据全瞎）基线 65/15 → 清 samples 两份 7 处 → 58/13。
// 7c 批：再清 3 份 4 处（development/garmentDevelopmentService、migration/dataMigrationService、qc/qcChainService）→ 54/10。
// 7d 批：再清 2 份 5 处（shipping/orderShipmentBatchService、paymentRequests/paymentRequestService）→ 49/8。
// 7e 批：再清 2 份 8 处（exceptions/exceptionService、internalTrade/internalTransferService）→ 41/6。
// 7f 批：再清 2 份 10 处（samples/garmentSampleGateService、production/releaseService）→ 31/4。
// 7g 批：再清 1 份 5 处（orderChanges/orderChangeRequestService）→ 26/3。
// ★ v3.84 补上漏掉的一环：v2.73 清 config/systemConfigRoute.ts 3 处 ⇒ B33 42/19 → **39/18**
//   （当时只改了账面根侧那把尺、server 侧逐文件基线漏改；本文件的 EXPECT 也跟着漏了一版 ⇒
//    自 v2.73 起本脚本每跑一次都打印"与守卫基线不符"，但**退出码一直是 0** ⇒ 看得见、不会红。
//    v3.84 一并把 drift 改成非 0 退出，见文件末尾）。
const EXPECT = { B33: [39, 18], 'B36①': [10, 5], 'B36②': [18, 8], B37: [8, 7], B39: [20, 2] };

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, summary: Object.fromEntries(Object.keys(EXPECT).map((k) => [k, sum(k)])) }));
} else {
  const show = process.argv.includes('--missing-log') ? noLog
    : process.argv.includes('--bad-copy') ? badCopy : rows;
  for (const r of show) console.log(`${r.kind.padEnd(6)} ${r.file}:${r.line} 码=${r.code} 日志=${r.log} 兜底="${r.copy}"`);
}
console.log(`\n汇总：B33 ${sum('B33')} 处/${filesOf('B33')} 文件 · B36① ${sum('B36①')} 处/${filesOf('B36①')} 文件 · B36② ${sum('B36②')} 处/${filesOf('B36②')} 文件 · B37 ${sum('B37')} 处/${filesOf('B37')} 文件 · B39 ${sum('B39')} 处/${filesOf('B39')} 文件`);
let drift = 0;
for (const [k, [sites, files]] of Object.entries(EXPECT)) {
  if (sum(k) !== sites || filesOf(k) !== files) { drift += 1; console.log(`  ⚠️ ${k} 与守卫基线不符：本脚本 ${sum(k)} 处/${filesOf(k)} 文件 vs 基线 ${sites}/${files}`); }
}
console.log(drift === 0 ? `✓ ${Object.keys(EXPECT).length} 支配线与守卫基线一致（同一份判据代码 ⇒ 只可能差在基线表本身）`
  : '↑ 不一致通常是**守卫基线刚改过**：先跑 scripts/measure-error-debt.mjs 对数，再同步本文件的 EXPECT');
console.log(`需补日志：${noLog.length} 处 · 兜底文案不合格（B31，需逐处手写中文）：${badCopy.length} 处`);
// ★ v3.84：漂了就必须红。此前只打印、绝不置退出码 ⇒ 本脚本自 v2.73 起每跑一次都在报
//   "与守卫基线不符"却始终退 0 —— 看得见、不会红。改成非 0 退出后，"改了守卫基线忘同步 EXPECT"当场失败。
if (drift > 0) process.exitCode = 1;
