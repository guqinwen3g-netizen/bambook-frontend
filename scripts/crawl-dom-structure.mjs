// crawl-dom-structure.mjs —— DOM 深挖（第三刀）：**按 DOM 结构找可点面，不靠文案**
//
// 为什么重写：第二刀（crawl-dom-deep.mjs）按 `button:has-text("设置|新建|…")` 筛，
// **只多找到 58 个** —— 因为本仓 UI **大量用图标按钮与自定义组件**：
//   ① 图标按钮无文字 ⇒ 文案筛不到；
//   ② 页签常是 `div[role=tab]` / 自定义组件，不是 `<button>`。
// ⇒ 本刀改为**按结构找**：`[role=tab]` · `[role=menuitem]` · `[aria-haspopup]` ·
//   `[data-state]` · `[role=button]` · 可点 `div/span`（有 onclick / cursor:pointer）。
//
// 用法：node scripts/crawl-dom-structure.mjs [baseUrl] [outJson] [maxScreens]
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const OUT = process.argv[3] || '/tmp/dom-structure.json';
const MAX = Number(process.argv[4] || 32);
const EMAIL = process.env.CRAWL_EMAIL || 'jason.shen@bambook.local';
const PASSWORD = process.env.BAMBOOK_DEMO_PASSWORD || 'Bambook@2026';

/** ★ 按结构统计"可点面"（不依赖文案） */
const SURVEY_FN = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const q = (s) => [...document.querySelectorAll(s)].filter(vis);
  const clickableDiv = [...document.querySelectorAll('div,span,li')].filter((el) => {
    if (!vis(el)) return false;
    const cs = getComputedStyle(el);
    return cs.cursor === 'pointer' && el.children.length <= 3 && (el.innerText || '').trim().length < 30;
  });
  return {
    roleTab: q('[role="tab"]').length,
    roleMenuItem: q('[role="menuitem"]').length,
    roleButton: q('[role="button"]').length,
    ariaHaspopup: q('[aria-haspopup]').length,
    ariaExpanded: q('[aria-expanded]').length,
    dataState: q('[data-state]').length,
    nativeButton: q('button').length,
    anchors: q('a[href]').length,
    inputs: q('input,textarea,select').length,
    clickableDiv: clickableDiv.length,
    tables: q('table').length,
    dialogs: q('[role="dialog"],[class*="modal" i]').length,
  };
};

/** 在页面里找"值得点开的页签"，返回其索引（不靠文案） */
const FIND_TABS_FN = () => {
  const els = [...document.querySelectorAll('[role="tab"], [role="menuitem"], [aria-haspopup="menu"], [aria-haspopup="dialog"]')];
  return els.map((e, i) => i).slice(0, 12);
};

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const out = { base: BASE, screens: [] };

async function survey() { return page.evaluate(SURVEY_FN); }

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('button, input', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const eb = page.locator('input[type="email"],input[name="email"],input[placeholder*="邮箱" i]').first();
  if (await eb.count()) {
    await eb.fill(EMAIL);
    const pw = page.locator('input[type="password"]').first();
    if (await pw.count()) await pw.fill(PASSWORD);
    const btn = page.locator('button[type="submit"],button:has-text("登录")').first();
    if (await btn.count()) await btn.click();
    await page.waitForTimeout(4500);
  }

  const navTexts = await page.evaluate(() => {
    const q = [...document.querySelectorAll('nav a,[class*="sidebar" i] a,[class*="sidebar" i] button')];
    return [...new Set(q.map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 20))];
  });
  console.log(`侧边栏 ${navTexts.length} 项`);

  let n = 0;
  for (const t of navTexts) {
    if (n >= MAX) break;
    const navEl = page.locator(`text="${t}"`).first();
    if (!(await navEl.count())) continue;
    try { await navEl.click({ timeout: 5000 }); } catch { continue; }
    await page.waitForTimeout(2200);
    n++;
    const before = await survey();

    // ★ 按结构点页签：逐个点 role=tab / aria-haspopup，看"可点面总数"涨多少
    const tabCount = await page.evaluate(() => document.querySelectorAll('[role="tab"],[role="menuitem"],[aria-haspopup]').length);
    let opened = 0;
    let maxSeen = 0;
    for (let i = 0; i < Math.min(tabCount, 10); i++) {
      try {
        const el = page.locator('[role="tab"],[role="menuitem"],[aria-haspopup]').nth(i);
        if (!(await el.count())) continue;
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(1200);
        const s = await survey();
        const total = s.roleTab + s.roleMenuItem + s.roleButton + s.ariaHaspopup + s.nativeButton + s.clickableDiv;
        maxSeen = Math.max(maxSeen, total);
        opened++;
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(400);
      } catch { /* 单项失败不影响 */ }
    }
    const baseTotal = before.roleTab + before.roleMenuItem + before.roleButton + before.ariaHaspopup + before.nativeButton + before.clickableDiv;
    const screen = { nav: t, base: before, baseTotal, opened, maxSeen, delta: Math.max(0, maxSeen - baseTotal) };
    console.log(`  [${t}] 基础 ${baseTotal}（tab ${before.roleTab} / haspopup ${before.ariaHaspopup} / div ${before.clickableDiv}）· 点开 ${opened} · 峰值 ${maxSeen}`);
    out.screens.push(screen);
  }
} catch (e) {
  out.fatal = String(e.message);
  console.log('致命错误：', String(e.message).slice(0, 200));
} finally {
  const baseSum = out.screens.reduce((s, x) => s + x.baseTotal, 0);
  const peakSum = out.screens.reduce((s, x) => s + x.maxSeen, 0);
  out.totals = { screens: out.screens.length, baseSum, peakSum };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n══ ${out.totals.screens} 屏 · 基础可点面合计 ${baseSum} · 逐屏峰值合计 ${peakSum} ══`);
  console.log(`输出：${OUT}`);
  await browser.close();
}
