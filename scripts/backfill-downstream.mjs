#!/usr/bin/env node
// 补齐下游连通：给「有出运但缺发票」「有发票但缺收汇」的订单，走真实 API 补上。
// 目标：把「全链通」比例拉上去，让走查时点任何一单都不至于半截。
// 用法：node scripts/backfill-downstream.mjs [--dry]

import { orderAmountOrNull } from '../server/src/shared/orderAmount.ts';
import { todayLocalKey } from '../server/src/shared/localDate.ts';

const BASE = 'http://localhost:8081';
const DRY = process.argv.includes('--dry');

async function login(email, pw) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  });
  const j = await r.json();
  return j.token || j.data?.token;
}
let T = '';
async function api(m, p, b) {
  const r = await fetch(BASE + p, {
    method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  let j = null; try { j = await r.json(); } catch { j = {}; }
  return { status: r.status, data: j };
}
const today = todayLocalKey;

(async () => {
  T = await login('jason.shen@bambook.local', 'Bambook@2026');
  if (!T) { console.error('登录失败'); process.exit(1); }

  const or = await api('GET', '/api/v1/orders?limit=200');
  const orders = or.data?.items || or.data?.orders || or.data?.data || [];
  console.log(`可见订单 ${orders.length} 张${DRY ? '（演练模式，不写库）' : ''}`);

  let invoiceMade = 0, voucherMade = 0, skipped = 0;
  const errs = [];

  for (const o of orders) {
    const orderId = o.id;
    // ★ 列表接口不带 customerRelationId / 金额，必须取详情
    const od = await api('GET', `/api/v1/orders/${encodeURIComponent(orderId)}`);
    const d = od.data?.order || od.data?.data || od.data || {};
    const relId = d.customerRelationId || o.customerRelationId || null;
    const custName = d.customer || o.customer || '—';
    const amount = orderAmountOrNull(d);
    const currency = d.currency || d.salesCurrency || 'USD';

    // 已有发票？
    const iv = await api('GET', `/api/v1/finance?orderId=${encodeURIComponent(orderId)}&limit=50`);
    const invList = iv.data?.items || iv.data?.invoices || iv.data?.data || [];
    let hasInvoice = Array.isArray(invList) && invList.length > 0;

    if (!hasInvoice) {
      if (amount == null || amount <= 0 || !relId) { skipped++; errs.push(`${orderId}: 缺金额或客户 relation，跳过`); continue; }
      if (!DRY) {
        const r = await api('POST', '/api/v1/finance', {
          type: 'Receivable', status: 'Draft', amount, currency,
          issueDate: today(), invoiceNumber: `INV-BF-${orderId}`.slice(0, 40),
          customerRelationId: relId, customerName: custName,
          orderAllocations: [{ orderId, allocatedAmount: amount, note: '连通补齐' }],
        });
        if (r.status === 200 || r.status === 201) { invoiceMade++; hasInvoice = true; }
        else { errs.push(`${orderId} 建票: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 130)}`); continue; }
      } else { invoiceMade++; hasInvoice = true; }
    }

    // 已有收汇凭证？
    const pv = await api('GET', `/api/v1/finance/vouchers?orderId=${encodeURIComponent(orderId)}&limit=50`);
    const pvList = pv.data?.items || pv.data?.vouchers || pv.data?.data || [];
    const hasVoucher = Array.isArray(pvList) && pvList.length > 0;

    if (!hasVoucher && amount != null && amount > 0 && relId) {
      if (!DRY) {
        // 刻意留 3% 尾款不收，模拟真实「少收汇」（也是走查要看的场景）
        const recv = Math.round((amount * 0.97) * 100) / 100;
        const r = await api('POST', '/api/v1/finance/vouchers', {
          type: 'Receipt', voucherNumber: `PV-BF-${orderId}`.slice(0, 40),
          amount: recv, currency, paymentDate: today(),
          paymentMethod: 'T/T', customerRelationId: relId, customerName: custName,
          notes: '连通补齐（留 3% 尾款模拟少收汇）',
        });
        if (r.status === 200 || r.status === 201) voucherMade++;
        else errs.push(`${orderId} 建凭证: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 130)}`);
      } else voucherMade++;
    }
  }

  console.log(`\n结果：新建发票 ${invoiceMade} 张 · 新建收汇凭证 ${voucherMade} 张 · 跳过 ${skipped}`);
  if (errs.length) console.log('失败/跳过样本:\n  ' + errs.slice(0, 10).join('\n  '));
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
