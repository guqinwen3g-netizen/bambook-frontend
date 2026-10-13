import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lockAndValidate: vi.fn(),
  freezeSnapshot: vi.fn(),
  checkMoq: vi.fn(),
}));

vi.mock('../orderLineQuantityPlan', async (importOriginal) => ({
  ...await importOriginal<typeof import('../orderLineQuantityPlan')>(),
  lockAndValidateQuantityPlan: mocks.lockAndValidate,
}));
vi.mock('../quantityPlanMoqGate', () => ({
  freezeQuantityMoqSnapshot: mocks.freezeSnapshot,
  checkOrderMoqFacts: mocks.checkMoq,
}));

import { createOrderQuantityPlanPreviewService } from '../orderQuantityPlanPreviewService';

const actor: any = { userId: 'sales-1', roles: ['sales'], permissions: ['order:change_request:create'] };
const lineQuantityPlan = {
  version: 2,
  orderId: 'O1',
  expectedUpdatedAt: '100',
  lines: [
    { lineId: 'B', beforeQuantity: '5', unit: 'PC', afterQuantity: '4', beforeUnitPrice: null, beforeNetValue: '0', afterNetValue: '0' },
    { lineId: 'A', beforeQuantity: '1000', unit: 'M', afterQuantity: '800.0003', beforeUnitPrice: '2', beforeNetValue: '1750', afterNetValue: '1500' },
  ],
};

function makeDb(actual: any[]) {
  const write = vi.fn();
  const tx: any = {
    order: { update: write },
    orderLine: { update: write },
    auditLog: { create: write },
    approvalRequest: { create: write },
  };
  const prisma: any = { $transaction: vi.fn(async (run: any) => run(tx)) };
  mocks.lockAndValidate.mockImplementation(async (_tx: any, _orderId: string, plan: any) => ({
    plan,
    actual,
    order: { id: 'O1', updatedAt: 100n, moqSnapshot: { verified: true } },
  }));
  return { prisma, write };
}

beforeEach(() => {
  mocks.lockAndValidate.mockReset();
  mocks.freezeSnapshot.mockReset().mockResolvedValue(null);
  mocks.checkMoq.mockReset();
});

describe('read-only actual-line quantity/MOQ preview', () => {
  it('maps exact mixed-unit verdicts to every actual line and performs no business writes', async () => {
    const actual = [
      { id: 'B', lineNumber: 2, quantity: '5', unit: 'PC' },
      { id: 'A', lineNumber: 1, quantity: '1000', unit: 'M' },
    ];
    const { prisma, write } = makeDb(actual);
    mocks.checkMoq.mockResolvedValue({
      ok: false,
      lines: [
        { lineIndex: 0, quantityExact: '800.0003', unit: 'M', compliant: false },
        { lineIndex: 1, quantityExact: '4', unit: 'PC', compliant: true },
      ],
    });

    const result = await createOrderQuantityPlanPreviewService(prisma).preview(actor, lineQuantityPlan);

    expect(result.advisory).toBe(true);
    expect(result.lineQuantityPlan.lines.map((line: any) => line.lineId)).toEqual(['A', 'B']);
    expect(result.moq.lines.map((line: any) => [line.lineId, line.quantityExact, line.unit])).toEqual([
      ['A', '800.0003', 'M'],
      ['B', '4', 'PC'],
    ]);
    expect(mocks.lockAndValidate).toHaveBeenCalledWith(expect.anything(), 'O1', expect.anything(), actor, 'order:change_request:create');
    expect(write).not.toHaveBeenCalled();
  });

  it('fails closed for an unverified historical line MOQ override before computing a verdict', async () => {
    const { prisma, write } = makeDb([{ id: 'A', lineNumber: 1, quantity: '1000', unit: 'M', moqOverride: 500 }]);
    await expect(createOrderQuantityPlanPreviewService(prisma).preview(actor, lineQuantityPlan)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.checkMoq).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('fails closed if any actual line is missing from the MOQ readback', async () => {
    const { prisma, write } = makeDb([
      { id: 'A', lineNumber: 1, quantity: '1000', unit: 'M' },
      { id: 'B', lineNumber: 2, quantity: '5', unit: 'PC' },
    ]);
    mocks.checkMoq.mockResolvedValue({ ok: true, lines: [{ lineIndex: 0, quantityExact: '800.0003', unit: 'M', compliant: true }] });
    await expect(createOrderQuantityPlanPreviewService(prisma).preview(actor, lineQuantityPlan)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(write).not.toHaveBeenCalled();
  });
});
