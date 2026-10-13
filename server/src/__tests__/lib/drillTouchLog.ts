/**
 * ★ B35 第三刀（#32）：演练的**触碰记录壳** —— 把"这次演练写过哪些表"从人登记变成运行时得到。
 *
 * 为什么必须有它（不是洁癖，是量出来的账）：
 *   验收读数要能被信任，前提是"我知道自己写过哪几张表"。此前这件事有 **25 份手写实现**
 *   （现量：`grep -rl "async function cleanup()|async function residual()" server/src` = 25），
 *   而 B94 实测：12 个 `*Drill*` 演练写过 **20** 张模型，认领清单只覆盖其中 10 张 ⇒
 *   **少登记一张表 = 得到一个绿色的"零残留"**。今天就有活例：
 *   `stockOwnershipDrill.test.ts:36` 创建 `userAccount`，而它自己的 `cleanup()`(:42-47) 与 `residual()`(:49-58)
 *   **两张表里都没有 userAccount** ⇒ 账号行结构性留在库里。
 *
 * 判据取向（三条都是本仓既有教训推出来的）：
 *   1. **行为优先于形状**：不靠 grep 猜"这个文件写了哪张表"（位置参数会把写入藏进服务层 —— B58 实测漏过 3 个 flow），
 *      而是包住注入的 prisma 实例**看着**它被写。服务与事件总线都从外面收 `prisma`
 *      （现量：`server/src/**` 非测试代码里 `new PrismaClient` **0 处**），所以同一个代理能记到扇出的写入。
 *   2. **不新增第四份列知识**：残留扫描复用基座唯一的 `sweepResidue`（DMMF 派生字段），
 *      本文件不出现任何 `{ model, field }` 硬编码。
 *   3. **run 唯一标记必须留在既有前缀族内**（`TEST_<族>_<runId>_`）⇒ v2.63 的"按前缀族认领"与
 *      v2.67 的"认领 ⊆ 源派生"两条判据都不换口径；改成新形状要先在 §9 立账（D49）。
 *
 * ⚠️ 已知盲区（写在这里，别让下一个人以为壳是全视的）：
 *   · 交互式 `$transaction` **不再是盲区**（v2.81 起回调收到包过一层的 `tx`，见下方 `wrapTx`）。
 *     但那条修法只盖住"从本壳的 `prisma` 进 `$transaction`"这一条路：
 *     若演练/服务绕过壳自己造客户端（`new PrismaClient()`）再开事务，那条腿仍然不被记录。
 *   · 演练若**另外**自己 `new PrismaClient()`（不走注入），那条腿也不被记录 —— 守卫会抓"演练里出现裸 new PrismaClient()"。
 *   · 基座的 Json 字段扫描取"近期 5000 行切片"⇒ 切片内的命中数是**下界**，不许当精确总数写进台账。
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { afterAll, expect } from 'vitest';
import { sweepResidue, actorRefRelations, markerOwnedElsewhereWhere } from '../../../../scripts/lib/drill-residue.mjs';

/**
 * 动词名单**只有这一份**（两份清单各自漂 = 本仓头号病，见 §9 R2/B77）。
 *  · `WRITE_OPS` = 读操作之外**动过库**的一切 ⇒ 决定"哪张表进清扫面"；
 *  · `MUTATION_OPS` = 其中"造出 / 改掉东西"的那部分 ⇒ 决定"本次演练到底写过业务数据没有"（★ B116）。
 * 读操作（find/count/aggregate）故意都不进 —— 否则一次查询就把集合灌满，"写过"这个语义就没了。
 * ⚠️ `*AndReturn` 那族（Prisma 生成的 `createManyAndReturn` / `updateManyAndReturn`）也是**真写入**：
 *   第一版两份集合都没它 ⇒ 一条这样的写"既不进锚点也不进清扫面"（现仓 0 处使用，属潜在，复核方 MINOR）。
 */
const MUTATION_OPS = new Set([
  'create', 'createMany', 'createManyAndReturn',
  'update', 'updateMany', 'updateManyAndReturn', 'upsert',
]);
const DELETE_OPS = new Set(['delete', 'deleteMany']);
const WRITE_OPS = new Set([...MUTATION_OPS, ...DELETE_OPS]);

export type DrillTouchRecord = { model: string; op: string; calls: number };

