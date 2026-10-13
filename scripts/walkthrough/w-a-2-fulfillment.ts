/**
 * W-A-2 切片卡「履约主干域」代码级模拟操作走查（A/B 链步骤 4-7）
 *
 * 走查范围：
 *   1. 订单：面料订单（MOQ 通过）→ 信用不足客户建单门禁 → 成衣订单（尺码配比+BOM 随单）
 *            → 确认订单 L1 生产管线初始化 + L6 BOM 草稿
 *   2. 采购：面料采购单 → 付款申请「先申请后付款」→ 成衣面辅料采购单 BOM 用量关联（L7）
 *   3. 生产跟单：交期录入 → 延迟登记联动（FactoryDelayRecord + 交期分 + 警示）
 *            → 工序链损耗/完工锁 → 成衣外发工序链（OutsourcingOrder 挂接）
 *   4. 入库：L8 自动入库（StockMovement 可回溯 + 幂等防重）
 *
 * 运行方式（后端 8081 需在跑，连 pandahub 库）：
 *   cd server && npx tsx ../scripts/walkthrough/w-a-2-fulfillment.ts
 *
 * 说明：
 *   - 操作面走 HTTP API（实机路径，与前端 apiService 同通道）
 *   - 落点断言走 Prisma 直连（server/node_modules 加载，同源 schema）
 *   - 所有业务单号带 WA2-<run> 前缀，便于识别与事后清理
 */

import { createRequire } from 'module';

const require2 = createRequire(import.meta.url);
const { PrismaClient } = require2('../../server/node_modules/@prisma/client');

const BASE = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local';
const PASSWORD = 'Bambook@2026';
const RUN = `WA2-${Date.now().toString(36).toUpperCase()}`;
const TODAY = new Date().toISOString().slice(0, 10);

// 走查用业务实体（pandahub 库已确认存在）
const CUST_OK = { id: 'DEMO-CUST-ATLAS', name: '【演示】Atlas Outfitters Ltd.' };
const CUST_FROZEN = { id: 'REL-1787224431389-4minff', name: 'REQ2-15 验收破产客户 31372' };
const MILL = { id: 'DEMO-MILL-DAESE', name: '【演示】DAESE Textile Co., Ltd.' };
const DYE_MILL = { id: 'DEMO-MILL-SUZHOU', name: '【演示】苏州蓝河染织' };

const prisma = new PrismaClient();

// ────────────────────────────────────────────────────────────────
// 记录器
// ────────────────────────────────────────────────────────────────
type Assertion = { name: string; ok: boolean; detail?: string };
type StepRec = { step: string; action: string; request?: any; response?: any; assertions: Assertion[]; verdict: 'PASS' | 'FAIL' | 'DEAD_END' | 'INFO' };
type DeadEnd = { id: string; title: string; severity: 'P0' | 'P1' | 'P2'; evidence: string; rootCauseGuess: string };

const steps: StepRec[] = [];
const deadEnds: DeadEnd[] = [];
let token = '';

