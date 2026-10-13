/**
 * B35 基座扫描的**失败可见性**守卫（复核 B-1 的处置，v2.76）。
 *
 * 病（实测，不是设想）：`sweepResidue` 里两处 `catch { x = 0 }` 把“**这张表数不了**”
 * 直接翻译成“这张表干净”⇒ 上层拿到 `hits=[]` 就打印“零残留”。
 * 复核方给的复现：健康桩 `hits=[CreditNote:7]`，抛错桩 `hits=[]` —— 两者**看起来一样干净**。
 *
 * 修法：计数/切片抛错时经 `unreadableOut` 把失败带出去（调用方决定红还是降级）。
 *
 * ★ 本文件就是那条“会红的守卫”：如果把基座改回 `catch { x = 0 }`（不再 push），
 *   下面第 2 条断言当场红 ⇒ 这不是恒真判据，而是**改回旧行为就会红**的判据。
 * ★ 不连库：`Prisma` 传的是**手搓的 dmmf 形状**（`sweepResidue` 只读 `dmmf.datamodel.models`），
 *   所以本文件从仓库根跑也不会碰 `panda_hub_local`（同族约束见 `drill-targets-single-source.test.ts` 的“不连库”那条）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sweepResidue } from './lib/drill-residue.mjs';
import { runAudit, AUDIT_MARKERS, DEMO_DATASET_MARKERS } from './audit-drill-residue.mjs';
import { ENTITY_TYPES } from '../server/src/entities/registry';
import { stripComments } from '../server/scripts/lib/errorDebtScanners.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const MODEL = 'FakeDrillTable';
const KEY = 'fakeDrillTable';
/** 只要一个 String 列 ⇒ 走 `count({OR:[...]})` 那条路（正是当年被静默吞掉的那条） */
const FAKE_PRISMA = { dmmf: { datamodel: { models: [{ name: MODEL, fields: [{ name: 'id', kind: 'scalar', type: 'String' }] }] } } };
const MARKS = ['TEST_B1X_'];

const sweepWith = async (impl: any, opts: any = {}) => {
  const unreadable: any[] = [];
  const hits = await sweepResidue({
    prisma: { [KEY]: impl },
    Prisma: FAKE_PRISMA,
    markers: MARKS,
    withFamily: false,
    unreadableOut: opts.noOut ? null : unreadable,
  });
  return { hits, unreadable };
};

