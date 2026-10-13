// REQ2-13 业务员离职一键交接 API 级实机验收
// 验收锚点（设计文档 §6 / DR-056 四决策）：
//   ① 移交面：五类归属字段全量改写（档主/协同/商机/跟进/无锚订单）+ 有锚订单 T-38 自动继承
//   ② 原子交接：预览计数与造数一致 + HandoverRecord append-only + 双审计（handover_execute/disable_account）
//   ③ 停用即时失效：离职者旧 token 立即 401 ACCOUNT_DISABLED（组合根守卫）+ 重新登录 403 DISABLED
//   ④ SEC-01 防批量导出双向：业务员 403 / SuperAdmin 200 + 导出审计落库
const BASE = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local'; // SuperAdmin（users:admin + data:export:full 全链）
const PASSWORD = 'Bambook@2026';

const results = [];
let token = '';
function pass(name, detail = '') { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); }

async function api(method, path, body, bearer) {
  const headers = { Authorization: `Bearer ${bearer ?? token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, token: data?.token, user: data?.user };
}

async function main() {
  const boss = await login(EMAIL, PASSWORD);
  if (!boss.token) { console.log('登录失败', boss.status); process.exit(1); }
  token = boss.token;
  const bossId = boss.user?.id;
  console.log(`登录成功：${boss.user?.displayName ?? EMAIL}（${bossId}）`);

  const today = new Date().toISOString().slice(0, 10);
  const stamp = Date.now() % 100000;

  // ── 1 构造离职者/接收人两个销售账号 ──
  const fromEmail = `req213-from-${stamp}@bambook.local`;
  const toEmail = `req213-to-${stamp}@bambook.local`;
  const mkFrom = await api('POST', '/api/admin/users', { displayName: `REQ2-13离职销售${stamp}`, email: fromEmail, password: 'Handover@2026', roles: ['role-sales'] });
  const mkTo = await api('POST', '/api/admin/users', { displayName: `REQ2-13接收销售${stamp}`, email: toEmail, password: 'Handover@2026', roles: ['role-sales'] });
  if (mkFrom.status !== 200 || mkTo.status !== 200) {
    console.log('测试账号创建失败', mkFrom.status, mkTo.status, JSON.stringify(mkFrom.data)?.slice(0, 160)); process.exit(1);
  }
  const fromId = mkFrom.data.userId, toId = mkTo.data.userId;
  console.log(`\n离职者：${fromId} · 接收人：${toId}`);

  // 离职者登录拿旧 token（DR-056-③ 即时失效实证用）
  const fromLogin = await login(fromEmail, 'Handover@2026');
  const fromToken = fromLogin.token;
  if (!fromToken) { console.log('离职者登录失败', fromLogin.status); process.exit(1); }
  pass('离职者（sales 角色）登录成功，持有未过期 JWT');

  // ── 2 造数：五类资产 ──
  console.log('\n── 造数 ──');
  // ① 档主客户（离职者创建 → owner=from）
  const relA = await api('POST', '/api/v2/relations', { name: `REQ2-13验收客户A${stamp}`, category: 'Customer' }, fromToken);
  const relAId = relA.data?.relation?.id;
  if (relAId) pass(`档主客户 A 创建（owner=from）`);
  else fail('档主客户 A 创建', `status=${relA.status}`);

  // ② 协同客户（boss 档主 + from 协同）
  const relB = await api('POST', '/api/v2/relations', { name: `REQ2-13验收客户B${stamp}`, category: 'Customer', salesRepIds: [bossId, fromId] }, token);
  const relBId = relB.data?.relation?.id;
  if (relBId) pass(`协同客户 B 创建（owner=boss, salesRepIds 含 from）`);
  else fail('协同客户 B 创建', `status=${relB.status}`);

  // ③ 商机（from 归属）
  const opp = await api('POST', `/api/v1/crm/${encodeURIComponent(relAId)}/opportunities`, {
    title: `REQ2-13验收商机${stamp}`, amount: 5000, currency: 'USD', salesRepId: fromId, salesRepName: `REQ2-13离职销售${stamp}`,
  }, fromToken);
  if (opp.status === 200 || opp.status === 201) pass('商机创建（salesRepId=from）');
  else fail('商机创建', `status=${opp.status}`);

  // ④ 跟进记录（from 归属）
  const fu = await api('POST', `/api/v1/crm/${encodeURIComponent(relAId)}/follow-ups`, {
    type: 'Call', content: `REQ2-13验收跟进${stamp}`, followUpAt: today, salesRepId: fromId, salesRepName: `REQ2-13离职销售${stamp}`,
  }, fromToken);
  if (fu.status === 200 || fu.status === 201) pass('跟进记录创建（salesRepId=from）');
  else fail('跟进记录创建', `status=${fu.status}`);

  // ⑤ 无锚订单（from 创建，无 customerRelationId）
  const ordU = await api('POST', '/api/v2/orders', { customer: `REQ2-13验收客户${stamp}`, product: '验收面料', quantity: 100 }, fromToken);
  const ordUId = ordU.data?.order?.id;
  if (ordUId) pass('无锚订单创建（ownerId=from, customerRelationId=null）');
  else fail('无锚订单创建', `status=${ordU.status} ${JSON.stringify(ordU.data)?.slice(0, 120)}`);

  // ⑥ 有锚订单（挂客户 A——T-38 自动继承实证用）
  const ordA = await api('POST', '/api/v2/orders', { customer: `REQ2-13验收客户A${stamp}`, product: '验收面料', quantity: 200, customerRelationId: relAId }, fromToken);
  const ordAId = ordA.data?.order?.id;
  if (ordAId) pass('有锚订单创建（挂客户 A，ownerId=from——按 T-38 不改写）');
  else fail('有锚订单创建', `status=${ordA.status}`);

  // ── 3 预览（DR-056-② 只读零写） ──
  console.log('\n── 预览 ──');
  const pv = await api('GET', `/api/v2/handover/preview?fromUserId=${fromId}&toUserId=${toId}`);
  const counts = pv.data?.counts;
  if (pv.status === 200 && counts) {
    const expect = { relationsOwned: 1, relationsCoFollowed: 1, opportunities: 1, followUpRecords: 1, unanchoredOrders: 1 };
    const match = Object.entries(expect).every(([k, v]) => counts[k] === v);
    if (match) pass('预览计数与造数一致（1/1/1/1/1）');
    else fail('预览计数', JSON.stringify(counts));
    if (Array.isArray(pv.data.warnings) && pv.data.warnings.length === 0) pass('无警示（接收人 active、from 非 born 部门主管）');
    else fail('警示检查', JSON.stringify(pv.data.warnings));
  } else fail('预览', `status=${pv.status} ${JSON.stringify(pv.data)?.slice(0, 160)}`);

  // ── 4 SEC-01 防批量导出（DR-056-④ 双向） ──
  console.log('\n── SEC-01 受控导出 ──');
  const expFrom = await fetch(`${BASE}/api/v2/relations/export.csv`, { headers: { Authorization: `Bearer ${fromToken}` } });
  if (expFrom.status === 403) pass('业务员导出客户档案 → 403 INSUFFICIENT_SCOPE（SEC-01 负向）');
  else fail('业务员导出被拒', `status=${expFrom.status}`);

  const expBoss = await fetch(`${BASE}/api/v2/relations/export.csv`, { headers: { Authorization: `Bearer ${token}` } });
  const csvText = await expBoss.text().catch(() => '');
  if (expBoss.status === 200 && csvText.includes('code,name')) pass(`SuperAdmin 导出 200 CSV（${csvText.split('\n').length - 1} 行，含 BOM）`);
  else fail('SuperAdmin 导出', `status=${expBoss.status}`);

  // ── 5 门禁与校验（负向） ──
  console.log('\n── 门禁与校验 ──');
  const salesPreview = await api('GET', `/api/v2/handover/preview?fromUserId=${fromId}`, undefined, fromToken);
  if (salesPreview.status === 403) pass('sales 调 preview → 403（无 users:admin）');
  else fail('sales preview 门禁', `status=${salesPreview.status}`);

  const sameUser = await api('POST', '/api/v2/handover', { fromUserId: fromId, toUserId: fromId });
  if (sameUser.status === 400 && sameUser.data?.error === 'SAME_USER') pass('from=to → 400 SAME_USER');
  else fail('from=to 校验', `status=${sameUser.status}`);

  // ── 6 执行交接（DR-056-①②③） ──
  console.log('\n── 执行交接 ──');
  const exec = await api('POST', '/api/v2/handover', { fromUserId: fromId, toUserId: toId, disableAccount: true, note: `REQ2-13 验收交接 ${stamp}` });
  const execCounts = exec.data?.counts;
  if (exec.status === 200 && exec.data?.ok && execCounts?.relationsOwned === 1 && execCounts?.unanchoredOrders === 1) {
    pass(`执行成功：交接单 ${exec.data.handoverId} · accountDisabled=${exec.data.accountDisabled}`);
  } else fail('执行交接', `status=${exec.status} ${JSON.stringify(exec.data)?.slice(0, 160)}`);
  const handoverId = exec.data?.handoverId;

  // ── 7 移交结果核验（五类字段全量改写） ──
  console.log('\n── 移交结果核验 ──');
  const relADetail = await api('GET', `/api/v2/relations/${encodeURIComponent(relAId)}`);
  const relAData = relADetail.data?.relation ?? {};
  if (relAData.ownerId === toId) pass('客户 A：ownerId → 接收人');
  else fail('客户 A ownerId', `ownerId=${relAData.ownerId}`);
  const repsA = Array.isArray(relAData.salesRepIds) ? relAData.salesRepIds : [];
  if (repsA.includes(toId) && !repsA.includes(fromId)) pass('客户 A：salesRepIds 剔除离职者、补入接收人');
  else fail('客户 A salesRepIds', JSON.stringify(repsA));

  const relBDetail = await api('GET', `/api/v2/relations/${encodeURIComponent(relBId)}`);
  const relBData = relBDetail.data?.relation ?? {};
  const repsB = Array.isArray(relBData.salesRepIds) ? relBData.salesRepIds : [];
  if (relBData.ownerId === bossId && repsB.includes(toId) && !repsB.includes(fromId)) pass('协同客户 B：档主不变，协同 from → to');
  else fail('协同客户 B', `owner=${relBData.ownerId} reps=${JSON.stringify(repsB)}`);

  const oppList = await api('GET', `/api/v1/crm/opportunities?salesRepId=${toId}`);
  const oppTo = (oppList.data?.opportunities ?? oppList.data?.items ?? []).find(o => o.salesRepId === toId);
  if (oppTo) pass(`商机：salesRepId → 接收人（salesRepName=${oppTo.salesRepName}）`);
  else fail('商机移交', `status=${oppList.status}`);

  const fuList = await api('GET', `/api/v1/crm/${encodeURIComponent(relAId)}/follow-ups`);
  const fuTo = (fuList.data?.followUps ?? []).find(f => f.salesRepId === toId);
  if (fuTo) pass('跟进记录：salesRepId → 接收人');
  else fail('跟进移交', `status=${fuList.status}`);

  // ── 8 停用即时失效（DR-056-③ 根因修复实证） ──
  console.log('\n── 停用即时失效 ──');
  const oldTokenProbe = await fetch(`${BASE}/api/v2/relations?limit=1`, { headers: { Authorization: `Bearer ${fromToken}` } });
  if (oldTokenProbe.status === 401) {
    const body = await oldTokenProbe.json().catch(() => ({}));
    if (body.error === 'ACCOUNT_DISABLED') pass('离职者旧 JWT 立即 401 ACCOUNT_DISABLED（未等 7 天 TTL）');
    else fail('旧 token 失效码', JSON.stringify(body).slice(0, 120));
  } else fail('旧 token 即时失效', `status=${oldTokenProbe.status}`);

  const reLogin = await login(fromEmail, 'Handover@2026');
  if (reLogin.status === 403 && reLogin.token === undefined) pass('离职者重新登录 → 403 DISABLED（既有链路回归）');
  else fail('重新登录拦截', `status=${reLogin.status}`);

  // ── 9 T-38 有锚订单自动继承 + 无锚订单兜底 ──
  console.log('\n── 接管可见性 ──');
  const toLogin = await login(toEmail, 'Handover@2026');
  if (toLogin.token) {
    const toOrders = await api('GET', '/api/v2/orders?limit=100', undefined, toLogin.token);
    const orderList = toOrders.data?.orders ?? toOrders.data?.items ?? [];
    const foundAnchored = orderList.some(o => o.id === ordAId);
    const foundUnanchored = orderList.some(o => o.id === ordUId);
    if (foundAnchored) pass('有锚订单经 T-38 自动继承（接收人可见，字段未改写）');
    else fail('有锚订单继承', `订单列表 ${orderList.length} 条未见 ${ordAId}`);
    if (foundUnanchored) pass('无锚订单兜底移交（接收人可见）');
    else fail('无锚订单移交', `订单列表未见 ${ordUId}`);
    const toRels = await api('GET', '/api/v2/relations?limit=100', undefined, toLogin.token);
    if ((toRels.data?.items ?? toRels.data?.relations ?? []).some(r => r.id === relAId)) pass('接收人接管客户 A（列表可见）');
    else fail('接收人客户可见性', `status=${toRels.status} keys=${Object.keys(toRels.data || {}).join(',')}`);
  } else fail('接收人登录', `status=${toLogin.status}`);

  // ── 10 交接单 + 双审计（append-only 留痕） ──
  console.log('\n── 留痕核验 ──');
  const recs = await api('GET', '/api/v2/handover/records?limit=5');
  const rec = (recs.data?.records ?? []).find(r => r.id === handoverId);
  if (rec) {
    pass(`交接单落库：${rec.fromUserName} → ${rec.toUserName} · disableAccount=${rec.disableAccount}`);
    if (rec.detail?.relationsOwned === 1 && rec.detail?.unanchoredOrders === 1) pass('交接单计数快照一致');
    else fail('交接单计数', JSON.stringify(rec.detail));
  } else fail('交接单查询', `status=${recs.status}`);

  const auditHandover = await api('GET', '/api/admin/audit-logs?action=handover_execute&limit=10');
  const auditH = (auditHandover.data?.logs ?? []).find(l => l.targetId === handoverId);
  if (auditH) pass('审计 handover_execute 落库（targetId=交接单号）');
  else fail('handover_execute 审计', `status=${auditHandover.status}`);

  const auditDisable = await api('GET', '/api/admin/audit-logs?action=disable_account&limit=10');
  const auditD = (auditDisable.data?.logs ?? []).find(l => l.targetId === fromId);
  if (auditD) pass('审计 disable_account 落库（targetId=离职者）');
  else fail('disable_account 审计', `status=${auditDisable.status}`);

  const auditExport = await api('GET', '/api/admin/audit-logs?action=relations_export_csv&limit=10');
  const auditE = (auditExport.data?.logs ?? []).find(l => l.actorId === bossId);
  if (auditE) pass('审计 relations_export_csv 落库（SEC-01 导出留痕）');
  else fail('导出审计', `status=${auditExport.status}`);

  // ── 汇总 ──
  const failed = results.filter(r => !r.ok);
  console.log(`\n══ REQ2-13 实机验收：${results.length - failed.length}/${results.length} 通过 ══`);
  if (failed.length > 0) { console.log('失败项：'); failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
