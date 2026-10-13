// 甲方视角「首屏观感」走查（2026-09-17）—— 回答「打开后像不像一个成品」
//
// 设计要点（针对业务方的真实担忧：**不是"有没有 bug"，而是"打开后是不是一片空白/像半成品"**）：
//   ① ★ **动态发现全部侧栏入口**（不写死页面名）—— 实测 32 个入口，
//      写死页面名会**漏掉页面**（第一版就漏了：真实文案是「货运管理」不是「出运管理」、
//      「人事管理」不是「人力资源」，且「发票管理」根本不是一级入口 ✗）
//   ② ★ 空态判据：**body 文本 − 侧栏文本 = 主区文本** —— 主区文本过短 ⇒ 判「空白页」✗
//      （今天刚踩过：注册表齐、侧栏能点会高亮、tsc 0、单测全绿 —— 但主内容区全空 ✗）
//   ③ 记录每页**观感样本**（主区字数 + 开头片段）—— 第一版很多模块数据少，
//      要看起来像「还没用」✓ 而不是「坏了」✗
//   ④ 多角色：**各自动态发现**入口并逐个走查 ⇒ 顺手得到「权限差异」对照（B5）
//   ⑤ 换角色用**全新 context**（否则还是上个角色的会话 ✗ —— 实测踩过）
//
// 跑法：node scripts/acceptance-first-release-sightcheck.mjs
// 截图：/tmp/acceptance-sightcheck/*.png
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const OUT_DIR = '/tmp/acceptance-sightcheck';
const PW = 'Bambook@2026';
/** 主区文本短于这个长度 ⇒ 判「空白页」✗ */
const BLANK_THRESHOLD = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (n, d = '') => { results.push({ n, ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ n, ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const gap = (n, d = '') => { console.log(`  ⚠️  [gap] ${n}${d ? ' — ' + d : ''}`); };
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });

async function sweep(roleLabel, email) {
  // ★ 每个角色**全新 context**（否则沿用上个角色的会话，登录页根本不会出现 ✗）
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  let consoleErrors = 0;
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors += 1; });
  page.on('pageerror', () => { consoleErrors += 1; });

  /**
   * ★ 主区文本 —— 直接取 `.app-main-viewport`（App.tsx 的稳定类名）。
   *
   * ⚠️ 第一版用「body 文本 − 侧栏文本」并剔固定噪声，**不可靠**：
   *   实测每页开头都是「panda_hub_local … 调试面板 …」⇒ 噪声没剔干净 ⇒
   *   **真有空白页也可能混过阈值** ✗（阈值 40 字 vs 噪声上百字）。
   *   ⇒ 改用**唯一锚点**，并**证伪过**（见提交说明：去掉某页渲染分支 → 立刻被标空白 ✓）
   */
  const mainText = () => page.evaluate(() => {
    const el = document.querySelector('.app-main-viewport');
    return (el?.innerText || '').replace(/\s+/g, ' ').trim();
  });
  /** 主区内可见元素数（辅助判据：空白页通常元素极少） */
  const mainNodeCount = () => page.evaluate(() => {
    const el = document.querySelector('.app-main-viewport');
    return el ? el.querySelectorAll('*').length : 0;
  });

  console.log(`\n──── ${roleLabel}（${email}）────`);
  const lg = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json();
  if (!lg.token) { fail(`${roleLabel} 登录`, '登录失败'); await ctx.close(); return; }

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('input[type="text"]', { timeout: 25000 });
  await page.fill('input[type="text"]', email);
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
  await sleep(1500);

  // ★ 动态发现该角色可见的全部入口
  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-sidebar-nav-item]'))
      .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
  pass(`${roleLabel} 登录 · 可见入口 ${labels.length} 个`);

  const blanks = [];
  for (const label of labels) {
    const nav = page.locator('[data-sidebar-nav-item]', { hasText: label }).first();
    // ★ 侧栏点击被全屏地球 canvas 拦截 ⇒ 始终 force
    await nav.click({ force: true, timeout: 10000 }).catch(() => {});
    // 轮询等主区真的渲染出内容（不用固定 sleep —— 否则会在旧视图上断言）
    let text = '';
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      text = await mainText();
      if (text.length > BLANK_THRESHOLD) break;
    }
    const nodes = await mainNodeCount();
    const shot = `${OUT_DIR}/${roleLabel}-${label.replace(/[\/\s]/g, '_')}.png`;
    await page.screenshot({ path: shot }).catch(() => {});
    if (text.length <= BLANK_THRESHOLD) {
      blanks.push(label);
      fail(`${roleLabel} · ${label}`, `★ 主区疑似**空白**（仅 ${text.length} 字 / ${nodes} 元素）`);
    } else {
      console.log(`  · ${label} — 主区 ${String(text.length).padStart(6)} 字 / ${String(nodes).padStart(4)} 元素 · 「${text.slice(0, 44)}」`);
    }
  }
  if (blanks.length === 0) pass(`${roleLabel}：全部 ${labels.length} 个入口主区均有内容（无空白页）`);
  else fail(`${roleLabel}：空白页 ${blanks.length} 个`, blanks.join(' / '));
  console.log(`  （${roleLabel} consoleErr=${consoleErrors}）`);
  await ctx.close();
  return labels;
}

try {
  const bossLabels = await sweep('老板', 'jason.shen@bambook.local');
  const salesLabels = await sweep('业务员', 'chloe.su@bambook.local');
  if (bossLabels && salesLabels) {
    const onlyBoss = bossLabels.filter((l) => !salesLabels.includes(l));
    console.log(`\n──── 权限差异（B5）────`);
    console.log(`  业务员看不到的入口 ${onlyBoss.length} 个：${onlyBoss.join(' / ') || '（无）'}`);
    console.log(`  业务员额外可见的：${salesLabels.filter((l) => !bossLabels.includes(l)).join(' / ') || '（无）'}`);
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n结果：${ok}/${results.length} 通过`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log('失败项：\n  - ' + failed.map((r) => r.n).join('\n  - '));
  console.log(`截图目录：${OUT_DIR}`);
} catch (e) {
  fail('脚本异常', String(e).slice(0, 300));
} finally {
  await browser.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}
