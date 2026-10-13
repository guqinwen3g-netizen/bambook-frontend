#!/usr/bin/env node
/**
 * 验收截图：浅色/深色 × 1440/1180/390。需要 playwright（`npm i -D playwright && npx playwright install chromium`）。
 *
 * 参考应用：
 *   node scripts/mist-shots.mjs ref development,orders/detail
 * 真实 App（先 npm run dev:web 并在该浏览器配置下已登录，或使用开发者免登录模式）：
 *   node scripts/mist-shots.mjs http://localhost:5173 orders
 *     → 真实 App 通过 localStorage.theme_preference 切换主题，通过 ?view= 不一定生效时请手动导航后用 --wait 截图
 *
 * 输出：mist-shots/<view>-<theme>-<width>.png；控制台错误会打印出来（必须为空）。
 * 可选环境变量：CHROMIUM=/path/to/chromium  WIDTHS=1440,1180,390  THEMES=light,dark
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [target = 'ref', viewsArg = 'cockpit'] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const base = target === 'ref' ? 'file://' + path.join(root, 'dev-ui-preview/mist-atelier/bambook-mist-atelier-reference.html') : target.replace(/\/$/, '');
const widths = (process.env.WIDTHS || '1440,1180,390').split(',').map(Number);
const themes = (process.env.THEMES || 'light,dark').split(',');
const out = path.join(process.cwd(), 'mist-shots');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
for (const w of widths) {
  const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${page.url()} ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${page.url()} ${m.text()}`); });
  for (const theme of themes) for (const v of viewsArg.split(',')) {
    const [view, id] = v.split(':');
    if (target === 'ref') {
      await page.goto(`${base}?intro=0&view=${view}&theme=${theme}${id ? '&id=' + id : ''}`);
    } else {
      await page.goto(base);
      await page.evaluate(t => localStorage.setItem('theme_preference', t), theme);
      await page.goto(`${base}/?view=${view}`);
    }
    await page.waitForTimeout(1200);
    const file = path.join(out, `${view.replace(/\//g, '_')}-${theme}-${w}.png`);
    await page.screenshot({ path: file });
    console.log('✓', path.relative(process.cwd(), file));
  }
  await ctx.close();
}
await browser.close();
if (errors.length) { console.log('\n控制台错误：\n' + errors.join('\n')); process.exit(1); }
console.log('\n无控制台错误'); process.exit(0);
