// crawl-dom-deep.mjs —— DOM 深挖：进弹窗/页签，把"面"的下界抬高
//
// 与 crawl-dom-surface.mjs 的区别：那份只数**顶层**；这份会在每个屏面上
// 试着点开"像页签/弹窗/设置"的按钮，把**新出现的**元素也算进去。
//
// 用法：node scripts/crawl-dom-deep.mjs [baseUrl] [outJson] [maxScreens]
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const OUT = process.argv[3] || '/tmp/dom-deep.json';
const MAX = Number(process.argv[4] || 34);
const EMAIL = process.env.CRAWL_EMAIL || 'jason.shen@bambook.local';
const PASSWORD = process.env.BAMBOOK_DEMO_PASSWORD || 'Bambook@2026';

/** 值得点开的按钮文案（页签/弹窗/设置类）—— 只点这些，避免误触"删除/提交" */
const OPENERS = /(设置|配置|新建|新增|导入|导出|详情|明细|编辑|更多|筛选|高级|历史|日志|规则|参数|偏好|模板|字段|列|展开|查看)/;
/** 绝对不点（破坏性） */
const DANGER = /(删除|作废|取消|提交|确认|保存|发布|清空|重置|退出|登出|支付|发货|关闭)/;

const COUNT_FN = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const q = (s) => [...document.querySelectorAll(s)].filter(vis);
  const tx = (el) => (el.innerText || el.textContent || '').trim().slice(0, 40);
  return {
    buttons: q('button').length,
    inputs: q('input,textarea,select').length,
    tabs: q('[role="tab"],[class*="tab" i]').length,
    dialogs: q('[role="dialog"],[class*="modal" i]').length,
    tables: q('table').length,
    labels: [...new Set(q('button').map(tx).filter(Boolean))],
  };
};

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const out = { base: BASE, screens: [] };

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

  const seen = new Set();
  let n = 0;
  for (const t of navTexts) {
    if (n >= MAX) break;
    const navEl = page.locator(`text="${t}"`).first();
    if (!(await navEl.count())) continue;
    try { await navEl.click({ timeout: 5000 }); } catch { continue; }
    await page.waitForTimeout(2500);
    n++;
    const base = await page.evaluate(COUNT_FN);
    const screen = { nav: t, topLevel: { buttons: base.buttons, inputs: base.inputs, tabs: base.tabs, dialogs: base.dialogs, tables: base.tables }, opened: [] };
    seen.add(t);

    // 点开"像页签/弹窗"的按钮，数新增
    const candidates = base.labels.filter((l) => OPENERS.test(l) && !DANGER.test(l)).slice(0, 6);
    for (const label of candidates) {
      try {
        const el = page.locator(`button:has-text("${label}")`).first();
        if (!(await el.count())) continue;
        await el.click({ timeout: 4000 });
        await page.waitForTimeout(1500);
        const after = await page.evaluate(COUNT_FN);
        screen.opened.push({ label, buttons: after.buttons, inputs: after.inputs, dialogs: after.dialogs, deltaButtons: after.buttons - base.buttons });
        // 关掉：优先 Esc，其次"关闭/取消"
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(600);
        const closeBtn = page.locator('button:has-text("关闭"),button:has-text("取消"),[aria-label*="close" i]').first();
        if (await closeBtn.count()) { await closeBtn.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(500); }
      } catch { /* 单项失败不影响 */ }
    }
    const openedBtns = screen.opened.reduce((s, x) => s + Math.max(0, x.deltaButtons || 0), 0);
    screen.newFromOpening = openedBtns;
    console.log(`  [${t}] 顶层 ${base.buttons} · 点开 ${screen.opened.length} 个 · 新增 ${openedBtns}`);
    out.screens.push(screen);
  }
} catch (e) {
  out.fatal = String(e.message);
  console.log('致命错误：', String(e.message).slice(0, 200));
} finally {
  const top = out.screens.reduce((s, x) => s + x.topLevel.buttons, 0);
  const extra = out.screens.reduce((s, x) => s + (x.newFromOpening || 0), 0);
  out.totals = { screens: out.screens.length, topLevelButtons: top, newFromOpening: extra, total: top + extra };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n══ ${out.totals.screens} 屏 · 顶层按钮 ${top} · 点开后新增 ${extra} · 合计 ${top + extra} ══`);
  console.log(`输出：${OUT}`);
  await browser.close();
}
