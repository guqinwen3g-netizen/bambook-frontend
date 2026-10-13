// R7（2026-09-15）UI 级实机验收：运单表单「关联订单」字段
// 验收锚点：
//   ① 运单页「新建运单」表单出现「关联订单」输入框（此前缺失 → 运单页新建的运单永远无订单锚）
//   ② 聚焦即出候选；输入 PO/客户可搜索；点选后回显 PO 号并自动带出客户名
//   ③ 保存后列表/详情可见订单锚（订单 xxx），且后端确实落库 orderId
//   ④ 演练数据清理（删除本次创建的运单）
// 截图证据：/tmp/acceptance-r7-picker/*.png
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local';
const PASSWORD = 'Bambook@2026';
const OUT_DIR = '/tmp/acceptance-r7-picker';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (name, detail = '') => { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); };
const fail = (name, detail = '') => { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); };
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── node 侧 API：登录 + 选宿主订单 + 清理 ──
const loginRes = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const login = await loginRes.json();
if (!login.token) { console.log('登录失败', loginRes.status, login); process.exit(1); }
const apiFetch = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const v2 = await apiFetch('GET', '/api/v2/orders?limit=500');
const orders = v2.data?.items || [];
if (orders.length === 0) { console.log('jason.shen v2 无可见订单，无法验收'); process.exit(1); }
const target = orders.find(o => (o.poNumber || '').trim()) ?? orders[0];
const PO = (target.poNumber || '').trim() || target.id.slice(-8);
console.log(`宿主订单：${PO}（客户 ${target.customer}）`);

// 取运单 ID 快照用于保存后 diff 找到新单（不依赖前端 shipmentNumber 注入）
const beforeList = await apiFetch('GET', '/api/v1/shipping?limit=500');
const beforeIds = new Set(((beforeList.data?.items || beforeList.data?.shipments) || []).map(s => s.id));
console.log(`运单基线：${beforeIds.size} 单`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));

