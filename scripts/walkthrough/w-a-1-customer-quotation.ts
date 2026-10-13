/**
 * W-A-1 切片卡「客户与商机起点域」代码级模拟操作走查
 *
 * 覆盖：A 链步骤 1-3 / B 链步骤 1-3
 *   1. 客户建档（V2 创建 → 归属人 → 信用额度 Active → S3 行级越权拦截）
 *   2. 开发打样（面料开发案 + 打色/缸差登记 + 批色判定 + 寄样四要素留痕；
 *               成衣开发案 + 三级样衣节点独立流转）
 *   3. 报价（Draft→Sent→Accepted 状态机 + imageUrl 字段 + 低于成本门禁 block + 成衣报价双轨成本构成）
 *
 * 运行：npx tsx scripts/walkthrough/w-a-1-customer-quotation.ts
 * 环境：本地 8081 后端（pandahub 库）。走查数据统一 WA1- 前缀，可识别、可清理。
 * 说明：本脚本直接打 HTTP API（非 service 层），原因：行级权限/门禁守卫挂在 route
 *       中间件上（requirePermission/requireRole/dataScope），service 层直调无法验证
 *       S3 越权拦截与 fail-closed 行为。
 */
import { createHmac } from 'node:crypto';

const BASE = process.env.WA1_BASE_URL || 'http://localhost:8081';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const RUN = `WA1${Date.now().toString(36).toUpperCase()}`;
const TODAY = new Date().toISOString().slice(0, 10);

// ────────────────────────────────────────────────────────────────────
// 基础设施：JWT 自签（与 auth/service.ts 默认 secret 对齐）+ fetch 封装
// ────────────────────────────────────────────────────────────────────
function signJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  const sig = createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * 业务员 A（建档归属人）/ 业务员 B（越权者）/ owner（全权对照）。
 * userId 必须是 UserAccount 表真实存在的账号——AuditLog.actorId 有 FK 指向
 * UserAccount.id，审计 fail-closed（写不进审计 → 事务回滚 500），虚构 userId
 * 会导致开发案创建等链路整体失败（首轮走查实测证实）。
 */
const SALES_A_ID = 'usr_demo_sales_a'; // 苏晓芸
const SALES_B_ID = 'usr_demo_sales_b'; // 周子墨
const OWNER_ID = 'u1'; // Test Owner
const SALES_A = signJwt({ userId: SALES_A_ID, roles: ['sales'] });
const SALES_B = signJwt({ userId: SALES_B_ID, roles: ['sales'] });
const OWNER = signJwt({ userId: OWNER_ID, roles: ['owner'] });

interface StepRecord {
  step: string;
  call: string;
  params?: unknown;
  httpStatus?: number;
  responseSummary?: unknown;
  assertions: { name: string; pass: boolean; detail?: string }[];
  verdict: 'PASS' | 'FAIL' | 'BLOCKED';
  note?: string;
}

const records: StepRecord[] = [];
const deadEnds: { step: string; symptom: string; rootCauseGuess: string; blocking: boolean }[] = [];

async function api(method: string, path: string, opts: { token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 xlsx/html） */ }
  return { status: res.status, json, text: text.slice(0, 400) };
}

function record(r: StepRecord) {
  records.push(r);
  const icon = r.verdict === 'PASS' ? '✓' : r.verdict === 'FAIL' ? '✗' : '⊘';
  console.log(`\n${icon} [${r.verdict}] ${r.step}`);
  console.log(`  调用: ${r.call}`);
  for (const a of r.assertions) {
    console.log(`  ${a.pass ? '✓' : '✗'} ${a.name}${a.detail ? ` — ${a.detail}` : ''}`);
  }
  if (r.note) console.log(`  备注: ${r.note}`);
}

function deadEnd(step: string, symptom: string, rootCauseGuess: string, blocking: boolean) {
  deadEnds.push({ step, symptom, rootCauseGuess, blocking });
}

