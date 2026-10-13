/**
 * Agent 端到端联调脚本
 * ========================
 *
 * 目标：验证"代码 OK"是不是真的"产品 OK"。tsc/build 不能证明 LLM-Planner
 * 真的能选对工具、approval 流真的会拦住、错误真的能恢复。
 *
 * 用例覆盖（10 个）：
 *   只读 query (4)：products.query / relations.expand / orders.expand / development.query
 *   关系图谱 (2)：links.query / links.expand_neighbors
 *   生产 (2)：orders.list_by_status / orders.kanban
 *   Mutation+approval (2)：orders.update_status / development.convert_to_order
 *
 * 每个用例记录：选中的工具 / 输入 / 输出摘要 / 是否触发 approval / 失败原因。
 */
import { PrismaClient } from '@prisma/client';
import { runAgentToolCalls, PlannedToolCall } from '../src/agent/toolRuntime';
import { ActorContext } from '../src/agent/types';

const ownerActor: ActorContext = {
  userId: 'e2e-tester-owner',
  displayName: 'E2E Tester (Owner)',
  roles: ['owner'],
  departmentIds: ['company'],
  permissionScopes: ['admin'],
  memoryScopes: ['company'],
  knowledgeScopes: ['company', 'owner', 'products'],
  toolScopes: ['admin', 'products', 'orders', 'relations', 'knowledge', 'development', 'automation', 'finance', 'shipping', 'email'],
};

type CaseResult = {
  caseId: string;
  toolId: string;
  status: 'success' | 'approval_required' | 'rejected' | 'error';
  outputSummary?: string;
  errorMessage?: string;
  durationMs: number;
};

async function runOne(prisma: PrismaClient, caseId: string, call: PlannedToolCall): Promise<CaseResult> {
  const start = Date.now();
  let status: CaseResult['status'] = 'error';
  let outputSummary = '';
  let errorMessage: string | undefined;

  // capture by hooking emit + step recorders
  const events: any[] = [];
  try {
    const hits = await runAgentToolCalls({
      prisma,
      actor: ownerActor,
      calls: [call],
      sessionId: `e2e-${caseId}`,
      requestSource: 'dev',
      emitStep: (msg) => events.push({ type: 'step', msg }),
      emit: (evt: any) => events.push({ type: 'work', evt }),
    });

    // Check tool run status from DB (most reliable)
    const lastRun = await (prisma as any).agentToolRun.findFirst({
      where: { sessionId: `e2e-${caseId}` },
      orderBy: { startedAt: 'desc' },
    });
    if (!lastRun) {
      status = 'error';
      errorMessage = 'No tool run recorded';
    } else if (lastRun.status === 'success') {
      status = 'success';
      const out = lastRun.output ? JSON.stringify(lastRun.output).slice(0, 200) : '';
      outputSummary = out;
    } else if (lastRun.status === 'approval_required') {
      status = 'approval_required';
      outputSummary = `approvalId=${lastRun.approvalId || 'n/a'}`;
    } else {
      status = 'rejected';
      errorMessage = lastRun.error;
    }
  } catch (e: any) {
    status = 'error';
    errorMessage = String(e?.message || e);
  }

  return {
    caseId,
    toolId: call.toolId,
    status,
    outputSummary,
    errorMessage,
    durationMs: Date.now() - start,
  };
}

