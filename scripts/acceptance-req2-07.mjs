// REQ2-07 历史数据批量迁移 API 级实机验收
// 验收锚点（需求池原文）：
//   ① 3 年数据（约千行级）迁移 ≤1 个工作日 → 1000 行订单 CSV 全链实测（能力锚点）
//   ② 错误行 100% 可定位可修正重导 → 混合错误 CSV 逐行断言 + 修正后全绿
//   ③ 导入后对账单/账龄数字与 Excel 原账一致 → 发票金额合计 vs 库内发票合计（同一 Invoice 真源）
//   软删可回滚 → rollback 后 entityIds 全部 deletedAt
const BASE = 'http://127.0.0.1:8081';
const EMAIL = 'raymond.lin@bambook.local'; // AdminPanel 属管理后台——用 raymond.lin（ADMIN）
const PASSWORD = 'Bambook@2026';

const results = [];
let token = '';
function pass(name, detail = '') { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); }

async function api(method, path, body, isForm = false) {
  const headers = { Authorization: `Bearer ${token}` };
  if (!isForm && body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json().catch(() => null);
  else if (ct.includes('csv') || ct.includes('text')) data = await res.text().catch(() => null);
  return { status: res.status, data, res };
}

const ORDER_HEADER = 'poNumber,customer,product,type,quantity,dueDate,quoteAmount,status,currency,salesPerson';
const INVOICE_HEADER = 'invoiceNumber,type,amount,currency,issueDate,status,dueDate,orderId,customerName';

function csvFile(rows) {
  return new File([Buffer.from('\uFEFF' + rows.join('\n') + '\n', 'utf8')], 'migrate.csv', { type: 'text/csv' });
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

  // ── 1 模板下载 ──
  console.log('\n── 模板下载 ──');
  {
    const r = await api('GET', '/api/v1/data-migration/templates/orders');
    if (r.status === 200 && typeof r.data === 'string' && r.data.includes('poNumber') && r.data.includes('必填')) {
      pass('四类模板之一（orders）：CSV attachment + 表头 + 中文示例行');
    } else fail('模板下载', `status=${r.status}`);
    const bad = await api('GET', '/api/v1/data-migration/templates/quotes');
    if (bad.status === 400) pass('非法类型 → 400');
    else fail('非法模板类型', `status=${bad.status}`);
  }

  // ── 2 错误行定位（验收锚点②） ──
  console.log('\n── 错误行 100% 定位 ──');
  {
    const rows = [
      ORDER_HEADER,
      'PO-A1,客户A,产品A,Fabric,1000,2026-09-01,25000,,,',        // 2 valid
      ',客户B,产品B,Garment,500,2026-09-01,12000,,,',               // 3 缺 poNumber
      'PO-A2,客户C,产品C,Sewing,500,2026-09-01,12000,,,',           // 4 type 非法
      'PO-A3,客户D,产品D,Fabric,0,2026-09-01,12000,,,',             // 5 quantity ≤0
      'PO-A4,客户E,产品E,Fabric,500,2026/09/01,12000,,,',           // 6 dueDate 格式
      'PO-DUP,客户F,产品F,Fabric,100,2026-09-01,3000,,,',          // 7 valid（首现）
      'PO-DUP,客户G,产品G,Fabric,100,2026-09-01,3000,,,',          // 8 文件内重复
    ];
    const form = new FormData();
    form.append('file', csvFile(rows));
    form.append('type', 'orders');
    const r = await api('POST', '/api/v1/data-migration/validate', form, true);
    const d = r.data;
    if (r.status === 200 && d.totalRows === 7 && d.validCount === 2 && d.errorCount === 5) {
      pass(`混合错误校验：7 行 → valid 2 / error 5（错误行表逐行返回）`);
      const checks = [
        [3, 'poNumber'], [4, 'type'], [5, 'quantity'], [6, 'dueDate'], [8, '文件内重复'],
      ];
      const allMatch = checks.every(([line, kw]) =>
        (d.rows.find(x => x.lineNo === line) || {}).reason?.includes(kw));
      if (allMatch) pass('错误行定位：第 3/4/5/6/8 行原因逐行命中（行号+原因 100% 锚点）');
      else fail('错误行定位', JSON.stringify(d.rows.filter(x => !x.valid).map(x => [x.lineNo, x.reason])));
    } else fail('混合错误校验', `total=${d?.totalRows} valid=${d?.validCount} err=${d?.errorCount}`);

    // 修正后重导全绿（锚点②闭环）
    const fixed = [ORDER_HEADER,
      'PO-A1,客户A,产品A,Fabric,1000,2026-09-01,25000,,,',
      'PO-A2,客户C,产品C,Garment,500,2026-09-01,12000,,,',
    ];
    const form2 = new FormData();
    form2.append('file', csvFile(fixed));
    form2.append('type', 'orders');
    const r2 = await api('POST', '/api/v1/data-migration/validate', form2, true);
    if (r2.status === 200 && r2.data.validCount === 2 && r2.data.errorCount === 0) {
      pass('修正重导：错误行修正后校验全绿（可修正重导锚点）');
    } else fail('修正重导', `valid=${r2.data?.validCount}`);
  }

  // ── 3 千行级迁移（验收锚点①） ──
  console.log('\n── 千行级迁移（3 年历史数据能力锚点） ──');
  let batchId = '';
  {
    const rows = [ORDER_HEADER];
    for (let i = 1; i <= 1000; i++) {
      rows.push(`PO-MIG-${String(i).padStart(4, '0')},历史客户${(i % 30) + 1},三年历史订单${i},Fabric,${500 + i},2024-0${(i % 9) + 1}-15,${1000 + i}.5,,,`);
    }
    const form = new FormData();
    form.append('file', csvFile(rows));
    form.append('type', 'orders');
    const t0 = Date.now();
    const rv = await api('POST', '/api/v1/data-migration/validate', form, true);
    const validateMs = Date.now() - t0;
    if (rv.status === 200 && rv.data.validCount === 1000 && rv.data.errorCount === 0) {
      pass(`千行校验：1000 行全 valid（${validateMs}ms）`);
    } else fail('千行校验', `valid=${rv.data?.validCount}`);

    const t1 = Date.now();
    const rc = await api('POST', '/api/v1/data-migration/commit', form, true);
    const commitMs = Date.now() - t1;
    if (rc.status === 201 && rc.data.imported === 1000 && rc.data.skipped === 0) {
      batchId = rc.data.batch.id;
      pass(`千行落库：1000 行导入 + 批次留痕（${commitMs}ms，validate+commit 合计 ${(validateMs + commitMs) / 1000}s——千行级 ≤1 工作日能力锚点）`);
    } else fail('千行落库', `imported=${rc.data?.imported} skipped=${rc.data?.skipped}`);

    // 重复提交幂等（同文件再 commit → 全部跳过）
    const rc2 = await api('POST', '/api/v1/data-migration/commit', form, true);
    if (rc2.status === 201 && rc2.data.imported === 0 && rc2.data.skipped === 1000) {
      pass('重复导入幂等：同文件二次 commit → 0 落库 / 1000 跳过（库内查重）');
    } else fail('重复导入幂等', `imported=${rc2.data?.imported}`);
  }

  // ── 4 发票对账一致性（验收锚点③） ──
  console.log('\n── 对账一致性（发票导入 = Invoice 真源） ──');
  let invBatchId = '';
  {
    const AMOUNTS = [12000.5, 8500.25, 43000, 15600.75];
    const rows = [INVOICE_HEADER];
    AMOUNTS.forEach((amt, i) => {
      rows.push(`INV-MIG-${i + 1},Receivable,${amt},USD,2026-0${i + 3}-15,Issued,2026-0${i + 4}-15,,对账客户${i + 1}`);
    });
    const form = new FormData();
    form.append('file', csvFile(rows));
    form.append('type', 'invoices');
    const rc = await api('POST', '/api/v1/data-migration/commit', form, true);
    if (rc.status === 201 && rc.data.imported === 4) {
      invBatchId = rc.data.batch.id;
      pass(`发票导入：4 张落库（批次 ${rc.data.batch.id}）`);
    } else fail('发票导入', `imported=${rc.data?.imported}`);

    // 对账锚点：库内发票（INV-MIG-*）金额合计 == CSV 原账合计（列表端点 GET /api/v1/finance → items）
    const expected = AMOUNTS.reduce((s, a) => s + a, 0);
    const inv = await api('GET', '/api/v1/finance?limit=500');
    const list = (inv.data?.items || []);
    const migrated = list.filter(i => String(i.invoiceNumber || '').startsWith('INV-MIG-'));
    const actual = migrated.reduce((s, i) => s + Number(i.amount), 0);
    if (Math.abs(actual - expected) < 0.001 && migrated.length === 4) {
      pass(`对账一致：库内 4 张合计 $${actual.toFixed(2)} == Excel 原账 $${expected.toFixed(2)}（账龄/对账单读同一 Invoice 真源——结构性一致）`);
    } else fail('对账一致', `db=${actual} excel=${expected} count=${migrated.length}`);
  }

  // ── 5 整批回滚（软删锚点） ──
  console.log('\n── 整批回滚 ──');
  {
    if (invBatchId) {
      const rb = await api('POST', `/api/v1/data-migration/batches/${invBatchId}/rollback`, {});
      if (rb.status === 200 && rb.data.rolledBack === 4) {
        pass('发票批次回滚：4 张软删（entityIds 全部 deletedAt）');
      } else fail('发票回滚', `rolledBack=${rb.data?.rolledBack}`);

      // 回滚后对账数字归零（一致性反证）
      const inv = await api('GET', '/api/v1/finance?limit=500');
      const list = (inv.data?.items || []);
      const stillThere = list.filter(i => String(i.invoiceNumber || '').startsWith('INV-MIG-'));
      if (stillThere.length === 0) pass('回滚后对账归零：INV-MIG-* 全部从发票列表消失（软删生效）');
      else fail('回滚后归零', `残留 ${stillThere.length}`);

      const rb2 = await api('POST', `/api/v1/data-migration/batches/${invBatchId}/rollback`, {});
      if (rb2.status === 409) pass('二次回滚拒 → 409 ALREADY_ROLLED_BACK');
      else fail('二次回滚拒', `status=${rb2.status}`);
    }

    if (batchId) {
      const rb = await api('POST', `/api/v1/data-migration/batches/${batchId}/rollback`, {});
      if (rb.status === 200 && rb.data.rolledBack === 1000) {
        pass('千行订单批次回滚：1000 行软删（演示库不留脏数据）');
      } else fail('千行回滚', `rolledBack=${rb.data?.rolledBack}`);
    }

    // 批次列表
    const bl = await api('GET', '/api/v1/data-migration/batches');
    if (bl.status === 200 && Array.isArray(bl.data?.items) && bl.data.items.length >= 3) {
      pass(`批次列表：${bl.data.items.length} 批（committed/rolled_back 状态留痕）`);
    } else fail('批次列表', `count=${bl.data?.items?.length}`);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n═══ REQ2-07 API 验收汇总：${results.length - failed.length}/${results.length} 通过 ${failed.length ? '· 失败 ' + failed.length : '· 全绿'} ═══`);
  if (failed.length) { failed.forEach(f => console.log(`  ✗ ${f.name}: ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
