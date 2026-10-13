/**
 * W-C 权限收口补漏 · dashboard 域敏感字段遮罩测试（2026-09-02）。
 *
 * 实锤背景：GET /api/v1/dashboard/cockpit 仅校验 cockpit:read，对未持
 * sensitive:cost / sensitive:profit 的角色（sales 等）明文返回订单毛利表的
 * cost/margin/marginRate/collectionRate 与排行榜回款率。
 * 本套件断言：无 sensitive scope 的 actor → 敏感字段遮罩（数字 → null，前端
 * CockpitManager formatPct/formatAmount 渲染 '—'）；持 sensitive scope 或 owner → 明文。
 *
 * 身份矩阵（与 rolePermissionMatrix 默认矩阵一致）：
 *   - sales：cockpit:read 但无 sensitive:*（SALES_BASE 明文注释「自动遮罩」终落地）
 *   - finance：sensitive:cost + sensitive:profit → 全量明文
 *   - cost-only：仅 sensitive:cost → cost 明文，margin/marginRate/collectionRate 遮罩
 *   - owner：legacy owner → 全量明文（SuperAdmin 直通）
 */
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { maskBusinessCockpit, dashboardSensitiveVisibility } from '../sensitiveMask';
import type { BusinessCockpit } from '../dashboardService';

function makeReq(actor: any): Request {
  return { actor } as unknown as Request;
}

const salesActor = { userId: 'u-sales', roles: ['sales'], permissions: ['cockpit:read'] };
const financeActor = { userId: 'u-finance', roles: ['finance'], permissions: ['cockpit:read', 'sensitive:cost', 'sensitive:profit'] };
const costOnlyActor = { userId: 'u-cost', roles: [], permissions: ['cockpit:read', 'sensitive:cost'] };
const ownerActor = { userId: 'u-owner', roles: ['owner'], permissions: ['cockpit:read'] };

function makeCockpit(): BusinessCockpit {
  return {
    from: null, to: null, generatedAt: '2026-09-02T00:00:00.000Z',
    salesLeaderboard: [
      { salesPerson: 'Alice', currency: 'USD', orderCount: 2, salesAmount: 1700, collectedAmount: 600, collectionRate: 0.3529 },
    ],
    customerContribution: [],
    orderMargins: {
      rows: [
        {
          orderId: 'O1', poNumber: 'PO-1', customer: 'ACME', product: 'T-Shirt',
          salesPerson: 'Alice', dueDate: '2026-08-01', status: 'Production',
          currency: 'USD', revenue: 1200, cost: 800, crossCurrency: false,
          margin: 400, marginRate: 0.3333, collectionRate: 0.5,
        },
      ],
      totals: [
        { currency: 'USD', revenue: 1200, cost: 800, margin: 400, marginRate: 0.3333, orderCount: 1 },
      ],
      excludedCount: 0,
    },
    orderStatusDistribution: [],
    deliveryAlerts: [],
    sampleProgressAlerts: [],
    fxTrend: { baseCurrency: 'CNY', points: [] },
    arApAlerts: { receivable: { rows: [], totals: [] }, payable: { rows: [], totals: [] } },
    fxSummary: { baseCurrency: 'CNY', totalGainLoss: 0, rowCount: 0 },
  };
}

describe('dashboardSensitiveVisibility', () => {
  it('sales → 双敏感 false；finance → 双 true；owner 直通', () => {
    expect(dashboardSensitiveVisibility(makeReq(salesActor))).toEqual({ cost: false, profit: false });
    expect(dashboardSensitiveVisibility(makeReq(financeActor))).toEqual({ cost: true, profit: true });
    expect(dashboardSensitiveVisibility(makeReq(ownerActor))).toEqual({ cost: true, profit: true });
  });
});

describe('maskBusinessCockpit — sales（无 sensitive scope）', () => {
  it('masks cost/margin/marginRate/collectionRate on rows + totals + leaderboard', () => {
    const masked = maskBusinessCockpit(makeCockpit(), makeReq(salesActor));
    const row = masked.orderMargins.rows[0];
    expect(row.cost).toBeNull();
    expect(row.margin).toBeNull();
    expect(row.marginRate).toBeNull();
    expect(row.collectionRate).toBeNull();
    // 非敏感字段保真
    expect(row.revenue).toBe(1200);
    expect(row.currency).toBe('USD');
    expect(row.status).toBe('Production');
    const total = masked.orderMargins.totals[0];
    expect(total.cost).toBeNull();
    expect(total.margin).toBeNull();
    expect(total.marginRate).toBeNull();
    expect(total.revenue).toBe(1200);
    // 排行榜：回款率遮罩；collectedAmount（回款流水）不在敏感矩阵内保留
    const leaderboard = masked.salesLeaderboard[0];
    expect(leaderboard.collectionRate).toBeNull();
    expect(leaderboard.collectedAmount).toBe(600);
    expect(leaderboard.salesAmount).toBe(1700);
  });
});

