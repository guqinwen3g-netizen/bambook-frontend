/**
 * B220 · v3.112：报关单更新的**字段级**留痕
 *
 * 修之前：`updateDeclaration` 只写一条 `CUSTOMS_DECLARATION_UPDATE`，`detail` 里是
 * `{ fields: Object.keys(input) }` ⇒ 看得出"动了运保费这个字段"，看不出"从 1,200 改成 3,400"。
 * 本文件钉四件事（缺一件就是半瞎的测试）：
 *   ① 真改动 ⇒ 出现带前后值的字段级痕；
 *   ② `Decimal` 列（运保费）折成字符串才进 `Json`；
 *   ③ 值没变 ⇒ 不产生痕（不许把"碰过"记成"改过"）；
 *   ④ 前值取自**事务内**那一次读（把事务内外喂成两行不同的数据，看它用哪一份）；
 *   ⑤ 追踪面比 agent 白名单**宽**（`freightAmount` 只在 HTTP 侧可改，白名单里没有它 ——
 *      只派生白名单就会漏掉这一列，这条把差异钉成断言）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createCustomsService, CUSTOMS_DECLARATION_AUDIT_FIELDS, CUSTOMS_DECLARATION_UPDATE_FIELDS } from '../customsService';

const BEFORE_IN_TX = {
  id: 'cd_1', declarationNumber: 'CD-2026-001', type: 'Export', status: 'Draft',
  tradeTerms: 'FOB Shanghai', currency: 'USD',
  // 运保费在 Prisma 里是 Decimal（有 toString/toFixed），直接进 Json 列会带出内部形状
  freightAmount: { toString: () => '1200.0000', toFixed: (n: number) => (1200).toFixed(n) },
  insuranceAmount: { toString: () => '80.0000', toFixed: (n: number) => (80).toFixed(n) },
  notes: 'unchanged', lines: [], deletedAt: null,
};
const OUTER_ROW = { ...BEFORE_IN_TX, tradeTerms: '事务外·过期值' };

function makeStub() {
  const audited: any[] = [];
  const tx: any = {
    customsDeclaration: {
      findFirst: vi.fn(async () => BEFORE_IN_TX),          // ★ 事务内读到的那一行（与事务外不同）
      update: vi.fn(async ({ where, data }: any) => ({ ...BEFORE_IN_TX, ...data, id: where.id })),
      findMany: vi.fn(async () => []),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => { audited.push(data); return data; }) },
    shipment: { findFirst: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    entityReference: { findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
    entityLink: { findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
    relation: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    order: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
  };
  const prisma: any = {
    ...tx,
    // 事务外那一次读（状态校验 + 最后 getDeclaration 用它）：喂一份**不同**的行，才能问出前值取自哪边
    customsDeclaration: { ...tx.customsDeclaration, findFirst: vi.fn(async () => OUTER_ROW) },
    $transaction: async (fn: any) => fn(tx),
  };
  return { prisma, audited, tx };
}

describe('B220 · 报关单更新字段级留痕', () => {
  it('①+② 改条款与运保费 ⇒ 出现带前后值的字段级痕，Decimal 折成字符串', async () => {
    const { prisma, audited, tx } = makeStub();
    const svc = createCustomsService(prisma);
    await svc.updateDeclaration('cd_1', { tradeTerms: 'CIF Shenzhen', freightAmount: 3400 }, 'u-9');

    const summary = audited.filter((r) => r.action === 'CUSTOMS_DECLARATION_UPDATE');
    const field = audited.filter((r) => r.action === 'CUSTOMS_DECLARATION_UPDATE_FIELD');
    expect(summary).toHaveLength(1); // 原有那条不许消失（它记着"这次 patch 了哪些字段名"）
    expect(field.length, '改了条款与运保费却零字段级痕 ⇒ 还是答不出"从多少改成多少"').toBeGreaterThanOrEqual(2);

    const tt: any = field.find((r) => r.fieldPath === 'tradeTerms');
    expect(tt).toMatchObject({ targetType: 'CustomsDeclaration', targetId: 'cd_1', afterValue: 'CIF Shenzhen', operationType: 'update' });
    const fr: any = field.find((r) => r.fieldPath === 'freightAmount');
    expect(typeof fr.beforeValue, 'Decimal 原值不许直接进 Json 列').toBe('string');
    expect(fr.beforeValue).toBe('1200.0000');
    // 字段级痕挂到这次操作的汇总行上（读侧能看出"这几条是同一次"）
    for (const r of field) expect(r.transactionId).toBe(summary[0].id);
    expect(tx.customsDeclaration.findFirst, '④ 前值必须先做事务内那次读').toHaveBeenCalled();
  });

  it('③ 值没变 ⇒ 不产生痕（notes 原样传回）', async () => {
    const { prisma, audited } = makeStub();
    const svc = createCustomsService(prisma);
    await svc.updateDeclaration('cd_1', { notes: 'unchanged' }, 'u-9');
    expect(audited.filter((r) => r.fieldPath === 'notes')).toHaveLength(0);
  });

  it('④ 前值取自**事务内**那一行：条款前值必须是事务内读到的 FOB，不是事务外那份过期值', async () => {
    const { prisma, audited } = makeStub();
    const svc = createCustomsService(prisma);
    await svc.updateDeclaration('cd_1', { tradeTerms: 'CIF Shenzhen' }, 'u-9');
    const tt: any = audited.find((r) => r.fieldPath === 'tradeTerms');
    expect(tt.beforeValue, '取到事务外那份 ⇒ 变更史会记一条没发生过的变更').toBe('FOB Shanghai');
  });

  it('⑤ 追踪面＝agent 白名单 ∪ 运保费两列（差异钉成断言，不靠注释）', () => {
    expect(CUSTOMS_DECLARATION_AUDIT_FIELDS).toContain('freightAmount');
    expect(CUSTOMS_DECLARATION_AUDIT_FIELDS).toContain('insuranceAmount');
    expect(CUSTOMS_DECLARATION_UPDATE_FIELDS).not.toContain('freightAmount'); // 白名单确实没有它（agent 通道改不到）
    for (const f of CUSTOMS_DECLARATION_UPDATE_FIELDS) expect(CUSTOMS_DECLARATION_AUDIT_FIELDS).toContain(f);
  });
});
