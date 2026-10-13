/**
 * B58 —— agent 面写进"身份列"的值，必须是库里真存在的账号
 *
 * 为什么单独一个文件：`actorId: 'agent'` 这一族此前有 34 处 / 19 文件，分散在各 flow 里，
 * 每一处单独看都不像缺陷（"这是个来源标记嘛"）。它的实际后果只有一条：**`AuditLog.actorId`
 * 有外键 → `UserAccount(id)`**（真库 pg_constraint 实测），而 `agent` / `unknown` / `api`
 * 在 `UserAccount` 里都没有行 ⇒ 一旦走到审计那笔写，整条业务写入 P2003 回滚，
 * 用户看到的是一句"数据库错误"，真相是身份写错。
 *
 * 三组判据（① ② 走真库，是本批的主证据；③ ④ 是取值链）：
 *  ① 哨兵本身合法：`SYSTEM_AUDIT_ACTOR` 在 `UserAccount` 有行；被换掉的那三个值确实没有行
 *     —— 否则这次"修"只是把 P2003 换个位置犯。
 *  ② 反面对照（真库）：拿 `'agent'` 当 actorId 写审计 **必须**失败且失败码就是 P2003；
 *     同一笔写换成真账号必须成功（不然 ① 只是个读数，不构成行为证据）。
 *  ③ 审批提交路的身份来源 = `ApprovalRequest.requesterId`（registry 注入一次，不再各处自查）；
 *     取不到时落 ① 的那个账号，绝不落回无账号的哨兵。
 *  ④ 缺参 / 空串 / 全空格 三种"没身份"的形状都收敛到同一个账号，且永远不会产出 'agent'。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { SYSTEM_AUDIT_ACTOR, auditActorFrom, writeRouteAuditLog } from '../../audit/routeAudit';
import { registerCommitTool, getToolHandler } from '../toolDispatchRegistry';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';

/**
 * ★ B35 宽尺第二刀采纳点 ①（v2.96）：客户端由触碰记录壳给 ⇒ "本次写过哪张表"由运行时决定而不是这份文件自己声明。
 *   本文件的落库写面只有 `AuditLog` 一条（其余 ③④⑤ 组用桩与源码文本），所以是 v2.95 那次普查的 12 份候选里迁移风险最低的一份，先拿它开刀。
 */
const MARK = 'TEST_B58ACTOR_';
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
// 这三个值在 UserAccount 里没有行 —— 它们只能出现在 detail.source，不能出现在身份列
const NO_ACCOUNT_ACTORS = ['agent', 'unknown', 'api'];

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { targetId: { startsWith: ctx.mark } } });
/** ★ v3.31（B151）：单值普查也交给基座。where 逐字搬自旧那一行；⚠️ 本文件另有两处 count **不是**残留普查（循环变量 bad / ctx.id('ILLEGAL') 的用例内探针）⇒ 一律留原地。 */
const RESIDUAL_SPEC = [
  { key: 'audit', model: 'auditLog', run: () => prisma.auditLog.count({ where: { targetId: { startsWith: ctx.mark } } }) },
];
  const got = await safeResidualCounts(RESIDUAL_SPEC);
  expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
  expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
    .toEqual({ audit: 0 });
  /**
   * ★ 壳那一半（不断言具体模型名，钉实现字面是 B102 那一族）：触碰集合非空 + 列无关口径下不留本次 run 的行 + 不许有"数不到"的表。
   */
  await prisma.$disconnect();
});

describe('B58 ① 哨兵必须是真账号（真库只读）', () => {
  it(`SYSTEM_AUDIT_ACTOR='${SYSTEM_AUDIT_ACTOR}' 在 UserAccount 里有行`, async () => {
    const row = await prisma.userAccount.findUnique({ where: { id: SYSTEM_AUDIT_ACTOR }, select: { id: true } });
    expect(row?.id).toBe(SYSTEM_AUDIT_ACTOR);
  });

  it('★ 被换掉的三个值在 UserAccount 里确实没有行（= 写进身份列必然 P2003）', async () => {
    for (const bad of NO_ACCOUNT_ACTORS) {
      const n = await prisma.userAccount.count({ where: { id: bad } });
      expect(n, `'${bad}' 若真有账号，本批的前提就不成立了，得重判`).toBe(0);
    }
  });
});

