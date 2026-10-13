import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createInternalTransferService,
  decodeInternalTransferPayload,
  INTERNAL_TRANSFER_ERRORS,
} from '../internalTransferService';
import { logger } from '../../lib/logger';
import { __clearTeamShareCacheForTests, createTeamShareService } from '../../teams/teamShareService';

/**
 * DR-033 内部供料单服务测试：
 *   create 必填/越界校验 + 双订单校验 + 方向唯一 + 结算价审批链
 *   confirm 生效门槛（未批准结算价不生效）+ 生效后双方 OrderLine.internalTransferPrice 回写
 *   registerDelivery 分批出运/到货回写/差异追溯/超发拒绝/运单归属守卫
 *   cancel 状态守卫 + 状态机非法迁移 fail-closed
 *   list/get 查询（按部门/状态/面料订单）
 */

import { makePrisma, makeService, seedPendingTransfer, seedEffectiveTransfer, decideApproval,
  GARMENT_ORDER, FABRIC_ORDER, baseOrders, baseLines, VALID_INPUT, TRUSTED_ACTOR } from './nativeInternalTransferFixture';

describe('createInternalTransfer 发起', () => {
  it('writes use locked ReadCommitted while detail reads retain Serializable', async () => {
    const ctx = await seedPendingTransfer();
    expect(ctx.prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted', timeout: 20000 });
    expect(await ctx.service.getInternalTransferById(ctx.created.transfer.id, TRUSTED_ACTOR)).not.toBeNull();
    expect(ctx.prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: 'Serializable', timeout: 20000 });
  });

  it('both Order locks precede the final fresh grant check; withdrawal is zero-write', async () => {
    const ctx = makePrisma(), { service } = makeService(ctx.prisma);
    let locks = 0;
    ctx.prisma.$queryRaw.mockImplementation(async () => {
      if (++locks === 2) ctx.users[0].roles[0].role.permissions = [];
      return [];
    });
    const result = await service.createInternalTransfer({ ...VALID_INPUT, trustedActor: TRUSTED_ACTOR });
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', statusCode: 403 } });
    expect(locks).toBe(2); expect(ctx.transfers).toEqual([]); expect(ctx.approvals).toEqual([]); expect(ctx.auditLogs).toEqual([]);
  });

  it('warmed shared-customer read cache cannot authorize a create after the real share is revoked', async () => {
    __clearTeamShareCacheForTests();
    const ctx = makePrisma({ orders: baseOrders().map(order => ({ ...order, customerRelationId: 'shared-customer', ownerId: 'other' })) });
    ctx.users[0].roles[0].role.id = 'custom-internal-writer';
    let granted = true;
    ctx.prisma.relation = { findMany: vi.fn(async () => []) };
    ctx.prisma.teamMember = { findMany: vi.fn(async () => [{ teamId: 'actual-team' }]) };
    ctx.prisma.teamDataGrant = { findMany: vi.fn(async () => granted ? [{ entityId: 'shared-customer' }] : []) };
    const { service } = makeService(ctx.prisma);
    try {
      expect(await createTeamShareService(ctx.prisma).getActiveGrantedRelationIds('u_sales')).toEqual(['shared-customer']);
      granted = false;
      expect(await createTeamShareService(ctx.prisma).getActiveGrantedRelationIds('u_sales')).toEqual(['shared-customer']);
      const result = await service.createInternalTransfer({ ...VALID_INPUT, trustedActor: TRUSTED_ACTOR });
      expect(result).toMatchObject({ ok: false, error: { code: 'GARMENT_ORDER_NOT_FOUND', statusCode: 404 } });
      expect(ctx.prisma.teamDataGrant.findMany).toHaveBeenCalledTimes(2);
      expect(ctx.transfers).toEqual([]); expect(ctx.approvals).toEqual([]); expect(ctx.auditLogs).toEqual([]);
    } finally { __clearTeamShareCacheForTests(); }
  });

  it('必填缺失 → 400 MISSING_REQUIRED_FIELD（列出缺失字段）', async () => {
    const { prisma } = makePrisma({ orders: baseOrders() });
    const { service } = makeService(prisma);
    const res = await service.createInternalTransfer({ ...VALID_INPUT, supplyDepartmentId: '', materialCode: '', dueDate: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.MISSING_REQUIRED_FIELD);
      expect(res.error.message).toContain('supplyDepartmentId');
      expect(res.error.message).toContain('materialCode');
      expect(res.error.message).toContain('dueDate');
      expect(res.error.statusCode).toBe(400);
    }
  });

  it('数量/结算价非正数、交期格式非法 → 400', async () => {
    const { prisma } = makePrisma({ orders: baseOrders() });
    const { service } = makeService(prisma);
    const badQty = await service.createInternalTransfer({ ...VALID_INPUT, quantity: 0 });
    expect(!badQty.ok && badQty.error.code).toBe(INTERNAL_TRANSFER_ERRORS.INVALID_QUANTITY);
    const badPrice = await service.createInternalTransfer({ ...VALID_INPUT, settlementPrice: -5 });
    expect(!badPrice.ok && badPrice.error.code).toBe(INTERNAL_TRANSFER_ERRORS.INVALID_SETTLEMENT_PRICE);
    const badDate = await service.createInternalTransfer({ ...VALID_INPUT, dueDate: '2026/09/01' });
    expect(!badDate.ok && badDate.error.code).toBe(INTERNAL_TRANSFER_ERRORS.INVALID_DUE_DATE);
  });

  it('服装订单不存在 → 404 GARMENT_ORDER_NOT_FOUND', async () => {
    const { prisma } = makePrisma({ orders: [{ ...FABRIC_ORDER }] });
    const { service } = makeService(prisma);
    const res = await service.createInternalTransfer(VALID_INPUT);
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.GARMENT_ORDER_NOT_FOUND);
    expect(!res.ok && res.error.statusCode).toBe(404);
  });

  it('面料订单未标记 isInternalFabricTrade → 400 FABRIC_ORDER_NOT_INTERNAL_TRADE（fail-closed）', async () => {
    const { prisma } = makePrisma({
      orders: [{ ...GARMENT_ORDER }, { ...FABRIC_ORDER, isInternalFabricTrade: false }],
    });
    const { service } = makeService(prisma);
    const res = await service.createInternalTransfer(VALID_INPUT);
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.FABRIC_ORDER_NOT_INTERNAL_TRADE);
  });

  it('服装订单自身为内部交易订单 → 400 GARMENT_ORDER_INTERNAL_CONFLICT', async () => {
    const { prisma } = makePrisma({
      orders: [{ ...GARMENT_ORDER, isInternalFabricTrade: true }, { ...FABRIC_ORDER }],
    });
    const { service } = makeService(prisma);
    const res = await service.createInternalTransfer(VALID_INPUT);
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.GARMENT_ORDER_INTERNAL_CONFLICT);
  });

  it('成功发起 → master(incoming/服装订单) + mirror(outgoing/面料订单) 双向关联 + 结算价审批单', async () => {
    const { prisma, calls, transfers } = makePrisma({ orders: baseOrders(), orderLines: baseLines() });
    const { service, createBusinessApproval } = makeService(prisma);
    const res = await service.createInternalTransfer(VALID_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 双向记录
    expect(transfers).toHaveLength(2);
    const master = transfers.find((t) => t.transferDirection === 'incoming')!;
    const mirror = transfers.find((t) => t.transferDirection === 'outgoing')!;
    expect(master.orderId).toBe('G1');
    expect(master.ourDepartmentId).toBe('dept_garment');
    expect(master.counterpartyId).toBe('dept_fabric');
    expect(mirror.orderId).toBe('F1');
    expect(mirror.ourDepartmentId).toBe('dept_fabric');
    // 金额 = 结算价 × 数量
    expect(Number(master.transferAmount)).toBe(30000);
    expect(Number(mirror.transferAmount)).toBe(30000);

    // 载荷状态机：PendingConfirm（Draft → PendingConfirm 已留痕）
    const payload = decodeInternalTransferPayload(master.memo)!;
    expect(payload.status).toBe('PendingConfirm');
    expect(payload.history[0]).toMatchObject({ from: 'Draft', to: 'PendingConfirm' });
    expect(payload.mirrorId).toBe(mirror.id);

    // 审批链：actionType + targetType + payload（DR-006 内部结算价审批）
    expect(createBusinessApproval).toHaveBeenCalledTimes(1);
    const approvalInput = createBusinessApproval.mock.calls[0][0];
    expect(approvalInput.actionType).toBe('order:internal_trade_price');
    expect(approvalInput.targetType).toBe('OrderInternalTransfer');
    expect(approvalInput.payload.content.settlementPrice).toBe(30);
    expect(res.data.approvalRequestId).toBe('ar_1');
    expect(payload.settlementApprovalId).toBe('ar_1');
    expect(calls.transferCreate).toHaveLength(2);
  });

  it('方向唯一：同一服装订单重复发起 incoming → 409 TRANSFER_ALREADY_EXISTS', async () => {
    const ctx = await seedPendingTransfer();
    const res = await ctx.service.createInternalTransfer(VALID_INPUT);
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.TRANSFER_ALREADY_EXISTS);
    expect(!res.ok && res.error.statusCode).toBe(409);
  });

  it('审批路由解析失败（NO_REVIEWER_RESOLVED）→ 409 透传，不落库', async () => {
    const { prisma, transfers } = makePrisma({ orders: baseOrders() });
    const noReviewer = Object.assign(new Error('无法解析审批人'), { code: 'NO_REVIEWER_RESOLVED' });
    const { service } = makeService(prisma, vi.fn(async () => { throw noReviewer; }));
    const res = await service.createInternalTransfer(VALID_INPUT);
    expect(!res.ok && res.error.code).toBe('NO_REVIEWER_RESOLVED');
    expect(!res.ok && res.error.statusCode).toBe(409);
    expect(transfers).toHaveLength(0);
  });
});

