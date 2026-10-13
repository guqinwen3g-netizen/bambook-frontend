// 深度交互验收 v2：逐页枚举可交互元素 + 安全点开弹层回读字段 + 切换视图标签 + 捕获报错。
// 只做「打开→回读→关闭」类非破坏性操作；不提交表单、不触发删除/确认/保存等写动作。
//
// v2 改进：
//   - 5 个账号均衡覆盖全部 32 个模块（最大单 agent 9 页）
//   - 实时进度：每页完成即追加 JSONL 到 /tmp/acceptance-deep-pages.jsonl + stderr 打印一行
//   - 单页硬超时 45s、单 agent 硬超时 8min，杜绝单点卡死拖垮整体
//   - 精简 sleep/click 超时，缩短整体时长
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:3000';
const PASSWORD = 'Bambook@2026';
const PAGES_LOG = '/tmp/acceptance-deep-pages.jsonl';
const PAGE_TIMEOUT_MS = 45000;
const AGENT_TIMEOUT_MS = 8 * 60 * 1000;

const AGENTS = [
  { name: 'A-经营总览+平台', email: 'raymond.lin@bambook.local', pages: ['全景看板', '经营驾驶舱', '报表中心', 'AI 助手', '数据中心', '人事管理', '业务工具', '管理后台', '设置'] },
  { name: 'B-客户与市场', email: 'chloe.su@bambook.local', pages: ['关系智库', '客户关系管理', '供应商管理', '智能邮箱', '季节性与趋势', '营销推广'] },
  { name: 'C1-订单履约A', email: 'vivian.chen@bambook.local', pages: ['数字档案', '开发管理', '报价管理', '订单管理', '生产跟单', '采购管理'] },
  { name: 'C2-订单履约B', email: 'vivian.chen@bambook.local', pages: ['库存管理', 'QC 工作台', '货运管理', '外贸与报关', '单据中心', '生产执行 MES'] },
  { name: 'D-财务与成本', email: 'melissa.zhao@bambook.local', pages: ['财务管理', '定价与利润', 'BOM 成本核算', '风险管理与合规', '发票管理'] },
];

// 打开语义（点开弹层/抽屉/新视图）——非写操作
const OPEN_RE = /新建|添加|新增|创建|导入|导出|查看|详情|展开|更多|设置|配置|上传|下载|刷新|同步|打印|预览|生成|计算|风控|扫描|检查|筛选|团队|搜索|模板|分享|收藏|历史|日志|明细|规则|门禁|汇率|退税率|佣金/;
// 破坏性/写语义——一律不点
const SKIP_RE = /删除|作废|确认|提交|保存|通过|驳回|拒绝|核销|冻结|解冻|取消订单|撤回|停用|禁用|归档|发布|上架|下架|同意|指派|分配|委派|转交|继续|下一步|发送|支付|收款|退款|收款|申报/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('TIMEOUT ' + label)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

const texts = async (loc) => {
  try {
    const arr = await loc.all();
    const out = [];
    for (const el of arr) {
      const t = ((await el.innerText().catch(() => '')) || '').trim();
      if (t) out.push(t.replace(/\s+/g, ' ').slice(0, 40));
    }
    return [...new Set(out)].slice(0, 60);
  } catch {
    return [];
  }
};

async function closeModal(page) {
  try { await page.keyboard.press('Escape'); await sleep(200); } catch {}
  for (const t of ['取消', '关闭', 'Cancel', 'Close']) {
    try {
      const b = page.locator(`.bds-modal button:has-text("${t}")`).first();
      if ((await b.count()) && (await b.isVisible().catch(() => false))) { await b.click({ timeout: 1000 }); await sleep(150); break; }
    } catch {}
  }
  try {
    const mask = page.locator('.bds-modal-mask').first();
    if ((await mask.count()) && (await mask.isVisible().catch(() => false))) {
      await mask.click({ position: { x: 5, y: 5 }, timeout: 1000 });
      await sleep(150);
    }
  } catch {}
}

