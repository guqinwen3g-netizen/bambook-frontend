/**
 * ★ B35 第三刀：触碰记录壳的**行为**测试（不连库 —— 替身 prisma + 替身 DMMF）。
 *
 * 为什么主判据是行为不是形状（本仓反复踩的坑）：
 *   "这个演练写过哪几张表"用 grep 数形状得到的是**下界** —— B58 那批实测：3 个 flow 用**位置参数**
 *   把值传进服务层、由服务内部落库，形状判据一条都没抓到。壳站在注入点上，
 *   所以"服务里写的"与"事件总线扇出的"都会被记录 —— 第 1 条断言钉的正是这件事。
 *   第 3 条是 B94 的正身：**手写清理清单漏一张表时，壳必须仍然把它报成脏。**
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { autoAssert, createDrillContext, residualFailureMessage } from './lib/drillTouchLog';

/**
 * ★ v3.02：替身必须听得懂**真 where 的形状**（AND / OR / NOT / 相等 / contains / startsWith / in）。
 *   原来只认顶层 `where.OR` 的 contains ⇒ 壳新加的两处计数（`{id: actor}` 与"别人名下"那一刀的 AND/NOT）
 *   在替身上会**被当成没有条件**而返回全表，测试就只会证明"跑过了"而证明不了"数对了"
 *   （本仓反复立的"替身语义不足 ⇒ 假覆盖"，与 §9 B108/B115 同族）。
 */
function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') { if (!(v as any[]).every((w) => matchesWhere(row, w))) return false; continue; }
    if (k === 'OR') { if (!(v as any[]).some((w) => matchesWhere(row, w))) return false; continue; }
    if (k === 'NOT') { if (matchesWhere(row, v)) return false; continue; }
    const actual = row[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const spec = v as Record<string, unknown>;
      if ('contains' in spec && !String(actual ?? '').includes(String(spec.contains))) return false;
      if ('startsWith' in spec && !String(actual ?? '').startsWith(String(spec.startsWith))) return false;
      if ('in' in spec && !(spec.in as unknown[]).includes(actual)) return false;
      if ('not' in spec && actual === spec.not) return false;
    } else if (actual !== v) return false;
  }
  return true;
}

/**
 * ★ 这里刻意用**真 Prisma 模型名**（Order / UserAccount / Notification / AgentMemory …），不是随便起的名：
 *   壳取模型定义走的是 `Prisma.dmmf`（与基座同一份），替身若用假名就会"扫 0 张表 ⇒ 恒干净"——
 *   正是本文件第一版被**突变**抓出来的那种假覆盖。
 * ★ `AgentMemory` 是**专门为 B120 的"可空归属列"那一档**加的：真 schema 里它的 `userId` 可空，
 *   而 `Notification.userId` 必选 ⇒ "无主行（NULL）"只能建在前者上，否则测试会去验一个库里不可能存在的形状
 *   （这正是 v3.02 那条 BLOCKER 的形状：替身听得懂 `{col:null}`，真 Prisma 在必选列上直接拒整条 where）。
 */
const MODEL_NAMES = ['Order', 'InventoryItem', 'Notification', 'UserAccount', 'AgentMemory'];
const keyOf = (m: string) => m.charAt(0).toLowerCase() + m.slice(1);
/** 真 schema 的列可空性：替身拿它**拒收**"必选列上的 `{col: null}`"—— 那是真 Prisma 会直接报错的形状 */
const REAL_MODELS = new Map<string, any>(((Prisma as any).dmmf?.datamodel?.models ?? []).map((m: any) => [m.name, m]));
function assertWhereLegal(modelName: string, where: any, path = ''): void {
  if (!where || typeof where !== 'object') return;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND' || k === 'OR') { (v as any[]).forEach((w, i) => assertWhereLegal(modelName, w, `${path}${k}[${i}]`)); continue; }
    if (k === 'NOT') { assertWhereLegal(modelName, v, `${path}NOT`); continue; }
    if (v === null) {
      const f = (REAL_MODELS.get(modelName)?.fields ?? []).find((x: any) => x.name === k);
      if (f?.isRequired) {
        throw new Error(`STUB_REJECTS_REQUIRED_NULL: ${modelName}.${k} 在真 schema 里是**必选列**，`
          + `Prisma 5 对必选列的 \`{ ${k}: null }\` 会拒绝整条 where（实测报 \`Argument \\\`${k}\\\` is missing.\`）`
          + `⇒ 替身照真库拒收，别让它当"能查"（v3.02 那条 BLOCKER 的回归钉子）`);
      }
    }
  }
}

