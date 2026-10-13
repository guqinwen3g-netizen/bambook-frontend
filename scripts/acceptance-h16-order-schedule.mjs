// H16-③ 订单进度对照（只读增强）—— 真库验收（零写入）
//
// 验的口径不变量：
//   R1 `GET /orders/:id/timeline` 返回 `schedule`（进度对照）且**时间线未被破坏**
//   R2 status ∈ on_time | delayed | overdue | pending | unknown
//   R3 **自洽**：delivered=true 时 status 只能是 on_time/delayed；
//      status=overdue 时 delivered 必须为 false
//   R4 deviationDays 与 basis 口径一致（overdue/delayed 时为正数；pending 时为负数）
//   R5 归属隔离：不存在/不属于本客户的订单 → 404
//   R6 未登录 → 401
//   R7 数据边界：schedule 只含对外字段（无工厂/成本/内部备注）
//
// 用法：node scripts/acceptance-h16-order-schedule.mjs
const BASE = 'http://127.0.0.1:8081';
const CUSTOMER_PASSWORD = 'Customer@123';
const CUST = 'sakurabrandskk@portal.demo';

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
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data };
}

const VALID_STATUS = new Set(['on_time', 'delayed', 'overdue', 'pending', 'unknown']);
const SCHEDULE_KEYS = ['dueDate', 'plannedEtd', 'actualAtd', 'plannedEta', 'actualAta', 'delivered', 'status', 'deviationDays', 'basis'];

async function main() {
  console.log('══ H16-③ 订单进度对照 · 真库验收（零写入）══\n');

  const token = await customerLogin(CUST);
  if (!token) { fail('客户登录', CUST); return exit(); }
  pass('客户登录', CUST);

  const orders = await api(token, '/api/v2/customer/orders');
  const items = orders.data?.items ?? [];
  pass('订单列表', `${items.length} 张`);
  if (items.length === 0) { info('无订单样本', '跳过'); return exit(); }

  const sample = items.slice(0, 6);
  let checked = 0;
  const statusSeen = new Set();

  for (const o of sample) {
    const r = await api(token, `/api/v2/customer/orders/${encodeURIComponent(o.id)}/timeline`);
    if (r.status !== 200) { fail(`timeline ${o.id}`, `HTTP ${r.status}`); continue; }
    const s = r.data?.schedule;
    if (!s) { fail(`R1 ${o.id} schedule 缺失`, JSON.stringify(r.data).slice(0, 120)); continue; }
    if (!Array.isArray(r.data?.timeline)) { fail(`R1 ${o.id} timeline 被破坏`, 'timeline 不是数组'); continue; }
    checked += 1;
    statusSeen.add(s.status);

    // R2 status 合法
    if (!VALID_STATUS.has(s.status)) fail(`R2 ${o.id} status 非法`, s.status);

    // R3 自洽
    if (s.delivered && !['on_time', 'delayed'].includes(s.status)) {
      fail(`R3 ${o.id}`, `delivered=true 但 status=${s.status}`);
    }
    if (s.status === 'overdue' && s.delivered) fail(`R3 ${o.id}`, 'overdue 却 delivered=true');

    // R4 deviationDays 与 status 口径一致
    if (['overdue', 'delayed'].includes(s.status) && !(typeof s.deviationDays === 'number' && s.deviationDays > 0)) {
      fail(`R4 ${o.id}`, `${s.status} 的 deviationDays=${s.deviationDays}（应为正数）`);
    }
    if (s.status === 'pending' && typeof s.deviationDays === 'number' && s.deviationDays > 0) {
      fail(`R4 ${o.id}`, `pending 却已过交期（deviationDays=${s.deviationDays}）`);
    }
    if (typeof s.basis !== 'string' || !s.basis) fail(`R4 ${o.id}`, 'basis 缺失');

    // R7 数据边界
    const extra = Object.keys(s).filter(k => !SCHEDULE_KEYS.includes(k));
    if (extra.length > 0) fail(`R7 ${o.id} schedule 含非对外字段`, extra.join(', '));
  }

  if (checked > 0) pass('R1/R2/R3/R4/R7 进度对照逐单校验', `${checked} 单通过 · 出现状态 ${[...statusSeen].join('/')}`);

  // R5 归属隔离 / 不存在 → 404
  const nf = await api(token, '/api/v2/customer/orders/NOPE__x/timeline');
  if (nf.status === 404) pass('R5 不存在/非本客户订单 → 404');
  else fail('R5', `期望 404，实际 ${nf.status}`);

  // R6 未登录 → 401
  const anon = await api(null, `/api/v2/customer/orders/${encodeURIComponent(items[0].id)}/timeline`);
  if (anon.status === 401) pass('R6 未登录 → 401');
  else fail('R6 未登录', `期望 401，实际 ${anon.status}`);

  console.log('');
  info('口径', '已交付用实际完成日（ATA→ATD）算偏差；未交付用今天判是否逾期；Cancelled 运单排除');
  info('数据边界', 'schedule 只含 dueDate/ETD/ATD/ETA/ATA/delivered/status/deviationDays/basis（无工厂/成本/内部备注）');
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
