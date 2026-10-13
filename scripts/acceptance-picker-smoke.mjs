// picker 能力冒烟验证（**零写入**：只填选择器 + 确认选上，**不提交**）
// 为什么单独验：把 picker 直接塞进「录入订单」需要**多模型回滚**（Order + OrderLine ✗），
//   回滚不全 ⇒ 真库留垃圾 ✗ ⇒ **比不测更糟** ✗。所以先**独立验证能力本身** ✓。
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const OUT = '/tmp/acceptance-picker-smoke';
const PW = 'Bambook@2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

await (await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'jason.shen@bambook.local', password: PW }),
})).json();

const b = await chromium.launch({ headless: true });
const page = await (await b.newContext({ viewport: { width: 1560, height: 1000 } })).newPage();
const results = [];
const pass = (n, d = '') => { results.push({ n, ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ n, ok: false }); console.log(`  ✗ ${n} — ${d}`); };

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
await page.waitForSelector('input[type="text"]', { timeout: 25000 });
await page.fill('input[type="text"]', 'jason.shen@bambook.local');
await page.fill('input[type="password"]', PW);
await page.click('button[type="submit"]');
await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
await sleep(1500);
pass('登录');

await page.locator('[data-sidebar-nav-item]', { hasText: '订单管理' }).first().click({ force: true });
await sleep(4500);
await page.locator('text=录入订单').first().click({ force: true });
await sleep(3000);
pass('打开「录入订单」表单');

/** 填 label 父容器里的 input（typeahead）→ 等选项 → 点第一个 / 回车兜底 */
async function setPicker(labelText, value) {
  const filled = await page.evaluate(({ labelText, value }) => {
    const lab = Array.from(document.querySelectorAll('label')).find((l) => (l.textContent || '').includes(labelText));
    const input = lab?.parentElement?.querySelector('input');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    return true;
  }, { labelText, value });
  if (!filled) return { ok: false, how: 'no-input' };
  await sleep(1600);
  const opt = page.locator('[role="option"], [role="listbox"] li, ul li[role="button"]').first();
  if ((await opt.count()) > 0) {
    const txt = (await opt.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 30);
    await opt.click({ force: true }).catch(() => {});
    await sleep(700);
    return { ok: true, how: `click-option「${txt}」` };
  }
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(700);
  return { ok: true, how: 'press-Enter' };
}

for (const [labelText, value] of [['客户 (Customer)', 'Peerless'], ['供应商 (Supplier)', 'DRILL']]) {
  const r = await setPicker(labelText, value);
  await page.screenshot({ path: `${OUT}/${labelText.slice(0, 4)}.png` });
  // ★ 判据必须用**语义信号**，不能只用 `input.value`（实测踩过，第 6 次判据错 ✗）：
  //   该 picker 的 placeholder 正好是「Peerless」✗ ⇒ `input.value === 'Peerless'` 时
  //   **分不清"选上了"还是"只是 placeholder"** ✗
  //   真正的语义信号：字段下方出现「**已关联关系档案**」提示 ✓（选上后才出现 ✓）
  const readBack = await page.evaluate((lt) => {
    const lab = Array.from(document.querySelectorAll('label')).find((l) => (l.textContent || '').includes(lt));
    const box = lab?.parentElement;
    const input = box?.querySelector('input');
    // 该字段所在的更大容器（含下方提示文案）
    const outer = box?.parentElement ?? box;
    const hint = (outer?.innerText || '').replace(/\s+/g, ' ');
    return {
      value: input ? input.value : null,
      linked: /已关联关系档案/.test(hint),
      hint: hint.slice(0, 80),
    };
  }, labelText);
  if (!r.ok) fail(`${labelText}：定位失败`, r.how);
  else if (readBack.linked) pass(`${labelText} → ${r.how}`, `★ 语义信号「已关联关系档案」出现 ✓（值「${String(readBack.value).slice(0, 24)}」）`);
  else fail(`${labelText}：填了但**未出现「已关联关系档案」**`, `值「${readBack.value}」· 提示「${readBack.hint}」⇒ 选择可能没生效`);
}

const ok = results.filter((x) => x.ok).length;
console.log(`\n结果：${ok}/${results.length} 通过（**零写入**：未提交 ✓）`);
console.log(`截图：${OUT}`);
await b.close();
process.exit(results.some((x) => !x.ok) ? 1 : 0);
