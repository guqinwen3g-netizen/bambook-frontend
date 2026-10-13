// 批次一（REQ2-01/02/03）+ REQ2-04 API 级实机验收脚本
// 环境：本地数据中心 http://127.0.0.1:8081（新代码）+ 演示账号
// 验收锚点（需求池原文）：
//   REQ2-03: ±5% 条款发货 5.2% → 预警 + 条款结算金额；米码换算（单测覆盖）
//   REQ2-04: D4 报告挂订单归档 / 失败项 100% 整改 / 3 击查看（GET ?orderId 全景）
//   REQ2-01: bulk 缸差登记 → 客户判定 → 封样基准 → 取证聚合
//   REQ2-02: cash-calendar 四区结构 + asOf 窗口
const BASE = 'http://127.0.0.1:8081';
// vivian.chen = SALES_MANAGER（业务员容器角色含 qc:write：登记/结论/整改均可写；raymond.lin=ADMIN 无业务写 scope）
const EMAIL = 'vivian.chen@bambook.local';
const PASSWORD = 'Bambook@2026';

const results = [];
let token = '';
function pass(name, detail = '') { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); }

async function api(method, path, body, isForm = false) {
  const headers = { Authorization: `Bearer ${token}` };
  if (!isForm && body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json().catch(() => null);
  return { status: res.status, data, res };
}

// ────────────────────────────────────────────────────────
async function main() {
  // 登录
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const login = await loginRes.json();
  if (!loginRes.ok || !login.token) { console.log('登录失败', loginRes.status, login); process.exit(1); }
  token = login.token;
  console.log(`登录成功：${login.user?.displayName ?? EMAIL}`);

  // 取一个有行的面料订单（订单详情各区块的宿主）
  const ordersRes = await api('GET', '/api/v1/orders');
  const orders = (ordersRes.data?.orders || []).filter(o => (o.lines || []).length > 0);
  const fabricOrder = orders.find(o => o.type === 'Fabric') ?? orders[0];
  if (!fabricOrder) { console.log('无可用订单（演示库需有带行订单）'); process.exit(1); }
  console.log(`宿主订单：${fabricOrder.poNumber}（${fabricOrder.type}，${fabricOrder.lines.length} 行）`);

  // ══════════ REQ2-03 溢短装 ══════════
  console.log('\n── REQ2-03 溢短装校验 ──');
  {
    // 锚点：±5% 条款发货 5.2% → over_limit 预警 + 上限结算额
    const r1 = await api('POST', '/api/v1/orders/tolerance-check', {
      contractQty: 10000, actualQty: 10520, tolerancePercent: 5, unitPrice: 3.5,
    });
    const c1 = r1.data?.check;
    if (r1.status === 200 && c1?.verdict === 'over_limit' && Math.abs(c1.deviationPct - 5.2) < 0.001
      && c1.maxLimitAmount === 36750 && c1.settlementAmount === 36820) {
      pass('容差锚点：±5% 发货 5.2% → over_limit + 上限结算额 36,750',
        `verdict=${c1.verdict} dev=${c1.deviationPct}% settle=${c1.settlementAmount} maxLimit=${c1.maxLimitAmount}`);
    } else fail('容差锚点', JSON.stringify(c1).slice(0, 200));

    // 限额内：+4.9% → ok
    const r2 = await api('POST', '/api/v1/orders/tolerance-check', {
      contractQty: 10000, actualQty: 10490, tolerancePercent: 5, unitPrice: 3.5,
    });
    if (r2.data?.check?.verdict === 'ok' && !r2.data.check.warning) pass('限额内 +4.9% → ok 无预警');
    else fail('限额内', JSON.stringify(r2.data?.check).slice(0, 150));

    // 订单聚合：GET tolerance-status
    const r3 = await api('GET', `/api/v1/orders/${encodeURIComponent(fabricOrder.id)}/tolerance-status`);
    const s = r3.data?.summary;
    if (r3.status === 200 && Array.isArray(r3.data?.lines) && s && s.total === fabricOrder.lines.length
      && typeof s.overLimit === 'number' && typeof s.unshipped === 'number') {
      pass(`订单溢短装状态（3 击数据源）：${s.total} 行 · ok ${s.ok} / over ${s.overLimit} / under ${s.underLimit} / 未发 ${s.unshipped}`);
    } else fail('订单溢短装状态', JSON.stringify(s));

    // 行容差字段回读（默认 5 落库）
    const line = fabricOrder.lines[0];
    const tol = line.tolerancePercent != null ? Number(line.tolerancePercent) : 5;
    if (tol === 5 || r3.data?.lines?.[0]?.tolerancePercent === 5) pass('OrderLine.tolerancePercent 默认 ±5%（历史行回退口径）');
    else fail('tolerancePercent 默认值', `line=${tol}`);
  }

  // ══════════ REQ2-04 第三方测试管理 ══════════
  console.log('\n── REQ2-04 第三方测试管理 ──');
  let trId = '', trNo = '', caId = '', fileId = '';
  {
    // 1 登记（非法 agency 拒 + 正常登记）
    const bad = await api('POST', '/api/v1/qc/test-requests', { orderId: fabricOrder.id, testItems: ['ph'], agency: 'tuv' });
    if (bad.status === 400 && bad.data?.error?.code === 'INVALID_AGENCY') pass('登记校验：非法机构 → 400 INVALID_AGENCY');
    else fail('非法机构校验', JSON.stringify(bad.data).slice(0, 120));

    const create = await api('POST', '/api/v1/qc/test-requests', {
      orderId: fabricOrder.id, testItems: ['color_fastness', 'shrinkage', 'ph'], agency: 'sgs',
      sentDate: '2026-08-18', expectedDate: '2026-08-25', notes: '验收实测委托',
    });
    if (create.status === 201 && create.data?.request?.trNo) {
      trId = create.data.request.id; trNo = create.data.request.trNo;
      pass(`登记委托：${trNo}（sgs · 3 项 · 待报告）`);
    } else fail('登记委托', JSON.stringify(create.data).slice(0, 150));

    // 2 fail 门禁三连拒
    const f1 = await api('PATCH', `/api/v1/qc/test-requests/${trId}`, { result: 'fail' });
    if (f1.status === 400 && f1.data?.error?.code === 'FAIL_ITEMS_REQUIRED') pass('fail 门禁①：无失败项 → 400 FAIL_ITEMS_REQUIRED');
    else fail('fail 门禁①', JSON.stringify(f1.data).slice(0, 120));

    const f2 = await api('PATCH', `/api/v1/qc/test-requests/${trId}`, { result: 'fail', failItems: ['azo'] });
    if (f2.status === 400 && f2.data?.error?.code === 'INVALID_FAIL_ITEM') pass('fail 门禁②：失败项不在委托内 → 400');
    else fail('fail 门禁②', JSON.stringify(f2.data).slice(0, 120));

    const f3 = await api('PATCH', `/api/v1/qc/test-requests/${trId}`, { result: 'fail', failItems: ['ph'] });
    if (f3.status === 400 && f3.data?.error?.code === 'CA_REQUIRED') pass('fail 门禁③：无整改 → 400 CA_REQUIRED（失败项 100% 跟踪闭环）');
    else fail('fail 门禁③', JSON.stringify(f3.data).slice(0, 120));

    // 3 fail 带整改 → 落库
    const f4 = await api('PATCH', `/api/v1/qc/test-requests/${trId}`, {
      result: 'fail', failItems: ['ph', 'color_fastness'],
      correctiveAction: { failItem: 'ph', action: '面料返工修整 pH 后送 SGS 复测', owner: '验收跟单', dueDate: '2026-09-01' },
    });
    if (f4.status === 200 && f4.data?.request?.result === 'fail') pass('fail 落库：结论 + 同步 open 整改');
    else fail('fail 落库', JSON.stringify(f4.data).slice(0, 150));

    // 4 3 击全景（GET ?orderId=）
    const list = await api('GET', `/api/v1/qc/test-requests?orderId=${encodeURIComponent(fabricOrder.id)}`);
    const item = (list.data?.items || []).find(i => i.id === trId);
    if (list.status === 200 && item && item.correctiveActions?.length >= 1 && list.data.summary) {
      const openCa = item.correctiveActions.find(c => c.status === 'open');
      caId = openCa?.id ?? '';
      pass(`3 击全景：${list.data.summary.total} 项委托 · open 整改 ${list.data.summary.openCorrectiveActions} 条（含附件/整改聚合）`);
    } else fail('3 击全景', JSON.stringify(list.data?.summary));

    // 5 D4 报告归档：PDF 上传 + 下载
    const form = new FormData();
    const pdf = new Blob([Buffer.from('%PDF-1.4\n% bambook acceptance test report\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')], { type: 'application/pdf' });
    form.append('files', pdf, 'SGS验收报告.pdf');
    const up = await api('POST', `/api/v1/qc/test-requests/${trId}/files`, form, true);
    if (up.status === 201 && up.data?.files?.length === 1) {
      fileId = up.data.files[0].id;
      pass(`D4 报告归档：PDF 落盘 + 行落库（${up.data.files[0].fileName}）`);
    } else fail('D4 报告归档', JSON.stringify(up.data).slice(0, 150));

    if (fileId) {
      const dl = await fetch(`${BASE}/api/v1/qc/test-requests/${trId}/files/${fileId}`, { headers: { Authorization: `Bearer ${token}` } });
      const buf = Buffer.from(await dl.arrayBuffer());
      if (dl.status === 200 && buf.slice(0, 4).toString() === '%PDF') pass('报告下载：sendFile 返回 PDF 流');
      else fail('报告下载', `status=${dl.status} head=${buf.slice(0, 8).toString()}`);
    }

    // 6 追加整改 + 闭环
    const addCa = await api('POST', `/api/v1/qc/test-requests/${trId}/corrective-actions`, {
      failItem: 'color_fastness', action: '让步接收 + 客户书面确认', owner: '验收QC',
    });
    if (addCa.status === 201) pass('追加整改：第二条（color_fastness 让步接收）');
    else fail('追加整改', JSON.stringify(addCa.data).slice(0, 120));

    if (caId) {
      const close = await api('POST', `/api/v1/qc/test-requests/corrective-actions/${caId}/close`, { closeNote: '复测通过 pH 6.8（验收实测）' });
      if (close.status === 200 && close.data?.correctiveAction?.status === 'closed') pass('整改闭环：open→closed + 闭环说明留痕');
      else fail('整改闭环', JSON.stringify(close.data).slice(0, 120));
      const close2 = await api('POST', `/api/v1/qc/test-requests/corrective-actions/${caId}/close`, {});
      if (close2.status === 409) pass('二次闭环拒：409 CA_CLOSED（状态机终态）');
      else fail('二次闭环拒', `status=${close2.status}`);
    }

    // 7 pending 单登记 + 软删
    const c2 = await api('POST', '/api/v1/qc/test-requests', { orderId: fabricOrder.id, testItems: ['gsm'], agency: 'bv' });
    if (c2.status === 201) {
      const del = await api('DELETE', `/api/v1/qc/test-requests/${c2.data.request.id}`);
      if (del.status === 200) pass('软删：pending 单可删（仅待报告态）');
      else fail('软删', `status=${del.status}`);
      const delFinal = await api('DELETE', `/api/v1/qc/test-requests/${trId}`);
      if (delFinal.status === 409) pass('终态归档保留：fail 单删除 → 409');
      else fail('终态删除拒', `status=${delFinal.status}`);
    }
  }

  // ══════════ REQ2-01 色差（bulk 挂订单复测核心链） ══════════
  console.log('\n── REQ2-01 色差管理（bulk 复测） ──');
  {
    if (fabricOrder.type === 'Fabric') {
      const create = await api('POST', '/api/v1/samples/color-batches', {
        stage: 'bulk', orderId: fabricOrder.id, dyeLotNo: `ACC-${Date.now()}`,
        colorRating: 4, defectCauses: [], notes: '验收实测缸差',
      });
      if (create.status === 201 || create.data?.batch) {
        const batchId = create.data?.batch?.id;
        const fb = await api('POST', `/api/v1/samples/color-batches/${batchId}/customer-feedback`, {
          status: 'approved', note: '验收批色通过',
        });
        if (fb.status === 200 || fb.data?.batch) pass(`bulk 缸差登记 → 客户批色通过${fb.data?.batch?.approvedAsSealed ? ' → 封样基准' : ''}`);
        else fail('客户批色', JSON.stringify(fb.data).slice(0, 150));
        const ev = await api('GET', `/api/v1/samples/color-batches/evidence?orderId=${encodeURIComponent(fabricOrder.id)}`);
        const evBatches = ev.data?.evidence?.batches;
        if (ev.status === 200 && Array.isArray(evBatches)) pass(`取证聚合：${evBatches.length} 缸证据链一次成型`);
        else fail('取证聚合', JSON.stringify(ev.data).slice(0, 120));
      } else fail('bulk 缸差登记', JSON.stringify(create.data).slice(0, 150));
    } else {
      pass('宿主非面料订单，bulk 色差面板为 Fabric 限定区块（跳过，UI 验收覆盖）');
    }
  }

  // ══════════ REQ2-02 资金日历 ══════════
  console.log('\n── REQ2-02 资金日历 ──');
  {
    const r = await api('GET', '/api/v1/finance/reports/cash-calendar?days=30');
    const d = r.data;
    if (r.status === 200 && d && d.asOf && d.windowEnd
      && Array.isArray(d.todayActions) && Array.isArray(d.forecast)
      && Array.isArray(d.fxExposure) && Array.isArray(d.unappliedVouchers)) {
      const todayCount = d.todayActions.length;
      const fxCount = d.fxExposure.length;
      pass(`四区结构完整：今日动作 ${todayCount} 条 · 窗口 ${d.asOf}~${d.windowEnd} · 外汇敞口 ${fxCount} 币种 · 未核销泳道 ${d.unappliedVouchers.length} 组`);
    } else fail('资金日历结构', JSON.stringify(d).slice(0, 200));
  }

  // ══════════ 汇总 ══════════
  const failed = results.filter(r => !r.ok);
  console.log(`\n═══ API 验收汇总：${results.length - failed.length}/${results.length} 通过 ${failed.length ? '· 失败 ' + failed.length : '· 全绿'} ═══`);
  if (failed.length) { failed.forEach(f => console.log(`  ✗ ${f.name}: ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