describe('B35 基座：扫不动的表必须被记成"数不了"，不许冒充零残留（B-1）', () => {
  /**
   * ★ v2.93 / B109：把"扫到 0 张表"和"扫了 N 张表都干净"分开。
   *   成因是我自己做只读取证时的真实误用：`Prisma` 少传一层 `dmmf` ⇒ 循环不进 ⇒ `hits=[]` 且
   *   `unreadable=[]` ⇒ 上层读成"零残留"，而同一份数据用对形状读到的是 2424 行。
   *   下面三条：错形状必须**炸**、空 markers 必须**炸**、对形状必须**仍能数到命中**（正向对照，
   *   防止"一炸了之"被当成修好了）。
   */
  it('②c 表在 DMMF 里、客户端却没有 delegate ⇒ 报"一行都没被数过"，不许静默 continue（v3.13 B133 同族）', async () => {
    const unreadable: any[] = [];
    const hits = await sweepResidue({
      // 只给 FakeA 的 delegate：FakeB 在 DMMF 里存在，但客户端拿不到 ⇒ 旧代码 `continue`，两边都看不见
      prisma: { fakeA: { count: async () => 0, findMany: async () => [] } } as any,
      Prisma: { dmmf: { datamodel: { models: ['FakeA', 'FakeB'].map((name) => ({ name, fields: [{ name: 'id', kind: 'scalar', type: 'String' }] })) } } } as any,
      markers: MARKS, withFamily: false, unreadableOut: unreadable,
    });
    expect(hits.map((h: any) => h.model), '被跳过的表不该出现在命中里（这点旧行为也对）').toEqual([]);
    expect(unreadable.map((u: any) => u.model), '但必须被记成"没数过"，否则"零命中"又被读成"零残留"').toEqual(['FakeB']);
    expect(String(unreadable[0].why)).toMatch(/一行都没被数过/);
    // ★ 复核 I-3：壳原先自己再推一条**不同措辞**的同类失败 ⇒ 同一张表进 `failed` 两次、严重度翻倍。
    //   这里钉"这条知识只剩一处"：壳里不许再出现那句自推的文案（把那条 push 加回去，本条立刻红）。
    const SHELL = readFileSync(join(REPO, 'server/src/__tests__/lib/drillTouchLog.ts'), 'utf8');
    expect(stripComments(SHELL), '壳里不许再自己推一条「客户端没有委托」的同类失败（去重按 why 相等，措辞不同就躲过去了）')
      .not.toMatch(/客户端上没有对应委托/);
  });

  it('③ 模型分母为空 ⇒ 当场抛，绝不返回"干净"（B109）', async () => {
    await expect(sweepResidue({
      prisma: { [KEY]: { count: async () => 0, findMany: async () => [] } },
      Prisma: { datamodel: { models: FAKE_PRISMA.dmmf.datamodel.models } }, // ← 少一层 dmmf，正是我踩到的形状
      markers: MARKS,
    })).rejects.toThrow(/扫到 0 个模型/);
  });

  it('④ markers 传空 ⇒ 抛（那会让任何计数恒为 0 = 恒绿判据）', async () => {
    await expect(sweepResidue({ prisma: { [KEY]: { count: async () => 0 } }, Prisma: FAKE_PRISMA, markers: [] }))
      .rejects.toThrow(/markers 为空/);
  });

  /**
   * ★ v2.94 / B110：两条通道必须取**并集**，不能把同一物理行数两次。
   *   实测踩法：`EntityLink` 真 1212 行，`sweepResidue` 报 **2424** —— 因为 Json 切片的 select 里带 `id`，
   *   而 `id` 自己含演练标识 ⇒ 每个字符串命中必然再被 Json 通道命中一次。
   *   下面两条：① Json 查询必须带上「排除字符串通道已命中行」的 where（结构判据，改回相加就红）；
   *           ② 纯 Json 模型（无 String 列可筛）不得被这个 where 误伤（否则等于把 Json 通道关掉 = 假零）。
   */
  it('⑥ Json 通道必须排除已被字符串通道命中的行（B110 去重）', async () => {
    const seen: any[] = [];
    const mixed = {
      dmmf: { datamodel: { models: [{ name: MODEL, fields: [
        { name: 'id', kind: 'scalar', type: 'String' },
        { name: 'meta', kind: 'scalar', type: 'Json' },
      ] }] } },
    };
    const unreadable: any[] = [];
    const hits = await sweepResidue({
      prisma: { [KEY]: { count: async () => 5, findMany: async (a: any) => { seen.push(a); return []; } } },
      Prisma: mixed, markers: MARKS, withFamily: false, unreadableOut: unreadable,
    });
    // ★ 不写死调用次数：命中数 > 0 时基座还会再发一次"取样本"的查询 ⇒ 这里只要求
    //   **至少有一次** Json 切片查询带上了去重条件（写死 1 会把那条正常取样本的查询也算成 bug）。
    const slice = seen.find((a: any) => a?.select && 'meta' in a.select);
    expect(slice, 'Json 通道没发出带 select(meta) 的切片查询 ⇒ 它被跳过了（那才是假零）').toBeTruthy();
    const w = slice?.where;
    expect(Array.isArray(w?.NOT?.OR), `Json 查询必须带 NOT(字符串命中) 才不重复计，拿到的是 ${JSON.stringify(w)}`).toBe(true);
    expect(w.NOT.OR[0], '排除条件要落在同一个标记上').toHaveProperty('id');
    expect(hits.map((h: any) => `${h.model}:${h.count}`), '字符串 5 行 ⇒ 去重后报 5，不是 10').toEqual([`${MODEL}:5`]);
  });

  it('⑦ 纯 Json 模型不受去重影响（不许把 Json 通道顺手关掉）', async () => {
    const seen: any[] = [];
    const jsonOnly = {
      dmmf: { datamodel: { models: [{ name: MODEL, fields: [{ name: 'payload', kind: 'scalar', type: 'Json' }] }] } },
    };
    await sweepResidue({
      prisma: { [KEY]: { findMany: async (a: any) => { seen.push(a); return [{ id: '1', payload: { x: MARKS[0] } }]; } } },
      Prisma: jsonOnly, markers: MARKS, withFamily: false, unreadableOut: [],
    });
    expect(seen.length).toBe(1);
    expect(seen[0].where, '无字符串列可筛 ⇒ 不该塞 where，否则 Json 面被整块关掉').toBeUndefined();
  });

  it('⑤ 正向对照：形状传对时仍能真的数到命中（防止"只会炸"冒充修好）', async () => {
    const r = await sweepWith({ count: async () => 7, findMany: async () => [] });
    expect(r.hits.map((h) => `${h.model}:${h.count}`), '桩里数到 7 就必须报 7').toEqual([`${MODEL}:7`]);
    expect(r.unreadable).toEqual([]);
  });

  it('① 健康桩：既无命中也无"数不了"（否则第 ② 条的"红"没有对照）', async () => {
    const r = await sweepWith({ count: async () => 0, findMany: async () => [] });
    expect(r.hits, '健康桩应当真的数到零').toEqual([]);
    expect(r.unreadable, '健康桩不该被记成数不了（若这里非空，第 ② 条就失去意义）').toEqual([]);
  });

  it('② 计数抛错 ⇒ 必须经 unreadableOut 带出去（把基座改回 catch{x=0} 时这条当场红）', async () => {
    const r = await sweepWith({
      count: async () => { throw new Error('boom：该列不可比较'); },
      findMany: async () => [],
    });
    expect(r.hits, '旧行为下这里是 [] ⇒ 看起来"干净"，这正是要禁掉的形状').toEqual([]);
    expect(r.unreadable.map((x) => x.model), '抛错必须被点名到具体是哪张表数不了').toEqual([MODEL]);
    expect(String(r.unreadable[0].why), '理由里要带上原始报错，否则排查时又变成一句空话')
      .toContain('boom：该列不可比较');
  });

  /**
   * ★ v2.90：把 B-1 的**第二条通道**也钉住。`sweepResidue` 有两处 catch（String 计数 / Json 切片），
   *   v2.76 只测了前者 ⇒ 这条补测“只有 Json 列可扫”的模型：切片抛错必须同样被点名。
   *   没有它，改回 `catch { jsonRows = [] }` 只会静默放过一整类表（Json-only 的表恰好是最容易藏标记的）。
   */
  it('②b Json 切片抛错也必须被记成数不了（B-1 的第二条通道）', async () => {
    const jsonOnly = {
      dmmf: { datamodel: { models: [{
        name: 'FakeJsonTable',
        fields: [
          { name: 'id', kind: 'scalar', type: 'String' },
          { name: 'payload', kind: 'scalar', type: 'Json' },
          { name: 'createdAt', kind: 'scalar', type: 'BigInt' },
        ],
      }] } },
    };
    const out: any[] = [];
    const hits = await sweepResidue({
      prisma: { fakeJsonTable: {
        count: async () => 0,
        findMany: async () => { throw new Error('boom：Json 列不能这么比'); },
      } },
      Prisma: jsonOnly as any,
      markers: ['TEST_B1X_'], withFamily: false, unreadableOut: out,
    });
    expect(hits, '旧行为这里是 [] 且不带任何告警 ⇒ 看起来“干净”').toEqual([]);
    expect(out.map((x: any) => x.model), 'Json 切片的失败必须被点名到表').toEqual(['FakeJsonTable']);
    expect(String(out[0].why), '理由要指到 Json 那条路，而不是被 String 那条混淆').toContain('Json');
  });

  it('③ 不传 unreadableOut 的老调用方行为不变（不炸、也不静默改返回值形状）', async () => {
    const r = await sweepWith({
      count: async () => { throw new Error('boom2'); },
      findMany: async () => [],
    }, { noOut: true });
    expect(Array.isArray(r.hits), '返回值仍是数组（删除器/诊断脚本按数组在吃）').toBe(true);
    expect(r.hits).toEqual([]);
  });
});

