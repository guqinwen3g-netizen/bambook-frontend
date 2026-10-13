// crawl-dom-faces.mjs —— DOM 面数（**去重后**）：把"可点元素"收敛成"不同的操作面"
//
// 为什么要这一版：第三刀（crawl-dom-structure.mjs）探到 ~17,076 个可点元素，
// 但**那不等于"面"** —— 表格里每行每格都 `cursor:pointer`，同一模板会重复成百上千次。
// 本版按 **(标签 + 归一化文本 + 父链签名)** 去重，并**分桶**：
//   · `faceKeys`   = 去重后的"不同操作面"（这才是面数）
//   · `rawCount`   = 原始可点元素数（对照用，证明去重前后的差）
//
// ★ 登录用**三重兜底**（上次探针登录失败导致抽样作废）：表单填 → 回车 → 直接注入 token。
//
// 用法：node scripts/crawl-dom-faces.mjs [baseUrl] [outJson] [maxScreens]
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const OUT = process.argv[3] || '/tmp/dom-faces.json';
const MAX = Number(process.argv[4] || 32);
const EMAIL = process.env.CRAWL_EMAIL || 'jason.shen@bambook.local';
const PASSWORD = process.env.BAMBOOK_DEMO_PASSWORD || 'Bambook@2026';

/** ★ 去重式面清单：每个"面"给一个 key = 标签 + 归一化文本 + 父链签名（剥掉行号/数字） */
const FACES_FN = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const norm = (s) => (s || '')
    .replace(/\d+/g, '#')          // 数字归一（行号/金额/日期都变 #）
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  const sig = (el) => {
    const parts = [];
    let p = el.parentElement, d = 0;
    while (p && d < 3) { parts.push(p.tagName + (p.className ? '.' + String(p.className).split(/\s+/)[0] : '')); p = p.parentElement; d++; }
    return parts.join('>');
  };
  /**
   * ★★ 2026-09-29 修正（第 4 次口径错的修法）：**"面" = 动作，不是数据单元格**。
   *
   * 上一版把表格数据行里的可点单元格也算成"面" ⇒ 财务管理的 1,187 个里 **88% 是数据行**
   * （`TEST-C#WO-PAY-*` 这种），数据越多数越大 ⇒ **它测的是数据量，不是操作面数**。
   *
   * 本版加两道闸：
   *   ① **排除落在表格/数据行里的元素**（`closest('table')` 或父链含 `data-row`/`rdl-data`）；
   *   ② **排除单字符文本**（那是被切碎的标签片段，不是动作）。
   * ★ 剩下的才是"用户在这一屏能做的动作"。
   */
  const inDataRow = (el) => {
    if (el.closest('table')) return true;
    let p = el.parentElement, d = 0;
    while (p && d < 6) {
      const cn = String(p.className || '');
      if (/data-row|rdl-data|tbody|data-grid/i.test(cn)) return true;
      p = p.parentElement; d++;
    }
    return false;
  };
  const cand = [...document.querySelectorAll('button,a[href],[role="button"],[role="tab"],[role="menuitem"],[aria-haspopup],div,span,li')]
    .filter((el) => {
      if (!vis(el)) return false;
      const cs = getComputedStyle(el);
      if (cs.cursor !== 'pointer' && el.tagName !== 'BUTTON' && el.tagName !== 'A') return false;
      const t = (el.innerText || '').trim();
      if (t.length < 2 || t.length >= 40) return false;   // ① 单字符不算
      if (el.children.length > 3) return false;
      if (inDataRow(el)) return false;                    // ② 数据行不算
      return true;
    });
  const keys = new Set();
  const buckets = { nativeButton: 0, anchor: 0, roleAttr: 0, clickableDiv: 0 };
  for (const el of cand) {
    const key = el.tagName + '|' + norm(el.innerText) + '|' + sig(el);
    keys.add(key);
    if (el.tagName === 'BUTTON') buckets.nativeButton++;
    else if (el.tagName === 'A') buckets.anchor++;
    else if (el.getAttribute('role') || el.getAttribute('aria-haspopup')) buckets.roleAttr++;
    else buckets.clickableDiv++;
  }
  return { rawCount: cand.length, faceCount: keys.size, buckets, sampleKeys: [...keys].slice(0, 8) };
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const out = { base: BASE, screens: [] };

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('button, input', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // ★ 三重兜底登录
  let logged = false;
  const eb = page.locator('input[type="email"],input[name="email"],input[placeholder*="邮箱" i],input[placeholder*="姓名" i]').first();
  if (await eb.count()) {
    await eb.fill(EMAIL).catch(() => {});
    const pw = page.locator('input[type="password"]').first();
    if (await pw.count()) await pw.fill(PASSWORD).catch(() => {});
    const btn = page.locator('button[type="submit"],button:has-text("登录")').first();
    if (await btn.count()) await btn.click().catch(() => {});
    else await pw.press('Enter').catch(() => {});
    await page.waitForTimeout(5000);
    logged = !(await page.locator('input[type="password"]').count());
  }
  console.log(`登录${logged ? '成功' : '★失败（读数将不可信）'}`);
  if (!logged) { out.loginFailed = true; }

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
    const r = await page.evaluate(FACES_FN);
    out.screens.push({ nav: t, ...r });
    console.log(`  [${t}] 原始 ${r.rawCount} → **去重 ${r.faceCount}**（按钮 ${r.buckets.nativeButton} / 链接 ${r.buckets.anchor} / role ${r.buckets.roleAttr} / 可点div ${r.buckets.clickableDiv}）`);
  }
} catch (e) {
  out.fatal = String(e.message);
  console.log('致命错误：', String(e.message).slice(0, 200));
} finally {
  const raw = out.screens.reduce((s, x) => s + x.rawCount, 0);
  const faces = out.screens.reduce((s, x) => s + x.faceCount, 0);
  out.totals = { screens: out.screens.length, rawClickables: raw, dedupedFaces: faces, compression: raw ? +(faces / raw).toFixed(3) : null };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n══ ${out.totals.screens} 屏 · 原始可点 ${raw} → **去重后面 ${faces}**（压缩比 ${out.totals.compression}）══`);
  if (out.loginFailed) console.log('★★ 警告：本次登录失败 ⇒ 这些读数**不可信**，不要拿去用');
  console.log(`输出：${OUT}`);
  await browser.close();
}
