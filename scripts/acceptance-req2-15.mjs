// REQ2-15 客户破产货权处置 API 级实机验收
// 验收锚点（设计文档 §7 / DR-055 三决策）：
//   ① X-10 处置全程留痕：开案（declare+自动冻结）→ 转卖/退运/坏账/回款动作追加 →
//      时间线 append-only 正序完整可查 → 闭案汇总正确
//   ② 坏账快照引用闭环可见性（发票号/订单号 payload 留痕）
//   ③ 净损失 = 申报 − 转卖回收 − 回款 + 退运成本（100000 − 40000 − 7000 + 8000 = 61000）
const BASE = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local'; // SuperAdmin（relations:write + crm:write + credit:freeze:write 全链）
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

  const today = new Date().toISOString().slice(0, 10);
  const stamp = Date.now() % 100000;

  // ── 1 构造测试客户 + 信用额度（让开案自动冻结可实证） ──
  const rel = await api('POST', '/api/v2/relations', { name: `REQ2-15 验收破产客户 ${stamp}`, category: 'Customer' });
  const relationId = rel.data?.relation?.id;
  if (!relationId) { console.log('客户创建失败', rel.status, JSON.stringify(rel.data)?.slice(0, 200)); process.exit(1); }
  console.log(`\n测试客户：${relationId}`);

  const cl = await api('POST', `/api/v2/crm/${encodeURIComponent(relationId)}/credit-limit`, {
    totalLimit: 200000, currency: 'CNY', validFrom: today, notes: 'REQ2-15 验收',
  });
  if (cl.status === 200 || cl.status === 201) pass('信用额度设置（Active 200000 CNY）');
  else fail('信用额度设置', `status=${cl.status}`);

  // ── 2 开案（DR-055-③ 自动冻结实证） ──
  console.log('\n── 开案 ──');
  const open = await api('POST', '/api/v1/credit/bankruptcy', {
    relationId, declaredAt: today, totalClaimedAmount: 100000, note: 'REQ2-15 验收开案',
  });
  const proceeding = open.data?.proceeding;
  if (open.status === 201 && proceeding) {
    pass(`开案 201：${proceeding.proceedingNumber} · status=${proceeding.status}`);
    if (open.data.creditFrozen === true) pass('creditFrozen=true（开案自动信用冻结）');
    else fail('自动冻结标记', `creditFrozen=${open.data.creditFrozen}`);
  } else fail('开案', `status=${open.status} ${JSON.stringify(open.data)?.slice(0, 160)}`);

  // 信用状态联动：Frozen（门禁真源 CreditLimit.status）
  const st = await api('GET', `/api/v1/credit/${encodeURIComponent(relationId)}/status`);
  if (st.status === 200 && st.data?.status === 'Frozen' && st.data?.creditFrozen === true) {
    pass('信用状态联动：CreditLimit.status=Frozen，门禁生效（DR-055-③）');
  } else fail('信用状态联动', `status=${st.status} state=${st.data?.status}`);

  const pid = proceeding?.id;

  // ── 3 四类处置动作追加（X-10 全程留痕） ──
  console.log('\n── 处置动作 ──');
  const resale = await api('POST', `/api/v1/credit/bankruptcy/${encodeURIComponent(pid)}/actions`, {
    actionType: 'resale', amount: 40000, payload: { buyer: '下家买家A', orderRef: `PO-BKP-${stamp}` }, note: '货权转卖',
  });
  if (resale.status === 201 && resale.data?.summary?.resaleRecovered === 40000) pass('转卖处置 40000（汇总实时回收 40000）');
  else fail('转卖处置', `status=${resale.status}`);

  const ret = await api('POST', `/api/v1/credit/bankruptcy/${encodeURIComponent(pid)}/actions`, {
    actionType: 'return_shipment', amount: 8000, payload: { shipmentNo: `SH-BKP-${stamp}` },
  });
  if (ret.status === 201 && ret.data?.summary?.returnShippingCost === 8000) pass('退运 8000（汇总退运成本 8000）');
  else fail('退运', `status=${ret.status}`);

  const bad = await api('POST', `/api/v1/credit/bankruptcy/${encodeURIComponent(pid)}/actions`, {
    actionType: 'bad_debt', amount: 45000, payload: { invoiceNumbers: [`INV-BKP-${stamp}`], orderIds: [`PO-BKP-${stamp}`] },
  });
  if (bad.status === 201 && bad.data?.summary?.badDebt === 45000) pass('坏账登记 45000（汇总坏账 45000）');
  else fail('坏账登记', `status=${bad.status}`);

  const rec = await api('POST', `/api/v1/credit/bankruptcy/${encodeURIComponent(pid)}/actions`, {
    actionType: 'recover', amount: 7000, payload: { receivedAt: today },
  });
  if (rec.status === 201 && rec.data?.summary?.recovered === 7000) pass('部分回款 7000（汇总回款 7000）');
  else fail('部分回款', `status=${rec.status}`);

  // ── 4 时间线 + 净损失锚点 ──
  console.log('\n── 时间线与净损失 ──');
  const detail = await api('GET', `/api/v1/credit/bankruptcy/${encodeURIComponent(pid)}`);
  const actions = detail.data?.actions ?? [];
  const seq = actions.map(a => a.actionType).join(',');
  if (seq === 'declare,resale,return_shipment,bad_debt,recover') {
    pass('时间线 append-only 正序：declare → resale → return_shipment → bad_debt → recover（X-10 全程留痕）');
  } else fail('时间线正序', `got ${seq}`);

  const badAction = actions.find(a => a.actionType === 'bad_debt');
  if (badAction?.payload?.invoiceNumbers?.[0] === `INV-BKP-${stamp}` && badAction?.payload?.orderIds?.[0] === `PO-BKP-${stamp}`) {
    pass('坏账快照引用：发票号/订单号 payload 留痕（闭环可见性）');
  } else fail('坏账快照', JSON.stringify(badAction?.payload)?.slice(0, 120));

  const sum = detail.data?.summary;
  if (sum?.netLoss === 61000) pass('净损失 = 申报 − 回收 − 回款 + 退运成本 = 61000（精确口径）');
  else fail('净损失', `got ${sum?.netLoss} expected 61000`);

  // 列表过滤锚点
  const list = await api('GET', `/api/v1/credit/bankruptcy?relationId=${encodeURIComponent(relationId)}`);
  const listItem = (list.data?.items ?? []).find(x => x.id === pid);
  if (listItem?.summary?.netLoss === 61000) pass('列表 relationId 过滤 + 每案汇总（净损失 61000）');
  else fail('列表过滤', `items=${(list.data?.items ?? []).length}`);

  // ── 5 边界：同客户二案 409 / 非法枚举 400 ──
  console.log('\n── 边界 ──');
  const dup = await api('POST', '/api/v1/credit/bankruptcy', { relationId, declaredAt: today, totalClaimedAmount: 1 });
  if (dup.status === 409 && dup.data?.error?.code === 'ACTIVE_PROCEEDING_EXISTS') pass('同客户二案 → 409 ACTIVE_PROCEEDING_EXISTS（唯一活跃案件）');
  else fail('二案 409', `status=${dup.status}`);

  const badType = await api('POST', `/api/v1/credit/bankruptcy/${encodeURIComponent(pid)}/actions`, { actionType: 'declare', amount: 1 });
  if (badType.status === 400 && badType.data?.error?.code === 'INVALID_ACTION_TYPE') pass('declare 经 actions 端点追加 → 400 INVALID_ACTION_TYPE');
  else fail('枚举校验', `status=${badType.status}`);

  // ── 6 闭案（终态） ──
  console.log('\n── 闭案 ──');
  const close = await api('POST', `/api/v1/credit/bankruptcy/${encodeURIComponent(pid)}/close`, { note: 'REQ2-15 债权处置完毕' });
  const closed = close.data?.proceeding;
  if (close.status === 200 && closed?.status === 'closed') {
    pass('闭案 200：status=closed（终态）');
    if (String(closed.closeNote ?? '').includes('净损失 ¥61000')) pass('closeNote 落库净损失结论（¥61000）');
    else fail('closeNote 结论', String(closed?.closeNote).slice(0, 120));
  } else fail('闭案', `status=${close.status}`);

  const afterClose = await api('POST', `/api/v1/credit/bankruptcy/${encodeURIComponent(pid)}/actions`, { actionType: 'resale', amount: 1 });
  if (afterClose.status === 409 && afterClose.data?.error?.code === 'PROCEEDING_CLOSED') pass('终态后追加动作 → 409 PROCEEDING_CLOSED');
  else fail('终态追加', `status=${afterClose.status}`);

  const reClose = await api('POST', `/api/v1/credit/bankruptcy/${encodeURIComponent(pid)}/close`, {});
  if (reClose.status === 409) pass('二次闭案 → 409');
  else fail('二次闭案', `status=${reClose.status}`);

  // 闭案不自动解冻（DR-055-③：人工决策）
  const stAfter = await api('GET', `/api/v1/credit/${encodeURIComponent(relationId)}/status`);
  if (stAfter.data?.status === 'Frozen') pass('闭案后信用仍冻结（不自动解冻，人工决策 DR-055-③）');
  else fail('闭案后冻结', `status=${stAfter.data?.status}`);

  // ── 清理：软删测试客户（破产案件 append-only 留档，符合审计语义） ──
  await api('DELETE', `/api/v2/relations/${encodeURIComponent(relationId)}`);
  console.log('\n清理：测试客户已软删（破产案件时间线 append-only 留档）');

  const failed = results.filter(r => !r.ok);
  console.log(`\n═══ REQ2-15 验收结果：${results.length - failed.length}/${results.length} 通过 ═══`);
  if (failed.length) { console.log('失败项：'); failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
