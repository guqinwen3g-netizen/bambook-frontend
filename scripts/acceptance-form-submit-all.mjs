// 「表单真实提交」**配置驱动骨架**（2026-09-17）—— 一个文件覆盖多条写路径
//
// ── 为什么合并 ─────────────────────────────────────────────
// 一页一个脚本不可持续 ✗。本骨架把每条写路径抽成**一条配置** ✓：
//   { 页面, 创建入口, 必填字段[label,值][], 列表API, 列表字段名, 回滚模型, 校验字段 }
// ⇒ **以后加一条写路径 = 加一条配置** ✓（不用再写脚本 ✗）
//
// ── 每条配置做的事（统一）──────────────────────────────────
//   ① 打开创建表单 → ② 填必填 → ③ 断言「提交按钮已启用」→ ④ 提交
//   → ⑤ **API 回读验证落库**（不信 UI 自述 ✗）→ ⑥ 校验落库字段
//   → ⑦ 回滚（含联动副作用 EntityLink/EntityReference/AuditLog）→ ⑧ **独立复核零残留**
//
// ── ★★ 纪律（本仓约定 + 今晚血的教训）──────────────────────
//   · 字段 label / 按钮文案 **必须实测取得**，**不许猜** ✗
//     （今晚因猜 label 判错 4 次：`金额`→实为`预计金额` · `保存`→实为`确认创建` …）
//   · **跑完必须看一张截图** ✓ —— 截图是**证伪我自己判据**的唯一手段 ✓
//   · 演练数据用**明显假标识**（`DRILL` 前缀）· **零残留复核** ✓
//   · `createRequire` 以 `server/` 为基准解析 `@prisma/client` ✓（否则静默失败、真库留残留 ✗）
//
// 用法：node scripts/acceptance-form-submit-all.mjs            # 全部
//       node scripts/acceptance-form-submit-all.mjs --only=crm # 单条
// 截图：/tmp/acceptance-form-submit-all/
import { chromium } from 'playwright';
import { SERVER_DIR, REPO_ROOT, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const OUT_DIR = '/tmp/acceptance-form-submit-all';
const PW = 'Bambook@2026';
const TS = Date.now().toString().slice(-7);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (n, d = '') => { results.push({ n, ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ n, ok: false }); console.log(`  ✗ ${n} — ${d}`); };
fs.mkdirSync(OUT_DIR, { recursive: true });

// ★ prisma 必须以 server/ 为基准解析
const req = createRequire(SERVER_DIR + '/');
loadEnvForScript(REPO_ROOT); // env 的唯一装载口：取不到就抛，不借别的 worktree
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient();

/**
 * ★ 写路径配置表 —— 加一条就是加一条配置 ✓
 * 字段 label 全部**实测取得**（见各条注释里的来源）✓
 */
const TARGETS = [
  {
    key: 'crm',
    page: '客户关系管理',
    open: '新建商机',
    // 来源：空提交的 toast「请填写商机标题和金额」+ 截图实测 label
    fields: [['商机标题', `DRILL-UI-商机-${TS}`], ['预计金额', '123456']],
    listApi: '/api/v2/crm/opportunities',
    listKey: 'opportunities',
    model: 'opportunity',
    /** 落库校验：[字段名, 期望值] */
    expect: [['title', `DRILL-UI-商机-${TS}`]],
    residue: { title: { contains: 'DRILL-UI-商机' } },
  },
  {
    key: 'dev',
    page: '开发管理',
    open: '新建开发单',
    // 来源：截图实测 label「编号*」「名称*」
    fields: [['编号', `DRILLDEV${TS}`], ['名称', 'DRILL-UI-开发单']],
    listApi: '/api/v1/development?limit=500',
    listKey: 'cases',
    model: 'developmentCase',
    expect: [['code', `DRILLDEV${TS}`], ['name', 'DRILL-UI-开发单']],
    residue: { code: { startsWith: 'DRILLDEV' } },
  },
  {
    key: 'po',
    page: '采购管理',
    open: '新建采购单',
    /** ★ 提交按钮文案**各页不同** ⇒ 可配（默认「保存」）✗ */
    submit: '创建采购单',
    // 来源：探针实测必填 label「采购单号 *」「下单日期 *」（下单日期已预填今天 ✓）
    fields: [['采购单号', `DRILLPO${TS}`]],
    /**
     * ★ **明细行**（2026-09-17 新增能力）
     *   实测：明细行字段用 **`placeholder`** 定位（**不是 `label`** ✗）
     *   例：采购单行内 `品名描述 *` / `数量 *` / `单价 *`（placeholder 里带星号 ✓）
     *   · 本表单**默认已有「行 1」** ⇒ 不需要点「+ 添加行」✓
     *   · 上一版**没填明细行** ⇒ 应用正确拦住并提示「至少需要一行有效采购明细」✓
     *     （**那不是缺陷** ✓ —— 是**我的配置不全** ✗；见提交历史 `fe0c974`）
     */
    lines: { fields: [['品名描述', 'DRILL-UI-面料'], ['数量', '100'], ['单价', '12.5']] },
    listApi: '/api/v1/procurement',
    listKey: 'items',
    model: 'purchaseOrder',
    expect: [['poNumber', `DRILLPO${TS}`]],
    residue: { poNumber: { startsWith: 'DRILLPO' } },
  },
  // ── ★ 明确**不纳入**的页面（硬塞进来只会得到"看起来绿但没测到东西"的假象 ✗）──
  //
  // ★ 「采购单」**已纳入**（骨架新增了明细行能力 ✓ 见上面的 po 配置）
  //
  // { key: 'quote', page: '报价管理', open: '新建报价单',
  //   ✗ **21 个字段 + 需要报价明细行**（toast：「至少需要一行有效报价明细」）✗
  // }
  //
  // { key: 'order', page: '订单管理', open: '录入订单', submit: '确认创建',
  //   ✗ 必填含「客户 (Customer)*」「供应商 (Supplier)*」—— 是**选择器**不是文本框 ✗
  //     ⇒ 需要 picker-aware 的填法（点开下拉 → 选项 → 选中）✗
  //     （参考 `acceptance-r7-shipment-order-picker.mjs` 的 picker 处理方式 ✓）
  // }
  //
  // ★ **下一步能力**（本骨架的升级方向）：
  //   ① **明细行支持**：点「+ 添加行」→ 填行内 label → 断言合计变化（覆盖 采购单/报价单 ✓）
  //   ② **picker 支持**：点开下拉 → 选项 → 选中（覆盖 订单的客户/供应商 ✓）
  //   —— 在没做这两项之前，**不要**把它们塞进来 ✗（会得到"看起来绿但没测到东西"的假象 ✗）
];

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const queue = TARGETS.filter((t) => !only || t.key === only);

const browser = await chromium.launch({ headless: true });

async function runTarget(t, loginToken) {
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  let pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 120)));
  const fullText = () => page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());
  const setByLabel = (labelPrefix, value) => page.evaluate(({ labelPrefix, value }) => {
    const lab = Array.from(document.querySelectorAll('label'))
      .find((l) => (l.textContent || '').trim().startsWith(labelPrefix));
    const el = lab?.querySelector('input, textarea') ?? lab?.parentElement?.querySelector('input, textarea');
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, { labelPrefix, value });

  /** 按 **placeholder** 填（★ 明细行字段用 placeholder 定位，不是 label ✗） */
  const setByPlaceholder = (phPrefix, value) => page.evaluate(({ phPrefix, value }) => {
    const el = Array.from(document.querySelectorAll('input, textarea'))
      .filter((e) => e.offsetParent !== null)
      .find((e) => (e.getAttribute('placeholder') || '').trim().startsWith(phPrefix));
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, { phPrefix, value });

  /**
   * ★ **选择器（picker）填法** —— 2026-09-17 新增能力
   *
   * 实测结构（「录入订单」的 客户/供应商）：
   *   `<label>客户 (Customer)*</label>` 的**父容器** `DIV.space-y-1.5` 里
   *   有一个 **typeahead `INPUT`** + 一个 `BUTTON[aria-label="Toggle dropdown"]` ✓
   *   ⇒ **控件在 `label` 之外** ✗（所以 `setByLabel` 找不到 ✗）
   *
   * 填法：① 定位 label → 取**父容器** → ② 填其中的 input（触发 typeahead）
   *       → ③ 等下拉出现 ⇒ **点第一个选项**；没出现 ⇒ **回车**兜底 ✓
   * ⚠️ 兜底链是刻意的：不同 picker 的"确认"方式不同（点选项 / 回车 / 失焦）✗
   *    但**必须看截图确认真的选上了** ✓（否则会得到"填了但没生效"的假绿 ✗）
   */
  const setPickerByLabel = async (labelText, value) => {
    const filled = await page.evaluate(({ labelText, value }) => {
      const lab = Array.from(document.querySelectorAll('label'))
        .find((l) => (l.textContent || '').includes(labelText));
      const box = lab?.parentElement;
      const input = box?.querySelector('input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return true;
    }, { labelText, value });
    if (!filled) return false;
    await sleep(1500);
    // 优先点第一个选项（各库的 option 角色不一，取并集 ✓）
    const opt = page.locator('[role="option"], [role="listbox"] li, [role="listbox"] [role="option"], ul li[role="button"]').first();
    if ((await opt.count()) > 0) {
      await opt.click({ force: true }).catch(() => {});
      await sleep(600);
      return true;
    }
    await page.keyboard.press('Enter').catch(() => {});   // 兜底
    await sleep(600);
    return true;
  };

  const api = async (path) => {
    const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${loginToken}` } });
    return { status: r.status, data: await r.json().catch(() => null) };
  };

  let createdId = null;
  console.log(`\n════ ${t.key} · ${t.page}「${t.open}」════`);
  try {
    const before = await api(t.listApi);
    const beforeIds = new Set((before.data?.[t.listKey] ?? []).map((x) => x.id));
    console.log(`  基线：${beforeIds.size} 条`);

    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('input[type="text"]', { timeout: 25000 });
    await page.fill('input[type="text"]', 'jason.shen@bambook.local');
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
    await sleep(1500);

    await page.locator('[data-sidebar-nav-item]', { hasText: t.page }).first().click({ force: true });
    let t0 = ''; let stable = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const now = await fullText();
      if (now === t0 && now.length > 30) { stable += 1; if (stable >= 2) break; } else stable = 0;
      t0 = now;
    }
    pass(`${t.key} 进入页面`, `${t0.length} 字`);

    pageErrors = [];
    const opener = page.locator(`text=${t.open}`).first();
    if ((await opener.count()) === 0) { fail(`${t.key} 找不到入口「${t.open}」`); return; }
    await opener.click({ force: true, timeout: 8000 });
    await sleep(2500);
    await page.screenshot({ path: `${OUT_DIR}/${t.key}-01-form.png` });

    for (const [lab, val] of t.fields) {
      const ok = await setByLabel(lab, val);
      if (!ok) fail(`${t.key} 字段「${lab}」定位失败`, '（label 文案可能变了 ⇒ 看 01-form.png 修正）');
    }
    // ★ 选择器字段（picker）：控件在 label 之外 ⇒ 用专门填法 ✓
    for (const [lab, val] of (t.pickers ?? [])) {
      const ok = await setPickerByLabel(lab, val);
      if (!ok) fail(`${t.key} 选择器「${lab}」定位失败`, '（结构变了 ⇒ 看 01-form.png 修正）');
    }
    await sleep(400);
    // ★ 明细行（可选）：点「+ 添加行」（若配置了 addButton）→ 按 placeholder 填行内字段
    if (t.lines) {
      if (t.lines.addButton) {
        await page.locator(`text=${t.lines.addButton}`).first().click({ force: true }).catch(() => {});
        await sleep(800);
      }
      for (const [ph, val] of t.lines.fields) {
        const ok = await setByPlaceholder(ph, val);
        if (!ok) fail(`${t.key} 明细行字段「${ph}」定位失败`, '（placeholder 文案变了 ⇒ 看截图修正）');
      }
      await sleep(600);
      const bodyAfterLines = await fullText();
      // 阳性对照：行填了之后「合计」不应还是 0（证明行真的生效 ✓）
      if (/合计\s*0\.00/.test(bodyAfterLines)) {
        fail(`${t.key} 填了明细行但**合计仍为 0**`, '⇒ 行没生效（或合计不刷新）');
      } else {
        pass(`${t.key} 明细行已生效（合计不再是 0）✓`);
      }
    }
    await page.screenshot({ path: `${OUT_DIR}/${t.key}-02-filled.png` });

    // ★ 提交按钮文案**各页不同** ⇒ 可配（默认「保存」）
    //   实测：采购单「创建采购单」· 订单「确认创建」· 开发单「保存」
    const submitText = t.submit ?? '保存';
    const submitRe = new RegExp(`^\\s*${submitText}\\s*$`);
    const saveBtn = page.locator('.app-main-viewport button, .app-main-viewport [role="button"]')
      .filter({ hasText: submitRe }).last();
    if ((await saveBtn.count()) === 0) { fail(`${t.key} 找不到提交按钮「${submitText}」`, '（文案变了 ⇒ 改配置里的 submit）'); return; }
    if (await saveBtn.evaluate((e) => e.disabled === true)) {
      fail(`${t.key} 填了必填后「${submitText}」**仍禁用**`, '⇒ 必填判据与提示不一致');
      return;
    }
    pass(`${t.key} 填完必填后「${submitText}」已启用 ✓`);

    pageErrors = [];
    await saveBtn.click({ force: true, timeout: 8000 });
    await sleep(3500);
    await page.screenshot({ path: `${OUT_DIR}/${t.key}-03-after-save.png` });
    if (pageErrors.length) fail(`${t.key} 提交触发 pageerror`, pageErrors[0]);

    const after = await api(t.listApi);
    const items = after.data?.[t.listKey] ?? [];
    const created = items.find((x) => !beforeIds.has(x.id));
    if (!created) { fail(`${t.key} ★ 提交后**未落库**`, `共 ${items.length} 条`); return; }
    createdId = created.id;
    pass(`${t.key} ★ 提交后**确实落库** ✓`, `id=${created.id}`);
    for (const [f, want] of t.expect) {
      if (String(created[f] ?? '') === String(want)) pass(`${t.key} 落库字段「${f}」正确`, String(created[f]));
      else fail(`${t.key} 落库字段「${f}」`, `期望「${want}」got「${created[f]}」`);
    }
    const txt = await fullText();
    if (t.expect.some(([, v]) => txt.includes(String(v)))) pass(`${t.key} 列表已刷新 ✓`);
    else console.log(`  ⚠️  [gap] ${t.key} 列表未显示新记录（可能需手动刷新）`);
  } catch (e) {
    fail(`${t.key} 脚本异常`, String(e).slice(0, 200));
  } finally {
    try {
      if (createdId) {
        const link = await prisma.entityLink.deleteMany({ where: { OR: [{ fromId: createdId }, { toId: createdId }] } });
        const ref = await prisma.entityReference.deleteMany({ where: { OR: [{ ownerId: createdId }, { targetId: createdId }] } });
        const audit = await prisma.auditLog.deleteMany({ where: { targetId: createdId } });
        const del = await prisma[t.model].deleteMany({ where: { id: createdId } });
        console.log(`  清理：link=${link.count} ref=${ref.count} audit=${audit.count} ${t.model}=${del.count}`);
        if (del.count !== 1) fail(`${t.key} 回滚`, `未删掉（count=${del.count}）`);
        else pass(`${t.key} 回滚：已删 ✓`);
      }
      const residue = await prisma[t.model].count({ where: t.residue });
      if (residue === 0) pass(`${t.key} 回滚：独立复核零残留 ✓`);
      else fail(`${t.key} 回滚：独立复核`, `残留 ${residue} 条`);
    } catch (e) {
      fail(`${t.key} 回滚异常`, String(e).slice(0, 160));
    }
    await ctx.close();
  }
}

try {
  const lg = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jason.shen@bambook.local', password: PW }),
  })).json();
  if (!lg.token) throw new Error('登录失败');
  console.log(`跑 ${queue.length} 条写路径（配置驱动 · 每条：填→提交→API回读→回滚→复核）`);
  for (const t of queue) await runTarget(t, lg.token);
} catch (e) {
  fail('脚本异常', String(e).slice(0, 200));
} finally {
  await prisma.$disconnect().catch(() => {});
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n═══ 结果：${ok}/${results.length} 通过 ═══`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log('失败项：\n  - ' + failed.map((r) => r.n).join('\n  - '));
  console.log(`截图：${OUT_DIR}（**跑完请至少看一张** ✓ —— 截图是证伪自己判据的唯一手段）`);
  await browser.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}
