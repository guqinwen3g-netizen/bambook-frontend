// 「创建表单」必填校验走查（2026-09-17）
//
// ── 为什么做这一层 ─────────────────────────────────────────
// 「表单能打开」只是第一层 ✓；**甲方真正会踩的是"填完点提交之后"** ✗：
//   · 必填没校验 ⇒ **静默成功**（脏数据入库）✗
//   · 校验了但**没有提示** ⇒ 用户不知道哪里错了 ✗（最像半成品）
//   · 提交直接**崩**（pageerror）✗
//
// ── ★ 本走查是**零写入**的 ─────────────────────────────────
// 只做「**不填必填项**就提交」⇒ 合法实现下**不应落库** ✓
// （若真落了库，那本身就是缺陷 ⇒ 会被下面的断言抓到 ✓）
//
// ── ★★ 判据分三态（第一版判错，实测踩过）──────────────────
//   **禁用**（最佳 ✓）→ **点了被拦 + 有明确提示**（好 ✓）→ **点了没反应**（缺陷 ✗）
//   第一版只看「有没有文字提示」✗ ⇒ 把「**保存按钮是 disabled**」误判成「无反馈」✗
//   （开发管理 的保存就是禁用的 —— 这**比弹提示更好** ✓）
//
// ── ★★ 提交按钮文案**各页不同**，必须**显式列出**（别猜）─────────
//   实测：报价管理是「创建报价单」· 采购管理是「创建采购单」· 开发管理是「保存」✗
//   ⇒ 宽松正则（`保存|提交|创建`）会**匹配到列表行** ⇒ 点错元素 ⇒ 假失败 ✗
//   ⇒ 本脚本**逐页显式写死**，找不到时**明确报错**（而不是退回猜测）✓
//
// 截图：/tmp/acceptance-form-validation/*.png
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const OUT_DIR = '/tmp/acceptance-form-validation';
const PW = 'Bambook@2026';

/** [侧栏文案, 创建入口文案, **提交按钮文案（实测取得，不猜）**] */
const TARGETS = [
  ['订单管理', '录入订单', '确认创建'],
  ['报价管理', '新建报价单', '创建报价单'],
  ['开发管理', '新建开发单', '保存'],
  ['采购管理', '新建采购单', '创建采购单'],
  ['客户关系管理', '新建商机', '保存'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (n, d = '') => { results.push({ n, ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ n, ok: false }); console.log(`  ✗ ${n} — ${d}`); };
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
const page = await ctx.newPage();
let pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 120)));

const mainText = () => page.evaluate(() => (document.querySelector('.app-main-viewport')?.innerText || '').replace(/\s+/g, ' ').trim());
/**
 * ★★ 校验提示必须读**整个文档**，不能只读主区（实测踩过，第三次判错）：
 *   CRM 的「保存」空提交后，应用弹了一个 **全局 toast「请填写商机标题和金额」** ✓，
 *   而它**渲染在 `.app-main-viewport` 之外** ✗ ⇒ 只读主区的判据**漏掉它** ✗
 *   ⇒ 误报「无任何反馈」✗（**看截图才发现 toast 就在屏幕顶部** ✓）
 */
const fullText = () => page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());
const hasFormChrome = (t) => /保存|提交|取消|确定|确认|创建|下一步|完成/.test(t);
const VALIDATION_RE = /必填|请输入|不能为空|请选择|请填写|至少|不得|无效|格式|required|请先/;

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

  for (const [label, openText, submitText] of TARGETS) {
    const nav = page.locator('[data-sidebar-nav-item]', { hasText: label }).first();
    if ((await nav.count()) === 0) { console.log(`  ⚠️  [gap] ${label}：侧栏无入口`); continue; }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
    await nav.click({ force: true, timeout: 10000 }).catch(() => {});
    let before = ''; let stable = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const now = await mainText();
      if (now === before && now.length > 30) { stable += 1; if (stable >= 2) break; } else stable = 0;
      before = now;
    }
    if (before.length <= 30) { fail(`${label}：页面未渲染`, `${before.length} 字`); continue; }

    pageErrors = [];
    const opener = page.locator(`text=${openText}`).first();
    if ((await opener.count()) === 0) { fail(`${label} · 「${openText}」`, '找不到入口'); continue; }
    await opener.click({ force: true, timeout: 8000 }).catch(() => {});
    await sleep(3000);
    const formText = await mainText();
    if (!hasFormChrome(formText)) { fail(`${label}：表单未打开`, `${formText.length} 字`); continue; }

    // ★ 找提交按钮（**精确文案**）并先看 disabled
    const submitInfo = await page.evaluate((st) => {
      const main = document.querySelector('.app-main-viewport');
      const b = Array.from(main.querySelectorAll('button, [role="button"]'))
        .find((e) => (e.innerText || '').replace(/\s+/g, ' ').trim() === st);
      if (!b) return null;
      return { disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true' };
    }, submitText);
    if (!submitInfo) { fail(`${label}：找不到提交按钮「${submitText}」`, '（文案变了 ⇒ 请更新本脚本的显式列表）'); continue; }

    if (submitInfo.disabled) {
      pass(`${label}：必填未填时「${submitText}」**被禁用** ✓`, '（比弹提示更好的设计：用户点不了）');
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(600);
      continue;
    }

    const submitBtn = page.locator('.app-main-viewport button, .app-main-viewport [role="button"]')
      .filter({ hasText: new RegExp(`^\\s*${submitText}\\s*$`) }).last();
    pageErrors = [];
    await submitBtn.click({ force: true, timeout: 8000 }).catch(() => {});
    await sleep(3000);
    const afterText = await mainText();
    const afterFull = await fullText();   // ★ 含全局 toast
    const shot = `${OUT_DIR}/${label}-空提交.png`;
    await page.screenshot({ path: shot }).catch(() => {});

    const errNow = pageErrors.slice();
    if (errNow.length > 0) {
      fail(`${label}：空提交**崩溃**`, `pageerror：${errNow[0]} —— 截图 ${shot}`);
    } else if (!hasFormChrome(afterText)) {
      fail(`${label}：空提交后**离开了表单**`, `疑似静默成功（必填未校验）· ${afterText.slice(0, 80)} —— 截图 ${shot}`);
    } else if (VALIDATION_RE.test(afterFull)) {
      const m = afterFull.match(VALIDATION_RE);
      const i = m ? afterFull.indexOf(m[0]) : 0;
      pass(`${label}：空提交被拦 + 有提示`, `命中「${afterFull.slice(Math.max(0, i - 10), i + 18)}」`);
    } else {
      fail(`${label}：空提交后仍在表单，但**无任何反馈**`, `用户点了「${submitText}」不知道哪里错 · 截图 ${shot}`);
    }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(800);
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n结果：${ok}/${results.length} 通过`);
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
