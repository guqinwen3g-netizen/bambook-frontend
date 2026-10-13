#!/usr/bin/env node
/**
 * 根门禁 JSON 读数的**唯一出处**（v3.219 落盘）。
 *
 * 为什么从 /tmp 搬进仓库：`/tmp/v3206_gate_read.cjs` 把输入路径**写死**成 `/tmp/v3214_gate.json`，
 * 于是 v3.219 那一批我明明传了当天的文件，它照样打印 v3.214 的 `pass=4113`（当天真数是 4123）。
 * 症状是"数字看着合理、只是不是今天的" ⇒ 光看输出抓不到，只有对账才抓得到。
 *
 * 三条自证（本件自己就是那把尺，缺任何一条就退出码 1，不许把"没读到"读成"通过"）：
 *  ① 输入必须**显式传参**，且文件存在、且 mtime 在 30 分钟内（旧批次的 JSON 一律拒）；
 *  ② **两通道对撞**：逐文件累加的 passed/failed/skipped 必须等于顶层 numTotalTests/numPassedTests/…，
 *     不等就说明聚合行与明细来自两次运行（或某层被截断）；
 *  ③ 六维都要打出来，**文件级错误与 skipped 单独成列**（"失败=0"不含这两维）。
 *
 * 用法：`npx vitest run --reporter=json --outputFile=/tmp/gate-<批次>.json && node scripts/gate-readout.mjs /tmp/gate-<批次>.json`
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_AGE_MS = 30 * 60 * 1000;
const arg = process.argv[2];
if (!arg) {
  console.error('✗ 没给 JSON 路径 ⇒ 本件拒绝读数（绝不回退到任何"上一次的"文件）');
  process.exit(1);
}
const file = path.resolve(arg);
if (!fs.existsSync(file)) {
  console.error(`✗ 输入文件不存在：${file}`);
  process.exit(1);
}
const age = Date.now() - fs.statSync(file).mtimeMs;
if (age > MAX_AGE_MS) {
  console.error(`✗ 输入文件是 ${Math.round(age / 60000)} 分钟前写的（上限 ${MAX_AGE_MS / 60000} 分钟）`
    + ` ⇒ 那是别的批次的读数，拒绝：${file}`);
  process.exit(1);
}

const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const t = j.testResults ?? [];
let pass = 0, fail = 0, skip = 0;
const fails = [], fileErr = [];
for (const f of t) {
  const arr = f.assertionResults ?? [];
  for (const a of arr) {
    if (a.status === 'passed') pass++;
    else if (a.status === 'failed') { fail++; fails.push(`${f.name} :: ${a.title}`); }
    else skip++;
  }
  if (f.status === 'failed' && arr.length === 0) fileErr.push(f.name);
}
console.log(`输入=${file} · mtime=${Math.round(age / 1000)}s 前 · 文件数=${t.length}`);
console.log(`逐文件累加：passed=${pass} failed=${fail} skipped=${skip} 文件级错误=${fileErr.length}`);
console.log(`顶层聚合：numPassedTests=${j.numPassedTests} numFailedTests=${j.numFailedTests} `
  + `numPendingTests=${j.numPendingTests ?? j.numSkippedTests} numTotalTests=${j.numTotalTests} success=${j.success}`);

if (t.length === 0) { console.error('✗ 零文件 ⇒ 采集坏了，不是"全绿"'); process.exit(1); }
const pending = j.numPendingTests ?? j.numSkippedTests ?? 0;
const mismatch = [];
if (pass !== j.numPassedTests) mismatch.push(`passed ${pass} ≠ 顶层 ${j.numPassedTests}`);
if (fail !== j.numFailedTests) mismatch.push(`failed ${fail} ≠ 顶层 ${j.numFailedTests}`);
if (skip !== pending) mismatch.push(`skipped ${skip} ≠ 顶层 ${pending}`);
// 注意：**不**拿 t.length 去对 `numTotalTestSuites` —— 顶层那个数数的是 describe 套件（今天 1035），
// 而 testResults 一项是一个**文件**（今天 222）。我第一版把两者当成同一个量，当场被自己的对撞抓到。
if (j.numTotalTests !== undefined && pass + fail + skip !== j.numTotalTests) {
  mismatch.push(`明细累加 ${pass + fail + skip} ≠ 顶层总数 ${j.numTotalTests}`);
}
if (mismatch.length) {
  console.error('✗ 两通道对撞不过：' + mismatch.join(' / ') + ' ⇒ 这份 JSON 不能当本批读数用');
  process.exit(1);
}
if (fails.length) console.error('FAILED:\n' + fails.slice(0, 20).join('\n'));
if (fileErr.length) console.error('FILE_ERR:\n' + fileErr.join('\n'));
console.log('✓ 两通道一致（明细累加 == 顶层聚合）· 以上即为六维读数，推进刻度只看签字表/四件事');
process.exit(fail === 0 && fileErr.length === 0 && j.success ? 0 : 1);