describe('maskBusinessCockpit — finance / owner（持 sensitive scope）', () => {
  it('returns plaintext cockpit untouched (identity)', () => {
    const cockpit = makeCockpit();
    expect(maskBusinessCockpit(cockpit, makeReq(financeActor))).toBe(cockpit);
    expect(maskBusinessCockpit(cockpit, makeReq(ownerActor))).toBe(cockpit);
  });
});

describe('maskBusinessCockpit — cost-only（sensitive:cost 无 sensitive:profit）', () => {
  it('keeps cost visible, masks profit family', () => {
    const masked = maskBusinessCockpit(makeCockpit(), makeReq(costOnlyActor));
    const row = masked.orderMargins.rows[0];
    expect(row.cost).toBe(800);
    expect(row.margin).toBeNull();
    expect(row.marginRate).toBeNull();
    expect(row.collectionRate).toBeNull();
    const total = masked.orderMargins.totals[0];
    expect(total.cost).toBe(800);
    expect(total.margin).toBeNull();
    expect(total.marginRate).toBeNull();
    expect(masked.salesLeaderboard[0].collectionRate).toBeNull();
  });
});

/**
 * ★ 口径 B2（2026-09-17 业务方确认）：`fxSummary`（汇兑损益）与 `arApAlerts`（应收应付逾期预警）
 *   **刻意不遮罩** —— 任何能进驾驶舱的人都能看，含业务员。
 *
 * ── 为什么要有这条测试 ───────────────────────────────────
 * 这两个字段**看起来很像"该遮罩的敏感财务数据"**（P4-1 体检曾把它列为待修缺陷，
 * 设计文档 §8-4 也提过按 `fx:read`/`ar:read` 过滤）。但业务方 2026-09-17 明确答复
 * **「两块都不遮罩」** ⇒ 它是**确认口径、不是缺陷**。
 * 这条断言的作用：**将来有人（包括未来的我）去"顺手修"它时，立刻转红**，
 * 强制先回来改口径，而不是悄悄改变业务方确认过的行为。
 */
describe('★ 口径 B2：fxSummary / arApAlerts 刻意不遮罩', () => {
  /** 给这两块塞**非空真值**（否则"没遮罩"与"本来就是空"无法区分 = 空过的验证器） */
  function cockpitWithAlerts(): BusinessCockpit {
    const c = makeCockpit();
    c.fxSummary = { baseCurrency: 'CNY', totalGainLoss: 12345.67, rowCount: 3 };
    c.arApAlerts = {
      receivable: { rows: [], totals: [{ currency: 'USD', overdue: 9999, total: 20000 }] },
      payable: { rows: [], totals: [{ currency: 'CNY', overdue: 888, total: 1000 }] },
    };
    return c;
  }

  it('★ 承重：无 sensitive scope 的 sales actor → 这两块**原样返回**（数字不被置 null/0）', () => {
    const before = cockpitWithAlerts();
    const after = maskBusinessCockpit(before, makeReq(salesActor));
    expect(after.fxSummary).toEqual(before.fxSummary);
    expect(after.arApAlerts).toEqual(before.arApAlerts);
    expect(after.fxSummary.totalGainLoss).toBe(12345.67);
    expect(after.arApAlerts.receivable.totals[0].overdue).toBe(9999);
    expect(after.arApAlerts.payable.totals[0].overdue).toBe(888);
  });

  it('★ 阳性对照：同一函数确实遮了别的敏感块 —— 证明上面那条不是"函数根本没生效"', () => {
    const after = maskBusinessCockpit(cockpitWithAlerts(), makeReq(salesActor));
    expect(after.orderMargins.rows[0].cost).toBeNull();
    expect(after.orderMargins.rows[0].margin).toBeNull();
    expect(after.salesLeaderboard[0].collectionRate).toBeNull();
  });
});
