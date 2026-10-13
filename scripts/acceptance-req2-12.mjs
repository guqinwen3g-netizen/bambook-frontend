// REQ2-12 报价单产品图片 API 级实机验收
// 验收锚点：A4——报价 PDF 含产品图（API 层验证全链：上传 → 行携带 → 落库快照 → 详情回读）
const BASE = 'http://127.0.0.1:8081';
// SALES 角色（持 quotations:write scope）——W-C 起报价写端点叠加 quotations:write 门，
// ADMIN 只读不写，验收脚本改用业务员账号
const EMAIL = 'chloe.su@bambook.local';
const PASSWORD = 'Bambook@2026';

const results = [];
let token = '';
function pass(name, detail = '') { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); }

async function api(method, path, body, isForm = false) {
  const headers = { Authorization: `Bearer ${token}` };
  if (!isForm && body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

/** 1x1 PNG（最小合法图片） */
function makePng() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  return new File([png], 'swatch.png', { type: 'image/png' });
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

  let uploadedUrl = '';
  let quotationId = '';

  // ── 1 上传（DR-053-① 手动通道） ──
  console.log('\n── 行图片上传 ──');
  {
    const form = new FormData();
    form.append('file', makePng());
    const r = await api('POST', '/api/v1/quotations/line-image', form, true);
    if (r.status === 201 && r.data?.url?.startsWith('/api/v1/quotations/line-image/')) {
      uploadedUrl = r.data.url;
      pass(`上传 201 → ${uploadedUrl}`);
    } else fail('上传', `status=${r.status} ${JSON.stringify(r.data)?.slice(0, 160)}`);

    // 无文件 → 400
    const empty = new FormData();
    const bad = await api('POST', '/api/v1/quotations/line-image', empty, true);
    if (bad.status === 400) pass('无文件 → 400 NO_FILE');
    else fail('无文件校验', `status=${bad.status}`);

    // 非图片类型 → multer 拦截
    const txtForm = new FormData();
    txtForm.append('file', new File([Buffer.from('not an image')], 'x.txt', { type: 'text/plain' }));
    const badType = await api('POST', '/api/v1/quotations/line-image', txtForm, true);
    if (badType.status >= 400) pass('非图片类型 → 拦截（text/plain 拒绝）');
    else fail('类型校验', `status=${badType.status}`);

    // P0-3 安全收口：/api/uploads/quotations 静态直读已 fail-closed 404；读取统一走 scoped 端点
    const legacyStatic = await fetch(`${BASE}/api/uploads/quotations/${uploadedUrl.split('/').pop()}`, { headers: { Authorization: `Bearer ${token}` } });
    if (legacyStatic.status === 404) pass('静态直读已 fail-closed 404（/api/uploads/quotations/...）');
    else fail('静态 fail-closed', `status=${legacyStatic.status}`);
    const imgRes = await fetch(`${BASE}${uploadedUrl}`, { headers: { Authorization: `Bearer ${token}` } });
    if (imgRes.status === 200) pass('scoped 端点带 token 回读 200（/api/v1/quotations/line-image/...）');
    else fail('scoped 回读', `status=${imgRes.status}`);
    const imgNoAuth = await fetch(`${BASE}${uploadedUrl}`);
    if (imgNoAuth.status === 401) pass('scoped 端点无 token → 401');
    else fail('scoped 无 token', `status=${imgNoAuth.status}`);
  }

  // ── 2 创建报价单（行携带 imageUrl 落快照） ──
  console.log('\n── 报价创建（行图快照） ──');
  {
    const today = new Date().toISOString().slice(0, 10);
    const r = await api('POST', '/api/v1/quotations', {
      currency: 'USD', customerName: 'REQ2-12 验收客户', issueDate: today,
      lines: [
        { fabricCode: 'FAB-IMG-01', description: '带图面料行', quantity: 1000, unit: 'YD', unitPrice: 5.5, imageUrl: uploadedUrl },
        { fabricCode: 'FAB-NOIMG-01', description: '无图面料行', quantity: 500, unit: 'YD', unitPrice: 4.2 },
      ],
    });
    quotationId = r.data?.quotation?.id;
    const lines = r.data?.quotation?.lines || [];
    if (r.status === 201 && lines.length === 2 && lines[0].imageUrl === uploadedUrl && lines[1].imageUrl == null) {
      pass('创建 201：行1 imageUrl 快照落库，行2 无图为 null');
    } else fail('创建', `status=${r.status} ${JSON.stringify(lines.map(l => l.imageUrl))}`);

    // 详情回读
    const detail = await api('GET', `/api/v1/quotations/${encodeURIComponent(quotationId)}`);
    const dLines = detail.data?.quotation?.lines || [];
    if (detail.status === 200 && dLines[0]?.imageUrl === uploadedUrl) pass('详情回读：imageUrl 持久化');
    else fail('详情回读', `status=${detail.status}`);
  }

  // ── 3 更新链路（先删后建保留 imageUrl） ──
  console.log('\n── 更新链路 ──');
  {
    const r = await api('PUT', `/api/v1/quotations/${encodeURIComponent(quotationId)}`, {
      currency: 'USD', customerName: 'REQ2-12 验收客户', issueDate: new Date().toISOString().slice(0, 10),
      lines: [
        { fabricCode: 'FAB-IMG-01', description: '带图面料行 V2', quantity: 1200, unit: 'YD', unitPrice: 5.8, imageUrl: uploadedUrl },
      ],
    });
    const lines = r.data?.quotation?.lines || [];
    if (r.status === 200 && lines[0]?.imageUrl === uploadedUrl) pass('更新（先删后建）后 imageUrl 快照保留');
    else fail('更新', `status=${r.status} url=${lines[0]?.imageUrl}`);
  }

  // ── 清理 ──
  if (quotationId) {
    // Draft 可删
    const del = await api('DELETE', `/api/v1/quotations/${encodeURIComponent(quotationId)}`);
    console.log(`\n清理：验收报价单软删 ${del.status}`);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n═══ REQ2-12 验收结果：${results.length - failed.length}/${results.length} 通过 ═══`);
  if (failed.length) { console.log('失败项：'); failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
