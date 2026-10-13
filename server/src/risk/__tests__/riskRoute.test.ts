import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const viewerToken = jwt.sign({ userId: 'u2', roles: ['viewer'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createRiskRouter } from '../riskRoute';

/**
 * Mock Prisma：内存存储 H3 五个模型 + 关联真源（Invoice/Relation/Order/CreditLimit/
 * CustomsDeclaration/CustomsDeclarationLine/HsCode/InspectionReport）。
 * 语义对齐真实 client 的本测试用到的子集（where 条件、多字段 orderBy、
 * riskAlert.dedupKey 唯一约束 → P2002）。
 */
function makeMockPrisma() {
  let seq = 0;
  const exchangeRates: any[] = [];
  const fxRateLocks: any[] = [];
  const riskAlerts: any[] = [];
  const creditRatings: any[] = [];
  const complianceChecks: any[] = [];
  const invoices: any[] = [];
  const relations: any[] = [];
  const orders: any[] = [];
  const creditLimits: any[] = [];
  const customsDeclarations: any[] = [];
  const customsDeclarationLines: any[] = [];
  const hsCodes: any[] = [];
  const inspectionReports: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as any[]).some(sub => matchWhere(row, sub));
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('equals' in cond) {
          return cond.mode === 'insensitive'
            ? String(row[k] ?? '').toLowerCase() === String(cond.equals).toLowerCase()
            : row[k] === cond.equals;
        }
        if ('contains' in cond) return String(row[k] || '').toLowerCase().includes(String(cond.contains).toLowerCase());
        if ('lt' in cond && !(row[k] < cond.lt)) return false;
        if ('lte' in cond && !(row[k] <= cond.lte)) return false;
        if ('gt' in cond && !(row[k] > cond.gt)) return false;
        if ('gte' in cond && !(row[k] >= cond.gte)) return false;
        return true;
      }
      return row[k] === v;
    });

  // 支持单字段对象或多字段数组两种 orderBy 形式
  const applyOrderBy = (rows: any[], orderBy: any) => {
    if (!orderBy) return rows;
    const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((x, y) => {
      for (const o of orders) {
        const [[field, dir]] = Object.entries(o) as [string, string][];
        const xv = x[field] ?? null;
        const yv = y[field] ?? null;
        if (xv === yv) continue;
        if (xv === null) return 1;
        if (yv === null) return -1;
        if (xv < yv) return dir === 'desc' ? 1 : -1;
        if (xv > yv) return dir === 'desc' ? -1 : 1;
      }
      return 0;
    });
  };

  const applyTakeSkip = (rows: any[], take?: number, skip?: number) =>
    rows.slice(skip || 0, (skip || 0) + (take ?? rows.length));

  /**
   * ★ Prisma `distinct` 的真实语义：在 **orderBy 之后、take/skip 之前**去重，每组保留第一条。
   *   2026-09-17 用真库实测确认（`distinct:['relationId'] + take:3` 返回 3 个不同客户）。
   *   ⚠️ mock 若写成「先 take 再 distinct」，测试就会**固化错误语义**，
   *   让「生产先去重、mock 后去重」的差异**结构性不可见** —— 这正是本仓踩过的坑。
   */
  const applyDistinct = (rows: any[], distinct?: string[]) => {
    if (!distinct || distinct.length === 0) return rows;
    const seen = new Set<string>();
    return rows.filter((r) => {
      const key = distinct.map((f) => String(r[f])).join('\u0000');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const exchangeRate = {
    findFirst: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(exchangeRates.filter(r => matchWhere(r, where)), orderBy)[0] ?? null,
    findMany: async ({ where, orderBy, take, skip }: any = {}) =>
      applyTakeSkip(applyOrderBy(exchangeRates.filter(r => matchWhere(r, where)), orderBy), take, skip),
    count: async ({ where }: any = {}) => exchangeRates.filter(r => matchWhere(r, where)).length,
    create: async ({ data }: any) => {
      const row = { source: 'manual', note: null, ...data, id: data.id || `FXR__T${++seq}` };
      exchangeRates.push(row);
      return row;
    },
  };

  const fxRateLock = {
    findUnique: async ({ where }: any) => fxRateLocks.find(l => l.id === where.id) || null,
    findFirst: async ({ where }: any = {}) => fxRateLocks.find(l => matchWhere(l, where)) || null,
    findMany: async ({ where, orderBy, take, skip }: any = {}) =>
      applyTakeSkip(applyOrderBy(fxRateLocks.filter(l => matchWhere(l, where)), orderBy), take, skip),
    count: async ({ where }: any = {}) => fxRateLocks.filter(l => matchWhere(l, where)).length,
    create: async ({ data }: any) => {
      const row = { note: null, lockedById: null, deletedAt: null, ...data, id: data.id || `FXL__T${++seq}` };
      fxRateLocks.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = fxRateLocks.find(l => l.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const riskAlert = {
    findUnique: async ({ where }: any) =>
      riskAlerts.find(a => (where.id !== undefined ? a.id === where.id : a.dedupKey === where.dedupKey)) || null,
    findMany: async ({ where, orderBy, take, skip }: any = {}) =>
      applyTakeSkip(applyOrderBy(riskAlerts.filter(a => matchWhere(a, where)), orderBy), take, skip),
    count: async ({ where }: any = {}) => riskAlerts.filter(a => matchWhere(a, where)).length,
    // ★ getRiskOverview 的计数走 groupBy（不再从 take:500 窗口里数）
    groupBy: async ({ by, where, _count }: any = {}) => {
      const rows = riskAlerts.filter(a => matchWhere(a, where));
      const groups = new Map<string, any>();
      for (const r of rows) {
        const key = (by as string[]).map(f => String(r[f])).join('\u0000');
        if (!groups.has(key)) {
          const g: any = {};
          for (const f of by as string[]) g[f] = r[f];
          if (_count?._all) g._count = { _all: 0 };
          groups.set(key, g);
        }
        if (_count?._all) groups.get(key)._count._all += 1;
      }
      return [...groups.values()];
    },
    create: async ({ data }: any) => {
      // dedupKey @unique 幂等真源：与真实 DB 一致撞键抛 P2002
      if (riskAlerts.some(a => a.dedupKey === data.dedupKey)) {
        const err: any = new Error('Unique constraint failed on the fields: (`dedupKey`)');
        err.code = 'P2002';
        throw err;
      }
      const row = { relatedType: null, relatedId: null, status: 'Open', resolvedAt: null, ...data, id: data.id || `RSKA__T${++seq}` };
      riskAlerts.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = riskAlerts.find(a => a.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const creditRating = {
    create: async ({ data }: any) => {
      const row = { evaluatedBy: null, ...data, id: data.id || `CDR__T${++seq}` };
      creditRatings.push(row);
      return row;
    },
    findMany: async ({ where, orderBy, take, skip, distinct }: any = {}) =>
      applyTakeSkip(applyDistinct(applyOrderBy(creditRatings.filter(r => matchWhere(r, where)), orderBy), distinct), take, skip),
  };

  const complianceCheck = {
    create: async ({ data }: any) => {
      const row = { details: null, checkedById: null, ...data, id: data.id || `CPC__T${++seq}` };
      complianceChecks.push(row);
      return row;
    },
    findMany: async ({ where, orderBy, take, skip }: any = {}) =>
      applyTakeSkip(applyOrderBy(complianceChecks.filter(r => matchWhere(r, where)), orderBy), take, skip),
    count: async ({ where }: any = {}) => complianceChecks.filter(r => matchWhere(r, where)).length,
  };

  const invoice = {
    findMany: async ({ where }: any = {}) => invoices.filter(i => matchWhere(i, where)),
  };

  const relation = {
    findUnique: async ({ where }: any) => relations.find(r => r.id === where.id) || null,
  };

  const order = {
    findUnique: async ({ where }: any) => orders.find(o => o.id === where.id) || null,
    findMany: async ({ where }: any = {}) => orders.filter(o => matchWhere(o, where)),
  };

  const creditLimitHistories: any[] = [];
  const auditLogs: any[] = [];
  const systemConfigs: any[] = [];
  const systemConfigHistories: any[] = [];

  const creditLimit = {
    findUnique: async ({ where }: any) => creditLimits.find(c => c.id === where.id) || null,
    findFirst: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(creditLimits.filter(c => matchWhere(c, where)), orderBy)[0] ?? null,
    findMany: async ({ where }: any = {}) => creditLimits.filter(c => matchWhere(c, where)),
    update: async ({ where, data }: any) => {
      const row = creditLimits.find(c => c.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const rows = creditLimits.filter(c => matchWhere(c, where));
      rows.forEach(r => Object.assign(r, data));
      return { count: rows.length };
    },
  };

  const creditLimitHistory = {
    create: async ({ data }: any) => {
      const row = { triggerId: null, triggerBy: null, remark: null, ...data, id: data.id || `CLHIST__T${++seq}` };
      creditLimitHistories.push(row);
      return row;
    },
  };

  const auditLog = {
    create: async ({ data }: any) => {
      const row = { ...data, id: data.id || `ALOG__T${++seq}` };
      auditLogs.push(row);
      return row;
    },
  };

  // SystemConfig（M7 禁运国清单）：id = `${scope}::${key}`，json 类型存字符串
  const systemConfig = {
    // 返回浅拷贝（Prisma 语义为脱离库的快照；service 侧 set 先读 existing 再 upsert 后读 existing.version 写 History）
    findUnique: async ({ where }: any) => {
      const found = systemConfigs.find(c => c.id === where.id);
      return found ? { ...found } : null;
    },
    upsert: async ({ where, create, update }: any) => {
      const existing = systemConfigs.find(c => c.id === where.id);
      if (existing) {
        for (const [k, v] of Object.entries(update)) {
          if (v !== undefined) (existing as any)[k] = v;
        }
        return existing;
      }
      const row = { ...create };
      systemConfigs.push(row);
      return row;
    },
  };

  const systemConfigHistory = {
    create: async ({ data }: any) => {
      const row = { ...data, id: data.id || `SCH__T${++seq}` };
      systemConfigHistories.push(row);
      return row;
    },
  };

  const customsDeclaration = {
    findUnique: async ({ where }: any) => customsDeclarations.find(d => d.id === where.id) || null,
  };

  const customsDeclarationLine = {
    findMany: async ({ where }: any = {}) => customsDeclarationLines.filter(l => matchWhere(l, where)),
  };

  const hsCode = {
    findUnique: async ({ where }: any) => hsCodes.find(h => h.code === where.code) || null,
    count: async ({ where }: any = {}) => (where ? hsCodes.filter(h => matchWhere(h, where)).length : hsCodes.length),
  };

  const inspectionReport = {
    findMany: async ({ where, take }: any = {}) =>
      applyTakeSkip(inspectionReports.filter(r => matchWhere(r, where)), take),
  };

  const prisma: any = {
    exchangeRate,
    fxRateLock,
    riskAlert,
    creditRating,
    complianceCheck,
    invoice,
    relation,
    order,
    creditLimit,
    creditLimitHistory,
    auditLog,
    systemConfig,
    systemConfigHistory,
    customsDeclaration,
    customsDeclarationLine,
    hsCode,
    inspectionReport,
    // credit 正规冻结通道（transitionLimits）在 $transaction 内执行：mock 直接复用同一对象
    $transaction: async (fn: any) => fn(prisma),
    _stores: {
      exchangeRates, fxRateLocks, riskAlerts, creditRatings, complianceChecks,
      invoices, relations, orders, creditLimits, creditLimitHistories, auditLogs,
      systemConfigs, systemConfigHistories, customsDeclarations,
      customsDeclarationLines, hsCodes, inspectionReports,
    },
  };
  return prisma;
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (req.headers.cookie) {
      const cookies: Record<string, string> = {};
      req.headers.cookie.split(';').forEach((c: string) => {
        const [k, v] = c.trim().split('=');
        cookies[k] = v;
      });
      req.cookies = cookies;
    }
    next();
  });
  app.use('/api/v1/risk', createRiskRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const auth = () => ({ Cookie: `bambook_token=${ownerToken}` });
const viewerAuth = () => ({ Cookie: `bambook_token=${viewerToken}` });

/** 相对今日的本地日期串（服务侧按真实今日计算，测试须同步口径） */
function dateDaysAgo(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function currentQuarter(): string {
  const d = new Date();
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

// ════════════════════════════════════════════════════════════════
// 汇率（PRD 15.1）
// ════════════════════════════════════════════════════════════════

describe('H3 · 汇率档案与波动预警', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  const addRate = (app: any, body: Record<string, any>) =>
    request(app).post('/api/v1/risk/fx-rates').set(auth()).send(body);

  it('录入校验：缺币种 / rate≤0 / 日期格式非法 → 400；币种归一化大写', async () => {
    const app = makeApp(prisma);
    expect((await addRate(app, { rate: 7.1 })).status).toBe(400);
    expect((await addRate(app, { currency: 'USD', rate: 0 })).status).toBe(400);
    expect((await addRate(app, { currency: 'USD', rate: -1 })).status).toBe(400);
    expect((await addRate(app, { currency: 'USD', rate: 7.1, effectiveDate: '2026/08/01' })).status).toBe(400);

    const ok = await addRate(app, { currency: 'usd', rate: 7.1, effectiveDate: '2026-08-01' });
    expect(ok.status).toBe(201);
    expect(ok.body.item.currency).toBe('USD');
    expect(ok.body.item.source).toBe('manual');
  });

  it('波动 ≥2% 触发 warning、≥5% 升 critical；同 dedupKey 幂等；<2% 不触发', async () => {
    const app = makeApp(prisma);
    await addRate(app, { currency: 'USD', rate: 7.10, effectiveDate: '2026-08-01' });

    // +2.11% → warning
    await addRate(app, { currency: 'USD', rate: 7.25, effectiveDate: '2026-08-02' });
    let alerts = await request(app).get('/api/v1/risk/alerts?type=fx_volatility').set(auth());
    expect(alerts.body.total).toBe(1);
    expect(alerts.body.items[0].level).toBe('warning');
    expect(alerts.body.items[0].title).toContain('USD');
    expect(alerts.body.items[0].dedupKey).toBe('fx_volatility:USD:2026-08-02');
    expect(alerts.body.items[0].status).toBe('Open');

    // 同 effectiveDate 再录入一条 -2.07% 的汇率：波动达阈值但 dedupKey 撞键 → 幂等不产生新预警
    await addRate(app, { currency: 'USD', rate: 7.10, effectiveDate: '2026-08-02' });
    alerts = await request(app).get('/api/v1/risk/alerts?type=fx_volatility').set(auth());
    expect(alerts.body.total).toBe(1);

    // +0.14% < 2% → 不触发
    await addRate(app, { currency: 'USD', rate: 7.11, effectiveDate: '2026-08-03' });
    alerts = await request(app).get('/api/v1/risk/alerts?type=fx_volatility').set(auth());
    expect(alerts.body.total).toBe(1);

    // -5.625% → critical
    await addRate(app, { currency: 'EUR', rate: 8.00, effectiveDate: '2026-08-01' });
    await addRate(app, { currency: 'EUR', rate: 7.55, effectiveDate: '2026-08-02' });
    alerts = await request(app).get('/api/v1/risk/alerts?type=fx_volatility').set(auth());
    expect(alerts.body.total).toBe(2);
    const critical = alerts.body.items.find((a: any) => a.level === 'critical');
    expect(critical.title).toContain('EUR');
  });

  it('GET /fx-rates 按币种过滤（大小写不敏感）；GET /fx-rates-latest 各币种取最新一条', async () => {
    const app = makeApp(prisma);
    await addRate(app, { currency: 'USD', rate: 7.10, effectiveDate: '2026-08-01' });
    await addRate(app, { currency: 'USD', rate: 7.20, effectiveDate: '2026-08-05' });
    await addRate(app, { currency: 'EUR', rate: 8.30, effectiveDate: '2026-08-03' });

    const usd = await request(app).get('/api/v1/risk/fx-rates?currency=usd').set(auth());
    expect(usd.body.total).toBe(2);
    expect(usd.body.items[0].effectiveDate).toBe('2026-08-05'); // effectiveDate 降序

    const latest = await request(app).get('/api/v1/risk/fx-rates-latest').set(auth());
    expect(latest.body.total).toBe(2);
    expect(latest.body.items[0].currency).toBe('EUR'); // 按币种排序
    expect(latest.body.items[0].rate).toBe(8.30);
    expect(latest.body.items[1].currency).toBe('USD');
    expect(latest.body.items[1].rate).toBe(7.20);
    expect(latest.body.items[1].effectiveDate).toBe('2026-08-05');
  });

  it('写操作仅 API-Key → 401（JWT 强制）', async () => {
    const app = makeApp(prisma);
    const res = await request(app)
      .post('/api/v1/risk/fx-rates')
      .set('x-bambook-api-key', validApiKey)
      .send({ currency: 'USD', rate: 7.1 });
    expect(res.status).toBe(401);
    // W-C 批三-E：读面已挂 risk:read scope 门（requirePermission 需 JWT actor），
    // API-Key 无身份 → 401（旧「读可走 API-Key」契约随 scope 门收口关闭）
    const read = await request(app).get('/api/v1/risk/fx-rates').set('x-bambook-api-key', validApiKey);
    expect(read.status).toBe(401);
  });
});

describe('H3 · 汇率锁定', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._stores.orders.push({ id: 'O1', customer: 'Alpha', status: 'Confirmed', millRelationId: 'FAC1', deletedAt: null });
  });

  it('缺省取最新汇率；无汇率 → 400；重复锁定 → 400；软删后可重新锁定', async () => {
    const app = makeApp(prisma);

    // 无可用汇率
    const noRate = await request(app).post('/api/v1/risk/fx-locks').set(auth()).send({ orderId: 'O1', currency: 'USD' });
    expect(noRate.status).toBe(400);
    expect(noRate.body.error.message).toContain('无可用汇率');

    await request(app).post('/api/v1/risk/fx-rates').set(auth()).send({ currency: 'USD', rate: 7.10, effectiveDate: '2026-08-01' });
    await request(app).post('/api/v1/risk/fx-rates').set(auth()).send({ currency: 'USD', rate: 7.22, effectiveDate: '2026-08-06' });

    // 缺省取最新（7.22 @ 08-06）
    const locked = await request(app).post('/api/v1/risk/fx-locks').set(auth()).send({ orderId: 'O1', currency: 'usd' });
    expect(locked.status).toBe(201);
    expect(locked.body.item.rate).toBe(7.22);
    expect(locked.body.item.currency).toBe('USD');
    expect(locked.body.item.lockedById).toBe('u1');

    // 同订单同币种重复锁定 → 400
    const dup = await request(app).post('/api/v1/risk/fx-locks').set(auth()).send({ orderId: 'O1', currency: 'USD' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('已锁定汇率');

    // 显式汇率锁定另一币种
    const eur = await request(app).post('/api/v1/risk/fx-locks').set(auth()).send({ orderId: 'O1', currency: 'EUR', rate: 7.8 });
    expect(eur.status).toBe(201);
    expect(eur.body.item.rate).toBe(7.8);

    const list = await request(app).get('/api/v1/risk/fx-locks?orderId=O1').set(auth());
    expect(list.body.total).toBe(2);

    // 软删后可重新锁定
    const del = await request(app).delete(`/api/v1/risk/fx-locks/${locked.body.item.id}`).set(auth());
    expect(del.status).toBe(200);
    const after = await request(app).get('/api/v1/risk/fx-locks?orderId=O1').set(auth());
    expect(after.body.total).toBe(1);
    const relock = await request(app).post('/api/v1/risk/fx-locks').set(auth()).send({ orderId: 'O1', currency: 'USD' });
    expect(relock.status).toBe(201);

    // 删除不存在 → 404
    const delGone = await request(app).delete('/api/v1/risk/fx-locks/FXL__NOPE').set(auth());
    expect(delGone.status).toBe(404);
  });

  it('订单不存在 → 404', async () => {
    const app = makeApp(prisma);
    const res = await request(app).post('/api/v1/risk/fx-locks').set(auth()).send({ orderId: 'O_GONE', currency: 'USD', rate: 7.1 });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('订单不存在');
  });
});

// ════════════════════════════════════════════════════════════════
// 信用（PRD 15.2）
// ════════════════════════════════════════════════════════════════

describe('H3 · 信用评级', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._stores.relations.push(
      { id: 'REL_C1', name: '客户A', category: 'Customer', isOrganization: true, deletedAt: null },
      { id: 'REL_C2', name: '客户B', category: 'Customer', isOrganization: true, deletedAt: null },
      { id: 'REL_S1', name: '供应商C', category: 'Supplier', isOrganization: true, deletedAt: null },
    );
  });

  it('因子口径：onTimeRate / 当前逾期扣分 / 合作年限；grade 边界 70→B', async () => {
    const app = makeApp(prisma);
    prisma._stores.invoices.push(
      // 准时结清（结算日 375 天前 ≤ 到期日 370 天前）
      { id: 'INV1', invoiceNumber: 'INV-1', type: 'Receivable', status: 'Paid', amount: 100, currency: 'USD', issueDate: dateDaysAgo(400), dueDate: dateDaysAgo(370), settlementDate: dateDaysAgo(375), customerRelationId: 'REL_C1', deletedAt: null },
      // 逾期结清（结算日 160 天前 > 到期日 170 天前）
      { id: 'INV2', invoiceNumber: 'INV-2', type: 'Receivable', status: 'Paid', amount: 100, currency: 'USD', issueDate: dateDaysAgo(200), dueDate: dateDaysAgo(170), settlementDate: dateDaysAgo(160), customerRelationId: 'REL_C1', deletedAt: null },
      // 当前逾期 10 天
      { id: 'INV3', invoiceNumber: 'INV-3', type: 'Receivable', status: 'Issued', amount: 100, currency: 'USD', issueDate: dateDaysAgo(100), dueDate: dateDaysAgo(10), settlementDate: null, customerRelationId: 'REL_C1', deletedAt: null },
      // 已软删不计入
      { id: 'INV4', invoiceNumber: 'INV-4', type: 'Receivable', status: 'Issued', amount: 999, currency: 'USD', issueDate: dateDaysAgo(500), dueDate: dateDaysAgo(400), settlementDate: null, customerRelationId: 'REL_C1', deletedAt: BigInt(Date.now()) },
      // 其他客户不计入（REL_OTHER 不参与本测试评估）
      { id: 'INV5', invoiceNumber: 'INV-5', type: 'Receivable', status: 'Issued', amount: 100, currency: 'USD', issueDate: dateDaysAgo(100), dueDate: dateDaysAgo(90), settlementDate: null, customerRelationId: 'REL_OTHER', deletedAt: null },
    );

    const res = await request(app).post('/api/v1/risk/credit-ratings/evaluate').set(auth()).send({ relationId: 'REL_C1' });
    expect(res.status).toBe(201);
    const r = res.body.item;
    // onTimeRate = 1/2 → -20；当前逾期 1 张 → -10；合作 ≈1.1 年不扣 → 70 → B
    expect(r.score).toBe(70);
    expect(r.grade).toBe('B');
    expect(r.factors.onTimeRate).toBe(0.5);
    expect(r.factors.overdueCount).toBe(1);
    expect(r.factors.maxDaysOverdue).toBe(10);
    expect(r.factors.settledCount).toBe(2);
    expect(r.factors.evaluatedBy).toBe('u1');

    // 无发票客户：onTimeRate=null，仅合作 <1 年 -5 → 95 → A
    const res2 = await request(app).post('/api/v1/risk/credit-ratings/evaluate').set(auth()).send({ relationId: 'REL_C2' });
    expect(res2.body.item.score).toBe(95);
    expect(res2.body.item.grade).toBe('A');
    expect(res2.body.item.factors.onTimeRate).toBeNull();

    // latestOnly 每客户取最新
    const latest = await request(app).get('/api/v1/risk/credit-ratings?latestOnly=true').set(auth());
    expect(latest.body.total).toBe(2);
    const byRel = latest.body.items.map((i: any) => i.relationId).sort();
    expect(byRel).toEqual(['REL_C1', 'REL_C2']);
    const c1Only = await request(app).get('/api/v1/risk/credit-ratings?relationId=REL_C1').set(auth());
    expect(c1Only.body.total).toBe(1);
  });

  it('非 Customer / 不存在 → 400 / 404', async () => {
    const app = makeApp(prisma);
    const sup = await request(app).post('/api/v1/risk/credit-ratings/evaluate').set(auth()).send({ relationId: 'REL_S1' });
    expect(sup.status).toBe(400);
    expect(sup.body.error.message).toContain('仅 category=Customer');
    const gone = await request(app).post('/api/v1/risk/credit-ratings/evaluate').set(auth()).send({ relationId: 'REL_GONE' });
    expect(gone.status).toBe(404);
  });
});

describe('H3 · 信用风险扫描', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._stores.creditLimits.push(
      { id: 'CL_1', relationId: 'REL_C1', totalLimit: 100000, usedAmount: 0, currency: 'CNY', status: 'Active', deletedAt: null },
      { id: 'CL_2', relationId: 'REL_C1', totalLimit: 50000, usedAmount: 0, currency: 'CNY', status: 'Active', deletedAt: null },
      { id: 'CL_3', relationId: 'REL_C2', totalLimit: 80000, usedAmount: 0, currency: 'CNY', status: 'Active', deletedAt: null },
    );
    prisma._stores.invoices.push(
      // REL_C1：逾期 70 天（>60 → 冻结其全部 Active 额度）
      { id: 'INV_A', invoiceNumber: 'INV-A', type: 'Receivable', status: 'Issued', amount: 1000, currency: 'USD', issueDate: dateDaysAgo(100), dueDate: dateDaysAgo(70), settlementDate: null, customerRelationId: 'REL_C1', deletedAt: null },
      // REL_C1：逾期 200 天（>180 → 坏账预警）
      { id: 'INV_B', invoiceNumber: 'INV-B', type: 'Receivable', status: 'PartiallyPaid', amount: 2000, currency: 'USD', issueDate: dateDaysAgo(230), dueDate: dateDaysAgo(200), settlementDate: null, customerRelationId: 'REL_C1', deletedAt: null },
      // REL_C2：逾期 30 天（未达阈值）
      { id: 'INV_C', invoiceNumber: 'INV-C', type: 'Receivable', status: 'Issued', amount: 500, currency: 'USD', issueDate: dateDaysAgo(60), dueDate: dateDaysAgo(30), settlementDate: null, customerRelationId: 'REL_C2', deletedAt: null },
      // 已结清/已软删不参与
      { id: 'INV_D', invoiceNumber: 'INV-D', type: 'Receivable', status: 'Paid', amount: 1, currency: 'USD', issueDate: dateDaysAgo(300), dueDate: dateDaysAgo(250), settlementDate: dateDaysAgo(260), customerRelationId: 'REL_C2', deletedAt: null },
      { id: 'INV_E', invoiceNumber: 'INV-E', type: 'Receivable', status: 'Issued', amount: 1, currency: 'USD', issueDate: dateDaysAgo(300), dueDate: dateDaysAgo(250), settlementDate: null, customerRelationId: 'REL_C2', deletedAt: BigInt(Date.now()) },
    );
  });

  it('逾期 >60 天冻结 Active 额度 + credit_frozen 预警；>180 天 bad_debt；重复扫描幂等', async () => {
    const app = makeApp(prisma);
    const res = await request(app).post('/api/v1/risk/credit-risk-scan').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, frozenCount: 2, badDebtCount: 1 });

    const stores = prisma._stores;
    expect(stores.creditLimits.find((c: any) => c.id === 'CL_1').status).toBe('Frozen');
    expect(stores.creditLimits.find((c: any) => c.id === 'CL_2').status).toBe('Frozen');
    expect(stores.creditLimits.find((c: any) => c.id === 'CL_3').status).toBe('Active');

    const frozen = await request(app).get('/api/v1/risk/alerts?type=credit_frozen').set(auth());
    expect(frozen.body.total).toBe(2);
    expect(frozen.body.items[0].level).toBe('critical');
    const badDebt = await request(app).get('/api/v1/risk/alerts?type=bad_debt').set(auth());
    expect(badDebt.body.total).toBe(1);
    expect(badDebt.body.items[0].dedupKey).toBe('bad_debt:INV_B');
    expect(badDebt.body.items[0].relatedType).toBe('Invoice');

    // 幂等：额度已 Frozen 不再重复冻结；bad_debt dedupKey 唯一不重复预警
    const again = await request(app).post('/api/v1/risk/credit-risk-scan').set(auth());
    expect(again.body).toMatchObject({ ok: true, frozenCount: 0, badDebtCount: 0 });
    const allAlerts = await request(app).get('/api/v1/risk/alerts').set(auth());
    expect(allAlerts.body.total).toBe(3);
  });

  it('M1：冻结走信用模块正规通道（frozenBy=system_credit_scan + CreditLimitHistory + AuditLog 审计理由）', async () => {
    const app = makeApp(prisma);
    const res = await request(app).post('/api/v1/risk/credit-risk-scan').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.frozenCount).toBe(2);

    const stores = prisma._stores;
    // 正规通道标记：信用模块自动解冻仅认 frozenBy=system_credit_scan 的冻结（M1 修复核心）
    for (const id of ['CL_1', 'CL_2']) {
      const cl = stores.creditLimits.find((c: any) => c.id === id);
      expect(cl.status).toBe('Frozen');
      expect(cl.frozenBy).toBe('system_credit_scan');
      expect(cl.frozenAt).toBeInstanceOf(Date);
    }

    // CreditLimitHistory：每条被冻额度一行 credit_freeze（delta=0，理由含逾期天数）
    const histories = stores.creditLimitHistories.filter((h: any) => h.triggerType === 'credit_freeze');
    expect(histories).toHaveLength(2);
    expect(histories.map((h: any) => h.creditLimitId).sort()).toEqual(['CL_1', 'CL_2']);
    expect(histories[0].triggerBy).toBe('system_credit_scan');
    expect(histories[0].delta).toBe(0);
    expect(histories[0].remark).toContain('60 天逾期规则自动冻结');
    expect(histories[0].remark).toContain('200'); // REL_C1 最大逾期 200 天

    // AuditLog：字段级审计（status Active→Frozen + 理由）
    const audits = stores.auditLogs.filter((a: any) => a.action === 'credit:60d-overdue-freeze');
    expect(audits).toHaveLength(2);
    expect(audits[0].actorId).toBe('system_credit_scan');
    expect(audits[0].targetType).toBe('CreditLimit');
    expect(audits[0].afterValue).toBe('Frozen');

    // 幂等：正规通道已 Frozen 不重复写历史/审计
    await request(app).post('/api/v1/risk/credit-risk-scan').set(auth());
    expect(stores.creditLimitHistories.filter((h: any) => h.triggerType === 'credit_freeze')).toHaveLength(2);
    expect(stores.auditLogs.filter((a: any) => a.action === 'credit:60d-overdue-freeze')).toHaveLength(2);
  });

  it('viewer 角色触发扫描 → 403（owner/admin/manager 专属）', async () => {
    const app = makeApp(prisma);
    const res = await request(app).post('/api/v1/risk/credit-risk-scan').set(viewerAuth());
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════
// 合规（PRD 15.3）
// ════════════════════════════════════════════════════════════════

describe('H3 · HS Code 校验', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._stores.customsDeclarations.push(
      { id: 'CD_1', declarationNumber: 'D-1', destinationCountry: 'US', deletedAt: null },
      { id: 'CD_2', declarationNumber: 'D-2', destinationCountry: 'DE', deletedAt: null },
      { id: 'CD_3', declarationNumber: 'D-3', destinationCountry: 'JP', deletedAt: null },
    );
    prisma._stores.customsDeclarationLines.push(
      // CD_1：两种可接受格式 → pass
      { id: 'CDL_1', declarationId: 'CD_1', lineNumber: 1, productName: '棉织物', hsCode: '5208.52' },
      { id: 'CDL_2', declarationId: 'CD_1', lineNumber: 2, productName: '化纤织物', hsCode: '5208520000' },
      // CD_2：缺失 + 格式非法 → fail
      { id: 'CDL_3', declarationId: 'CD_2', lineNumber: 1, productName: '无编码商品', hsCode: null },
      { id: 'CDL_4', declarationId: 'CD_2', lineNumber: 2, productName: '坏编码商品', hsCode: 'ABC' },
      // CD_3：注册表有 5208.52；6204.62 格式合法但未注册 → warn
      { id: 'CDL_5', declarationId: 'CD_3', lineNumber: 1, productName: '棉织物', hsCode: '5208.52' },
      { id: 'CDL_6', declarationId: 'CD_3', lineNumber: 2, productName: '女裤', hsCode: '6204.62' },
    );
  });

  it('pass / fail / warn 三分支 + fail 触发 compliance_fail 预警', async () => {
    const app = makeApp(prisma);

    // 注册表为空 → 跳过注册检查 → 全部通过
    const pass = await request(app).post('/api/v1/risk/compliance-checks/hs-code').set(auth()).send({ declarationId: 'CD_1' });
    expect(pass.status).toBe(201);
    expect(pass.body.item.result).toBe('pass');
    expect(pass.body.item.summary).toBe('2 行全部通过');
    expect(pass.body.item.type).toBe('hs_code');
    expect(pass.body.item.targetType).toBe('CustomsDeclaration');

    // 缺失 + 非法 → fail + 预警
    const fail = await request(app).post('/api/v1/risk/compliance-checks/hs-code').set(auth()).send({ declarationId: 'CD_2' });
    expect(fail.body.item.result).toBe('fail');
    expect(fail.body.item.summary).toContain('1 行缺失 HS 编码');
    expect(fail.body.item.summary).toContain('1 行 HS 编码格式非法');
    expect(fail.body.item.details.lines).toHaveLength(2);
    const failAlerts = await request(app).get('/api/v1/risk/alerts?type=compliance_fail').set(auth());
    expect(failAlerts.body.total).toBe(1);
    expect(failAlerts.body.items[0].level).toBe('warning');

    // 注册表非空 + 未注册编码 → warn（未注册不代表非法）
    prisma._stores.hsCodes.push({ id: 'HS_1', code: '5208.52', description: '棉织物', isActive: true });
    const warn = await request(app).post('/api/v1/risk/compliance-checks/hs-code').set(auth()).send({ declarationId: 'CD_3' });
    expect(warn.body.item.result).toBe('warn');
    expect(warn.body.item.summary).toContain('1 行 HS 编码未注册');
    // warn 不产生预警
    const afterWarn = await request(app).get('/api/v1/risk/alerts?type=compliance_fail').set(auth());
    expect(afterWarn.body.total).toBe(1);

    // 报关单不存在 → 404
    const gone = await request(app).post('/api/v1/risk/compliance-checks/hs-code').set(auth()).send({ declarationId: 'CD_GONE' });
    expect(gone.status).toBe(404);

    // 列表按 checkedAt 降序
    const list = await request(app).get('/api/v1/risk/compliance-checks?type=hs_code').set(auth());
    expect(list.body.total).toBe(3);
  });
});

describe('H3 · 出口管制与人工合规录入', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._stores.customsDeclarations.push(
      { id: 'CD_KP', declarationNumber: 'D-KP', destinationCountry: 'KP', deletedAt: null },
      { id: 'CD_IR', declarationNumber: 'D-IR', destinationCountry: 'Iran', deletedAt: null },
      { id: 'CD_NULL', declarationNumber: 'D-NULL', destinationCountry: null, deletedAt: null },
      { id: 'CD_US', declarationNumber: 'D-US', destinationCountry: 'US', deletedAt: null },
    );
  });

  it('禁运国（ISO 码 / 英文名不敏感）→ fail + critical 预警；空目的国 → warn；其他 → pass', async () => {
    const app = makeApp(prisma);

    const kp = await request(app).post('/api/v1/risk/compliance-checks/export-control').set(auth()).send({ declarationId: 'CD_KP' });
    expect(kp.body.item.result).toBe('fail');
    expect(kp.body.item.summary).toContain('KP');

    const ir = await request(app).post('/api/v1/risk/compliance-checks/export-control').set(auth()).send({ declarationId: 'CD_IR' });
    expect(ir.body.item.result).toBe('fail');

    const alerts = await request(app).get('/api/v1/risk/alerts?type=compliance_fail&level=critical').set(auth());
    expect(alerts.body.total).toBe(2);

    const empty = await request(app).post('/api/v1/risk/compliance-checks/export-control').set(auth()).send({ declarationId: 'CD_NULL' });
    expect(empty.body.item.result).toBe('warn');
    expect(empty.body.item.summary).toContain('无法判定');

    const us = await request(app).post('/api/v1/risk/compliance-checks/export-control').set(auth()).send({ declarationId: 'CD_US' });
    expect(us.body.item.result).toBe('pass');

    const list = await request(app).get('/api/v1/risk/compliance-checks?type=export_control&result=fail').set(auth());
    expect(list.body.total).toBe(2);
  });

  it('人工录入 origin_rule：封闭集校验（type/result）', async () => {
    const app = makeApp(prisma);
    const badType = await request(app).post('/api/v1/risk/compliance-checks').set(auth()).send({
      type: 'hack', targetType: 'Order', targetId: 'O1', result: 'pass', summary: 'x',
    });
    expect(badType.status).toBe(400);
    const badResult = await request(app).post('/api/v1/risk/compliance-checks').set(auth()).send({
      type: 'origin_rule', targetType: 'Order', targetId: 'O1', result: 'maybe', summary: 'x',
    });
    expect(badResult.status).toBe(400);

    const ok = await request(app).post('/api/v1/risk/compliance-checks').set(auth()).send({
      type: 'origin_rule', targetType: 'Order', targetId: 'O1', result: 'pass',
      summary: '原产地证书已核验', details: { certificateNo: 'CO-2026-001' },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.item.type).toBe('origin_rule');
    expect(ok.body.item.checkedById).toBe('u1');
  });

  it('R678 合规记录分页：limit/offset 透传服务端，total 为全量计数（翻页不重叠、越界空页 total 不变）', async () => {
    const app = makeApp(prisma);
    for (let i = 1; i <= 5; i++) {
      const res = await request(app).post('/api/v1/risk/compliance-checks').set(auth()).send({
        type: 'origin_rule', targetType: 'Order', targetId: `O${i}`, result: 'pass', summary: `记录 ${i}`,
      });
      expect(res.status).toBe(201);
    }

    const page1 = await request(app).get('/api/v1/risk/compliance-checks?type=origin_rule&limit=2').set(auth());
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(5);
    expect(page1.body.items).toHaveLength(2);

    const page2 = await request(app).get('/api/v1/risk/compliance-checks?type=origin_rule&limit=2&offset=2').set(auth());
    expect(page2.body.total).toBe(5);
    expect(page2.body.items).toHaveLength(2);
    const page1Ids = new Set(page1.body.items.map((c: any) => c.id));
    expect(page2.body.items.every((c: any) => !page1Ids.has(c.id))).toBe(true);

    // offset 越过末尾：空页但 total 仍为全量
    const tail = await request(app).get('/api/v1/risk/compliance-checks?type=origin_rule&limit=2&offset=4').set(auth());
    expect(tail.body.items).toHaveLength(1);
    expect(tail.body.total).toBe(5);

    // 不传 offset 行为不变（默认 0）：首页与显式 offset=0 等价
    const explicit0 = await request(app).get('/api/v1/risk/compliance-checks?type=origin_rule&limit=2&offset=0').set(auth());
    expect(explicit0.body.items.map((c: any) => c.id)).toEqual(page1.body.items.map((c: any) => c.id));
  });
});

