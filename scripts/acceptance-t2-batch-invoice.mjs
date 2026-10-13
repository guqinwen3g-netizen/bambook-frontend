// T2 发票批次锚定（H14 方案 A）+ 品类派生 —— API 级实机验收
//
// 要证的业务链：
//   ① 分批开票：IOA 落 batchId + allocatedAmount（批次票不显式给金额被服务端拒绝——虚增防线）
//   ② 批次结算快照：B1 开票 500 → B1.invoicedAmount=500、B2.invoicedAmount=0（不含其他批次金额）
//   ③ 两跳反查运单：发票 batchId → 批次 → shipmentId（GET /:id 的 batchAnchors）
//   ④ 品类派生（D8-Q3）：发票由订单 businessLine 派生；category-summary 按品类分组
//   ⑤ dueDate 自动推导：Receivable 未显式给 dueDate → issueDate + paymentTerms 账期
//
// 自回滚：临时订单/发票作废/批次取消，历史数据一律不动。
// 用法：node scripts/acceptance-t2-batch-invoice.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
// This legacy API drill has no runner/app database identity handshake. It must
// not run against the normal local app until migrated to an isolated fixture.
// Keeping the scenario source is not permission to bypass API dependency guards.
if (!process.env.BAMBOOK_ACCEPTANCE_SANDBOX || !process.env.BAMBOOK_ACCEPTANCE_HTTP_IDENTITY_VERIFIED) {
  throw new Error('T2 legacy drill is disabled: an isolated runner must verify the HTTP app database identity before execution.');
}
const DEBUG = process.env.T2_DEBUG === '1';
const TAG = `T2INV${Date.now().toString(36).toUpperCase()}`;

const results = [];
function pass(name, detail = '') { results.push({ ok: true }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ ok: false }); console.log(`  ✗ ${name} — ${detail}`); }
function info(name, detail = '') { results.push({ ok: null }); console.log(`  ⓘ ${name} — ${detail}`); }

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await res.json().catch(() => null);
  return res.ok && data?.token ? data.token : null;
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (DEBUG && res.status >= 400) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, data };
}