describe('confirmInternalTransfer 生效门槛', () => {
  it('结算价审批 pending → 409 SETTLEMENT_PRICE_NOT_APPROVED（未批准不生效，fail-closed）', async () => {
    const ctx = await seedPendingTransfer({ approvals: [{ id: 'ar_1', status: 'pending' }] });
    const res = await ctx.service.confirmInternalTransfer({ id: ctx.created.transfer.id, actorId: 'u_fabric' });
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.SETTLEMENT_PRICE_NOT_APPROVED);
    expect(!res.ok && res.error.statusCode).toBe(409);
    // 状态未变
    const payload = decodeInternalTransferPayload(ctx.transfers[0].memo)!;
    expect(payload.status).toBe('PendingConfirm');
  });

  it('结算价审批 rejected → 409 SETTLEMENT_PRICE_NOT_APPROVED', async () => {
    const ctx = await seedPendingTransfer({ approvals: [{ id: 'ar_1', status: 'rejected' }] });
    const res = await ctx.service.confirmInternalTransfer({ id: ctx.created.transfer.id, actorId: 'u_fabric' });
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.SETTLEMENT_PRICE_NOT_APPROVED);
  });

  it('非 PendingConfirm 状态确认 → 409 INVALID_TRANSFER_STATE', async () => {
    const ctx = await seedEffectiveTransfer();
    const res = await ctx.service.confirmInternalTransfer({ id: ctx.created.transfer.id, actorId: 'u_fabric' });
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.INVALID_TRANSFER_STATE);
  });

  it('供料单不存在 → 404 TRANSFER_NOT_FOUND', async () => {
    const { prisma } = makePrisma({ orders: baseOrders() });
    const { service } = makeService(prisma);
    const res = await service.confirmInternalTransfer({ id: 'OIT__MISSING', actorId: 'u' });
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.TRANSFER_NOT_FOUND);
    expect(!res.ok && res.error.statusCode).toBe(404);
  });

  it('审批通过 + 面料部确认 → Effective：认账落库 + 双方 OrderLine.internalTransferPrice 回写（双向关联独立核算）+ mirror 同步', async () => {
    const ctx = await seedEffectiveTransfer();
    const master = ctx.transfers.find((t) => t.transferDirection === 'incoming')!;
    const mirror = ctx.transfers.find((t) => t.transferDirection === 'outgoing')!;
    const payload = decodeInternalTransferPayload(master.memo)!;

    expect(payload.status).toBe('Effective');
    expect(payload.confirmedQuantity).toBe(1000);
    expect(payload.confirmedDueDate).toBe('2026-09-01');
    expect(payload.confirmedBy).toBe('u_fabric');
    expect(master.recognizedBy).toBe('u_fabric');
    expect(master.recognizedAt).toBeTruthy();
    // mirror 同步
    expect(decodeInternalTransferPayload(mirror.memo)!.status).toBe('Effective');

    // 双方订单行回写内部结算价：服装订单=面料成本依据，面料订单=内部收入依据
    const gl = ctx.orderLines.find((l) => l.id === 'GL1')!;
    const fl = ctx.orderLines.find((l) => l.id === 'FL1')!;
    expect(Number(gl.internalTransferPrice)).toBe(30);
    expect(Number(fl.internalTransferPrice)).toBe(30);
    expect(ctx.calls.orderLineUpdate).toHaveLength(2);
  });

  it('已批准版本直接改数量/交期拒绝；真实重送审再批准后金额按800重算', async () => {
    const ctx = await seedPendingTransfer({ approvals: [{ id: 'ar_1', status: 'approved' }] });
    const before = structuredClone({ transfers: ctx.transfers, approvals: ctx.approvals, lines: ctx.orderLines, audits: ctx.auditLogs });
    const changed = await ctx.service.confirmInternalTransfer({ id: ctx.created.transfer.id, actorId: 'u_fabric', confirmedQuantity: 800, confirmedDueDate: '2026-09-15' });
    expect(changed.ok).toBe(false); expect(!changed.ok && changed.error.code).toBe('SOURCE_CHANGED');
    expect({ transfers: ctx.transfers, approvals: ctx.approvals, lines: ctx.orderLines, audits: ctx.auditLogs }).toEqual(before);
    const revised = await ctx.service.reviseInternalTransferPrice({ id: ctx.created.transfer.id, actorId: 'u_fabric', requestId: 'change-800', expectedContentFingerprint: ctx.created.payload.contentFingerprint!, quantity: 800, settlementPrice: 30, dueDate: '2026-09-15', reason: '面料部提出新交付范围与交期，原批准保持历史' });
    expect(revised.ok).toBe(true); if (!revised.ok) return;
    expect(ctx.approvals[0]).toEqual(before.approvals[0]);
    await decideApproval(ctx.prisma, revised.data.approvalRequestId);
    const res = await ctx.service.confirmInternalTransfer({ id: ctx.created.transfer.id, actorId: 'u_fabric', confirmedQuantity: 800, confirmedDueDate: '2026-09-15' });
    expect(res.ok).toBe(true);
    const master = ctx.transfers.find(t => t.transferDirection === 'incoming')!;
    expect(Number(master.transferAmount)).toBe(24000);
    expect(decodeInternalTransferPayload(master.memo)).toMatchObject({ confirmedQuantity: 800, confirmedDueDate: '2026-09-15', priceRevision: 2 });
  });
});