// ════════════════════════════════════════════════════════════════
// M7 · 禁运国清单可配置（SystemConfig 数据库真源）
// ════════════════════════════════════════════════════════════════

describe('M7 · 禁运国清单配置', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._stores.customsDeclarations.push(
      { id: 'CD_KP', declarationNumber: 'D-KP', destinationCountry: 'KP', deletedAt: null },
      { id: 'CD_XX', declarationNumber: 'D-XX', destinationCountry: 'XX', deletedAt: null },
    );
  });

  it('未配置 → GET 返回内置默认清单（source=default）', async () => {
    const app = makeApp(prisma);
    const res = await request(app).get('/api/v1/risk/sanctioned-countries').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.source).toBe('default');
    expect(res.body.items).toContain('KP');
    expect(res.body.items).toContain('IR');
  });

  it('PUT 配置生效（source=config，trim/去重）；出口管制检查改用配置清单；二次 PUT 落 SystemConfigHistory 审计', async () => {
    const app = makeApp(prisma);

    const put = await request(app).put('/api/v1/risk/sanctioned-countries').set(auth()).send({
      items: ['XX', ' yy ', 'YY'], // 去重（大小写不敏感）+ trim
      reason: '政策更新：新增 XX 禁运',
    });
    expect(put.status).toBe(200);
    expect(put.body.source).toBe('config');
    expect(put.body.items).toEqual(['XX', 'yy']);

    const get = await request(app).get('/api/v1/risk/sanctioned-countries').set(auth());
    expect(get.body.source).toBe('config');
    expect(get.body.items).toEqual(['XX', 'yy']);

    // 出口管制检查即时生效：XX 命中（新增禁运），KP 不再命中（配置覆盖默认）
    const xx = await request(app).post('/api/v1/risk/compliance-checks/export-control').set(auth()).send({ declarationId: 'CD_XX' });
    expect(xx.body.item.result).toBe('fail');
    expect(xx.body.item.details.sanctionedSource).toBe('config');
    const kp = await request(app).post('/api/v1/risk/compliance-checks/export-control').set(auth()).send({ declarationId: 'CD_KP' });
    expect(kp.body.item.result).toBe('pass');

    // 二次 PUT：更新既有配置 → SystemConfigHistory 留痕（versionFrom→To + actor + reason）
    const put2 = await request(app).put('/api/v1/risk/sanctioned-countries').set(auth()).send({
      items: ['XX'],
      reason: '移除 yy',
    });
    expect(put2.status).toBe(200);
    expect(put2.body.items).toEqual(['XX']);
    const histories = prisma._stores.systemConfigHistories;
    expect(histories).toHaveLength(1);
    expect(histories[0].versionFrom).toBe(1);
    expect(histories[0].versionTo).toBe(2);
    expect(histories[0].actorId).toBe('u1');
    expect(histories[0].reason).toBe('移除 yy');
  });

  it('PUT 校验：空数组 / 非字符串条目 → 400；viewer → 403', async () => {
    const app = makeApp(prisma);
    const empty = await request(app).put('/api/v1/risk/sanctioned-countries').set(auth()).send({ items: [] });
    expect(empty.status).toBe(400);
    const badItem = await request(app).put('/api/v1/risk/sanctioned-countries').set(auth()).send({ items: ['KP', 42] });
    expect(badItem.status).toBe(400);
    const viewer = await request(app).put('/api/v1/risk/sanctioned-countries').set(viewerAuth()).send({ items: ['KP'] });
    expect(viewer.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════
// 质量（PRD 15.4）
// ════════════════════════════════════════════════════════════════

describe('H3 · 疵点趋势', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._stores.orders.push(
      { id: 'O1', millRelationId: 'FAC1', deletedAt: null },
      { id: 'O2', millRelationId: 'FAC1', deletedAt: null },
      { id: 'O3', millRelationId: null, deletedAt: null },
      // 已软删订单视同未关联
      { id: 'O4', millRelationId: 'FAC9', deletedAt: BigInt(Date.now()) },
    );
    prisma._stores.inspectionReports.push(
      { id: 'R1', orderId: 'O1', inspectionType: 'final', result: 'fail', criticalDefects: 1, majorDefects: 2, minorDefects: 3, defectSummary: '跳线x3 污渍x2', inspectionDate: '2026-07-15' },
      { id: 'R2', orderId: 'O2', inspectionType: 'final', result: 'pass', criticalDefects: 0, majorDefects: 1, minorDefects: 1, defectSummary: '跳线x1，色花 x 2', inspectionDate: '2026-08-01' },
      { id: 'R3', orderId: 'O3', inspectionType: 'midline', result: 'conditional', criticalDefects: 0, majorDefects: 1, minorDefects: 0, defectSummary: '污渍x1', inspectionDate: '2026-04-10' },
      { id: 'R4', orderId: 'O4', inspectionType: 'final', result: 'fail', criticalDefects: 0, majorDefects: 5, minorDefects: 0, defectSummary: null, inspectionDate: null },
      { id: 'R5', orderId: 'O_GONE', inspectionType: 'final', result: 'pass', criticalDefects: 0, majorDefects: 0, minorDefects: 2, defectSummary: '断经x2', inspectionDate: '2026-05-20' },
    );
  });

  it('groupBy=factory：聚合疵点计数与高频词（去数量缀）；null/软删订单归入未关联工厂', async () => {
    const app = makeApp(prisma);
    const res = await request(app).get('/api/v1/risk/quality/defect-trends?groupBy=factory').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.groupBy).toBe('factory');
    expect(res.body.items).toHaveLength(2);

    // 按 reports 降序：未关联工厂（R3/R4/R5）在前
    const unlinked = res.body.items[0];
    expect(unlinked.factoryId).toBeNull();
    expect(unlinked.factoryLabel).toBe('未关联工厂');
    expect(unlinked.reports).toBe(3);
    expect(unlinked.failCount).toBe(1); // 仅 R4 fail
    expect(unlinked.majorDefects).toBe(6);

    const fac1 = res.body.items[1];
    expect(fac1.factoryId).toBe('FAC1');
    expect(fac1.reports).toBe(2);
    expect(fac1.failCount).toBe(1);
    expect(fac1.criticalDefects).toBe(1);
    expect(fac1.majorDefects).toBe(3);
    expect(fac1.minorDefects).toBe(4);
    // 疵点词解析：跳线x3→跳线、跳线x1→跳线（计数 2）；色花 x 2→色花（带空格数量缀）
    expect(fac1.defectKeywords[0]).toEqual({ keyword: '跳线', count: 2 });
    const keywords = fac1.defectKeywords.map((k: any) => k.keyword);
    expect(keywords).toContain('色花');
    expect(keywords).toContain('污渍');
    expect(keywords).not.toContain('x');
  });

  it('groupBy=quarter：按 YYYY-Q 聚合，inspectionDate 缺失的行跳过', async () => {
    const app = makeApp(prisma);
    const res = await request(app).get('/api/v1/risk/quality/defect-trends?groupBy=quarter').set(auth());
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].quarter).toBe('2026-Q2'); // 升序
    expect(res.body.items[0].reports).toBe(2); // R3 + R5
    expect(res.body.items[1].quarter).toBe('2026-Q3');
    expect(res.body.items[1].reports).toBe(2); // R1 + R2（R4 无 inspectionDate 跳过）
  });
});

