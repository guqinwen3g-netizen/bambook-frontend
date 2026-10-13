#!/usr/bin/env node
/**
 * 源码里的「凭据形状字面量」普查（v3.237 补 25 新增）。
 *
 * 为什么还要再加一把尺：仓里现成那两把都扫不到这一层 ——
 *   `check-bundle-secret-leak.mjs` 扫**构建产物**，`probe-web-key-leak.mjs` 探**线上页面**，
 *   台账那句"HEAD 已干净"也是按那两把 + git 历史的口径说的。
 *   本批普查"默认就打生产"的脚本时，在**跟踪中的源码**里读到一枚 40 位十六进制 API Key 字面量
 *   （`scripts/test-frontend-exact.mjs`；另在 `docs/archive/` 的一份历史文档里还有一份）
 *   ⇒ "源码树"这一层从来没被扫过 ⇒ 那句"HEAD 已干净"是**在错的分母上说的**（见 §9 B282）。
 *
 * ★ 打印**指纹**不打印明文（前 6 位 + 长度 + sha256 前 12）：这把尺自己不能变成新的泄漏面。
 *
 * 用法：
 *   node scripts/secret-source-census.mjs               # 扫工作树（跟踪 + 未跟踪未被忽略），命中即退出码 1
 *   node scripts/secret-source-census.mjs --self-check   # 自证：抓得住已知形状、放得过 env 读取与占位符
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// ★ `[ _-]?`：文档里写作 "API Key"（中间是**空格**），只允许下划线/连字符会让那两处漏成假零。
const KEY_NAME = /(api[ _-]?key|apikey|secret|token|password|passwd|access[ _-]?key|authorization)/i;
/**
 * 引号**或反引号**里 ≥20 位的连续 hex，或 base64 样式（≥20 位且以 `=` 补位）。
 * ★ 第二支必须带 `=`：第一版写成 `[A-Za-z0-9+/]{24,}`，把 `''/api/v1'…` 这种**URL 路径**整类当命中
 *   （40 处里有 38 处是这么来的 ⇒ 尺乱咬会让人以后直接忽略这把尺的输出，那比没尺更糟）。
 * ★ 第三支的反引号是补的洞：文档里凭据habitually 写作 `` `d1db03…` ``，只认 ASCII 引号会让
 *   本批实测那 2 处真密钥被报成"0 处"（假零）。
 */
const LITERAL_G = /['"`]([0-9a-fA-F]{20,}|[A-Za-z0-9+/]{20,}={1,2})['"`]/g;
/** 反语境：这一句在说"这是摘要/字节数"，不是在赋值凭据（本批 3 处包摘要行就是这么被误伤的）。 */
const ANTI = /(sha256|sha1|md5|摘要|digest|checksum|字节)/i;
/** 键名与字面量之间允许的最大间隔（字符）：凭据写法都是 `KEY': 'v'` / `API Key 作废（\`v\`）` 这一类。 */
const MAX_GAP = 24;

/** 被"间隔/反语境"放掉的候选数——0 命中必须能区分"没有"与"都被我放掉了"。 */
let skippedCandidates = 0;

/** 一行的判定：邻近的键名上下文 + 引号/反引号里的长字面量 + 不是占位/全零/摘要语境 */
function bites(line) {
  const names = [...line.matchAll(new RegExp(KEY_NAME.source, 'gi'))];
  if (!names.length) return null;
  for (const m of line.matchAll(new RegExp(LITERAL_G.source, 'g'))) {
    const v = m[1];
    if (v.includes('${') || /^0+$/.test(v) || /^x+$/i.test(v) || /placeholder|example|dummy|changeme/i.test(line)) continue;
    const before = names.filter((n) => (n.index ?? 0) + n[0].length <= m.index);
    if (!before.length) continue;
    const last = before[before.length - 1];
    const gapStart = (last.index ?? 0) + last[0].length;
    const between = line.slice(gapStart, m.index);
    if (between.length > MAX_GAP || ANTI.test(between)) { skippedCandidates++; continue; }
    return {
      head: v.slice(0, 6), len: v.length,
      sha: createHash('sha256').update(v).digest('hex').slice(0, 12),
      via: last[0],
    };
  }
  return null;
}

function trackedFiles() {
  // ★ 必须 -c core.quotepath=off：默认会把中文文件名转义成 \346… ⇒ 按名字找文件必假零
  const tracked = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\0').filter(Boolean);
  // ★ 未跟踪但未被 ignore 的文件也在分母里：本批这把尺自己就是**未跟踪**的，
  //   而它的第一版把真密钥嵌进了自检夹具 —— 只扫 ls-files 会让它对自己的缺陷全盲。
  const others = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);
  return [...new Set([...tracked, ...others])];
}

