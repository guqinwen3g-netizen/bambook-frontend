/**
 * 客户门户路由测试（stub Prisma，不连真实库）
 *   - 未登录访问业务端点 → 401
 *   - 登录错误口令 → 401；成功 → 返回 token + customer
 *   - 数据作用域：/orders 查询强制 customerRelationId = 登录客户 relationId
 *   - 禁用账号 → 401（requireCustomer 回查 DB）
 */
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createCustomerPortalRouter } from '../route';
import { createCustomerAuthService } from '../authService';
import { orderAmountOrNull } from '../../shared/orderAmount';

// 跟随环境：被测路由在内部自行构造 authService（读 process.env.JWT_SECRET，
// 而测试会加载 server/.env.local），写死常量会导致两侧密钥不一致而全 401。
const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const customerAuth = createCustomerAuthService({ jwtSecret: SECRET });

const CLIENT_RELATION = 'clientA';

function customerToken(customerUserId = 'cu1', relationId = CLIENT_RELATION) {
  return customerAuth.signToken({ kind: 'customer', customerUserId, relationId, displayName: 'A Co' });
}

/** 构造带指定 prisma stub 的 app；requireCustomer 用 customerUser.findFirst */
function makeApp(overrides: any = {}, routerOpts: any = {}) {
  const activeUser = {
    id: 'cu1', email: 'a@portal.demo', displayName: 'A Co', relationId: CLIENT_RELATION,
    relationName: 'A Co', status: 'active', passwordHash: '',
  };
  const prisma: any = {
    customerUser: {
      findFirst: vi.fn(async () => activeUser),
      findUnique: vi.fn(),
      update: vi.fn(async () => activeUser),
    },
    order: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
    shipment: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
    invoice: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
    relation: { findFirst: vi.fn(async () => ({ name: 'A Co', englishName: 'A Co' })) },
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v2/customer', createCustomerPortalRouter({ prisma, ...routerOpts }));
  return { app, prisma };
}

describe('customer portal route', () => {
  it('未登录访问订单 → 401', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v2/customer/orders');
    expect(res.status).toBe(401);
  });

  it('登录错误口令 → 401 INVALID_CREDENTIALS', async () => {
    const prisma: any = {
      customerUser: {
        findFirst: vi.fn(async () => ({ ...{ passwordHash: await customerAuth.hashPassword('right'), status: 'active' } })),
        update: vi.fn(async () => ({})),
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/v2/customer', createCustomerPortalRouter({ prisma }));
    const res = await request(app).post('/api/v2/customer/auth/login').send({ email: 'a@portal.demo', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('数据作用域：/orders 查询 only customerRelationId = 登录客户', async () => {
    const { app, prisma } = makeApp();
    const orderFindMany = vi.fn(async () => []);
    prisma.order.findMany = orderFindMany;
    const res = await request(app)
      .get('/api/v2/customer/orders')
      .set({ Authorization: `Bearer ${customerToken()}` });
    expect(res.status).toBe(200);
    const where = orderFindMany.mock.calls[0][0].where;
    expect(where.customerRelationId).toBe(CLIENT_RELATION);
  });

  it('不存在/禁用的账号 → 401（requireCustomer 回查 DB 未命中）', async () => {
    const { app } = makeApp({
      customerUser: { findFirst: vi.fn(async () => null), findUnique: vi.fn(), update: vi.fn() },
    });
    const res = await request(app)
      .get('/api/v2/customer/orders')
      .set({ Authorization: `Bearer ${customerToken()}` });
    expect(res.status).toBe(401);
  });

  /**
   * 跨客户越权（IDOR）回归。
   *
   * 这里不沿用 makeApp 里「无条件返回数据」的 stub —— 那种 stub 即便把 where 里的
   * customerRelationId 删掉也照样返回 200，测试会假绿。改为**模拟真实数据库**：
   * 只有当 where.customerRelationId 与登录客户一致时才命中，否则返回 null。
   * 这样一旦作用域条件被误删，跨客户请求就会拿到别人的数据 → 测试立刻红。
   */
  describe('跨客户越权（IDOR）门禁', () => {
    const OTHER_RELATION = 'clientB';
    // 详情端点会连带查这些关联表；makeApp 默认 stub 没有它们，缺了会 500 掩盖真实断言
    const LOOKUPS = {
      shipmentOrderAllocation: { findMany: vi.fn(async () => []) },
      paymentVoucher: { findMany: vi.fn(async () => []) },
      invoiceLine: { findMany: vi.fn(async () => []) },
      invoiceAllocation: { findMany: vi.fn(async () => []) },
    };

    // 模拟真实表：id 与 customerRelationId 同时匹配才命中（只按 relationId 判定会掩盖越权）
    const ORDERS = [
      // lines 由 include:{lines:true} 带回，Prisma 恒返回数组；stub 需补齐否则渲染 500
      { id: 'ord_self', customerRelationId: CLIENT_RELATION, poNumber: 'PO-SELF', status: 'Confirmed', lines: [] },
      { id: 'ord_other', customerRelationId: OTHER_RELATION, poNumber: 'PO-OTHER', status: 'Confirmed', lines: [] },
    ];
    const INVOICES = [
      { id: 'inv_self', customerRelationId: CLIENT_RELATION, type: 'Receivable', status: 'Issued', invoiceNumber: 'INV-SELF', amount: 100 },
      { id: 'inv_other', customerRelationId: OTHER_RELATION, type: 'Receivable', status: 'Issued', invoiceNumber: 'INV-OTHER', amount: 200 },
    ];
    const findInTable = (table: any[]) => vi.fn(async (args: any) => {
      const w = args?.where || {};
      return table.find((r) =>
        (w.id == null || r.id === w.id)
        && (w.customerRelationId == null || r.customerRelationId === w.customerRelationId)
        && (w.type == null || r.type === w.type)) ?? null;
    });

    it('GET /orders/:id —— 他人订单 → 404，且查询带 customerRelationId 作用域', async () => {
      const { app, prisma } = makeApp({
        ...LOOKUPS,
        order: { findFirst: findInTable(ORDERS), findMany: vi.fn(async () => []) },
      });
      // 客户 A 拿客户 B 的订单 id
      const res = await request(app)
        .get('/api/v2/customer/orders/ord_other')
        .set({ Authorization: `Bearer ${customerToken()}` });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
      // 作用域条件必须真的下发到查询层
      const where = prisma.order.findFirst.mock.calls[0][0].where;
      expect(where.customerRelationId).toBe(CLIENT_RELATION);
      expect(where.id).toBe('ord_other');
    });

    it('GET /orders/:id —— 自己的订单 → 200（对照组，防止门禁过严误杀）', async () => {
      const { app } = makeApp({
        ...LOOKUPS,
        order: { findFirst: findInTable(ORDERS), findMany: vi.fn(async () => []) },
      });
      const res = await request(app)
        .get('/api/v2/customer/orders/ord_self')
        .set({ Authorization: `Bearer ${customerToken()}` });
      expect(res.status).toBe(200);
      expect(res.body.order?.id ?? res.body.id).toBe('ord_self');
    });

    it('GET /invoices/:id —— 他人发票 → 404，且查询带 customerRelationId 作用域', async () => {
      const { app, prisma } = makeApp({
        ...LOOKUPS,
        invoice: { findFirst: findInTable(INVOICES), findMany: vi.fn(async () => []) },
      });
      const res = await request(app)
        .get('/api/v2/customer/invoices/inv_other')
        .set({ Authorization: `Bearer ${customerToken()}` });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
      const where = prisma.invoice.findFirst.mock.calls[0][0].where;
      expect(where.customerRelationId).toBe(CLIENT_RELATION);
      expect(where.id).toBe('inv_other');
    });

    it('GET /invoices/:id —— 自己的发票 → 200（对照组）', async () => {
      const { app } = makeApp({
        ...LOOKUPS,
        invoice: { findFirst: findInTable(INVOICES), findMany: vi.fn(async () => []) },
        order: { findFirst: findInTable(ORDERS), findMany: vi.fn(async () => []) },
      });
      const res = await request(app)
        .get('/api/v2/customer/invoices/inv_self')
        .set({ Authorization: `Bearer ${customerToken()}` });
      expect(res.status).toBe(200);
    });
  });

  it('客户 token 无法访问内部路由语义（内部 guard 因缺 roles 拒绝业务流程）', async () => {
    // 直接用同样的 JWT 走 requirePermission 语义：客户 token 无 permissions，应被内部权限门拒绝。
    const decoded = jwt.decode(customerToken()) as any;
    expect(decoded?.roles).toBeUndefined();
    expect(decoded?.permissions).toBeUndefined();
  });
});

describe('customer portal 登录防爆破（2026-09-15 补：此前门户登录无任何限流）', () => {
  const login = (app: any, email: string, password: string) =>
    request(app).post('/api/v2/customer/auth/login').send({ email, password });

  it('连续 5 次失败后第 6 次 → 429 RATE_LIMITED（窗口内不再查库）', async () => {
    const { app, prisma } = makeApp();
    for (let i = 0; i < 5; i++) {
      const r = await login(app, 'a@portal.demo', 'wrong');
      expect(r.status, `第 ${i + 1} 次`).toBe(401);
    }
    const blocked = await login(app, 'a@portal.demo', 'wrong');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');
    expect(typeof blocked.body.retryAfterMs).toBe('number');
    // 被封锁后不再查库（防爆破的意义所在）
    const callsBefore = prisma.customerUser.findFirst.mock.calls.length;
    await login(app, 'a@portal.demo', 'wrong');
    expect(prisma.customerUser.findFirst.mock.calls.length).toBe(callsBefore);
  });

  it('限流按「IP + 邮箱」建键：换邮箱不受上一个邮箱的封锁影响', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 6; i++) await login(app, 'a@portal.demo', 'wrong');
    expect((await login(app, 'a@portal.demo', 'wrong')).status).toBe(429);
    expect((await login(app, 'b@portal.demo', 'wrong')).status).toBe(401);
  });

  it('登录成功会清零失败计数（成功后仍可正常重试）', async () => {
    const hash = bcrypt.hashSync('pw123', 4); // 低轮次，测试快
    const { app } = makeApp({
      customerUser: {
        findFirst: vi.fn(async () => ({
          id: 'cu1', email: 'a@portal.demo', displayName: 'A Co', relationId: CLIENT_RELATION,
          relationName: 'A Co', status: 'active', passwordHash: hash,
        })),
        update: vi.fn(async () => ({})),
      },
    });
    for (let i = 0; i < 4; i++) {
      expect((await login(app, 'a@portal.demo', 'wrong')).status).toBe(401);
    }
    const okRes = await login(app, 'a@portal.demo', 'pw123');
    expect(okRes.status).toBe(200);
    expect(okRes.body.token).toBeTruthy();
    // 清零后，再错 4 次仍不该被封（若没清零，第 5 次就会 429）
    for (let i = 0; i < 4; i++) {
      expect((await login(app, 'a@portal.demo', 'wrong')).status).toBe(401);
    }
  });
});

const active = {
  id: 'cu1', email: 'a@portal.demo', displayName: 'A Co', relationId: CLIENT_RELATION,
  relationName: 'A Co', status: 'active', passwordHash: '',
};
// ────────────────────────────────────────────────────────────────
// ★ E 批（2026-09-26）：客户门户看到的「订单金额」必须是真源值
//   病形：门户 DTO 直传 `quoteAmount`，而同一页的行表渲染 `netValue`
//         ⇒ 客户在 OrderDetail 的一页上看到两个对不上的数。
//   ★ 桩必须**尊重 select/include**：否则「改了 DTO 却没补 select 列」
//     这种缺陷在桩上永远测不出来（真 Prisma 会按 select 裁字段 ⇒ 静默落 ③）。
// ────────────────────────────────────────────────────────────────
describe('E 批：客户门户订单金额 = 明细行合计', () => {
  const DIVERGENT = {
    id: 'ord_div', poNumber: 'PO-DIV', code: null, customer: 'A Co', product: 'Poplin', type: 'Fabric',
    businessLine: 'fabric', quantity: 10600, status: 'Confirmed', currency: 'USD',
    quoteAmount: 16850.5, totalNet: 16850.5, contractAmount: 16850.5,
    dueDate: '2026-11-30', productionDate: null, clientDate: null, createdAt: 1,
    deliveryTerms: 'FOB', paymentTerms: 'T/T', paymentInstrument: 'T/T', billToName: null,
    invoiceNumber: null, invoiceDate: null, shipmentDate: null, shipmentMethod: null,
    shipmentQuantity: null, shipmentAmount: null,
    lines: [
      { unit: 'YD', netValue: 10000, lineNumber: 1 },
      { unit: 'PC', netValue: 3000, lineNumber: 2 },
    ],
  };

  /** 按 select 投影（include 时 select 为 undefined ⇒ 原样返回） */
  function project(row: any, select?: any): any {
    if (!select) return row;
    const out: any = {};
    for (const [k, v] of Object.entries(select)) {
      if (v === true) out[k] = row[k];
      else if (v && typeof v === 'object') {
        out[k] = (row[k] ?? []).map((r: any) => project(r, (v as any).select));
      }
    }
    return out;
  }

  it('列表：orderAmount 给真源值，且 select 真的带上了真源要读的列', async () => {
    let seenSelect: any = null;
    const { app } = makeApp({
      order: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async (args: any) => {
          seenSelect = args.select;
          return [project(DIVERGENT, args.select)];
        }),
        groupBy: vi.fn(async () => []),
      },
    });
    const res = await request(app)
      .get('/api/v2/customer/orders')
      .set({ Authorization: `Bearer ${customerToken()}` });
    expect(res.status).toBe(200);
    expect(res.body.items[0].orderAmount).toBe(13000);
    expect(res.body.items[0]).not.toHaveProperty('quoteAmount');
    // 证人：这两列缺一个，orderAmount 就会静默变成报价额（见下面那一例）
    expect(seenSelect.totalNet).toBe(true);
    expect(seenSelect.lines.select.netValue).toBe(true);
  });

  it('详情：卡片金额与同页行表同源（findFirst 的 include 带着 lines）', async () => {
    const { app } = makeApp({
      order: {
        findFirst: vi.fn(async () => DIVERGENT),
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
      },
      shipmentOrderAllocation: { findMany: vi.fn(async () => []) },
    });
    const res = await request(app)
      .get('/api/v2/customer/orders/ord_div')
      .set({ Authorization: `Bearer ${customerToken()}` });
    expect(res.status).toBe(200);
    expect(res.body.order.orderAmount).toBe(13000);
    // 同一页的两个数必须相等：卡片 vs 行表逐格相加
    const lineSum = res.body.lines.reduce((s: number, l: any) => s + Number(l.netValue), 0);
    expect(lineSum).toBe(res.body.order.orderAmount);
  });

  it('★ 桩的形状证人（★ 不跑路由）：证明上面 seenSelect 那两条断言不是恒真 —— 桩真的按 select 裁字段', () => {
    // ★ 本例只喂 orderAmountOrNull 一个手裁过的对象，**不经过路由** ⇒ 它证的不是产品代码，
    //   而是「我的桩有牙」：正因为桩会按 select 裁字段，r1 里那两条 seenSelect 断言才不是摆设
    // 少一列时 orderAmountOrNull 会落到 ③ 报价额（16850.5）而不是 ① 明细行合计（13000）
    const starved = project(DIVERGENT, {
      id: true, currency: true, quoteAmount: true,
      lines: { select: { unit: true } }, // ← 旧 select 的形状
    });
    expect(orderAmountOrNull(starved)).toBe(16850.5);
    expect(orderAmountOrNull(project(DIVERGENT, {
      id: true, currency: true, quoteAmount: true, totalNet: true,
      lines: { select: { unit: true, netValue: true } },
    }))).toBe(13000);
  });
});