describe('H3 · 重复疵点扫描', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._stores.orders.push(
      { id: 'O1', millRelationId: 'FAC1', deletedAt: null },
      { id: 'O2', millRelationId: 'FAC1', deletedAt: null },
      { id: 'O3', millRelationId: 'FAC2', deletedAt: null },
      { id: 'O4', millRelationId: null, deletedAt: null },
    );
    prisma._stores.inspectionReports.push(
      // FAC1 跳线 ×2 张 → 预警
      { id: 'R1', orderId: 'O1', result: 'fail', criticalDefects: 0, majorDefects: 2, minorDefects: 0, defectSummary: '跳线x2 污渍x1', inspectionDate: dateDaysAgo(10) },
      { id: 'R2', orderId: 'O2', result: 'pass', criticalDefects: 0, majorDefects: 1, minorDefects: 0, defectSummary: '跳线x1', inspectionDate: dateDaysAgo(5) },
      // FAC2 跳线仅 1 张 → 不预警（跨工厂不合并）
      { id: 'R3', orderId: 'O3', result: 'pass', criticalDefects: 0, majorDefects: 1, minorDefects: 0, defectSummary: '跳线x4', inspectionDate: dateDaysAgo(3) },
      // 未关联工厂 破洞 ×2 张 → 预警
      { id: 'R4', orderId: 'O4', result: 'fail', criticalDefects: 1, majorDefects: 0, minorDefects: 0, defectSummary: '破洞x1', inspectionDate: dateDaysAgo(2) },
      { id: 'R5', orderId: 'O_GONE', result: 'fail', criticalDefects: 1, majorDefects: 0, minorDefects: 0, defectSummary: '破洞x3', inspectionDate: dateDaysAgo(1) },
      // 90 天窗口外的同词报告 → 被 DB 过滤不预警
      { id: 'R6', orderId: 'O1', result: 'fail', criticalDefects: 0, majorDefects: 1, minorDefects: 0, defectSummary: '旧疵x9', inspectionDate: dateDaysAgo(120) },
      { id: 'R7', orderId: 'O2', result: 'fail', criticalDefects: 0, majorDefects: 1, minorDefects: 0, defectSummary: '旧疵x1', inspectionDate: dateDaysAgo(100) },
    );
  });

  it('近 90 天同工厂同疵点 ≥2 张报告 → 预警；重复扫描幂等', async () => {
    const app = makeApp(prisma);
    const res = await request(app).post('/api/v1/risk/quality/repeat-scan').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, alerted: 2 });

    const alerts = await request(app).get('/api/v1/risk/alerts?type=quality_repeat').set(auth());
    expect(alerts.body.total).toBe(2);
    const keys = alerts.body.items.map((a: any) => a.dedupKey).sort();
    expect(keys).toEqual([
      `quality_repeat:FAC1:跳线:${currentQuarter()}`,
      `quality_repeat:unlinked:破洞:${currentQuarter()}`,
    ]);
    const fac1Alert = alerts.body.items.find((a: any) => a.relatedId === 'FAC1');
    expect(fac1Alert.relatedType).toBe('Relation');
    expect(fac1Alert.level).toBe('warning');

    // 幂等：dedupKey 含季度，季度内重复扫描不再产生新预警
    const again = await request(app).post('/api/v1/risk/quality/repeat-scan').set(auth());
    expect(again.body).toMatchObject({ ok: true, alerted: 0 });
  });
});

