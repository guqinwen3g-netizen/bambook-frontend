// 并行验收脚本：4 个独立浏览器 context = 4 个独立登录态 = 4 个账号，各扫一组页面。
// 仅只读导航 + 采集客观信号（标题/文本长度/占位符/console 错误/网络 4xx 5xx），不改任何数据。
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const PASSWORD = 'Bambook@2026';

const AGENTS = [
  { name: 'A-经营总览+平台', email: 'raymond.lin@bambook.local', pages: ['全景看板', '经营驾驶舱', '报表中心', 'AI 助手', '数据中心', '人事管理', '业务工具', '管理后台', '设置'] },
  { name: 'B-客户与市场', email: 'chloe.su@bambook.local', pages: ['关系智库', '客户关系管理', '供应商管理', '智能邮箱', '季节性与趋势', '营销推广'] },
  { name: 'C-订单履约', email: 'vivian.chen@bambook.local', pages: ['数字档案', '开发管理', '报价管理', '订单管理', '生产跟单', '采购管理', '库存管理', 'QC 工作台', '货运管理', '外贸与报关', '单据中心', '生产执行 MES'] },
  { name: 'D-财务与成本', email: 'melissa.zhao@bambook.local', pages: ['财务管理', '定价与利润', 'BOM 成本核算', '风险管理与合规', '发票管理'] },
];

const HARD_PH = /TODO|占位|敬请期待|coming soon|开发中|待开发|建设中|placeholder|lorem ipsum|no data/i;
const SOFT_PH = /undefined|NaN|\bnull\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runAgent(browser, agent) {
  const ctx = await browser.newContext({ viewport: { width: 1460, height: 920 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 220)); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 220)));
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 140)}`); });

  const out = { agent: agent.name, email: agent.email, login: 'pending', pages: [] };
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('input[type="text"]', { timeout: 25000 });
    await page.fill('input[type="text"]', agent.email);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-sidebar-nav-item], [data-sidebar-collapsed-expand-button]', { timeout: 30000 });
    out.login = 'ok';

    const expand = page.locator('[data-sidebar-collapsed-expand-button]');
    if (await expand.count()) {
      await expand.first().click().catch(() => {});
      await sleep(700);
    }

    for (const label of agent.pages) {
      const cStart = consoleErrors.length;
      const fStart = failedRequests.length;
      const r = { label, status: 'unknown', title: '', textLen: 0, hardPh: [], softPh: [] };
      const item = page.locator('[data-sidebar-nav-item]', { hasText: label }).first();
      try {
        await item.waitFor({ state: 'visible', timeout: 3000 });
      } catch {
        r.status = 'no-nav-item';
        out.pages.push(r);
        continue;
      }
      try {
        await item.click();
        await sleep(2000);
        r.title = ((await page.locator('h1.ph-title').first().textContent().catch(() => '')) || '').trim();
        const body = ((await page.locator('body').innerText().catch(() => '')) || '');
        r.textLen = body.length;
        r.hardPh = [...new Set((body.match(HARD_PH) || []).map((s) => s.trim()))];
        r.softPh = [...new Set((body.match(SOFT_PH) || []).map((s) => s.trim()))];
        r.consoleErrors = consoleErrors.slice(cStart);
        r.failedRequests = failedRequests.slice(fStart);
        r.status = r.textLen > 80 ? 'ok' : 'lean';
      } catch (e) {
        r.status = 'error';
        r.error = String(e).slice(0, 180);
      }
      out.pages.push(r);
    }
  } catch (e) {
    out.login = 'FAILED: ' + String(e).slice(0, 260);
  }
  await ctx.close();
  return out;
}

const browser = await chromium.launch({ headless: true });
const results = await Promise.all(AGENTS.map((a) => runAgent(browser, a)));
await browser.close();
console.log(JSON.stringify(results, null, 2));