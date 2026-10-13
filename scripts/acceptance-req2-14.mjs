// REQ2-14 海运费变动利润重估 API 级实机验收
// 验收锚点（需求池 / 设计文档 §7）：
//   ① X-04：运费涨 3 倍录入后受影响订单利润变化一屏可见
//   ② 重估口径与利润表同源（multiplier=1 重估 == 落库利润表值）
const BASE = 'http://127.0.0.1:8081';
// ★ 2026-09-17 修：原用 raymond.lin（无 orders:write ⇒ 403）
//   建订单是**销售主管**的真实场景 ⇒ 换 vivian.chen
const EMAIL = 'vivian.chen@bambook.local';
const PASSWORD = 'Bambook@2026';

const results = [];
let token = '';
function pass(name, detail = '') { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); }

async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const login = await loginRes.json();
  if (!loginRes.ok || !login.token) { console.log('登录失败', loginRes.status); process.exit(1); }
  token = login.token;
  console.log(`登录成功：${login.user?.displayName ?? EMAIL}`);

  // ── 1 空库基线（无受影响或既有数据） ──
  const base = await api('GET', '/api/v1/pricing/freight-impact?multiplier=3');
  const baseCount = base.data?.summary?.affectedOrders ?? 0;
  console.log(`\n当前受影响订单基线：${baseCount} 单`);

  // ── 2 构造测试数据：带运费运单的订单 ──
  const today = new Date().toISOString().slice(0, 10);
  const PO = `PO-FRT-${Date.now() % 100000}`;
  const createdOrder = await api('POST', '/api/v1/orders', {
    poNumber: PO, customer: 'REQ2-14 验收客户', product: '运费重估测试面料', type: 'Fabric',
    quantity: 1000, dueDate: '2026-12-31', quoteAmount: 72000, status: 'Confirmed',
    millName: '验收测试染厂',
  });
  const orderId = createdOrder.data?.order?.id || createdOrder.data?.id;
  if (!orderId) { console.log('订单创建失败', createdOrder.status, JSON.stringify(createdOrder.data).slice(0, 200)); process.exit(1); }
  console.log(`测试订单：${orderId}`);

  // 发票（收入 72000 CNY）
  const inv = await api('POST', '/api/v1/finance', {
    invoiceNumber: `INV-FRT-${Date.now() % 100000}`, type: 'Receivable', amount: 72000, currency: 'CNY',
    issueDate: today, orderId, customerName: 'REQ2-14 验收客户', status: 'Issued',
  });
  // 运单（运费 3000 CNY；shippingMethod schema 必填）
  const sh = await api('POST', '/api/v1/shipping', {
    orderId, shippingMethod: 'Sea Freight', type: 'Sea', status: 'Booked',
    freightAmount: 3000, freightCurrency: 'CNY',
    etd: today, eta: '2026-10-01',
  });
  console.log(`发票 ${inv.status} / 运单 ${sh.status}`);
  if (sh.status >= 400) {
    fail('运单创建', `${sh.status} ${JSON.stringify(sh.data)?.slice(0, 200)}`);
  }

  // 生成利润表（baseline 落库）
  const gen = await api('POST', `/api/v1/pricing/profit-sheets/generate/${encodeURIComponent(orderId)}`);
  const sheet = gen.data?.item;
  if (gen.status === 200 && sheet) {
    pass(`利润表生成：利润 ${sheet.grossProfit} CNY · 运费 ${sheet.freightCost} CNY（口径含运单费用）`);
  } else fail('利润表生成', `status=${gen.status} ${JSON.stringify(gen.data)?.slice(0, 160)}`);

  // ── 3 X-04 锚点：×3 重估 ──
  console.log('\n── ×3 重估 ──');
  {
    const r = await api('GET', `/api/v1/pricing/freight-impact?multiplier=3&orderId=${encodeURIComponent(orderId)}`);
    const item = (r.data?.items || []).find(x => x.orderId === orderId);
    if (r.status === 200 && item) {
      pass(`受影响清单命中测试订单：baseline ${item.baseline.grossProfit} → ${item.reestimated.grossProfit}（Δ ${item.deltaProfit}）`);
      // delta = −2×原运费（涨 3 倍 = 多付 2 倍）
      const expectedDelta = -2 * Number(sheet.freightCost);
      if (Math.abs(item.deltaProfit - expectedDelta) < 0.01) {
        pass(`delta = −2×原运费（${expectedDelta}）：运费涨 3 倍口径精确`);
      } else fail('delta 口径', `got ${item.deltaProfit} expected ${expectedDelta}`);
      if (item.baseline.source === 'persisted') pass('baseline 取已落库利润表（用户认过的口径）');
      else fail('baseline 来源', item.baseline.source);
    } else fail('×3 重估', `status=${r.status} items=${(r.data?.items || []).length}`);
  }

  // ── 4 同真源锚点：multiplier=1 重估 == 落库值 ──
  console.log('\n── 同真源锚点 ──');
  {
    const r = await api('GET', `/api/v1/pricing/freight-impact?multiplier=1&orderId=${encodeURIComponent(orderId)}`);
    const item = (r.data?.items || []).find(x => x.orderId === orderId);
    if (r.status === 200 && item && Math.abs(item.reestimated.grossProfit - Number(sheet.grossProfit)) < 0.01) {
      pass('multiplier=1 重估 == 利润表落库值（生成与重估同真源）');
    } else fail('同真源', `重估 ${item?.reestimated.grossProfit} vs 落库 ${sheet?.grossProfit}`);
  }

  // ── 5 边界 ──
  {
    const bad0 = await api('GET', '/api/v1/pricing/freight-impact?multiplier=0');
    if (bad0.status === 400) pass('multiplier=0 → 400');
    else fail('multiplier=0', `status=${bad0.status}`);
    const bad101 = await api('GET', '/api/v1/pricing/freight-impact?multiplier=101');
    if (bad101.status === 400) pass('multiplier=101 → 400');
    else fail('multiplier=101', `status=${bad101.status}`);
    const badAbc = await api('GET', '/api/v1/pricing/freight-impact?multiplier=abc');
    if (badAbc.status === 400) pass('非数 multiplier → 400');
    else fail('非数校验', `status=${badAbc.status}`);
  }

  // ── 清理 ──
  await api('DELETE', `/api/v1/orders/${encodeURIComponent(orderId)}`);
  console.log('\n清理：测试订单已软删（发票随订单软删级联口径以域规则为准）');

  const failed = results.filter(r => !r.ok);
  console.log(`\n═══ REQ2-14 验收结果：${results.length - failed.length}/${results.length} 通过 ═══`);
  if (failed.length) { console.log('失败项：'); failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