export type DrillContext = {
  /** 交给服务层 / 事件总线的同一个实例（注入点即记录点） */
  prisma: PrismaClient;
  /** run 唯一行标记：`<族前缀><runId>_`。业务号/主键一律由 `id()` 拼，别再手写 MARK 常量 */
  mark: string;
  /**
   * run 唯一**执行者**：`TEST_ACTOR_<族>_<runId>`。
   * ★ 为什么执行者也要 run 唯一（这是采纳第一个演练时才暴露出来的洞）：
   *   `stockOwnershipDrill.test.ts` 写死的 `TEST_ACTOR_C4OWN` **不含行标记** ⇒ 只按行标记对撞残留的判据
   *   对它天生失明，而它恰恰是库里那 11 行演练账号的来源（该文件的 cleanup 与 residual 都没有 userAccount）。
   *   仍留在 `TEST_ACTOR_` 前缀族内 ⇒ v2.63 的"按前缀族认领 auditLog/userAccount"这条判据不换口径。
   */
  actor: string;
  /** 本次 run 真正写过的模型（运行时得到，不是人登记得到），已排序。⚠️ 含"被 cleanup 删过"的表 ⇒ 不许拿它断言"跑过用例" */
  touchedModels(): string[];
  /** ★ B116：只含**非删除动词**那一份集合 ⇒ 断言"本次确实写过业务数据"必须用它，而不是 `touchedModels()` */
  writtenModels(): string[];
  /** 逐 (model, op) 的写入次数 —— 报告与"清理是否覆盖全"的比对都用它 */
  touchRecords(): DrillTouchRecord[];
  /** 拼一个带 run 唯一标记的 id / 业务号 */
  id(suffix: string): string;
  /**
   * ★ B120：**执行者引用普查** —— "还有什么行挂在我这个执行者账号上"，模型集合由 **schema 派生**（基座
   *   `actorRefRelations()`），不是任何人手写的清单。
   *
   * 为什么必须有它（v2.99 的账）：为 B119 补的那一条 `notification.deleteMany` 只挡住了**当时会红的那一张**。
   * 现量：指向 `UserAccount` 的 FK 侧关系 **13 条**，其中**必选且非 cascade 的 7 条** ⇒ 这 7 张里**任何一张**
   * 有一条晚到写入，"删执行者账号"就抛 FK，而红话只说"constraint fails"—— 出一张补一张就是本仓第 N+1 份手写清单。
   * 有了这份普查，红的时候直接点名是哪张表、几行钉着。
   * @returns 每条派生关系的命中行数（`count = null` 表示该表在客户端上没有委托 ⇒ **没数过**，不是零）
   */
  actorReferences(): Promise<Array<{ model: string; fk: string; required: boolean; onDelete: string; blocking: boolean; count: number | null; why?: string }>>;
  /**
   * 收尾对撞：把**被触碰过的**每一张表按"本次 run 的行标记 + 执行者"数一遍残留。
   * ★ 这里就是把 B94 的"少算一张表"变成会红的那一步 —— 数的是运行时记录的集合，不是任何清单。
   * @returns 命中 > 0 的模型（含样本 + ★ B120 的"别人名下"切分）+ 查询失败的模型（失败**不算零残留**）+ 被扫的模型集合
   */
  residual(opts?: { settleMs?: number; maxRounds?: number; extraMarkers?: string[] }): Promise<{
    dirty: Array<ResidualHit>;
    failed: Array<{ model: string; why: string }>;
    swept: string[];
    markers: string[];
    /** ★ B120：执行者账号还在不在库里；在 ⇒ 指名是哪几张表钉住了它（删账号会被 FK 挡） */
    actorPinned: ActorPinned;
  }>;
};

/** ★ B120：一条脏命中（`foreignOwned` 是"关于本次 run 但落在真用户名下"的那一半，**下界**） */
export type ResidualHit = {
  model: string;
  count: number;
  sample: unknown[];
  /** 该表没有挂执行者的列 ⇒ `null`（= **不适用**，与"数过了并且是 0"是两件事） */
  foreignOwned: number | null;
  /** 计数本身失败的原因（有值 ⇒ `foreignOwned` 这个数不可信，也不许当零） */
  foreignWhy?: string;
};

export type ActorPinned = {
  /** 本次执行者账号在库里的行数（>0 = 删账号那一步没成功或没做） */
  accountRows: number;
  /** 钉住它的表：`blocking` 且行数 > 0 */
  blockers: Array<{ model: string; fk: string; count: number }>;
  /** 普查里**没数到**的表（客户端上没委托 / 查询抛错）⇒ 不许读成"没有引用" */
  uncountable: Array<{ model: string; fk: string; why: string }>;
};

/**
 * ★ B120：**红话要说准** —— 同样一句"还有脏行"，两种成因的处置完全相反：
 *  · 行在本次执行者名下 ⇒ 本文件补一条定向删除就完事（常规）；
 *  · 行在**真用户**名下（`foreignOwned`）⇒ 本文件里**没有安全修法**，要清就等于删别人的收件箱
 *    ⇒ 只能掐断扇出或登记 §12.1 等拍 ⇒ 这句话必须把"不许自行删"写在脸上（B120 就是这么被绕过去的）。
 *  · 执行者账号还在库里 ⇒ 普查点名是哪几张表钉住了它（否则读者只会看到一条 FK 报错）。
 * 单独成一个函数：它能被常驻门禁直接喂数据打靶，不必等一次真库红跑才知道红话说得对不对。
 */
