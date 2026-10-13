// H16 发货通知（Shipping Advice）—— 真库验收（只读，不建数据）
//
// 验的口径不变量：
//   R1 客户侧 `GET /shipments` 返回 **Shipping Advice 必备字段**（三单号 + 毛净重体积 + 订舱号）
//   R2 四种单据可下载且是真 PDF：CI / PL / **BL（提单）** / **AWB（空运单）**
//      —— H16 新增 bl/awb（提单是给买方的物权凭证）
//   R3 归属隔离：A 客户下载 **B 客户**的运单单据 → 404（不区分「不存在」与「不属于你」）
//   R4 未登录 → 401
//
// ⚠️ 已知遗留（非本批引入，已登记）：CI/PL/BL/AWB 走**运单维度**归属判定
//    （`shipmentBelongsToCustomer`：运单内任一订单属我就放行），而 `assembleDocumentSetData`
//    取整张运单的 shipmentLine —— **拼柜（一票运单含多客户订单）时可能带出他客户订单行**。
//    见 `server/src/customer/route.ts:9-12` 自记（handoff 6k，**业务口径待拍板**）。
//    本批新增的 bl/awb **继承同一风险**（未扩大、也未修复）。
//
// 用法：node scripts/acceptance-h16-shipping-advice.mjs
const BASE = 'http://127.0.0.1:8081';
const CUSTOMER_PASSWORD = 'Customer@123';
const CUST_A = 'sakurabrandskk@portal.demo';   // SIM-CUS-03
const CUST_B = 'nordicapparelgmbh@portal.demo'; // SIM-CUS-02

const results = [];
function pass(name, detail = '') { results.push({ ok: true }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ ok: false }); console.log(`  ✗ ${name} — ${detail}`); }
function info(name, detail = '') { results.push({ ok: null }); console.log(`  ⓘ ${name} — ${detail}`); }

async function customerLogin(email) {
  const res = await fetch(`${BASE}/api/v2/customer/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: CUSTOMER_PASSWORD }),
  });
  const data = await res.json().catch(() => null);
  return res.ok && data?.token ? data.token : null;
}

async function api(token, path) {
  const res = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/pdf')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, isPdf: buf.slice(0, 5).toString() === '%PDF-', size: buf.length, contentType: ct };
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data, contentType: ct };
}

async function main() {
  console.log('══ H16 发货通知（Shipping Advice）· 真库验收 ══\n');

  const tokenA = await customerLogin(CUST_A);
  const tokenB = await customerLogin(CUST_B);
  if (!tokenA) { fail('客户 A 登录', CUST_A); return exit(); }
  pass('客户 A 登录', CUST_A);
  if (tokenB) pass('客户 B 登录', CUST_B);
  else info('客户 B 登录失败', '归属隔离用例将跳过');

  // ── R1 发货通知必备字段 ──
  const list = await api(tokenA, '/api/v2/customer/shipments');
  if (list.status !== 200 || !Array.isArray(list.data?.items)) {
    fail('R1 GET /shipments', `HTTP ${list.status}`);
    return exit();
  }
  const items = list.data.items;
  pass('R1 运单列表', `${items.length} 张`);
  const REQUIRED = ['billOfLadingNo', 'masterBillNo', 'houseBillNo', 'grossWeight', 'netWeight', 'volume', 'bookingNo', 'soNumber'];
  const sample = items[0];
  const missing = REQUIRED.filter(k => !(k in sample));
  if (missing.length === 0) {
    pass('R1 Shipping Advice 必备字段齐全', REQUIRED.join(' / '));
    info('R1 样本取值', REQUIRED.map(k => `${k}=${sample[k] ?? 'null'}`).join(' '));
  } else {
    fail('R1 缺字段', missing.join(', '));
  }

  // ── R2 四种单据可下载且是真 PDF ──
  const sid = sample.id;
  for (const [kind, label] of [['ci', '商业发票'], ['pl', '装箱单'], ['bl', '提单'], ['awb', '空运单']]) {
    const r = await api(tokenA, `/api/v2/customer/documents/${kind}/${encodeURIComponent(sid)}.pdf`);
    if (r.status === 200 && r.isPdf) pass(`R2 ${kind}（${label}）可下载`, `${Math.round(r.size / 1024)} KB`);
    else fail(`R2 ${kind}（${label}）`, `HTTP ${r.status} isPdf=${r.isPdf}`);
  }

  // ── R3 归属隔离：A 客户下载 B 客户的运单 → 404 ──
  if (tokenB) {
    const bList = await api(tokenB, '/api/v2/customer/shipments');
    const bItems = bList.data?.items ?? [];
    const bIds = new Set(bItems.map(x => x.id));
    const notMine = items.find(x => !bIds.has(x.id));
    if (!notMine) {
      info('R3 未覆盖', '两个客户的运单集合无差集（演练数据可能重叠）');
    } else {
      const r = await api(tokenB, `/api/v2/customer/documents/ci/${encodeURIComponent(notMine.id)}.pdf`);
      if (r.status === 404) pass('R3 归属隔离：B 下载 A 的运单 → 404', notMine.shipmentNumber ?? notMine.id);
      else fail('R3 归属隔离', `期望 404，实际 ${r.status}`);
      const r2 = await api(tokenB, `/api/v2/customer/documents/bl/${encodeURIComponent(notMine.id)}.pdf`);
      if (r2.status === 404) pass('R3 归属隔离（提单同口径）→ 404');
      else fail('R3 归属隔离（提单）', `期望 404，实际 ${r2.status}`);
    }
  }

  // ── R4 未登录 → 401 ──
  const anon = await api(null, `/api/v2/customer/documents/ci/${encodeURIComponent(sid)}.pdf`);
  if (anon.status === 401) pass('R4 未登录 → 401');
  else fail('R4 未登录', `期望 401，实际 ${anon.status}`);

  console.log('');
  info('已知遗留', 'CI/PL/BL/AWB 走运单维度归属判定，拼柜时可能带出他客户订单行（route.ts:9-12 自记，口径待拍板；本批 bl/awb 继承同一风险）');
  exit();

  function exit() {
    const ok = results.filter(r => r.ok === true).length;
    const bad = results.filter(r => r.ok === false).length;
    const notes = results.filter(r => r.ok === null).length;
    console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
    process.exit(bad === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error('脚本异常', e); process.exit(2); });
