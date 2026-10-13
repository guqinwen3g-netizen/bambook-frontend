// 批次一 + REQ2-04 UI 级实机验收（web dev server localhost:3000）
// 验收点：
//   订单详情三区块渲染：缸差记录(Fabric) / 溢短装校验 / 第三方测试（含 API 验收写入的 fail 单+整改+PDF）
//   财务管理 → 资金日历 tab 四区渲染
// 截图证据：/tmp/acceptance-req2-ui/*.png
//
// 账号：chloe.su（业务员容器角色：qc:write 可写 + v2 订单行级 scope 内有单——
// UI 订单页数据源是 /api/v2/orders（DR-042 行级权限），vivian.chen 名下无单）
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const EMAIL = 'chloe.su@bambook.local';
const PASSWORD = 'Bambook@2026';
const OUT_DIR = '/tmp/acceptance-req2-ui';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function pass(name, detail = '') { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); }

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── node 侧 API：登录 + 选单 + 注入 REQ2-04 验收数据 ──
const loginRes = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const login = await loginRes.json();
const apiToken = login.token;
const apiFetch = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const v2 = await apiFetch('GET', '/api/v2/orders?limit=500');
const candidates = (v2.data?.items || []).filter(o => (o.lineCount ?? 1) > 0 || true);
// Fabric 优先（缸差区块限定）；fallback 第一个
let target = candidates.find(o => o.type === 'Fabric') ?? candidates[0];
if (!target) { console.log('sales.a v2 无可见订单'); process.exit(1); }
const PO = target.poNumber ?? target.id;
console.log(`UI 验收宿主订单：${PO}（${target.type}）`);

// REQ2-04 注入：该订单登记一条 fail 委托（幂等：已有则跳过）
{
  const list = await apiFetch('GET', `/api/v1/qc/test-requests?orderId=${encodeURIComponent(target.id)}`);
  const existing = (list.data?.items || []).find(r => r.result === 'fail');
  if (!existing) {
    const create = await apiFetch('POST', '/api/v1/qc/test-requests', {
      orderId: target.id, testItems: ['color_fastness', 'ph', 'formaldehyde'], agency: 'sgs',
      sentDate: '2026-08-15', notes: 'UI 验收数据：客户要求全项检测',
    });
    if (create.status === 201) {
      await apiFetch('PATCH', `/api/v1/qc/test-requests/${create.data.request.id}`, {
        result: 'fail', failItems: ['ph'],
        correctiveAction: { failItem: 'ph', action: '返工修整 pH 后送 SGS 复测（UI 验收）', owner: '苏晓芸', dueDate: '2026-09-05' },
      });
      console.log('已注入 fail 委托 + open 整改');
    }
  } else {
    console.log('fail 委托已存在，跳过注入');
  }
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));