/** 替身客户端：字段形状与 Prisma DMMF 一致（扫描的列由 DMMF 派生，本文件不出现任何 {model, field} 硬编码） */
function makeStubClient() {
  // ★ store 必须从 MODEL_NAMES 派生：早前写死三张表，加第四张（userAccount）时 create 直接炸在替身上
  const store: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(MODEL_NAMES.map((n) => [keyOf(n), []]));
  const delegateFor = (name: string, model: string) => ({
    create: async (a: any) => { store[name].push(a.data); return a.data; },
    findMany: async (a: any) => {
      assertWhereLegal(model, a?.where);
      const hit = store[name].filter((row) => matchesWhere(row, a?.where));
      return a?.select ? hit.map((r) => Object.fromEntries(Object.keys(a.select).map((k) => [k, r[k]]))) : hit;
    },
    count: async (a: any) => (await delegateFor(name, model).findMany({ ...a, take: undefined, select: undefined })).length,
    update: async () => ({}),
    // ★ 替身必须真的删：否则"清理后必须数到 0"那条对照就是假的（本仓反复踩的"替身语义不足 ⇒ 判据恒绿"）
    deleteMany: async (a: any) => {
      assertWhereLegal(model, a?.where);
      const before = store[name].length;
      store[name] = store[name].filter((r) => !matchesWhere(r, a?.where));
      return { count: before - store[name].length };
    },
  });
  const client: any = { $prisma: { dmmf: { datamodel: { models: MODEL_NAMES.map((name) => ({
    name,
    fields: [
      { name: 'id', kind: 'scalar', type: 'String' },
      { name: 'note', kind: 'scalar', type: 'String' },
      { name: 'createdAt', kind: 'scalar', type: 'DateTime' },
    ],
  })) } } } };
  for (const name of MODEL_NAMES) client[keyOf(name)] = delegateFor(keyOf(name), name);
  return { client, store };
}

/** 模拟服务层：prisma 是**位置参数**进来的，内部写两张表 —— 形状判据看不见的那一类 */
async function serviceWritesTwoTables(p: any, mark: string) {
  await p.order.create({ data: { id: `${mark}ORD_1`, note: 'drill order' } });
  // 模拟事件总线扇出（同一条注入链路上的另一次写）
  await p.notification.create({ data: { id: `${mark}NTF_1`, note: 'fanout' } });
}

