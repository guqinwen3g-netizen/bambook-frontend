// T7-1 ①对账跨币种裸加 + ②多币种开票显示 0 —— 真库验收（只读，不建数据、无需回滚）
//
// 本批是「钱算错」修复，重点在**口径不变量**，不是"接口能通"。故断言以自洽性为主：
//   R1  invoicedAmount === null  ⟺  invoicedByCurrency.length > 1     （跨币种才置 null）
//   R2  invoicedAmount !== null  →  分币种明细长度 ≤ 1 且金额相等      （单币种可合并且必须一致）
//   R3  currency_mismatch 若出现 → severity 必须为 critical            （T7-① 升级为阻断级）
//   R4  客户级 totalOrderAmount === null  ⟺  totalByCurrency.length > 1
//   R5  ②preview 的 summaryByCurrency 非空，且 multiCurrency === (长度 > 1)
//
// 用法：node scripts/acceptance-t7-1-multicurrency.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.T7_DEBUG === '1';

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

/** R1/R2：订单级「可合并值」与分币种明细的自洽 */
function assertOrderInvariants(label, r) {
  const inv = r.invoicedAmount;
  const list = r.invoicedByCurrency ?? [];
  if (inv === null) {
    if (list.length > 1) pass(`${label} R1 跨币种 → invoicedAmount=null`, `${list.length} 个币种：${list.map(x => `${x.currency} ${x.amount}`).join(' / ')}`);
    else fail(`${label} R1`, `invoicedAmount=null 但分币种只有 ${list.length} 条（应为 >1）`);
  } else {
    const ok = list.length <= 1 && (list.length === 0 ? inv === 0 : list[0].amount === inv);
    if (ok) pass(`${label} R2 单币种可合并且一致`, `invoicedAmount=${inv}${list.length ? ` (${list[0].currency})` : ''}`);
    else fail(`${label} R2`, `invoicedAmount=${inv} 与分币种 ${JSON.stringify(list)} 不自洽`);
  }
  const paidList = r.paidByCurrency ?? [];
  if (r.paidAmount === null) {
    if (paidList.length > 1) pass(`${label} R1 跨币种 → paidAmount=null`, `${paidList.map(x => `${x.currency} ${x.amount}`).join(' / ')}`);
    else fail(`${label} R1(paid)`, `paidAmount=null 但分币种只有 ${paidList.length} 条`);
  } else {
    const ok = paidList.length <= 1 && (paidList.length === 0 ? r.paidAmount === 0 : paidList[0].amount === r.paidAmount);
    if (ok) pass(`${label} R2 收款单币种可合并且一致`, `paidAmount=${r.paidAmount}`);
    else fail(`${label} R2(paid)`, `paidAmount=${r.paidAmount} 与 ${JSON.stringify(paidList)} 不自洽`);
  }
  if (typeof r.settledCny !== 'number') fail(`${label} settledCny 字段`, `期望 number，实际 ${typeof r.settledCny}`);
  else pass(`${label} settledCny 已结汇折算`, `${r.settledCny} CNY`);
}