export function residualFailureMessage(r: {
  dirty: Array<{ model: string; count?: number; foreignOwned?: number | null; foreignWhy?: string }>;
  touched: string[];
  actorPinned?: ActorPinned;
}): string {
  const rows = r.dirty.map((x) => {
    const foreign = typeof x.foreignOwned === 'number' && x.foreignOwned > 0 ? ` ⇒ 其中 ${x.foreignOwned} 行**不挂在任何演练执行者名下**（真用户的收件箱）` : '';
    const unmeasured = x.foreignWhy ? ` ⇒ 别人名下那一刀没数（${x.foreignWhy}）` : '';
    return `${x.model}:${x.count ?? '?'} 行${foreign}${unmeasured}`;
  });
  const pin = r.actorPinned;
  const pinned = pin && pin.accountRows > 0
    ? `；★ 执行者账号仍留库（${pin.accountRows} 行），钉住它的表：`
      + `${pin.blockers.length ? pin.blockers.map((b) => `${b.model}.${b.fk}=${b.count} 行`).join(' + ') : '（普查未发现 blocking 行）'}`
      + `${pin.uncountable.length ? `；另有 ${pin.uncountable.length} 张表没数到：${pin.uncountable.map((u) => `${u.model}.${u.fk}`).join(' / ')}` : ''}`
    : '';
  const allForeign = r.dirty.length > 0 && r.dirty.every((x) => (x.foreignOwned ?? 0) > 0 && (x.foreignOwned ?? 0) >= (x.count ?? 0));
  const howto = allForeign
    ? ' ⇒ 这类行**不是"忘了清"**：它的收件人由业务侧决定（全体 active 用户），要清就得删真用户的数据 ⇒ **不许自行删**，'
      + '改法是掐断这条扇出（或按 §12.1 登记后由 Kevin 点头）；touched='
    : ' ⇒ 那张表本文件既没清也没数，或它的清理被更早的"整族删"顺手兜着（run 范围口径下别指望）；touched=';
  return `★ B121（壳的文件级断言）：跑到文件最后仍然脏的表（带命中数）：${rows.join('；')}${pinned}${howto}${JSON.stringify(r.touched)}`;
}

/**
 * ★ B121：**文件级断言本体**（独立成一个函数 ⇒ 它能被单测直接喂一个假 ctx 打靶，
 *   而不是只能靠"跑一次真库演练 + 一次性探针"来证明 —— 那种证据会腐烂）。
 *   三句话就是原来 21 份演练各自手抄的那三句；v3.01 把手抄删了，这里成为唯一一份。
 *   ⚠️ 它**不**断言具体模型名（钉实现字面 = B102 那一族）；"本次演练的主对象必须在触碰集合里"
 *   那种知识属于各份演练自己 ⇒ 那些 `toContain('PaymentVoucher')` 一类断言保留在文件里，没被收进来。
 *   ★ v3.02（B120）：断言的**条数没加**（`foreignOwned` 恒为 `dirty` 的子集 ⇒ 另立一条等于同一件事红两次），
 *   加的是**红话说准**：哪一半在真用户名下、执行者被哪张表钉住。
 */
/**
 * ★ B151（v3.25）：**"清干净了没有"这件事必须能说出"没有读数"。**
 *   ★ 精确性（我第一版在台账里把这条写成了"演练只有两态"，那是新颖性夸大）：**壳早就有第三态**（B-1 那批的 `failed`，还断言过"不许在 catch 里降级成干净"）；
 *   本批补的是另外两样——① 各份演练**自己手写**的 `residual()` 仍是"抛／不抛"两态，② 壳把"库连不上"和"查询坏了"混在同一个 `why` 字符串里，缺一个**谓词**。
 *
 * 触发它的是真实一次：2026-09-24 全量门禁里 `processCoverageDrill` 的 afterAll 残留普查撞上
 * `Can't reach database server at localhost:5432` ⇒ 报形是 `Test Files 1 failed` 而 `Tests 7369 passed`
 * （**一个用例都没红**，是 suite 级报错），复盘时容易和"真清出残留"混成一件事 ——
 * 前者的正确处置是修数据库可达性，后者是去补删除；混起来就会有人去找一批根本不存在的脏行。
 * ⇒ 但也不能反过来：把连接类错误 catch 掉当"干净/跳过"就是给盲区发通行证。所以这里做的是
 *   **分开报**：能数的照常数；数不了的记成 `unreadable`，由调用方抛一条 **NO_BACKEND** 的话。
 */
export function isBackendUnreachable(e: unknown): boolean {
  const s = `${(e as any)?.code ?? ''} ${(e as any)?.name ?? ''} ${(e as any)?.message ?? e ?? ''}`;
  // ★ v3.26（复核 I-4 收紧子串面）：错误码/errno 一律加词边界（`ExportETIMEDOUT` 这类拼接词不再命中），
  //   `too many connections` 换成 PG 的真实措辞 `too many clients already`（SMTP relay 那类文案不再命中），
  //   `connection … refused`：v3.26 一度**整条删掉**，理由是「PG/Prisma 真会说这句话时一定同时带着
  //   `Can't reach database server` 或 `ECONNREFUSED`」——★ 那句「一定」是错的，见下面 v3.27 的更正。
  //   留着宽松面的代价是真的：会放行业务文案（如"Upstream AI provider connection refused by gateway"）。
  //   ⚠️ 代价如实记：漏判的方向是"照旧抛裸栈／抛未被识别为连接类"（fail-closed），不会被读成"清干净"。
  //   ★★ v3.27 更正（复核 B 项**反证**了那句「一定」）：Rust query-engine 有一条
  //     `Error querying the database: … Connection refused (os error 61)` —— 旧面抓得住、我上一版删掉后抓不住
  //     ⇒ 那句"实测 6 类"其实数的是我自己照正则手写进 ① 的 6 条字符串，真驱动只实测到 1 类（复核独立复现同结论）。
  //     这里按它的真实形状**放回来但收窄**：只认带 os errno 的 `connection refused (os error N)`，业务文案仍不认。
  return /Can't reach database|\bECONNREFUSED\b|\bEHOSTUNREACH\b|\bETIMEDOUT\b|\bP1001\b|\bP2024\b|PrismaClientInitializationError|too many clients already|timed out fetching a new connection|connection refused \(os error \d+\)/i.test(s);
}