describe('价格修订的原生命令与批准事实', () => {
  it('pending旧审批追加cancelled，新native审批产生；原请求重放匹配原审计，改参拒绝零写', async () => {
    const ctx = await seedPendingTransfer(), command = { id: ctx.created.transfer.id, actorId: 'u_sales', requestId: 'pending-revision', expectedContentFingerprint: ctx.created.payload.contentFingerprint!, quantity: 800, settlementPrice: 25, dueDate: '2026-09-15', reason: '客户调整未认账的需求，重新提交准确价格范围' };
    const revised = await ctx.service.reviseInternalTransferPrice(command);
    expect(revised.ok).toBe(true); if (!revised.ok) return;
    expect(revised.data).toMatchObject({ revision: 2, approvalRequestId: 'ar_2', previousApprovalId: 'ar_1', replayed: false });
    expect(ctx.approvals[0].status).toBe('cancelled'); expect(ctx.approvals[1]).toMatchObject({ status: 'pending', targetId: command.id });
    expect(ctx.auditLogs.filter(row => row.action === 'internal_transfer_price_supersede')).toHaveLength(1);
    const state = structuredClone({ pair: ctx.transfers, approvals: ctx.approvals, audits: ctx.auditLogs });
    const replay = await ctx.service.reviseInternalTransferPrice(command);
    expect(replay.ok).toBe(true); if (replay.ok) expect(replay.data).toEqual({ ...revised.data, replayed: true });
    const changed = await ctx.service.reviseInternalTransferPrice({ ...command, settlementPrice: 26 });
    expect(!changed.ok && changed.error.code).toBe('REQUEST_CONFLICT');
    expect({ pair: ctx.transfers, approvals: ctx.approvals, audits: ctx.auditLogs }).toEqual(state);
  });

  it('rejected原决议保持；新批准确认后允许原改价命令精确回执重放，新的Effective改价拒绝', async () => {
    const ctx = await seedPendingTransfer({ approvals: [{ status: 'rejected' }] }), original = structuredClone(ctx.approvals[0]);
    const command = { id: ctx.created.transfer.id, actorId: 'u_sales', requestId: 'rejected-revision', expectedContentFingerprint: ctx.created.payload.contentFingerprint!, quantity: 500, settlementPrice: 30, dueDate: '2026-09-01', reason: '按主管驳回意见重新提交，历史驳回不覆盖' };
    const revised = await ctx.service.reviseInternalTransferPrice(command); expect(revised.ok).toBe(true); if (!revised.ok) return;
    expect(ctx.approvals[0]).toEqual(original); await decideApproval(ctx.prisma, revised.data.approvalRequestId);
    expect((await ctx.service.confirmInternalTransfer({ id: command.id, actorId: 'u_fabric' })).ok).toBe(true);
    const state = structuredClone({ pair: ctx.transfers, approvals: ctx.approvals, lines: ctx.orderLines, audits: ctx.auditLogs });
    const replay = await ctx.service.reviseInternalTransferPrice(command); expect(replay.ok).toBe(true); if (replay.ok) expect(replay.data.auditId).toBe(revised.data.auditId);
    const newCommand = await ctx.service.reviseInternalTransferPrice({ ...command, requestId: 'too-late', expectedContentFingerprint: revised.data.contentFingerprint });
    expect(!newCommand.ok && newCommand.error.code).toBe('INVALID_STATE');
    expect({ pair: ctx.transfers, approvals: ctx.approvals, lines: ctx.orderLines, audits: ctx.auditLogs }).toEqual(state);
  });

  it('陈旧指纹与credential ceiling拒绝零写', async () => {
    const ctx = await seedPendingTransfer(), state = structuredClone({ pair: ctx.transfers, approvals: ctx.approvals, audits: ctx.auditLogs });
    const command = { id: ctx.created.transfer.id, actorId: 'u_sales', requestId: 'stale-revision', expectedContentFingerprint: '0'.repeat(64), quantity: 800, settlementPrice: 30, dueDate: '2026-09-01', reason: 'version probe' };
    const stale = await ctx.service.reviseInternalTransferPrice(command); expect(!stale.ok && stale.error.code).toBe('SOURCE_CHANGED');
    const limited = await ctx.service.reviseInternalTransferPrice({ ...command, expectedContentFingerprint: ctx.created.payload.contentFingerprint!, trustedActor: { ...TRUSTED_ACTOR, permissionCeiling: ['orders:read'] } });
    expect(!limited.ok && limited.error.code).toBe('FORBIDDEN');
    expect({ pair: ctx.transfers, approvals: ctx.approvals, audits: ctx.auditLogs }).toEqual(state);
  });

  it('实际普通owner兜底决议不能当主管批准；显式boss模式的真实3字段+审计可消费', async () => {
    const ordinary = await seedPendingTransfer();
    await decideApproval(ordinary.prisma, ordinary.created.approvalRequestId, 'approved', 'normal', 'u_owner');
    const refused = await ordinary.service.confirmInternalTransfer({ id: ordinary.created.transfer.id, actorId: 'u_fabric' });
    expect(!refused.ok && refused.error.code).toBe('INVALID_COST_SOURCE');
    const boss = await seedPendingTransfer(); await decideApproval(boss.prisma, boss.created.approvalRequestId, 'approved', 'boss');
    expect(boss.approvals[0]).toMatchObject({ bossFinalBypassBy: 'u_owner', status: 'approved' });
    expect(boss.auditLogs.filter(row => row.action === 'boss_final_bypass')).toHaveLength(1);
    const accepted = await boss.service.confirmInternalTransfer({ id: boss.created.transfer.id, actorId: 'u_fabric' });
    expect(accepted.ok).toBe(true); if (accepted.ok) expect(accepted.data.payload.status).toBe('Effective');
  });
});

