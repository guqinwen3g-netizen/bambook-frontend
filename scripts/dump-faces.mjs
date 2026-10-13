// dump-faces.mjs —— 把某一屏的"面清单"完整打出来（供人逐条读）
//
// 用法：node scripts/dump-faces.mjs [屏面名] [baseUrl]
// 例：  node scripts/dump-faces.mjs 财务管理
import { chromium } from 'playwright';
import fs from 'node:fs';

const TARGET = process.argv[2] || '财务管理';
const BASE = process.argv[3] || 'http://127.0.0.1:3100';
const EMAIL = process.env.CRAWL_EMAIL || 'jason.shen@bambook.local';
const PASSWORD = process.env.BAMBOOK_DEMO_PASSWORD || 'Bambook@2026';

const DUMP_FN = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const norm = (s) => (s || '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 50);
  const sig = (el) => {
    const p = el.parentElement, g = p?.parentElement;
    const one = (x) => x ? x.tagName + (x.className ? '.' + String(x.className).split(/\s+/)[0].slice(0, 18) : '') : '';
    return one(g) + '>' + one(p);
  };
  const cand = [...document.querySelectorAll('button,a[href],[role="button"],[role="tab"],[role="menuitem"],[aria-haspopup],div,span,li')]
    .filter((el) => {
      if (!vis(el)) return false;
      const cs = getComputedStyle(el);
      if (cs.cursor !== 'pointer' && el.tagName !== 'BUTTON' && el.tagName !== 'A') return false;
      const t = (el.innerText || '').trim();
      return t.length > 0 && t.length < 40 && el.children.length <= 3;
    });
  const seen = new Map();
  for (const el of cand) {
    const key = el.tagName + '|' + norm(el.innerText) + '|' + sig(el);
    if (!seen.has(key)) seen.set(key, { tag: el.tagName, text: norm(el.innerText), parent: sig(el) });
  }
  return { raw: cand.length, faces: [...seen.values()] };
};

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('button, input', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const eb = page.locator('input[type="email"],input[name="email"],input[placeholder*="邮箱" i]').first();
  if (await eb.count()) {
    await eb.fill(EMAIL).catch(() => {});
    const pw = page.locator('input[type="password"]').first();
    if (await pw.count()) await pw.fill(PASSWORD).catch(() => {});
    const btn = page.locator('button[type="submit"],button:has-text("登录")').first();
    if (await btn.count()) await btn.click().catch(() => {}); else await pw.press('Enter').catch(() => {});
    await page.waitForTimeout(5000);
  }
  const ok = !(await page.locator('input[type="password"]').count());
  console.log(`登录${ok ? '成功' : '★失败（读数不可信）'}`);
  await page.locator(`text="${TARGET}"`).first().click({ timeout: 8000 });
  await page.waitForTimeout(3000);
  const r = await page.evaluate(DUMP_FN);
  console.log(`【${TARGET}】原始可点 ${r.raw} → 去重后面 ${r.faces.length}\n`);
  r.faces.forEach((f, i) => console.log(`${String(i + 1).padStart(4)}. [${f.tag}] ${f.text}    «${f.parent}»`));
  fs.writeFileSync(`/tmp/faces-${TARGET}.json`, JSON.stringify(r, null, 2));
  console.log(`\n输出：/tmp/faces-${TARGET}.json`);
} catch (e) {
  console.log('失败：', String(e.message).slice(0, 200));
} finally { await browser.close(); }