// ════════════════════════════════════════════════════════════════
// 统一预警状态机
// ════════════════════════════════════════════════════════════════

describe('H3 · 预警状态机与总览', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  async function seedFxAlert(app: any) {
    await request(app).post('/api/v1/risk/fx-rates').set(auth()).send({ currency: 'USD', rate: 7.10, effectiveDate: '2026-08-01' });
    await request(app).post('/api/v1/risk/fx-rates').set(auth()).send({ currency: 'USD', rate: 7.25, effectiveDate: '2026-08-02' });
    const alerts = await request(app).get('/api/v1/risk/alerts').set(auth());
    return alerts.body.items[0];
  }

  it('Open → Acknowledged → Resolved；Resolved 写 resolvedAt；非法状态 400；不存在 404', async () => {
    const app = makeApp(prisma);
    const alert = await seedFxAlert(app);
    expect(alert.status).toBe('Open');

    const ack = await request(app).patch(`/api/v1/risk/alerts/${alert.id}`).set(auth()).send({ status: 'Acknowledged' });
    expect(ack.status).toBe(200);
    expect(ack.body.item.status).toBe('Acknowledged');
    expect(ack.body.item.resolvedAt).toBeNull();

    const resolved = await request(app).patch(`/api/v1/risk/alerts/${alert.id}`).set(auth()).send({ status: 'Resolved' });
    expect(resolved.body.item.status).toBe('Resolved');
    expect(resolved.body.item.resolvedAt).toBeGreaterThan(0);

    const bad = await request(app).patch(`/api/v1/risk/alerts/${alert.id}`).set(auth()).send({ status: 'Closed' });
    expect(bad.status).toBe(400);
    const gone = await request(app).patch('/api/v1/risk/alerts/RSKA__NOPE').set(auth()).send({ status: 'Resolved' });
    expect(gone.status).toBe(404);

    // overview：Resolved 后不再计入 Open
    const overview = await request(app).get('/api/v1/risk/overview').set(auth());
    expect(overview.body.openByType.fx_volatility).toBeUndefined();
    expect(overview.body.recent).toHaveLength(0);
  });

  it('overview 按类型/级别聚合 Open 预警，recent 取最近 10 条', async () => {
    const app = makeApp(prisma);
    await seedFxAlert(app); // USD warning
    await request(app).post('/api/v1/risk/fx-rates').set(auth()).send({ currency: 'EUR', rate: 8.0, effectiveDate: '2026-08-01' });
    await request(app).post('/api/v1/risk/fx-rates').set(auth()).send({ currency: 'EUR', rate: 7.5, effectiveDate: '2026-08-02' }); // -6.25% critical

    const overview = await request(app).get('/api/v1/risk/overview').set(auth());
    expect(overview.body.openByType).toEqual({ fx_volatility: 2 });
    expect(overview.body.openByLevel).toEqual({ warning: 1, critical: 1 });
    expect(overview.body.recent).toHaveLength(2);
    expect(overview.body.recent.map((a: any) => a.level).sort()).toEqual(['critical', 'warning']);

    // 状态过滤
    const openOnly = await request(app).get('/api/v1/risk/alerts?status=Open&level=critical').set(auth());
    expect(openOnly.body.total).toBe(1);
  });
});

