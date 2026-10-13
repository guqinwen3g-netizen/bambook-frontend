#!/usr/bin/env node
// 数据联通演练：用真实 API 走完整流程，把「骨架在、血没通」的库打通。
// 目的有二：① 产出真联通的数据（已发量会被写回 OrderLine.shipmentQuantity）
//          ② 哪一步走不通，那一处就是软件的真断点（自动登记）
// 用法：node scripts/data-union-drill.mjs [单数]   默认 1 单试点

const BASE = 'http://localhost:8081';
const LIMIT = Number(process.argv[2] || 1);

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jason.shen@bambook.local', password: 'Bambook@2026' }),
  });
  const j = await r.json();
  return j.token || j.data?.token || j.accessToken;
}

let TOKEN = '';
async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { j = { raw: await r.text().catch(() => '') }; }
  return { status: r.status, data: j };
}

const log = (tag, ok, detail) =>
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${tag.padEnd(26)} ${detail}`);

async function pickOrders(n) {
  const r = await api('GET', `/api/v1/orders?limit=200`);
  const items = r.data?.items || r.data?.orders || r.data?.data || [];
  // 未软删（API 已过滤），按状态各取一些，优先有订单行的
  const byStatus = {};
  for (const o of items) {
    const s = o.status || '?';
    (byStatus[s] ||= []).push(o);
  }
  const order = ['Confirmed', 'Production', 'Shipping', 'Pending', 'Delivered'];
  const picked = [];
  for (const s of order) {
    for (const o of byStatus[s] || []) {
      if (picked.length >= n) break;
      picked.push(o);
    }
    if (picked.length >= n) break;
  }
  return picked;
}

async function drillOne(o, idx) {
  console.log(`\n===== [${idx + 1}] ${o.id} · ${o.status} · ${o.poNumber || ''} =====`);
  const poNumber = o.poNumber;
  const orderId = o.id;

  // 1) 补订单行到 >=3 行（一行一色，像真面料单）
  let lineCount = 0;
  try {
    const cur = await api('GET', `/api/v1/order-lines?orderId=${encodeURIComponent(orderId)}&limit=100`);
    const arr = cur.data?.items || cur.data?.lines || cur.data?.data || [];
    lineCount = Array.isArray(arr) ? arr.length : 0;
  } catch { /* 下面会再试 */ }
  log('读现有订单行', true, `${lineCount} 行`);

  const colors = ['NAVY', 'CHARCOAL', 'OLIVE', 'CAMEL', 'BLACK'];
  let added = 0;
  for (let i = lineCount; i < 3; i++) {
    const c = colors[i % colors.length];
    const r = await api('POST', '/api/v1/order-lines', {
      orderId, poNumber,
      quantity: 800 + i * 450,
      unitPrice: 7.5 + i * 0.9,
      unit: 'M', width: 150, colorName: c,
      styleNo: o.styleNo || undefined,
      deliveryDate: o.deliveryDate || undefined,
    });
    if (r.status === 200 || r.status === 201) { added++; log(`补订单行 ${c}`, true, `HTTP ${r.status}`); }
    else { log(`补订单行 ${c}`, false, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`); }
  }

  // 2) 建运单
  const shipNo = `UNION-${idx + 1}-${Date.now().toString(36).toUpperCase()}`;
  const cr = await api('POST', '/api/v1/shipping', {
    shipmentNumber: shipNo, type: 'Sea', shippingMethod: 'Sea', orderId, status: 'Draft',
  });
  const shipId = cr.data?.shipment?.id || cr.data?.id;
  if (!shipId) { log('建运单', false, `HTTP ${cr.status} ${JSON.stringify(cr.data).slice(0, 200)}`); return; }
  log('建运单', true, shipId);

  // 3) 带出装运行
  const pr = await api('POST', `/api/v1/shipping/${encodeURIComponent(shipId)}/lines/pull-from-order`);
  log('带出装运行', pr.status === 200, `HTTP ${pr.status} ${JSON.stringify(pr.data).slice(0, 140)}`);

  // 4) 读行 → 填实际数量
  const lr = await api('GET', `/api/v1/shipping/${encodeURIComponent(shipId)}/lines`);
  const lines = lr.data?.items || lr.data?.lines || lr.data?.data || [];
  log('读运单明细', lr.status === 200, `${Array.isArray(lines) ? lines.length : '?'} 行`);
  if (Array.isArray(lines) && lines.length) {
    const payload = lines.map((l) => ({
      id: l.id, orderLineId: l.orderLineId,
      plannedQty: l.plannedQty ?? l.quantity ?? 0,
      actualQty: l.plannedQty ?? l.quantity ?? 0,
    }));
    const ur = await api('PUT', `/api/v1/shipping/${encodeURIComponent(shipId)}/lines`, { lines: payload });
    log('填实际数量', ur.status === 200, `HTTP ${ur.status} ${JSON.stringify(ur.data).slice(0, 140)}`);
  }

  // 5) Draft → Booked → Shipped（Shipped 会触发短装/溢装门禁并写回已发量）
  const bk = await api('PATCH', `/api/v1/shipping/${encodeURIComponent(shipId)}`, { status: 'Booked' });
  log('Draft → Booked', bk.status === 200, `HTTP ${bk.status} ${JSON.stringify(bk.data).slice(0, 140)}`);

  const sp = await api('PATCH', `/api/v1/shipping/${encodeURIComponent(shipId)}`, { status: 'Shipped' });
  const shippedOk = sp.status === 200;
  log('Booked → Shipped', shippedOk, `HTTP ${sp.status} ${JSON.stringify(sp.data).slice(0, 200)}`);
  if (!shippedOk) console.log(`      ↳ 若 409 是短装/数量完整性拦截，属预期门禁；若 500 则是出口档位缺陷`);

  // 6) 回读订单行已发量，验证血有没有通
  const back = await api('GET', `/api/v1/order-lines?orderId=${encodeURIComponent(orderId)}&limit=100`);
  const arr = back.data?.items || back.data?.lines || back.data?.data || [];
  const withShipped = Array.isArray(arr) ? arr.filter((l) => l.shipmentQuantity != null && Number(l.shipmentQuantity) > 0).length : 0;
  log('已发量写回', withShipped > 0, `${withShipped}/${Array.isArray(arr) ? arr.length : '?'} 行有已发量`);
}

(async () => {
  TOKEN = await login();
  if (!TOKEN) { console.error('登录失败'); process.exit(1); }
  console.log(`登录成功；目标 ${LIMIT} 单`);
  const orders = await pickOrders(LIMIT);
  console.log(`选中 ${orders.length} 单：${orders.map((o) => `${o.id}(${o.status})`).join(', ')}`);
  for (let i = 0; i < orders.length; i++) await drillOne(orders[i], i);
  console.log('\n完成。');
})().catch((e) => { console.error('脚本异常:', e.message); process.exit(1); });
