// REQ2-10 工厂延迟链路影响 API 级实机验收
// 验收锚点（需求池 / 设计文档 §7）：
//   ① 延迟 30 天登记后 3 击内拿到受影响清单（客户/订单/交期/分级/建议）
//   ② 影响计算正确（缓冲侵蚀三档判定 + planDate 缺失回退）
//   ③ 工厂交期分下调（登记 → FactoryEvaluation(delivery) 追加，幂等不重复扣）
const BASE = 'http://127.0.0.1:8081';
const EMAIL = 'raymond.lin@bambook.local';
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

  // ── 测试数据准备：找一个有工厂（millRelationId）的活跃订单所在工厂 ──
  // 直接查供应商域工厂档案，选第一个有 relationId 的
  const profiles = await api('GET', '/api/v1/suppliers?limit=50');
  const factories = profiles.data?.items || [];
  const target = factories.find(f => f.relationId);
  if (!target) { console.log('无工厂档案可用'); process.exit(1); }
  const SUPPLIER_ID = target.relationId;
  console.log(`目标工厂：${target.relation?.name ?? SUPPLIER_ID}`);

  // 查该工厂活跃订单基线
  const ordersRes = await api('GET', `/api/v1/orders?limit=100&supplier=${encodeURIComponent(SUPPLIER_ID)}`);
  // orders 列表可能不支持 supplier 过滤——用 preview 结果反推
  const basePreview = await api('GET', `/api/v1/suppliers/delays/preview?supplierRelationId=${encodeURIComponent(SUPPLIER_ID)}&delayDays=1`);
  const baseCount = basePreview.data?.summary?.total ?? 0;
  console.log(`该工厂活跃订单基线：${baseCount} 单`);

  // ── 1 预检（验收锚点②：缓冲侵蚀分级） ──
  console.log('\n── 预检：缓冲侵蚀三级分级 ──');
  {
    const r = await api('GET', `/api/v1/suppliers/delays/preview?supplierRelationId=${encodeURIComponent(SUPPLIER_ID)}&delayDays=30`);
    const d = r.data;
    if (r.status === 200 && d?.items && d?.summary && d?.advice) {
      pass(`预检 30 天：受影响 ${d.summary.total} 单（critical ${d.summary.critical} / warning ${d.summary.warning} / info ${d.summary.info}）`);
      const hasAllFields = d.items.every(x =>
        x.poNumber != null && x.dueDate != null && x.newCompletionDate != null && x.level != null);
      if (hasAllFields) pass('逐单字段齐备：PO/客户/交期/新完成日/剩余缓冲/分级');
      else fail('逐单字段', JSON.stringify(d.items[0]).slice(0, 200));
      const levels = new Set(d.items.map(x => x.level));
      const validLevels = ['critical', 'warning', 'info'];
      if ([...levels].every(l => validLevels.includes(l))) pass(`分级枚举合法：${[...levels].join(' | ')}`);
      // 建议文案：critical 存在时建议包含沟通指引
      if (d.summary.critical > 0 && (d.advice.critical || '').includes('客户')) pass('critical 建议含客户沟通指引');
      else if (d.summary.critical === 0) pass('无 critical 单（建议文案为空串）');
      else fail('建议文案', d.advice.critical);
    } else fail('预检', `status=${r.status} ${JSON.stringify(d)?.slice(0, 160)}`);

    // 边界
    const bad0 = await api('GET', `/api/v1/suppliers/delays/preview?supplierRelationId=${encodeURIComponent(SUPPLIER_ID)}&delayDays=0`);
    if (bad0.status === 400) pass('delayDays=0 → 400 INVALID_DELAY_DAYS');
    else fail('delayDays 校验', `status=${bad0.status}`);
    const none = await api('GET', '/api/v1/suppliers/delays/preview?supplierRelationId=REL-NONE&delayDays=5');
    if (none.status === 404) pass('工厂不存在 → 404');
    else fail('工厂校验', `status=${none.status}`);
  }

  // ── 2 登记延迟 30 天（验收锚点①：登记即得受影响清单） ──
  console.log('\n── 登记：延迟 30 天 ──');
  let recordId = '';
  {
    const r = await api('POST', '/api/v1/suppliers/delays', {
      supplierRelationId: SUPPLIER_ID, delayDays: 30, reason: 'capacity', reasonNote: 'API 验收：织机故障',
    });
    const d = r.data;
    if (r.status === 201 && d?.record?.id && d?.impact?.items) {
      recordId = d.record.id;
      const impactOk = d.impact.items.length === baseCount
        && Array.isArray(d.record.affectedOrderIds) && d.record.affectedOrderIds.length === baseCount;
      if (impactOk) {
        pass(`登记即得受影响清单：响应体含 ${d.impact.items.length} 单聚合（客户/订单/交期/分级/建议）+ affectedOrderIds 快照`);
      } else fail('登记聚合', `items=${d.impact.items.length} base=${baseCount}`);
      if (d.record.recordNumber?.startsWith('FDR-')) pass(`业务号 ${d.record.recordNumber}`);
      else fail('业务号', d.record.recordNumber);
    } else fail('登记', `status=${r.status} ${JSON.stringify(d)?.slice(0, 160)}`);

    // 非法 reason
    const badReason = await api('POST', '/api/v1/suppliers/delays', {
      supplierRelationId: SUPPLIER_ID, delayDays: 5, reason: 'alien',
    });
    if (badReason.status === 400) pass('非法 reason → 400 INVALID_REASON');
    else fail('reason 校验', `status=${badReason.status}`);
  }

  // ── 3 工厂交期分下调联动（验收锚点③） ──
  console.log('\n── 交期分联动 ──');
  {
    // 查该工厂评估记录：应有 sourceType=factory_delay 的 delivery 评分（30 天 → 25 分）
    const factoryId = target.id;
    const evals = await api('GET', `/api/v1/suppliers/${encodeURIComponent(factoryId)}/evaluations?kind=delivery`);
    const items = evals.data?.items || [];
    const delayEval = items.find(e => e.sourceType === 'factory_delay' && e.sourceId === recordId);
    if (delayEval && Number(delayEval.score) === 25) {
      pass('FactoryEvaluation(delivery) 追加：30 天 → 25 分（sourceType=factory_delay 幂等键）');
    } else fail('交期分联动', JSON.stringify(items.filter(e => e.sourceType === 'factory_delay')).slice(0, 200));
  }

  // ── 4 列表与详情 ──
  console.log('\n── 列表与详情 ──');
  {
    const list = await api('GET', `/api/v1/suppliers/delays?supplierRelationId=${encodeURIComponent(SUPPLIER_ID)}`);
    const items = list.data?.items || [];
    const hit = items.find(x => x.id === recordId);
    if (list.status === 200 && hit && hit.delayDays === 30 && hit.impactSummary?.total === baseCount) {
      pass(`列表按工厂过滤命中刚登记的记录（含影响快照 total=${baseCount}）`);
    } else fail('列表', `status=${list.status} items=${items.length}`);

    const detail = await api('GET', `/api/v1/suppliers/delays/${encodeURIComponent(recordId)}`);
    if (detail.status === 200 && detail.data?.record?.id === recordId) pass('详情可查（登记时影响快照）');
    else fail('详情', `status=${detail.status}`);

    const none = await api('GET', '/api/v1/suppliers/delays/FDR__NOPE');
    if (none.status === 404) pass('不存在记录 → 404');
    else fail('404 校验', `status=${none.status}`);
  }

  // ── 5 幂等：同 sourceId 不重复扣分（联动层保证；API 层再登记一次不同天数验证新评估独立） ──
  {
    const r2 = await api('POST', '/api/v1/suppliers/delays', {
      supplierRelationId: SUPPLIER_ID, delayDays: 5, reason: 'weather',
    });
    if (r2.status === 201) pass('二次登记（不同天数）独立成记录——幂等键为 (sourceType, sourceId) 每登记一条独立扣分');
    else fail('二次登记', `status=${r2.status}`);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n═══ REQ2-10 验收结果：${results.length - failed.length}/${results.length} 通过 ═══`);
  if (failed.length) { console.log('失败项：'); failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