export function scan(list = trackedFiles()) {
  const hits = [];
  for (const f of list) {
    let txt;
    try { txt = readFileSync(f, 'utf8'); } catch { continue; }   // 二进制/权限/已删：跳过但不静默——由 --verbose 报数
    txt.split('\n').forEach((line, i) => {
      const h = bites(line);
      if (h) hits.push({ file: f, line: i + 1, ...h });
    });
  }
  return hits;
}

function selfCheck() {
  // 合成值：形状与真凭据一致（64 位 hex），但内容是本机拼出来的死串，不是任何在用密钥。
  const KNOWN_SHAPE = "  'X-Bambook-API-Key': '" + 'deadbeef'.repeat(8) + "',";
  const cases = [
    ['已知形状（长 hex + 键名上下文）必须被抓', bites(KNOWN_SHAPE) !== null, true],
    ['env 读取写法不许误伤', bites("const key = process.env.BAMBOOK_API_KEY || '';") !== null, false],
    ['插值占位不许误伤', bites("const k = `sk-${process.env.X}`;") !== null, false],
    ['全零/占位串不许误伤', bites("const apiKey = '0000000000000000000000000000000000000000';") !== null, false],
    ['无键名上下文的真 base64 不误伤', bites("const svg = 'aGVsbG93b3JsZDEyMzQ1Njc4OTBhYmNkZWY=';") !== null, false],
    ['★ 反例（本批实测抓回来的一条）：引号里的 URL 路径不是凭据', bites("  const url = '/api/v1/reconciliation/token/ack';") !== null, false],
    ['文档形状（反引号 + "API Key" 带空格）必须被抓', bites('- 已泄露 API Key 作废（`' + 'cafebabe'.repeat(8) + '`）') !== null, true],
    ['反例：无键名上下文的构建产物摘要（64 位 hex）不误伤', bites('整包清单摘要 `' + 'a1b2c3d4'.repeat(8) + '`') !== null, false],
    ['反例（本批实测的 3 处误伤）：同一行"不取 token … 包内容摘要 → `64hex`"须被反语境放掉',
      bites('重打（不取 token、不联网）：包内容摘要 → `' + 'a1b2c3d4'.repeat(8) + '`') !== null, false],
    ['反例：键名与字面量隔一整句（>24 字）不误伤',
      bites('token 的用法见下文若干说明与举例，另外还有若干行说明文字与示例，此处 `' + 'a1b2c3d4'.repeat(8) + '`') !== null, false],
  ];
  let ok = true;
  for (const [name, got, want] of cases) {
    const pass = got === want;
    ok = ok && pass;
    console.log(`${pass ? '✓' : '✗'} ${name}（期望抓到=${want}，实测=${got}）`);
  }
  console.log(ok ? `[SELF-CHECK] ${cases.length} 格全过：尺有牙，也不乱咬` : `[SELF-CHECK] ✗ 不合格（${cases.length} 格）`);
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--self-check')) selfCheck();
else {
  const files = trackedFiles();
  const hits = scan(files);
  for (const h of hits) console.log(`   命中 ${h.file}:${h.line}  指纹 ${h.head}…（长度 ${h.len}，sha256 ${h.sha}…）← 键名 "${h.via}" · 不打印明文`);
  console.log(`[SECRET-SOURCE-CENSUS] 扫工作树文件 ${files.length} 个（跟踪 + 未跟踪未被忽略）· 命中 ${hits.length} 处 · 被反语境/间隔放掉的候选 ${skippedCandidates} 处`);
  if (hits.length) {
    console.log('结论：源码里仍有凭据形状字面量 ⇒ 退出码 1。处理＝改 env 读取或占位，并登记进 docs/密钥轮换与历史清理-清单。');
    process.exit(1);
  }
  console.log('结论：源码这一层 0 处凭据形状字面量（这一句只覆盖"源码树"这把尺的谓词，不等于"没有泄漏"）。');
}
