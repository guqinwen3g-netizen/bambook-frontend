// crawl-dom-surface.mjs —— 用真浏览器枚举"面"（交互元素）
//
// 为什么需要：源码枚举只能数出"文件/路由"，**数不出"面"** ——
// 232 个前端组件里有多少按钮、输入框、页签、菜单，只有**运行中的 DOM** 知道。
// 本脚本是《产物面清单》§2 发现 C 说的"第二种枚举方式"，与源码枚举**互撞**用。
//
// 用法：node scripts/crawl-dom-surface.mjs [baseUrl] [outJson]
// 默认 baseUrl = http://127.0.0.1:3100（本程另起的前端，不动走查环境）
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const OUT = process.argv[3] || '/tmp/dom-surface.json';
const EMAIL = process.env.CRAWL_EMAIL || 'jason.shen@bambook.local';
const PASSWORD = process.env.BAMBOOK_DEMO_PASSWORD || 'Bambook@2026';

/** 在页面里数各类可交互元素 */
const COUNT_FN = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const q = (sel) => [...document.querySelectorAll(sel)].filter(vis);
  const text = (el) => (el.innerText || el.textContent || '').trim().slice(0, 40);
  return {
    buttons: q('button').map(text).filter(Boolean),
    inputs: q('input,textarea,select').length,
    links: q('a[href]').length,
    tabs: q('[role="tab"],[class*="tab" i][role],.tab').map(text).filter(Boolean),
    checkboxes: q('input[type=checkbox]').length,
    tables: q('table').length,
    dialogs: q('[role="dialog"],.modal,[class*="modal" i]').length,
    navItems: q('nav a,[class*="sidebar" i] a,[class*="nav" i] button').map(text).filter(Boolean),
  };
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const out = { base: BASE, startedAt: new Date().toISOString(), steps: [] };

async function snap(label) {
  try {
    const r = await page.evaluate(COUNT_FN);
    out.steps.push({ label, url: page.url(), ...r });
    console.log(`  [${label}] buttons=${r.buttons.length} inputs=${r.inputs} links=${r.links} tables=${r.tables}`);
  } catch (e) {
    out.steps.push({ label, url: page.url(), error: String(e.message).slice(0, 120) });
    console.log(`  [${label}] 失败：${String(e.message).slice(0, 80)}`);
  }
}

try {
  console.log(`==> 打开 ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // ★ 实测：本应用启动 >2.5s（首屏登录页约 6s 才渲染完）⇒ 等久一点，别把"还没画完"读成"没有面"
  await page.waitForSelector('button, input, nav a', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await snap('landing');

  // 登录：优先走界面表单；找不到就退到 localStorage 注入
  const emailBox = page.locator('input[type="email"],input[name="email"],input[placeholder*="邮箱" i]').first();
  if (await emailBox.count()) {
    console.log('==> 走登录表单');
    await emailBox.fill(EMAIL);
    const pw = page.locator('input[type="password"]').first();
    if (await pw.count()) await pw.fill(PASSWORD);
    const btn = page.locator('button[type="submit"],button:has-text("登录"),button:has-text("Sign in")').first();
    if (await btn.count()) await btn.click();
    await page.waitForTimeout(4000);
  }
  await snap('after-login');

  // 枚举侧边栏模块，逐个点进去
  const navTexts = await page.evaluate(() => {
    const q = [...document.querySelectorAll('nav a,[class*="sidebar" i] a,[class*="sidebar" i] button')];
    return q.map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 20);
  });
  out.navItems = [...new Set(navTexts)];
  console.log(`==> 侧边栏 ${out.navItems.length} 项，逐个进入`);

  for (const t of out.navItems.slice(0, 40)) {
    try {
      const el = page.locator(`text="${t}"`).first();
      if (!(await el.count())) continue;
      await el.click({ timeout: 5000 });
      await page.waitForTimeout(2500);
      await snap(t);
    } catch { /* 单项失败不影响整体 */ }
  }
} catch (e) {
  out.fatal = String(e.message);
  console.log('致命错误：', String(e.message).slice(0, 200));
} finally {
  out.finishedAt = new Date().toISOString();
  const totalButtons = out.steps.reduce((s, x) => s + (x.buttons?.length || 0), 0);
  const totalInputs = out.steps.reduce((s, x) => s + (x.inputs || 0), 0);
  out.totals = { steps: out.steps.length, buttons: totalButtons, inputs: totalInputs };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n══ 汇总：${out.steps.length} 个屏面 · 按钮 ${totalButtons} · 输入 ${totalInputs} ══`);
  console.log(`输出：${OUT}`);
  await browser.close();
}
