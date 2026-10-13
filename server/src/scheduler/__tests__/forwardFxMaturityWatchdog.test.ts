/**
 * forwardFxMaturityWatchdog.test.ts — ★ D6 真库守卫：远期合约到期预警
 *
 * 为什么要有（零基础障碍清单 D6）：合约层缺的后果里，**"到期日没人管"是其中一半** ——
 * 远期结汇合约到期必须交割，逾期有展期成本/罚息。本任务把"临近/已逾期"变成**可见的预警**。
 *
 * 判据（真库 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 到期 ≤7 天 → warning；已逾期 → critical（title 带「已逾期 N 天」）
 *   ② 窗口外（>7 天）→ 不预警
 *   ③ ★ 终态不预警（已交割 Settled / 已取消 Cancelled）
 *   ④ ★ 到期日非法 → **跳过**（不显示成"今天到期"：0 与 null 是两回事）
 *   ⑤ 幂等：同日重复扫 → 不重复建（dedupKey 由 RiskAlert 唯一约束承担）
 *   ⑥ 预警内容带「剩余未交割」金额（业务员要知道还差多少要交割）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';
import { scanForwardFxMaturity } from '../tasks/forwardFxMaturityWatchdog';

const prisma = new PrismaClient();

const MARK = 'TEST_D6WD_';
let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

/** 本地日期（与真源同口径：业务日期不用 UTC） */
const ymd = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function cleanup() {
  await prisma.riskAlert.deleteMany({ where: { dedupKey: { startsWith: 'forward_fx_maturity:' } } });
  await prisma.forwardFxContract.deleteMany({ where: { id: { startsWith: MARK } } });
}

/** ★ v3.31（B151）：**只换读数这一侧**。本文件没有 ctx、MARK 是族级前缀 ⇒
 *   刻意不改成 createDrillContext（那等于把标记换成 run 唯一 = §12.1 第 27 条等 Kevin 拍的事）；
 *   `cleanup()` 与"删按 dedupKey、数按 relatedId"的列差也一个字未动。 */
const RESIDUAL_SPEC = [
  { key: 'c', model: 'forwardFxContract', run: () => prisma.forwardFxContract.count({ where: { id: { startsWith: MARK } } }) },
  { key: 'a', model: 'riskAlert', run: () => prisma.riskAlert.count({ where: { relatedId: { startsWith: MARK } } }) },
];

async function makeContract(over: Record<string, unknown> = {}) {
  const id = `${MARK}FFX_${n()}`;
  return prisma.forwardFxContract.create({
    data: {
      id, contractNumber: `${MARK}FX-${n()}`,
      bankName: '某银行', currency: 'USD',
      foreignAmount: new Prisma.Decimal(1000),
      contractRate: new Prisma.Decimal(7.0),
      signedDate: ymd(-90), maturityDate: ymd(3),
      settledForeignAmount: new Prisma.Decimal(0), status: 'Open',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      ...over,
    } as any,
  });
}

const alertsOf = (id: string) =>
  prisma.riskAlert.findMany({ where: { relatedId: id }, select: { level: true, title: true, content: true, dedupKey: true } });

describe('★ D6 真库守卫：远期合约到期预警', () => {
  beforeAll(async () => { await cleanup(); });

  afterAll(async () => {
    await cleanup();
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（SPEC 见本文件顶部）`)
      .toEqual({ c: 0, a: 0 });
    await prisma.$disconnect();
  });

  it('① 到期 3 天后 → warning（title 带「仅剩 3 天」）', async () => {
    const c = await makeContract({ maturityDate: ymd(3) });
    await scanForwardFxMaturity(prisma);
    const alerts = await alertsOf(c.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('warning');
    expect(alerts[0].title).toContain('仅剩 3 天');
    // 内容要带剩余未交割（业务员要知道还差多少要交割）
    expect(alerts[0].content).toContain('剩余未交割 1000');
  });

  it('② 已逾期 5 天 → critical（title 带「已逾期 5 天」）', async () => {
    const c = await makeContract({ maturityDate: ymd(-5), signedDate: ymd(-200) });
    await scanForwardFxMaturity(prisma);
    const alerts = await alertsOf(c.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('critical');
    expect(alerts[0].title).toContain('已逾期 5 天');
  });

  it('③ 窗口外（30 天后）→ 不预警', async () => {
    const c = await makeContract({ maturityDate: ymd(30) });
    await scanForwardFxMaturity(prisma);
    expect(await alertsOf(c.id)).toHaveLength(0);
  });

  it('★ ④ 终态不预警（已交割 Settled / 已取消 Cancelled）', async () => {
    const settled = await makeContract({ maturityDate: ymd(2), status: 'Settled', settledForeignAmount: new Prisma.Decimal(1000) });
    const cancelled = await makeContract({ maturityDate: ymd(2), status: 'Cancelled' });
    await scanForwardFxMaturity(prisma);
    expect(await alertsOf(settled.id)).toHaveLength(0);
    expect(await alertsOf(cancelled.id)).toHaveLength(0);
  });

  it('★ ⑤ 到期日非法 → 跳过（不显示成「今天到期」）', async () => {
    const c = await makeContract({ maturityDate: 'not-a-date' });
    await scanForwardFxMaturity(prisma);
    expect(await alertsOf(c.id)).toHaveLength(0);
  });

  it('★ ⑥ 幂等：同日重复扫 → 不重复建（dedupKey 唯一约束）', async () => {
    const c = await makeContract({ maturityDate: ymd(1) });
    const first = await scanForwardFxMaturity(prisma);
    expect(first.alerted).toBeGreaterThanOrEqual(1);
    const second = await scanForwardFxMaturity(prisma);
    expect(second.alerted).toBe(0); // 同键不再新建
    expect(await alertsOf(c.id)).toHaveLength(1);
  });

  it('⑦ 部分交割的合约：剩余未交割金额正确（1000 − 400 = 600）', async () => {
    const c = await makeContract({ maturityDate: ymd(4), settledForeignAmount: new Prisma.Decimal(400), status: 'PartiallySettled' });
    await scanForwardFxMaturity(prisma);
    const alerts = await alertsOf(c.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].content).toContain('剩余未交割 600');
    expect(alerts[0].content).toContain('已交割 400');
  });
});
