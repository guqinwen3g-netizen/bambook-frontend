// 甲方视角「点得动」走查（2026-09-17）—— 首屏观感的下一层：**页面是活的吗**
//
// 首屏走查证明「打开有内容」；本走查证明「**点得动**」——
// 列表行点了会不会真的打开详情（而不是静态壳子）。
//
// 覆盖：**服装外贸的核心业务链**（按行业日常，不是全站）：
//   接单 → 打样 → 报价 → 生产 → 出运 → 报关 → 收付款 → 售后
//
// ── ★★ 判据的两次修正（第一版两个方向都错，实测踩过）──────────────
// ① **假 gap**：等页面用「主区文本 > 40 字」⇒ 壳子文案就满足了 ⇒ 页面还没加载就找按钮 ⇒
//    4 个页面被误报成「没有详情类按钮」✗
//    ⇒ 改为**等该页自己的标题出现**（侧栏文案出现在主区）✓
// ② **假通过**（更危险）：判据是「主区文本有变化」⇒ 侧栏没导航成功时，
//    我又点了**上一页**的按钮，文本照样变化 ⇒ 报「有反应」✗
//    （实测：财务管理与售后索赔报出的数字**一模一样** 4125→4186 ⇒ 其实没导航 ✗）
//    ⇒ 改为**等导航确认** + 用**「出现『返回』」**作详情打开的信号
//      （实测订单详情页有「← 返回列表」✓ —— 列表页没有「返回」✓ 这个信号是干净的）
//
// 截图：/tmp/acceptance-clickable/*.png
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const OUT_DIR = '/tmp/acceptance-clickable';
const PW = 'Bambook@2026';

/** 核心业务链（按服装外贸日常顺序） */
const CHAIN = ['订单管理', '样品管理', '报价管理', '生产跟单', '货运管理', '外贸与报关', '财务管理', '售后索赔'];
/** 详情类按钮文案（各页写法不同，取并集；**不含「编辑」** —— 编辑常需先选中一行） */
const DETAIL_RE = /查看详情|查看|详情|明细|打开/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (n, d = '') => { results.push({ n, ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ n, ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const gap = (n, d = '') => { console.log(`  ⚠️  [gap] ${n}${d ? ' — ' + d : ''}`); };
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
const page = await ctx.newPage();
let consoleErrors = 0;
page.on('console', (m) => { if (m.type() === 'error') consoleErrors += 1; });
page.on('pageerror', () => { consoleErrors += 1; });

const mainText = () => page.evaluate(() => (document.querySelector('.app-main-viewport')?.innerText || '').replace(/\s+/g, ' ').trim());

try {
  const lg = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jason.shen@bambook.local', password: PW }),
  })).json();
  if (!lg.token) throw new Error('登录失败');

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('input[type="text"]', { timeout: 25000 });
  await page.fill('input[type="text"]', 'jason.shen@bambook.local');
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
  await sleep(1500);
  pass('登录');

  for (const label of CHAIN) {
    const nav = page.locator('[data-sidebar-nav-item]', { hasText: label }).first();
    if ((await nav.count()) === 0) { gap(`${label}：侧栏无入口`); continue; }

    // ★ 回列表（若上一轮进了详情）—— 先点「返回」再点侧栏
    await page.locator('.app-main-viewport button, .app-main-viewport a').filter({ hasText: /返回/ }).first()
      .click({ force: true, timeout: 3000 }).catch(() => {});
    await sleep(500);
    await nav.click({ force: true, timeout: 10000 }).catch(() => {});

    // ★ 等**该页自己的标题**出现在主区（不是"文本 > 40 字"那种壳子级判据）
    let before = '';
    let navigated = false;
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      before = await mainText();
      if (before.includes(label)) { navigated = true; break; }
    }
    if (!navigated) { fail(`${label}：导航未确认`, `主区未出现「${label}」`); continue; }

    // 找「详情类」按钮（只在主区找，且**排除「返回」**避免自己点自己）
    const target = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc);
      const main = document.querySelector('.app-main-viewport');
      if (!main) return null;
      const btns = Array.from(main.querySelectorAll('button, a, [role="button"]'))
        .filter((b) => {
          const t = (b.innerText || '').trim();
          return t && re.test(t) && !/返回/.test(t) && b.offsetParent !== null;
        });
      if (!btns.length) return null;
      return { text: (btns[0].innerText || '').trim().slice(0, 24), count: btns.length };
    }, DETAIL_RE.source);

    if (!target) {
      gap(`${label}：主区无详情类按钮（空态/列表为空？）`);
      await page.screenshot({ path: `${OUT_DIR}/${label}-nodetail.png` }).catch(() => {});
      continue;
    }

    const btn = page.locator('.app-main-viewport button, .app-main-viewport a, .app-main-viewport [role="button"]')
      .filter({ hasText: new RegExp(target.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
    await btn.click({ force: true, timeout: 8000 }).catch(() => {});
    await sleep(2800);
    const after = await mainText();
    const shot = `${OUT_DIR}/${label}-after-click.png`;
    await page.screenshot({ path: shot }).catch(() => {});

    // ★ 判据：「详情已打开」= 出现「返回」（列表页没有，详情页有 —— 实测订单详情有「← 返回列表」）
    const opened = /返回/.test(after) && !/返回/.test(before);
    if (opened) {
      pass(`${label} · 点「${target.text}」→ **详情已打开**`, `主区 ${before.length} → ${after.length} 字（出现「返回」）`);
    } else if (after !== before) {
      // 有反应但没出现「返回」—— 不判失败（可能是内联展开/页签切换），但要标出来供人工看
      gap(`${label} · 点「${target.text}」→ 主区有变化但**未出现「返回」**（形态待人工确认）`);
      console.log(`       ${before.length} → ${after.length} 字 · 截图 ${shot}`);
    } else {
      fail(`${label} · 点「${target.text}」→ **完全无反应**`, `主区文本未变化（${before.length} 字）—— 截图 ${shot}`);
    }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(600);
  }

  console.log(`\n结果：${results.filter((r) => r.ok).length}/${results.length} 通过 · consoleErr=${consoleErrors}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log('失败项：\n  - ' + failed.map((r) => r.n).join('\n  - '));
  console.log(`截图：${OUT_DIR}`);
} catch (e) {
  fail('脚本异常', String(e).slice(0, 300));
  await page.screenshot({ path: `${OUT_DIR}/99-error.png` }).catch(() => {});
} finally {
  await browser.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}