describe('registerDelivery 交付登记（面料订单既有出运状态机）', () => {
  const SHIPMENT = { id: 'SH1', shipmentNumber: 'SHP-2026-001', orderId: 'F1', status: 'Shipped', deletedAt: null };

  it('SOA source is reread after its row lock; concurrent parent drift refuses without delivery/audit/line writes', async () => {
    const ctx = await seedEffectiveTransfer(); ctx.shipments.push({ ...SHIPMENT });
    const before = structuredClone({ transfers: ctx.transfers, lines: ctx.orderLines, audits: ctx.auditLogs });
    ctx.prisma.$queryRaw.mockImplementation(async (sql: any) => {
      if (String(sql?.sql ?? '').includes('ShipmentOrderAllocation')) ctx.shipments[0].orderId = 'G1';
      return [];
    });
    const command = { id: ctx.created.transfer.id, actorId: 'u_fabric', shipmentId: 'SH1', allocationId: 'SH1-allocation', quantity: 100, requestId: 'same-physical-delivery' };
    expect(await ctx.service.registerDelivery(command)).toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED', statusCode: 409 } });
    expect({ transfers: ctx.transfers, lines: ctx.orderLines, audits: ctx.auditLogs }).toEqual(before);
    ctx.prisma.$queryRaw.mockImplementation(async () => []); ctx.shipments[0].orderId = 'F1';
    expect(await ctx.service.registerDelivery(command)).toMatchObject({ ok: true });
  });

  it('未生效（PendingConfirm）登记交付 → 409 INVALID_TRANSFER_STATE', async () => {
    const ctx = await seedPendingTransfer({ approvals: [{ id: 'ar_1', status: 'approved' }] });
    const res = await ctx.service.registerDelivery({
      id: ctx.created.transfer.id, actorId: 'u_fabric', shipmentId: 'SH1', quantity: 100,
    });
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.INVALID_TRANSFER_STATE);
  });

  it('运单不存在/已取消 → 404 SHIPMENT_NOT_FOUND', async () => {
    const ctx = await seedEffectiveTransfer();
    const res = await ctx.service.registerDelivery({
      id: ctx.created.transfer.id, actorId: 'u_fabric', shipmentId: 'SH_X', quantity: 100,
    });
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.SHIPMENT_NOT_FOUND);
    const cancelled = await ctx.service.registerDelivery({
      id: ctx.created.transfer.id, actorId: 'u_fabric', shipmentId: 'SH_C', quantity: 100,
    });
    ctx.shipments.push({ id: 'SH_C', shipmentNumber: 'X', orderId: 'F1', status: 'Cancelled', deletedAt: null });
    const res2 = await ctx.service.registerDelivery({
      id: ctx.created.transfer.id, actorId: 'u_fabric', shipmentId: 'SH_C', quantity: 100,
    });
    expect(!cancelled.ok && cancelled.error.code).toBe(INTERNAL_TRANSFER_ERRORS.SHIPMENT_NOT_FOUND);
    expect(!res2.ok && res2.error.code).toBe(INTERNAL_TRANSFER_ERRORS.SHIPMENT_NOT_FOUND);
  });

  it('运单不属于关联面料订单 → 409 SHIPMENT_NOT_OF_FABRIC_ORDER（禁止平行出库）', async () => {
    const ctx = await seedEffectiveTransfer();
    ctx.shipments.push({ ...SHIPMENT, id: 'SH_OTHER', orderId: 'G1' });
    const res = await ctx.service.registerDelivery({
      id: ctx.created.transfer.id, actorId: 'u_fabric', shipmentId: 'SH_OTHER', quantity: 100,
    });
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.SHIPMENT_NOT_OF_FABRIC_ORDER);
    expect(!res.ok && res.error.statusCode).toBe(409);
  });

  it('累计交付超确认数量 → 409 OVER_DELIVERY（禁止超发）', async () => {
    const ctx = await seedEffectiveTransfer();
    ctx.shipments.push({ ...SHIPMENT });
    const res = await ctx.service.registerDelivery({
      id: ctx.created.transfer.id, actorId: 'u_fabric', shipmentId: 'SH1', quantity: 1001,
    });
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.OVER_DELIVERY);
  });

  it('分批出运 + 分批到货 + 差异追溯 + 服装订单行到货回写（PartiallyArrived → Arrived → Closed）', async () => {
    const ctx = await seedEffectiveTransfer();
    ctx.shipments.push({ ...SHIPMENT }, { ...SHIPMENT, id: 'SH2', shipmentNumber: 'SHP-2026-002' });
    const id = ctx.created.transfer.id;

    // 第一批：出运 600，到货 580（差异 -20）
    const d1 = await ctx.service.registerDelivery({
      id, actorId: 'u_fabric', shipmentId: 'SH1', quantity: 600, deliveryDate: '2026-08-20',
      receivedQuantity: 580, receivedDate: '2026-08-22',
      packingLines: [{ cartonNo: '1-20', quantity: 600, grossWeight: 720 }],
    });
    expect(d1.ok).toBe(true);
    if (!d1.ok) return;
    expect(d1.data.status).toBe('Delivering');
    expect(d1.data.cumulativeDelivered).toBe(600);
    expect(d1.data.delivery.variance).toBe(-20); // 差异追溯
    expect(d1.data.delivery.shipmentNumber).toBe('SHP-2026-001');
    expect(d1.data.delivery.packingLines).toHaveLength(1); // 装箱明细数据

    // 服装订单行回写：累计出运量 + 最近交付日期 + 分批到货状态
    const gl = ctx.orderLines.find((l) => l.id === 'GL1')!;
    expect(Number(gl.shipmentQuantity)).toBe(600);
    expect(gl.shippingDate).toBe('2026-08-20');
    expect(gl.status).toBe('PartiallyArrived');

    // 第二批出运400；仍有20未到货，不能仅凭累计出运关闭。
    const d2 = await ctx.service.registerDelivery({
      id, actorId: 'u_fabric', shipmentId: 'SH2', quantity: 400, deliveryDate: '2026-08-25', receivedQuantity: 400,
    });
    expect(d2.ok).toBe(true);
    if (!d2.ok) return;
    expect(d2.data.status).toBe('Delivering');
    expect(d2.data.cumulativeDelivered).toBe(1000);
    expect(d2.data.payload.deliveries).toHaveLength(2);

    // 累计到货 980 ≥ 确认 1000？否（980 < 1000）→ 仍 PartiallyArrived（差异 -20 保留追溯）
    expect(gl.status).toBe('PartiallyArrived');
    expect(Number(gl.shipmentQuantity)).toBe(1000);
    expect(gl.shippingDate).toBe('2026-08-25');

    const mirror = ctx.transfers.find(t => t.transferDirection === 'outgoing')!;
    expect(decodeInternalTransferPayload(mirror.memo)!.status).toBe('Delivering');
    const tail = await ctx.service.registerReceipt({ id, actorId: 'u_fabric', deliveryId: d1.data.delivery.id, quantity: 20, receivedDate: '2026-08-27', requestId: 'independent-tail-20' });
    expect(tail.ok).toBe(true); if (!tail.ok) return;
    expect(tail.data.payload.status).toBe('Closed');
    expect(tail.data.payload.receipts!.map(row => row.quantity)).toEqual([580, 400, 20]);
    expect(tail.data.payload.deliveries[0].variance).toBe(0);
    expect(gl.status).toBe('Arrived');
    expect(decodeInternalTransferPayload(mirror.memo)!.status).toBe('Closed');

    // Closed 后禁止追加交付
    const d3 = await ctx.service.registerDelivery({ id, actorId: 'u_fabric', shipmentId: 'SH2', quantity: 1 });
    expect(!d3.ok && d3.error.code).toBe(INTERNAL_TRANSFER_ERRORS.INVALID_TRANSFER_STATE);
  });

  it('到货累计达确认数量 → 服装订单行状态 Arrived', async () => {
    const ctx = await seedPendingTransfer({ approvals: [{ id: 'ar_1', status: 'approved' }] });
    const revised = await ctx.service.reviseInternalTransferPrice({ id: ctx.created.transfer.id, actorId: 'u_fabric', requestId: 'change-500', expectedContentFingerprint: ctx.created.payload.contentFingerprint!, quantity: 500, settlementPrice: 30, dueDate: '2026-09-01', reason: '面料部重新提交五百米交付范围' });
    expect(revised.ok).toBe(true); if (!revised.ok) return;
    await decideApproval(ctx.prisma, revised.data.approvalRequestId);
    const confirmed = await ctx.service.confirmInternalTransfer({ id: ctx.created.transfer.id, actorId: 'u_fabric', confirmedQuantity: 500 });
    expect(confirmed.ok).toBe(true);
    ctx.shipments.push({ ...SHIPMENT });
    const res = await ctx.service.registerDelivery({
      id: ctx.created.transfer.id, actorId: 'u_fabric', shipmentId: 'SH1', quantity: 500, receivedQuantity: 500,
    });
    expect(res.ok).toBe(true);
    const gl = ctx.orderLines.find((l) => l.id === 'GL1')!;
    expect(gl.status).toBe('Arrived');
  });
});