async function switchTabs(page, locs) {
  const seen = new Set();
  const results = [];
  for (const el of locs) {
    const t = ((await el.innerText().catch(() => '')) || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    try {
      await el.click({ timeout: 1000 });
      await sleep(300);
      const bodyLen = (await page.locator('body').innerText().catch(() => '')).length;
      results.push(`${t}→${bodyLen}`);
    } catch {}
    if (results.length >= 10) break;
  }
  return results;
}

// 扫描单个页面：导航、枚举元素、切 tab、点开「打开语义」按钮并回读弹层
async function scanPage(page, r) {
  await r.item.click({ timeout: 5000 });
  await sleep(1200);
  r.title = ((await page.locator('h1.ph-title').first().textContent().catch(() => '')) || '').trim().replace(/\n/g, ' ');

  r.buttons = await texts(page.locator('button:visible'));
  r.placeholders = [];
  for (const el of await page.locator('input:visible, textarea:visible').all()) {
    const ph = (await el.getAttribute('placeholder').catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || (await el.getAttribute('name').catch(() => '')) || '';
    if (ph) r.placeholders.push(ph.slice(0, 40));
  }
  r.placeholders = [...new Set(r.placeholders)].slice(0, 40);
  r.tabs = await texts(page.locator('[role="tab"]:visible, [aria-pressed]:visible'));
  if (!r.tabs.length) r.tabs = await texts(page.locator('.bds-segment button:visible, .seg:visible'));

  const tabLocs = await page.locator('[role="tab"]:visible, [aria-pressed]:visible, .bds-segment button:visible').all();
  r.viewsSwitched = await switchTabs(page, tabLocs);

  const btns = await page.locator('button:visible').all();
  let clicked = 0;
  for (const b of btns) {
    if (clicked >= 10) break;
    const t = ((await b.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (SKIP_RE.test(t)) { if (t.length <= 16) r.unsafeButtons.push(t.slice(0, 20)); continue; }
    if (!OPEN_RE.test(t)) continue;
    clicked++;
    const before = await page.locator('[role="dialog"]:visible, .bds-modal:visible').count().catch(() => 0);
    const clickedOk = await b.click({ timeout: 1500 }).then(() => true).catch(() => false);
    if (!clickedOk) continue;
    await sleep(450);
    const after = await page.locator('[role="dialog"]:visible, .bds-modal:visible').count().catch(() => 0);
    if (after > before) {
      r.dialogsOpened++;
      const dlgText = ((await page.locator('[role="dialog"]:visible, .bds-modal:visible').last().innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
      r.safeOpened.push({ button: t.slice(0, 24), opened: true, preview: dlgText.slice(0, 80) });
      await closeModal(page);
    } else {
      r.safeOpened.push({ button: t.slice(0, 24), opened: false });
    }
  }
}

function emitPage(agent, r) {
  fs.appendFileSync(PAGES_LOG, JSON.stringify({ agent: agent.name, email: agent.email, ...r }) + '\n');
  const errCount = (r.consoleErrors?.length ?? 0) + (r.pageErrors?.length ?? 0);
  console.error(`[${agent.name}] ${r.label} | nav=${r.nav} btn=${r.buttons?.length ?? 0} dlg=${r.dialogsOpened ?? 0} tab=${r.tabs?.length ?? 0} err=${errCount} req=${r.failedRequests?.length ?? 0}${r.timeout ? ' TIMEOUT' : ''}`);
}

async function runAgent(browser, agent) {
  const ctx = await browser.newContext({ viewport: { width: 1460, height: 920 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 120)}`); });

  const out = { agent: agent.name, email: agent.email, login: 'pending', pageCount: agent.pages.length, completed: 0 };
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('input[type="text"]', { timeout: 25000 });
    await page.fill('input[type="text"]', agent.email);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
    out.login = 'ok';

    for (const label of agent.pages) {
      const errStart = consoleErrors.length;
      const pageErrStart = pageErrors.length;
      const reqStart = failedRequests.length;
      const r = { label, nav: 'ok', buttons: [], placeholders: [], safeOpened: [], unsafeButtons: [], tabs: [], viewsSwitched: [], dialogsOpened: 0 };
      const item = page.locator('[data-sidebar-nav-item]', { hasText: label }).first();
      try { await item.waitFor({ state: 'visible', timeout: 3000 }); } catch { r.nav = 'no-nav-item'; emitPage(agent, r); out.completed++; continue; }
      r.item = item;
      try {
        await withTimeout(scanPage(page, r), PAGE_TIMEOUT_MS, label);
      } catch (e) {
        const msg = String(e).slice(0, 160);
        if (msg.startsWith('TIMEOUT')) r.timeout = true;
        else r.error = msg;
        // 兜底关掉可能残留的弹层，避免影响下一页
        await closeModal(page);
      }
      delete r.item;
      r.consoleErrors = [...new Set(consoleErrors.slice(errStart))];
      r.pageErrors = [...new Set(pageErrors.slice(pageErrStart))];
      r.failedRequests = [...new Set(failedRequests.slice(reqStart))];
      out.completed++;
      emitPage(agent, r);
    }
  } catch (e) {
    out.login = 'FAILED: ' + String(e).slice(0, 200);
  }
  await ctx.close();
  return out;
}

fs.writeFileSync(PAGES_LOG, '');
const browser = await chromium.launch({ headless: true });
const settled = await Promise.allSettled(AGENTS.map((a) => withTimeout(runAgent(browser, a), AGENT_TIMEOUT_MS, a.name)));
await browser.close();

const results = settled.map((s, i) => {
  if (s.status === 'fulfilled') return s.value;
  return { agent: AGENTS[i].name, email: AGENTS[i].email, login: 'AGENT_ERROR: ' + String(s.reason).slice(0, 120), pageCount: AGENTS[i].pages.length, completed: 0 };
});
console.log(JSON.stringify(results, null, 2));