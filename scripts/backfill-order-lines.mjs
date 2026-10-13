#!/usr/bin/env node
// 补齐订单行深度：每单补到 >=4 行（一行一色，贴近真实面料 PO）。
// 走真实 API（POST /api/v1/order-lines），保证触发联动，不是裸写库。
// 用法：node scripts/backfill-order-lines.mjs [目标每单行=4] [最多处理单数]

const BASE = 'http://localhost:8081';
const TARGET = Number(process.argv[2] || 4);
const MAX = Number(process.argv[3] || 999);

const COLORS = [
  ['NAVY', 'Wool/Poly 80/20', 'W-2401'],
  ['CHARCOAL', 'Wool/Poly 80/20', 'W-2402'],
  ['OLIVE', 'Wool 100%', 'W-2410'],
  ['CAMEL', 'Wool/Cashmere 90/10', 'W-2425'],
  ['BLACK', 'Wool/Poly 70/30', 'W-2433'],
  ['GREY MELANGE', 'Wool 100%', 'W-2441'],
];

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jason.shen@bambook.local', password: 'Bambook@2026' }),
  });
  const j = await r.json();
  return j.token || j.data?.token;
}

let T = '';
async function api(m, p, b) {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  let j = null; try { j = await r.json(); } catch { j = { raw: '' }; }
  return { status: r.status, data: j };
}

(async () => {
  T = await login();
  if (!T) { console.error('登录失败'); process.exit(1); }

  const or = await api('GET', '/api/v1/orders?limit=200&sort=createdAt:desc');
  const orders = or.data?.items || or.data?.orders || or.data?.data || [];
  console.log(`可见订单 ${orders.length} 张，目标每单 ${TARGET} 行`);

  let doneOrders = 0, added = 0, failed = 0;
  const failures = [];

  for (const o of orders.slice(0, MAX)) {
    const orderId = o.id;
    const poNumber = o.poNumber;
    if (!poNumber) { failures.push(`${orderId}: 无 poNumber`); continue; }

    const lr = await api('GET', `/api/v1/order-lines?orderId=${encodeURIComponent(orderId)}&limit=100`);
    const arr = lr.data?.items || lr.data?.lines || lr.data?.data || [];
    const have = Array.isArray(arr) ? arr.length : 0;
    if (have >= TARGET) continue;

    let ok = 0;
    for (let i = have; i < TARGET; i++) {
      const [color, cloth, mill] = COLORS[i % COLORS.length];
      const qty = 800 + i * 620;                    // 800 / 1420 / 2040 / 2660
      const price = (7.5 + i * 1.15).toFixed(2);
      const r = await api('POST', '/api/v1/order-lines', {
        orderId, poNumber,
        quantity: qty,
        unitPrice: Number(price),
        unit: 'M',
        width: '150',                                // ★ 字符串，schema 要求
        colorName: color,
        cloth,
        millQuality: mill,
        deliveryDate: o.deliveryDate || undefined,
      });
      if (r.status === 200 || r.status === 201) { ok++; added++; }
      else { failed++; failures.push(`${orderId}/${color}: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`); }
    }
    if (ok > 0) doneOrders++;
  }

  console.log(`\n结果：新增订单行 ${added} 行（涉及 ${doneOrders} 张订单），失败 ${failed}`);
  if (failures.length) console.log('失败样本:\n  ' + failures.slice(0, 8).join('\n  '));
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
