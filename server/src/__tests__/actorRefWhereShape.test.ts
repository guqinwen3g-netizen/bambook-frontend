/**
 * ★ B120 / v3.02：**拿真 Prisma 校验普查与 foreign 那一刀的 where 形状。**
 *
 * 为什么要有这个文件（不是重复 `drillTouchLog.test.ts`，是补它测不到的那一半）：
 *   那 13 颗 count 与 foreign 的 AND/NOT 都只跑在手搓替身上，而**替身听得懂 `{ col: null }`、真 Prisma 听不懂** ——
 *   必选列上放 `null` 会让整条 where 被拒（实测：`notification.count(...)` ⇒ `Argument \`userId\` is missing.`）。
 *   ⇒ 上一批的形状是"单测 13 例全绿、真库里那一刀永远数不到"。这条测试就是把**只有真客户端能给的证据**入门禁。
 *
 * ⚠️ 本文件**一行都不写**：全程 `count`（含只读的 `findMany` 取一个"已知非零对照"用的 actor id）。
 *    所以它不进 B35 的候选集（候选按"代码行里自造 `TEST_<族>_` 标记"认，这里一个那种字面量都没有；
 *    `DRILL_ACTOR_PREFIX` 从基座取，不在此处手抄）⇒ 也不会给 §12.1 第 25/26 条那本残留账添新行。
 * ⚠️ 它**需要** `DATABASE_URL`（server 场域本来就连库跑演练）。没有 env 时会以连接错误红 ⇒ 那是环境问题，
 *    按 §9.1 的取证纪律写清"哪一道门禁、什么环境"，不要改写成"这条判据没用"。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  actorRefRelations, markerOwnedElsewhereWhere, DRILL_ACTOR_PREFIX,
} from '../../../scripts/lib/drill-residue.mjs';
import { noBackendMessage, safeResidualCounts } from './lib/drillTouchLog';

const db = new PrismaClient();
const MODELS = (Prisma as any).dmmf.datamodel.models as any[];
const RELS = actorRefRelations(MODELS);
const defOf = (name: string) => MODELS.find((m) => m.name === name);
const delegateOf = (name: string) => (db as any)[name.charAt(0).toLowerCase() + name.slice(1)];
// 探针用的 id 拼不出来自任何族：加不了标记、也不会有人认领它 ⇒ 所有 count 都该是 0，但**必须能数**
const PROBE_ACTOR = `${DRILL_ACTOR_PREFIX}shape_probe_no_such_row`;
const NO_MARKER = '__definitely_not_a_real_marker__';

afterAll(async () => { await db.$disconnect(); });

describe('B120：普查与 foreign 的 where 形状必须被真 Prisma 接受（替身测不到的那一半）', () => {
  it('★ 派生不为空（空 = 尺瞎了，后面每一条都会变成恒绿的 0 循环）', () => {
    expect(RELS.length, '一条指向 UserAccount 的 FK 侧关系都没派生出来 ⇒ 普查没内容').toBeGreaterThan(0);
    expect(RELS.filter((r) => r.blocking).length, 'blocking 集合为空 ⇒ "没人钉住执行者"这句话就是假的').toBeGreaterThan(0);
  });

  it('★ 逐根列 count 执行者引用：Prisma 不许拒（必选列上塞 null 的那种修法会在这里红）', async () => {
    // ★ v3.31（B151）：这一格的 `errs` 桶本来就分不出"库不可达"与"这列数不了"——两样都进同一个桶、
    //   都只让这一格红。交给基座 ⇒ 连接类错误走**第三态**（NO_BACKEND），别的错照旧抛（fail-closed 不变），
    //   而"根本没跑出读数"由下面那条 `Object.keys(values).length` 兜住，语义比原来更窄也更准。
    //   ⚠️ 只搬这一格：`② 逐模型构造 foreign 的 where` 那格有"没有可承载标记的列 ⇒ 不适用"的跳过逻辑，
    //   以及 `applicable > 0` 这条防"恒绿"的前置断言 —— 那是另一件事，保持原样。
    const got = await safeResidualCounts(RELS.map((r: any) => ({
      key: `${r.model}.${r.fk}`, model: r.model,
      run: () => delegateOf(r.model).count({ where: { [r.fk]: PROBE_ACTOR } }),
    })));
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.dirty, `探针 id 本不该被任何列引用，却数到了行：${got.dirty.join('；')}`).toEqual([]);
    expect(Object.keys(got.values).length,
      `只有 ${Object.keys(got.values).length} 根列跑出了读数，应为 ${RELS.length} 根 ⇒ 有列根本没被数到（盲区，不是"它没有引用"）`)
      .toBe(RELS.length);
  });

  it('★ 逐模型构造 foreign 的 where 并真的数一遍：不许拒、结果必须是数', async () => {
    const errs: string[] = [];
    let applicable = 0;
    for (const model of [...new Set(RELS.map((r) => r.model))]) {
      const rels = RELS.filter((r) => r.model === model);
      const where = markerOwnedElsewhereWhere(defOf(model), [NO_MARKER], rels, PROBE_ACTOR);
      if (where === null) { errs.push(`${model}: 该表有挂执行者的列却没有可承载标记的 String 列 ⇒ 这一刀不适用，需要单独解释`); continue; }
      applicable += 1;
      try { expect(await delegateOf(model).count({ where })).toBe(0); }
      catch (e) { errs.push(`${model}: ${String((e as any)?.message ?? e).replace(/\s+/g, ' ').slice(0, 90)}`); }
    }
    expect(applicable, '一个能数的模型都没有 ⇒ 下面那条"不许拒"会恒绿').toBeGreaterThan(0);
    expect(errs, 'foreign 那颗 where 在真客户端上被拒 ⇒ 单测绿也没用（v3.02 BLOCKER 的形状）').toEqual([]);
  });

  it('★ 已知非零对照：上面那些 0 是因为探针不存在，不是因为查询恒零', async () => {
    // 库里确有演练执行者（§12.1 第 25 条那本账）⇒ 按前缀取一个真 id，再问"谁钉着它"必须数得到东西
    const actors = await db.userAccount.findMany({
      where: { id: { startsWith: DRILL_ACTOR_PREFIX } }, select: { id: true }, take: 5,
    });
    expect(actors.length, '库里一个演练执行者都没有 ⇒ 这条对照失去输入，不能读成"普查没问题"（B109 同族）').toBeGreaterThan(0);
    const ids = actors.map((a: any) => a.id);
    let maxOnOne = 0;
    for (const r of RELS) {
      const n = await delegateOf(r.model).count({ where: { [r.fk]: { in: ids } } });
      maxOnOne = Math.max(maxOnOne, n);
    }
    expect(maxOnOne, '13 根列对 5 个真执行者全部数到 0 ⇒ 与 §9.1 记的"Notification 钉住演练账号"矛盾 ⇒ 先疑尺').toBeGreaterThan(0);
  });
});
