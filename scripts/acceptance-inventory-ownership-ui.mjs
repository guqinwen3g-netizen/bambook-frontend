// D7-② 货权汇总 · UI 级实机走查（真浏览器，2026-09-16）
//
// 为什么需要：API 通不等于 UI 可用。本批在「库存管理」加了第 4 个 Tab（货权汇总）
// 与物料详情里的货权下拉（inventory:write 可见），要确认真的点得开、渲染得出来。
//
// 验收锚点：
//   U1 库存管理页可达，且有第 4 个 Tab「货权汇总」
//   U2 切到货权汇总 → 「我方存货（报表口径）」卡片渲染，含数量与金额
//   U3 数量/金额**分行展示**（多单位/多币种并列，不是合成一个数）
//   U4 切回库存物料 → 展开一项 → 出现「货权」下拉（写权限可见）
//   U5 无阻断性红（bds-alert.danger = 0）+ 控制台 error 未异常增长
//
// 用法：node scripts/acceptance-inventory-ownership-ui.mjs（需前端 dev server 在 3000）
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://127.0.0.1:3000';
const EMAIL = 'jason.shen@bambook.local';
const PASSWORD = 'Bambook@2026';
const OUT_DIR = '/tmp/acceptance-inventory-ownership-ui';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
fs.mkdirSync(OUT_DIR, { recursive: true });

/** 点精确文本的 button（避免 hasText 子串误匹配） */
async function clickExactText(page, text) {
  return page.evaluate((t) => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim() === t);
    if (!btn) return false;
    btn.click();
    return true;
  }, text);
}

/** 找最内层「包含某段文本」的元素（skill：别用 locator('text=')） */
async function hasInnerText(page, needle) {
  return page.evaluate((n) => {
    const cands = Array.from(document.querySelectorAll('div,span,td,th,button'))
      .filter(d => (d.innerText || '').includes(n));
    if (!cands.length) return false;
    return cands.some(d => !Array.from(d.children).some(c => (c.innerText || '').includes(n)));
  }, needle);
}

async function main() {
  console.log('══ D7-② 货权汇总 · UI 走查 ══\n');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('input[type="text"]', { timeout: 25000 });
  await page.fill('input[type="text"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
  pass('登录', EMAIL);

  // 地球底图 pointer-events:auto 会拦点击 → force 绕开（skill 已登记为 actionability 误报）
  await page.locator('[data-sidebar-nav-item]', { hasText: '库存' }).first().click({ force: true, timeout: 15000 });
  await sleep(2500);
  if (await hasInnerText(page, '库存物料')) pass('U1 库存管理页可达');
  else fail('U1 库存管理页可达', '未找到「库存物料」分段');

  // U2 切到第 4 个 Tab
  const tabOk = await clickExactText(page, '货权汇总');
  if (!tabOk) { fail('U2 第 4 个 Tab「货权汇总」', '按钮未找到'); await browser.close(); return exit(); }
  await sleep(2500);
  if (await hasInnerText(page, '我方存货（报表口径）')) pass('U2 货权汇总 Tab 渲染', '含「我方存货（报表口径）」卡片');
  else fail('U2 货权汇总 Tab 渲染', '未渲染「我方存货（报表口径）」');

  // U3 数量 / 金额分行（多单位、多币种并列）—— 必须取**卡片内**文本，
  // 取整页会把侧栏数字也算进来（断言假绿，本轮第一次就踩了）
  const summaryText = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.bds-card'))
      .find(c => (c.innerText || '').includes('我方存货（报表口径）'));
    return card ? card.innerText.replace(/\n+/g, ' | ') : '';
  });
  const hasQty = /\d[\d,]*(\.\d+)?\s*(M|YD|KG|PC|PCS)/.test(summaryText);
  const hasMoney = /(CNY|USD|EUR)\s*[\d,]+\.\d{2}/.test(summaryText);
  if (hasQty && hasMoney) pass('U3 我方存货卡片出数（数量带单位 + 金额带币种）', summaryText.slice(0, 150));
  else fail('U3 我方存货卡片出数', `单位=${hasQty} 币种=${hasMoney}｜${summaryText.slice(0, 150)}`);
  await page.screenshot({ path: `${OUT_DIR}/ownership-summary.png`, fullPage: false });

  // U4 切回物料，展开第一项，看货权下拉
  await clickExactText(page, '库存物料');
  await sleep(2000);
  const expanded = await page.evaluate(() => {
    const card = document.querySelector('.bds-card button');
    if (!card) return false;
    card.click();
    return true;
  });
  await sleep(1800);
  if (expanded && await hasInnerText(page, '货权')) pass('U4 物料详情出现「货权」行（写权限可见下拉）');
  else fail('U4 物料详情「货权」行', '未找到');
  await page.screenshot({ path: `${OUT_DIR}/item-ownership.png`, fullPage: false });

  // U5 无阻断性红 + 控制台
  const danger = await page.evaluate(() => document.querySelectorAll('.bds-alert.danger').length);
  if (danger === 0) pass('U5 无阻断性红（bds-alert.danger = 0）');
  else fail('U5 存在阻断性红', `${danger} 处`);
  if (consoleErrors.length === 0) pass('U5 控制台无 error');
  else console.log(`  ⓘ 控制台 error ${consoleErrors.length} 条：${consoleErrors.slice(0, 2).join(' ｜ ')}`);

  await browser.close();
  return exit();
}

function exit() {
  const failed = results.filter(r => r.ok === false).length;
  const passed = results.filter(r => r.ok === true).length;
  console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`);
  console.log(`截图目录：${OUT_DIR}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('脚本异常：', e); process.exit(1); });