/**
 * ★ 静默少算守卫（窗口截断）—— 2026-09-17 新增
 *
 * 两条病灶同源：**先取一个固定窗口、再在内存里算**，于是窗口外的数据被静默丢掉。
 *   · `getRiskOverview` 旧实现 `findMany({ take: 500 })` 后内存累加 → >500 条时计数少算
 *   · `listCreditRatings` 旧实现 `take 200` 后内存按 relationId 去重 → 窗口外的客户整条缺失
 * 两条都用**超过窗口的数据量**构造输入（否则测不出来 —— 小数据量下新旧实现结果相同）。
 */
describe('★ 静默少算守卫（窗口截断）', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('overview 计数不被 500 行窗口截断（501 条 Open → 计数 501）', async () => {
    const app = makeApp(prisma);
    const N = 501;
    for (let i = 0; i < N; i++) {
      prisma._stores.riskAlerts.push({
        id: `RSKA__BULK${i}`,
        type: 'fx_volatility',
        level: 'warning',
        status: 'Open',
        dedupKey: `bulk:${i}`,
        relatedType: null,
        relatedId: null,
        resolvedAt: null,
        createdAt: BigInt(1000 + i),
      });
    }

    const res = await request(app).get('/api/v1/risk/overview').set(auth());
    expect(res.status).toBe(200);
    // 修前：从 take:500 的窗口里数 → 500（静默少算 1）
    expect(res.body.openByType.fx_volatility).toBe(N);
    expect(res.body.openByLevel.warning).toBe(N);
    // recent 的截断是**预期语义**（最近 10 条），不受影响
    expect(res.body.recent).toHaveLength(10);
  });

  it('latestOnly 不被 200 行窗口截断（最老的客户仍在结果里）', async () => {
    const app = makeApp(prisma);
    // 200 条「新」评级属于同一个客户，把窗口占满
    for (let i = 0; i < 200; i++) {
      prisma._stores.creditRatings.push({
        id: `CDR__BULK${i}`,
        relationId: 'REL_BULK',
        grade: 'A',
        score: 90,
        evaluatedAt: BigInt(2000 + i),
        evaluatedBy: null,
        factors: null,
      });
    }
    // 1 条「最老」评级属于另一个客户 → 修前它落在 200 行窗口之外，**整条缺失**
    prisma._stores.creditRatings.push({
      id: 'CDR__OLDEST',
      relationId: 'REL_OLDEST',
      grade: 'B',
      score: 80,
      evaluatedAt: BigInt(1),
      evaluatedBy: null,
      factors: null,
    });

    const res = await request(app).get('/api/v1/risk/credit-ratings?latestOnly=true').set(auth());
    expect(res.status).toBe(200);
    const rels = res.body.items.map((i: any) => i.relationId).sort();
    // 修前：只有 ['REL_BULK']（total=1）
    expect(rels).toEqual(['REL_BULK', 'REL_OLDEST']);
    expect(res.body.total).toBe(2);
    // 每客户只保留**最新**一条
    expect(res.body.items.filter((i: any) => i.relationId === 'REL_BULK')).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════
// S0-A Task 5：risk 域错误出口收敛到注册表（试点，摘除第一行豁免）
//   本文件每个 describe 各持一份内存 prisma mock（`makeMockPrisma()` 在 :20 定义、
//   `makeApp(prisma)` 在 :320 定义并以参数接收 prisma）—— 新块必须自己声明 prisma，
//   否则引用不到外层变量，编译直接不过。
// ════════════════════════════════════════════════════════════════

describe('S0-A 错误不外泄（risk 试点）', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  // ⚠️ 本块**不用**文件里的 `viewerToken`：`auth/permissionGuard.ts:170` 的 legacy 映射是
  // `viewer: []`（零 scope），GET /alerts 会在 `requirePermission('risk:read')` 处直接 403 ——
  // 请求进不到 handler，三条断言会因「鉴权失败」而红，测不到本次收敛（实测：三条全报
  // `expected 403 to be 500`）。故改用真正持有 risk:read 的只读角色 sales
  // （SALES 有 risk:read、无 risk:write），保持 brief「非特权只读用户看到安全文案」的意图。
  const readToken = jwt.sign({ userId: 'u-risk-read', roles: ['sales'] }, SECRET);

  it('★ 服务层抛 Prisma 原文 → 响应只含注册表文案，不含内部细节', async () => {
    const app = makeApp(prisma);
    prisma.riskAlert.findMany = async () => {
      throw new Error(
        'PrismaClientKnownRequestError: Invalid `prisma.riskAlert.findMany()` invocation in ' +
        '/Users/panda1/bambook-main-api/server/src/risk/riskService.ts:244: Unknown argument `deletedAts`',
      );
    };
    const res = await request(app)
      .get('/api/v1/risk/alerts')
      .set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('ALERT_LIST_FAILED');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Prisma');
    expect(body).not.toContain('bambook-main-api');
    expect(body).not.toContain('deletedAts');
    expect(body).not.toContain('riskService');
    // 形状必须保持 nested —— 前端契约
    expect(res.body.error.message).toBe('预警列表加载失败，请稍后重试。');
  });

  it('★ 业务错误（自带 code+statusCode）文案照旧透传', async () => {
    const app = makeApp(prisma);
    prisma.riskAlert.findMany = async () => {
      throw Object.assign(new Error('预警状态非法'), { code: 'VALIDATION_FAILED', statusCode: 400 });
    };
    const res = await request(app)
      .get('/api/v1/risk/alerts')
      .set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('预警状态非法');
    // ★ 复审 Minor 6：这里原来抄了一份「注册表此刻对 VALIDATION_FAILED 的文案」做 `not.toBe` ——
    //   抄本被改动（哪怕只是标点）后断言就恒真、不再咬人。改钉**走的是哪条支路**：
    //   兜底支路回的 code 是调用点传的 fallbackCode（ALERT_LIST_FAILED），
    //   业务支路回的 code 是抛出方自带的 —— 只有后者能证明业务错误真的被透传了。
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    // 再钉一条不依赖任何单条文案字面量的形状判据：注册表的兜底文案（含通用文案）都是「…请稍后重试。」句式
    expect(res.body.error.message).not.toMatch(/请稍后重试。/);
    // 形状仍是 nested（前端契约）
    expect(typeof res.body.error).toBe('object');
  });

  it('★ 中文子串猜码已废除：含「必填」的内部异常不得因此变 400', async () => {
    const app = makeApp(prisma);
    prisma.riskAlert.findMany = async () => {
      throw new Error('Prisma: 字段 tenantId 必填 才能查询 table=risk_alert');
    };
    const res = await request(app)
      .get('/api/v1/risk/alerts')
      .set('Authorization', `Bearer ${readToken}`);
    // 旧实现会因 includes('必填') 误判 400 并把原文甩出去
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('risk_alert');
    expect(JSON.stringify(res.body)).not.toContain('tenantId');
  });

  it('★ 服务层业务校验文案照旧到前端（400 + 原文案），不再由路由猜', async () => {
    const app = makeApp(prisma);
    const res = await request(app)
      .post('/api/v1/risk/fx-rates')
      .set(auth())
      .send({ currency: 'USD', rate: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('汇率必须大于 0');
  });

  it('★ 抛出的不是 Error 对象（`throw { message }`）时，原文同样不许上网络', async () => {
    const app = makeApp(prisma);
    // 旧实现读的是 `e?.message || 'operation failed'` —— 对象字面量带 message 就直接进响应体
    prisma.riskAlert.findMany = async () => {
      throw { message: 'PrismaClientUnknownRequestError: SELECT * FROM risk_alert WHERE deletedAts IS NULL' };
    };
    const res = await request(app)
      .get('/api/v1/risk/alerts')
      .set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Prisma');
    expect(body).not.toContain('risk_alert');
    expect(body).not.toContain('deletedAts');
    expect(res.body.error.message).toBe('预警列表加载失败，请稍后重试。');
  });

  it('★ riskRoute 用到的每个 fallback 码都必须在注册表里（漏一个=文案静默退化成通用提示）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { ERROR_CODES } = await import('../../shared/errorCodes');
    const file = path.resolve(__dirname, '..', 'riskRoute.ts');
    const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const used = [...code.matchAll(/handleError\(\s*res\s*,\s*e\s*,\s*'([A-Z0-9_]+)'\s*\)/g)].map((m) => m[1]);
    // ★ 再加一道形变压力：每个 catch 都必须走这个统一出口，且码数与端点数对齐
    //   （risk 域实测 20 个端点 / 20 个 catch / 20 个 handleError 调用点 = 20 个不同的码）
    const catches = [...code.matchAll(/\}\s*catch\s*\(/g)].length;
    const endpoints = [...code.matchAll(/\brouter\.(?:get|post|patch|put|delete)\s*\(/g)].length;
    // ★★ 断言顺序是这条守卫的一部分（复审 F2）：**可行动的那条放最前面**。
    //   旧写法把 `new Set(used).size === 20` 抄成实现里的常量、又排在缺码断言之前 ⇒
    //   有人合法加了第 21 个端点却忘了登记码时，先红的是那条计数（报「20 不对」），
    //   真正告诉他该干什么的「注册表缺这些码」反而被压在后面 —— 于是人去 bump/删那个魔数，守卫失效。
    const missing = [...new Set(used)].filter((c) => !Object.prototype.hasOwnProperty.call(ERROR_CODES, c));
    expect(missing, `注册表缺这些码：${missing.join(', ')}`).toEqual([]);
    // 非空对照（brief Step 5 的下界，防正则退化成恒空集 —— 那样本测试会假绿）
    expect(used.length).toBeGreaterThanOrEqual(20);
    // 计数断言一律从**同一份源码自身**推导，不写实现里抄来的魔数（权威文档 G6.3/G6.4）
    expect(used.length, '每个 catch 都必须走这一个统一错误出口（出现绕过写法 = 红）').toBe(catches);
    expect(new Set(used).size, '不同的码必须与端点数一一对应（新增端点要同步把码登记进注册表）').toBe(endpoints);
  });
});
