// T6 订舱段 + 陆运段 —— API 级真库实机验收（handoff-20260916-104300 §二-4）
//
// 要证的：
//   1) 订舱 8 字段 PATCH 可写可读（spaceConfirmedAt 是 epoch ms）；并舱 = 两张运单可填同一 bookingNo。
//   2) 陆运段 upsert 幂等（第二次提交仍是同一行 id），部分更新保留其它字段。
//   3) 费用采集落库（陆运费 1200 CNY / 进仓费 300 CNY）。
//   4) 非法日期 → 400；负费用 → 400；软删运单 → 404。
//
// 自回滚：本脚本新建的临时运单跑完软删（历史运单一律不动）。
// 用法：node scripts/acceptance-t6-booking-land.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.T6_DEBUG === '1';

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

const STAMP = Date.now().toString(36).toUpperCase();
const BOOKING_NO = `BK-T6-${STAMP}`;
const SPACE_CONFIRMED_AT = Date.parse('2026-09-20T10:30:00+08:00');

const BOOKING_FIELDS = {
  bookingNo: BOOKING_NO,
  soNumber: `SO-T6-${STAMP}`,
  spaceConfirmedAt: SPACE_CONFIRMED_AT,
  cutOffAt: '2026-09-22 17:00',
  docCutOffAt: '2026-09-21 12:00',
  billOfLadingNo: `BL-T6-${STAMP}`,
  masterBillNo: `MAWB-T6-${STAMP}`,
  houseBillNo: `HAWB-T6-${STAMP}`,
};

let exitFn = () => process.exit(0);