/**
 * ★★ v3.13（B120 未闭环的那一半：`audit-drill-residue.mjs` 那份手抄普查器的收编）
 *
 * 收编前量到的账（只读 DMMF，不连库，2026-09-23）：库里 **225 个模型 / 2282 个 String 列**，
 * 而那份手写清单只看 **12 个模型名 / 19 列 = 0.8%**；其中 `customerRelation`、`supplierRelation`
 * **在 DMMF 里根本没有对应模型** ⇒ 每次跑都是"`catch {}` 吞掉 ⇒ 看起来查过且干净"。
 * ⇒ 与本文件上面那族是**同一个病**（"数不了"被翻译成"干净"），只是这次病在**读数口自己抄了一份清单**。
 * 修法：读数口只留 `sweepResidue()` 一份；审计器改成它的薄壳；数不了 ⇒ `exitCode` 非零。
 */
describe('v3.13 B120 收编：只读审计器不许是第二份普查实现，也不许把"数不了"报成零残留', () => {
  const SRC = readFileSync(join(REPO, 'scripts/audit-drill-residue.mjs'), 'utf8');
  const CODE = stripComments(SRC);

  it('① 形状：手抄清单/绝对路径已消失，读数只能来自基座那一份', () => {
    expect(CODE, '审计器必须走基座唯一的扫描器（否则又是一份并行真源）').toContain('sweepResidue(');
    // 复核 I-3：解析「表在不在客户端里」的键拼写也只此一份（审计器原先自己写了第 6 份 lowerFirst）
    expect(CODE, '委托键的拼写必须来自基座（`delegateKey`），不许在审计器里再写一遍 charAt(0).toLowerCase()')
      .toMatch(/delegateKey\(/);
    expect(CODE, '不许再自带"模型 × 列"的手写清单（这次的根因就是它漂在真源之外）').not.toMatch(/\[\s*'[a-z][A-Za-z]*'\s*,\s*\[/);
    expect(CODE, '不许再手写悬挂检查的 targetType 对（改成从库里派生）').not.toMatch(/const PAIRS/);
    expect(SRC, '绝对路径会让"守卫在一棵树、读数在另一棵树"（B85 那一课）').not.toMatch(/\/Users\//);
  });

  /** 两模型一列的替身 DMMF：够算分母，也够制造"一张数得了、一张数不了" */
  const PrismaStub = (models: any[]) => ({ dmmf: { datamodel: { models } } });
  const M = (name: string, cols: string[] = ['id']) => ({ name, fields: cols.map((c) => ({ name: c, kind: 'scalar', type: 'String' })) });

  it('② 行为：有一张表数不了 ⇒ unreadable 非空且 exitCode 非零（"零命中"不等于"干净"）', async () => {
    const r = await runAudit({
      prisma: {
        fakeA: { count: async () => 0, findMany: async () => [] },
        fakeB: { count: async () => { throw new Error('boom 权限不够'); }, findMany: async () => [] },
        $queryRawUnsafe: async () => [],
      } as any,
      Prisma: PrismaStub([M('FakeA'), M('FakeB')]) as any,
    });
    expect(r.modelsScanned, '分母由 DMMF 派生（两个 ⇒ 2）').toBe(2);
    expect(r.stringColsScanned).toBe(2);
    expect(r.hits, '两表都"没有命中"（一表数不了）⇒ 命中集为空是对的').toEqual([]);
    // ★ 三条计数通道（残留串列 / 残留族检测已随 withFamily 走 / 演示数据集通道）各算各的，
    //   不许合并成一条 —— 合并就等于把"另一个通道也数不了"这件事藏掉
    expect(r.unreadable.map((u: any) => u.model).sort(), '每一次数失败都要各自点名（串列计数 / 族检测 / 演示数据集通道）')
      .toEqual(['FakeB', 'FakeB', 'FakeB（演示数据集通道）']);
    expect(r.exitCode, '数不了 ⇒ 退出码非零（这条就是"零命中不许说干净"的落点）').not.toBe(0);
    expect(r.exitCode, '★ 有表数不了却退出 0 ⇒ 上层就能说"零残留"，这正是 B-1/B109 的洞').not.toBe(0);
  });

  it('②b 口径纪律：演示数据集不算残留（与删除器同一立场），但要单列看得见', async () => {
    expect(AUDIT_MARKERS, 'SIM- 混进残留集 ⇒ 1307 变 38093，这个读数就再也没人信了（也与删除器口径分叉）').not.toContain('SIM-');
    expect(DEMO_DATASET_MARKERS).toEqual(['SIM-']);
    const r = await runAudit({
      prisma: {
        // 按"这一遍问的是哪套标记"分流：含 SIM- 的那一遍算 4 条，其余算 0 条（不猜 where 的内部形状）
        fakeA: { count: async (a: any) => (JSON.stringify(a ?? '').includes('SIM-') ? 4 : 0), findMany: async () => [] },
        $queryRawUnsafe: async () => [],
      } as any,
      Prisma: PrismaStub([M('FakeA')]) as any,
    });
    expect(r.hits.reduce((a: number, h: any) => a + h.count, 0), '残留总数里不许含演示数据').toBe(0);
    expect(r.demoTotal, '演示数据集那一边必须单独数出来（不是删掉不看）').toBe(4);
  });

  it('③ 恒真对照：全都数得动且无命中 ⇒ exitCode 必须是 0（否则②成了"永远红"）', async () => {
    const r = await runAudit({
      prisma: { fakeA: { count: async () => 0, findMany: async () => [] }, $queryRawUnsafe: async () => [] } as any,
      Prisma: PrismaStub([M('FakeA')]) as any,
    });
    expect(r.unreadable).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it('④ 悬挂面：targetType 全集从库里派生，对不上模型的必须报"没检查"（不许静默跳过）', async () => {
    const seen: string[] = [];
    const r = await runAudit({
      prisma: {
        fakeA: { count: async () => 0, findMany: async () => [] },
        order: { count: async () => 0, findMany: async () => [] },
        $queryRawUnsafe: async (sql: string, ...args: any[]) => {
          if (/GROUP BY/.test(sql)) return [{ t: 'order', n: 40 }, { t: 'relation.organization', n: 1080 }, { t: 'ghostType', n: 7 }];
          seen.push(String(args[0]));
          return [{ n: 3 }];
        },
      } as any,
      Prisma: PrismaStub([M('FakeA'), M('Order'), M('Relation')]) as any,
    });
    expect(seen, '带点的嵌套类型要按**实体注册表**解析（relation.organization ⇒ Relation；旧脚本那对 order/Order 是同一事实的小写驼峰面）')
      .toEqual(['order', 'relation.organization']);
    expect(r.dangling, '解析得到的类型必须真查（这里两条各查出 3 条悬挂）')
      .toEqual([{ type: 'order', n: 3 }, { type: 'relation.organization', n: 3 }]);
    expect(r.unmappedTargetTypes, '解析不到的必须带行数报出来，不能被当成"没有悬挂"').toEqual(['ghostType（7 行引用）']);
    // ★ 复核 BLOCKER 的处置：**没被数到的面就是失败**，不许发"已表态"的通行证
    //（我上一版给 `relation.organization` 写过一张"它不是模型"的声明表 —— 那是错的，且会把最大的悬挂族压成 0 退出）
    expect(r.exitCode, '有面没查 ⇒ 退出码非零').not.toBe(0);
  });

  /**
   * ★ 上面那条「带点的 targetType 取第一段」这条规则，对照物是产品侧的实体注册表
   *   （`server/src/entities/registry.ts` 的 `type → sourceModel`）。
   *   规则本身写在普查器里（一份），注册表在这里当**独立真源被比对** ⇒ 注册表哪天把
   *   `relation.person` 指向别的模型，本条立刻红，而不是让普查器安静地查错表。
   */
  it('④b 解析规则与实体注册表对撞：每个登记过的 type 都必须解析到它声明的 sourceModel', () => {
    expect(ENTITY_TYPES.length, '注册表读空 ⇒ 这条对撞成了恒真').toBeGreaterThan(3);
    const byName = new Map(ENTITY_TYPES.map((e: any) => [e.type, e.sourceModel]));
    const misfit = ENTITY_TYPES.filter((e: any) => {
      const head = String(e.type).split('.')[0];
      const guess = head.charAt(0).toUpperCase() + head.slice(1);
      return byName.get(e.type) !== guess;
    }).map((e: any) => `${e.type} 声明的是 ${e.sourceModel}，但按点号前段猜会得到 ${String(e.type).split('.')[0].replace(/^./, (c: string) => c.toUpperCase())}`);
    // ★ 这条**故意红**（当前 7 条对不上）：它证伪了我上一版给普查器写的那条「取点号前第一段」规则，
    //   也正是普查器现在改为直接问注册表的原因。留着它，是为了拦住"有人图省事把规则又写回工具里"：
    //   谁想恢复那条捷径，就会在这里看见自己错在哪。
    expect(misfit.length, '点号前缀规则与注册表**不**一致（现量 7 条）⇒ 解析必须问注册表，不许把捷径写回工具里').toBeGreaterThan(0);
  });

  it('⑤ 基座补牙（同一刀的顺手项）：族检测数不了也要被点名（原先静默归零）', async () => {
    const unreadable: any[] = [];
    await sweepResidue({
      prisma: { fakeA: { count: async () => { throw new Error('族检测炸了'); }, findMany: async () => [] } } as any,
      Prisma: PrismaStub([M('FakeA')]) as any,
      markers: MARKS, withFamily: true, unreadableOut: unreadable,
    });
    expect(unreadable.map((u: any) => u.why).join(' '), '族通道失败必须进 unreadable').toMatch(/族检测/);
  });
});