describe('B58 ② 反面对照：写 agent 进身份列在真库里失败，写真账号成功', () => {
  it('actorId=agent ⇒ 抛 P2003（不是"静默成功"，也不是别的码）', async () => {
    await expect(writeRouteAuditLog({
      prisma: prisma as any, actorId: 'agent', source: 'agent:b58.probe',
      operation: 'probe_illegal_actor', targetType: 'Probe', targetId: ctx.id('ILLEGAL'),
    })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.auditLog.count({ where: { targetId: ctx.id('ILLEGAL') } })).toBe(0);
  });

  it('★ 同一笔写换成真账号 ⇒ 成功落行（阳性对照：证明上一条是身份导致的，不是探针本身写不进）', async () => {
    const id = await writeRouteAuditLog({
      prisma: prisma as any, actorId: SYSTEM_AUDIT_ACTOR, source: 'agent:b58.probe',
      operation: 'probe_legal_actor', targetType: 'Probe', targetId: ctx.id('LEGAL'),
    });
    const row = await prisma.auditLog.findUnique({ where: { id } });
    expect(row?.actorId).toBe(SYSTEM_AUDIT_ACTOR);
    expect((row?.detail as any)?.source).toBe('agent:b58.probe'); // "来自 agent 面"这个事实仍在，只是不占身份列
  });
});

describe('B58 ③ 审批提交路的身份 = 审批请求人（registry 注入一次）', () => {
  const TOOL_ID = 'tool.b58probe.commit';

  function mockPrisma(approval: Record<string, unknown> | null) {
    return {
      approvalRequest: { findUnique: async () => approval },
      // receipts 缺失是 registry 明确支持的不完整桩（见 toolDispatchRegistry 注释）
    } as any;
  }

  it('approval 带 requesterId ⇒ commitFn 收到的 ctx.actorId 就是它', async () => {
    let seen: { actorId?: string } | null = null;
    registerCommitTool(TOOL_ID, async (ctx) => {
      seen = ctx as any;
      return { ok: true } as any;
    });
    const handler = getToolHandler(TOOL_ID)!;
    const r = await handler(
      mockPrisma({ id: 'ap_1', status: 'approved', actionType: `tool:${TOOL_ID}`, requesterId: 'usr_requester', payload: {} }),
      {}, { approvalId: 'ap_1' } as any,
    );
    expect(r.ok).toBe(true);
    expect((seen as any)?.actorId).toBe('usr_requester');
  });

  it('★ requesterId 缺失 ⇒ 落真账号哨兵，且永远不落回无账号的那三个值', async () => {
    let seen: { actorId?: string } | null = null;
    registerCommitTool(TOOL_ID + '.fallback', async (ctx) => {
      seen = ctx as any;
      return { ok: true } as any;
    });
    const handler = getToolHandler(TOOL_ID + '.fallback')!;
    await handler(
      mockPrisma({ id: 'ap_2', status: 'approved', actionType: `tool:${TOOL_ID}.fallback`, requesterId: null, payload: {} }),
      {}, { approvalId: 'ap_2' } as any,
    );
    expect((seen as any)?.actorId).toBe(SYSTEM_AUDIT_ACTOR);
    expect(NO_ACCOUNT_ACTORS).not.toContain((seen as any)?.actorId);
  });
});

describe('B58 ④ 取值链：没有身份时收敛到同一个账号', () => {
  it('注入了就用注入的；空/缺省/空格一律落 SYSTEM_AUDIT_ACTOR', () => {
    expect(auditActorFrom({ actorId: 'usr_requester' })).toBe('usr_requester');
    expect(auditActorFrom({ actorId: '' })).toBe(SYSTEM_AUDIT_ACTOR);
    expect(auditActorFrom({})).toBe(SYSTEM_AUDIT_ACTOR);
    expect(auditActorFrom({ actorId: '   ' })).toBe(SYSTEM_AUDIT_ACTOR);
    expect(auditActorFrom(undefined)).toBe(SYSTEM_AUDIT_ACTOR);
  });

  it('★ 不会因为"忘了传"而产出 agent/unknown/api', () => {
    for (const p of [undefined, null, {}, { actorId: '' }, { actorId: '  ' }]) {
      expect(NO_ACCOUNT_ACTORS).not.toContain(auditActorFrom(p as any));
    }
  });
});