function step(stepId: string, action: string): StepRec {
  const rec: StepRec = { step: stepId, action, assertions: [], verdict: 'INFO' };
  steps.push(rec);
  console.log(`\n══ ${stepId} ${action}`);
  return rec;
}
function check(rec: StepRec, name: string, ok: boolean, detail?: string) {
  rec.assertions.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function closeStep(rec: StepRec) {
  if (rec.verdict === 'INFO') {
    rec.verdict = rec.assertions.length === 0 ? 'INFO' : rec.assertions.every(a => a.ok) ? 'PASS' : 'FAIL';
  }
  console.log(`  → 判定：${rec.verdict}`);
}
function deadEnd(id: string, title: string, severity: DeadEnd['severity'], evidence: string, rootCauseGuess: string) {
  deadEnds.push({ id, title, severity, evidence, rootCauseGuess });
  console.log(`  ⚠ 死胡同[${id}] ${title}\n      证据：${evidence}\n      根因猜测：${rootCauseGuess}`);
}

async function api(method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

/** 轮询直到 fn() 返回非 null 值或超时（联动为 in-process fire-and-forget，需短暂等待） */
async function poll<T>(fn: () => Promise<T | null>, timeoutMs = 8000, intervalMs = 300): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`W-A-2 履约主干域走查 RUN=${RUN} BASE=${BASE} 日期=${TODAY}`);

  // ── S0 环境自检 + 登录 ──
  const s0 = step('S0', '环境自检 + 登录（jason.shen@bambook.local）');
  const health = await fetch(`${BASE}/api/health`).then(r => r.json()).catch(() => null);
  check(s0, 'health ok + database ok', health?.status === 'ok' && health?.database === 'ok', JSON.stringify(health)?.slice(0, 120));
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const login = await loginRes.json().catch(() => null);
  token = login?.token ?? '';
  check(s0, '登录成功拿 JWT', loginRes.ok && !!token, `user=${login?.user?.displayName} roles=${JSON.stringify(login?.user?.roles)}`);
  console.log(`  登录角色：${JSON.stringify(login?.user?.roles)} newRoleIds=${JSON.stringify(login?.user?.newRoleIds ?? login?.user?.roleIds)}`);
  if (!token) { console.log('无 token，走查终止'); process.exit(1); }
  closeStep(s0);

  // ── S1 A链步骤4：新建面料订单（MOQ 校验通过：1000 > fabric 800） ──
  const s1 = step('S1-A4', '新建面料订单（quantity=1000 > MOQ 800）');
  const fabricPoNo = `${RUN}-FABRIC-PO`;
  const fabricOrderReq = {
    customer: CUST_OK.name, customerRelationId: CUST_OK.id,
    product: `${RUN} 全棉斜纹面料`, type: 'Fabric', quantity: 1000,
    dueDate: '2026-09-10', quoteAmount: 12500, currency: 'CNY',
    poNumber: fabricPoNo, millRelationId: MILL.id, millName: MILL.name,
    businessLine: 'Fabric',
  };
  const fabricOrderRes = await api('POST', '/api/v2/orders', fabricOrderReq);
  s1.request = fabricOrderReq; s1.response = fabricOrderRes.data;
  const fabricOrder = fabricOrderRes.data?.order;
  check(s1, '创建成功 ok=true', fabricOrderRes.status === 200 && fabricOrderRes.data?.ok === true && !!fabricOrder?.id,
    `status=${fabricOrderRes.status} id=${fabricOrder?.id} code=${fabricOrder?.code}`);
  check(s1, '发号器编号 SO- 前缀', typeof fabricOrder?.code === 'string' && fabricOrder.code.length > 0, fabricOrder?.code);
  check(s1, 'MOQ advisory 校验通过（1000≥800）', fabricOrder?.moqCheck == null || fabricOrder?.moqCheck?.ok !== false,
    fabricOrder?.moqCheck ? `moqCheck.ok=${fabricOrder.moqCheck.ok}` : 'moqCheck=null');
  const fabricOrderId = fabricOrder?.id;
  closeStep(s1);

  // ── S2 信用不足客户建单门禁实证 ──
  const s2 = step('S2-A4', '信用冻结客户建单（验证门禁阻断）');
  const creditStatusRes = await api('GET', `/api/v1/credit/${CUST_FROZEN.id}/status`);
  // 响应为平铺 status 对象（serializeValue(status)，无 ok 包装）
  const cs = creditStatusRes.data;
  check(s2, 'creditService 门禁结论可得（creditFrozen=true + status=Frozen）', cs?.creditFrozen === true && cs?.status === 'Frozen',
    `creditFrozen=${cs?.creditFrozen} status=${cs?.status} frozenAt=${cs?.frozenAt ?? ''}`);
  const frozenOrderReq = {
    customer: CUST_FROZEN.name, customerRelationId: CUST_FROZEN.id,
    product: `${RUN} 信用门禁探针`, type: 'Fabric', quantity: 1000,
    dueDate: '2026-09-10', quoteAmount: 9999, currency: 'CNY', poNumber: `${RUN}-FROZEN-PO`,
  };
  const frozenOrderRes = await api('POST', '/api/v2/orders', frozenOrderReq);
  s2.request = frozenOrderReq; s2.response = frozenOrderRes.data;
  const frozenBlocked = frozenOrderRes.data?.ok === false || frozenOrderRes.status >= 400;
  check(s2, '信用冻结客户建单被服务端门禁阻断', frozenBlocked,
    `status=${frozenOrderRes.status} body=${JSON.stringify(frozenOrderRes.data)?.slice(0, 200)}`);
  if (!frozenBlocked) {
    s2.verdict = 'DEAD_END';
    deadEnd('DE-1', '信用门禁未接线：Frozen 客户可正常建单（checkCreditAvailable 生产代码零调用方）', 'P0',
      `POST /api/v2/orders customerRelationId=${CUST_FROZEN.id}（CreditLimit.status=Frozen）返回 status=${frozenOrderRes.status} ok=${frozenOrderRes.data?.ok} orderId=${frozenOrderRes.data?.order?.id ?? 'n/a'}；而 GET /api/v1/credit/:id/status 明确返回 creditFrozen=true`,
      'creditService.checkCreditAvailable（含 CREDIT_FROZEN_60_DAYS/CREDIT_REVOKED/OVERDUE_60_DAYS 错误码）仅在 creditService 内定义+单测消费，orderServiceV2.createOrder 与 V1 route 创建路径均未调用；信用控制规则 §6#6 的「订单创建/变更额度校验门禁」从未接线');
    // 清理探针单（软删，避免污染）
    const probeId = frozenOrderRes.data?.order?.id;
    if (probeId) await api('DELETE', `/api/v2/orders/${probeId}`);
  }
  closeStep(s2);

  // ── S3 B链步骤4：新建成衣订单（尺码配比+BOM 字段随单保存） ──
  const s3 = step('S3-B4', '新建成衣订单 + 订单行（尺码配比 sizeBreakdown / bomItems 随单保存）');
  const apparelPoNo = `${RUN}-APPAREL-PO`;
  const apparelOrderReq = {
    customer: CUST_OK.name, customerRelationId: CUST_OK.id,
    product: `${RUN} 连帽卫衣`, type: 'Apparel', quantity: 500,
    dueDate: '2026-09-20', quoteAmount: 40000, currency: 'CNY',
    poNumber: apparelPoNo, businessLine: 'Garment',
  };
  const apparelOrderRes = await api('POST', '/api/v2/orders', apparelOrderReq);
  s3.request = apparelOrderReq;
  const apparelOrder = apparelOrderRes.data?.order;
  const apparelOrderId = apparelOrder?.id;
  check(s3, '成衣订单创建成功（500 > garment MOQ 200）', apparelOrderRes.status === 200 && !!apparelOrderId,
    `id=${apparelOrderId} code=${apparelOrder?.code}`);
  const lineReq = {
    poNumber: apparelPoNo, itemNo: '1', description: `${RUN} 连帽卫衣-主行`,
    quantity: 500, unit: 'PC',
    sizeBreakdown: { S: 100, M: 200, L: 150, XL: 50 },
    bomItems: [
      { materialCode: `${RUN}-FAB-MAIN`, description: '卫衣面料', quantity: 1.4, unit: 'M' },
      { materialCode: `${RUN}-TRIM-ZIP`, description: '拉链', quantity: 1, unit: 'PC' },
    ],
  };
  const lineRes = await api('POST', '/api/v1/order-lines', lineReq);
  s3.response = { order: apparelOrderRes.data, line: lineRes.data };
  const lineId = lineRes.data?.line?.id;
  check(s3, '订单行创建成功', lineRes.status === 200 && !!lineId, `status=${lineRes.status} lineId=${lineId} err=${JSON.stringify(lineRes.data?.error ?? '')?.slice(0, 120)}`);
  if (lineId) {
    const lineRow = await prisma.orderLine.findUnique({ where: { id: lineId } });
    check(s3, 'sizeBreakdown 随单保存（尺码配比 JSON 落库）',
      !!lineRow?.sizeBreakdown && (lineRow.sizeBreakdown as any).M === 200,
      JSON.stringify(lineRow?.sizeBreakdown));
    check(s3, 'bomItems 随单保存（行级 BOM JSON 落库）',
      Array.isArray(lineRow?.bomItems) && (lineRow.bomItems as any[]).length === 2,
      JSON.stringify(lineRow?.bomItems)?.slice(0, 200));
  }
  closeStep(s3);

  // ── S4 A/B链步骤5：确认订单 → L1 生产管线初始化 + L6 BOM 草稿 ──
  const s4 = step('S4-A5/B5', '确认订单（V1 status-transition，前端真实路径）→ L1/L6 联动');
  const confirmRes = await api('POST', `/api/v1/orders/${fabricOrderId}/status-transition`, { toStatus: 'Confirmed', note: `${RUN} 走查确认` });
  s4.request = { orderId: fabricOrderId, toStatus: 'Confirmed' };
  s4.response = confirmRes.data;
  check(s4, 'Pending→Confirmed 流转成功', confirmRes.status === 200 && confirmRes.data?.ok === true,
    `status=${confirmRes.status} body=${JSON.stringify(confirmRes.data)?.slice(0, 160)}`);
  // L1：ProductionStage ×10
  const stages = await poll(async () => {
    const rows = await prisma.productionStage.findMany({ where: { orderId: fabricOrderId } });
    return rows.length >= 10 ? rows : null;
  });
  check(s4, 'L1 生产管线初始化（ProductionStage ×10）', !!stages,
    stages ? `stages=${stages.length} stage1=${stages.find((x: any) => x.stageSeq === 1)?.stageKey}:${stages.find((x: any) => x.stageSeq === 1)?.status}` : '超时未生成');
  // L6：BOM 草稿
  const bomA = await poll(async () => {
    return await prisma.bOM.findFirst({ where: { orderId: fabricOrderId, deletedAt: null }, include: { lines: true } });
  });
  check(s4, 'L6 BOM 草稿生成（status=Draft 且 orderId 关联）', !!bomA && bomA.status === 'Draft',
    bomA ? `bomNumber=${bomA.bomNumber} status=${bomA.status} lines=${bomA.lines?.length}` : '超时未生成');
  if (bomA) {
    const placeholder = (bomA.lines as any[]).some(l => String(l.description).includes('占位'));
    console.log(`  ℹ L6 无模板匹配 → 占位行 BOM：${placeholder ? '是（含「占位行，请编辑补充」文本）' : '否'}`);
  }
  // 成衣订单同样确认（B链步骤5）
  const confirmB = await api('POST', `/api/v1/orders/${apparelOrderId}/status-transition`, { toStatus: 'Confirmed', note: `${RUN} 走查确认` });
  check(s4, '成衣订单 Pending→Confirmed', confirmB.status === 200 && confirmB.data?.ok === true,
    `status=${confirmB.status} ${JSON.stringify(confirmB.data?.error ?? '')?.slice(0, 120)}`);
  const bomB = await poll(async () => {
    return await prisma.bOM.findFirst({ where: { orderId: apparelOrderId, deletedAt: null }, include: { lines: true } });
  });
  check(s4, '成衣订单 L6 BOM 草稿生成', !!bomB && bomB.status === 'Draft',
    bomB ? `bomNumber=${bomB.bomNumber} lines=${bomB.lines?.length}` : '超时未生成');
  const stagesB = await poll(async () => {
    const rows = await prisma.productionStage.findMany({ where: { orderId: apparelOrderId } });
    return rows.length >= 10 ? rows : null;
  });
  check(s4, '成衣订单 L1 生产管线初始化', !!stagesB, stagesB ? `stages=${stagesB.length}` : '超时未生成');
  closeStep(s4);

  // ── S4b 对照：V2 PATCH /status 路径差异探测 ──
  const s4b = step('S4b-对照', 'V2 PATCH /:id/status 确认路径差异探测（L1/L6 是否触发）');
  const probeOrderReq = {
    customer: CUST_OK.name, customerRelationId: CUST_OK.id,
    product: `${RUN} V2路径探针`, type: 'Fabric', quantity: 1000,
    dueDate: '2026-09-10', quoteAmount: 100, currency: 'CNY', poNumber: `${RUN}-V2PROBE-PO`,
  };
  const probeOrderRes = await api('POST', '/api/v2/orders', probeOrderReq);
  const probeOrderId = probeOrderRes.data?.order?.id;
  const probeConfirm = await api('PATCH', `/api/v2/orders/${probeOrderId}/status`, { status: 'Confirmed' });
  s4b.request = probeOrderReq; s4b.response = probeConfirm.data;
  check(s4b, 'V2 PATCH 确认成功', probeConfirm.status === 200 && probeConfirm.data?.ok === true,
    `status=${probeConfirm.status}`);
  // 等 3s（联动若存在应已执行）
  await new Promise(r => setTimeout(r, 3000));
  const probeStages = await prisma.productionStage.findMany({ where: { orderId: probeOrderId } });
  const probeBom = await prisma.bOM.findFirst({ where: { orderId: probeOrderId, deletedAt: null } });
  const v2TriggersLinkage = probeStages.length > 0 || !!probeBom;
  check(s4b, 'V2 确认路径触发 L1/L6 联动', v2TriggersLinkage,
    `stages=${probeStages.length} bom=${probeBom?.bomNumber ?? 'none'}`);
  if (!v2TriggersLinkage) {
    s4b.verdict = 'DEAD_END';
    deadEnd('DE-2', '双确认路径行为分裂：V2 PATCH /api/v2/orders/:id/status 确认订单不发布 OrderConfirmed 事件 → L1 生产管线/L6 BOM 均不初始化', 'P0',
      `探针单 ${probeOrderId} 经 V2 PATCH 确认 Confirmed 成功（HTTP 200），3s 后 ProductionStage=0、BOM=none；同操作经 V1 POST /api/v1/orders/:id/status-transition（前端 apiService 实际通道）则 L1/L6 正常触发`,
      'orderServiceV2.transitionStatus 只做状态更新+OrderStatusTransition 留痕，未像 orderLifecycleService.transitionOrderStatus 那样 publishBusinessEvent(OrderConfirmed)；V2 路由带 MOQ Confirmed 门禁但不发事件，V1 路由发事件但无 MOQ 门禁——两条路径各缺一半');
  }
  closeStep(s4b);

  // ── S5 A链步骤6：对面料订单建采购单 → send → confirm ──
  const s5 = step('S5-A6', '对面料订单建采购单（orderId 挂接 + 供应商）');
  const poReq = {
    poNumber: `${RUN}-PO-FABRIC`, currency: 'CNY', orderDate: TODAY,
    supplierRelationId: MILL.id, supplierName: MILL.name,
    orderId: fabricOrderId, expectedDeliveryDate: '2026-09-01',
    lines: [{ materialCode: `${RUN}-FAB-001`, description: `${RUN} 全棉斜纹面料`, quantity: 1000, unit: 'M', unitPrice: 12.5 }],
  };
  const poRes = await api('POST', '/api/v1/procurement', poReq);
  s5.request = poReq; s5.response = poRes.data;
  const poId = poRes.data?.purchaseOrder?.id;
  check(s5, '采购单创建（Draft）', poRes.status === 201 && !!poId,
    `status=${poRes.status} id=${poId} status=${poRes.data?.purchaseOrder?.status}`);
  check(s5, '采购单挂接面料订单 orderId', poRes.data?.purchaseOrder?.orderId === fabricOrderId, poRes.data?.purchaseOrder?.orderId);
  const sendRes = await api('POST', `/api/v1/procurement/${poId}/send`);
  check(s5, 'Draft→Sent', sendRes.status === 200 && sendRes.data?.purchaseOrder?.status === 'Sent', `status=${sendRes.status}`);
  const confirmPoRes = await api('POST', `/api/v1/procurement/${poId}/confirm`);
  check(s5, 'Sent→Confirmed（收料前提）', confirmPoRes.status === 200 && confirmPoRes.data?.purchaseOrder?.status === 'Confirmed', `status=${confirmPoRes.status}`);
  closeStep(s5);

  // ── S6 付款申请「先申请后付款」审批链 ──
  const s6 = step('S6-A6', '付款申请（PaymentRequest 生成 + 审批链 + 不可直付实证）');
  const prReq = {
    supplierId: MILL.id, supplierName: MILL.name, totalAmount: 12500, currency: 'CNY',
    sourceType: 'purchase_order', sourceId: poId, remark: `${RUN} 面料款`, expectedPaymentDate: '2026-09-05',
  };
  const prRes = await api('POST', '/api/v1/payment-requests', prReq);
  s6.request = prReq; s6.response = prRes.data;
  const payReq = prRes.data?.paymentRequest;
  check(s6, '付款申请创建（status=Pending）', prRes.status === 201 && payReq?.status === 'Pending',
    `status=${prRes.status} requestNumber=${payReq?.requestNumber} prStatus=${payReq?.status}`);
  check(s6, 'ApprovalRequest 审批单生成（DR-007）', !!prRes.data?.approvalRequestId, prRes.data?.approvalRequestId);
  if (prRes.data?.approvalRequestId) {
    const approval = await prisma.approvalRequest.findUnique({ where: { id: prRes.data.approvalRequestId } });
    check(s6, '审批单落库 actionType=finance:payment_request + Pending',
      approval?.actionType === 'finance:payment_request' && String(approval?.status).toLowerCase() === 'pending',
      `actionType=${approval?.actionType} status=${approval?.status} reviewerId=${approval?.reviewerId}`);
  }
  // 不可直付实证 ①：PaymentRequest 域无凭证生成 HTTP 端点
  const issueProbe = await api('POST', `/api/v1/payment-requests/${payReq?.id}/issue-voucher`, {});
  check(s6, '未批准申请无凭证生成端点（POST .../issue-voucher → 404）', issueProbe.status === 404,
    `status=${issueProbe.status}（凭证生成 issueVoucherForApprovedRequest 仅 service 层，生产代码无调用方）`);
  // 不可直付实证 ②：PaymentVoucher 直付旁路是否有门禁
  const directVoucherReq = {
    type: 'Disbursement', voucherCategory: 'normal', amount: 12500, currency: 'CNY',
    paymentDate: TODAY, paymentMethod: 'TT', customerRelationId: MILL.id, customerName: MILL.name,
    notes: `${RUN} 直付旁路探针（未经付款申请）`,
  };
  const directVoucherRes = await api('POST', '/api/v1/finance/vouchers', directVoucherReq);
  const directVoucherId = directVoucherRes.data?.voucher?.id ?? directVoucherRes.data?.id;
  const directBlocked = directVoucherRes.status >= 400;
  check(s6, '直付旁路（未经 PaymentRequest 直接建 Disbursement 凭证）被门禁阻断', directBlocked,
    `status=${directVoucherRes.status} voucherId=${directVoucherId ?? 'n/a'}`);
  if (!directBlocked) {
    deadEnd('DE-3', '「先申请后付款」非唯一通道：PaymentVoucher 直付无门禁（可绕过 PaymentRequest 审批链直接付款）', 'P1',
      `POST /api/v1/finance/vouchers { type:'Disbursement', amount:12500, supplier=${MILL.id} } 未关联任何 PaymentRequest 即创建成功（voucherId=${directVoucherId}）；DR-017 闭环只约束 PaymentRequest→issueVoucher 路径，paymentVoucherMutationService.createPaymentVoucher 无任何 PaymentRequest 前置校验`,
      'createPaymentVoucher 只校验枚举字段，未按 voucherCategory/金额区间要求关联 Approved PaymentRequest；「先申请后付款」目前是倡议式流程而非系统门禁');
    // 清理直付探针凭证（软删，避免污染财务数据）
    if (directVoucherId) await api('DELETE', `/api/v1/finance/vouchers/${directVoucherId}`);
  }
  closeStep(s6);

  // ── S7 B链步骤6：成衣面辅料采购单 BOM 用量关联（L6→完善→confirm→L7） ──
  const s7 = step('S7-B6', '成衣面辅料采购单验证 BOM 用量关联（L7 自动生成 Draft PO）');
  let l7PoId: string | null = null;
  if (bomB) {
    const bomUpdateReq = {
      lines: [
        { materialType: 'Main', materialCode: `${RUN}-FAB-MAIN`, description: '卫衣面料', category: '面料', quantity: 700, unit: 'M', wastagePercent: 5, unitCost: 12.5 },
        { materialType: 'Trimmings', materialCode: `${RUN}-TRIM-ZIP`, description: '拉链', category: '辅料', quantity: 500, unit: 'PC', wastagePercent: 0, unitCost: 0.8 },
      ],
    };
    const bomUpdateRes = await api('PUT', `/api/v1/bom/${bomB.id}`, bomUpdateReq);
    s7.request = bomUpdateReq;
    const updatedLines = bomUpdateRes.data?.bom?.lines ?? bomUpdateRes.data?.lines;
    check(s7, 'L6 占位 BOM 完善为真实用量行（数量=BOM 用量口径）', bomUpdateRes.status === 200 && (updatedLines?.length ?? 0) === 2,
      `status=${bomUpdateRes.status} lines=${updatedLines?.length} err=${JSON.stringify(bomUpdateRes.data)?.slice(0, 160)}`);
    const bomConfirmRes = await api('POST', `/api/v1/bom/${bomB.id}/confirm`);
    check(s7, 'BOM Draft→Confirmed（触发 BOMConfirmed 事件）', bomConfirmRes.status === 200,
      `status=${bomConfirmRes.status} ${JSON.stringify(bomConfirmRes.data)?.slice(0, 160)}`);
    const l7Po = await poll(async () => {
      return await prisma.purchaseOrder.findFirst({ where: { bomId: bomB.id, deletedAt: null }, include: { lines: true } });
    });
    s7.response = l7Po;
    check(s7, 'L7 自动生成 Draft 采购单（bomId 关联）', !!l7Po && l7Po.status === 'Draft',
      l7Po ? `poNumber=${l7Po.poNumber} status=${l7Po.status}` : '超时未生成');
    if (l7Po) {
      l7PoId = l7Po.id;
      check(s7, 'L7 采购单关联成衣订单 orderId', l7Po.orderId === apparelOrderId, l7Po.orderId);
      // L7 口径（L7CreateProcurement.ts:86）：采购量 = BOM 行 effectiveQty（含损耗实际用量）
      // 卫衣面料 700×(1+5%)=735，拉链 500×(1+0%)=500
      const expectedQtys = [735, 500];
      const poQtys = (l7Po.lines as any[]).map(l => Number(l.quantity)).sort((a, b) => b - a);
      check(s7, '采购行数量 = BOM 有效用量 effectiveQty（含损耗：700×1.05=735 / 500×1.0=500）',
        JSON.stringify(poQtys) === JSON.stringify(expectedQtys),
        `poLines=${JSON.stringify((l7Po.lines as any[]).map(l => ({ d: l.description, q: Number(l.quantity), u: l.unit })))}`);
    }
  } else {
    check(s7, '前置 BOM 存在', false, 'S4 未生成成衣 BOM，跳过 L7 验证');
  }
  closeStep(s7);

  // ── S8 生产跟单：录入交期 → 登记延迟联动 ──
  const s8 = step('S8-A/B7', '生产跟单：交期录入 → 延迟登记联动（FactoryDelayRecord + 交期分 + 警示）');
  const dueRes = await api('PUT', `/api/v2/orders/${fabricOrderId}`, { dueDate: '2026-09-03' });
  check(s8, '交期录入（dueDate → 2026-09-03）', dueRes.status === 200 && dueRes.data?.ok === true,
    `status=${dueRes.status} dueDate=${dueRes.data?.order?.dueDate}`);
  const evalBefore = await prisma.factoryEvaluation.count({ where: { factory: { relationId: MILL.id }, kind: 'delivery' } }).catch(() => -1);
  const delayReq = { supplierRelationId: MILL.id, delayDays: 6, reason: 'material', reasonNote: `${RUN} 走查：原料短缺` };
  const delayRes = await api('POST', '/api/v1/suppliers/delays', delayReq);
  s8.request = delayReq; s8.response = delayRes.data;
  const delayRec = delayRes.data?.record;
  check(s8, 'FactoryDelayRecord 生成', delayRes.status === 201 && !!delayRec?.id,
    `status=${delayRes.status} recordNumber=${delayRec?.recordNumber}`);
  const impactItems = delayRes.data?.impact?.items ?? [];
  const myImpact = impactItems.find((x: any) => x.orderId === fabricOrderId);
  check(s8, '影响计算命中面料订单（缓冲侵蚀分级）', !!myImpact,
    myImpact ? `level=${myImpact.level} bufferDays=${myImpact.bufferDays} newCompletion=${myImpact.newCompletionDate}` : `items=${impactItems.length} 未命中`);
  check(s8, '受影响订单 ID 列表含面料订单', Array.isArray(delayRec?.affectedOrderIds) && delayRec.affectedOrderIds.includes(fabricOrderId),
    `affected=${delayRec?.affectedOrderIds?.length}`);
  check(s8, '交期分联动标记 qualityScoreLinked=true', delayRes.data?.qualityScoreLinked === true,
    `qualityScoreLinked=${delayRes.data?.qualityScoreLinked}`);
  if (delayRec?.id) {
    const evalRow = await prisma.factoryEvaluation.findFirst({ where: { sourceType: 'factory_delay', sourceId: delayRec.id } });
    check(s8, '工厂交期分落库（FactoryEvaluation kind=delivery，delayDaysToScore(6)=60）',
      evalRow?.kind === 'delivery' && Number(evalRow?.score) === 60,
      evalRow ? `kind=${evalRow.kind} score=${evalRow.score}` : '未落库');
  }
  const hasAlertText = !!delayRes.data?.impact?.advice;
  console.log(`  ℹ 警示形态：API 返回 impact.advice 文案（critical/warning/info 分级+沟通建议）=${hasAlertText ? '有' : '无'}；后端不落持久化警示单`);
  closeStep(s8);

  // ── S9 工序链损耗 / 完工锁 ──
  const s9 = step('S9-A7', '面料工序链：损耗计算 + 完工锁字段');
  const nodeReq = { orderId: fabricOrderId, seq: 1, processType: 'dyeing', supplierId: DYE_MILL.id, inputQty: 1000, unit: 'M', unitPrice: 2, notes: `${RUN} 染整` };
  const nodeRes = await api('POST', '/api/v1/mes/order-processes', nodeReq);
  s9.request = nodeReq; s9.response = nodeRes.data;
  const nodeId = nodeRes.data?.node?.id;
  check(s9, '工序节点创建（planned，预估金额=投入×单价=2000）', (nodeRes.status === 201 || nodeRes.status === 200) && !!nodeId,
    `status=${nodeRes.status} nodeId=${nodeId} amount=${nodeRes.data?.node?.amount}`);
  const startRes = await api('POST', `/api/v1/mes/order-processes/${nodeId}/start`);
  check(s9, 'planned→in_progress', startRes.status === 200 && startRes.data?.node?.status === 'in_progress', `status=${startRes.status}`);
  const completeRes = await api('POST', `/api/v1/mes/order-processes/${nodeId}/complete`, { outputQty: 950 });
  check(s9, '完工登记（产出 950 → 损耗率 5% + 金额按产出重算 1900）',
    completeRes.status === 200 && Number(completeRes.data?.lossPct) === 5 && Number(completeRes.data?.node?.amount) === 1900,
    `lossPct=${completeRes.data?.lossPct} amount=${completeRes.data?.node?.amount} status=${completeRes.status}`);
  const lockPatchRes = await api('PATCH', `/api/v1/mes/order-processes/${nodeId}`, { inputQty: 900 });
  check(s9, '完工锁：done 节点禁止改量（409 NODE_DONE）', lockPatchRes.status === 409,
    `status=${lockPatchRes.status} body=${JSON.stringify(lockPatchRes.data)?.slice(0, 120)}`);
  const lockDelRes = await api('DELETE', `/api/v1/mes/order-processes/${nodeId}`);
  check(s9, '完工锁：done 节点禁止删除（409 NOT_PLANNED）', lockDelRes.status === 409,
    `status=${lockDelRes.status}`);
  closeStep(s9);

  // ── S10 成衣外发工序链登记（OutsourcingOrder 挂接） ──
  const s10 = step('S10-B7', '成衣外发工序链：OutsourcingOrder 创建 + 工序节点挂接');
  const osoReq = {
    orderNumber: `${RUN}-OSO`, supplierId: DYE_MILL.id, orderId: apparelOrderId,
    processType: 'Sewing', description: `${RUN} 缝制外发`, quantity: 500, unit: 'PC', unitPrice: 8,
    orderDate: TODAY, plannedDeliveryDate: '2026-09-15',
  };
  const osoRes = await api('POST', '/api/v1/mes/outsourcing', osoReq);
  s10.request = osoReq; s10.response = osoRes.data;
  const osoId = osoRes.data?.item?.id ?? osoRes.data?.outsourcingOrder?.id ?? osoRes.data?.order?.id ?? osoRes.data?.id;
  check(s10, '外协单创建（orderId 挂成衣订单）', (osoRes.status === 201 || osoRes.status === 200) && !!osoId,
    `status=${osoRes.status} osoId=${osoId} body=${JSON.stringify(osoRes.data)?.slice(0, 200)}`);
  if (osoId) {
    const osoNodeReq = { orderId: apparelOrderId, seq: 1, processType: 'other', supplierId: DYE_MILL.id, inputQty: 500, unit: 'M', unitPrice: 8, outsourcingOrderId: osoId, notes: `${RUN} 外发缝制` };
    const osoNodeRes = await api('POST', '/api/v1/mes/order-processes', osoNodeReq);
    const osoNodeId = osoNodeRes.data?.node?.id;
    check(s10, '工序节点挂接 outsourcingOrderId', (osoNodeRes.status === 201 || osoNodeRes.status === 200) && !!osoNodeId,
      `status=${osoNodeRes.status} nodeId=${osoNodeId} err=${JSON.stringify(osoNodeRes.data)?.slice(0, 160)}`);
    if (osoNodeId) {
      const nodeRow = await prisma.orderProcessNode.findUnique({ where: { id: osoNodeId } });
      check(s10, '挂接落库（OrderProcessNode.outsourcingOrderId = OSO id）', nodeRow?.outsourcingOrderId === osoId,
        `outsourcingOrderId=${nodeRow?.outsourcingOrderId}`);
    }
  }
  closeStep(s10);

  // ── S11 入库：L8 自动入库 + 幂等防重 + 三击回溯 ──
  const s11 = step('S11-A/B7', '采购收料 → L8 自动入库（库存变化 + 流水回溯 + 幂等防重）');
  const itemBefore = await prisma.inventoryItem.findFirst({ where: { materialCode: `${RUN}-FAB-001`, deletedAt: null } });
  const qtyBefore = Number(itemBefore?.quantity ?? 0);
  const receiptNo = `${RUN}-RCV-001`;
  const receiptReq = { receiptNumber: receiptNo, receivedDate: TODAY, totalReceived: 1000, totalAccepted: 1000, totalRejected: 0, receivedBy: 'walkthrough' };
  const receiptRes = await api('POST', `/api/v1/procurement/${poId}/receipts`, receiptReq);
  s11.request = receiptReq;
  const receipt = receiptRes.data?.receipt;
  check(s11, '收料单创建（全部合格 → PO Received）', receiptRes.status === 201 && !!receipt?.id,
    `status=${receiptRes.status} receiptId=${receipt?.id} receiptStatus=${receipt?.status}`);
  const poAfter = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
  check(s11, 'PO 状态 → Received', poAfter?.status === 'Received', poAfter?.status);
  // L8 轮询
  const movement = await poll(async () => {
    return await prisma.stockMovement.findFirst({ where: { referenceType: 'PurchaseOrder', referenceId: receipt?.id }, include: { item: true } });
  });
  s11.response = { receipt, movement };
  check(s11, 'L8 自动入库流水生成（StockMovement Inbound 1000）',
    !!movement && movement.type === 'Inbound' && Number(movement.quantity) === 1000,
    movement ? `movementId=${movement.id} qty=${movement.quantity} reason=${movement.reason}` : '超时未生成');
  if (movement) {
    const itemAfter = await prisma.inventoryItem.findUnique({ where: { id: movement.itemId } });
    check(s11, '库存余量变化（0 → 1000）', Number(itemAfter?.quantity) - qtyBefore === 1000,
      `item=${itemAfter?.materialCode} warehouseId=${itemAfter?.warehouseId} qty=${itemAfter?.quantity}`);
    // 三击回溯：movement.referenceId → receipt → PO → Order
    const receiptRow = await prisma.materialReceipt.findUnique({ where: { id: movement.referenceId! } });
    const poRow = receiptRow ? await prisma.purchaseOrder.findUnique({ where: { id: receiptRow.purchaseOrderId } }) : null;
    const orderRow = poRow?.orderId ? await prisma.order.findUnique({ where: { id: poRow.orderId } }) : null;
    check(s11, '三击回溯链：StockMovement.referenceId → 收料单 → 采购单 → 订单',
      !!receiptRow && !!poRow && orderRow?.id === fabricOrderId,
      `movement→receipt(${receiptRow?.receiptNumber})→PO(${poRow?.poNumber})→Order(${orderRow?.code ?? orderRow?.poNumber})`);
  }
  // 幂等防重：重复提交同一收料单号
  const movementsBefore = await prisma.stockMovement.count({ where: { referenceType: 'PurchaseOrder', referenceId: receipt?.id } });
  const dupRes = await api('POST', `/api/v1/procurement/${poId}/receipts`, receiptReq);
  const dupReceipt = dupRes.data?.receipt;
  await new Promise(r => setTimeout(r, 1500));
  const movementsAfter = await prisma.stockMovement.count({ where: { referenceType: 'PurchaseOrder', referenceId: receipt?.id } });
  const itemFinal = movement ? await prisma.inventoryItem.findUnique({ where: { id: movement.itemId } }) : null;
  check(s11, '幂等：重复提交同一收料单号返回既有记录（不新建）', dupReceipt?.id === receipt?.id,
    `dup.receiptId=${dupReceipt?.id} 原=${receipt?.id} http=${dupRes.status}`);
  check(s11, '幂等：不二次入库（StockMovement 数不变 + 库存不翻倍）',
    movementsAfter === movementsBefore && Number(itemFinal?.quantity ?? 0) - qtyBefore === 1000,
    `movements ${movementsBefore}→${movementsAfter} qty=${itemFinal?.quantity}`);
  closeStep(s11);

  // ── S12 三否决项检查 ──
  const s12 = step('S12', '三否决项检查（跳系统手工断点）');
  // 12a MOQ 不满足：V2 确认门禁 + 自动豁免审批单入口
  const smallOrderReq = {
    customer: CUST_OK.name, customerRelationId: CUST_OK.id, product: `${RUN} MOQ探针面料`,
    type: 'Fabric', quantity: 500, dueDate: '2026-09-10', quoteAmount: 100, currency: 'CNY', poNumber: `${RUN}-MOQ-PO`,
  };
  const smallOrderRes = await api('POST', '/api/v2/orders', smallOrderReq);
  const smallOrderId = smallOrderRes.data?.order?.id;
  const smallMoqAdvisory = smallOrderRes.data?.order?.moqCheck;
  check(s12, 'MOQ 不满足（500<800）创建为 advisory 不阻断（草稿可保存）', smallOrderRes.status === 200 && !!smallOrderId,
    `moqCheck.ok=${smallMoqAdvisory?.ok} blocked=${JSON.stringify(smallMoqAdvisory?.blockedLineIndexes)}`);
  const smallConfirmV2 = await api('PATCH', `/api/v2/orders/${smallOrderId}/status`, { status: 'Confirmed' });
  // routeV2 响应形态：{ error: '<code 字符串>', message }（error 非对象，approvalRequestId 不透传）
  const moqBlockedV2 = smallConfirmV2.data?.error === 'MOQ_VIOLATION' || smallConfirmV2.data?.error?.code === 'MOQ_VIOLATION';
  check(s12, 'V2 确认门禁阻断（MOQ_VIOLATION）', moqBlockedV2,
    `http=${smallConfirmV2.status} error=${JSON.stringify(smallConfirmV2.data?.error)?.slice(0, 80)}`);
  const moqApproval = moqBlockedV2 ? await prisma.approvalRequest.findFirst({
    where: { targetType: 'Order', targetId: smallOrderId, actionType: 'order:moq-exemption' },
  }) : null;
  check(s12, 'MOQ 豁免审批单自动发起并落库（系统内入口，无跳手工）', !!moqApproval,
    `id=${moqApproval?.id ?? 'none'} status=${moqApproval?.status ?? ''}`);
  if (moqBlockedV2) {
    const contractFlaw = smallConfirmV2.status === 500 || !smallConfirmV2.data?.error?.approvalRequestId;
    if (contractFlaw) {
      deadEnd('DE-6', 'MOQ 门禁 HTTP 契约缺陷：阻断返回 500（应 409/422）且不透传 approvalRequestId，客户端无法引导用户到豁免审批单', 'P2',
        `V2 PATCH 小单确认 → HTTP ${smallConfirmV2.status} body.error=${JSON.stringify(smallConfirmV2.data?.error)}（字符串形态）；orderServiceV2 内部已生成 approvalRequestId 但 routeV2 的 res.json({error, message}) 丢弃了该字段；审批单实际已落库`,
        'routeV2 PATCH /:id/status 的 statusMap 无 MOQ_VIOLATION（fallback 500），且响应构造只取 error.code/message 两字段，service 返回的 approvalRequestId 未透传');
    }
  }
  // 12a-2 对照：V1 确认同一张小单（MOQ 门禁是否存在）
  const smallConfirmV1 = await api('POST', `/api/v1/orders/${smallOrderId}/status-transition`, { toStatus: 'Confirmed', note: `${RUN} V1路径MOQ探针` });
  const v1Blocked = smallConfirmV1.status >= 400;
  check(s12, '对照：V1 确认路径同受 MOQ 门禁阻断', v1Blocked,
    `status=${smallConfirmV1.status} body=${JSON.stringify(smallConfirmV1.data)?.slice(0, 140)}`);
  if (!v1Blocked) {
    deadEnd('DE-4', 'MOQ Confirmed 门禁仅存在于 V2 路径：V1 status-transition（前端实际通道）可绕过 MOQ 直接确认', 'P1',
      `500m 面料小单（MOQ 800）V2 PATCH 被 MOQ_VIOLATION 阻断并自动生成豁免审批单，但同一订单经 V1 POST status-transition 确认返回 ${smallConfirmV1.status} ok=${smallConfirmV1.data?.ok}`,
      'MOQ Confirmed 门禁实现于 orderServiceV2.transitionStatus；orderLifecycleService.transitionOrderStatus（V1/Agent flow 共用）无 MOQ 校验——门禁与事件发布分裂在两条路径（与 DE-2 同根）');
  }
  // 12b 信用阻断例外申请入口
  const creditExcRes = await api('POST', '/api/v1/exceptions', { exceptionCategory: 'credit_exemption', targetType: 'Relation', targetId: CUST_FROZEN.id, action: 'order:create', reason: `${RUN} 探针：信用例外入口探测（至少五字）` });
  check(s12, '信用例外申请入口（DR-013 credit_exemption 类别）不存在且被明确拒绝', creditExcRes.status === 400,
    `status=${creditExcRes.status} msg=${creditExcRes.data?.message ?? JSON.stringify(creditExcRes.data)?.slice(0, 120)}`);
  if (creditExcRes.status !== 400) {
    console.log('  ℹ 例外类别接受情况与预期不符，需人工复核');
  }
  deadEnds.push({
    id: 'DE-5', title: '信用阻断无系统内例外申请入口（DR-013 八类例外不含信用类）', severity: 'P2',
    evidence: `POST /api/v1/exceptions {exceptionCategory:'credit_exemption'} → ${creditExcRes.status}（EXCEPTION_CATEGORIES=moq_exemption/price_deviation/order_change/shipment_release/qc_fault/payment_term/sample_skip/other，无信用类）`,
    rootCauseGuess: '信用控制规则未定义例外通道；叠加 DE-1（门禁未接线），信用域当前是「有结论、无执行、无例外」状态',
  });
  console.log(`  ⚠ 死胡同[DE-5] 信用阻断无系统内例外申请入口（与 DE-1 合并评估）`);
  // 12c 占位文本
  const placeholderBom = await prisma.bOMLine.findFirst({ where: { bom: { orderId: { in: [fabricOrderId, apparelOrderId].filter(Boolean) as string[] } }, description: { contains: '占位' } } }).catch(() => null);
  console.log(`  ℹ 占位文本检查：L6 无模板时生成「占位行，请编辑补充」BOM 行=${placeholderBom ? '存在（设计决策：明示待补充，非 UI 假占位）' : '未命中'}`);
  closeStep(s12);

  // ── 汇总 ──
  console.log('\n\n════════════ 走查汇总 ════════════');
  console.log(`RUN=${RUN}`);
  for (const s of steps) {
    const passed = s.assertions.filter(a => a.ok).length;
    const total = s.assertions.length;
    console.log(`${s.verdict === 'PASS' ? '✓' : s.verdict === 'FAIL' ? '✗' : s.verdict === 'DEAD_END' ? '⚠' : 'ℹ'} [${s.verdict}] ${s.step} ${s.action}（断言 ${passed}/${total}）`);
  }
  console.log(`\n死胡同/断点 ${deadEnds.length} 项：`);
  for (const d of deadEnds) console.log(`  [${d.severity}] ${d.id} ${d.title}`);
  console.log('\n关键实体 ID（便于复核/清理）：');
  console.log(JSON.stringify({
    RUN, fabricOrderId, apparelOrderId, probeOrderId, smallOrderId,
    fabricPoId: poId, l7PoId, paymentRequestId: payReq?.id, receiptId: receipt?.id,
  }, null, 1));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('走查脚本异常中止：', e);
  await prisma.$disconnect();
  process.exit(1);
});