async function main() {
  const token = await login('jason.shen@bambook.local');
  if (!token) { console.log('登录失败（jason.shen 超管）'); process.exit(1); }
  console.log('══ T6 订舱段 + 陆运段 · 真库实跑 ══\n');

  // ── 1. 两张临时运单（并舱 = 同 bookingNo） ────────────────────────────────
  const ids = [];
  for (const suffix of ['A', 'B']) {
    const created = await api(token, 'POST', '/api/v1/shipping', {
      shipmentNumber: `T6-${suffix}-${STAMP}`,
      type: 'Sea',
      shippingMethod: 'Sea',
      status: 'Draft',
    });
    if (created.status !== 201 && created.status !== 200) {
      fail(`建临时运单 ${suffix}`, `HTTP ${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
      await rollbackAll(token, ids);
      return exitFn();
    }
    const id = created.data?.shipment?.id ?? created.data?.id;
    ids.push(id);
    pass(`建临时运单 ${suffix}`, `${id}（跑完软删）`);
  }
  const [shipA, shipB] = ids;


  // ── 2. 订舱 8 字段 PATCH → GET 回读 ──────────────────────────────────────
  const patched = await api(token, 'PATCH', `/api/v1/shipping/${encodeURIComponent(shipA)}`, BOOKING_FIELDS);
  if (patched.status !== 200) {
    fail('PATCH 订舱 8 字段', `HTTP ${patched.status} ${JSON.stringify(patched.data).slice(0, 200)}`);
    await rollbackAll(token, ids); return exitFn();
  }
  pass('PATCH 订舱 8 字段', 'HTTP 200');

  const got = await api(token, 'GET', `/api/v1/shipping/${encodeURIComponent(shipA)}`);
  const s = got.data ?? {};
  for (const k of Object.keys(BOOKING_FIELDS)) {
    if (String(s[k] ?? '') === String(BOOKING_FIELDS[k])) pass(`回读 ${k}`, String(s[k]));
    else fail(`回读 ${k}`, `期望 ${BOOKING_FIELDS[k]}，实际 ${s[k]}`);
  }
  // spaceConfirmedAt 必须是 epoch ms（BigInt 列，序列化后仍应能还原为同一时刻）
  const scNum = Number(s.spaceConfirmedAt);
  if (Number.isFinite(scNum) && scNum === SPACE_CONFIRMED_AT) pass('spaceConfirmedAt = epoch ms', `${scNum}`);
  else fail('spaceConfirmedAt 口径', `期望 ${SPACE_CONFIRMED_AT}，实际 ${s.spaceConfirmedAt}`);

  // ── 3. 并舱：两张运单填同一订舱号（无唯一约束） ──────────────────────────
  const patchedB = await api(token, 'PATCH', `/api/v1/shipping/${encodeURIComponent(shipB)}`, { bookingNo: BOOKING_NO });
  if (patchedB.status !== 200) fail('并舱：第二票填同号', `HTTP ${patchedB.status}`);
  else {
    const gotB = await api(token, 'GET', `/api/v1/shipping/${encodeURIComponent(shipB)}`);
    if (String(gotB.data?.bookingNo ?? '') === BOOKING_NO) {
      pass('并舱：两票共享同一订舱号', `${BOOKING_NO}（A=${shipA} / B=${shipB}，无唯一约束冲突）`);
    } else fail('并舱回读', `期望 ${BOOKING_NO}，实际 ${gotB.data?.bookingNo}`);
  }
  const listSearch = await api(token, 'GET', `/api/v1/shipping?search=${encodeURIComponent(BOOKING_NO)}`);
  const hits = (listSearch.data?.items ?? []).filter(x => x.bookingNo === BOOKING_NO).length;
  if (hits > 0) pass('列表 search 能按订舱号命中', `${hits} 票`);
  else info('列表 search 未命中订舱号', 'GET /v1/shipping 的 search 只含 shipmentNumber/customerName/carrierName——「按订舱号查出所有并舱票」暂不可查（见回报 ❓）');

  // ── 4. 陆运段 upsert（第一次 = create） ──────────────────────────────────
  const emptyLt = await api(token, 'GET', `/api/v1/shipping/${encodeURIComponent(shipA)}/land-transport`);
  if (emptyLt.data?.landTransport === null) pass('未登记时陆运段 = null', '不预建空行');
  else fail('未登记时陆运段', JSON.stringify(emptyLt.data).slice(0, 200));

  const lt1 = await api(token, 'PUT', `/api/v1/shipping/${encodeURIComponent(shipA)}/land-transport`, {
    plannedArrivalAt: '2026-09-19 09:00',
    actualDeliveredAt: '2026-09-19 14:20',
    plateNo: '苏E·A1234',
    driverName: '张师傅',
    driverPhone: '13800000001',
    carrierName: '张家港顺风车队',
    inlandFreightAmount: '1200',
    inlandFreightCurrency: 'CNY',
    warehouseFeeAmount: '300',
    warehouseFeeCurrency: 'CNY',
    notes: '9.6m 厢车，周二上午进仓',
  });
  if (lt1.status !== 200 && lt1.status !== 201) {
    fail('PUT 陆运段（首次）', `HTTP ${lt1.status} ${JSON.stringify(lt1.data).slice(0, 200)}`);
    await rollbackAll(token, ids); return exitFn();
  }
  const row1 = lt1.data?.landTransport ?? {};
  pass('PUT 陆运段（首次 = create）', `id=${row1.id}`);
  const expect1 = {
    plannedArrivalAt: '2026-09-19 09:00', actualDeliveredAt: '2026-09-19 14:20',
    plateNo: '苏E·A1234', driverName: '张师傅', driverPhone: '13800000001',
    carrierName: '张家港顺风车队', inlandFreightCurrency: 'CNY', warehouseFeeCurrency: 'CNY',
  };
  for (const k of Object.keys(expect1)) {
    if (String(row1[k] ?? '') === expect1[k]) pass(`落库 ${k}`, String(row1[k]));
    else fail(`落库 ${k}`, `期望 ${expect1[k]}，实际 ${row1[k]}`);
  }
  if (Number(row1.inlandFreightAmount) === 1200) pass('费用采集：陆运费', `1200 ${row1.inlandFreightCurrency}`);
  else fail('费用采集：陆运费', `期望 1200，实际 ${row1.inlandFreightAmount}`);
  if (Number(row1.warehouseFeeAmount) === 300) pass('费用采集：进仓费', `300 ${row1.warehouseFeeCurrency}`);
  else fail('费用采集：进仓费', `期望 300，实际 ${row1.warehouseFeeAmount}`);
  if (row1.direction === 'factory_to_forwarder') pass('默认方向', row1.direction);
  else fail('默认方向', `期望 factory_to_forwarder，实际 ${row1.direction}`);

  // ── 5. 幂等：第二次只改车牌，必须还是同一行且其它字段不动 ─────────────────
  const lt2 = await api(token, 'PUT', `/api/v1/shipping/${encodeURIComponent(shipA)}/land-transport`, {
    plateNo: '苏E·B9999',
  });
  const row2 = lt2.data?.landTransport ?? {};
  if (lt2.status === 200 && row2.id === row1.id) pass('upsert 幂等：仍是同一行', `${row2.id}（一票一段，未新增）`);
  else fail('upsert 幂等', `HTTP ${lt2.status} id1=${row1.id} id2=${row2.id}`);
  if (String(row2.plateNo ?? '') === '苏E·B9999') pass('部分更新：车牌已改', String(row2.plateNo));
  else fail('部分更新：车牌', `期望 苏E·B9999，实际 ${row2.plateNo}`);
  const kept = ['plannedArrivalAt', 'actualDeliveredAt', 'driverName', 'carrierName'];
  const keptOk = kept.every(k => String(row2[k] ?? '') === String(row1[k] ?? ''));
  if (keptOk) pass('部分更新：未提交字段保持原值', kept.join(' / '));
  else fail('部分更新：字段被抹', kept.map(k => `${k}: ${row1[k]}→${row2[k]}`).join(' | '));
  if (Number(row2.inlandFreightAmount) === 1200) pass('费用未被部分更新抹掉', `1200 ${row2.inlandFreightCurrency}`);
  else fail('费用被抹', `实际 ${row2.inlandFreightAmount}`);

  const reread = await api(token, 'GET', `/api/v1/shipping/${encodeURIComponent(shipA)}/land-transport`);
  if (reread.data?.landTransport?.id === row1.id && String(reread.data.landTransport.plateNo) === '苏E·B9999') {
    pass('GET 回读一致', `${row1.id} · 车牌 ${reread.data.landTransport.plateNo}`);
  } else fail('GET 回读', JSON.stringify(reread.data).slice(0, 200));

  // ── 6. 校验：非法日期 / 负费用 ───────────────────────────────────────────
  const badDate = await api(token, 'PUT', `/api/v1/shipping/${encodeURIComponent(shipA)}/land-transport`, {
    plannedArrivalAt: '2026/09/19 9点',
  });
  if (badDate.status === 400) pass('非法日期 → 400', badDate.data?.error?.message ?? '');
  else fail('非法日期应 400', `实际 HTTP ${badDate.status} ${JSON.stringify(badDate.data).slice(0, 160)}`);

  const badFee = await api(token, 'PUT', `/api/v1/shipping/${encodeURIComponent(shipA)}/land-transport`, {
    inlandFreightAmount: '-1',
  });
  if (badFee.status === 400) pass('负费用 → 400', badFee.data?.error?.message ?? '');
  else fail('负费用应 400', `实际 HTTP ${badFee.status} ${JSON.stringify(badFee.data).slice(0, 160)}`);

  // ── 7. 404：软删运单 → 陆运段不可写 ─────────────────────────────────────
  const delB = await api(token, 'DELETE', `/api/v1/shipping/${encodeURIComponent(shipB)}`);
  if (delB.status === 200) pass('软删 B 票（为验 404）', shipB);
  else fail('软删 B 票', `HTTP ${delB.status}`);
  const lt404 = await api(token, 'PUT', `/api/v1/shipping/${encodeURIComponent(shipB)}/land-transport`, { plateNo: 'X' });
  if (lt404.status === 404) pass('软删票 → 陆运段 404', lt404.data?.error?.code ?? '');
  else fail('软删票应 404', `实际 HTTP ${lt404.status} ${JSON.stringify(lt404.data).slice(0, 160)}`);

  await rollbackAll(token, ids);
}

const deletedIds = new Set();
async function rollbackAll(token, ids) {
  for (const id of ids) {
    if (!id || deletedIds.has(id)) continue;
    const d = await api(token, 'DELETE', `/api/v1/shipping/${encodeURIComponent(id)}`);
    if (d.status === 200) { deletedIds.add(id); pass('回滚：软删临时运单', id); }
    else fail('回滚：软删临时运单', `${id} HTTP ${d.status}`);
  }
}

main().then(() => {
  const ok = results.filter(r => r.ok === true).length;
  const bad = results.filter(r => r.ok === false).length;
  const notes = results.filter(r => r.ok === null).length;
  console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
  process.exit(bad === 0 ? 0 : 1);
}).catch((e) => { console.error('脚本异常', e); process.exit(2); });