async function main() {
  const prisma = new PrismaClient();
  const results: CaseResult[] = [];

  // Ensure a real UserAccount exists so approval flow can persist
  const E2E_USER_ID = 'e2e-tester-owner';
  await prisma.userAccount.upsert({
    where: { id: E2E_USER_ID },
    update: {},
    create: {
      id: E2E_USER_ID,
      displayName: 'E2E Tester (Owner)',
      email: 'e2e@bambook.local',
      status: 'active',
    },
  });

  // Get a real customer + dev case + order id from the DB to test with
  const sampleOrg = await prisma.relation.findFirst({
    where: { deletedAt: null, isOrganization: true },
    select: { id: true, name: true },
  });
  const sampleOrder = await prisma.order.findFirst({
    where: { deletedAt: null },
    select: { id: true, poNumber: true, status: true },
  });
  const sampleDevCase = await prisma.developmentCase.findFirst({
    where: { deletedAt: null, linkedOrderId: null },
    select: { id: true, code: true, stage: true },
  });

  if (!sampleOrg || !sampleOrder || !sampleDevCase) {
    console.error('Missing sample data: org=' + !!sampleOrg + ' order=' + !!sampleOrder + ' devCase=' + !!sampleDevCase);
    await prisma.$disconnect();
    return;
  }

  console.log('Test fixtures:');
  console.log('  org:      ' + sampleOrg.id + ' (' + sampleOrg.name + ')');
  console.log('  order:    ' + sampleOrder.id + ' (' + sampleOrder.poNumber + ', status=' + sampleOrder.status + ')');
  console.log('  devCase:  ' + sampleDevCase.id + ' (' + sampleDevCase.code + ', stage=' + sampleDevCase.stage + ')');
  console.log('');

  // ── READ-ONLY ───────────────────────────────────────────────
  results.push(await runOne(prisma, 'r1-products-query', {
    toolId: 'products.query',
    input: { limit: 3 },
    reason: 'list first 3 products',
  }));

  results.push(await runOne(prisma, 'r2-relations-expand', {
    toolId: 'relations.expand',
    input: { id: sampleOrg.id, include: ['profile', 'people'] },
    reason: 'expand sample organization',
  }));

  results.push(await runOne(prisma, 'r3-orders-expand', {
    toolId: 'orders.expand',
    input: { id: sampleOrder.id, include: ['lines', 'customer'] },
    reason: 'expand sample order',
  }));

  results.push(await runOne(prisma, 'r4-development-query', {
    toolId: 'development.query',
    input: { limit: 5 },
    reason: 'list first 5 development cases',
  }));

  // ── RELATIONSHIP GRAPH ─────────────────────────────────────
  // Use canonical {type,id} per manifest contract
  results.push(await runOne(prisma, 'g1-links-query', {
    toolId: 'links.query',
    input: { type: 'relation.organization', id: sampleOrg.id, limit: 20 },
    reason: 'find what this org is connected to',
  }));

  results.push(await runOne(prisma, 'g2-links-expand-neighbors', {
    toolId: 'links.expand_neighbors',
    input: { type: 'relation.organization', id: sampleOrg.id, limit: 10 },
    reason: 'expand 1-hop neighbors with snapshots',
  }));

  // ── PRODUCTION ─────────────────────────────────────────────
  results.push(await runOne(prisma, 'p1-orders-list-by-status', {
    toolId: 'orders.list_by_status',
    input: { status: 'Production', limit: 10 },
    reason: 'list production orders',
  }));

  results.push(await runOne(prisma, 'p2-orders-kanban', {
    toolId: 'orders.kanban',
    input: {},
    reason: 'order kanban summary',
  }));

  // ── MUTATIONS (must trigger approval, not execute) ─────────
  results.push(await runOne(prisma, 'm1-orders-update-status', {
    toolId: 'orders.update_status',
    input: { id: sampleOrder.id, toStatus: 'Production', reason: 'e2e test' },
    reason: 'attempt status transition - should hit approval',
  }));

  results.push(await runOne(prisma, 'm2-development-convert-to-order', {
    toolId: 'development.convert_to_order',
    input: { id: sampleDevCase.id, autoCreate: true },
    reason: 'attempt convert dev case - should hit approval',
  }));

  // ── FINANCE B1 SMOKE (stub returns 200, no real DB write) ──
  results.push(await runOne(prisma, 'f1-finance-list-invoices', {
    toolId: 'finance.list_invoices',
    input: { filters: { type: 'Receivable' }, limit: 10 },
    reason: 'list receivable invoices (stub)',
  }));
  results.push(await runOne(prisma, 'f2-finance-get-invoice', {
    toolId: 'finance.get_invoice',
    input: { invoiceNumber: 'INV-20260615-001' },
    reason: 'get invoice by number (stub)',
  }));
  results.push(await runOne(prisma, 'f3-finance-list-vouchers', {
    toolId: 'finance.list_vouchers',
    input: { filters: { type: 'Receipt' }, limit: 10 },
    reason: 'list receipt vouchers (stub)',
  }));
  results.push(await runOne(prisma, 'f4-finance-get-voucher', {
    toolId: 'finance.get_voucher',
    input: { voucherNumber: 'PAY-20260615-001' },
    reason: 'get voucher by number (stub)',
  }));
  results.push(await runOne(prisma, 'f5-finance-query-outstanding', {
    toolId: 'finance.query_outstanding',
    input: { scope: { customerRelationId: sampleOrg.id }, type: 'Receivable' },
    reason: 'query outstanding AR by customer (stub)',
  }));
  // mutations — 应该 hit approval
  results.push(await runOne(prisma, 'f6-finance-create-invoice', {
    toolId: 'finance.create_invoice',
    input: {
      type: 'Receivable',
      invoiceNumber: 'INV-20260615-E2E',
      amount: 50000,
      currency: 'USD',
      issueDate: '2026-06-15',
      dueDate: '2026-09-13',
      orderId: sampleOrder.id,
      customerRelationId: sampleOrg.id,
    },
    reason: 'create invoice - should hit approval',
  }));
  results.push(await runOne(prisma, 'f7-finance-create-voucher', {
    toolId: 'finance.create_voucher',
    input: {
      type: 'Receipt',
      voucherNumber: 'PAY-20260615-E2E',
      amount: 30000,
      currency: 'USD',
      paymentDate: '2026-06-15',
      paymentMethod: 'TT',
      customerRelationId: sampleOrg.id,
    },
    reason: 'create voucher - should hit approval',
  }));
  results.push(await runOne(prisma, 'f8-finance-apply-voucher', {
    toolId: 'finance.apply_voucher_to_invoice',
    input: {
      voucherId: 'PAY__stub_test',
      invoiceId: 'INV__stub_test',
      appliedAmount: 30000,
    },
    reason: 'apply voucher to invoice - should hit approval',
  }));

  // ── Shipping (货运管理) ──
  results.push(await runOne(prisma, 's1-shipping-list', {
    toolId: 'shipping.list_shipments',
    input: { filters: { type: 'Export' }, limit: 10 },
    reason: 'list export shipments',
  }));
  results.push(await runOne(prisma, 's2-shipping-get', {
    toolId: 'shipping.get_shipment',
    input: { id: 'SHP__nonexistent' },
    reason: 'get nonexistent shipment - should return ok:false',
  }));
  results.push(await runOne(prisma, 's3-shipping-create', {
    toolId: 'shipping.create_shipment',
    input: { type: 'Export', shipmentNumber: 'SHP-E2E-001', carrier: 'COSCO', orderId: sampleOrder.id, customerRelationId: sampleOrg.id },
    reason: 'create shipment - should hit approval',
  }));
  results.push(await runOne(prisma, 's4-shipping-update-tracking', {
    toolId: 'shipping.update_tracking_status',
    input: { shipmentId: 'SHP__stub_test', status: 'Shipped' },
    reason: 'update tracking status - should hit approval',
  }));

  // ── EMAIL MODULE TESTS (Phase 4a) ──────────────────────────
  results.push(await runOne(prisma, 'em1-email-list', {
    toolId: 'email.list',
    input: { filters: {}, limit: 10 },
    reason: 'list emails - read-only',
  }));
  results.push(await runOne(prisma, 'em2-email-search', {
    toolId: 'email.search',
    input: { query: 'test', limit: 10 },
    reason: 'search emails by keyword - read-only',
  }));
  results.push(await runOne(prisma, 'em3-email-get', {
    toolId: 'email.get',
    input: { id: 'EML__stub_test' },
    reason: 'get email by id - read-only',
  }));
  results.push(await runOne(prisma, 'em4-email-link', {
    toolId: 'email.link_to_order',
    input: { emailId: 'EML__stub_test', orderRelationId: sampleOrg.id },
    reason: 'link email to order - should hit approval',
  }));
  results.push(await runOne(prisma, 'em5-email-ai-extract', {
    toolId: 'email.ai_extract',
    input: { emailId: 'EML__stub_test' },
    reason: 'AI extract email fields - should hit approval (high risk)',
  }));

  // ── REPORT ─────────────────────────────────────────────────
  console.log('\n========= E2E AGENT TEST RESULTS =========\n');
  console.log('| Case | Tool | Status | Duration | Detail |');
  console.log('|------|------|--------|----------|--------|');
  for (const r of results) {
    const detail = r.status === 'success'
      ? (r.outputSummary || '').slice(0, 60).replace(/\|/g, '/')
      : (r.errorMessage || r.outputSummary || '').slice(0, 60).replace(/\|/g, '/');
    console.log(`| ${r.caseId} | ${r.toolId} | ${r.status} | ${r.durationMs}ms | ${detail} |`);
  }

  const successes = results.filter(r => r.status === 'success').length;
  const approvals = results.filter(r => r.status === 'approval_required').length;
  const rejected = results.filter(r => r.status === 'rejected').length;
  const errors = results.filter(r => r.status === 'error').length;

  console.log('\nSummary:');
  console.log('  ✓ success:           ' + successes);
  console.log('  ⏸ approval_required: ' + approvals + '   (mutations - expected)');
  console.log('  ✗ rejected:          ' + rejected);
  console.log('  ⚠ error:             ' + errors);

  // Verify mutation cases really created ApprovalRequest rows.
  // ApprovalRequest schema doesn't have sessionId — we filter by actionType prefix.
  const approvals2 = await prisma.approvalRequest.findMany({
    where: {
      actionType: { startsWith: 'tool:' },
      requesterId: E2E_USER_ID,
    },
    select: { id: true, actionType: true, status: true, risk: true, payload: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  console.log('\nApprovalRequest rows for mutation cases:');
  for (const a of approvals2) {
    const pl = a.payload as any;
    console.log('  ' + a.id + ' tool=' + (pl?.toolId || a.actionType) + ' status=' + a.status + ' risk=' + a.risk);
  }

  // Cleanup test data
  await (prisma as any).agentToolRun.deleteMany({ where: { sessionId: { startsWith: 'e2e-' } } });
  await prisma.approvalRequest.deleteMany({ where: { requesterId: E2E_USER_ID } });
  // AuditLog.actorId 也指向 UserAccount（FK），清理时必须先于 userAccount 删除
  await (prisma as any).auditLog.deleteMany({ where: { actorId: E2E_USER_ID } });
  await prisma.userAccount.deleteMany({ where: { id: E2E_USER_ID } });
  console.log('\n(test rows cleaned up)');

  await prisma.$disconnect();

  if (errors > 0) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