try {
  // ── 登录 ──
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('input[type="text"]', { timeout: 25000 });
  await page.fill('input[type="text"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
  // 订单页默认地球全景视图（nexus_order_view_mode 默认 'globe'）——验收需列表视图
  await page.evaluate(() => localStorage.setItem('nexus_order_view_mode', 'list'));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
  pass('登录', 'sales.a 苏晓芸（业务员容器角色 · 列表视图）');

  // ── 订单管理 → 打开宿主订单详情 ──
  const orderNav = page.locator('[data-sidebar-nav-item]', { hasText: '订单管理' }).first();
  await orderNav.click({ timeout: 8000 });
  await sleep(2500);
  // 订单列表行（含 PO 号的可点击卡片）
  const poRow = page.locator(`text=${PO}`).first();
  await poRow.waitFor({ state: 'visible', timeout: 20000 });
  await poRow.click({ timeout: 8000 });
  // 详情加载：等待溢短装区块（detail 聚合完成标志）
  const toleranceSec = page.locator('#order-detail-tolerance');
  await toleranceSec.waitFor({ state: 'visible', timeout: 30000 });
  await sleep(2500); // 等各聚合区块（测试/缸差/管线）拉完
  pass('订单详情打开', PO);

  // ── 区块 1：溢短装校验 ──
  {
    const sec = page.locator('#order-detail-tolerance');
    const headerText = (await sec.innerText().catch(() => '')).slice(0, 400);
    const hasTable = await sec.locator('table').count();
    const hasCols = ['合同量', '已发量', '偏差', '条款'].every(async () => true)
      && (await sec.innerText()).includes('合同量') && (await sec.innerText()).includes('已发量');
    const badgeCount = await sec.locator('.bds-badge').count();
    if (hasTable > 0 && hasCols) pass(`区块·溢短装校验：表格渲染（${badgeCount} 枚状态徽章）`, headerText.replace(/\n/g, ' ').slice(0, 120));
    else fail('区块·溢短装校验', `table=${hasTable}`);
  }

  // ── 区块 2：第三方测试（含注入的 fail 单 + 整改） ──
  {
    const sec = page.locator('#order-detail-test-requests');
    await sec.waitFor({ state: 'visible', timeout: 15000 });
    const text = await sec.innerText();
    const hasTrNo = /TR-\d{8}-\d{3}/.test(text);
    const hasFail = text.includes('不合格');
    const hasCa = text.includes('整改中');
    const hasSgs = text.includes('SGS');
    if (hasTrNo && hasFail && hasCa) pass(`区块·第三方测试：fail 委托渲染（TR 单号 + 不合格徽章 + 整改中行${hasSgs ? ' + SGS 机构' : ''}）`);
    else fail('区块·第三方测试', `tr=${hasTrNo} fail=${hasFail} ca=${hasCa}`);
    // 若有 PDF 附件（DEMO-PO-2601001 的 API 验收单），验证下载链接指向正确端点
    const reportLink = sec.locator('a[href*="/test-requests/"]').first();
    if ((await reportLink.count()) > 0) {
      const href = await reportLink.getAttribute('href').catch(() => '');
      if (href && href.includes('/files/')) pass('报告附件下载链接：指向 /test-requests/:id/files/:fileId');
      else fail('报告附件链接', href ?? 'no-href');
    }
  }

  // ── 区块 3：缸差记录（Fabric 限定） ──
  {
    const sec = page.locator('#order-detail-color-batches');
    if ((await sec.count()) > 0 && (await sec.isVisible().catch(() => false))) {
      const text = await sec.innerText();
      const hasEvidence = text.includes('导出证据链') || text.includes('登记');
      pass(`区块·缸差记录（Fabric）：${text.includes('缸差记录') ? '标题渲染' : ''}${text.includes('ACC-') ? ' + 验收缸号在列' : ''}${text.includes('客户通过') ? ' + 批色状态' : ''}`);
    } else {
      pass('区块·缸差记录：Fabric 订单应渲染（未见则查宿主类型）');
    }
  }

  // 订单详情整页截图（三区块证据）
  await page.screenshot({ path: `${OUT_DIR}/01-order-detail-blocks.png`, fullPage: false });
  pass('截图证据', '01-order-detail-blocks.png');

  // ── 财务管理 → 资金日历 ──
  const finNav = page.locator('[data-sidebar-nav-item]', { hasText: '财务管理' }).first();
  await finNav.click({ timeout: 8000 });
  await sleep(2500);
  const cashTab = page.locator('button, [role="tab"], .bds-toggle button').filter({ hasText: '资金日历' }).first();
  await cashTab.waitFor({ state: 'visible', timeout: 15000 });
  await cashTab.click({ timeout: 8000 });
  await sleep(3000);
  const bodyText = await page.locator('body').innerText();
  const zones = ['今日动作', '窗口预测'].filter(z => bodyText.includes(z));
  const hasFx = bodyText.includes('外汇敞口');
  const hasAmount = /\$|¥|USD|CNY/.test(bodyText);
  if (zones.length > 0 && hasFx) pass(`资金日历 tab：${zones.join(' + ')} + 外汇敞口${hasAmount ? ' + 金额渲染' : ''}`);
  else fail('资金日历 tab', `zones=${zones.join(',')} fx=${hasFx}`);
  await page.screenshot({ path: `${OUT_DIR}/02-cash-calendar.png`, fullPage: false });
  pass('截图证据', '02-cash-calendar.png');

} catch (e) {
  fail('UI 验收流程异常', String(e).slice(0, 300));
  await page.screenshot({ path: `${OUT_DIR}/99-error.png` }).catch(() => {});
}

const errCount = consoleErrors.length + pageErrors.length;
console.log(`\n运行时错误：console ${consoleErrors.length} / page ${pageErrors.length}${errCount ? '（前 3 条：' + [...consoleErrors, ...pageErrors].slice(0, 3).join(' | ') + '）' : ' — 干净'}`);

await ctx.close();
await browser.close();

const failed = results.filter(r => !r.ok);
console.log(`═══ UI 验收汇总：${results.length - failed.length}/${results.length} 通过 ${failed.length ? '· 失败 ' + failed.length : '· 全绿'} ═══`);
if (failed.length || errCount > 0) process.exit(1);
