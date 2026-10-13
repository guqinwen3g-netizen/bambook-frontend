/**
 * B184（v3.72）：兜底清扫那一路也要交"删了哪几行"——行级台账的**行为**守卫。
 *
 * 病（第十一程实测）：链上手写清单那 32 处 `tryDel` 接了预读，而 `cleanResidue` 没接 ⇒
 * `AgentJob/Notification/ProductionStage` 三张共 422 行整表落进"判不了"，
 * 行级守恒的覆盖面被这 422 行挡住（v3.71 banner 里那条 B184）。
 *
 * ★ 不连库：`Prisma` 传手搓的 dmmf 形状、`prisma` 传手搓 delegate ⇒ 本文件从仓根跑也不碰
 *   `panda_hub_local`（同族约束见 `drill-targets-single-source.test.ts`）。
 * ★ 每条守卫都配"改回旧行为就会红"的反面：预读摘掉 / 不等长却照记 ⇒ 当场红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanResidue } from './lib/drill-residue.mjs';
import { stripComments } from '../server/scripts/lib/errorDebtScanners.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'FakeSweepTable';
const KEY = 'fakeSweepTable';
const MARK = 'TEST_B4X_';
const FAKE_PRISMA = {
  dmmf: { datamodel: { models: [{ name: MODEL, fields: [
    { name: 'id', kind: 'scalar', type: 'String' },
    { name: 'note', kind: 'scalar', type: 'String' },
    { name: 'createdAt', kind: 'scalar', type: 'DateTime' },
  ] }] } },
};
const markRow = (id: string, ago: number) => ({ id, note: `${MARK}x`, createdAt: new Date(Date.now() - ago) });

/** 一个"删得掉、读得到"的桩：记录两侧收到的谓词，供"同构"断言用 */
const stub = (opts: { found?: any[]; count?: number; readThrows?: boolean } = {}) => {
  const seen: { op: string; where: any; select?: any }[] = [];
  // ★ 桩要"删一次就空"：cleanResidue 是多轮收敛的（maxPasses=8）；若每轮都返回同一批行，
  //   台账与 byModel 都会按轮次累加（第一版就是被 16/8 这种数骗到的）。
  let drained = false;
  const delegate = {
    count: async (a: any) => { seen.push({ op: 'count', where: a.where }); return drained ? 0 : (opts.found ?? []).length; },
    findMany: async (a: any) => {
      seen.push({ op: 'findMany', where: a.where, select: a.select });
      if (opts.readThrows) throw new Error('read boom');
      return drained ? [] : (opts.found ?? []);
    },
    deleteMany: async (a: any) => {
      seen.push({ op: 'deleteMany', where: a.where });
      const n = drained ? 0 : (opts.count ?? 0);
      drained = true;
      return { count: n };
    },
  };
  return { seen, prisma: { [KEY]: delegate } as any };
};