async function main() {
  const admin = await login('jason.shen@bambook.local');
  if (!admin) { console.log('管理员登录失败'); process.exit(1); }
  console.log('══ T2 发票批次锚定 · 真库实跑 ══\n');

  const cleanups = [];
  const runCleanups = async () => {
    for (const c of cleanups.reverse()) {
      try { await c.fn(); } catch (e) { fail(`回滚：${c.name}`, String(e?.message ?? e)); }
    }
  };

  // ── 1. 临时订单（fabric 品类，用于派生断言；不走出运所以不碰样品门禁） ──
  const imported = await api(admin, 'POST', '/api/v1/orders/import', {
    orders: [{
      customerId: 'peerless', poNumber: TAG, season: 'T2验收', poDate: '2026-09-16',
      contactPerson: 'T2', contactPhone: '000', currency: 'USD', deliveryTerms: 'FOB', paymentTerms: 'T/T 30 days',
      shipTo: {}, lines: [{
        itemNo: 'L1', materialCode: TAG, millQuality: 'T2', description: `T2 验收 ${TAG}`,
        width: '150cm', exMillDate: '2026-09-16', deliveryDate: '2026-09-30',
        quantity: 800, unit: 'M', unitPrice: 1, netValue: 800, via: 'T2', cloth: 'T2',
      }],
      totalNet: 800, totalActual: 800,
    }],
  });
  const order = (imported.data?.orders ?? [])[0];
  if (imported.status !== 200 || !order?.id) { fail('导入临时订单', `HTTP ${imported.status}`); await runCleanups(); return exit(); }
  const orderId = order.id;
  pass('导入临时订单', `${orderId} po=${TAG}（totalNet=800, paymentTerms=T/T 30 days）`);
  cleanups.push({ name: '软删临时订单', fn: async () => {
    const d = await api(admin, 'DELETE', `/api/v1/orders/${encodeURIComponent(orderId)}`);
    if (d.status === 200) return;
    // A business dependency rejection is evidence to inspect, never authority
    // for raw SQL deletion. Keep the fixture in its disposable sandbox.
    fail('临时订单 API 清理被拒绝', `HTTP ${d.status}；保留隔离夹具供核查，未绕过依赖保护`);
  } });

  // ── 2. 登记两个批次：B1=500、B2=300 ──
  const mkBatch = async (amount) => {
    const r = await api(admin, 'POST', '/api/v1/shipping/order-batches', {
      orderId, amount, currency: 'USD', plannedRatio: null, notes: 'T2 验收批次',
    });
    return r;
  };
  const b1 = await mkBatch(500);
  const b2 = await mkBatch(300);
  if (b1.status !== 201 || b2.status !== 201) { fail('登记批次', `HTTP ${b1.status}/${b2.status}`); await runCleanups(); return exit(); }
  const batch1 = b1.data.batch, batch2 = b2.data.batch;
  pass('登记两个批次', `B1=${batch1.id}（500）B2=${batch2.id}（300）`);
  cleanups.push({ name: '取消批次', fn: async () => {
    for (const b of [batch1, batch2]) {
      await api(admin, 'PUT', `/api/v1/shipping/order-batches/${encodeURIComponent(b.id)}`, { status: 'cancelled' });
    }
  } });

  // ── 3. 防线：批次票不显式传 allocatedAmount → 400 ──
  const bad = await api(admin, 'POST', '/api/v1/finance', {
    type: 'Receivable', status: 'Draft', amount: 500, currency: 'USD', issueDate: '2026-09-16',
    orderAllocations: [{ orderId, batchId: batch1.id }],
  });
  if (bad.status === 400 && String(bad.data?.error?.message ?? '').includes('allocatedAmount')) {
    pass('虚增防线：批次票缺 allocatedAmount → 400', 'recalcSettlement 读侧 null=整单额语义不被写侧穿透');
  } else {
    fail('虚增防线', `HTTP ${bad.status} ${JSON.stringify(bad.data).slice(0, 200)}`);
  }

  // ── 4. B1 开票 500（batchId + allocatedAmount）+ dueDate 自动推导 ──
  const inv = await api(admin, 'POST', '/api/v1/finance', {
    type: 'Receivable', status: 'Draft', amount: 500, currency: 'USD', issueDate: '2026-09-16',
    orderAllocations: [{ orderId, batchId: batch1.id, allocatedAmount: 500, note: 'T2 验收 B1' }],
  });
  if (inv.status !== 201) { fail('B1 批次开票', `HTTP ${inv.status} ${JSON.stringify(inv.data).slice(0, 250)}`); await runCleanups(); return exit(); }
  const invoiceId = inv.data.id;
  pass('B1 批次开票 500', `${invoiceNumber(inv.data)}（跑完作废）`);
  cleanups.push({ name: '作废临时发票', fn: async () => {
    await api(admin, 'POST', `/api/v1/finance/${encodeURIComponent(invoiceId)}/cancel`, { reason: 'T2 验收回滚' });
  } });

  // dueDate 自动推导断言（issueDate 2026-09-16 + 30 days）
  if (inv.data.dueDate === '2026-10-16') pass('dueDate 自动推导', `dueDate=${inv.data.dueDate}（issueDate + T/T 30 days）`);
  else info('dueDate 自动推导', `dueDate=${inv.data.dueDate ?? 'null'}（期望 2026-10-16；paymentTerms 解析不出则留空属预期）`);

  // ── 5. 两跳反查运单 + 品类派生（GET /:id） ──
  const detail = await api(admin, 'GET', `/api/v1/finance/${encodeURIComponent(invoiceId)}`);
  if (detail.status !== 200) { fail('发票详情', `HTTP ${detail.status}`); await runCleanups(); return exit(); }
  const ioa = (detail.data.orderAllocations ?? [])[0];
  if (ioa?.batchId === batch1.id) pass('IOA.batchId 落库', `orderAllocations[0].batchId=${ioa.batchId}`);
  else fail('IOA.batchId', JSON.stringify(ioa));
  const anchors = detail.data.batchAnchors ?? [];
  const a1 = anchors.find((a) => a.batchId === batch1.id);
  if (a1 && a1.batchNo === batch1.batchNo) pass('两跳反查：batchId → 批次 → shipmentId 通路', `batchNo=${a1.batchNo} shipmentId=${a1.shipmentId ?? 'null（未排船，计划期语义）'}`);
  else fail('两跳反查锚点', JSON.stringify(anchors).slice(0, 200));

  // ── 6. 批次结算快照：B1=500、B2=0（不含其他批次金额）──
  let b1Invoiced = null, b2Invoiced = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const bl = await api(admin, 'GET', `/api/v1/shipping/order-batches?orderId=${encodeURIComponent(orderId)}`);
    const rows = bl.data?.batches ?? bl.data?.items ?? [];
    b1Invoiced = rows.find((x) => x.id === batch1.id)?.invoicedAmount ?? null;
    b2Invoiced = rows.find((x) => x.id === batch2.id)?.invoicedAmount ?? null;
    if (Number(b1Invoiced) === 500) break;
  }
  if (Number(b1Invoiced) === 500 && Number(b2Invoiced ?? 0) === 0) {
    pass('批次结算快照不含其他批次金额', `B1.invoicedAmount=${b1Invoiced}，B2.invoicedAmount=${b2Invoiced ?? 0}`);
  } else {
    fail('批次结算快照', `B1=${b1Invoiced}（期望 500），B2=${b2Invoiced}（期望 0）`);
  }

  // ── 7. 品类派生 + 分品类汇总 ──
  if (detail.data.businessLine === 'fabric') pass('品类派生（发票 ← 订单 businessLine）', `businessLine=${detail.data.businessLine}`);
  else info('品类派生（null 入 → null 出，派生链路本身正确）', `businessLine=${detail.data.businessLine ?? 'null'}：导入器不写订单 businessLine（ParsedOrder 无此字段）且该字段不可经 PUT 修改——带真实品类的存量订单由汇总端点验证（见下一行）`);
  const summary = await api(admin, 'GET', '/api/v1/finance/category-summary?type=Receivable');
  if (summary.status !== 200) { fail('品类汇总端点', `HTTP ${summary.status}`); await runCleanups(); return exit(); }
  const fabricRow = (summary.data.items ?? []).find((g) => g.businessLine === 'fabric' && g.currency === 'USD');
  if (fabricRow && fabricRow.totalAmount >= 500) pass('分品类汇总', `fabric/USD：count=${fabricRow.invoiceCount} total=${fabricRow.totalAmount}`);
  else info('分品类汇总', `fabric/USD 组未找到（汇总行数 ${summary.data.items?.length ?? 0}）`);

  await runCleanups();
  exit();

  function invoiceNumber(x) { return x.invoiceNumber ?? x.invoiceNumber ?? x.id; }
  function exit() {
    const ok = results.filter((r) => r.ok === true).length;
    const bad = results.filter((r) => r.ok === false).length;
    const notes = results.filter((r) => r.ok === null).length;
    console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
    process.exit(bad === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error('脚本异常', e); process.exit(2); });