/**
 * ★ B152（v3.26，复核给的 BLOCKER，我自己独立复现）：**真 Prisma 错误的 `message` 以换行开头** ⇒
 *   `split('\n')[0]` 恒为空串，NO_BACKEND 那条红话的"原因："一格永远是空的
 *   （实测：`"\nInvalid \`c.order.count()\` invocation in\n/private/tmp/x.cjs:10:19\n…→ 10 await…"`，
 *   有信息量那句 ``Can't reach database server at `127.0.0.1:1` `` 埋在代码上下文块**之后**）。
 *   ⇒ 取"第一行有信息量的"：跳过 Prisma 的 invocation 头、文件:行号、数字前缀的代码片段行与 `→` 指针行；
 *     全被跳过时退回**最后一行**（总比空强）。
 */
export function errorDigest(e: unknown, cap = 160): string {
  const lines = String((e as any)?.message ?? e).split('\n').map((l) => l.trim()).filter(Boolean);
  const informative = lines.find((l) =>
    !/^Invalid\b/.test(l) && !/^→/.test(l) && !/^\d+\s/.test(l)
    && !/(^|\/)[\w.@~+-]+:\d+:\d+$/.test(l) && !/^at\s/.test(l));
  return (informative ?? lines[lines.length - 1] ?? String(e)).slice(0, cap);
}

export type SafeCount = { key: string; model: string; run: () => Promise<number> };

/** 逐表计数：抛错的表进 `unreadable`，**不**冒充 0；返回的行数 >0 进 `dirty`。 */
export async function safeResidualCounts(
  spec: SafeCount[],
): Promise<{ values: Record<string, number>; dirty: string[]; unreadable: Array<{ key: string; model: string; why: string }> }> {
  // ★ v3.31（复核 D 项）：values 以 key 为键 ⇒ 两条 SPEC 撞名时**后完成的那条覆盖前一条**，
  //   于是"有没有残留"取决于 Promise 完成顺序（dirty 只进失败消息、不进断言 ⇒ 非零能静默消失）。
  //   现仓 0 份触发（16 份逐份查过重复键），所以这不是修既有脏数据，是堵掉那条通道。
  const dupe = spec.map((c) => c.key).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupe.length) throw new Error(`★ B151 普查清单里有 ${dupe.length} 个重复 key（${[...new Set(dupe)].join(' / ')}）：`
    + '撞名会让两条读数的红/绿取决于 Promise 完成顺序 ⇒ 改 key，别留着撞运气');
  const values: Record<string, number> = {};
  const dirty: string[] = [];
  const unreadable: Array<{ key: string; model: string; why: string }> = [];
  const settled = await Promise.all(spec.map(async (c) => {
    try { return { c, ok: true as const, n: await c.run() }; }
    catch (e: any) { return { c, ok: false as const, why: errorDigest(e), backend: isBackendUnreachable(e) }; }
  }));
  for (const r of settled) {
    if (r.ok) {
      values[r.c.key] = r.n;
      if (r.n > 0) dirty.push(`${r.c.model}:${r.n} 行`);
      continue;
    }
    // ★ 只有**连接类**错误才算"没有读数"；别的错（写错的 where、类型错）照旧抛出去 ——
    //   否则任何一次实现走样都会被洗成"测不了"，那条通道就永远是绿的。
    // ★ v3.27（复核 B 项）：这一层能说的只有「没被**认成**连接类」，不能说「不是连接类」——
    //   漏判时那句「且不是数据库不可达」会把人指向「你的 where 写错了」，
    //   正是本文件开头写的那件要避免的事（混起来就会有人去找一批根本不存在的脏行）。
    if (!r.backend) throw new Error(`★ 残留普查里 ${r.c.model} 的计数失败，且**未被识别为**连接类错误（若驱动文案其实是连接类，请补进 isBackendUnreachable）：${r.why}`);
    unreadable.push({ key: r.c.key, model: r.c.model, why: r.why });
  }
  return { values, dirty, unreadable };
}