describe('cancelInternalTransfer 取消', () => {
  it('PendingConfirm 可取消 + 待决审批单同步取消', async () => {
    const ctx = await seedPendingTransfer({ approvals: [{ id: 'ar_1', status: 'pending' }] });
    const res = await ctx.service.cancelInternalTransfer({ id: ctx.created.transfer.id, actorId: 'u_sales', reason: '客户需求取消' });
    expect(res.ok).toBe(true);
    const payload = decodeInternalTransferPayload(ctx.transfers[0].memo)!;
    expect(payload.status).toBe('Cancelled');
    expect(ctx.approvals[0].status).toBe('cancelled');
  });

  it('Effective 后禁止取消 → 409（须走订单变更/例外链）', async () => {
    const ctx = await seedEffectiveTransfer();
    const res = await ctx.service.cancelInternalTransfer({ id: ctx.created.transfer.id, actorId: 'u_sales' });
    expect(!res.ok && res.error.code).toBe(INTERNAL_TRANSFER_ERRORS.INVALID_TRANSFER_STATE);
  });
});

describe('查询：list / get（按部门/状态/订单）', () => {
  it('list 按 status 过滤（内存过滤，schema 冻结权衡）', async () => {
    const ctx = await seedPendingTransfer();
    const pending = await ctx.service.listInternalTransfers({ trustedActor: TRUSTED_ACTOR, status: 'PendingConfirm' });
    expect(pending.total).toBe(1);
    const effective = await ctx.service.listInternalTransfers({ trustedActor: TRUSTED_ACTOR, status: 'Effective' });
    expect(effective.total).toBe(0);
  });

  it('list 按 departmentId / garmentOrderId / fabricOrderId 过滤', async () => {
    const ctx = await seedPendingTransfer();
    const byDept = await ctx.service.listInternalTransfers({ trustedActor: TRUSTED_ACTOR, departmentId: 'dept_garment' });
    expect(byDept.total).toBe(1);
    const byDeptMiss = await ctx.service.listInternalTransfers({ trustedActor: TRUSTED_ACTOR, departmentId: 'dept_other' });
    expect(byDeptMiss.total).toBe(0);
    const byGarment = await ctx.service.listInternalTransfers({ trustedActor: TRUSTED_ACTOR, garmentOrderId: 'G1' });
    expect(byGarment.total).toBe(1);
    const byFabric = await ctx.service.listInternalTransfers({ trustedActor: TRUSTED_ACTOR, fabricOrderId: 'F1' });
    expect(byFabric.total).toBe(1);
    const byFabricMiss = await ctx.service.listInternalTransfers({ trustedActor: TRUSTED_ACTOR, fabricOrderId: 'F_X' });
    expect(byFabricMiss.total).toBe(0);
  });

  it('getById 支持 mirror id 解析到 master', async () => {
    const ctx = await seedPendingTransfer();
    const mirrorId = ctx.created.mirror.id;
    const got = await ctx.service.getInternalTransferById(mirrorId, TRUSTED_ACTOR);
    expect(got).toBeTruthy();
    expect(got!.master.id).toBe(ctx.created.transfer.id);
    expect(got!.mirror?.id).toBe(mirrorId);
    expect(got!.payload?.garmentOrderId).toBe('G1');
  });
});

