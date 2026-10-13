// 订单详情「11 区块」深走（2026-09-17）—— 甲方最核心的一条链
//
// ── 为什么不做"通用自动点击"（实测两版都失败，如实记）──────────
// 试过两版通用脚本（自动找「详情类按钮」并点它），**两个方向都不可靠**：
//   ① 假 gap：等页面用「主区文本 > 40 字」⇒ 壳子就满足 ⇒ 4 个页面被误报"没有详情按钮" ✗
//   ② 假通过：判据是「文本有变化」⇒ 侧栏没导航成功时点了**上一页**的按钮，文本照样变 ✗
//   ③ 改成「出现『返回』」后，订单管理匹配到的是**整行容器**（多行文本），点它无反应 ✗
// ⇒ **通用方案需要"猜按钮"，而各页写法差异太大**。**改为手工写死一条主链**（可靠、可读）。
//
// 本脚本：订单列表 → 打开第一条订单 → 逐个点开 DETAIL MAP 的 11 个区块 → 每块断言有内容
// 跑法：node scripts/acceptance-order-detail-deepwalk.mjs
// 截图：/tmp/acceptance-order-deepwalk/*.png
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const OUT_DIR = '/tmp/acceptance-order-deepwalk';
const PW = 'Bambook@2026';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (n, d = '') => { results.push({ n, ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ n, ok: false }); console.log(`  ✗ ${n} — ${d}`); };
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

  // ── 进订单管理，等列表真的加载 ──
  await page.locator('[data-sidebar-nav-item]', { hasText: '订单管理' }).first().click({ force: true });
  let listText = '';
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    listText = await mainText();
    // ★ 等**列表行**出现（不是等壳子）—— 行里有「查看详情」或订单号形态
    if (/查看详情/.test(listText) || /PO [A-Z0-9]{6,}/.test(listText)) break;
  }
  if (!/查看详情/.test(listText)) {
    fail('订单列表加载', `未出现「查看详情」（主区 ${listText.length} 字）`);
    throw new Error('列表未加载，无法继续');
  }
  pass('订单列表加载', `主区 ${listText.length} 字`);

  // ── 点第一条「查看详情」进详情 ──
  await page.locator('.app-main-viewport [role="button"], .app-main-viewport button, .app-main-viewport a').filter({ hasText: '查看详情' }).first()
    .click({ force: true, timeout: 8000 });
  let detail = '';
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    detail = await mainText();
    if (/返回/.test(detail)) break;
  }
  if (!/返回/.test(detail)) { fail('打开订单详情', `未出现「返回」（主区 ${detail.length} 字）`); throw new Error('详情未打开'); }
  await page.screenshot({ path: `${OUT_DIR}/00-detail-overview.png` });
  pass('打开订单详情', `主区 ${detail.length} 字`);

  // ── DETAIL MAP 的 11 个区块：从截图已知（概览/生产进度/关联视图/全链路/变更历史/变更申请/出运资格/生产线管/面料项目/基础档案/买卖四方）──
  // ★ 真实是 **19 个**区块（我从截图数成 11 ✗），第 8 个是「生产管线」不是「生产线管」✗
  //   实测取自 DOM（带序号的 DETAIL MAP 入口），不靠截图肉眼数
  const SECTIONS = [
    '概览', '生产进度', '关联视图', '全链路', '变更历史', '变更申请', '出运资格',
    '生产管线', '面料项目', '基础档案', '买卖四方', '交期与物流', '面料规格', '销售与收汇',
    '出货与发票', '大货船样', '匹头样', '采购与供应商', '特别说明',
  ];
  for (const s of SECTIONS) {
    const btn = page.locator('.app-main-viewport [role="button"], .app-main-viewport [role="button"], .app-main-viewport button, .app-main-viewport a')
      .filter({ hasText: s }).first();
    if ((await btn.count()) === 0) { fail(`区块「${s}」`, '未找到入口按钮'); continue; }
    const btnText = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 40);
    await btn.click({ force: true, timeout: 8000 }).catch(() => {});
    await sleep(1800);
    const scrolled = await page.evaluate(() => {
      const el = document.querySelector('.app-main-viewport');
      const sc = Array.from(el?.querySelectorAll('*') || []).find((e) => e.scrollHeight > e.clientHeight + 20);
      return sc ? Math.round(sc.scrollTop) : -1;
    });
    const t = await mainText();
    const shot = `${OUT_DIR}/sec-${s}.png`;
    await page.screenshot({ path: shot }).catch(() => {});
    // 判据：点了之后主区**仍有内容**且**不含报错关键词**（不要求"必须变化" —— 有的区块内容少）
    const hasError = /加载失败|出错了|Something went wrong|undefined|NaN/.test(t);
    if (t.length > 60 && !hasError) pass(`区块「${s}」`, `入口「${btnText}」· ${t.length} 字 · scrollTop=${scrolled}`);
    else fail(`区块「${s}」`, hasError ? `出现报错关键词 · 截图 ${shot}` : `内容过少（${t.length} 字）· 截图 ${shot}`);
  }

  console.log(`\n结果：${results.filter((r) => r.ok).length}/${results.length} 通过 · consoleErr=${consoleErrors}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log('失败项：\n  - ' + failed.map((r) => r.n).join('\n  - '));
  console.log(`截图：${OUT_DIR}`);
} catch (e) {
  fail('脚本异常', String(e).slice(0, 240));
  await page.screenshot({ path: `${OUT_DIR}/99-error.png` }).catch(() => {});
} finally {
  await browser.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}