/** 红话：NO_BACKEND 必须与"发现残留"用词不同，且要说清"这不是零、也不是脏"。 */
export function noBackendMessage(unreadable: Array<{ model: string; why: string }>): string {
  return `★ B151 NO_BACKEND：本次**没有读数**（数据库不可达），"${unreadable.map((u) => u.model).join(' / ')}" 数不了。\n`
    + `   原因：${unreadable.map((u) => `${u.model} ⇒ ${u.why}`).join('；')}\n`
    + `   ⇒ 这**不是**"有残留"（不知道有没有剩），也**不是**"清干净了"：处置是修数据库可达性后重跑，\n`
    + `      不是去补删除逻辑；也**不许**把它降级成 skip/绿（那等于给盲区发通行证）。`;
}

/**
 * ★ B151 的**低成本接法**：老演练的 `residual()` 各写各的（★ 独立口径实测（v3.26 放宽谓词后）：还自己写计数的 14 份未接、已接的 4 份，每份的计数口径就是它自己的真源），
 *   逐份改成 `safeResidualCounts` 等于把那 14 段 where 口径抄第二遍 —— 那是造第二套真源。
 *   ⇒ 这一层只做一件事：把"数不了"从裸 Prisma 栈翻成 **NO_BACKEND** 那条可区分的话，
 *     其余语义原样不动（0 还是 0、脏还是脏）。接一份只需在调用处包一层，棘轮跟着往下走。
 */
export async function withBackend<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e: any) {
    if (!isBackendUnreachable(e)) throw e;
    // ★ B152：`errorDigest` 而不是 `split('\n')[0]`（真 Prisma 的消息首行是空行 ⇒ 原因格会空）；
    //   ★ M-1：带 `cause` —— 重抛不许把原异常对象丢掉（否则这条通道唯一的物证就没了）。
    throw new Error(noBackendMessage([{ model: label, why: errorDigest(e) }]), { cause: e });
  }
}

export async function autoAssert(sh: {
  writtenModels(): string[];
  touchedModels(): string[];
  residual(): Promise<{
    dirty: Array<{ model: string; count?: number; foreignOwned?: number | null; foreignWhy?: string }>;
    failed: Array<{ model: string }>;
    actorPinned?: ActorPinned;
  }>;
}): Promise<void> {
  expect(sh.writtenModels().length,
    '★ B121（壳的文件级断言）：本次没有任何**非删除写入**被壳记录 ⇒ 三种成因都要查：'
    + '① 用例整批没跑（含 `describe.skip`）；② 写入绕过了壳；'
    + '③ ★ **本机库连不上**（v3.29 复核 E 项补这一种：断库时读者看到的**第一句就是这条**，'
    + '而它原来不在枚举里 ⇒ 与刚修的 BL-1 同族，红话把没列到的成因藏起来，读者就去翻"谁没登记写入"）。'
    + '分不清就先看用例自己的报错：满屏 reach database / ECONNREFUSED ⇒ 该修的是可达性，不要去改壳。')
    .toBeGreaterThan(0);
  const r = await sh.residual();
  expect(r.dirty.map((x) => `${x.model}:${x.count ?? '?'}`), residualFailureMessage({ ...r, touched: sh.touchedModels() }))
    .toEqual([]);
  expect(r.failed, '★ B121（壳的文件级断言）：有表数不了 = 本次零残留不可信').toEqual([]);
}