describe('B35 第三刀：触碰记录壳（写操作记录 + 按 run 标记对撞残留）', () => {
  it('★ 服务层内部与总线扇出的写入都被记录；读操作不进集合', async () => {
    const { client } = makeStubClient();
    const ctx = createDrillContext({ prefix: 'TEST_C4OWN_', client: client as any, runId: 't1' });
    await serviceWritesTwoTables(ctx.prisma, ctx.mark);
    await ctx.prisma.inventoryItem.create({ data: { id: ctx.id('INV_1'), note: 'direct' } });
    await ctx.prisma.order.findMany({}); // 读：不许进 touched

    expect(ctx.touchedModels(), '三张被写的表都必须在集合里（含服务层内部写的那两张）')
      .toEqual(['InventoryItem', 'Notification', 'Order']);
    const orderCreate = ctx.touchRecords().find((r) => r.model === 'Order' && r.op === 'create');
    expect(orderCreate?.calls, 'order.create 由**服务层**发起 ⇒ 记录必须为 1 次').toBe(1);
    expect(ctx.touchRecords().some((r) => r.op === 'findMany'), '读操作被当写操作登记 ⇒ "写过"这个语义就废了').toBe(false);
    // 标记形状：留在既有前缀族内（v2.63 的认领与 v2.67 的族对撞都不换口径）
    expect(ctx.mark, 'run 标记必须是 TEST_<族>_<runId>_ 形状').toBe('TEST_C4OWN_t1_');
    expect(ctx.id('INV_9'), 'id() 必须把 run 标记带在最前（否则按前缀认领不到）').toBe('TEST_C4OWN_t1_INV_9');
  });

  it('★ residual 只扫"被触碰的模型"，并把每一张的命中数报出来', async () => {
    const { client, store } = makeStubClient();
    const ctx = createDrillContext({ prefix: 'TEST_C5SH_', client: client as any, runId: 't2' });
    await serviceWritesTwoTables(ctx.prisma, ctx.mark);
    expect(store.order.length + store.notification.length + store.inventoryItem.length, '前置：替身里确实有行').toBe(2);

    const r = await ctx.residual({ settleMs: 0, maxRounds: 2 });
    expect(r.swept, '扫描面必须等于被触碰集合（不是全库 214 张）').toEqual(['Notification', 'Order']);
    expect(r.dirty.map((x) => x.model).sort(), '两张被写的表都要出现在脏清单里').toEqual(['Notification', 'Order']);
    expect(r.dirty.every((x) => x.count > 0), '脏清单里每条都必须带具体命中数（0 不该出现在这里）').toBe(true);
    expect(r.failed, '替身 DMMF 齐备时不该报查询失败').toEqual([]);
  });

  /**
   * ★ v3.13（复核 I-3 的**行为**牙，不是文案牙）：模型在 DMMF 里、客户端却没有委托时，
   *   这张表必须被记成「没数过」，而且**只记一次**。
   *   为什么单列：本批之前基座是静默 `continue`，壳里另外自己推了一条不同措辞的同义失败 ⇒
   *   去重按 `why` 字符串相等判不出来 ⇒ 同一张表进 `failed` 两次（严重度被读数放大）。
   *   上一版我只在守卫里钉了一句文案（`.not.toMatch(/客户端上没有对应委托/)`），复核方当场证伪：
   *   换个措辞加回去，那条断言照样绿 ⇒ **文案牙不算牙**，改钉这里的行为。
   */
  it('★ 表在 DMMF 里、客户端却没有委托 ⇒ failed 恰好一条，且不许被当成脏或干净（B133/I-3）', async () => {
    const { client } = makeStubClient();
    const ctx = createDrillContext({ prefix: 'TEST_C8DG_', client: client as any, runId: 't8dg' });
    await serviceWritesTwoTables(ctx.prisma, ctx.mark);
    expect(ctx.touchedModels(), '前置：Order 与 Notification 都被写过').toEqual(['Notification', 'Order']);
    delete client.order;   // 模拟 B122 真发生时：schema/DMMF 有这张表，生成的客户端里没有这个委托

    const r = await ctx.residual({ settleMs: 0, maxRounds: 1 });
    const orderFails = r.failed.filter((f: any) => f.model === 'Order');
    expect(orderFails.length, `同一张表被记了 ${orderFails.length} 次 ⇒ 严重度被读数放大（去重要按模型，不能按措辞）`).toBe(1);
    expect(r.dirty.map((d: any) => d.model), 'Order 一行都没被数到 ⇒ 既不许出现在脏清单，也不许被当成干净').toEqual(['Notification']);
  });

  it('★ B94 的正身：手写清理清单漏一张表，壳仍然把它报成脏', async () => {
    const { client, store } = makeStubClient();
    const ctx = createDrillContext({ prefix: 'TEST_C7WO_', client: client as any, runId: 't3' });
    await serviceWritesTwoTables(ctx.prisma, ctx.mark);
    // 模拟"该文件手写的 cleanup()"只覆盖了 order 这一张（正是 stockOwnershipDrill 对 userAccount 犯的错）
    const handWrittenCleanupCovers = ['order'];
    await client.order.deleteMany({ where: { id: { contains: ctx.mark } } });

    const r = await ctx.residual({ settleMs: 0, maxRounds: 2 });
    const dirty = r.dirty.map((x) => x.model);
    expect(dirty, 'notification 没进那份手写清单 ⇒ 它必须被报成脏（这就是"少登记一张表会红"）').toContain('Notification');
    expect(dirty, 'order 已被清 ⇒ 不该再出现在脏清单').not.toContain('Order');
    // 恒真检查：若 residual 恒返回脏（例如把 mark 拼错导致永远 0 命中又被当成脏），上面两条都没牙齿
    expect(store.notification.length, '对照：notification 里那行确实还在').toBe(1);
    expect(store.order.length, '对照：order 侧确实被删空了').toBe(0);
  });

  it('★ 反面对照：换一个没写过任何东西的 ctx，residual 必须给空清单（证明上一条不是恒红）', async () => {
    const { client } = makeStubClient();
    const used = createDrillContext({ prefix: 'TEST_C1CT_', client: client as any, runId: 't4a' });
    await used.prisma.order.create({ data: { id: used.id('ORD_1'), note: 'x' } });
    await used.prisma.order.deleteMany({ where: { id: { contains: used.mark } } });

    const idle = createDrillContext({ prefix: 'TEST_C1CT_', client: client as any, runId: 't4b' });
    const a = await used.residual({ settleMs: 0, maxRounds: 2 });
    const b = await idle.residual({ settleMs: 0, maxRounds: 2 });
    expect(a.swept, '用过一次写的 ctx 必须有 touched 集合').toEqual(['Order']);
    expect(b.swept, '没用过的 ctx 集合必须为空 ⇒ "脏为空"这句才有内容').toEqual([]);
    expect(b.dirty).toEqual([]);
    /**
     * ★ B115（v2.94 的 B109 炸点与这条反面对照相撞，只在 server 场域露出来）：
     *   空触碰集合现在**两条都不许** —— 既不许走到 `sweepResidue`（0 分母 ⇒ 抛，那是给"形状传错的调用方"准备的），
     *   也不许悄悄给一个 `dirty=[]` 冒充"数过了"。它必须落在 `failed` 里被点名。
     */
    expect(b.failed.map((x) => x.model), '空触碰集合必须被点名成"没数过"（不是静默的零）').toEqual(['(触碰集合为空)']);
    expect(a.failed, '对照：真正写过并已清干净的 ctx 不许被点名 ⇒ 上面那条不是"只要空就红"的恒红判据').toEqual([]);
    // ★ 关键对照：删干净之后 used 也该是空 —— 否则"漏一张表会红"可能只是"永远报红"
    expect(a.dirty, '清理后按 run 标记必须数到 0 ⇒ 上面那条"抓到漏表"不是恒红判据').toEqual([]);
  });

  /**
   * ★ B116（2026-09-22 复核实测、我复量确认）：**"跑过用例"这件事不能拿 `touchedModels()` 断言。**
   *   `WRITE_OPS` 含 `deleteMany`，而演练的 `afterAll` 是**先 `cleanup()` 再断言** ⇒
   *   清理动作自己就把触碰集合灌满 ⇒ 那句"非空"在任何带清理的演练里**恒真**，
   *   连"整个文件所有 `it` 被 skip"（vitest 照样跑 `afterAll`）都能拿到一个绿色的"零残留"。
   *   ⇒ 壳另暴露一份**只含非删除动词**的 `writtenModels()`；本条同时钉住两侧，
   *     免得修法退化成"永远返回空数组"那种假修。
   */
  it('★ B116：只有删除动作 ⇒ touched 必须非空（清扫面要含它）而 writtenModels 必须为空（这才是"写过业务数据"）', async () => {
    const { client } = makeStubClient();
    const c = createDrillContext({ prefix: 'TEST_C1CT_', client: client as any, runId: 'b116a' });
    await c.prisma.order.deleteMany({ where: { id: { contains: c.mark } } }); // ← 模拟 cleanup() 自己
    expect(c.touchedModels(), '删除确实动过库 ⇒ 清扫面必须包含这张表').toContain('Order');
    expect(c.writtenModels(), '但"本次写过业务数据"必须是空的 ⇒ 演练的非空断言换锚到这里').toEqual([]);
    // 正面对照：同一份壳记到一次 create ⇒ 立刻非空（否则上面那条只是"永远返回空"）
    await c.prisma.order.create({ data: { id: c.id('ORD_1'), note: 'x' } });
    expect(c.writtenModels(), 'create 算写过').toEqual(['Order']);
    // 档位对照：update 算写过、删除不算 —— 两份集合的差就是这条规则
    const d = createDrillContext({ prefix: 'TEST_C1CT_', client: client as any, runId: 'b116b' });
    await d.prisma.order.update({ where: { id: 'x' }, data: {} });
    await d.prisma.order.deleteMany({ where: { id: { contains: d.mark } } });
    expect(d.writtenModels(), 'update 进写入集合').toEqual(['Order']);
    expect(d.touchedModels(), 'touched 比 written 宽（这里同表看不出差别 ⇒ 用长度断言形状没变）').toEqual(['Order']);
  });

  /**
   * ★★ 采纳第一个演练时才暴露出来的洞（所以它单独一条，不混进上面）：
   *   `stockOwnershipDrill.test.ts:36` 建的执行者行是**固定 id**（`TEST_ACTOR_C4OWN`），
   *   **不含行标记** ⇒ 只按"本次 run 的行标记"对撞的判据对它天生失明，而该文件又从不数 userAccount。
   *   壳的处置：执行者也 run 唯一（`actor`），并且 residual 默认把 `mark + actor` 一起当标记。
   *   形状仍留在 `TEST_ACTOR_` 前缀族内 ⇒ v2.63"按前缀族认领 userAccount/auditLog"那条不换口径。
   */
  /**
   * ★ B103 第③步的**可证伪判据**：事务内的写必须出现在触碰集合里。
   *   判据自带反面对照 —— 若有人把回调参数换成外层客户端（写会逃出事务），本测试要能看出区别：
   *   这里断言的是“**回调收到的对象被用过、且写真的落到委托上**”，不是“touched 非空”这种弱读法。
   */
  it('★ 事务内经 tx 的写被记到，且回调拿的是被包装过的事务上下文（B103 第③步）', async () => {
    const { client } = makeStubClient();
    let entered = 0;
    let hitRealDelegate = false;
    (client as any).$transaction = async (arg: any, opts?: any) => {
      entered += 1;
      if (typeof arg === 'function') {
        const tx = { order: { create: async (a: any) => { hitRealDelegate = true; return { id: a.data.id }; } } };
        return arg(tx);
      }
      return Promise.all(arg);
    };
          // 前缀复用已登记族（本测试走桩客户端、不连库）：另起新 MARK 族会被
          // drill-targets-single-source.test.ts 的方向二抓成未认领新族（实测红过一次），
          // 那个反应是对的方向 —— 新族要么进认领清单，要么进已登记未认领族名单并在 diff 里给出理由。
    const ctx = createDrillContext({ prefix: 'TEST_C5SH_', client: client as any, runId: 'tx9' });
    const made = await ctx.prisma.$transaction(async (tx: any) => tx.order.create({ data: { id: ctx.id('ORD_TX') } }));
    expect(entered, '外层必须真的转发进 $transaction（否则“记到”是假的）').toBe(1);
    expect(hitRealDelegate, '回调里对 tx 的写要真的执行到底层委托').toBe(true);
    expect(made, '返回值原样透出（包装不改行为）').toEqual({ id: ctx.id('ORD_TX') });
    expect(ctx.touchedModels(), '事务内的写必须出现在触碰集合（把壳改回原样透传 ⇒ 本条红）').toContain('Order');
    expect(ctx.touchRecords().some((r) => r.model === 'Order' && r.op === 'create'), '触碰记录里要能看见是哪个模型的哪种操作').toBe(true);
  });

  it('★ 执行者行（只有 actor、不带行标记）也必须被数到 —— 否则 userAccount 那一类漏表照样隐身', async () => {
    const { client, store } = makeStubClient();
    const ctx = createDrillContext({ prefix: 'TEST_C4OWN_', client: client as any, runId: 't5' });
    expect(ctx.actor, '执行者必须 run 唯一且仍在 TEST_ACTOR_ 前缀族内').toBe('TEST_ACTOR_C4OWN_t5');
    expect(ctx.actor.startsWith('TEST_ACTOR_'), '前缀族不变 ⇒ 既有认领判据继续有效').toBe(true);

    // 服务内部只写"执行者 + 一条留痕"，留痕行本身不带行标记（真实形态：auditLog.actorId = ACTOR）
    await ctx.prisma.userAccount.create({ data: { id: ctx.actor, note: 'actor row' } });
    const r = await ctx.residual({ settleMs: 0, maxRounds: 2 });
    expect(r.swept, 'userAccount 被写过就必须进扫描面').toEqual(['UserAccount']);
    expect(r.dirty.map((x) => x.model), '只靠 actor 定位的行也必须被报成脏').toEqual(['UserAccount']);
    // 牙齿：删掉执行者行之后必须归零（否则"报脏"是恒红）
    await client.userAccount.deleteMany({ where: { id: { contains: ctx.actor } } });
    const after = await ctx.residual({ settleMs: 0, maxRounds: 2 });
    expect(after.dirty, '删干净后仍报脏 ⇒ 这条判据是恒红，没有内容').toEqual([]);
    expect(store.userAccount.length, '对照：替身里那行确实被删了').toBe(0);
  });

  /**
   * ★ B121（v3.01）：**文件级断言本体的四侧**，喂一个假 ctx 就能打靶 ⇒ 不需要真库、也不需要一次性探针。
   *   为什么必须在这里：v3.00 删掉了 21 份演练各自手抄的那三句 ⇒ 这三句从此**只有这一份实现**，
   *   它的牙如果只靠"跑一次演练 + 手工突变"来证明，那份证据会腐烂（本仓反复犯的老病）。
   */
  it('★ B121：autoAssert 三侧都有牙，且第四侧（全干净）不许恒红', async () => {
    const fake = (written: string[], dirty: Array<{ model: string }>, failed: Array<{ model: string }>) => ({
      writtenModels: () => written,
      touchedModels: () => [...new Set([...written, ...dirty.map((d) => d.model)])].sort(),
      residual: async () => ({ dirty, failed }),
    });
    await expect(autoAssert(fake([], [], [])), '没有任何写入 ⇒ 必须抛').rejects.toThrow(/B121/);
    await expect(autoAssert(fake(['Order'], [{ model: 'EntityLink' }], [])), '有脏表 ⇒ 必须抛并点名那张表').rejects.toThrow(/EntityLink/);
    await expect(autoAssert(fake(['Order'], [], [{ model: 'Notification' }])), '有表数不了 ⇒ 必须抛（不许读成零残留）').rejects.toThrow(/Notification/);
    await expect(autoAssert(fake(['Order'], [], [])), '正对照：有写入、干净、全数得到 ⇒ 不许抛').resolves.toBeUndefined();
  });

  /**
   * 接线钉子（**不是行为证明**）：上面那四条证明 `autoAssert` 有牙，但"它有没有被挂到文件级钩子上"是另一件事。
   * 行为证明来自 v3.00 的实测（`describe.skip` 一份真演练 ⇒ exit 1 并点名 B121）与 21 份绿跑；
   * 这里只防"某次重构顺手把 afterAll 那行删了/条件改错了"这种最可能的腐坏路径。
   */
  it('★ B121：接线还在（`if (!opts.client)` 里登记 autoAssert）—— 只防误删，不证明行为', () => {
    const src = readFileSync(new URL('./lib/drillTouchLog.ts', import.meta.url), 'utf8');
    const at = src.indexOf('if (!opts.client) {');
    expect(at, '登记条件被改名/删掉 ⇒ 文件级断言就不挂了').toBeGreaterThan(-1);
    expect(src.slice(at, at + 220), '条件体里必须挂的是 autoAssert').toContain('afterAll(() => autoAssert(shell))');
  });

  it('★ prefix 形状不合规必须在构造阶段就抛（换形状=换口径，要先去 §9 立账）', () => {
    const { client } = makeStubClient();
    expect(() => createDrillContext({ prefix: 'DRILL-C4_', client: client as any }), '非 TEST<族>_ 前缀必须炸').toThrow(/TEST/);
    expect(() => createDrillContext({ prefix: 'TEST_', client: client as any }), '空族名（会命中整个 TEST 面）必须炸').toThrow(/TEST/);
  });

  /**
   * ★★ B120 第①半：**执行者引用普查**（v3.02）。
   *   病根：为 B119 补的那一条 `notification.deleteMany` 只挡住了**当时会红的那一张** ——
   *   指向 UserAccount 的必选非级联关系实测 **7 张**，任何一张有晚到写入都会把"删账号"抛成一条裸 FK 报错。
   *   ⇒ 普查的模型集合来自 schema 派生：`refs` 的**输入侧**没有任何模型名清单（那是本测试唯一写死名字的地方 ——
   *     期望侧写 `Notification.userId` 是**正面对照**，它同时钉住"派生认得出这张表、且它被判成 blocking"；
   *     若派生漏了它，`blocked` 会空 ⇒ 这条红。派生规则本身由 `scripts/drill-actor-refs.test.ts` 用合成 dmmf 打靶）。
   */
  it('★ B120①：执行者还在库里 ⇒ 普查必须按本次 ACTOR 数、并指名是谁钉住了删账号', async () => {
    const { client } = makeStubClient();
    const ctx = createDrillContext({ prefix: 'TEST_C4OWN_', client: client as any, runId: 'b120a' });
    await ctx.prisma.userAccount.create({ data: { id: ctx.actor, note: 'actor' } });
    // 两行通知：一行挂在**本次**执行者名下，一行挂在别的账号名下 ⇒ 普查只许数到 1（where 条件真的生效）
    await ctx.prisma.notification.create({ data: { id: ctx.id('NTF_MINE'), note: 'mine', userId: ctx.actor } });
    await ctx.prisma.notification.create({ data: { id: ctx.id('NTF_OTHER'), note: 'other', userId: 'someone_else' } });
    // 一行挂在执行者名下的**可空**列（AgentMemory.userId）⇒ 数得到，但不许进 blockers（不挡删账号）
    await ctx.prisma.agentMemory.create({ data: { id: ctx.id('MEM'), note: 'mine', userId: ctx.actor } });

    const refs = await ctx.actorReferences();
    expect(refs.filter((r) => r.count === null).length, '替身只有 5 个委托 ⇒ 其余表必须报"没数到"，不许静默当零')
      .toBeGreaterThan(0);
    const counted = refs.filter((r) => (r.count ?? 0) > 0)
      .map((r) => `${r.model}.${r.fk}=${r.count} blocking=${r.blocking}`).sort();
    expect(counted, '两根列都要按各自列数到 1；blocking 只许给"必选非级联"那一根').toEqual([
      'AgentMemory.userId=1 blocking=false',
      'Notification.userId=1 blocking=true',
    ]);
    const blocked = refs.filter((r) => r.blocking && (r.count ?? 0) > 0);
    expect(blocked.map((r) => `${r.model}.${r.fk}`), '钉住执行者的那张表要被点名，且可空列那张不许混进来').toEqual(['Notification.userId']);

    const r = await ctx.residual({ settleMs: 0, maxRounds: 2 });
    expect(r.actorPinned.accountRows, '执行者账号还在库里 ⇒ 必须报出来').toBe(1);
    expect(r.actorPinned.blockers, '收尾结论里要直接带着"是谁钉住的"').toEqual([{ model: 'Notification', fk: 'userId', count: 1 }]);
    await client.notification.deleteMany({ where: { userId: ctx.actor } });
    await client.agentMemory.deleteMany({ where: { userId: ctx.actor } });
    const after = await ctx.residual({ settleMs: 0, maxRounds: 2 });
    expect(after.actorPinned.blockers, '牙齿：把钉住它的行删掉 ⇒ blockers 必须归零（否则这条是恒红）').toEqual([]);
  });

  /** ★ B120 第②半：脏行**在真用户名下**时必须单列，且三个排除档（本次 ACTOR / 别份演练执行者 / NULL）都要生效 */
  it('★ B120②：只写在真用户名下的那部分算 foreign，别份演练执行者与无主行都不算', async () => {
    const { client } = makeStubClient();
    const ctx = createDrillContext({ prefix: 'TEST_C4OWN_', client: client as any, runId: 'b120b' });
    // `Notification.userId` 真 schema 里**必选** ⇒ 这里只摆三种真实可能的归属（NULL 那种行根本进不了库）
    await ctx.prisma.notification.create({ data: { id: ctx.id('A'), note: 'n', userId: ctx.actor } });
    await ctx.prisma.notification.create({ data: { id: ctx.id('B'), note: 'n', userId: 'real_user_1' } });
    await ctx.prisma.notification.create({ data: { id: ctx.id('C'), note: 'n', userId: 'TEST_ACTOR_OTHER_r1' } });
    // `AgentMemory.userId` **可空** ⇒ "无主行（NULL）"只能在它身上测（v3.02 的 BLOCKER 就是把这档加到了必选列上）
    await ctx.prisma.agentMemory.create({ data: { id: ctx.id('M1'), note: 'n', userId: 'real_user_2' } });
    await ctx.prisma.agentMemory.create({ data: { id: ctx.id('M2'), note: 'n', userId: null } });
    await ctx.prisma.order.create({ data: { id: ctx.id('ORD'), note: 'n' } });

    const r = await ctx.residual({ settleMs: 0, maxRounds: 2 });
    const ntf = r.dirty.find((x) => x.model === 'Notification');
    expect(ntf?.count, '前置：三行都带本次标记 ⇒ 扫描面必须看到 3 行').toBe(3);
    expect(ntf?.foreignOwned, '只有 real_user_1 那一行算"落在真用户名下"（本次 ACTOR 与 TEST_ACTOR_ 族都不算）').toBe(1);
    expect(ntf?.foreignWhy, '这颗 where 必须被真 Prisma 接受 ⇒ 替身对必选列上的 `{col:null}` 会**拒收**（BLOCKER 的钉子在这里）')
      .toBeUndefined();
    const mem = r.dirty.find((x) => x.model === 'AgentMemory');
    expect(mem?.count, '前置：AgentMemory 两行都带标记').toBe(2);
    expect(mem?.foreignOwned, '可空列那一档生效：真用户算、NULL 无主行不算').toBe(1);
    const ord = r.dirty.find((x) => x.model === 'Order');
    expect(ord?.foreignOwned, 'Order 没有挂执行者的列 ⇒ 这一刀**不适用**（null，不是"数过了是 0"）').toBe(null);

    // 牙齿：把行删干净 ⇒ 两侧都归位（否则"报脏/报 foreign"可能只是恒红）
    await client.notification.deleteMany({ where: { id: { contains: ctx.mark } } });
    await client.agentMemory.deleteMany({ where: { id: { contains: ctx.mark } } });
    await client.order.deleteMany({ where: { id: { contains: ctx.mark } } });
    const after = await ctx.residual({ settleMs: 0, maxRounds: 2 });
    expect(after.dirty, '对照：清干净之后不许还有脏表').toEqual([]);
  });

  /** ★ B120 的**红话**分档：两种成因处置相反 ⇒ 消息必须能区分（这条同时防"消息恒含某句"的假修） */
  it('★ B120：红话要分档 —— "别人名下"必须说不许自行删，普通脏不许带这句', () => {
    const mine = residualFailureMessage({ dirty: [{ model: 'Order', count: 2, foreignOwned: null }], touched: ['Order'] });
    expect(mine).toContain('Order:2');
    expect(mine, '普通脏的修法是本文件补一条定向删除 ⇒ 不许同时喊"删不得"').not.toContain('不许自行删');
    const theirs = residualFailureMessage({ dirty: [{ model: 'Notification', count: 3, foreignOwned: 3 }], touched: ['Notification'] });
    expect(theirs, '全在真用户名下 ⇒ 必须说不许自行删').toContain('不许自行删');
    const pinned = residualFailureMessage({
      dirty: [{ model: 'UserAccount', count: 1, foreignOwned: null }], touched: ['UserAccount'],
      actorPinned: { accountRows: 1, blockers: [{ model: 'AuditLog', fk: 'actorId', count: 7 }], uncountable: [] },
    });
    expect(pinned, '红话里要直接出现"是哪张表几行钉住了执行者"').toContain('AuditLog.actorId=7 行');
    const mixed = residualFailureMessage({ dirty: [{ model: 'Notification', count: 5, foreignOwned: 2 }], touched: [] });
    expect(mixed).toContain('其中 2 行');
    expect(mixed, '只有一半在别人名下 ⇒ 不许说成"全都删不得"（那会放掉该自己清的那一半）').not.toContain('不许自行删');
  });
});
