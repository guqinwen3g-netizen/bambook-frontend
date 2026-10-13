/**
 * T6-b 陆运段 + T6-a 订舱段 —— 单元/契约测试
 *
 * 覆盖：
 *   - 陆运段 upsert：一票一段（重复提交不重复建行）、字段校验（日期格式/费用非负）、404
 *   - 毛利口径未切契约：profitSheetService 不消费陆运费（本批只采集——切换与 CIF 分支同一刀，
 *     见 T2 回报 ❓1；此契约钉住"本批不改任何毛利数字"）
 *   - 订舱段：PATCH 白名单含 T6-a 八字段（并舱 = 多票同订舱号，无唯一约束）
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createShipmentLandTransportService } from '../shipmentLandTransportService';

vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function makePrisma(opts: { shipment?: any; existing?: any } = {}) {
  const shipment = opts.shipment ?? { id: 'SHP_1', shipmentNumber: 'SHP-001', deletedAt: null };
  let row: any = opts.existing ? { ...opts.existing } : null;
  const tx: any = {
    shipment: { findUnique: vi.fn().mockResolvedValue(shipment) },
    shipmentLandTransport: {
      findUnique: vi.fn().mockImplementation(async () => (row ? { ...row } : null)),
      create: vi.fn().mockImplementation(async ({ data }: any) => { row = { ...data }; return { ...row }; }),
      update: vi.fn().mockImplementation(async ({ data }: any) => { Object.assign(row, data); return { ...row }; }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'AL_1' }) },
  };
  const prisma: any = { $transaction: vi.fn(async (fn: any) => fn(tx)), __tx: tx };
  prisma.shipmentLandTransport = tx.shipmentLandTransport; // getLandTransport 走顶层 client
  (prisma as any).__row = () => row;
  return prisma;
}

const baseInput = {
  plannedArrivalAt: '2026-09-20 09:00',
  actualDeliveredAt: '2026-09-20 11:30',
  plateNo: '沪A12345',
  driverName: '张师傅',
  inlandFreightAmount: '1200',
  inlandFreightCurrency: 'CNY',
  warehouseFeeAmount: '200',
  warehouseFeeCurrency: 'CNY',
};

describe('T6-b 陆运段 upsert', () => {
  beforeEach(() => vi.clearAllMocks());

  it('新建：一票一段落库 + 审计', async () => {
    const prisma = makePrisma();
    const svc = createShipmentLandTransportService(prisma);

    const r = await svc.upsertLandTransport({ shipmentId: 'SHP_1', input: baseInput, actorId: 'u1' });

    expect(r.ok).toBe(true);
    expect((prisma as any).__row()).toBeTruthy();
    expect((prisma as any).__row().plateNo).toBe('沪A12345');
    expect(String((prisma as any).__row().inlandFreightAmount)).toBe('1200');
  });

  it('幂等：重复提交更新同一行，不重复建行', async () => {
    const prisma = makePrisma({ existing: { id: 'SLT_1', shipmentId: 'SHP_1', plateNo: '旧车牌' } });
    const svc = createShipmentLandTransportService(prisma);

    const r = await svc.upsertLandTransport({ shipmentId: 'SHP_1', input: { plateNo: '新车牌' } });

    expect(r.ok).toBe(true);
    expect((prisma as any).__row().id).toBe('SLT_1');
    expect((prisma as any).__row().plateNo).toBe('新车牌');
    // create 未被调用（走的 update 分支）
    expect((prisma as any).__tx.shipmentLandTransport.create).not.toHaveBeenCalled();
  });

  it('日期格式非法 → 400（YYYY-MM-DD 或 YYYY-MM-DD HH:mm）', async () => {
    const prisma = makePrisma();
    const svc = createShipmentLandTransportService(prisma);

    const r = await svc.upsertLandTransport({ shipmentId: 'SHP_1', input: { plannedArrivalAt: '明天上午' } });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('费用为负 → 400（采集口径只收非负数）', async () => {
    const prisma = makePrisma();
    const svc = createShipmentLandTransportService(prisma);

    const r = await svc.upsertLandTransport({ shipmentId: 'SHP_1', input: { inlandFreightAmount: -100 } });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('运单不存在/已删 → 404', async () => {
    const prisma = makePrisma({ shipment: { id: 'SHP_X', shipmentNumber: 'X', deletedAt: 123 } });
    const svc = createShipmentLandTransportService(prisma);

    const r = await svc.upsertLandTransport({ shipmentId: 'SHP_X', input: baseInput });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(404);
  });

  it('查询：无陆运段 → null', async () => {
    const prisma = makePrisma();
    const svc = createShipmentLandTransportService(prisma);

    const r = await svc.getLandTransport('SHP_1');

    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as any).landTransport).toBeNull();
  });
});

describe('毛利口径未切（契约钉）', () => {
  it('profitSheetService 不消费陆运费/进仓费（ShipmentLandTransport 零引用）——切换属后续拍板', () => {
    const src = stripComments(readFileSync(new URL('../../pricing/profitSheetService.ts', import.meta.url), 'utf8'));
    expect(src).not.toContain('shipmentLandTransport');
    expect(src).not.toContain('ShipmentLandTransport');
    expect(src).not.toContain('inlandFreightAmount');
  });

  it('订舱段八字段在 PATCH 白名单（T6-a）', () => {
    const src = stripComments(readFileSync(new URL('../route.ts', import.meta.url), 'utf8'));
    for (const f of ['bookingNo', 'soNumber', 'spaceConfirmedAt', 'cutOffAt', 'docCutOffAt', 'billOfLadingNo', 'masterBillNo', 'houseBillNo']) {
      expect(src).toContain(`'${f}'`);
    }
  });
});