/** 等异步扇出落定（事件总线 → notification / agentJob 是 emit 之后才写的，数早了会得到假零） */
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createDrillContext(opts: {
  /** 该演练既有的族前缀，形如 `TEST_C4OWN_`（沿用文件里那份 `const MARK`，不另起第二处字面量） */
  prefix: string;
  client?: PrismaClient;
  runId?: string;
}): DrillContext {
  if (!/^TEST[_-][A-Z0-9]+[_-]$/.test(opts.prefix)) {
    throw new Error(`prefix 必须是 TEST<族>_ 形状（拿到的是 ${opts.prefix}）：换形状要先在 §9 立账（D49）`);
  }
  const runId = opts.runId ?? `${process.pid.toString(36)}${Date.now().toString(36)}`;
  const mark = `${opts.prefix}${runId}_`;
  const family = opts.prefix.replace(/^TEST[_-]/, '').replace(/[_-]$/, '');
  const actor = `TEST_ACTOR_${family}_${runId}`;
  const base = opts.client ?? new PrismaClient();
  const seen = new Map<string, DrillTouchRecord>();

  const wrapDelegate = (model: string, delegate: any): any =>
    new Proxy(delegate, {
      get(target: any, prop: string) {
        const value = target[prop];
        if (typeof value === 'function' && WRITE_OPS.has(String(prop))) {
          return (...args: any[]) => {
            const key = `${model}.${String(prop)}`;
            const rec = seen.get(key) ?? { model, op: String(prop), calls: 0 };
            rec.calls += 1;
            seen.set(key, rec);
            return value.apply(target, args);
          };
        }
        return value;
      },
    });

  /**
   * ★ B103 第③步（v2.81）：交互式事务里经 `tx` 发生的写**也要被记录**。
   *   只在外层再套一层“只记录、不改行为”的 Proxy 并把**它**传给回调，
   *   回调拿到的仍是 Prisma 给的真事务上下文（★ 不能把外层客户端塞进回调：那会让写**逃出事务**，
   *   改掉被测服务的原子性/回滚语义 —— 这是本批刻意保留的一层间接）。
   *   数组式 `$transaction([p1, p2])` 里那些 promise 本就由外层委托创建 ⇒ 调用那一刻已记到，不需要额外处理。
   */
  const wrapTx = (tx: any) =>
    new Proxy(tx, {
      get(target: any, prop: string) {
        const value = target[prop];
        const modelName = MODEL_BY_KEY.get(String(prop));
        if (modelName && value && typeof value === 'object' && typeof value.create === 'function') return wrapDelegate(modelName, value);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  const prisma = new Proxy(base as any, {
    get(target: any, prop: string) {
      if (prop === '$transaction') {
        return (arg: any, opts?: any) =>
          typeof arg === 'function'
            ? (opts === undefined ? target.$transaction((tx: any) => arg(wrapTx(tx))) : target.$transaction((tx: any) => arg(wrapTx(tx)), opts))
            : target.$transaction(arg);
      }
      const value = target[prop];
      // 只有"看起来像 Prisma 委托"（有 create 方法）的属性才包；$connect/$on 等原样给。
      // ★ 记的是 **DMMF 模型名**（Order），不是属性名（order）⇒ 与基座 allModels/delegateOf 同名同向。
      const modelName = MODEL_BY_KEY.get(String(prop));
      if (modelName && value && typeof value === 'object' && typeof value.create === 'function') return wrapDelegate(modelName, value);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as PrismaClient;

  const touchedModels = () => [...new Set([...seen.values()].map((r) => r.model))].sort();
  const writtenModels = () =>
    [...new Set([...seen.values()].filter((r) => MUTATION_OPS.has(r.op)).map((r) => r.model))].sort();

  const shell: DrillContext = {
    prisma,
    mark,
    actor,
    touchedModels,
    writtenModels,
    touchRecords: () => [...seen.values()],
    id: (suffix: string) => `${mark}${suffix}`,
    actorReferences: actorReferencesCensus,
    async residual(o = {}) {
      const settleMs = o.settleMs ?? 2500;
      const maxRounds = o.maxRounds ?? 6;
      const markers = [...new Set([mark, actor, ...(o.extraMarkers ?? [])])];
      const models = touchedModels();
      /**
       * ★ B115：**空触碰集合不许走到 `sweepResidue`**（那是 B109 炸点的合法触发面 ⇒ 会抛），
       *   也不许悄悄返回一个"干净的零"。它的意思是"本次一行业务写入都没被记到"，
       *   ⇒ 归进 `failed`（演练侧断言 `failed=[]` 会因此红），而不是 `dirty=[]` 冒充"数过且为 0"。
       */
      if (models.length === 0) {
        return {
          dirty: [],
          failed: [{ model: '(触碰集合为空)', why: '本次没有任何写操作被壳记录 ⇒ "零残留"这句没有内容（不是"数过了并且是 0"）' }],
          swept: [],
          markers,
          actorPinned: await actorPinnedDiagnosis(),
        };
      }
      const dirty = new Map<string, ResidualHit>();
      const failed: Array<{ model: string; why: string }> = [];
      // 轮次：每轮 settle 后重数一次，直到命中数不再下降（扇出是异步的，一轮可能还没写完）
      let prev = -1;
      for (let round = 0; round < maxRounds; round += 1) {
        await settle(settleMs);
        // ★ 只扫被触碰的模型：把 DMMF 裁成触碰集合 ⇒ 复用基座那一份 sweepResidue，不另写一份扫描
        const prunedPrisma = { dmmf: { datamodel: { models: modelDefsOf(models) } } };
        // ★ B-1 的修法：sweep 里"数不了"的表必须进 failed，**不许**在 catch 里被降级成"干净"
        const unreadable: { model: string; why: string }[] = [];
        const hits = await sweepResidue({ prisma, Prisma: prunedPrisma as any, markers, withFamily: false, unreadableOut: unreadable });
        // ★ 去重：settle 循环会多轮扫同一张表，不去重会把同一条失败塞好几次（严重度被读数放大）
        for (const u of unreadable) {
          const why = `${u.why}（零残留判据对它无效）`;
          if (!failed.some((f) => f.model === u.model && f.why === why)) failed.push({ model: u.model, why });
        }
        dirty.clear();
        let total = 0;
        for (const h of hits) {
          dirty.set(h.model, { model: h.model, count: h.count, sample: h.sample ?? [], foreignOwned: null });
          total += h.count;
        }
        if (total === prev) break;
        prev = total;
      }
      // ★ v3.13（复核 I-3）：这一条**由基座报**（`sweepResidue` 现在会把「客户端没有 delegate」记进 unreadable，
      //   上面 ① 已并进 failed）。原先这里再推一条不同措辞的 ⇒ 同一张表被记两次、去重按 why 相等判不出来 ⇒ 严重度被翻倍。
      //   牙齿：守卫 `drill-sweep-unreadable.test.ts` 的 ②c 钉基座那一条；本文件的 ⑥ 钉「同一张表在 failed 里只出现一次」。
      // ★ 反真空：DMMF 里没有的模型 = sweep 会**静默跳过**它 ⇒ 宁可红，也不给"数过了"的假象。
      //   （本壳第一版就是从 `client.$prisma.dmmf` 取模型定义，真客户端那儿没有 ⇒ 扫描面恒空、
      //    断言恒绿，是"替身形状与真客户端不同"造成的假覆盖，靠突变才抓出来。）
      const known = new Set(modelDefsOf(models).map((d: any) => d.name));
      for (const m of models) if (!known.has(m)) failed.push({ model: m, why: 'DMMF 里找不到该模型 ⇒ sweep 会跳过它（不是零残留）' });
      // ★ B120 第②半：把每张脏表再切一刀 —— 这些行**是我写的**，但它们**在我以外的真用户名下**吗？
      //   （收件人由 `resolveRecipients()` 决定 = 全体 active 用户 ⇒ 是"隔离面不闭合"，不是"我自己忘了清"，
      //    两者修法不同 ⇒ 分开报，见 §9 B120。只在**已经脏**的表上付这个钱 ⇒ 绿路径这一刀 0 次查询，
      //    但 `residual()` 整体**不是** 0 次额外查询：`actorPinnedDiagnosis` 每次都会数一次执行者行（1 次按主键 count）。）
      for (const h of [...dirty.values()]) {
        const rels: typeof ACTOR_RELS = [];
        const seenFk = new Set<string>();
        for (const r of ACTOR_RELS) {
          if (r.model !== h.model || seenFk.has(r.fk)) continue;
          seenFk.add(r.fk);
          rels.push(r);
        }
        if (rels.length === 0) continue; // 该表不挂执行者 ⇒ foreignOwned 保持 null = 不适用
        const def = ALL_MODEL_DEFS.find((m: any) => m.name === h.model);
        const where = def ? markerOwnedElsewhereWhere(def as any, markers, rels, actor) : null;
        if (!where) { h.foreignWhy = '该模型没有可承载标记的 String 列 ⇒ 这一刀切不出来（不适用，不是零）'; continue; }
        const d = delegateOfKey(h.model);
        if (!d?.count) { h.foreignWhy = '客户端上没有该委托 ⇒ 这一刀没数（不适用，不是零）'; continue; }
        try { h.foreignOwned = await d.count({ where }); }
        catch (e) { h.foreignWhy = String((e as any)?.message ?? e).slice(0, 120); }
      }
      return { dirty: [...dirty.values()], failed, swept: models, markers, actorPinned: await actorPinnedDiagnosis() };
    },
  };

  /** 客户端属性名（`order` → 委托对象）；普查与"别人名下"那一刀都走它，不再各自摸一遍 */
  function delegateOfKey(modelName: string): any {
    const key = modelName.charAt(0).toLowerCase() + modelName.slice(1);
    return (prisma as any)[key];
  }

  /** ★ B120 第①半的实现体：逐张数"挂在我这个执行者身上的行"，模型集合来自 schema 派生（见 `ACTOR_RELS`） */
  async function actorReferencesCensus(): Promise<Array<{ model: string; fk: string; required: boolean; onDelete: string; blocking: boolean; count: number | null; why?: string }>> {
    const out: Array<{ model: string; fk: string; required: boolean; onDelete: string; blocking: boolean; count: number | null; why?: string }> = [];
    for (const r of ACTOR_RELS) {
      const d = delegateOfKey(r.model);
      if (!d?.count) {
        out.push({ ...r, count: null, why: '客户端上没有该委托 ⇒ 这张表**没被数过**（不是"没有引用"）' });
        continue;
      }
      try { out.push({ ...r, count: await d.count({ where: { [r.fk]: actor } }) }); }
      catch (e) { out.push({ ...r, count: null, why: String((e as any)?.message ?? e).slice(0, 120) }); }
    }
    return out;
  }

  /**
   * ★ B120 第①半：执行者账号还留在库里时，**指名是谁钉住了它**。
   *   只在账号行确实还在的时候付普查那 13 次 count（实测整轮 33ms，且这是红路径不是绿路径）。
   */
  async function actorPinnedDiagnosis(): Promise<ActorPinned> {
    const empty: ActorPinned = { accountRows: 0, blockers: [], uncountable: [] };
    const acc = delegateOfKey('UserAccount');
    if (!acc?.count) return { ...empty, uncountable: [{ model: 'UserAccount', fk: 'id', why: '客户端上没有 userAccount 委托 ⇒ 执行者行没被数过' }] };
    let accountRows = 0;
    try { accountRows = await acc.count({ where: { id: actor } }); }
    catch (e) { return { ...empty, uncountable: [{ model: 'UserAccount', fk: 'id', why: String((e as any)?.message ?? e).slice(0, 120) }] }; }
    if (accountRows === 0) return empty;
    const refs = await actorReferencesCensus();
    if (refs.length === 0) {
      // ★ 派生集合本身为空 = DMMF 没拿到 ⇒ "没发现钉住它的表"这句是**空的**，不是零（B109 同一方向）
      return { accountRows, blockers: [], uncountable: [{ model: '(schema 派生)', fk: '—', why: '派生出的引用关系为 0 条 ⇒ 这次普查没有内容，不许读成"没人引用执行者"' }] };
    }
    return {
      accountRows,
      blockers: refs.filter((r) => r.blocking && typeof r.count === 'number' && r.count > 0)
        .map((r) => ({ model: r.model, fk: r.fk, count: r.count as number })),
      uncountable: refs.filter((r) => r.count === null).map((r) => ({ model: r.model, fk: r.fk, why: r.why ?? '未知原因' })),
    };
  }

  /**
   * ★ **B121：把这三句钉在「文件级」钩子上，而不是只活在每个演练自己抄的那一段里。**
   *   原来 21 份演练各自在某个 `describe` 的 `afterAll` 里手抄同一段断言 ⇒ 两个毛病：
   *   ① 整份 suite 被 `describe.skip` 时钩子不跑，而采纳棘轮是**文本**判据（grep `writtenModels(` 等四条）⇒ 照样绿；
   *   ② 段落在哪个 suite 里 = 只能看见那之前的写入（写在后面的那一半没人管）。
   *   ⇒ 两侧都实测过：① 文件里还有活用例时，suite 级钩子不跑而**文件级钩子会跑** ⇒ 本处注册确实咬得住（突变跑 exit 1 并点名 B121）；
   *   ② **整份文件只剩被 skip 的 suite 时，vitest 把整个文件记成 skipped、连文件级钩子也不跑**
   *      （实测 `Test Files 1 skipped (1)` + exit 0）⇒ 这一档运行时兜不住，由棘轮那条**文本**判据兜
   *      （已接壳文件里出现 skip/only ⇒ 红，见 `drill-adoption-ratchet` 的 B121 第二层）。
   *   ⚠️ **注入客户端的情形不注册**（`opts.client` 只可能是替身 ⇒ 那是壳自己的单测，
   *   对着替身跑真库扫描既无意义又会假红）。这条豁免本身有守卫盯着：**已接壳的演练文件不许注入客户端**，
   *   否则就是拿「注入替身」当逃逸口（谓词 ④ `injectsStubClient`，与 ⑤ `registersCtxAtTopLevel` 一起住在基座，壳与棘轮读同一份）。
   *   ⚠️ 代价如实说：现在文件内自己那段与这里**各扫一遍**。★ v3.31 复核实测把我这里那句"约 2.5s"否了：
   *     residual() 的 prev=-1 分支要**两轮** settle(2500) 才 break ⇒ 绿路径单份演练就 ≥5.3s
   *     （实测 5.63 / 5.33 / 5.54s）；"2.5s"是把一轮当成了两轮。整轮按 21 段估是 +~110s 不是 +~50s。
   *   本批**故意不删**那 21 段（删它们要同时改采纳判据的语义，那是下一刀，且要先给"文件级钩子真的会跑"补一条能常驻门禁的牙齿）。
   */
  if (!opts.client) {
    afterAll(() => autoAssert(shell));
  }

  return shell;
}

/**
 * 模型名的**唯一**来源：`Prisma.dmmf`（与基座 `allModels()` 同一份）。
 * ★ 本壳第一版从 `client.$prisma.dmmf` 取，真客户端那个位置是 undefined ⇒ 扫描面恒空 ⇒
 *   `dirty=[]` 恒成立 —— 一条恒绿判据，是**突变**（删掉 userAccount 的清理行仍然全绿）抓出来的。
 *   所以这里同时做两件事：① 用与基座同一份 DMMF；② 取不到就抛，绝不回退成"扫 0 张表"。
 */
const ALL_MODEL_DEFS: any[] = (Prisma as any)?.dmmf?.datamodel?.models ?? [];
/** 客户端属性名 → 模型名（`order` → `Order`）；触碰集合里存**模型名**，与基座 `delegateOf` 的取键方向一致 */
const MODEL_BY_KEY = new Map<string, string>(ALL_MODEL_DEFS.map((m: any) => [m.name.charAt(0).toLowerCase() + m.name.slice(1), m.name]));
/**
 * ★ B120：**"谁引用了执行者"这份集合来自 schema，不来自人写的清单**（现量：FK 侧 13 条 / 必选非级联 7 条）。
 *   取一次放在模块级：派生是纯函数，而每次演练收尾都重算没有意义。
 *   ⚠️ `ALL_MODEL_DEFS` 为空（DMMF 拿不到）时这里是空数组 ⇒ 普查会报"每张表都没数到"（`uncountable`），
 *      而不是静默的零 —— 与 B109 那条"分母为空必须炸"同一方向。
 */
const ACTOR_RELS = actorRefRelations(ALL_MODEL_DEFS);

function modelDefsOf(names: string[]) {
  const defs = ALL_MODEL_DEFS.filter((m: any) => names.includes(m.name));
  if (names.length > 0 && defs.length === 0) {
    throw new Error(`拿不到任何模型定义（Prisma.dmmf 里有 ${ALL_MODEL_DEFS.length} 个模型）⇒ 宁可炸，也不给"扫了 0 张表 = 干净"的假象`);
  }
  return defs;
}