let createdShipmentId = null;

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('input[type="text"]', { timeout: 25000 });
  await page.fill('input[type="text"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
  pass('登录', EMAIL);

  // ── 进入运单页 ──
  const nav = page.locator('[data-sidebar-nav-item]', { hasText: '出运' }).first();
  await nav.click({ timeout: 10000 }).catch(async () => {
    await page.locator('[data-sidebar-nav-item]', { hasText: '货运' }).first().click({ timeout: 10000 });
  });
  await sleep(2500);
  await page.screenshot({ path: `${OUT_DIR}/01-shipment-list.png` });

  // ── 打开新建运单 ──
  const createBtn = page.locator('button', { hasText: '新建运单' }).first();
  await createBtn.waitFor({ state: 'visible', timeout: 15000 });
  await createBtn.click({ timeout: 8000 });
  await sleep(1200);

  const picker = page.locator('input[aria-label="关联订单"]');
  if ((await picker.count()) === 0) { fail('① 表单出现「关联订单」字段'); throw new Error('picker missing'); }
  pass('① 新建运单表单出现「关联订单」输入框', 'aria-label=关联订单');
  await page.screenshot({ path: `${OUT_DIR}/02-form-open.png` });

  // ── 聚焦出候选 ──
  await picker.click({ timeout: 5000 });
  await sleep(1500);
  const optionBtns = page.locator('div.absolute.z-30 button');
  const optionCount = await optionBtns.count();
  await page.screenshot({ path: `${OUT_DIR}/03-dropdown-default.png` });
  if (optionCount > 0) pass('② 聚焦即出候选订单（默认一页）', `${optionCount} 条`);
  else fail('② 聚焦出候选', 'dropdown 无选项');

  // ── 搜索 ──
  await picker.fill(PO);
  await sleep(1600); // 防抖 300ms + 请求
  const searchCount = await page.locator('div.absolute.z-30 button').count();
  await page.screenshot({ path: `${OUT_DIR}/04-dropdown-search.png` });
  const firstLabel = searchCount > 0 ? (await page.locator('div.absolute.z-30 button').first().innerText()).split('\n')[0] : '';
  if (searchCount > 0 && firstLabel.includes(PO)) pass('② 按 PO 搜索命中目标订单', firstLabel);
  else fail('② 按 PO 搜索', `count=${searchCount} first=${firstLabel}`);

  // ── 点选 ──
  await page.locator('div.absolute.z-30 button').first().click({ timeout: 5000 });
  await sleep(600);
  const pickedValue = await picker.inputValue();
  if (pickedValue && pickedValue.includes(PO)) pass('③ 点选后回显 PO 号（非裸 id）', pickedValue);
  else fail('③ 点选回显', `value=${pickedValue}`);

  // 客户自动带出（按 label 锚定到其后的 input，避免外层 wrapper 误匹配）
  const customerValue = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label'));
    const lab = labels.find(l => (l.textContent || '').trim().startsWith('客户'));
    const input = lab?.parentElement?.querySelector('input');
    return input?.value ?? '';
  });
  if (customerValue && target.customer && customerValue.includes(target.customer.slice(0, 3))) {
    pass('③ 选单自动带出客户名', customerValue);
  } else {
    fail('③ 自动带出客户名', `got="${customerValue}" expect≈"${target.customer}"`);
  }
  await page.screenshot({ path: `${OUT_DIR}/05-picked.png` });

  // ── 填运单号并保存（label 锚定，避开 placeholder 在其它输入框可能的撞库） ──
  const shipNo = `R7UI-${Date.now() % 100000}`;
  await page.evaluate((v) => {
    const lab = Array.from(document.querySelectorAll('label')).find(l => (l.textContent || '').trim().startsWith('运单号'));
    const input = lab?.parentElement?.querySelector('input');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, shipNo);
  await sleep(300);
  await page.screenshot({ path: `${OUT_DIR}/06-filled.png` });

  const saveBtn = page.locator('button', { hasText: '保存' }).first();
  await saveBtn.click({ timeout: 8000 });
  await sleep(3500); // 等两连 toast + 拉装运行
  await page.screenshot({ path: `${OUT_DIR}/07-after-save.png` });

  // ── 回读：后端 diff 找到新运单并验证 orderId ──
  const afterList = await apiFetch('GET', '/api/v1/shipping?limit=500');
  const afterItems = (afterList.data?.items || afterList.data?.shipments) || [];
  const created = afterItems.find(s => !beforeIds.has(s.id));
  if (created) {
    createdShipmentId = created.id;
    if (created.orderId === target.id) pass('④ 后端落库 orderId 与所选订单一致', created.orderId);
    else fail('④ 后端落库 orderId', `got=${created.orderId} expect=${target.id}`);
  } else {
    fail('④ 新建运单落库（diff）', 'after 中无新单');
  }

  // ── 回读：UI 列表显示订单锚（行内「订单 orderId」文本，orderId ≠ PO） ──
  const orderAnchorText = `订单 ${target.id}`;
  const rowText = await page.locator(`text=${orderAnchorText}`).first().locator('xpath=ancestor::button[1]').innerText().catch(() => '');
  if (/\bR7UI-/.test(rowText) || (created && rowText.includes((created.shipmentNumber || '').slice(0, 8)))) {
    pass('④ 列表行可见订单锚', rowText.replace(/\n/g, ' | ').slice(0, 120));
  } else {
    fail('④ 列表行订单锚', rowText.replace(/\n/g, ' | ').slice(0, 120));
  }
  await page.screenshot({ path: `${OUT_DIR}/08-detail.png` });

  // ── 编辑态可改（非身份字段）：重开编辑，字段可输入 ──
  const editBtn = page.locator('button', { hasText: '编辑' }).first();
  if ((await editBtn.count()) > 0) {
    await editBtn.click({ timeout: 8000 });
    await sleep(1200);
    const editPicker = page.locator('input[aria-label="关联订单"]');
    const disabled = await editPicker.isDisabled().catch(() => true);
    const editValue = await editPicker.inputValue().catch(() => '');
    if (!disabled) pass('⑤ 编辑态可改关联订单（后端 PATCH 白名单收 orderId）', `回显=${editValue}`);
    else fail('⑤ 编辑态可改', `disabled=${disabled}`);
    await page.screenshot({ path: `${OUT_DIR}/09-edit-mode.png` });
    await page.keyboard.press('Escape').catch(() => {});
  } else {
    fail('⑤ 编辑入口', '未找到编辑按钮');
  }
} catch (e) {
  fail('脚本异常', String(e).slice(0, 300));
  await page.screenshot({ path: `${OUT_DIR}/99-error.png` }).catch(() => {});
} finally {
  // ── 清理演练数据 ──
  if (createdShipmentId) {
    const del = await apiFetch('DELETE', `/api/v1/shipping/${createdShipmentId}`);
    if (del.status < 300) console.log(`  清理：已删除演练运单 ${createdShipmentId}`);
    else console.log(`  ⚠ 清理失败 ${del.status}，需手动删除 ${createdShipmentId}`);
  }
  console.log(`\n控制台错误 ${consoleErrors.length} 条 / 页面异常 ${pageErrors.length} 条`);
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 5).join('\n'));
  if (pageErrors.length) console.log(pageErrors.slice(0, 5).join('\n'));
  const ok = results.filter(r => r.ok).length;
  console.log(`\n结果：${ok}/${results.length} 通过`);
  await browser.close();
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
