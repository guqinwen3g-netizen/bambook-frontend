#!/usr/bin/env node
/**
 * 未转义插值扫描器 —— 外部输入面排查的可复现工具。
 *
 * 用途：扫出所有「拼进 HTML 字符串但没有被转义函数包裹」的 ${...} 插值，供人工定级。
 * 背景（2026-09-15）：Bambook 有多条「业务数据 → 裸 HTML 字符串」的渲染链（服务端单据模板、
 * 前端 printDocument 打印链路）。只要有一个外部可控字符串漏了 esc()，就是存储型 XSS。
 * 靠人眼 review 不可靠，用脚本把可疑点全列出来逐条过。
 *
 * 用法：
 *   node scripts/scan-unescaped-interpolation.mjs                 # 默认扫内置两套目标
 *   node scripts/scan-unescaped-interpolation.mjs <file|dir> ...   # 扫指定路径
 *
 * 输出：每个可疑插值一行（文件:行号: 插值表达式）。**多数是数字/枚举/内部常量，非缺陷**——
 * 本脚本只负责不漏，定级靠人。定级时问三个问题：
 *   1. 这个值能被外部（客户/供应商/邮件同步/导入）控制吗？
 *   2. 它是字符串还是数字/枚举？（数字、内部常量、类名 = 安全）
 *   3. 它最终落进 HTML 的哪里？（文本节点风险低，属性内/标签内 = 高危）
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** 已知安全：内部已转义，或恒为数字/枚举/内部常量 */
const SAFE_FN = /^\$\{\s*(esc|escapeHtml|dash|qty|money|num|linesToHtml|renderDocStamp|fmt|pct|cur|badge|infoCell|fieldRow|docStr|partyBlock|exporterBlock|shippingMarks|imageCell|resolveInvoiceNo|formatDate|formatDocNumber|formatMoney|statusSemanticClass)\b/;

/** 含这些转义调用即视为已处理 */
const ESC_CALL = /\b(esc|escapeHtml)\s*\(/;

/** 纯数字/三元/索引，不含变量插值 —— 噪声太大，跳过 */
const NOISE = /^\$\{\s*(i|idx|index)\s*(\+\s*1)?\s*\}$|^\$\{\s*Date\.now\(\)\s*\}$|^\$\{\s*[A-Za-z_$][\w.]*\s*\?\s*'[^']*'\s*:\s*'[^']*'\s*\}$/;

/**
 * 默认只扫**真正拼 HTML 字符串**的模块。
 * 别把 React 组件（.tsx）加进来——JSX 走 React 默认转义，扫出来几百条全是噪声
 * （实测把 DocumentCenter.tsx 加进来会从 ~80 条涨到 449 条）。
 * 新增「业务数据 → 裸 HTML 字符串」的渲染器时，记得把它登记到这里。
 */
const DEFAULT_TARGETS = [
  'server/src/templates',              // 服务端单据模板（14 个 docTemplates）
  'components/tools/printDocument.ts', // 前端打印链路（window.open + document.write）
];

function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isFile()) {
    if (/\.(ts|tsx)$/.test(p)) out.push(p);
    return out;
  }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    // 测试文件里本来就写着注入 payload，扫出来全是预期噪声
    if (e.name === '__tests__' || /\.test\.tsx?$/.test(e.name)) continue;
    walk(path.join(p, e.name), out);
  }
  return out;
}

function scanFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const hits = [];
  let inBlockComment = false;

  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('/*')) inBlockComment = true;
    if (inBlockComment) {
      if (t.includes('*/')) inBlockComment = false;
      return;
    }
    if (t.startsWith('*') || t.startsWith('//')) return;

    const re = /\$\{([\s\S]*?)\}/g;
    let m;
    while ((m = re.exec(line))) {
      const inner = m[1];
      const full = '${' + inner + '}';
      if (SAFE_FN.test(full)) continue;
      if (ESC_CALL.test(inner)) continue;
      if (NOISE.test(full)) continue;
      hits.push({ line: i + 1, expr: full.slice(0, 120) });
    }
  });
  return hits;
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;
const files = [];
for (const t of targets) {
  const abs = path.isAbsolute(t) ? t : path.join(ROOT, t);
  if (!fs.existsSync(abs)) {
    console.error(`[skip] 不存在: ${t}`);
    continue;
  }
  walk(abs, files);
}

let total = 0;
for (const f of files) {
  const hits = scanFile(f);
  if (!hits.length) continue;
  total += hits.length;
  console.log(`=== ${path.relative(ROOT, f)} (${hits.length}) ===`);
  for (const h of hits) console.log(`  L${h.line}: ${h.expr}`);
}

console.log(`\n共 ${total} 处待人工定级（多数为数字/枚举/内部常量，非缺陷）。`);
console.log('定级三问：① 外部可控吗 ② 字符串还是数字/枚举 ③ 落在文本节点还是属性/标签内。');