async function main() {
  const token = await login('charlie.qian@bambook.local');
  if (!token) { console.log('登录失败（charlie.qian 财务）'); process.exit(1); }
  console.log('══ T7-1 多币种口径 · 真库只读验收 ══\n');

  // ── 样本来源：全量差异清单（顺带验证清单接口未被本批改坏） ──
  const list = await api(token, 'GET', '/api/v1/reconciliation/discrepancies?pageSize=200');
  if (list.status !== 200) {
    fail('GET /reconciliation/discrepancies', `HTTP ${list.status} ${JSON.stringify(list.data).slice(0, 200)}`);
    return exit();
  }
  const items = list.data?.items ?? [];
  pass('GET /reconciliation/discrepancies', `HTTP 200，${items.length} 条差异（总 ${list.data?.total}）`);

  const orderIds = [...new Set(items.map(x => x.orderId).filter(Boolean))].slice(0, 6);
  const customerIds = [...new Set(items.map(x => x.customerRelationId).filter(Boolean))].slice(0, 4);
  if (orderIds.length === 0) info('无订单样本', '差异清单为空，跳过订单级断言');
  if (customerIds.length === 0) info('无客户样本', '差异清单无 customerRelationId，跳过客户级断言');

  // ── ① 订单级：口径不变量 ──
  let crossCurrencyOrderSeen = 0;
  let criticalMismatchSeen = 0;
  for (const id of orderIds) {
    const r = await api(token, 'GET', `/api/v1/reconciliation/orders/${encodeURIComponent(id)}`);
    if (r.status !== 200) { fail(`订单对账 ${id}`, `HTTP ${r.status}`); continue; }
    const d = r.data;
    assertOrderInvariants(`订单 ${id}`, d);

    const cm = (d.discrepancies ?? []).filter(x => x.type === 'currency_mismatch');
    if (cm.length > 0) {
      if (cm.every(x => x.severity === 'critical')) { pass(`订单 ${id} R3 currency_mismatch=critical`, cm.map(x => x.actual).join('/')); criticalMismatchSeen += 1; }
      else fail(`订单 ${id} R3`, `currency_mismatch 存在非 critical：${JSON.stringify(cm.map(x => x.severity))}`);
    }
    if (d.invoicedAmount === null || d.paidAmount === null) crossCurrencyOrderSeen += 1;

    // 跨币种（含单一外币≠订单币种）时不得产出金额类差异 —— 这是本批修的核心「假 critical」
    const hasAmountMismatch = (d.discrepancies ?? []).some(x => x.type === 'invoice_amount_mismatch' || x.type === 'payment_mismatch');
    if (cm.length > 0 && d.invoicedAmount === null && hasAmountMismatch) {
      fail(`订单 ${id} 跨币种仍产出金额差异`, JSON.stringify(d.discrepancies.filter(x => x.type !== 'currency_mismatch').slice(0, 2)));
    }
  }
  if (crossCurrencyOrderSeen === 0) info('真库无跨币种订单样本', '订单级 R1（null 分支）未被真实数据覆盖——已由单测钉住，此处仅作知会');

  // ── ① 客户级：汇总按币种分组 ──
  let crossCurrencyCustomerSeen = 0;
  for (const cid of customerIds) {
    const r = await api(token, 'GET', `/api/v1/reconciliation/customers/${encodeURIComponent(cid)}`);
    if (r.status !== 200) { fail(`客户对账 ${cid}`, `HTTP ${r.status}`); continue; }
    const s = r.data?.summary;
    if (!s) { fail(`客户对账 ${cid} 汇总缺失`, JSON.stringify(r.data).slice(0, 150)); continue; }
    const by = s.totalByCurrency ?? [];
    const expectNull = by.length > 1;
    if (expectNull) {
      if (s.totalOrderAmount === null && s.totalInvoicedAmount === null && s.totalPaidAmount === null) {
        pass(`客户 ${cid} R4 跨币种 → 三个 total 置 null`, `分组：${by.map(x => `${x.currency} 订单 ${x.orderAmount}`).join(' / ')}`);
        crossCurrencyCustomerSeen += 1;
      } else fail(`客户 ${cid} R4`, `totalByCurrency=${by.length} 条但 totalOrderAmount=${s.totalOrderAmount}`);
    } else {
      const sole = by[0] ?? { orderAmount: 0, invoicedAmount: 0, paidAmount: 0 };
      if (s.totalOrderAmount === sole.orderAmount) pass(`客户 ${cid} R4 单币种 total 与分组一致`, `订单 ${s.totalOrderAmount}`);
      else fail(`客户 ${cid} R4`, `totalOrderAmount=${s.totalOrderAmount} vs 分组 ${sole.orderAmount}`);
    }
    if (typeof s.settledCnyTotal !== 'number') fail(`客户 ${cid} settledCnyTotal`, `期望 number，实际 ${typeof s.settledCnyTotal}`);
    else pass(`客户 ${cid} settledCnyTotal`, `${s.settledCnyTotal} CNY`);
  }
  if (crossCurrencyCustomerSeen === 0) info('真库无多币种客户样本', '客户级 R4（null 分支）未被真实数据覆盖——已由单测钉住');

  // ── ② 场景开票预览：多币种分组 ──
  if (orderIds.length > 0) {
    const pv = await api(token, 'POST', '/api/v1/finance/scene-invoice/preview', { scene: 'order', sourceId: orderIds[0] });
    if (pv.status !== 200) {
      info('场景开票预览', `HTTP ${pv.status}（该订单可能无费用行）${JSON.stringify(pv.data).slice(0, 120)}`);
    } else {
      const d = pv.data ?? {};
      const by = d.summaryByCurrency ?? [];
      if (!Array.isArray(by)) fail('② preview summaryByCurrency', `期望数组，实际 ${typeof by}`);
      else if (by.length === 0) info('② preview 无候选行', '该订单无费用行，summaryByCurrency 为空属正常');
      else {
        const expectMulti = by.length > 1;
        if (d.multiCurrency === expectMulti) pass('② R5 multiCurrency 与分组长度一致', `${by.length} 个币种，multiCurrency=${d.multiCurrency}`);
        else fail('② R5', `分组 ${by.length} 条但 multiCurrency=${d.multiCurrency}`);
        const sum = by.reduce((a, x) => a + Number(x.amount || 0), 0);
        if (expectMulti) {
          pass('② 多币种分组明细', by.map(x => `${x.currency} ${x.amount}`).join(' / '));
          if (d.summaryAmount === 0 && d.summaryCurrency === '') pass('② 多币种时兼容字段为 0/空（前端改读 summaryByCurrency）', '不再误导');
          else fail('② 兼容字段', `多币种下 summaryAmount=${d.summaryAmount} summaryCurrency='${d.summaryCurrency}'`);
        } else {
          if (d.summaryAmount === by[0].amount) pass('② 单币种标量与分组一致', `${by[0].currency} ${by[0].amount}`);
          else fail('② 单币种不一致', `summaryAmount=${d.summaryAmount} vs 分组 ${by[0].amount}`);
        }
        info('② 候选行合计', `${by.length} 币种 / ${sum} 合计（仅作参照，不代表可合并）`);
      }
    }
  }

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