/**
 * §9 **B39** · 位置参数内插原文的执行覆盖（R3 / §6 S1）
 *
 * 本批把该文件 4 处 ``fail(INTERNAL_TRANSFER_ERRORS.INTERNAL_ERROR, `…事务失败: ${String(e?.message ?? e)}`, 500)``
 * 换成字面中文。该文件**本来就有 `logger.error`**（实测 4 处）⇒ **一条都不用补**（D51：按文件实测）。
 *
 * ★ **D52 覆盖面**：4 处的 `try` 内**唯一写都是那个 `$transaction`**，之后只有 `return`（含 logger.info）
 *   ⇒ 四处**都可以**承诺「本次未确认任何改动」。
 *   ⚠️ 另注：这三处（confirm / registerDelivery / cancel）的 `catch` 里**前面还有一条业务错误透传分支**
 *   `if (e?.code === INVALID_TRANSFER_STATE) return fail(INVALID_TRANSFER_STATE, e.message, 409)`
 *   —— 那是**有意的业务文案透传**（自带 code），**本批不动**；它不是 B39 站点（形状不同，无 `||`/模板内插）。
 *
 * 出口链已核：`internalTradeRoute.ts:94/121/152/177` 用
 * `res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message })` 原样转发。
 */
const B39_RAW = 'PrismaClientKnownRequestError: Invalid `prisma.$transaction()` invocation in '
  + '/srv/app/server/src/internalTrade/internalTransferService.ts:416 — '
  + 'Unique constraint failed on the fields: (`id`)';
