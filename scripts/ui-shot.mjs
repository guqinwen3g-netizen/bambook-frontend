// 本地 UI 渲染截图：node scripts/ui-shot.mjs <navLabel> <outPng> [width] [height] [theme]
// 依赖本地 dev 栈（3000 前端 + 8081 后端）；凭据读环境变量 BAMBOOK_SHOT_USER / BAMBOOK_SHOT_PASS。
import { chromium } from 'playwright';

const [label = '订单', out = 'shot.png', w = '1440', h = '900'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
// 开发环境：经 dev panel 一键登录（/api/dev/accounts/:id/login），取 owner 级活跃账号
const api = 'http://localhost:8081/api/dev';
const { accounts } = await (await fetch(`${api}/accounts`)).json();
const pick = accounts.find(a => a.status === 'active' && a.roles.some(r => /owner|管理员|老板|admin/i.test(r))) || accounts.find(a => a.status === 'active');
const login = await (await fetch(`${api}/accounts/${pick.id}/login`, { method: 'POST' })).json();
await page.evaluate(({ token, user }) => {
  localStorage.setItem('bambook_auth_token', token);
  localStorage.setItem('bambook_auth_user', JSON.stringify(user));
}, login);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
if (process.env.SHOT_THEME === 'dark') await page.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.theme = 'dark'; });
if (label !== '-') {
  const nav = page.getByRole('button', { name: label, exact: false }).first();
  if (await nav.count()) await nav.click();
  else await page.getByText(label, { exact: true }).first().click();
  await page.waitForTimeout(3000);
}
for (const step of (process.env.SHOT_STEPS || '').split('|').filter(Boolean)) {
  if (step.startsWith('css:')) await page.locator(step.slice(4)).first().click();
  else await page.getByText(step, { exact: false }).first().click();
  await page.waitForTimeout(2500);
}
await page.screenshot({ path: out });
await browser.close();
