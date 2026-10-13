// REQ2-16 样品间管理 API 级实机验收
// 验收锚点（设计文档 §6 / DR-057 三决策）：
//   ① 登记出编号（SC-YYYYMMDD-NNN 递增，二维码载荷）
//   ② 借出→borrowed；在借再借 409；逾期派生标记；归还 append-only 补记
//   ③ 看样挂客户（即看即还不占借出状态）；客户不存在 400
//   ④ 退役终态（在借退役 409；退役后借出/看样 409）
//   ⑤ 权限：无 sample:room:write 角色 403；按 code 直达
const BASE = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local';
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
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // ── 1 登记两张样卡（编号递增） ──
  console.log('\n── 登记 ──');
  const a = await api('POST', '/api/v1/samples/room/items', {
    name: `REQ2-16验收苎麻面料卡${stamp}`, cardType: 'fabric', location: `A-${stamp % 50}`, colorCardCode: '19-4052 TCX',
  });
  const itemA = a.data?.item;
  if (a.status === 201 && itemA?.code?.startsWith(`SC-${day}-`)) pass(`样卡 A 登记：${itemA.code}（二维码载荷）`);
  else fail('样卡 A 登记', `status=${a.status} ${JSON.stringify(a.data)?.slice(0, 140)}`);

  const b = await api('POST', '/api/v1/samples/room/items', { name: `REQ2-16验收成衣样卡${stamp}`, cardType: 'garment' });
  const itemB = b.data?.item;
  if (b.status === 201 && itemB && Number(itemB.code.slice(-3)) === Number(itemA.code.slice(-3)) + 1) pass('样卡 B 登记且编号当日递增');
  else fail('样卡 B 编号递增', `${itemA?.code} → ${itemB?.code}`);

  const badType = await api('POST', '/api/v1/samples/room/items', { name: 'X', cardType: 'weird' });
  if (badType.status === 400) pass('cardType 枚举校验 400');
  else fail('cardType 校验', `status=${badType.status}`);

  // ── 2 借出/归还状态机 ──
  console.log('\n── 借出/归还 ──');
  const dueFuture = Date.now() + 3 * 24 * 3600 * 1000;
  const loan = await api('POST', `/api/v1/samples/room/items/${itemA.id}/loans`, {
    loanType: 'borrow', borrowerName: '验收借用人', dueAt: dueFuture,
  });
  if (loan.status === 201 && loan.data?.item?.status === 'borrowed') pass('借出 → status=borrowed');
  else fail('借出', `status=${loan.status} ${JSON.stringify(loan.data)?.slice(0, 140)}`);
  const loanId = loan.data?.loan?.id;

  const again = await api('POST', `/api/v1/samples/room/items/${itemA.id}/loans`, { loanType: 'borrow', borrowerName: '第二人' });
  if (again.status === 409) pass('在借再借 → 409 LOAN_ALREADY_ACTIVE');
  else fail('在借再借拦截', `status=${again.status}`);

  // 按编号直达（扫码路径）
  const byCode = await api('GET', `/api/v1/samples/room/items?code=${encodeURIComponent(itemA.code)}`);
  if (byCode.status === 200 && byCode?.data?.items?.length === 1 && byCode.data.items[0].activeLoan?.borrowerName === '验收借用人') {
    pass('按编号直达（扫码路径）：活跃借出摘要正确');
  } else fail('按编号直达', `status=${byCode.status}`);

  // 归还（append-only）
  const ret = await api('POST', `/api/v1/samples/room/loans/${loanId}/return`, { conditionNote: '边角轻微磨损' });
  if (ret.status === 200 && ret.data?.item?.status === 'in_stock' && ret.data.loan.conditionNote === '边角轻微磨损') {
    pass('归还 → in_stock + conditionNote 留痕');
  } else fail('归还', `status=${ret.status}`);

  const retAgain = await api('POST', `/api/v1/samples/room/loans/${loanId}/return`, {});
  if (retAgain.status === 409) pass('重复归还 → 409');
  else fail('重复归还拦截', `status=${retAgain.status}`);

  // ── 3 逾期派生 ──
  console.log('\n── 逾期 ──');
  const overdueLoan = await api('POST', `/api/v1/samples/room/items/${itemB.id}/loans`, {
    loanType: 'borrow', borrowerName: '逾期借用人', dueAt: Date.now() - 24 * 3600 * 1000,
  });
  const overdueLoanId = overdueLoan.data?.loan?.id;
  const overdueList = await api('GET', '/api/v1/samples/room/loans?overdue=true&active=true');
  if (overdueList.status === 200 && (overdueList.data?.loans ?? []).some(l => l.id === overdueLoanId && l.overdue === true)) {
    pass('逾期借出 → overdue=true 命中（在借+逾期过滤）');
  } else fail('逾期派生', `status=${overdueList.status}`);

  await api('POST', `/api/v1/samples/room/loans/${overdueLoanId}/return`, {});
  const overdueAfter = await api('GET', '/api/v1/samples/room/loans?overdue=true');
  if (!(overdueAfter.data?.loans ?? []).some(l => l.id === overdueLoanId)) pass('归还后逾期清单移除');
  else fail('归还后逾期移除', '仍命中');

  // ── 4 看样登记 ──
  console.log('\n── 看样 ──');
  // 造一个测试客户
  const rel = await api('POST', '/api/v2/relations', { name: `REQ2-16验收看样客户${stamp}`, category: 'Customer' });
  const relId = rel.data?.relation?.id;
  const viewing = await api('POST', `/api/v1/samples/room/items/${itemA.id}/loans`, {
    loanType: 'viewing', borrowerName: '看样联系人 Alice', relationId: relId,
  });
  const viewingLoan = viewing.data?.loan;
  if (viewing.status === 201 && viewingLoan?.relationName?.includes('REQ2-16') && viewingLoan.returnedAt > 0 && viewing.data.item.status === 'in_stock') {
    pass('看样挂客户快照 + 即看即还（不占借出状态）');
  } else fail('看样登记', `status=${viewing.status} ${JSON.stringify(viewing.data)?.slice(0, 140)}`);

  const badRel = await api('POST', `/api/v1/samples/room/items/${itemA.id}/loans`, { loanType: 'viewing', borrowerName: 'X', relationId: 'REL-NOPE' });
  if (badRel.status === 400) pass('看样客户不存在 → 400');
  else fail('看样客户校验', `status=${badRel.status}`);

  // ── 5 退役终态 ──
  console.log('\n── 退役 ──');
  const c = await api('POST', '/api/v1/samples/room/items', { name: `REQ2-16退役卡${stamp}`, cardType: 'other' });
  const itemC = c.data?.item;
  const cLoan = await api('POST', `/api/v1/samples/room/items/${itemC.id}/loans`, { loanType: 'borrow', borrowerName: '退役前借用人' });
  const r1 = await api('POST', `/api/v1/samples/room/items/${itemC.id}/retire`, { note: '样卡褪色报废' });
  if (r1.status === 409) pass('在借退役 → 409 ITEM_NOT_BORROWABLE');
  else fail('在借退役拦截', `status=${r1.status}`);

  await api('POST', `/api/v1/samples/room/loans/${cLoan.data?.loan?.id}/return`, {});
  const r2 = await api('POST', `/api/v1/samples/room/items/${itemC.id}/retire`, { note: '样卡褪色报废' });
  if (r2.status === 200 && r2.data?.item?.status === 'retired') pass('归还后退役成功（终态）');
  else fail('退役', `status=${r2.status}`);

  const borrowRetired = await api('POST', `/api/v1/samples/room/items/${itemC.id}/loans`, { loanType: 'borrow', borrowerName: 'X' });
  const viewRetired = await api('POST', `/api/v1/samples/room/items/${itemC.id}/loans`, { loanType: 'viewing', borrowerName: 'X' });
  if (borrowRetired.status === 409 && viewRetired.status === 409) pass('退役后借出/看样 → 409 ITEM_RETIRED');
  else fail('退役后拦截', `${borrowRetired.status}/${viewRetired.status}`);

  // 详情历史正序（借出→归还→看样）
  const detail = await api('GET', `/api/v1/samples/room/items/${itemA.id}`);
  const history = detail.data?.loans ?? [];
  if (detail.status === 200 && history.length >= 2 && history[0].loanType === 'borrow' && history[history.length - 1].loanType === 'viewing') {
    pass(`详情借还历史正序完整（${history.length} 条：borrow→viewing）`);
  } else fail('详情历史', `status=${detail.status} n=${history.length}`);

  // ── 6 权限 ──
  console.log('\n── 权限 ──');
  // finance 角色无 sample:room:write
  const finEmail = `req216-fin-${stamp}@bambook.local`;
  await api('POST', '/api/admin/users', { displayName: `REQ2-16财务${stamp}`, email: finEmail, password: 'Room@2026', roles: ['role-finance'] });
  const finLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: finEmail, password: 'Room@2026' }),
  }).then(r => r.json()).catch(() => null);
  const finCreate = await api('POST', '/api/v1/samples/room/items', { name: '越权登记' }, finLogin?.token);
  if (finCreate.status === 403) pass('finance（无 sample:room:write）登记 → 403');
  else fail('写权限拦截', `status=${finCreate.status}`);

  const finRead = await api('GET', '/api/v1/samples/room/items?limit=1', undefined, finLogin?.token);
  if (finRead.status === 200) pass('读登录即可（样卡目录非敏感）');
  else fail('读权限', `status=${finRead.status}`);

  // ── 汇总 ──
  const failed = results.filter(r => !r.ok);
  console.log(`\n══ REQ2-16 实机验收：${results.length - failed.length}/${results.length} 通过 ══`);
  if (failed.length > 0) { console.log('失败项：'); failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
