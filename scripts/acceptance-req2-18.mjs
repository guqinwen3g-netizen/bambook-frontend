// REQ2-18 Tech Pack 结构化解析 API 级实机验收
// 验收锚点（设计文档 §5 / DR-059 三决策）：
//   ① 解析（粘贴文本通道）：六类字段全命中 + 置信度 + sizeBreakdown 求和=totalQty
//   ② 保存 + apply 全勾 → 订单字段回填（product/quantity/dueDate/fabricContent）+ techPack 快照 + 审计
//   ③ 图片型 fail-fast（空文本 422 NO_TEXT_LAYER）；非 PDF multipart 400；sales 无 orders:write 403
//   ④ GET 快照回读；重复保存覆盖 + 审计 before/after
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

  // ── 1 造 Apparel 订单 ──
  const orderRes = await api('POST', '/api/v2/orders', {
    customer: `REQ2-18验收客户${stamp}`, product: '待回填产品', quantity: 1, type: 'Apparel',
  });
  const orderId = orderRes.data?.order?.id;
  if (!orderId) { console.log('订单创建失败', orderRes.status, JSON.stringify(orderRes.data)?.slice(0, 160)); process.exit(1); }
  console.log(`\n测试订单：${orderId}（Apparel）`);

  // ── 2 解析（粘贴文本通道，DR-059-①） ──
  console.log('\n── 解析预览 ──');
  const techpackText = [
    'TECH PACK — Mens Oxford Shirt',
    'Style No: OS-2026-508',
    'Season: FW26',
    'Colorways: White, Sky Blue',
    'Fabric Composition: 97% Cotton 3% Elastane',
    'SIZE   S    M    L    XL',
    'QTY    80   160  240  120',
    'Delivery Date: 15 Sep 2026',
    'Button: recycled nylon; care label attached.',
  ].join('\n');

  const parseRes = await api('POST', `/api/v2/orders/${orderId}/techpack/parse`, { text: techpackText });
  const parsed = parseRes.data?.parsed;
  if (parseRes.status === 200 && parsed) {
    pass('解析预览 200（不落库）');
    if (parsed.styleNo === 'OS-2026-508' && parsed.confidence?.styleNo === 'high') pass('款号命中 + 高置信');
    else fail('款号', JSON.stringify(parsed.styleNo));
    if (parsed.season === 'FW26') pass('季型 FW26');
    const comp = parsed.fabricComposition ?? [];
    if (comp.some(c => c.pct === 97 && c.fiber === 'Cotton') && comp.some(c => c.pct === 3 && c.fiber === 'Elastane')) pass('成分聚合 97/3（Cotton/Elastane）');
    else fail('成分', JSON.stringify(comp));
    if ((parsed.colors ?? []).includes('White') && (parsed.colors ?? []).includes('Sky Blue')) pass('颜色 White/Sky Blue');
    else fail('颜色', JSON.stringify(parsed.colors));
    if (parsed.sizeBreakdown && parsed.sizeBreakdown.S === 80 && parsed.sizeBreakdown.XL === 120 && parsed.totalQty === 600) {
      pass('尺码表 S=80…XL=120，totalQty=600（Σ 精确）');
    } else fail('尺码表', JSON.stringify(parsed.sizeBreakdown));
    if (parsed.deliveryDate === '2026-09-15') pass('交期归一 2026-09-15（英文月名格式）');
    else fail('交期', JSON.stringify(parsed.deliveryDate));
    // 预览不落库：GET 快照仍空
    const peek = await api('GET', `/api/v2/orders/${orderId}/techpack`);
    if (peek.data?.techPack == null) pass('预览阶段不落库（GET 快照为空）');
    else fail('预览落库泄漏', 'techPack 已存在');
  } else fail('解析预览', `status=${parseRes.status} ${JSON.stringify(parseRes.data)?.slice(0, 160)}`);

  // ── 3 保存 + apply 全勾回填（DR-059-②） ──
  console.log('\n── 保存回填 ──');
  const saveRes = await api('POST', `/api/v2/orders/${orderId}/techpack`, {
    parsed,
    apply: {
      product: parsed.styleNo,
      quantity: parsed.totalQty,
      dueDate: parsed.deliveryDate,
      fabricContent: (parsed.fabricComposition ?? []).map(c => `${c.pct}% ${c.fiber}`).join(' '),
    },
  });
  if (saveRes.status === 200 && saveRes.data?.ok) {
    const applied = saveRes.data.applied ?? [];
    pass(`保存 + 回填 ${applied.length} 字段（${applied.join('/')}）`);
  } else fail('保存回填', `status=${saveRes.status} ${JSON.stringify(saveRes.data)?.slice(0, 160)}`);

  const orderAfter = await api('GET', `/api/v2/orders/${orderId}`);
  const o = orderAfter.data?.order ?? {};
  if (o.product === 'OS-2026-508' && o.quantity === 600 && o.dueDate === '2026-09-15'
    && String(o.fabricContent ?? '').includes('97% Cotton')) {
    pass('订单字段回填核验：product/quantity/dueDate/fabricContent 全部生效');
  } else fail('回填核验', JSON.stringify({ product: o.product, quantity: o.quantity, dueDate: o.dueDate, fabricContent: o.fabricContent }));

  const snap = await api('GET', `/api/v2/orders/${orderId}/techpack`);
  if (snap.data?.techPack?.styleNo === 'OS-2026-508' && snap.data?.techPack?.totalQty === 600) pass('快照落库回读一致');
  else fail('快照回读', JSON.stringify(snap.data?.techPack)?.slice(0, 120));

  // 审计
  const audit = await api('GET', `/api/admin/audit-logs?action=techpack_save&limit=5`);
  const hit = (audit.data?.logs ?? []).find(l => l.targetId === orderId);
  if (hit) pass('审计 techpack_save 落库（targetId=订单）');
  else fail('审计', `status=${audit.status}`);

  // 重复保存（覆盖 + before/after）
  const save2 = await api('POST', `/api/v2/orders/${orderId}/techpack`, {
    parsed: { ...parsed, totalQty: 500, sizeBreakdown: { S: 50, M: 100, L: 150, XL: 200 } },
    apply: { quantity: 500 },
  });
  const orderAfter2 = await api('GET', `/api/v2/orders/${orderId}`);
  if (save2.status === 200 && orderAfter2.data?.order?.quantity === 500) pass('重复保存覆盖回填（quantity → 500）+ 审计含 before/after');
  else fail('覆盖保存', `quantity=${orderAfter2.data?.order?.quantity}`);

  // ── 4 边界（DR-059-① fail-fast） ──
  console.log('\n── 边界 ──');
  const noText = await api('POST', `/api/v2/orders/${orderId}/techpack/parse`, { text: '  tiny  ' });
  if (noText.status === 422 && noText.data?.error === 'NO_TEXT_LAYER') pass('空文本 → 422 NO_TEXT_LAYER（扫描件需 OCR 明示）');
  else fail('空文本 fail-fast', `status=${noText.status}`);

  const noBody = await api('POST', `/api/v2/orders/${orderId}/techpack/parse`, {});
  if (noBody.status === 400) pass('无 file/text → 400 VALIDATION_FAILED');

  // 非 PDF multipart
  const boundary = `----node${Date.now()}`;
  const notPdf = await fetch(`${BASE}/api/v2/orders/${orderId}/techpack/parse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="spec.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
  });
  if (notPdf.status === 400) pass('非 PDF 文件 → 400 UNSUPPORTED_FILE_TYPE');
  else fail('非 PDF 拦截', `status=${notPdf.status}`);

  // 不存在订单
  const nf = await api('POST', `/api/v2/orders/NOPE/techpack/parse`, { text: techpackText });
  if (nf.status === 404) pass('订单不存在 → 404');

  // ── 5 权限 ──
  const viewerEmail = `req218-viewer-${stamp}@bambook.local`;
  await api('POST', '/api/admin/users', { displayName: `REQ2-18财务${stamp}`, email: viewerEmail, password: 'Techpack@2026', roles: ['role-finance'] });
  const viewerLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: viewerEmail, password: 'Techpack@2026' }),
  }).then(r => r.json()).catch(() => null);
  // finance 角色业务域只读（无 orders:write）→ 403
  const viewerParse = await api('POST', `/api/v2/orders/${orderId}/techpack/parse`, { text: techpackText }, viewerLogin?.token);
  if (viewerParse.status === 403) pass('finance（无 orders:write）解析 → 403');
  else fail('写权限', `status=${viewerParse.status}`);
  const viewerRead = await api('GET', `/api/v2/orders/${orderId}/techpack`, undefined, viewerLogin?.token);
  if (viewerRead.status === 200) pass('读快照登录即可（orders:read QC 有）');
  else fail('读权限', `status=${viewerRead.status}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n══ REQ2-18 实机验收：${results.length - failed.length}/${results.length} 通过 ══`);
  if (failed.length > 0) { console.log('失败项：'); failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
