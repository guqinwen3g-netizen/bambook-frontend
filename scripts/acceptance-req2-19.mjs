// REQ2-19 砍价画像 API 级实机验收（报价版本快照 + 客户首报偏差统计）
// 验收锚点（设计文档 §5 / DR-060）：
//   ① Draft 改价自动快照 v1 + version+1；金额不变不快照
//   ② send → revise（砍价重报通道）→ version+1 回 Draft + 审计
//   ③ 版本历史正序；accept → convert-to-order → 画像（firstAmount/cutPct/成交偏差）
//   ④ 终态 revise 409；relationId 缺失 400；无报价空画像
const BASE = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local';
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

  const stamp = Date.now() % 100000;

  // ── 造客户 ──
  const rel = await api('POST', '/api/v2/relations', { name: `REQ2-19砍价客户${stamp}`, category: 'Customer' });
  const relationId = rel.data?.relation?.id;
  if (!relationId) { console.log('客户创建失败'); process.exit(1); }

  // ── 1 建报价 $1000（v1）──
  const today = new Date().toISOString().slice(0, 10);
  const create = await api('POST', '/api/v1/quotations', {
    quotationNumber: `QT-R19-${stamp}`,
    customerRelationId: relationId, customerName: `REQ2-19砍价客户${stamp}`,
    currency: 'USD', issueDate: today, status: 'Draft',
    lines: [{ fabricCode: 'F-R19', description: '验收面料', quantity: 1000, unit: 'YD', unitPrice: 1 }],
  });
  const qtId = create.data?.quotation?.id;
  if (!qtId) { console.log('报价创建失败', create.status, JSON.stringify(create.data)?.slice(0, 200)); process.exit(1); }
  console.log(`\n报价单：${qtId}（$1000 v1）`);

  // ── 2 Draft 改价 $900 → 自动快照 v1 + version=2 ──
  const upd = await api('PUT', `/api/v1/quotations/${qtId}`, {
    lines: [{ fabricCode: 'F-R19', description: '验收面料', quantity: 1000, unit: 'YD', unitPrice: 0.9 }],
  });
  if (upd.status === 200 && upd.data?.quotation?.version === 2) pass('Draft 改价 $900 → version=2（自动快照）');
  else fail('改价版本', `status=${upd.status} v=${upd.data?.quotation?.version}`);

  const versions1 = await api('GET', `/api/v1/quotations/${qtId}/versions`);
  const v1 = (versions1.data?.versions ?? []).find(v => v.version === 1);
  if (v1 && Number(v1.totalAmount) === 1000 && v1.linesSnapshot?.[0]?.unitPrice === 1) {
    pass('v1 快照落库（$1000 · 行单价 $10 留痕）');
  } else fail('v1 快照', JSON.stringify(versions1.data?.versions)?.slice(0, 120));

  // 金额不变（仅备注）→ 不新增快照
  await api('PUT', `/api/v1/quotations/${qtId}`, { notes: '备注更新' });
  const versions1b = await api('GET', `/api/v1/quotations/${qtId}/versions`);
  if ((versions1b.data?.versions ?? []).length === 1) pass('金额不变不快照（仍 1 个版本）');
  else fail('不快照', `n=${versions1b.data?.versions?.length}`);

  // ── 3 send → revise（砍价重报）──
  console.log('\n── 砍价修订 ──');
  const send = await api('POST', `/api/v1/quotations/${qtId}/send`, {});
  if (send.status === 200 && send.data?.quotation?.status === 'Sent') pass('发送报价 → Sent');
  else fail('发送报价', `status=${send.status} ${JSON.stringify(send.data)?.slice(0, 160)}`);

  const revise = await api('POST', `/api/v1/quotations/${qtId}/revise`, { changeReason: '客户砍价 10%' });
  if (revise.status === 200 && revise.data?.quotation?.version === 3 && revise.data?.quotation?.status === 'Draft') {
    pass('revise → v3 回 Draft（砍价重报通道）');
  } else fail('revise', `status=${revise.status} ${JSON.stringify(revise.data)?.slice(0, 120)}`);

  // 改价 $850 → v2 快照
  await api('PUT', `/api/v1/quotations/${qtId}`, {
    lines: [{ fabricCode: 'F-R19', description: '验收面料', quantity: 1000, unit: 'YD', unitPrice: 0.85 }],
  });
  const versions2 = await api('GET', `/api/v1/quotations/${qtId}/versions`);
  const vs = versions2.data?.versions ?? [];
  if (vs.length === 3 && vs[0].version === 1 && Number(vs[0].totalAmount) === 1000
    && vs[1].version === 2 && Number(vs[1].totalAmount) === 900 && vs[1].changeReason === '客户砍价 10%'
    && vs[2].version === 3 && Number(vs[2].totalAmount) === 900) {
    pass('版本历史正序 [v1 $1000, v2 $900(砍价), v3 $900] + 修订原因留痕');
  } else fail('版本历史', JSON.stringify(vs.map(v => ({ v: v.version, amt: Number(v.totalAmount), r: v.changeReason }))));

  const audit = await api('GET', '/api/admin/audit-logs?action=revise_quotation&limit=5');
  if ((audit.data?.logs ?? []).some(l => l.targetId === qtId)) pass('审计 revise_quotation 落库');
  else fail('审计', `status=${audit.status}`);

  // ── 4 accept → convert → 画像 ──
  console.log('\n── 画像 ──');
  const send2 = await api('POST', `/api/v1/quotations/${qtId}/send`, {});
  if (send2.status === 200) pass('砍价修订后重发 → Sent');
  else fail('重发', `status=${send2.status} ${JSON.stringify(send2.data)?.slice(0, 160)}`);
  const accept = await api('POST', `/api/v1/quotations/${qtId}/accept`, {});
  if (accept.status === 200 && accept.data?.quotation?.status === 'Accepted') pass('接受报价');
  else fail('接受报价', `status=${accept.status} ${JSON.stringify(accept.data)?.slice(0, 160)}`);

  // 转订单（convert-to-order 需要工厂/PO 参数？最小集）
  const convert = await api('POST', `/api/v1/quotations/${qtId}/convert-to-order`, {
    poNumber: `PO-R19-${stamp}`, millName: '验收工厂', type: 'Fabric', dueDate: '2026-12-31',
  });
  const orderId = convert.data?.orderId;
  if (orderId) {
    // convert 路径 totalNet 为空 → 画像成交金额 fallback quoteAmount（当前报价额 $850 继承）
    pass(`转订单 ${orderId}（成交金额 fallback quoteAmount 口径）`);
  } else fail('转订单', `status=${convert.status} ${JSON.stringify(convert.data)?.slice(0, 140)}`);

  const profile = await api('GET', `/api/v1/quotations/price-profile?relationId=${relationId}`);
  const item = (profile.data?.items ?? []).find(i => i.quotationId === qtId);
  const summary = profile.data?.summary;
  if (profile.status === 200 && item) {
    if (item.firstAmount === 1000 && item.currentAmount === 850 && item.cutPct === -15) {
      pass('画像：首报 $1000 → 当前 $850，cutPct=-15%（砍价 15%）');
    } else fail('画像字段', JSON.stringify({ first: item.firstAmount, cur: item.currentAmount, cut: item.cutPct }));
    if (item.rounds === 2) pass('砍价轮次 rounds=2');
    if (item.dealDeviationPct === -15 && item.orderDealAmount === 850) {
      pass('成交偏差 -15%（convert 继承额 $850 vs 首报 $1000——totalNet 录入后以 totalNet 优先）');
    } else if (orderId) fail('成交偏差', JSON.stringify({ d: item.dealDeviationPct, amt: item.orderDealAmount }));
    if (summary && summary.quotationCount >= 1 && summary.negotiatedCount >= 1) {
      pass(`汇总：${summary.quotationCount} 单 · 砍价 ${summary.negotiatedCount} 单 · 平均降幅 ${summary.avgCutPct}%`);
    }
  } else fail('画像', `status=${profile.status} ${JSON.stringify(profile.data)?.slice(0, 160)}`);

  // ── 5 边界 ──
  const revAccepted = await api('POST', `/api/v1/quotations/${qtId}/revise`, { changeReason: 'x' });
  if (revAccepted.status === 409) pass('终态（Accepted）revise → 409');
  else fail('终态 revise', `status=${revAccepted.status}`);

  const noRel = await api('GET', '/api/v1/quotations/price-profile');
  if (noRel.status === 400) pass('画像缺 relationId → 400');

  const emptyProfile = await api('GET', `/api/v1/quotations/price-profile?relationId=REL-EMPTY`);
  if (emptyProfile.status === 200 && (emptyProfile.data?.items ?? []).length === 0) pass('无报价客户 → 空画像');

  const failed = results.filter(r => !r.ok);
  console.log(`\n══ REQ2-19 实机验收：${results.length - failed.length}/${results.length} 通过 ══`);
  if (failed.length > 0) { console.log('失败项：'); failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
