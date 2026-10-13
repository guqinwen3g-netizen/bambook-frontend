import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  errorDigest, isBackendUnreachable, noBackendMessage, safeResidualCounts, withBackend,
} from './lib/drillTouchLog';

/**
 * ★ B151 的常驻证人：**"清干净了没有"必须能报出第三个态"没有读数"**，
 *   且这条通道不许被当成垃圾桶（任何错都算"测不了"= 永远绿）。
 *
 * 为什么要有它：2026-09-24 那次全量门禁里，`processCoverageDrill` 的 afterAll 残留普查撞上
 * `Can't reach database server at localhost:5432` ⇒ vitest 报成 `Test Files 1 failed`
 * 而 `Tests 7369 passed`（**一个用例都没红**）。这种报形与"真清出残留"共用一个红，
 * 复盘时会把人指向"去查哪张表没清"，而实际该查的是数据库可达性。
 * ★ 这里两头都测：连接类错误 ⇒ 第三态；**非**连接类错误 ⇒ 必须照旧抛（反面通行证）。
 */

const dead = (msg: string) => { const e: any = new Error(msg); e.code = 'P1001'; return e; };

describe('★ B151：残留普查的第三态 NO_BACKEND（没有读数 ≠ 有残留 ≠ 清干净）', () => {
  it('① 连接类错误的识别：正例都认，反例都不认（认错了就是把真缺陷洗成"测不了"）', () => {
    for (const msg of [
      "Can't reach database server at `localhost:5432`",
      'connect ECONNREFUSED 127.0.0.1:5432',
      // ★ v3.27 删掉一条假形状：这里原来有 `'PrismaClientInitializationError: ...'`（把**类名当 message 喂**）。
      //   真错误的类名在 `e.name` 上、message 里没有这串字（⑨ 用真客户端实测过）⇒ 上一批刚栽在"自造措辞"，
      //   这一条是同族，留着就是拿想象的字符串测尺。name 命中由 ⑪ 的 oneHot 单独证。
      'Timed out fetching a new connection from the connection pool',
      // ★ v3.26 更正：这里原本是 `sorry, too many connections already` —— **那是我自己造的措辞**，
      //   PG 真实文案是 "sorry, too many clients already"（53400）。分类器被调去匹配一个不存在的字符串，
      //   等于"对着自己的样本测"⇒ 换成真文案，并在 ⑪ 里挂上反面对照。
      'FATAL: 53400: sorry, too many clients already',
      'EHOSTUNREACH 10.0.0.1:5432',
    ]) expect(isBackendUnreachable(new Error(msg)), `应当认得：${msg.slice(0, 30)}`).toBe(true);
    for (const bad of [
      new Error('Unknown argument `nosuchcolumn`. Available options are marked with ?.'),
      new TypeError('Cannot read properties of undefined (reading count)'),
      new Error('Foreign key constraint violated on the constraint'),
      undefined,
    ]) expect(isBackendUnreachable(bad), `不该认成不可达：${String(bad).slice(0, 34)}`).toBe(false);
  });

  it('② 一条表数不了 ⇒ 只有那一格进 unreadable，数得到的那格不许被连坐抹平', async () => {
    const got = await safeResidualCounts([
      { key: 'ok', model: 'Order', run: async () => 0 },
      { key: 'dead', model: 'OrderLine', run: async () => { throw dead("Can't reach database server"); } },
      { key: 'alsoDead', model: 'WorkStation', run: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); } },
    ]);
    expect(got.values, '数得到的那格仍然要有数').toEqual({ ok: 0 });
    expect(got.unreadable.map((u) => u.model).sort(), '两条连接类失败都要单列').toEqual(['OrderLine', 'WorkStation']);
    expect(got.dirty, '没有读数时不许冒报"有残留"').toEqual([]);
    const msg = noBackendMessage(got.unreadable);
    expect(msg).toMatch(/NO_BACKEND/);
    expect(msg, '红话必须把"不是零、也不是脏"写在脸上').toMatch(/不是.*有残留|不是.*清干净/);
  });

  it('③ 反面通行证：非连接类错误必须照旧抛（否则任何实现走样都能躲进"测不了"）', async () => {
    await expect(safeResidualCounts([
      { key: 'x', model: 'Order', run: async () => { throw new TypeError('Cannot read properties of undefined (reading count)'); } },
    ])).rejects.toThrow(/未被识别为.{0,4}连接类/);
    // ★ v3.27：这里原先钉的是旧措辞（`不是.*数据库不可达` 那一族），我把消息按复核 B 项改掉后它当场红——
    //   红得对（这条消息真有证人），但**钉措辞不如钉语义**：改成"说了不是已识别的连接类"这一条即可。
  });

  it('④ 真有残留时报的是"有残留"，且 unreadable 为空（第三态不许吞掉第一态）', async () => {
    const got = await safeResidualCounts([
      { key: 'ord', model: 'Order', run: async () => 3 },
      { key: 'line', model: 'OrderLine', run: async () => 0 },
    ]);
    expect(got.unreadable).toEqual([]);
    expect(got.dirty, 'dirty 要带上表名与行数，红话才有的可指').toEqual(['Order:3 行']);
    expect(got.values).toEqual({ ord: 3, line: 0 });
  });

  it('⑤ 真客户端两头对照：指到必然连不上的端口 ⇒ 走第三态；本机库上正常计数 ⇒ 三态皆空', async () => {
    // 反面：dead-client 的对照组要选"必然被下游拒"的样本（记忆里那条：别用错误名反推阶段）
    const deadPrisma: any = new PrismaClient({ datasources: { db: { url: 'postgresql://nobody:nobody@127.0.0.1:1/nope' } }, log: [] });
    const gotDead = await safeResidualCounts([
      { key: 'ord', model: 'Order', run: () => deadPrisma.order.count({ where: { id: { startsWith: 'B151__NONE__' } } }) },
    ]);
    await deadPrisma.$disconnect().catch(() => {});
    expect(gotDead.unreadable.map((u) => u.model), '真客户端不可达时必须落在第三态').toEqual(['Order']);
    expect(gotDead.values, '没有读数就不许给一个 0').toEqual({});

    // 正面：真库上跑同一个 helper ⇒ 有读数、既不缺也不脏（证明第三态不是常开阀门）
    const live: any = new PrismaClient({ log: [] });
    // ★ v3.28 复核 BL-1：这一格是判据里**唯一连库**的格，而它原来那条红话写着"本机库可达却报第三态
    //   ⇒ 分类器过宽"—— 复核实测：把 DATABASE_URL 指到死端口跑这一格，红话就是这个，
    //   它教读者去**收窄** `isBackendUnreachable`（那正是第三态的命门），而该修的是可达性。
    //   这与 B151 立账的理由同族，且就发生在本文件里 ⇒ 先预检连接，连不上就报"判据自己没库"。
    //   ⚠️ 修法不改判据功率：预检通过后才轮到"分类器过宽"这句话，所以它只会把**说错的话说对**，
    //      不会把红变成绿（库不可达时这一格照旧红）。
    try { await live.$connect(); }
    catch (e) {
      await live.$disconnect().catch(() => {});
      throw new Error(`★ B151 判据自己没库：⑤ 的正面半边要连本机库，而连接失败（${errorDigest(e)}）`
        + ' ⇒ 该修的是数据库可达性，**不要去收窄分类器**', { cause: e });
    }
    const gotLive = await safeResidualCounts([
      { key: 'ord', model: 'Order', run: () => live.order.count({ where: { id: { startsWith: 'B151__NONE__' } } }) },
    ]);
    await live.$disconnect();
    expect(gotLive.unreadable, `已预检过连接、库确实可达，却仍报第三态 ⇒ 这才是"分类器过宽"：${JSON.stringify(gotLive.unreadable)}`).toEqual([]);
    expect(gotLive.values.ord, '哨兵前缀不该有行；有 ⇒ 说明它数的是别人的数据').toBe(0);
  }, 30_000);

  /**
   * ★ ⑥ 棘轮：**剩下没接第三态的手写残留普查只许减少，不许增加。**
   *   ★ 两头都要钉：上限防"越修越多"，下限防"正则瞎了 ⇒ 0 处 = 全接上了"这种假绿
   *     （记忆里那条老课：读数为零先疑尺，别先报喜）。
   */
  it('⑦ withBackend 本身有牙：连接类错 ⇒ 换成 NO_BACKEND 那条话；别的错 ⇒ 原样抛（不吞不改性）', async () => {
    const boom = (msg: string, code?: string) => { const e: any = new Error(msg); if (code) e.code = code; return e; };
    await expect(withBackend('DyeLot 三张表', async () => { throw boom("Can\'t reach database server at `localhost:5432`"); }))
      .rejects.toThrow(/NO_BACKEND/);
    await expect(withBackend('X', async () => { throw boom('nope'); }))
      .rejects.toThrow(/^nope$/);
    expect(await withBackend('Y', async () => 7), '正常路径不许被包一层就变味').toBe(7);
    // ★ B152 的 `{ cause: e }` 原先**没有任何断言覆盖**（复核 D 项："三条修法各带证人"这一句对它不成立）
    //   ⇒ 补一枚：原异常对象必须挂在 cause 上。（另注：vitest 不打印 cause，所以这条只能程序内查，
    //     红话的可读性靠 `errorDigest` —— 两件事别混着说。）
    const boomRaw10 = new Error('Can\'t reach database server at `localhost:5432`');
    const caught10: any = await withBackend('Z', async () => { throw boomRaw10; }).catch((e: any) => e);
    expect(caught10?.cause, '★ 重抛必须带 cause（否则原异常对象在这条通道里消失）').toBe(boomRaw10);
  });

  /**
   * ★ 一把遍历，⑥⑧ 共用（两份 walk 长在同一件事上，抄两遍就会漂）。
   *   口径：递归扫 server/src 下所有 .test.ts（跳过 node_modules）。
   */
  const walkTestFiles = (): string[] => {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const out: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p2 = join(d, f);
        const st = statSync(p2);
        if (st.isDirectory()) { if (f !== 'node_modules') walk(p2); }
        else if (f.endsWith('.test.ts')) out.push(p2);
      }
    };
    walk(join(__dirname, '..'));
    return out;
  };
  // ★ v3.26（复核 I-2）：**显式排除判据自己那份**。上一版不排是因为"反正它靠正则字面量自匹配，
  //   分子/已接各 +1 同向抵消" —— 但那个抵消只对「未接」成立，对 ⑧ 的下界不成立：
  //   那份 4 = 判据自己 + 3 份真演练，一旦自匹配没了 ⑧ 就红在"至少 4 份"上，而真实进展是 0。
  //   排除用文件名比对（不用 `__filename`：它在这套 ESM 环境下不保证存在）。
  const SELF = 'drillResidualBackend.test.ts';
  const notSelf = (f: string) => !f.endsWith(SELF);
  // ★ 手写残留普查的**宽**谓词（v3.26 按复核 I-1 放宽）：窄的那枚只认 `async function residual(`
  //   与 `const residual = async`，实测漏掉两份同族（`async function residualCounts()`、
  //   `const residual = await prisma.auditLog.count(...)`）⇒ 按落点放宽，不按我的样例形状。
  const HAND_ROLLED = /function\s+residual[A-Za-z]*\(|(const|let|var)\s+residual\w*\s*=/;
  // ★ v3.32（复核 MINOR-3）：原来只认"文件里出现过这两个函数名" ⇒ 一行
  //   `console.log('用 safeResidualCounts( 就能接上')` 就能把**没接**的普查记成已接（现仓 0 例，
  //   但那是"还没人写"不是"写不出来"）。收紧成"必须真的 await 它"。当场回量：notWired 旧尺 0 / 新尺 0
  //   ⇒ 不改现状、只补牙。（若 ⑧ 的 wireShapes 因此红，说明那枚正面样本本身就缺 await ⇒ 改样本，别改尺。）
  const WIRED = /(?:=\s*await\s*|\bawait\s+)(?:safeResidualCounts|withBackend)\(/;
  /**
   * ★ v3.28 复核 BL-2：上面这枚原来对**整份文件文本**做子串测试 ⇒ 谁加一行注释提到函数名，
   *   棘轮就记下一格不存在的进步。复核实测（M6）：给一份未接文件顶部加
   *   `// 用 withBackend( 就能接上第三态`，其余一字未动 ⇒ ⑥ 的"未接"从 19 变 18、⑧ 下界从 4 变 5，
   *   五条断言全绿。我把注释里那句"接法要真的在判据上"当成已做到，其实它一直是空的。
   * ⚠️ 刻意**不复用**仓里那份共享 `stripComments`（记忆里 B76：它曾让 1183 行代码对九条尺隐形）
   *   —— 这里用本地最窄的三条：整行 `//`、`/* *\/` 块、行尾 `//`。
   * ★ v3.29 复核 B 项：**上一批这个"修法"自己漏了一格**。行尾那条我原来写成
   *   `\s\/\/[^/\s].*$`（要求斜杠后紧跟非空白）⇒ **最自然的写法 `code; // safeResidualCounts(`
   *   （斜杠后有空格）根本没被剥掉，复核实测它仍能把一格不存在的进步记进棘轮**。
   *   根因不是我手滑，是**我的负面样本只放了"整行注释"这一种形状** ⇒ 对照组只证了我想到的那种
   *   （"新守卫要两侧自证，反例本身也要穷举"这条又兑现一次）。
   *   ⇒ 现在收成 `\s\/\/.*$`，并把**四种注释写法逐个**钉进 ⑧ 的断言，另留两条"不许过剥"的正面控制。
   *   换前后当场对撞 549 份 `*.test.ts`：两把剥离器**判定不同的文件 0 份**，
   *   wired 15 / notWired 8 / 分母 23 **三个读数一字不动** ⇒ 这次收紧不改任何现状，只补牙。
   * ⚠️ 残余盲区如实记：模板字符串里跨行出现的 ` // ` 会被当注释剥掉 ⇒ 方向是"少算已接"（fail-closed）。
   */
  const stripCommentsNarrow = (t: string) => t
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, ''))
    .join('\n');
  const isWiredFile = (f: string) => WIRED.test(stripCommentsNarrow(readFileSync(f, 'utf8')));
  /**
   * ★ v3.31（复核 IM-1）：⑥ 的**结构化分母谓词**提成纯函数（原来内联在 filter 里）。
   *   两个理由，都不是"整洁"：
   *   ① 提出来才配得上一次两侧自证（见 ⑥b：合法形状必须认出、非普查形状不得误认）——
   *      内联在 filter 里的谓词只能靠"数出来的份数"间接作证，而份数正是会被正当进步改小的那个量。
   *   ② 与 ⑧ 的 WIRED 同病：原谓词对**整份文件文本**做子串测试 ⇒ 一行提到 `.count(` 的注释
   *      就能把一份普通单测拉进分母（拉进 = notWired 顶红上界 0，自造随机红源）。故这里也先剥注释。
   *   ⚠️ 口径变化：剥注释后分母可能比 23 小 ⇒ 本批改完**当场重测量**，台账按新值记。
   */
  // ★ v3.31 第二处（当场回量逼出来的，不是原计划）：前缀也可以**从基座 import**，代码里一个 TEST_ 字面量都没有
  //   （actorRefWhereShape 就是这个形状：`DRILL_ACTOR_PREFIX` 住在 lib/drillTouchLog）。不列进来，剥注释会把一份
  //   **真在数残留**的件挤出分母 —— 而它原来在分母里靠的是文件头注释那句"自造 `TEST_<族>_` 标记"（误打误撞）。
  //   ⇒ 两笔账一起记：分母口径由"注释也算"改成"只认代码"，同时补上这个落点拼法，净读数 23 → 23（不多不少）。
  const CENSUS_MARK = /(ctx\.mark|\bMARK\b|DRILL_ACTOR_PREFIX|['"`]TEST_)/;
  const looksLikeCensus = (t: string): boolean => {
    const code = stripCommentsNarrow(t);
    return /afterAll\s*\(/.test(code) && CENSUS_MARK.test(code)
      && code.split('\n').some((l) => /\.count\s*\(/.test(l));
  };

  /**
   * ★ ⑧ 接法要**真的在判据上**，不是文件里出现过函数名就算接：
   *   已接的文件里不许再留裸的 `expect(await residual()).toEqual(` —— 名字写两遍而调用没包 = 这一格照样绿，
   *   那是把"注册"当成"接上"（记忆里那条：登记表从不与源码对撞）。
   */
  it('⑧ 已接的文件里不许再留裸 residual() 断言（防"提了一嘴就算修过"）', () => {
    // ★ "已接"必须是**独立口径**：只看有没有真的调用接线 API。
    //   旧口径额外要求"该文件还声明着手写 residual" ⇒ processCoverageDrill（已改用 safeResidualCounts、
    //   不再声明 residual）会被这个口径**漏数** —— 那正是记忆里那条"棘轮只数还剩多少，已做数要独立口径"。
    const wired = walkTestFiles().filter((f) => notSelf(f) && isWiredFile(f));
    // ★ v3.29（复核 B 项的根因修法）：上一批我只放了**一枚**负面样本（整行注释），于是"斜杠后带空格"
    //   这一种最自然的写法从缝里漏出去 ⇒ 负面侧要**穷举写法**，不是举一例就算两侧自证。
    const wireShapes: Array<[string, string, boolean]> = [
      ['整行注释（v3.28 复核 M6 的靶）', '// 用 withBackend( 就能接上第三态\nconst x = 1;\n', false],
      ['行尾注释 + 空格（v3.29 复核抓到、上一版漏掉的那一种）', 'const y = 2; // safeResidualCounts( 这里并没有真的调用\n', false],
      ['行尾注释无空格', 'const y = 2; //withBackend(\n', false],
      ['块注释里提函数名', '/* withBackend( 写在块注释里 */\nconst y = 2;\n', false],
      ['★ 正面控制：真调用带尾注释，不许被过剥', 'const got = await safeResidualCounts(SPEC); // 零残留\n', true],
      ['★ 正面控制：字符串里的 URL 不许当注释剥', 'const u = "postgresql://x@127.0.0.1:1/db";\nawait withBackend(u, f);\n', true],
    ];
    for (const [name, src, want] of wireShapes) {
      expect(WIRED.test(stripCommentsNarrow(src)),
        `剥离器在「${name}」上判错 ⇒ 期望"算已接"为 ${want}（负面侧必须穷举写法，举一例不算两侧自证）`).toBe(want);
    }
    expect(wired.length, '剥注释后"已接"数不许低于 4（低于 ⇒ 说明有真调用被我的剥离器误删）').toBeGreaterThanOrEqual(4);
    // ★ 复核 C 项实测：这枚**封闭名册是反向棘轮**（接一份红一次，红话还教下一个人"别接了"）⇒ 换成下界断言。
    //   名单由 ⑥ 的红话负责点名；"接了却仍留裸断言"由下面那条 bare 检查负责 —— 那才是有牙的一半。
    expect(wired.length, `已接 ${wired.length} 份（下界 4；当前名单看 ⑥ 的红话，本行不钉名单）`).toBeGreaterThanOrEqual(4);
    const bare = wired.filter((f) => /^ {2,}expect\(await residual\(\)\)/m.test(readFileSync(f, 'utf8')));
    expect(bare.map((f) => f.split('/').slice(-2).join('/')),
      '这些文件接了包装函数，却还留着**行首裸 residual() 断言**（只认行首，注释里引用这句写法不算 —— 我第一版就被自己的注释假红过一次） ⇒ 那条路径上仍然只有红/绿两态').toEqual([]);
  });

  it('⑥ 棘轮：还在自己数残留、没接第三态的演练文件只许减少（且有下限防尺瞎）', () => {
    const files = walkTestFiles().filter(notSelf);
    // ★ 复核 C 项实测：按名字的宽谓词漏过同族（变量不叫 residual*、或标识隔了一层
    //   `const own = { startsWith: ctx.mark }`）⇒ 换成结构化落点：afterAll ∧ 演练标识 ∧ 逐行数 count。
    //   谓词自 v3.31 起住在 looksLikeCensus（⑥b 对它做两侧自证）。
    //   ⚠️ 本行原写"结构化 23 ⊇ 名字法 17（多 6）"，那个 **17 已经复现不出来了**（复核 MINOR-9 判我注释腐烂，
    //   我当场回量：名字法现值见下面 narrower 那格的读数）⇒ 数字不再写在这里，只在红话里现打。
    const handRolled = files.filter((f) => looksLikeCensus(readFileSync(f, 'utf8')));
    const notWired = handRolled.filter((f) => !isWiredFile(f));
    // ★ 口径（v3.27 换成结构化落点后当场重测；上一版是按名字数 17／14）：
    //   "族内还有多少"与"我这枚正则看见多少"是两件事 ⇒ 分母必须取**超集**那一把。
    //   两把尺同测（复核 C 项给的教训）：结构化 23 份 ⊇ 名字法 17 份（多 6、不缺 0）。
    //   ⚠️ 顺序：换分母会当场把上界顶红 ⇒ 这一批仍是**先量后改界**。
    //   下限换锚（复核 C 项实测：原来那枚 14 是**反向棘轮**，迁 4 份就红、红话还教读者"别当成进步"）：
    //   结构化分子只会被"删了演练"或"改了标识写法"缩小，**接线不会** ⇒ 这个下限不会被进步消灭。
    // ★ v3.30 换锚（复核 IM-2 的延续 + 本批当场量）：下限**不许**钉在"文件里还自己数行数"上。
    //   基座注释明写的下一刀（把 21 段文件内重复普查收进壳，实测省每份 ~5s）会让
    //   上面那个结构化分母从 23 掉到 ~12（复核 M1/M1'/ENDSTATE 三次模拟同读数）⇒ 钉 20 是反向棘轮第五次现形。
    //   ⇒ 防瞎这半边改看**采纳面**：`createDrillContext(` 的出现份数。
    // ★ v3.31（复核 IM-2）：那把锚原来掺了一枚**非演练** —— `drillTouchLog.test.ts` 是壳自己的单测，
    //   它 createDrillContext 时喂的是替身 client，压根不读残留。复核实测"2 格余量"其实只拦 3 份删除：
    //   删 2 份真演练 ⇒ 20，不红；删 3 份 ⇒ 19 才红。本枚要拦的正是"静默删演练" ⇒ 那个余量是虚的。
    //   修法=把非演练按**文件**逐张写死（不放宽谓词），并钉住表长 + 反面对照。
    const NOT_A_DRILL = ['drillTouchLog.test.ts'];
    expect(NOT_A_DRILL, '豁免表只许按文件写死、长度钉在当前值：要加人必须同时改这个数并说明它凭什么是非演练')
      .toHaveLength(1);
    for (const name of NOT_A_DRILL) {
      const hit = files.filter((f) => f.endsWith(name));
      expect(hit.length, `豁免表指向的 ${name} 已经不在扫描结果里 ⇒ 这张表该删（留着=一条隐形豁免）`).toBe(1);
      expect(looksLikeCensus(readFileSync(hit[0], 'utf8')),
        `被豁免的 ${name} 竟然仍是一份自己数残留的演练 ⇒ 豁免不成立，把它退回分母`)
        .toBe(false);
    }
    const adopted = files.filter((f) => /createDrillContext\(/.test(readFileSync(f, 'utf8'))
      && !NOT_A_DRILL.some((n) => f.endsWith(n)));
    // ★ 话术改口（复核 IM-3，我复量成立）：v3.30 那句"会缩的正当成因只有删演练一种"是**错的**，
    //   而且和它下一行"若是改成公共夹具/换 import 路径 ⇒ 要重锚"自相矛盾。反例实测：
    //   `createDrillContext(` 整体改名成 `makeDrill(` 并把真调用挪进公共夹具 ⇒ 锚 22 → 0。
    //   所以本枚**不承诺**"只有删演练会缩"；它承诺的是"缩了必须停下来重看，不许顺手调小数字"。
    //   红话把两类成因分开写，读者据红话第一句就能分辨是哪一类。
    expect(adopted.length,
      `接了壳的演练只剩 ${adopted.length} 份（实测 21、界 20、余量 1 —— 诚实值，不假装宽）`
      + '⇒ 两类成因都要红、处置不同：① 真删了演练 = 本枚正该拦的；② 写法漂移（改名/换 import 路径/'
      + '抽公共夹具）= 认不出 ≠ 没采纳，**要重锚不是调小数字**。分辨方法：'
      + '`grep -rln "createDrillContext\|" server/src | wc -l` 与实跑用例数对照，不是看这一格。')
      .toBeGreaterThanOrEqual(20);
    // ★ v3.31（复核 IM-1）：原 `handRolled >= 12` **恰好等于**我自己在注释里写的完成态投影值
    //   （收壳那一刀落地后的实测读数就是 12）⇒ 零余量，且红话枚举的三种成因里没有"有人又往前走了一步"
    //   这一种。这不是判据，是把"这一批不红"抄成了下限。处置按记忆里那条规矩：**换锚，不调小数字**。
    //   防瞎拆成两枚各自能咬、失效方式不同的哨兵：
    //   (a) 扫描根活体：walkTestFiles 一共看见几份 .test.ts（只会随仓库长大而增，删一半测试树才会缩）——
    //       它拦的是"遍历根/后缀/statSync 走样"这一类（B122 同族的沉默区）。
    //   (b) 谓词认得出形状：见 ⑥b 那张两侧表（合法形状认出 / 非普查形状不误认）。
    expect(files.length,
      `一把遍历只看见 ${files.length} 份 .test.ts ⇒ 扫描根瞎了（根路径、后缀判定或目录跳过条件被改动）。`
      + '口径：walkTestFiles() 递归 join(__dirname,"..")=server/src，排除 node_modules 与判据自己那份；'
      + '本批实测 549 ⇒ 界 500 的余量 49 是"仓库里测试文件的净删除数"，不随演练收敛变化。')
      .toBeGreaterThanOrEqual(500);
    // ★★ v3.32（复核 IMPORTANT-1：我原来那句"收壳后分母趋 0"是**错的**）：非空洞前提不许写成 `> 0`。
    //   复核实测：把 21 段文件内普查整块收进壳之后，handRolled 还剩 **2**（actorRefWhereShape 与
    //   forwardFxMaturityWatchdog 本来就自己数行数）⇒ `> 0` **恒绿**，而那时 23 份里 21 份已经没有任何
    //   残留扫描 = G-3 要杀的"人自我声明"原地复活、**一点红都不报**。这枚前提是为那一刀买的，却在那一刀
    //   落地时不说话 ⇒ 彻底的惰性证人。本批当场用模拟复现同一读数（2），不是推演。
    //   ⇒ 换成**跨谓词**证人：`结构化分母 ⊇ 采纳面`（两枚互相独立的谓词：自己数行数 vs 调了壳）。
    //     它恰好在"接了壳却没有可读数的演练"那一格红；"删掉整份演练"则两边同缩 ⇒ 由上面那枚下限管。
    //   ⚠️ 这一枚**故意**会在"壳真去代扫"那一刀落地时红 —— 那是逼着人换读数面并自带证人，不是不许做。
    //     届时的处置：把右边换成"壳的代扫注册表份数" + 补一条运行时正面对照；
    //     **不许**把本条放宽回 `> 0`（那正是本批被抓到的那条惰性）。
    // ★ v3.34（复核 ③）：跨谓词证人管不到"**没接壳**的两份手写普查件同时消失"——那会让左右两边同步缩。
    //   复核实测：删掉这两份后 14 格**全绿** ⇒ 只能按名字各钉一次存在性（它们是只读探针 / §12.1 第 27 条的
    //   watchdog，刻意不接壳 ⇒ 从分母里消失只可能是被删或被改名，两种都该问，不是收敛）。
    const PINNED_UNADOPTED = ['actorRefWhereShape.test.ts', 'forwardFxMaturityWatchdog.test.ts'];
    // ★ v3.35（复核 ③）：名册自己也得有牙 —— 上一版没有长度钉，把数组删到 1 项甚至清空都全绿；
    //   而同文件的 NOT_A_DRILL 恰恰有"长度钉死 + 表内文件必须还在"两条臂 ⇒ 同一份判据里不该一边硬一边软。
    expect(PINNED_UNADOPTED, '名册长度钉在当前值：要减项必须同时说明那份演练去哪了').toHaveLength(2);
    for (const must of PINNED_UNADOPTED) {
      const hit = handRolled.filter((f) => f.endsWith(must));
      expect(hit.length,
        `${must} 不在分母里了 ⇒ 它被删/改名/移出了扫描根（这一族"手写但不接壳"的件消失不是进步）`).toBe(1);
      // ★ 只证"存在 + 形状"不够：文件名不动、把断言掏空（留下 .count( 与 afterAll( 两个影子）就能骗过上一版。
      // ★ v3.36（复核 #7 第 3 条）：这两条臂上一批**只看整份文件文本** ⇒ 复核造了一份"真断言全注释掉"的样本，
      //   注释里 3 处 `.count(` 就把它喂绿了 —— 而"文件名不动、内容被掏空"正是它红话里点名的那种失效形状。
      //   ⇒ 判定一律走剥过注释的代码（用本文件自己那枚最窄剥离器，不引仓里那份共享 stripComments：
      //   B76 记过它被劫持过一次，九条尺同时对 1183 行代码失明）。
      const code = stripCommentsNarrow(readFileSync(hit[0], 'utf8'));
      expect((code.match(/\.count\s*\(/g) || []).length,
        `${must} 还在，但**代码里**只剩 ${code.match(/\.count\s*\(/g) ? '' : '零'}处 count 调用 ⇒ 影子留在注释里不算牙`)
        .toBeGreaterThanOrEqual(2);
      expect(/\.toBe\(|\.toEqual\(|\.toMatch\(|safeResidualCounts\(/.test(code),
        `${must} 的**代码**里已经没有任何会红的断言了（文件名没动、内容被掏空或只剩注释）`).toBe(true);
    }
    expect(handRolled.length,
      `结构化分母 ${handRolled.length} < 采纳面 ${adopted.length} ⇒ 有 ${adopted.length - handRolled.length} `
      + '份演练接了壳、却在自己文件里不再数残留，而壳此刻**还不代扫** ⇒ 那些份的"零残留"退回人自我声明。'
      + '两条出路：① 有人删了演练/改了标识写法 ⇒ 逐名核对；② 收壳那一刀真落地了 ⇒ 把右边换成壳的代扫'
      + '注册表份数并补一条运行时正面对照（**不是**把本条放宽回 `> 0`）。')
      .toBeGreaterThanOrEqual(adopted.length);
    // ★ 结构化那把不许比按名字那把**看得少**（否则"放宽"是假的，我只是换了个更窄的形状）
    //   ⚠️ 这格自带一个终点：名字法**已经在缩小**（v3.27 记的 17 → 复核复量 6 → 本批接线后回量 3；
    //   接线本身就把 `const residual =` 换成了 `RESIDUAL_SPEC` + `safeResidualCounts(`，谓词当然不再命中）。
    //   它趋 0 时"⊆ 空集"会退化成恒真装饰 ⇒ **落到 0 的那一批必须显式退役这一格**（同族前例：
    //   B150 删过恒真断言、⑥ 里删过 `toEqual(expect.any(Array))`），不许留着冒充有牙。
    const nameBased = files.filter((f) => HAND_ROLLED.test(readFileSync(f, 'utf8')));
    const narrower = nameBased.filter((f) => !handRolled.includes(f)).map((f) => f.split('/').pop());
    expect(narrower, `结构化分母漏掉了按名字看得见的这些份 ⇒ 不是放宽是换窄：${narrower.join(' / ')}`).toEqual([]);
    expect(notWired.length, `未接第三态的还剩 ${notWired.length} 份（★ 上界 0 = v3.31 把最后 4 份搬完，B151 的采纳面到此清零：`
      + 'v3.27 未接 19 → v3.28 搬 11 = 8 → v3.30 搬 4 = 4 → 本批 3 份手工 + 1 份循环探针 = 0。'
      + '分母 23 全程未动 ⇒ "接线不缩分母"的实证现在是 23/23 全体，不再是样本。'
      + '★ 清零之后这一格的含义变了：它不再数"还剩多少要修"，而是**禁止新增手写普查**——'
      + '谁新写一份自己数残留的演练就会撞红，那不是尺坏了、也不是谁退步，是要把它接上壳（或显式往上拧并留痕）。'
      + '按形状把某份踢出分母来"保持 0"是 B153 立的那条罪，本文件不接受。）')
      .toBeLessThanOrEqual(0);
    // ★ v3.26 删掉第三条断言（复核 M-4，我复算成立）：`expect(名单).toEqual(expect.any(Array))`
    //   结构上**不可能红**（`.map()` 必然返回数组）⇒ 它不是判据，是装饰；
    //   名单的可读性由上面两个失败消息负责（红了就把实际名单打在消息里）。同族前例：B150 行删过一条恒真断言。
  });

  /**
   * ★ ⑥b：把 ⑥ 那枚分母**谓词**拿到两侧上测（缺陷放回必红 + 等价/合法写法不得假红）。
   *   它替代的是原来那枚 `handRolled >= 12`：份数会被正当进步改小，"形状认不认得出"不会。
   *   ⚠️ 口径说清：这一格只证**谓词**认得出/不误认，不证**扫描根**（那是 (a) 那枚 files.length 的活）；
   *     两条各拦一种瞎法，缺一条就剩一个盲区。
   */
  it('⑥b 分母谓词两侧自证：认得出五种真实落点形状（含"前缀从基座 import"），且不被注释/无标识骗进分母', () => {
    const censusShapes: Array<[string, string, boolean]> = [
      ['规范形状：afterAll + ctx.mark + count',
        "afterAll(async () => { const n = await prisma.order.count({ where: { orderNo: { startsWith: ctx.mark } } }); expect(n).toBe(0); });\n", true],
      ['标识隔了一层（v3.26 漏过的那族）',
        "afterAll(async () => { const own = { startsWith: ctx.mark };\nawait prisma.invoice.count({ where: own }); });\n", true],
      ['族级 MARK 常量（watchdog 那一族的写法）',
        // ⚠️ 故意拼成 "TEST_" + "D6WD_"：写成一整枚 `TEST_D6WD_` 字面量会让**根域那把宽尺**
        //   （`containsDrillMarker` = `['"`]TEST_[A-Z0-9]{2,}[_-]['"`]/`）把判据自己认成"代码行自造族标记的写库演练"
        //   ⇒ 未接壳读数 3 → 4，根门禁当场红（v3.31 实测就是这么抓到的）。本文件是尺，不是演练。
        'const MARK = "TEST_" + "D6WD_";\nafterAll(async () => { await prisma.fxRateLock.count({ where: { id: { startsWith: MARK } } }); });\n', true],
      ['反引号前缀字面量 + 循环里 count（v3.30 判"不算同族但按落点收"那一格）',
        'afterAll(async () => { for (const r of RELS) { await delegateOf(r.model).count({ where: { [r.fk]: `TEST_${SUF}_` } }); } });\n', true],
      ['★ 反向：只有注释提到 .count( ⇒ 不许进分母（进了就顶红"未接 ≤ 0"，= 自造随机红源）',
        'afterAll(async () => { /* 这里以前是 prisma.order.count(...) 的残留普查 */ });\n// 提醒：count 已交给壳\n', false],
      ['前缀从基座 import、代码里没有 TEST_ 字面量（v3.31 剥注释后差点挤出分母的那个形状）',
        'import { DRILL_ACTOR_PREFIX } from "./lib/drillTouchLog";\nconst PROBE = `${DRILL_ACTOR_PREFIX}probe`;\nafterAll(async () => { await safeResidualCounts([{ key: "k", model: "Notification", run: () => db.notification.count({ where: { userId: PROBE } }) }]); });\n', true],
      ['★ 反向：普通单测（有 afterAll、有 count、没有演练标识）',
        'afterAll(async () => { await prisma.userAccount.count(); });\n', false],
      ['已知放宽：计数住在 it 里、没有 afterAll ⇒ 不进本尺分母',
        'it("残留为 0", async () => { expect(await prisma.order.count({ where: { no: ctx.mark } })).toBe(0); });\n', false],
    ];
    const solo: Record<string, number> = {};
    for (const [name, src, want] of censusShapes) {
      expect(looksLikeCensus(src), `谓词在「${name}」上判错 ⇒ 期望 ${want}`).toBe(want);
      solo[String(want)] = (solo[String(want)] || 0) + 1;
    }
    // 两侧都得有人站：只测 true 就是"我只举了我想到的那一侧"（v3.29 那条罪的原形）
    expect(Math.min(solo['true'] || 0, solo['false'] || 0),
      `两侧样本数 = true:${solo['true'] || 0} / false:${solo['false'] || 0} ⇒ 有一侧空了，这格退化成单侧对照`)
      .toBeGreaterThanOrEqual(3);
  });

  /**
   * ★ ⑥c（复核 MINOR-2）：标识拼法是一张**白名单**（ctx.mark / MARK / DRILL_ACTOR_PREFIX / 'TEST_），
   *   换个名字就能对分母完全隐形 —— 正是 v3.26 记过的"同族 3 份对尺完全隐形"。
   *   白名单治不了未来 ⇒ 补一枚隐形族哨兵：凡"在 afterAll 里按前缀数行数、却不认识其标识"的文件当场点名。
   *   现仓实测 = 0 ⇒ 它不数"还剩几处"，只堵"新增一种拼法却没人知道"。
   *   ★ 两侧自证：同一枚谓词必须认得出我现造的新拼法（否则上面那条 toEqual([]) 是恒绿装饰）。
   */
  it('⑥c 隐形族哨兵：按前缀数行数却不在白名单里的件必须为 0，且哨兵认得出新拼法', () => {
    const scoped = walkTestFiles().filter(notSelf);
    const prefixCount = (code: string) => /afterAll\s*\(/.test(code)
      && /count\s*\(\s*\{\s*where/.test(code) && /startsWith\s*:/.test(code);
    const invisible = scoped.filter((f) => {
      const code = stripCommentsNarrow(readFileSync(f, 'utf8'));
      return prefixCount(code) && !CENSUS_MARK.test(code);
    });
    expect(invisible.map((f) => f.split('/').pop()),
      '这些文件在 afterAll 里按前缀数行数，但标识拼法不在白名单里 ⇒ 它对 ⑥ 的分母完全隐形：'
      + '要么把拼法补进 CENSUS_MARK（并在 ⑥b 留一枚正例），要么改回已有拼法').toEqual([]);
    const planted = 'const PFX = prefixFromSomewhere();\nafterAll(async () => { await prisma.order.count({ where: { no: { startsWith: PFX } } }); });\n';
    expect(prefixCount(planted), '哨兵谓词连"afterAll + 按前缀数行数"都不认 ⇒ 上面那条 toEqual([]) 是恒绿装饰').toBe(true);
    expect(CENSUS_MARK.test(planted), 'planted 样本必须**不被**白名单认到，否则正面控制测的是空集').toBe(false);
  });

  /**
   * ★ ⑥d（复核 C 项：那枚撞名键的抛此前**没有证人**，删掉它全仓不会红）。
   *   两侧：撞名必须抛；不撞名不许抛（否则它可能只是恒抛或恒不抛的装饰）。
   */
  it('⑥d safeResidualCounts 的撞名键：撞了必抛、没撞不许抛（给那条抛补上证人）', async () => {
    const run = (n: number) => async () => n;
    await expect(safeResidualCounts([
      { key: 'dup', model: 'Notification', run: run(0) },
      { key: 'dup', model: 'AuditLog', run: run(1) },
    ])).rejects.toThrow(/重复 key/);
    const ok = await safeResidualCounts([
      { key: 'a', model: 'Notification', run: run(0) },
      { key: 'b', model: 'AuditLog', run: run(0) },
    ]);
    expect(ok.values, '不撞名却被抛/读数丢一半 ⇒ 上面那条 rejects 测的就不是撞名这件事').toEqual({ a: 0, b: 0 });
  });

  /**
   * ★ ⑨ 真 Prisma 客户端的不可达形状：`why` **不许是空串**（B152 的靶）。
   *   复核抓到、我独立复现：真错误的 message 以 `\n` 开头 ⇒ 旧 `split('\n')[0]` 恒空，
   *   而 NO_BACKEND 那条红话里"原因："这一格就是空的 —— 读者既复核不了判定，也没法据此修可达性。
   *   ⚠️ 必须用**真客户端**：替身造不出这个换行形状（记忆里那条"替身证不了查询形状"）。
   */
  it('⑨ 真客户端不可达时 why 非空，且 NO_BACKEND 的红话带得上原因', async () => {
    const dead: any = new PrismaClient({
      datasources: { db: { url: 'postgresql://nobody:nobody@127.0.0.1:1/nope?connect_timeout=1' } }, log: [],
    });
    const got = await safeResidualCounts([
      { key: 'ord', model: 'Order', run: () => dead.order.count({ where: { id: { startsWith: 'B152__NONE__' } } }) },
    ]);
    await dead.$disconnect().catch(() => {});
    expect(got.unreadable.map((u) => u.model), '真不可达必须落进第三态').toEqual(['Order']);
    const why = got.unreadable[0]?.why ?? '';
    expect(why.length, `★ B152：why 是空的 ⇒ 这条通道唯一的自带证据没了（实得 ${JSON.stringify(why)}）`).toBeGreaterThan(0);
    expect(why, `why 要说得出"为什么数不了"（实得 ${JSON.stringify(why)}）`).toMatch(/reach|database|refus|timeout|ECONN|P1001|P2024/i);
    expect(noBackendMessage(got.unreadable)).toContain(why.trim().slice(0, 24));
  }, 30_000);

  /**
   * ★ ⑩ `errorDigest` 自己的正负对照：Prisma 那种"首行空 + 代码上下文块"要能穿过噪声拿到有信息量那行；
   *   普通单行消息不许被它加工坏；全是噪声时退回最后一行而不是空。
   */
  it('⑩ errorDigest：跳过 Prisma 的 invocation 头/文件:行号/代码片段行，取到真原因', () => {
    const prismaLike = new Error(
      '\nInvalid `prisma.order.count()` invocation in\n/private/tmp/x.test.ts:10:19\n\n   7   log: [],\n'
      + '   8 });\n→ 10   await c.order.count(\nCan\'t reach database server at `127.0.0.1:1`\n\nPlease make sure…',
    );
    // ★ 复核 A 项：这一条原来 `toBe(整串)` 钉的是**字节格式** —— 它手写 5 枚同样合理的 digest 实现，
    //   其中 3 枚被我假红，而那 3 枚在真客户端那格 ⑨ 全绿 ⇒ 只加假红面、不加证人功率
    //   （同一批 §9.1 刚撤过抄来的字面量，这条是我自己没照做）。改钉**行为**三件：
    //   非空／拿到的是原因而不是 invocation 头／不把"文件:行号"当原因。
    const d10 = errorDigest(prismaLike);
    expect(d10.length, 'digest 不许为空（B152 那一格的靶）').toBeGreaterThan(0);
    expect(d10.startsWith('Invalid'), `应是原因而非 invocation 头，实得 ${JSON.stringify(d10)}`).toBe(false);
    // ★ v3.28 复核 MN-1：这一条原来 `toMatch(/reach database/i)` 又钉回了**字面措辞**
    //   （复核手写"取最长行/取末行"两枚实现时，喂 `Please make sure your database server is running`
    //    这种同样合理的原因行就假红），而 ⑨ 用的是宽交替 ⇒ 同一批两格对同一件事一宽一窄。
    //   ⇒ 与 ⑨ 同一条交替：只要求"说得出原因类词汇"，不要求 Prisma 的原话。
    expect(d10, `应拿到原因而不是噪声，实得 ${JSON.stringify(d10)}`).toMatch(/reach|database|refus|timeout|ECONN|P1001|P2024/i);
    expect(/\.ts:\d+:\d+$/.test(d10), `不许把"文件:行号"当原因返回，实得 ${JSON.stringify(d10)}`).toBe(false);
    expect(errorDigest(new Error('单行消息，原样'))).toBe('单行消息，原样');
    expect(errorDigest({ message: '\n\n\n   \n' }), '全空也不许返回空串（宁可回落到原文）').not.toBe('');
    expect(errorDigest('就是字符串不是 Error')).toBe('就是字符串不是 Error');
    expect(errorDigest(new Error('x'.repeat(400))).length, '要有上限，红话不许被一条长栈撑爆').toBeLessThanOrEqual(160);
  });

  /**
   * ★ ⑪ 分类器收紧后的两侧对照（复核 I-4 实测过 4/7 条业务文案会被旧子串面误判）：
   *   假阳性那一面必须关掉，同时真不可达（靠类名 + 真措辞）一个都不许漏。
   */
  it('⑪ 收紧子串面：拼接词/他域文案不再命中，真不可达措辞仍然命中', () => {
    // ★ 复核 A 项实测：删掉 `\bETIMEDOUT\b`／`\bP1001\b`／`\bP2024\b` 三枚分支，`still` 仍然全绿
    //   ⇒ 我的正例互相重叠，那三枚**没被单独证过**。下面每枚只命中一个词（其余词都不出现），
    //     删掉任一枚词这一格就红。⚠️ 这只证明"没有白写的分支"，不证明"每个词都有必要"。
    const oneHot: Array<[string, Error]> = [
      // ★ v3.28 复核 IM-1：原来这一组**少一枚**，缺的恰恰是触发 B151 的那一句 ——
      //   真客户端那条错误同时带 `name=PrismaClientInitializationError` 与 `code=P1001`，
      //   所以删掉 `Can't reach database` 这一支之后 ⑤⑨⑪ 全绿（复核逐枚消融实测：可静默删除的分支 = 1）。
      ["Can't reach database", new Error("Can't reach database server at `db.internal:5432`")],
      ['P1001', Object.assign(new Error('database unreachable'), { code: 'P1001' })],
      ['P2024', Object.assign(new Error('pool 耗尽'), { code: 'P2024' })],
      ['ECONNREFUSED', new Error('connect ECONNREFUSED 127.0.0.1:5432')],
      ['EHOSTUNREACH', new Error('connect EHOSTUNREACH 10.0.0.1:5432')],
      ['ETIMEDOUT', new Error('socket ETIMEDOUT')],
      ['PrismaClientInitializationError', Object.assign(new Error('初始化失败'), { name: 'PrismaClientInitializationError' })],
      ['too many clients already', new Error('FATAL: 53400: sorry, too many clients already')],
      ['timed out fetching a new connection', new Error('Timed out fetching a new connection from the pool.')],
      // ★ 复核 B 项抓到本批改漏的那一类（Rust query-engine 没有 errno token，只有 os error）⇒ 回归证人
      ['connection refused (os error N)', new Error('Error querying the database: error connecting to server: Connection refused (os error 61)')],
    ];
    const soloMiss = oneHot.filter(([, e]) => !isBackendUnreachable(e)).map(([n]) => n);
    const still = [
      Object.assign(new Error('\nInvalid `prisma.order.count()` invocation in\n/private/tmp/x.test.ts:10:19'),
        { name: 'PrismaClientInitializationError' }),
      Object.assign(new Error('Timed out fetching a new connection from the pool.'), { code: 'P2024' }),
      Object.assign(new Error('Can\'t reach database server at `localhost:5432`'), { code: 'P1001' }),
      Object.assign(new Error('FATAL: sorry, too many clients already'), {}),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {}),
    ];
    expect(still.filter((e) => !isBackendUnreachable(e)).map((e) => (e as any).message),
      '真·连接类不许漏（漏了的代价见基座注释：一条通道退回裸栈，另一条抛「未被识别为连接类」）').toEqual([]);
    expect(soloMiss, `这几枚分支没有独占正例 ⇒ 删掉它判据不会红，等于白写：${soloMiss.join(' / ')}`).toEqual([]);
    const mustNot = [
      'ExportETIMEDOUT: 报表生成超时',
      'Upstream AI provider connection refused by gateway',
      'SMTP error: too many connections to relay',
      'your connection to the printer was refused by the policy',
      '导出任务 timed out，请重试',
    ];
    expect(mustNot.filter((m) => isBackendUnreachable(m)),
      '★ 这些是**业务错误**，被判成"库不可达"就等于把真缺陷洗成"测不了"（名单就是这 5 条，不设分母 —— 原来那句"旧面 4/7 命中"里的 7 在判据里没有对应集合，不可复核）').toEqual([]);
  });
});
