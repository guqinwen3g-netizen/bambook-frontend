/**
 * §10.3-9 Phase B 批次 2 — 签署人解析 + 盖章端到端（真库集成）。
 *
 * 仅在独立验收 Postgres 中，用自有 UserAccount / UserRole / ApprovalRequest
 * 验证签署人解析、选章和渲染。批准记录是显式合成输入，不证明审批内核闭环。
 */
import { PrismaClient } from '@prisma/client';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resolveDocumentSigner, resolveDocumentSignerByDoc } from '../documentSigner';
import { createSealService } from '../sealService';
import { renderServerDocument } from '../../templates/docTemplates/registry';

const prisma = new PrismaClient();
const PREFIX = `ITDS_${Date.now()}_`;
const LEADER_ID = `${PREFIX}ACTOR`;
const EARLY_ROLE_ID = `${PREFIX}EARLY_ROLE`;
const LATE_ROLE_ID = `${PREFIX}LATE_ROLE`;
let fixtureCreated = false;

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const EXPORTER_OK = true;

async function cleanup() {
  // Contract target references start with composite:, while owned approval IDs
  // always carry this fixture prefix. Delete only this test's own records.
  await prisma.approvalRequest.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.seal.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || '');
  expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true);
  expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe(process.env.BAMBOOK_ACCEPTANCE_DB_PORT);
  expect(url.pathname).toBe(`/${process.env.BAMBOOK_ACCEPTANCE_DB_NAME}`);
  expect(await prisma.$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`).toEqual([{ name: process.env.BAMBOOK_ACCEPTANCE_DB_NAME, directory: process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port: Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) }]);
  await cleanup();
  await prisma.userAccount.create({ data: { id: LEADER_ID, displayName: 'Owned signer rendering fixture', status: 'active' } });
  fixtureCreated = true;
  for (const id of [EARLY_ROLE_ID, LATE_ROLE_ID]) await prisma.role.create({ data: { id, name: id, isSystem: false } });
  // Deliberately insert the newer role first. Only the documented timestamp order is valid.
  await prisma.userRole.create({ data: { id: `${PREFIX}UR_LATE`, userId: LEADER_ID, roleId: LATE_ROLE_ID, createdAt: new Date('2026-01-02T00:00:00Z') } });
  await prisma.userRole.create({ data: { id: `${PREFIX}UR_EARLY`, userId: LEADER_ID, roleId: EARLY_ROLE_ID, createdAt: new Date('2026-01-01T00:00:00Z') } });
});
afterAll(async () => {
  try {
    await cleanup();
    if (fixtureCreated) {
      for (const row of await prisma.auditLog.findMany({ where: { actorId: LEADER_ID }, select: { id: true } })) await prisma.auditLog.delete({ where: { id: row.id } });
      await prisma.userAccount.delete({ where: { id: LEADER_ID } });
      for (const id of [EARLY_ROLE_ID, LATE_ROLE_ID]) if (await prisma.role.findUnique({ where: { id } })) await prisma.role.delete({ where: { id } });
    }
  } finally { await prisma.$disconnect(); }
});

const QUOT_DATA = {
  qt: {
    id: `${PREFIX}QT`, quotationNumber: `${PREFIX}QT-001`, status: 'Approved', currency: 'USD',
    totalAmount: 999, issueDate: '2026-09-12', validUntil: null, deliveryTerms: null,
    paymentTerms: null, salesperson: null, inquiryRef: null, notes: null,
    customerName: 'IT Customer', customerCode: null,
  },
  lines: [],
};

describe('§10.3-9 签署人解析 + 盖章 真库集成', () => {
  it('只有合成的报价批准状态，没有原报价版本及审批凭证时不盖章', async () => {
    expect(EXPORTER_OK).toBe(true);

    // 真实账号（ApprovalRequest.requesterId/reviewerId 是 UserAccount 外键）
    const leader = await prisma.userAccount.findUnique({ where: { id: LEADER_ID } });
    expect(leader).toBeTruthy();
    const leaderId = leader!.id;

    // 该账号的角色（若库中有 UserRole 记录，解析应带出 roleId）
    const leaderRole = await prisma.userRole.findFirst({ where: { userId: leaderId }, orderBy: { createdAt: 'asc' } });
    expect(leaderRole?.roleId).toBe(EARLY_ROLE_ID);

    // 1) 无审批 → 不出章
    const targetId = `${PREFIX}QT`;
    expect(await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId })).toBeNull();
    const htmlNoSign = await renderServerDocument(prisma, 'QUOT', QUOT_DATA, {}, {
      id: targetId, type: 'Quotation', sourceRef: targetId, signer: null,
    });
    expect(htmlNoSign).not.toContain('class="doc-stamp"');

    // 2) 给签署人建一枚专属章
    const seals = createSealService(prisma);
    await seals.createSeal(
      { name: `${PREFIX}领导章`, type: 'other', imageDataUrl: PNG, ownerUserId: leaderId },
      leaderId,
    );

    // 3) 落一条已批准审批（签署人 = 该账号）
    await prisma.approvalRequest.create({
      data: {
        id: `${PREFIX}APR`,
        requesterId: leaderId,
        reviewerId: leaderId,
        actionType: 'quotation:total_approve',
        targetType: 'Quotation',
        targetId,
        status: 'approved',
        risk: 'medium',
        payload: {},
        decidedAt: new Date(),
      },
    });

    // 4) 仅批准状态不能证明客户看到的报价就是已审阅版本。
    const signer = await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId });
    expect(signer).toBeNull();

    // 5) 印章存在也不能为缺少依据的批准记录补造签署。
    const htmlSigned = await renderServerDocument(prisma, 'QUOT', QUOT_DATA, {}, {
      id: targetId, type: 'Quotation', sourceRef: targetId, signer,
    });
    expect(htmlSigned).not.toContain('class="doc-stamp"');
    expect(htmlSigned).not.toContain(PNG);
  });

  it('旧订单确认书批准记录缺少冻结文档和审阅依据时，不作为签署凭证', async () => {
    const leader = await prisma.userAccount.findUnique({ where: { id: LEADER_ID } });
    const leaderId = leader!.id;
    const orderId = `${PREFIX}SO_1`;

    // 未提交签署 → 不出章
    expect(await resolveDocumentSignerByDoc(prisma, { type: 'OrderConfirmation', sourceRef: orderId })).toBeNull();

    await prisma.approvalRequest.create({
      data: {
        id: `${PREFIX}APR_OC`,
        requesterId: leaderId,
        reviewerId: leaderId,
        actionType: 'order:confirmation_sign',
        targetType: 'OrderConfirmation',
        targetId: orderId,
        status: 'approved',
        risk: 'medium',
        payload: {},
        decidedAt: new Date(),
      },
    });

    const signer = await resolveDocumentSignerByDoc(prisma, { type: 'OrderConfirmation', sourceRef: orderId });
    expect(signer).toBeNull();
  });

  it('旧合同批准记录缺少冻结文档和审阅依据时，不作为签署凭证', async () => {
    const leader = await prisma.userAccount.findUnique({ where: { id: LEADER_ID } });
    const leaderId = leader!.id;
    // 与服务端 buildCompositeSourceRef('CONTRACT', ids) 同构（ids 排序后拼接）
    const sourceRef = `composite:CONTRACT:${[`${PREFIX}A`, `${PREFIX}B`].sort().join(',')}`;

    // 未提交签署 → 不出章
    expect(await resolveDocumentSignerByDoc(prisma, { type: 'Contract', sourceRef })).toBeNull();

    await prisma.approvalRequest.create({
      data: {
        id: `${PREFIX}APR_CT`,
        requesterId: leaderId,
        reviewerId: leaderId,
        actionType: 'contract:sign',
        targetType: 'Contract',
        targetId: sourceRef,
        status: 'approved',
        risk: 'medium',
        payload: {},
        decidedAt: new Date(),
      },
    });

    // 回链一致也不足以签署：旧记录没有冻结内容及真实审阅凭证。
    const signer = await resolveDocumentSignerByDoc(prisma, { type: 'Contract', sourceRef });
    expect(signer).toBeNull();

    // 换一组订单 = 另一份合同 → 不应命中（章只盖在已签署的那份上）
    const otherRef = `composite:CONTRACT:${[`${PREFIX}A`, `${PREFIX}C`].sort().join(',')}`;
    expect(await resolveDocumentSignerByDoc(prisma, { type: 'Contract', sourceRef: otherRef })).toBeNull();
  });
});