const B39_FRAGMENTS = ['PrismaClient', 'prisma.$transaction', 'internalTransferService.ts:416', 'Unique constraint', '/srv/app', 'P2002'];

function expectB39Copy(msg: unknown, mustMention: string) {
  expect(typeof msg).toBe('string');
  const s = msg as string;
  expect(s.length, `文案过短（${s.length} 字）：${s}`).toBeGreaterThanOrEqual(20);
  expect(s, '必须含中文').toMatch(/[\u4e00-\u9fa5]/);
  expect(s, `必须说清对象：${s}`).toContain(mustMention);
  expect(s, `必须给下一步：${s}`).toMatch(/(稍后重试|联系管理员)/);
  expect(s.match(/[A-Za-z]{3,}/g) ?? [], `混入拉丁词（疑似原文上屏）：${s}`).toEqual([]);
  expect(s, '唯一写是 $transaction ⇒ 可以承诺零改动').toContain('本次未确认任何改动');
}

describe('§9 B39 · 内部供料单四处出口：内部原文不上屏', () => {
  const SHIPMENT = { id: 'SH1', shipmentNumber: 'SHP-2026-001', orderId: 'F1', status: 'Shipped', deletedAt: null };
  const failTx = (prisma: any) => { prisma.$transaction = async () => { throw new Error(B39_RAW); }; return prisma; };

  async function seedEffectiveWithShipment() {
    const ctx = makePrisma({
      orders: baseOrders(), orderLines: baseLines(),
      approvals: [{ id: 'ar_1', status: 'approved' }], shipments: [{ ...SHIPMENT }],
    });
    const { service } = makeService(ctx.prisma);
    const created = await service.createInternalTransfer(VALID_INPUT);
    if (!created.ok) throw new Error(`seed create failed: ${created.error.code}`);
    await decideApproval(ctx.prisma, created.data.approvalRequestId);
    const confirmed = await service.confirmInternalTransfer({ id: created.data.transfer.id, actorId: 'u_fabric' });
    if (!confirmed.ok) throw new Error(`seed confirm failed: ${confirmed.error.code}`);
    return { ctx, service, id: created.data.transfer.id };
  }

  it('★ createInternalTransfer：500 + 码名不变 + 中文 + 零原文 + 承诺零改动', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const { prisma } = makePrisma({ orders: baseOrders(), orderLines: baseLines() });
    const { service } = makeService(failTx(prisma));
    const r = await service.createInternalTransfer(VALID_INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(INTERNAL_TRANSFER_ERRORS.INTERNAL_ERROR);
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectB39Copy(r.error.message, '内部供料单创建');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[InternalTransfer]'), expect.objectContaining({ error: B39_RAW }));
    spy.mockRestore();
  });

  it('★ confirmInternalTransfer：500 + 码名不变 + 中文 + 零原文 + 承诺零改动', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const ctx = await seedPendingTransfer({ approvals: [{ id: 'ar_1', status: 'approved' }] });
    failTx(ctx.prisma);
    const r = await ctx.service.confirmInternalTransfer({ id: ctx.created.transfer.id, actorId: 'u_fabric' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(INTERNAL_TRANSFER_ERRORS.INTERNAL_ERROR);
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectB39Copy(r.error.message, '确认生效');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[InternalTransfer]'), expect.objectContaining({ error: B39_RAW }));
    spy.mockRestore();
  });

  it('★ registerDelivery：500 + 码名不变 + 中文 + 零原文 + 承诺零改动', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const { ctx, service, id } = await seedEffectiveWithShipment();
    failTx(ctx.prisma);
    const r = await service.registerDelivery({ id, actorId: 'u_fabric', shipmentId: 'SH1', quantity: 100 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(INTERNAL_TRANSFER_ERRORS.INTERNAL_ERROR);
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectB39Copy(r.error.message, '交付登记');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[InternalTransfer]'), expect.objectContaining({ error: B39_RAW }));
    spy.mockRestore();
  });

  it('★ cancelInternalTransfer：500 + 码名不变 + 中文 + 零原文 + 承诺零改动', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const ctx = await seedPendingTransfer();
    failTx(ctx.prisma);
    const r = await ctx.service.cancelInternalTransfer({ id: ctx.created.transfer.id, actorId: 'u_sales' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(INTERNAL_TRANSFER_ERRORS.INTERNAL_ERROR);
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectB39Copy(r.error.message, '取消');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[InternalTransfer]'), expect.objectContaining({ error: B39_RAW }));
    spy.mockRestore();
  });
});
