#!/usr/bin/env node
// 从 BusinessDocu 的 PDF 里抽出**可读文本**（这些 PDF 的正文是十六进制编码的 PDF 字符串，
// 形如 <506C65617365> ⇒ 解成 "Please"）。用途：把真实单据里的业务规则抽出来做判据。
//
// 用法：node scripts/extract-businessdocu-text.mjs [输出目录]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/qinwengu/WorkBuddy/Claw/BusinessDocu';
const OUT = process.argv[2] || '/tmp/businessdocu-text';

/** 解一段十六进制字符串 → 文本 */
function hexToText(hex) {
  let s = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (!Number.isNaN(code) && code >= 32 && code <= 126) s += String.fromCharCode(code);
    else s += ' ';
  }
  return s;
}

/** 从 PDF 原始字节里抽出所有 <hex> 串并解码；再用 Tj/TJ 顺序还原 */
function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  const out = [];
  // 匹配 <hex> ... Tj   以及 (...) ... Tj
  const reHex = /<([0-9A-Fa-f\s]{4,})>\s*Tj/g;
  let m;
  while ((m = reHex.exec(raw)) !== null) {
    const t = hexToText(m[1].replace(/\s+/g, ''));
    if (t.trim()) out.push(t);
  }
  const reLit = /\(([^)]{2,})\)\s*Tj/g;
  while ((m = reLit.exec(raw)) !== null) {
    const t = m[1].replace(/\\([()\\])/g, '$1');
    if (/[\x20-\x7E]{2,}/.test(t)) out.push(t);
  }
  return out.join('').replace(/\s{2,}/g, ' ');
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.pdf$/i.test(e.name)) acc.push(p);
  }
  return acc;
}

const files = walk(ROOT);
fs.mkdirSync(OUT, { recursive: true });
let ok = 0, empty = 0;
const index = [];
for (const f of files) {
  let text = '';
  try { text = extractPdfText(fs.readFileSync(f)); } catch { /* 跳过读不了的 */ }
  const rel = path.relative(ROOT, f);
  const safe = rel.replace(/[/\\#:]/g, '_');
  fs.writeFileSync(path.join(OUT, safe + '.txt'), text);
  if (text.trim().length > 50) ok++; else empty++;
  index.push({ rel, chars: text.trim().length });
}
fs.writeFileSync(path.join(OUT, '_index.json'), JSON.stringify({ total: files.length, withText: ok, empty, index }, null, 2));
console.log(`PDF 总数 ${files.length} · 抽出文本 ${ok} · 文本极少/空 ${empty}`);
console.log(`输出目录：${OUT}`);
console.log('--- 抽到字数最多的 10 份 ---');
index.sort((a, b) => b.chars - a.chars).slice(0, 10).forEach((x) => console.log(`  ${x.chars} 字  ${x.rel}`));