describe('B184 · cleanResidue 的行级台账（删除前同谓词预读）', () => {
  it('正例：删几行就报几行，且预读与实删共用同一个 where', async () => {
    const found = [markRow('a', 1000), markRow('b', 2000)];
    const { seen, prisma } = stub({ found, count: 2 });
    const out: any = {};
    const r = await cleanResidue({ prisma, Prisma: FAKE_PRISMA, markers: [MARK], deletedRowsOut: out });
    expect(r.byModel[MODEL], '桩里确实删掉了 2 行（否则下面全是空断言）').toBe(2);
    expect(out[MODEL].broken).toBe(false);
    expect(out[MODEL].rows.map((x: any) => x.id).sort()).toEqual(['a', 'b']);
    expect(out[MODEL].rows.every((x: any) => x.createdAt instanceof Date), '有 createdAt 的表要把 createdAt 带出来').toBe(true);
    const rd = seen.find((x) => x.op === 'findMany');
    const dl = seen.find((x) => x.op === 'deleteMany');
    expect(dl, '桩没被 deleteMany 打到 ⇒ 守卫空转').toBeTruthy();
    expect(JSON.stringify(rd!.where), '预读谓词 ≠ 删除谓词 ⇒ 台账记的就不是实删的那批行').toBe(JSON.stringify(dl!.where));
  });
  it('★ 不等长（实删比预读多）⇒ 整张记 broken，绝不"看见多少算多少"', async () => {
    const { prisma } = stub({ found: [markRow('a', 1000)], count: 3 });
    const out: any = {};
    await cleanResidue({ prisma, Prisma: FAKE_PRISMA, markers: [MARK], deletedRowsOut: out });
    expect(out[MODEL].broken).toBe(true);
    expect(out[MODEL].rows.length, 'broken 的表不许还留着半截行数（半截会被上层算成"已核")').toBe(0);
  });
  it('★ 预读抛错 ⇒ 这一张整个跳过（改造前就是这行为），台账里没有它 ⇒ 上层只能按"判不了"处理', async () => {
    const { seen, prisma } = stub({ readThrows: true, count: 2 });
    const out: any = {};
    const r = await cleanResidue({ prisma, Prisma: FAKE_PRISMA, markers: [MARK], deletedRowsOut: out });
    expect(r.byModel[MODEL], '读不出 id 就连删都跳过（原有语义，本批不许顺手改成"照删不误"）').toBeUndefined();
    expect(seen.some((x) => x.op === 'deleteMany'), '没读到 id 就不该发生删除').toBe(false);
    expect(out[MODEL], '台账里根本没有这张表 ⇒ 链上合并规则会把它算成 null（判不了），不是 0 行').toBeUndefined();
  });
  it('没传 deletedRowsOut（其余调用方的现况）⇒ 行为与改造前一致，不许因此抛错', async () => {
    const { prisma } = stub({ found: [markRow('a', 1)], count: 1 });
    const r = await cleanResidue({ prisma, Prisma: FAKE_PRISMA, markers: [MARK] });
    expect(r.byModel[MODEL]).toBe(1);
  });
  it('★ 链上接线：settleAndClean 要拿到 out、且合并规则要求"行数之和 == 自报行数"', () => {
    const src = stripComments(readFileSync(join(REPO, 'scripts/acceptance-e2e-business-chain.mjs'), 'utf8')).replace(/\s+/g, ' ');
    expect(src, '链没把 deletedRowsOut 交给 settleAndClean ⇒ 清扫那 422 行还是整表判不了').toMatch(/deletedRowsOut:\s*SWEEP_ROWS/);
    expect(src, '合并规则没要求等长 ⇒ 半截台账会被当成"已核过"').toMatch(/b\.rows\.length === reported/);
    expect(src, '清扫侧 broken 没参与合并判据').toMatch(/v && v\.broken\) b\.broken = true/);
    // ★ v3.74（复核 #17 B-2）：两通道的键必须先归一再对账，否则"有 3 行、报 0 行"能两头读成 0
    expect(src, '合并前没做命名归一 ⇒ camel 台账桶配 Pascal 自报数，两边都读成 0').toMatch(/canonModel\(k\)/);
    expect(src, '对不上账没有单独读数 ⇒ 静默放行没人喊疼').toMatch(/deletedUnreconciled: DEL_UNRECONCILED/);
    const lib = stripComments(readFileSync(join(REPO, 'scripts/lib/drill-residue.mjs'), 'utf8'));
    expect(lib.replace(/\s+/g, ' '), 'settleAndClean 没把选项透传给 cleanResidue ⇒ 链上接了个空')
      .toMatch(/cleanResidue\(\{[\s\S]{0,140}?deletedRowsOut\s*\}\s*\)/);
  });
});
describe('B184 续（v3.73）· ① 级联那处的预读也要带 createdAt', () => {
  // ★ 诚实标注：下面两格是**源码形状** pin，不是行为证人。手搓桩进不到 ① 那条臂
  //   （`cleanResidue` 前置的标记安全检查把这组桩挡掉了 ⇒ 探针 trace 全空），而我不会为了迁就桩
  //   去改那道检查。行为证据 = 真跑的 `判不了行数`（第十二程 52 行、全部来自这条臂），见台账 v3.73。
  const libSrc = stripComments(readFileSync(join(REPO, 'scripts/lib/drill-residue.mjs'), 'utf8'));
  const count = (needle: string) => libSrc.split(needle).length - 1;
  const SELECT = "select: hasCreated ? { id: true, createdAt: true } : { id: true }";
  const GUARD = "const hasCreated = !!(md && (md.fields || []).some((x) => x.name === 'createdAt'));";
  it('两处预读都按 DMMF 决定要不要带 createdAt（① 级联与 ② 标识扫各一处）', () => {
    expect(count(SELECT), '预读 select 的数量变了 ⇒ 有一条臂又回到只读 id（那 52 行会重新变成判不了）').toBe(2);
    // ② 用的是 modelDef 直接可见，① 走 modelsByKey 索引；两处都必须在
    expect(libSrc.includes('const hasCreated = (modelDef.fields || []).some'), '② 的 DMMF 判断被摘了').toBe(true);
    expect(libSrc.includes(GUARD), '① 的 DMMF 判断被摘了 ⇒ 级联那张表永远拿不到 createdAt').toBe(true);
    expect(count('modelsByKey[delegateKey(md.name)] = md'), '索引没建起来 ⇒ ① 的 hasCreated 恒 false').toBe(1);
  });
  it('★ 三处删除点都记账，且两处带等长校验（少一处就是给那张表开盲区）', () => {
    // 三处删除点各两个分支（等长记账 / 不等长记 broken）⇒ 6 个调用点。少任何一个就是一张表的盲区。
    expect(count('recordDeletedRows(deletedRowsOut'), 'recordDeletedRows 调用点数变了（3 处 × 2 分支）').toBe(6);
    // ★ v3.74（复核 #17 B-1）：③ 那条 Json 臂必须把 createdAt 读回来并记**取到的行**（不是裸 id）
    expect(count('createdAt: null'), '③ 又回到硬写 createdAt: null ⇒ 那 52 行永远判不了').toBe(0);
    expect(count('recordDeletedRows(deletedRowsOut, modelDef.name, hit)'), '③ 记的是裸 id 而不是带 createdAt 的行').toBe(1);
    expect(libSrc.includes('...(jHasCreated ? { createdAt: true } : {})'), 'Json 切片的 select 没按 DMMF 带上 createdAt').toBe(true);
    expect(count('=== r.count) recordDeletedRows'), '① 或 ② 的等长校验没了 ⇒ 半截台账会被当成已核').toBe(2);
    expect(count('count === ids.length) recordDeletedRows'), '③（按 id 批删）的等长校验没了').toBe(1);
  });
});
