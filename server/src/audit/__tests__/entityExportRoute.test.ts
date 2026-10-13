/**
 * G4.3：GET /api/v1/audit/entity/export（变更史导出 CSV）
 *
 * 判据（§12.05 D110）：
 *   · **门禁与 /entity 完全同档**（同 token 下两边状态码必须一致 —— 导出漏门禁 = 越权下载审计）；
 *   · 不走面板那 20 条：`take` 必须是导出上限 + 1（多取 1 条只为判截断）；
 *   · 响应是 `text/csv` 附件 + RFC 5987 文件名；正文带 BOM、第一行是表头；
 *   · 截断要在正文里**显式**说明（计数器对撞：数据行数 = 上限，且多一条说明行）；
 *   · **只读**：不许出现任何写库调用（本端点不写审计）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthService } from '../../auth/service';
import { createAuditRouter } from '../route';
import type { AgentRole } from '../../agent/types';

function tokenFor(roles: AgentRole[], userId = 'u-1') {
  return createAuthService().signToken({ userId, displayName: 'Test User', roles, permissions: [], departmentIds: [] });
}

/** 完整 prisma 桩：把"有没有被写"也留成证据（写方法一律记调用）；findMany 按 skip/take **真分页** */
function makeApp(opts: { logs?: any[] } = {}) {
  const all = opts.logs ?? [];
  const findMany = vi.fn(async (args: any) => {
    const skip = typeof args?.skip === 'number' ? args.skip : 0;
    const take = typeof args?.take === 'number' ? args.take : all.length;
    return all.slice(skip, skip + take);
  });
  const create = vi.fn();
  const update = vi.fn();
  const updateMany = vi.fn();
  const deleteMany = vi.fn();
  const prisma = { auditLog: { findMany, create, update, updateMany, deleteMany } } as any;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/audit', createAuditRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
  return { app, findMany, writes: [create, update, updateMany, deleteMany] };
}

const SAMPLE_LOG = {
  id: 'alog_1',
  action: 'update_order',
  targetType: 'Order',
  targetId: 'ORD_1',
  operationType: 'update',
  fieldPath: 'status',
  beforeValue: 'Draft',
  afterValue: 'Confirmed',
  detail: { source: 'orders.route' },
  createdAt: new Date(2026, 7, 7, 10, 0, 0),
  actor: { id: 'u-9', displayName: 'Operator', email: 'op@example.com' },
};

const URL_EXPORT = '/api/v1/audit/entity/export?targetType=Order&targetId=ORD_1';

