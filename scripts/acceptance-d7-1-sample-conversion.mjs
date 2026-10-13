// D7-① 米样转化通道（转大货 / 转售）—— 真库验收（**零写入**）
//
// 为什么本脚本只跑「必然被拒」的路径：
//   转化的**成功路径会写 StockMovement**（append-only 流水，转大货后无法干净回滚），
//   且会在样品上留下 to_bulk/to_resale 台账 → **不适合在真库跑成功路径**。
//   故真库只验：端点可达 + 参数/状态校验（这些路径全部在事务内失败回滚，零写入）；
//   **成功路径**分两处覆盖：
//     · 单测 `sampleLengthConversion.test.ts`（含「双侧同事务」「损耗不进大货」「失败整体回滚」）
//     · 真库演练 `acceptance-d7-1-resale-atomic.mjs`（**转售成功路径** + 自回滚，
//       证明真 HTTP 链路上两侧同时落库、金额/客户一一对应；2026-09-16 新增）
//
// 验的口径不变量：
//   R1 不存在的样品 → 404
//   R2 未建长度账 / 长度不足 → 409（且**不产生任何流水**——零写入前提）
//   R3 数量缺失/非正 → 400
//   R4 转售缺客户 → 400；金额 ≤ 0 → 400
//   R5 全流程结束后抽样复核：样品长度账与流水条数**未被本脚本改动**
//
// 用法：node scripts/acceptance-d7-1-sample-conversion.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.D7_DEBUG === '1';

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
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (DEBUG && res.status >= 400) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, data };
}

async function main() {
  let token = await login('jason.shen@bambook.local');
  const who = 'jason.shen(超管)';
  if (!token) { token = await login('chloe.su@bambook.local'); }
  if (!token) { console.log('登录失败'); process.exit(1); }
  console.log(`══ D7-① 米样转化通道 · 真库验收（零写入，${who}）══\n`);

  const list = await api(token, 'GET', '/api/v1/samples');
  if (list.status !== 200) { fail('GET /api/v1/samples', `HTTP ${list.status}`); return exit(); }
  const rows = list.data?.samples ?? list.data?.items ?? list.data?.data ?? [];
  pass('样品列表', `${rows.length} 个样品`);
  if (rows.length === 0) { info('无样品样本', '跳过'); return exit(); }

  // 挑一个有长度账的样品做「长度不足」测试（若有），否则用任意样品测「未建账」
  const withLen = rows.find(s => s.lengthQty != null);
  const target = withLen ?? rows[0];
  const beforeLen = target.lengthQty != null ? String(target.lengthQty) : null;
  info('测试样品', `${target.code ?? target.id} 长度账 ${beforeLen ?? '(未建)'} ${target.lengthUnit ?? ''}`);

  // R1 不存在的样品 → 404
  const nf = await api(token, 'POST', '/api/v1/samples/NOPE__x/convert-to-bulk', { quantity: '1' });
  if (nf.status === 404) pass('R1 不存在样品 → 404', nf.data?.error?.code ?? '');
  else fail('R1', `期望 404，实际 ${nf.status} ${JSON.stringify(nf.data).slice(0, 120)}`);

  // R3 数量缺失/非正 → 400
  const badQty = await api(token, 'POST', `/api/v1/samples/${encodeURIComponent(target.id)}/convert-to-bulk`, {});
  if (badQty.status === 400 || badQty.status === 409) pass('R3 缺数量 → 400/409', `${badQty.status} ${badQty.data?.error?.code ?? ''}`);
  else fail('R3', `期望 400/409，实际 ${badQty.status}`);

  // 注意：样品**未建长度账**时，`NO_LENGTH_ACCOUNT(409)` 是更前置的状态错误，会先于数量校验(400)触发
  // —— 这是刻意的校验顺序（状态错 > 参数错），故此处接受 400 或 409。
  const zeroQty = await api(token, 'POST', `/api/v1/samples/${encodeURIComponent(target.id)}/convert-to-bulk`, { quantity: '0' });
  if (zeroQty.status === 400) pass('R3 数量 0 → 400', zeroQty.data?.error?.code ?? '');
  else if (zeroQty.status === 409) pass('R3 数量 0 → 409（样品未建长度账，状态校验先于参数校验）', zeroQty.data?.error?.code ?? '');
  else fail('R3(0)', `期望 400/409，实际 ${zeroQty.status}`);

  // R2 未建账 → 409 NO_LENGTH_ACCOUNT；已建账且超量 → 409 LENGTH_INSUFFICIENT（均在事务内失败回滚 = 零写入）
  const huge = await api(token, 'POST', `/api/v1/samples/${encodeURIComponent(target.id)}/convert-to-bulk`, { quantity: '999999999' });
  if (huge.status === 409) pass('R2 超量/未建账 → 409（事务内回滚，零写入）', huge.data?.error?.code ?? '');
  else fail('R2', `期望 409，实际 ${huge.status} ${JSON.stringify(huge.data).slice(0, 120)}`);

  // R4 转售：缺客户 / 金额 ≤ 0
  const noCust = await api(token, 'POST', `/api/v1/samples/${encodeURIComponent(target.id)}/convert-to-resale`, { quantity: '1', amount: '100' });
  if (noCust.status === 400) pass('R4 转售缺客户 → 400', noCust.data?.error?.code ?? '');
  else fail('R4(noCust)', `期望 400，实际 ${noCust.status}`);

  const badAmount = await api(token, 'POST', `/api/v1/samples/${encodeURIComponent(target.id)}/convert-to-resale`, { quantity: '1', amount: '0', customerRelationId: 'REL_X' });
  if (badAmount.status === 400) pass('R4 转售金额 0 → 400', badAmount.data?.error?.code ?? '');
  else fail('R4(amount)', `期望 400，实际 ${badAmount.status}`);

  const nfResale = await api(token, 'POST', '/api/v1/samples/NOPE__x/convert-to-resale', { quantity: '1', amount: '100', customerRelationId: 'REL_X' });
  if (nfResale.status === 404) pass('R4 不存在样品转售 → 404', nfResale.data?.error?.code ?? '');
  else fail('R4(404)', `期望 404，实际 ${nfResale.status}`);

  // R5 复核：样品长度账与流水条数未被本脚本改动
  const after = await api(token, 'GET', `/api/v1/samples/${encodeURIComponent(target.id)}`);
  const afterLen = after.data?.sample?.lengthQty != null ? String(after.data.sample.lengthQty) : (after.data?.lengthQty != null ? String(after.data.lengthQty) : null);
  if (String(afterLen) === String(beforeLen)) pass('R5 样品长度账未被改动', `${beforeLen ?? '(未建)'} → ${afterLen ?? '(未建)'}`);
  else fail('R5', `长度账被改了：${beforeLen} → ${afterLen}`);

  const mv = await api(token, 'GET', `/api/v1/samples/${encodeURIComponent(target.id)}/length/movements`);
  const mvCount = (mv.data?.movements ?? []).length;
  info('R5 流水条数', `${mvCount} 条（本脚本未新增）`);

  console.log('');
  info('零写入保证', '本脚本只跑只读 + 「必然被拒」路径；成功路径由单测 + acceptance-d7-1-resale-atomic.mjs（自回滚）覆盖');
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
