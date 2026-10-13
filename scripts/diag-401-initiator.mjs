/**
 * 首屏 401 溯源（handoff §三 #6 第二阶段）
 *
 * 上一阶段已确认：19 条 401 全部发生在「未登录冷启动」，且全部没带 Bearer。
 * 本阶段回答「是谁发的」——用 CDP 抓 Network.requestWillBeSent 的 initiator
 * 调用栈，直接定位到源码文件:行号。
 *
 * 只观测，不写业务数据。
 */

import { chromium } from 'playwright';

const BASE = process.env.BAMBOOK_BASE || 'http://127.0.0.1:3000';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');

const pending = new Map(); // requestId -> initiator stack
const hits = [];

cdp.on('Network.requestWillBeSent', (e) => {
  const url = e.request.url;
  if (!/\/api\//.test(url)) return;
  if (url.includes('openfreemap')) return;
  const frames = e.initiator?.stack?.callFrames || [];
  pending.set(e.requestId, {
    url,
    at: Date.now(),
    stack: frames.slice(0, 8).map((f) => `${f.functionName || '(anon)'} @ ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`),
    type: e.initiator?.type,
  });
});

cdp.on('Network.responseReceived', (e) => {
  const status = e.response.status;
  if (status < 400) return;
  const rec = pending.get(e.requestId);
  if (!rec) return;
  hits.push({ ...rec, status });
});

const t0 = Date.now();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);

console.log(`\n冷启动未登录：捕获 ${hits.length} 条 4xx（含调用栈）\n`);

// 按「最深的业务调用帧」归并
const groups = new Map();
for (const h of hits) {
  // 取第一条非 node_modules/非 vite 内部帧作为归因点
  const biz =
    h.stack.find((s) => !s.includes('/@fs/') && !s.includes('node_modules') && !s.includes('(anon) @ ')) ||
    h.stack[0] ||
    '(no stack)';
  const short = h.url.replace(BASE, '').slice(0, 90);
  const key = `${short}\n      ← ${biz}`;
  if (!groups.has(key)) groups.set(key, { n: 0, first: h.at - t0, frames: h.stack });
  groups.get(key).n += 1;
}

for (const [key, v] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ×${String(v.n).padStart(2)}  +${v.first}ms  ${key}`);
}

console.log('\n===== 每个 URL 取一条完整栈（自上而下）=====');
const seen = new Set();
for (const h of hits) {
  const short = h.url.split('?')[0].replace(BASE, '');
  if (seen.has(short)) continue;
  seen.add(short);
  console.log(`\n[${h.status}] ${short}  initiator.type=${h.type}`);
  for (const s of h.stack) console.log(`    ${s}`);
}

await browser.close();