describe('G4.3 变更史导出：门禁 / 形状 / 截断 / 只读', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('未认证 → 401（与 /entity 同档）', async () => {
    const { app } = makeApp();
    const res = await request(app).get(URL_EXPORT);
    expect(res.status).toBe(401);
  });

  it('缺 targetType → 400 TARGET_REQUIRED（防全表扫描的口径不许在两处漂开）', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/api/v1/audit/entity/export?targetId=ORD_1')
      .set('Authorization', `Bearer ${tokenFor(['merchandiser'])}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TARGET_REQUIRED');
  });

  it('★ 门禁逐档对齐 /entity：同 token 两边状态码必须相等（导出漏门禁＝越权下载）', async () => {
    const cases: Array<{ roles: AgentRole[]; q: string; why: string }> = [
      { roles: ['merchandiser'], q: 'targetType=Order&targetId=ORD_1', why: 'merchandiser 可读订单' },
      { roles: ['viewer'], q: 'targetType=Order&targetId=ORD_1', why: 'viewer 无 orders scope' },
      { roles: ['finance'], q: 'targetType=Relation&targetId=REL_1', why: 'finance 无 relations scope' },
      { roles: ['owner'], q: 'targetType=NoSuchType&targetId=X', why: 'owner 恒可读（含未映射类型）' },
      { roles: ['merchandiser'], q: 'targetType=NoSuchType&targetId=X', why: '未映射类型 fail closed' },
    ];
    for (const c of cases) {
      const { app } = makeApp({ logs: [SAMPLE_LOG] });
      const token = tokenFor(c.roles);
      const a = await request(app).get(`/api/v1/audit/entity?${c.q}`).set('Authorization', `Bearer ${token}`);
      const b = await request(app).get(`/api/v1/audit/entity/export?${c.q}`).set('Authorization', `Bearer ${token}`);
      expect(b.status, `${c.why}：查询端 ${a.status} / 导出端 ${b.status} ⇒ 两处门禁漂了`).toBe(a.status);
    }
  });

  it('200：text/csv + RFC 5987 文件名 + BOM + 表头 + 行内容落位', async () => {
    const { app } = makeApp({ logs: [SAMPLE_LOG] });
    const res = await request(app)
      .get(URL_EXPORT)
      .set('Authorization', `Bearer ${tokenFor(['merchandiser'])}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-type']).toContain('utf-8');
    const cd = String(res.headers['content-disposition'] || '');
    expect(cd).toContain('attachment');
    expect(cd).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1])).toBe('变更史-Order-ORD_1.csv');
    expect(res.text.startsWith('\ufeff')).toBe(true);
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('时间,操作人,操作类型,字段,原值,新值,动作,详情');
    expect(lines[1]).toContain('Operator');
    expect(lines[1]).toContain('Draft,Confirmed'.replace(',', ',')); // 内容落位（原值/新值相邻）
    expect(lines[1]).toContain('update_order');
    expect(lines).toHaveLength(2);
  });

  it('★ 不走面板那 20 条：分页取满（每页 500、skip 递增），不是只给一页', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ ...SAMPLE_LOG, id: `alog_${i}` }));
    const { app, findMany } = makeApp({ logs: rows });
    const res = await request(app).get(URL_EXPORT).set('Authorization', `Bearer ${tokenFor(['merchandiser'])}`);
    const arg = findMany.mock.calls[0][0];
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.take, '导出取 20 条 ⇒ "完整变更史"名不副实').toBe(500);
    expect(arg.skip).toBe(0);
    expect(findMany.mock.calls.length, '第一页满了却没取第二页 ⇒ 501 条只导出了 500').toBe(2);
    expect(findMany.mock.calls[1][0].skip).toBe(500);
    expect(res.text.trim().split('\r\n'), '501 条属于"完整可导出"的范围内，不该写截断行').toHaveLength(502);
    expect(res.text).not.toContain('已截断');
  });

  it('★ 完整优先：1003 条（500+500+3）全导出，且**不**写截断行', async () => {
    const rows = Array.from({ length: 1003 }, (_, i) => ({ ...SAMPLE_LOG, id: `alog_${i}` }));
    const { app, findMany } = makeApp({ logs: rows });
    const res = await request(app).get(URL_EXPORT).set('Authorization', `Bearer ${tokenFor(['merchandiser'])}`);
    expect(findMany.mock.calls.length).toBe(3);
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(1004); // 表头 + 1003
    expect(res.text).not.toContain('已截断');
  });

  it('★ 刚好 5000（硬上限）：全部导出、**不**写截断行（边界不许误报）', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ ...SAMPLE_LOG, id: `alog_${i}` }));
    const { app } = makeApp({ logs: rows });
    const res = await request(app).get(URL_EXPORT).set('Authorization', `Bearer ${tokenFor(['merchandiser'])}`);
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(5001);
    expect(res.text).not.toContain('已截断');
  });

  it('★ 硬上限之上才截断：5500 条 ⇒ 数据行 5000 + **显式说明行**（不许静默少给）', async () => {
    const rows = Array.from({ length: 5500 }, (_, i) => ({ ...SAMPLE_LOG, id: `alog_${i}` }));
    const { app, findMany } = makeApp({ logs: rows });
    const res = await request(app).get(URL_EXPORT).set('Authorization', `Bearer ${tokenFor(['merchandiser'])}`);
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(5002); // 表头 + 5000 数据 + 1 说明
    expect(lines[lines.length - 1]).toContain('已截断');
    expect(lines[lines.length - 1]).toContain('最近 5000 条');
    expect(findMany.mock.calls.length, '取到上限就该停（11 页 = 5000+500）').toBe(11);
  });

  it('未截断时不许出现说明行（反面对照：上面的断言不是恒真）', async () => {
    const { app } = makeApp({ logs: [SAMPLE_LOG] });
    const res = await request(app).get(URL_EXPORT).set('Authorization', `Bearer ${tokenFor(['merchandiser'])}`);
    expect(res.text).not.toContain('已截断');
  });

  it('★ 只读：整个导出过程不许出现任何写库调用', async () => {
    const { app, writes } = makeApp({ logs: [SAMPLE_LOG] });
    await request(app).get(URL_EXPORT).set('Authorization', `Bearer ${tokenFor(['merchandiser'])}`);
    for (const w of writes) expect(w, '导出写了库 ⇒ 它不再是只读端点').not.toHaveBeenCalled();
  });
});