// ────────────────────────────────────────────────────────────────────
// 走查开始
// ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== W-A-1 客户与商机起点域走查 ===`);
  console.log(`BASE=${BASE} RUN=${RUN} TODAY=${TODAY}`);

  const health = await api('GET', '/api/health');
  if (health.status !== 200) {
    console.error('后端不可达，走查终止');
    process.exit(2);
  }
  console.log(`后端在线: database=${health.json?.database} authRequired=${health.json?.authRequired}`);

  // ════════════════════════════════════════════════════════════════
  // 步骤 1：客户建档（A/B 链步骤 1）
  // ════════════════════════════════════════════════════════════════
  // 1.1 业务员 A 创建面料客户（含信用额度）
  const fabricCustomerBody = {
    name: `${RUN}-面料客户-苏州锦纶纺织`,
    category: 'Customer',
    isOrganization: true,
    stage: 'Customer',
    currency: 'USD',
    creditLimit: 500000,
    primaryContactName: '王采购',
    primaryContactEmail: 'buyer@example.com',
    country: 'CN',
  };
  const c1 = await api('POST', '/api/v2/relations', { token: SALES_A, body: fabricCustomerBody });
  const fabricCustomer = c1.json?.relation;
  {
    const assertions = [
      { name: 'HTTP 200 且 ok=true', pass: c1.status === 200 && c1.json?.ok === true, detail: `status=${c1.status}` },
      { name: `归属人 ownerId = 创建者 ${SALES_A_ID}`, pass: fabricCustomer?.ownerId === SALES_A_ID, detail: `ownerId=${fabricCustomer?.ownerId}` },
      { name: '档案编号自动生成（CUS- 前缀）', pass: typeof fabricCustomer?.code === 'string' && fabricCustomer.code.startsWith('CUS-'), detail: `code=${fabricCustomer?.code}` },
      { name: '档案冗余额度字段落库 500000', pass: Number(fabricCustomer?.creditLimit) === 500000, detail: `creditLimit=${fabricCustomer?.creditLimit}` },
    ];
    record({
      step: '1.1 客户建档：创建面料客户（POST /api/v2/relations，业务员 A）',
      call: 'POST /api/v2/relations',
      params: fabricCustomerBody,
      httpStatus: c1.status,
      responseSummary: { id: fabricCustomer?.id, code: fabricCustomer?.code, ownerId: fabricCustomer?.ownerId, creditLimit: fabricCustomer?.creditLimit },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
    });
    if (!fabricCustomer?.id) {
      deadEnd('1.1 客户建档', `创建失败 status=${c1.status} body=${c1.text}`, 'V2 创建链路异常（编号序列/字典/权限）', true);
      summarize();
      process.exit(1);
    }
  }

  // 1.2 信用额度实体（真源）联动建立
  const cl = await api('GET', `/api/v1/crm/${fabricCustomer.id}/credit-limit`, { token: SALES_A });
  {
    const creditLimit = cl.json?.creditLimit;
    const assertions = [
      { name: '信用额度实体存在', pass: cl.status === 200 && !!creditLimit, detail: `status=${cl.status}` },
      { name: '状态 = Active', pass: creditLimit?.status === 'Active', detail: `status=${creditLimit?.status}` },
      { name: '总额度 = 500000', pass: Number(creditLimit?.totalLimit) === 500000, detail: `totalLimit=${creditLimit?.totalLimit}` },
      { name: 'validFrom 已落库', pass: typeof creditLimit?.validFrom === 'string' && creditLimit.validFrom.length === 10, detail: `validFrom=${creditLimit?.validFrom}` },
    ];
    record({
      step: '1.2 信用额度建立（GET /api/v1/crm/:id/credit-limit）',
      call: `GET /api/v1/crm/${fabricCustomer.id}/credit-limit`,
      httpStatus: cl.status,
      responseSummary: creditLimit && { id: creditLimit.id, status: creditLimit.status, totalLimit: String(creditLimit.totalLimit), usedAmount: String(creditLimit.usedAmount) },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
      note: 'CreditLimit 实体为生效额度真源；relation.creditLimit 为冗余快照（单一真源联动）',
    });
    if (!creditLimit) deadEnd('1.2 信用额度', '建档后无 Active CreditLimit 实体', 'syncCreditLimitEntity 联动失败（fail-soft 仅日志，不阻断建档）', false);
  }

  // 1.3 S3 行级隔离：匿名 401 / 业务员 B 写越权 404 / B 读敏感遮罩 / confidential 读越权 404 / owner 可读
  {
    // 匿名读 → requirePermission 无 actor → 401
    const anon = await api('GET', `/api/v2/relations/${fabricCustomer.id}`, { token: null });
    // B 写 A 的客户（写 scope=本人维，fail-closed 伪装 NOT_FOUND）
    const bWrite = await api('PUT', `/api/v2/relations/${fabricCustomer.id}`, { token: SALES_B, body: { summary: 'B 越权篡改' } });
    // B 读 A 的 normal 客户（图书馆口径允许读，但 creditLimit 敏感遮罩应为 null）
    const bRead = await api('GET', `/api/v2/relations/${fabricCustomer.id}`, { token: SALES_B });
    // A 建 confidential 客户 → B 读应 404
    const confCreate = await api('POST', '/api/v2/relations', {
      token: SALES_A,
      body: { name: `${RUN}-机密客户`, category: 'Customer', isOrganization: true, sensitivity: 'confidential' },
    });
    const confId = confCreate.json?.relation?.id;
    const bReadConf = confId ? await api('GET', `/api/v2/relations/${confId}`, { token: SALES_B }) : { status: 0, json: null, text: '' };
    // owner 全权对照：可读且 creditLimit 不遮罩
    const ownerRead = await api('GET', `/api/v2/relations/${fabricCustomer.id}`, { token: OWNER });
    // B 篡改后 A 复核 summary 未变
    const aRead = await api('GET', `/api/v2/relations/${fabricCustomer.id}`, { token: SALES_A });

    const assertions = [
      { name: '匿名无 JWT 读详情 → 401 fail-closed', pass: anon.status === 401, detail: `status=${anon.status}` },
      { name: 'B 越权写 A 的客户 → 404 NOT_FOUND（不泄露存在性）', pass: bWrite.status === 404 && bWrite.json?.error === 'NOT_FOUND', detail: `status=${bWrite.status} err=${bWrite.json?.error}` },
      { name: '越权写未生效（summary 未被篡改）', pass: aRead.json?.relation?.summary == null, detail: `summary=${aRead.json?.relation?.summary}` },
      { name: 'B 读 normal 档案：图书馆口径放行但 creditLimit 遮罩为 null', pass: bRead.status === 200 && bRead.json?.relation?.creditLimit === null, detail: `status=${bRead.status} creditLimit=${JSON.stringify(bRead.json?.relation?.creditLimit)}` },
      { name: 'B 读 confidential 档案 → 404 行级隔离', pass: bReadConf.status === 404, detail: `status=${bReadConf.status}` },
      { name: 'owner 全权读：creditLimit 可见 500000', pass: ownerRead.status === 200 && Number(ownerRead.json?.relation?.creditLimit) === 500000, detail: `creditLimit=${ownerRead.json?.relation?.creditLimit}` },
    ];
    record({
      step: '1.3 S3 行级隔离（匿名 401 / 越权写 404 / 敏感遮罩 / confidential 404 / owner 对照）',
      call: 'GET|PUT /api/v2/relations/:id（四种身份）',
      httpStatus: bWrite.status,
      responseSummary: { anon: anon.status, bWrite: bWrite.status, bReadMask: bRead.json?.relation?.creditLimit, bReadConf: bReadConf.status, ownerRead: ownerRead.status },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
      note: 'DR-042 v2.2：L1 图书馆（normal 全公司可读）+ 写本人维 + creditLimit 敏感遮罩 + confidential 收窄',
    });
    if (!assertions.every(a => a.pass)) deadEnd('1.3 行级隔离', '越权拦截/遮罩未达预期', 'dataScope resolver 或敏感遮罩链路口径漂移', true);
  }

  // 1.4 成衣客户建档（B 链步骤 1）
  const garmentCustomerBody = {
    name: `${RUN}-成衣客户-杭州风尚服饰`,
    category: 'Customer',
    isOrganization: true,
    stage: 'Customer',
    currency: 'USD',
    creditLimit: 300000,
  };
  const c2 = await api('POST', '/api/v2/relations', { token: SALES_A, body: garmentCustomerBody });
  const garmentCustomer = c2.json?.relation;
  {
    const assertions = [
      { name: '成衣客户建档成功', pass: c2.status === 200 && !!garmentCustomer?.id, detail: `status=${c2.status} id=${garmentCustomer?.id}` },
      { name: '归属人正确', pass: garmentCustomer?.ownerId === SALES_A_ID, detail: `ownerId=${garmentCustomer?.ownerId}` },
    ];
    record({
      step: '1.4 客户建档：创建成衣客户',
      call: 'POST /api/v2/relations',
      params: garmentCustomerBody,
      httpStatus: c2.status,
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
    });
    if (!garmentCustomer?.id) {
      deadEnd('1.4 成衣客户建档', `创建失败 ${c2.status}`, '同 1.1', true);
      summarize();
      process.exit(1);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 步骤 2：开发打样（A/B 链步骤 2）
  // ════════════════════════════════════════════════════════════════
  // 2.1 面料开发案创建
  const fabricDevBody = {
    code: `${RUN}-DEV-F`,
    name: `${RUN} 锦纶弹力面料开发`,
    type: 'fabric',
    customerRelationId: fabricCustomer.id,
    customerName: fabricCustomer.name,
    targetDate: '2026-09-30',
    sampleType: 'lab_dip',
    fabricSpec: '40D 锦纶 + 20D 氨纶，180gsm',
  };
  const d1 = await api('POST', '/api/v1/development', { token: SALES_A, body: fabricDevBody });
  const fabricDev = d1.json?.case;
  {
    const assertions = [
      { name: '201 创建成功', pass: d1.status === 201 && d1.json?.ok === true, detail: `status=${d1.status}` },
      { name: '初始 stage = developing', pass: fabricDev?.stage === 'developing', detail: `stage=${fabricDev?.stage}` },
      { name: '客户挂接正确', pass: fabricDev?.customerRelationId === fabricCustomer.id, detail: `customerRelationId=${fabricDev?.customerRelationId}` },
      { name: 'type = fabric', pass: fabricDev?.type === 'fabric', detail: `type=${fabricDev?.type}` },
    ];
    record({
      step: '2.1 面料开发案创建（POST /api/v1/development）',
      call: 'POST /api/v1/development',
      params: fabricDevBody,
      httpStatus: d1.status,
      responseSummary: fabricDev && { id: fabricDev.id, code: fabricDev.code, stage: fabricDev.stage },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
    });
    if (!fabricDev?.id) {
      deadEnd('2.1 面料开发案', `创建失败 ${d1.status} ${d1.text}`, '开发案创建链路异常', true);
      summarize();
      process.exit(1);
    }
  }

  // 2.2 打色/缸差登记（lab_dip 挂开发案）
  const cb1Body = {
    stage: 'lab_dip',
    developmentCaseId: fabricDev.id,
    dyeLotNo: `${RUN}-DL001`,
    colorRating: 3,
    sideDiff: 4,
    endDiff: 4,
    defectCauses: ['darker'],
    notes: '首打偏深，寄客户判定',
  };
  const cb1 = await api('POST', '/api/v1/samples/color-batches', { token: SALES_A, body: cb1Body });
  const batch1 = cb1.json?.batch;
  {
    const assertions = [
      { name: '登记成功', pass: (cb1.status === 200 || cb1.status === 201) && !!batch1?.id, detail: `status=${cb1.status}` },
      { name: '缸号落库', pass: batch1?.dyeLotNo === cb1Body.dyeLotNo, detail: `dyeLotNo=${batch1?.dyeLotNo}` },
      { name: 'roundNo 快照开发案轮次', pass: batch1?.roundNo === 1, detail: `roundNo=${batch1?.roundNo}` },
      { name: '客户判定初始 = pending', pass: batch1?.customerStatus === 'pending', detail: `customerStatus=${batch1?.customerStatus}` },
      { name: '疵点原因落库', pass: Array.isArray(batch1?.defectCauses) && batch1.defectCauses.includes('darker'), detail: JSON.stringify(batch1?.defectCauses) },
    ];
    record({
      step: '2.2 打色登记（POST /api/v1/samples/color-batches，缸差评级 3 级偏深）',
      call: 'POST /api/v1/samples/color-batches',
      params: cb1Body,
      httpStatus: cb1.status,
      responseSummary: batch1 && { id: batch1.id, batchCode: batch1.batchCode, customerStatus: batch1.customerStatus },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
    });
    if (!batch1?.id) deadEnd('2.2 打色登记', `登记失败 ${cb1.status} ${cb1.text}`, 'colorBatch 作用域校验/权限异常', true);
  }

  // 2.3 批色判定：首打 needs_recast → 重打 approved + asSealed（封样基准）
  {
    const fb1 = batch1?.id
      ? await api('POST', `/api/v1/samples/color-batches/${batch1.id}/customer-feedback`, { token: SALES_A, body: { status: 'needs_recast', note: '客户要求调浅半级' } })
      : { status: 0, json: null, text: 'no batch' };
    const cb2Body = { stage: 'lab_dip', developmentCaseId: fabricDev.id, dyeLotNo: `${RUN}-DL002`, colorRating: 5, defectCauses: [], notes: '重打与标样一致' };
    const cb2 = await api('POST', '/api/v1/samples/color-batches', { token: SALES_A, body: cb2Body });
    const batch2 = cb2.json?.batch;
    const fb2 = batch2?.id
      ? await api('POST', `/api/v1/samples/color-batches/${batch2.id}/customer-feedback`, { token: SALES_A, body: { status: 'approved', asSealed: true, note: '客户确认封样' } })
      : { status: 0, json: null, text: 'no batch2' };
    // 非法跳转负例：approved 终态再改 → 409
    const fbBad = batch2?.id
      ? await api('POST', `/api/v1/samples/color-batches/${batch2.id}/customer-feedback`, { token: SALES_A, body: { status: 'rejected' } })
      : { status: 0, json: null, text: '' };

    const assertions = [
      { name: '首打判定 needs_recast 成功', pass: fb1.status === 200 && fb1.json?.batch?.customerStatus === 'needs_recast', detail: `status=${fb1.status} cs=${fb1.json?.batch?.customerStatus}` },
      { name: '重打批次登记成功', pass: !!batch2?.id, detail: `status=${cb2.status}` },
      { name: '重打判定 approved + 封样基准', pass: fb2.status === 200 && fb2.json?.batch?.customerStatus === 'approved' && fb2.json?.batch?.approvedAsSealed === true, detail: `approvedAsSealed=${fb2.json?.batch?.approvedAsSealed}` },
      { name: '判定日期留痕', pass: typeof fb2.json?.batch?.customerFeedbackDate === 'string' && fb2.json.batch.customerFeedbackDate.length === 10, detail: fb2.json?.batch?.customerFeedbackDate },
      { name: '终态非法跳转被拒（409 INVALID_TRANSITION）', pass: fbBad.status === 409 && fbBad.json?.error?.code === 'INVALID_TRANSITION', detail: `status=${fbBad.status} code=${fbBad.json?.error?.code}` },
    ];
    record({
      step: '2.3 批色判定（needs_recast → 重打 → approved+asSealed 封样基准；终态防跳转）',
      call: 'POST /api/v1/samples/color-batches/:id/customer-feedback ×3',
      httpStatus: fb2.status,
      responseSummary: { fb1: fb1.json?.batch?.customerStatus, fb2: fb2.json?.batch?.customerStatus, sealed: fb2.json?.batch?.approvedAsSealed, fbBad: fbBad.status },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
    });
    if (!assertions.every(a => a.pass)) deadEnd('2.3 批色判定', '判定状态机/封样基准异常', 'CUSTOMER_TRANSITIONS 或封样唯一性切换异常', false);
  }

  // 2.4 寄样留痕（快递单号 + 收件人四要素）+ stage developing→shipping
  {
    const shipBody = {
      sampleSentDate: TODAY,
      sampleCourier: '顺丰速运',
      sampleTrackingNumber: `SF${RUN}001`,
      sampleRecipientName: '王采购',
      sampleRecipientCompany: fabricCustomer.name,
      sampleRecipientAddress: '苏州市吴中区纺织工业园 8 号',
      sampleRecipientPhone: '+86-512-66668888',
      sampleShippingFee: 23,
    };
    const upd = await api('PUT', `/api/v1/development/${fabricDev.id}`, { token: SALES_A, body: shipBody });
    const st = await api('PATCH', `/api/v1/development/${fabricDev.id}/stage`, { token: SALES_A, body: { stage: 'shipping', nextAction: '等客户签收反馈' } });
    const detail = await api('GET', `/api/v1/development/${fabricDev.id}`, { token: SALES_A });
    const dc = detail.json?.case;
    const assertions = [
      { name: '寄样字段写入成功', pass: upd.status === 200 && upd.json?.ok === true, detail: `status=${upd.status}` },
      { name: '快递单号落库', pass: dc?.sampleTrackingNumber === shipBody.sampleTrackingNumber, detail: dc?.sampleTrackingNumber },
      { name: '快递商落库', pass: dc?.sampleCourier === '顺丰速运', detail: dc?.sampleCourier },
      { name: '收件人四要素齐（姓名/公司/地址/电话）', pass: !!(dc?.sampleRecipientName && dc?.sampleRecipientCompany && dc?.sampleRecipientAddress && dc?.sampleRecipientPhone), detail: [dc?.sampleRecipientName, dc?.sampleRecipientCompany, dc?.sampleRecipientAddress, dc?.sampleRecipientPhone].filter(Boolean).length + '/4' },
      { name: '寄样日期落库', pass: dc?.sampleSentDate === TODAY, detail: dc?.sampleSentDate },
      { name: 'stage developing→shipping 流转成功', pass: st.status === 200 && st.json?.case?.stage === 'shipping', detail: `stage=${st.json?.case?.stage}` },
    ];
    record({
      step: '2.4 寄样留痕（四要素 + 快递单号）+ stage 流转 shipping',
      call: `PUT /api/v1/development/${fabricDev.id} + PATCH /:id/stage`,
      params: shipBody,
      httpStatus: upd.status,
      responseSummary: dc && { tracking: dc.sampleTrackingNumber, stage: dc.stage },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
    });
    if (!assertions.every(a => a.pass)) deadEnd('2.4 寄样留痕', '寄样字段未落库或 stage 不流转', 'updateDevelopmentCase 透传白名单/状态机异常', false);
  }

  // 2.5 面料开发案走完：shipping→feedback→approved + 非法跳转负例
  {
    const s1 = await api('PATCH', `/api/v1/development/${fabricDev.id}/stage`, { token: SALES_A, body: { stage: 'feedback' } });
    const bad = await api('PATCH', `/api/v1/development/${fabricDev.id}/stage`, { token: SALES_A, body: { stage: 'developing' } }); // feedback→developing 非法
    const s2 = await api('PATCH', `/api/v1/development/${fabricDev.id}/stage`, { token: SALES_A, body: { stage: 'approved' } });
    const assertions = [
      { name: 'shipping→feedback 流转', pass: s1.status === 200 && s1.json?.case?.stage === 'feedback', detail: `stage=${s1.json?.case?.stage}` },
      { name: 'feedback→developing 逆向非法跳转被拒（400）', pass: bad.status === 400, detail: `status=${bad.status} code=${bad.json?.error?.code}` },
      { name: 'feedback→approved 流转（终态）', pass: s2.status === 200 && s2.json?.case?.stage === 'approved', detail: `stage=${s2.json?.case?.stage}` },
      { name: 'approved 自动落 completedDate', pass: typeof s2.json?.case?.completedDate === 'string' && s2.json.case.completedDate.length === 10, detail: s2.json?.case?.completedDate },
    ];
    record({
      step: '2.5 开发案 stage 状态机走完 + 非法跳转负例',
      call: 'PATCH /api/v1/development/:id/stage ×3',
      httpStatus: s2.status,
      responseSummary: { s1: s1.json?.case?.stage, bad: bad.status, s2: s2.json?.case?.stage },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
    });
    if (!assertions.every(a => a.pass)) deadEnd('2.5 stage 状态机', '状态不流转或非法跳转放行', 'DEV_STAGE_TRANSITIONS 矩阵异常', false);
  }

  // 2.6 成衣开发案 + 三级样衣节点独立流转（confirmation/pp/top）
  const garmentDevBody = {
    code: `${RUN}-DEV-G`,
    name: `${RUN} 女式风衣样衣开发`,
    type: 'garment',
    customerRelationId: garmentCustomer.id,
    customerName: garmentCustomer.name,
    targetDate: '2026-10-15',
    styleSpec: '双排扣中长款风衣',
    sizeSpec: 'S/M/L 全码',
  };
  const d2 = await api('POST', '/api/v1/development', { token: SALES_A, body: garmentDevBody });
  const garmentDev = d2.json?.case;
  {
    const assertions = [
      { name: '成衣开发案创建成功（type=garment）', pass: d2.status === 201 && garmentDev?.type === 'garment', detail: `status=${d2.status} type=${garmentDev?.type}` },
    ];
    record({
      step: '2.6 成衣开发案创建',
      call: 'POST /api/v1/development',
      params: garmentDevBody,
      httpStatus: d2.status,
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
    });
  }
  if (garmentDev?.id) {
    const ensure = await api('POST', `/api/v1/development/${garmentDev.id}/sample-nodes/ensure`, { token: SALES_A });
    const nodes0 = ensure.json?.nodes ?? [];
    // confirmation 级：start → send → approve
    const nStart = await api('PATCH', `/api/v1/development/${garmentDev.id}/sample-nodes/confirmation`, { token: SALES_A, body: { action: 'start' } });
    const nSend = await api('PATCH', `/api/v1/development/${garmentDev.id}/sample-nodes/confirmation`, { token: SALES_A, body: { action: 'send', courier: 'DHL', trackingNumber: `DHL${RUN}` } });
    const nApprove = await api('PATCH', `/api/v1/development/${garmentDev.id}/sample-nodes/confirmation`, { token: SALES_A, body: { action: 'approve', feedback: '客户确认版型 OK' } });
    // pp 级独立：start 即可，不受 confirmation 终态阻塞
    const ppStart = await api('PATCH', `/api/v1/development/${garmentDev.id}/sample-nodes/pp`, { token: SALES_A, body: { action: 'start' } });
    // 非法负例：pp 未 send 直接 approve → 400
    const ppBad = await api('PATCH', `/api/v1/development/${garmentDev.id}/sample-nodes/pp`, { token: SALES_A, body: { action: 'approve' } });
    const list = await api('GET', `/api/v1/development/${garmentDev.id}/sample-nodes`, { token: SALES_A });
    const nodes = list.json?.nodes ?? [];
    const byLevel = Object.fromEntries(nodes.map((n: any) => [n.level, n]));
    const assertions = [
      { name: 'ensure 幂等建三级节点（confirmation/pp/top，均 pending）', pass: ensure.status === 200 && nodes0.length === 3 && nodes0.every((n: any) => n.status === 'pending'), detail: `nodes=${nodes0.length}` },
      { name: 'confirmation: pending→making（start）', pass: nStart.status === 200 && nStart.json?.node?.status === 'making', detail: nStart.json?.node?.status },
      { name: 'confirmation: making→sent（send，快递留痕）', pass: nSend.status === 200 && nSend.json?.node?.status === 'sent' && nSend.json?.node?.trackingNumber === `DHL${RUN}`, detail: `${nSend.json?.node?.status}/${nSend.json?.node?.trackingNumber}` },
      { name: 'confirmation: sent→approved（approve，批准人留痕）', pass: nApprove.status === 200 && nApprove.json?.node?.status === 'approved' && !!nApprove.json?.node?.approvedBy, detail: `approvedBy=${nApprove.json?.node?.approvedBy}` },
      { name: 'pp 级独立流转（start→making，不受 confirmation 影响）', pass: ppStart.status === 200 && ppStart.json?.node?.status === 'making', detail: ppStart.json?.node?.status },
      { name: 'pp 未寄出直接批准被拒（400 INVALID_TRANSITION）', pass: ppBad.status === 400 && ppBad.json?.error?.code === 'INVALID_TRANSITION', detail: `code=${ppBad.json?.error?.code}` },
      { name: '三级节点状态各自独立（confirmation=approved / pp=making / top=pending）', pass: byLevel.confirmation?.status === 'approved' && byLevel.pp?.status === 'making' && byLevel.top?.status === 'pending', detail: `c=${byLevel.confirmation?.status} p=${byLevel.pp?.status} t=${byLevel.top?.status}` },
    ];
    record({
      step: '2.7 成衣三级样衣节点独立流转（confirmation 全链 + pp 独立 + 非法负例）',
      call: 'POST /:id/sample-nodes/ensure + PATCH /:id/sample-nodes/:level ×5',
      httpStatus: nApprove.status,
      responseSummary: { confirmation: byLevel.confirmation?.status, pp: byLevel.pp?.status, top: byLevel.top?.status },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
    });
    if (!assertions.every(a => a.pass)) deadEnd('2.7 三级节点', '节点不流转/不独立/非法放行', '样品批次（SampleBatch）轮次状态机或确认锚点异常（sampleNodeService 已随消双轨 L-4 退役）', false);
  } else {
    deadEnd('2.6 成衣开发案', '创建失败，三级节点无法走查', '开发案创建链路异常', true);
  }

  // ════════════════════════════════════════════════════════════════
  // 步骤 3：报价（A/B 链步骤 3）
  // ════════════════════════════════════════════════════════════════
  // 3.0 前置：面料产品档案（低于成本门禁的成本真源 + 报价行 fabricCode 落点）
  const assetBody = { sku: `${RUN}-FAB-001`, name: `${RUN} 锦纶弹力面料`, mainCategory: 'fabric', cost: 40, unit: 'M' };
  const pa = await api('POST', '/api/v1/products/assets', { token: SALES_A, body: assetBody });
  const asset = pa.json?.asset;
  record({
    step: '3.0 前置：面料产品档案（cost=40 CNY/M，报价门禁成本真源）',
    call: 'POST /api/v1/products/assets',
    params: assetBody,
    httpStatus: pa.status,
    responseSummary: asset && { id: asset.id, sku: asset.sku, cost: String(asset.cost) },
    assertions: [
      { name: '产品档案创建成功且成本落库', pass: (pa.status === 200 || pa.status === 201) && Number(asset?.cost) === 40, detail: `status=${pa.status} cost=${asset?.cost}` },
    ],
    verdict: (pa.status === 200 || pa.status === 201) && Number(asset?.cost) === 40 ? 'PASS' : 'FAIL',
  });
  if (!asset?.id) deadEnd('3.0 产品档案', `创建失败 ${pa.status} ${pa.text}`, '产品档案链路异常', true);

  // 3.1 面料客户正常报价（带产品图 imageUrl + fabricCode 接产品档案）
  const q1Body = {
    currency: 'CNY',
    customerRelationId: fabricCustomer.id,
    customerName: fabricCustomer.name,
    issueDate: TODAY,
    validUntil: '2026-09-30',
    deliveryTerms: 'FOB Shanghai',
    paymentTerms: 'T/T 30% deposit',
    salesperson: SALES_A_ID,
    lines: [
      {
        fabricCode: `${RUN}-FAB-001`,
        description: '40D 锦纶弹力面料 180gsm 藏青',
        quantity: 10000,
        unit: 'M',
        unitPrice: 52,
        imageUrl: '/api/uploads/quotations/wa1-fabric-navy.jpg',
      },
    ],
  };
  const q1 = await api('POST', '/api/v1/quotations', { token: SALES_A, body: q1Body });
  const quote1 = q1.json?.quotation;
  {
    const line0 = quote1?.lines?.[0];
    const assertions = [
      { name: '201 创建成功，初始状态 Draft', pass: q1.status === 201 && quote1?.status === 'Draft', detail: `status=${q1.status} q.status=${quote1?.status}` },
      { name: '报价号自动生成（QT- 前缀）', pass: typeof quote1?.quotationNumber === 'string' && quote1.quotationNumber.startsWith('QT-'), detail: quote1?.quotationNumber },
      { name: '行 imageUrl（产品图字段）落库', pass: line0?.imageUrl === q1Body.lines[0].imageUrl, detail: line0?.imageUrl },
      { name: '行 fabricCode 接得上产品档案 sku', pass: line0?.fabricCode === asset?.sku, detail: `fabricCode=${line0?.fabricCode}` },
      { name: '行金额 = 数量×单价（520000）', pass: Number(line0?.amount) === 520000, detail: `amount=${line0?.amount}` },
      { name: '客户挂接正确', pass: quote1?.customerRelationId === fabricCustomer.id, detail: quote1?.customerRelationId },
    ];
    record({
      step: '3.1 面料报价创建（Draft，带 imageUrl + fabricCode 接产品档案）',
      call: 'POST /api/v1/quotations',
      params: q1Body,
      httpStatus: q1.status,
      responseSummary: quote1 && { id: quote1.id, quotationNumber: quote1.quotationNumber, status: quote1.status, priceDeviationLevel: quote1.priceDeviationLevel },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
    });
    if (!quote1?.id) {
      deadEnd('3.1 面料报价', `创建失败 ${q1.status} ${q1.text}`, '报价创建链路异常（价格规则/MOQ/专属面料预检）', true);
      summarize();
      process.exit(1);
    }
  }

  // 3.2 状态机：Draft→Sent→Accepted + 非法负例（Draft 直接 accept → 409；Accepted 再 send → 409）
  {
    const bad1 = await api('POST', `/api/v1/quotations/${quote1.id}/accept`, { token: SALES_A }); // Draft→Accepted 非法
    const send = await api('POST', `/api/v1/quotations/${quote1.id}/send`, { token: SALES_A });
    const accept = await api('POST', `/api/v1/quotations/${quote1.id}/accept`, { token: SALES_A, body: { note: '客户邮件确认' } });
    const bad2 = await api('POST', `/api/v1/quotations/${quote1.id}/send`, { token: SALES_A }); // Accepted 终态再 send
    const assertions = [
      { name: 'Draft 直接 accept 被拒（409 非法转换）', pass: bad1.status === 409, detail: `status=${bad1.status}` },
      { name: 'Draft→Sent 流转', pass: send.status === 200 && send.json?.quotation?.status === 'Sent', detail: send.json?.quotation?.status },
      { name: 'Sent→Accepted 流转', pass: accept.status === 200 && accept.json?.quotation?.status === 'Accepted', detail: accept.json?.quotation?.status },
      { name: 'Accepted 终态再 send 被拒（409）', pass: bad2.status === 409, detail: `status=${bad2.status}` },
    ];
    record({
      step: '3.2 报价状态机 Draft→Sent→Accepted + 非法转换负例 ×2',
      call: 'POST /api/v1/quotations/:id/{send,accept} ×4',
      httpStatus: accept.status,
      responseSummary: { bad1: bad1.status, sent: send.json?.quotation?.status, accepted: accept.json?.quotation?.status, bad2: bad2.status },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
    });
    if (!assertions.every(a => a.pass)) deadEnd('3.2 报价状态机', '状态不流转或非法放行', 'TRANSITIONS 矩阵/发送门禁异常', true);
  }

  // 3.3 低于成本报价 → priceDeviationLevel=block → 发送门禁 fail-closed（非静默放行）
  const q2Body = {
    currency: 'CNY',
    customerRelationId: fabricCustomer.id,
    customerName: fabricCustomer.name,
    issueDate: TODAY,
    lines: [
      { fabricCode: `${RUN}-FAB-001`, description: '锦纶弹力面料（恶意低价）', quantity: 10000, unit: 'M', unitPrice: 30 }, // 成本 40 → 低于成本
    ],
  };
  const q2 = await api('POST', '/api/v1/quotations', { token: SALES_A, body: q2Body });
  const quote2 = q2.json?.quotation;
  const send2 = quote2?.id
    ? await api('POST', `/api/v1/quotations/${quote2.id}/send`, { token: SALES_A })
    : { status: 0, json: null, text: 'no quote2' };
  {
    const assertions = [
      { name: '创建即命中门禁：priceDeviationLevel = block', pass: quote2?.priceDeviationLevel === 'block', detail: `level=${quote2?.priceDeviationLevel}` },
      { name: '发送被拦（409），非静默放行', pass: send2.status === 409, detail: `status=${send2.status}` },
      { name: '拦截文案含门禁标识（price-deviation / 审批）', pass: typeof send2.json?.error === 'string' && (send2.json.error.includes('price-deviation') || send2.json.error.includes('审批')), detail: (send2.json?.error || '').slice(0, 80) },
      { name: '拦截后状态仍 Draft（无半流转）', pass: send2.json?.quotation === undefined, detail: '响应不含已流转报价单' },
    ];
    record({
      step: '3.3 低于成本报价门禁（block → send fail-closed 409）',
      call: 'POST /api/v1/quotations（unitPrice 30 < cost 40）→ POST /:id/send',
      params: q2Body,
      httpStatus: send2.status,
      responseSummary: { level: quote2?.priceDeviationLevel, approvalId: quote2?.priceApprovalId ?? null, send: send2.status, err: (send2.json?.error || '').slice(0, 100) },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
      note: '规则④低于成本=红标 block；审批单创建依赖可解析 requester（resolveActorUserAccountId 解析失败时 priceApprovalId 为空，门禁仍 fail-closed 兜底）',
    });
    if (!assertions.every(a => a.pass)) deadEnd('3.3 低于成本门禁', 'block 未触发或 send 静默放行', '价格规则④/发送门禁链路异常', true);
  }

  // 3.4 折扣>10% 触发 warn（目录价真源缺失时记观察项，不阻塞）
  {
    // 目录价缺失（无 FabricPriceHistory）→ 规则①跳过；改用双轨偏差 15~30% 构造 warn 档
    const q3Body = {
      currency: 'USD',
      customerRelationId: fabricCustomer.id,
      issueDate: TODAY,
      trackAMedianUsd: 10,
      trackAUnit: 'M',
      trackBFinalUsd: 8, // 偏差 -20% → warn
      lines: [{ description: '锦纶弹力面料 USD 报价', quantity: 10000, unit: 'M', unitPrice: 8 }],
    };
    const q3 = await api('POST', '/api/v1/quotations', { token: SALES_A, body: q3Body });
    const quote3 = q3.json?.quotation;
    const assertions = [
      { name: '双轨偏差 -20% → warn 档落库', pass: quote3?.priceDeviationLevel === 'warn', detail: `level=${quote3?.priceDeviationLevel} pct=${quote3?.priceDeviationPercent}` },
      { name: '偏差百分比落库（-20）', pass: Math.abs(Number(quote3?.priceDeviationPercent) + 20) < 0.01, detail: String(quote3?.priceDeviationPercent) },
    ];
    record({
      step: '3.4 偏差分级 warn 档（双轨 -20%；折扣>10% 规则①因目录价缺失走 §6 #2 异常分支跳过）',
      call: 'POST /api/v1/quotations（trackA=10 / trackB=8）',
      params: q3Body,
      httpStatus: q3.status,
      responseSummary: { level: quote3?.priceDeviationLevel, pct: quote3?.priceDeviationPercent },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
      note: '规则①折扣>10% 依赖 FabricPriceHistory 目录价；warn 不阻断发送（仅 block 阻断）',
    });
    if (!assertions.every(a => a.pass)) deadEnd('3.4 偏差分级', 'warn 档未落库', '双轨偏差计算异常', false);
  }

  // 3.5 成衣客户报价 + BOM 成本构成（Track A 成本拆解：面料/辅料/CMT/包装）
  const q4Body = {
    currency: 'USD',
    customerRelationId: garmentCustomer.id,
    customerName: garmentCustomer.name,
    issueDate: TODAY,
    validUntil: '2026-10-31',
    lines: [
      { description: '女式双排扣风衣（确认样版型）', quantity: 3000, unit: 'PC', unitPrice: 18.5 },
    ],
  };
  const q4 = await api('POST', '/api/v1/quotations', { token: SALES_A, body: q4Body });
  const quote4 = q4.json?.quotation;
  {
    const assertions = [
      { name: '成衣报价创建成功（Draft）', pass: q4.status === 201 && quote4?.status === 'Draft', detail: `status=${q4.status}` },
      { name: '成衣客户挂接正确', pass: quote4?.customerRelationId === garmentCustomer.id, detail: quote4?.customerRelationId },
      { name: '行单位 PC（成衣族）', pass: quote4?.lines?.[0]?.unit === 'PC', detail: quote4?.lines?.[0]?.unit },
    ];
    record({
      step: '3.5 成衣报价创建',
      call: 'POST /api/v1/quotations',
      params: q4Body,
      httpStatus: q4.status,
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
    });
  }
  if (quote4?.id) {
    const pricingBody = {
      category: 'garment',
      fabricPriceCny: 30,
      fabricConsumptionM: 2.2,
      fabricLossRate: 5,
      trimmingCostCny: 8,
      cmtCostCny: 25,
      packagingCostCny: 3,
      purchaseCostCny: 105,
      refundRate: 0.13,
      exchangeRate: 7.1,
      profitMargin: 0.12,
    };
    const pr = await api('POST', `/api/v2/finance/quotations/${quote4.id}/apply-pricing`, { token: SALES_A, body: pricingBody });
    const pricing = pr.json?.pricing;
    const trackALines: any[] = pricing?.trackA?.lines ?? [];
    const lineKeys = trackALines.map(l => l.key).sort();
    const detail = await api('GET', `/api/v1/quotations/${quote4.id}`, { token: SALES_A });
    const dq = detail.json?.quotation;
    const assertions = [
      { name: 'apply-pricing 成功', pass: pr.status === 200 && pr.json?.ok === true, detail: `status=${pr.status}` },
      { name: 'BOM 成本构成四行齐全（fabric/trimming/cmt/packaging）', pass: JSON.stringify(lineKeys) === JSON.stringify(['cmt', 'fabric', 'packaging', 'trimming']), detail: lineKeys.join('/') },
      { name: '各行金额 > 0（成本拆解非占位）', pass: trackALines.length === 4 && trackALines.every(l => Number(l.amountCny) > 0), detail: trackALines.map(l => `${l.key}=${l.amountCny}`).join(', ') },
      { name: '双轨快照写回报价单（trackAMedianUsd/trackBFinalUsd）', pass: Number(dq?.trackAMedianUsd) > 0 && Number(dq?.trackBFinalUsd) > 0, detail: `A=${dq?.trackAMedianUsd} B=${dq?.trackBFinalUsd}` },
      { name: '偏差分级落库（ok/warn/block 之一）', pass: ['ok', 'warn', 'block'].includes(dq?.priceDeviationLevel), detail: dq?.priceDeviationLevel },
    ];
    record({
      step: '3.6 成衣报价 BOM 成本构成（Track A 成本拆解 + 双轨快照写回）',
      call: `POST /api/v2/finance/quotations/${quote4.id}/apply-pricing`,
      params: pricingBody,
      httpStatus: pr.status,
      responseSummary: { lineKeys, deviation: pricing?.deviationLevel, canSend: pricing?.canSend },
      assertions,
      verdict: assertions.every(a => a.pass) ? 'PASS' : 'FAIL',
      note: '成衣报价成本构成载体 = Track A 成本拆解行（Quotation 行本身无 BOM 成本字段，双轨面板为内部参考不对客户展示）',
    });
    if (!assertions.every(a => a.pass)) deadEnd('3.6 成衣成本构成', 'Track A 拆解行缺失或快照未写回', 'apply-pricing 链路异常', false);
  } else {
    deadEnd('3.5 成衣报价', '创建失败，成本构成无法走查', '报价创建链路异常', true);
  }

  summarize();
}

// ────────────────────────────────────────────────────────────────────
function summarize() {
  const pass = records.filter(r => r.verdict === 'PASS').length;
  const fail = records.filter(r => r.verdict === 'FAIL').length;
  console.log(`\n${'='.repeat(70)}`);
  console.log(`走查汇总：${records.length} 步，PASS=${pass} FAIL=${fail}`);
  console.log(`死胡同：${deadEnds.length} 项`);
  for (const d of deadEnds) {
    console.log(`  - [${d.blocking ? '阻塞' : '非阻塞'}] ${d.step}：${d.symptom}（根因猜测：${d.rootCauseGuess}）`);
  }
  console.log(`${'='.repeat(70)}`);
  // 机器可读 JSON 落 stdout 尾部，供回填 v0.8 剧本 §7 表格
  console.log(JSON.stringify({ run: RUN, pass, fail, records: records.map(r => ({ step: r.step, verdict: r.verdict, httpStatus: r.httpStatus })), deadEnds }, null, 2));
  if (fail > 0) process.exitCode = 1;
}

main().catch(e => {
  console.error('走查脚本异常终止:', e);
  process.exit(2);
});