/**
 * B58 ⑤ —— 位置参数这一族（★ R4-T4 复核抓到本批第一版分母漏掉的部分）。
 *
 * 为什么单独一组：第一版普查用的是 `grep "actorId: 'agent'"`，那是**对象字面量属性**的形状。
 * 而 `procurementFlow.ts` / `quotationFlow.ts` / `customsFlow.ts` 里身份是**位置参数**
 * （`svc.createPurchaseOrder(body, 'agent')`），形状不同、后果相同 —— 服务层下一路把它写进
 * `AuditLog.actorId`（`procurementService.ts:410` / `customsService.ts:962` 与 `:573`，
 * 其中 customs 那两处连兜底都没有）⇒ 同样 P2003、同样整笔回滚。
 * ★ 教训：**按形状 grep 得到的分母不是族的全量**，"34 处"当时被写成了"0 处"的结论因此是假的。
 *
 * 这里钉的是**接线形状**（注入有没有真的走到那三个文件的位置参数上）；
 * 逐工具的行为证据在各自的 flow 测试里（`procurementFlow` / `quotationFlow` / `customsFlow`
 * 的成功用例现在都断言"服务收到的身份位 = 注入的 `usr_requester`"）。
 */
describe('B58 ⑤ 位置参数传身份的一族：注入必须一路走到服务参数位', () => {
  const FLOWS: Array<[string, number]> = [
    ['procurementFlow.ts', 2],
    ['quotationFlow.ts', 2],
    ['customsFlow.ts', 2],
  ];

  for (const [file, n] of FLOWS) {
    const src = readFileSync(path.resolve(__dirname, '..', file), 'utf-8');
    it(`${file}：${n} 处位置参数取注入值，且 wrapper 把 ctx.actorId 传下来`, () => {
      expect(src.match(/auditActorFrom\(params\)/g) ?? [], `${file} 里取值点数不对`).toHaveLength(n);
      // wrapper 必须把 registry 注入的身份传进 commit 函数（不传 = 位置参数拿到 undefined ⇒ 落兜底，看着对其实丢人）
      expect((src.match(/actorId: ctx\.actorId/g) ?? []).length, `${file} 没把 ctx.actorId 传下去`).toBe(n);
      expect(src, `${file} 的 params 类型缺 actorId，注入会在这里静默掉`).toMatch(/actorId\?: string/);
      // 反向：身份位上不许再有库里不存在的字面量（位置参数写法）
      expect(src, `${file} 仍有把 'agent' 放在参数位上的调用`).not.toMatch(/,\s*'agent'\s*[,)]/);
    });
  }

  it('★ 全 agent/ 目录的非测试源码，身份位上不再出现 agent/unknown/api 字面量（形状无关的普查）', () => {
    // 不是棘轮（只扫一个目录、且需要人逐处判"这是身份位还是留痕位"）；本条要的是"别再按单一形状数分母"
    const dir = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(path.join(dir, f), 'utf-8');
      const code = src.split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))                       // 去注释行
        // 留痕位白名单：每一处的落点都单独验过是**无外键**的追踪列（台账 B58 行给的是同一条实测）：
        //   `StockMovement.operator` / `ShipmentEvent.actorId` / `OrderStatusTransition.operator` / `signedByX String?`
        .filter((l) => !/operator:|source:|signerId|appendShipmentEvent|deductShipmentStockInTx|reverseShipmentStockInTx|createStockMovement/.test(l))
        .join('\n');
      for (const bad of NO_ACCOUNT_ACTORS) {
        if (new RegExp(`,\\s*'${bad}'\\s*[,)]|actorId:\\s*'${bad}'`).test(code)) offenders.push(`${f} → '${bad}'`);
      }
    }
    expect(offenders, '这些地方会把无账号的值写进身份列').toEqual([]);
  });

  it('★ "合法身份"这个判断只有一份实现（不得再出现第二个手抄的 system 字面量）', () => {
    const src = readFileSync(path.resolve(__dirname, '..', 'toolRuntime.ts'), 'utf-8');
    expect(src, 'AGENT_SYSTEM_ACTOR 又手抄了一遍字面量 ⇒ 同一判断两处实现').toMatch(
      /const AGENT_SYSTEM_ACTOR = SYSTEM_AUDIT_ACTOR;/,
    );
    expect(src.match(/=\s*'system';/g) ?? [], 'toolRuntime 里不该再有第二份 system 字面量').toHaveLength(0);
  });
});
