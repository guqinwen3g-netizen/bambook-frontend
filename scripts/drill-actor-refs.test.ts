/**
 * ★ B120 守卫：**"谁引用了执行者账号"这件事必须由 schema 派生，且派生要能被独立复算。**
 *
 * 起因（不是设想，是 v2.99 的账）：为 B119 补的 `notification.deleteMany({ userId: ACTOR })` 只挡住了
 * **当时会红的那一张**。历史基座有 13 条 FK / 7 条 blocking；V1 六个新增不可覆盖事实
 * 关系已逐条登记到下方精确集合（退款、实际成本核对、真实返款）。
 * ⇒ 这 7 张里任何一张有一条晚到写入，"删执行者账号"就抛 FK。如果按"出一张补一张"修，那就是本仓第 N+1 份
 * 手写清单（§9 R2/B77 那一族）。修法改成 `actorRefRelations()` 从 DMMF 派生 ⇒ 于是必须回答两个问题：
 *
 *  ① **派生是不是真的派生？**（不是"看起来派生、里面写死了一串模型名"）
 *     ⇒ 用**合成 dmmf** 打靶：新增一条指向 UserAccount 的关系，函数必须当场多出一条（`B120-牙①`）。
 *  ② **派生的东西与 schema 一致吗？**（DMMF 来自**已生成的 client** ⇒ `prisma generate` 没跑就会静默少一条，
 *     而少一条的读数长得和"没人引用"一模一样）
 *     ⇒ 另起一把**只看 `schema.prisma` 文本**的尺，与 DMMF 那条**按集合对撞**（`B120-牙②`）。
 *     两把尺锚点不同（一个是生成产物、一个是源文本），所以对撞不是恒等式（§9 B107 的教训：对撞的谓词不许与尺共用）。
 *
 * ⚠️ 运行范围：本文件住在 `scripts/` 下，只有**从仓库根**跑的 `npx vitest run` 收它；
 *   `cd server && npx vitest run` 的 include 不收 `scripts/` ⇒ 引用"守卫绿"要说明是哪一道门禁（同 `drill-targets-single-source`）。
 * ⚠️ 本测试**不连库**：只用 `Prisma.dmmf`（静态，`new PrismaClient()` 都不做）。
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  actorRefRelations, markerOr, markerOwnedElsewhereWhere, DRILL_ACTOR_PREFIX,
} from './lib/drill-residue.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = join(REPO, 'server', 'prisma', 'schema.prisma');
const BASE = 'scripts/lib/drill-residue.mjs';
const SHELL = 'server/src/__tests__/lib/drillTouchLog.ts';
const req = createRequire(join(REPO, 'server') + '/');
/** 已生成 client 的静态 DMMF（不实例化客户端 ⇒ 不需要 DATABASE_URL，也不会碰库） */
const { Prisma } = req('@prisma/client');

const codeLines = (src: string) => src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));

/** 合成 dmmf 的一条关系字段（形状与 Prisma 生成物一致：kind / relationFromFields / relationOnDelete / isRequired） */
const rel = (name: string, opts: Record<string, unknown>) => ({ name, kind: 'object', type: 'UserAccount', ...opts });
const str = (name: string, required = true) => ({ name, kind: 'scalar', type: 'String', isRequired: required });

describe('B120 执行者引用普查：派生必须真是派生（合成 dmmf 打靶）', () => {
  it('牙① schema 里新增一条指向 UserAccount 的必选非级联关系 ⇒ 普查当场多出一条', () => {
    const models = [
      { name: 'UserAccount', fields: [str('id')] },
      { name: 'Widget', fields: [str('id'), str('ownerId'), rel('owner', { relationFromFields: ['ownerId'], relationToFields: ['id'], relationOnDelete: 'NoAction' })] },
    ];
    const got = actorRefRelations(models);
    expect(got.length, '一条都不派生出来 ⇒ 这函数其实是写死的清单').toBe(1);
    expect(got[0]).toMatchObject({ model: 'Widget', fk: 'ownerId', required: true, blocking: true });
  });

  it('★ 反面对照三则：级联 / 可空 / 反侧列表关系都**不**算"钉住执行者"', () => {
    const models = [
      { name: 'UserAccount', fields: [str('id')] },
      // ① 级联：删账号会带走它 ⇒ 不挡路
      { name: 'Role', fields: [str('userId'), rel('user', { relationFromFields: ['userId'], relationOnDelete: 'Cascade' })] },
      // ② 可空列：FK 为 NULL 的行不挡删除 ⇒ 不是 blocking
      { name: 'Note', fields: [str('userId', false), rel('user', { relationFromFields: ['userId'], relationOnDelete: 'NoAction' })] },
      // ③ 反侧（isList、没有 fromFields）：没有可 where 的列 ⇒ 进不了普查（进了就是拿假列去查）
      { name: 'Dept', fields: [rel('users', { isList: true, relationName: 'X' })] },
    ];
    const got = actorRefRelations(models);
    expect(got.map((r: any) => r.model).sort(), '反侧那条不许混进来').toEqual(['Note', 'Role']);
    expect(got.filter((r: any) => r.blocking).map((r: any) => r.model),
      'blocking 必须恰好排除"级联"与"可空"两类').toEqual([]);
  });

  it('★ 复合 FK（两列一起指 UserAccount）现在**不支持** ⇒ 必须显式知道，不能静默漏', () => {
    const models = [
      { name: 'UserAccount', fields: [str('id')] },
      { name: 'Pair', fields: [str('aId'), str('bId'),
        rel('user', { relationFromFields: ['aId', 'bId'], relationOnDelete: 'NoAction' })] },
    ];
    expect(actorRefRelations(models),
      '派生只认单列 FK ⇒ 复合 FK 会被丢掉。今天 schema 里没有这种（另一条测试在盯），出现时必须**先看见**再决定怎么数')
      .toEqual([]);
  });

  it('★ 反枚举：派生函数里不许出现"模型名形状"的字符串字面量（它只能认 `UserAccount` 这个类型锚）', () => {
    const src = String(actorRefRelations);
    // ★ v3.02 复核 IMP-4：第一版只捕**单引号** ⇒ 塞 `"Notification"` / `` `CreditNote` `` 都不红（实测）。
    //   尺的捕获面要比"我打算防的写法"更宽 ⇒ 三种引号都抓；只比**标识符形状**的字面量（模板串相邻产生的碎片不是标识符，
    //   例如 `` `${a.model}.${a.fk}`.localeCompare( `` 会被整段正则切成一个假"字面量" ⇒ 那是尺的误伤，不是名单）。
    const lits = (src.match(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g) ?? [])
      .map((s) => s.slice(1, -1))
      .filter((body) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(body));
    const allowed = new Set(['object', 'UserAccount', 'Cascade', 'NoAction']);
    const bad = lits.filter((l) => !allowed.has(l));
    expect(bad, `出现了白名单外的标识符字面量 ⇒ 普查正在退化成手写名单：${bad.join(' ')}`).toEqual([]);
    // 尺自己的牙齿：把"模型名白名单"塞回去，它必须抓得住（三种引号各试一次）
    for (const probe of ['if (m.name === "Widget") continue;', 'if (m.name === `Widget`) continue;', 'if (m.name === \'Widget\') continue;']) {
      const found = (probe.match(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g) ?? [])
        .map((s) => s.slice(1, -1)).filter((b) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(b) && !allowed.has(b));
      expect(found.length, `尺对这种写法没反应 ⇒ 反枚举是装饰：${probe}`).toBe(1);
    }
  });
});

describe('B120 派生与 schema 源文本对撞（抓"生成物过期"这种静默少一条）', () => {
  /** 独立第二把尺：只读 `schema.prisma` 文本，不碰 DMMF ⇒ 与 `actorRefRelations` 锚点不同 */
  function fromSchemaText() {
    const text = readFileSync(SCHEMA, 'utf8');
    const out: Array<{ model: string; fk: string; required: boolean; onDelete: string }> = [];
    for (const m of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const modelName = m[1];
      const body = m[2];
      for (const line of body.split('\n')) {
        const f = line.match(/^\s*(\w+)\s+UserAccount(\?)?\s+@relation\(([^)]*)\)/);
        if (!f) continue;
        const fields = f[3].match(/fields:\s*\[([^\]]*)\]/);
        if (!fields) continue;                       // 反侧（无 fields）⇒ 不是 FK 持有者
        const onDelete = (f[3].match(/onDelete:\s*(\w+)/) ?? [, 'NoAction'])[1] as string;
        for (const fkRaw of fields[1].split(',')) {
          const fk = fkRaw.trim();
          if (!fk) continue;
          const scalar = body.match(new RegExp(`^\\s*${fk}\\s+String(\\?)?`, 'm'));
          out.push({ model: modelName, fk, required: !!scalar && !scalar[1], onDelete });
        }
      }
    }
    return out;
  }

  const fromDmmf = actorRefRelations((Prisma as any).dmmf.datamodel.models);
  const fromText = fromSchemaText();
  // ★ v3.02 复核 IMP-5：第一版只比 `${model}.${fk}` ⇒ `required`/`onDelete` **不参与对撞**，
  //   于是"schema 把 Notification 改成 Cascade 但没 generate"这一整类会让**红话说谎而尺全绿**
  //   （`blocking` 完全由这两个字段决定）。对撞必须带上它们。
  const sig = (r: any) => `${r.model}.${r.fk}|required=${r.required}|cascade=${r.onDelete === 'Cascade'}`;

  it('★ 两把尺看到的 (表.列 + 必选性 + 是否级联) 必须一致（不一致 = 生成物过期 / 复合 FK / 新的写法逃过派生）', () => {
    expect(fromText.length, 'schema 文本这把尺一个都没扫到 ⇒ 尺瞎了，别拿它的"一致"当证据').toBeGreaterThan(0);
    // 文本尺对"同一张表两根列"会各出一行（`ApprovalRequest`），故先去重再比
    expect([...fromDmmf].map(sig).sort(), 'DMMF 与 schema 文本对不上 ⇒ 先看是不是忘了 prisma generate，再考虑扩展派生')
      .toEqual([...new Set(fromText.map(sig))].sort());
  });

  it('★ 只数**单列** FK 这条边界今天确实成立（否则上一条的对撞会被复合 FK 悄悄放行）', () => {
    const byModel = new Map<string, number>();
    for (const r of fromText) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
    const multi = [...byModel.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    // `ApprovalRequest` 有 requesterId + reviewerId 两根**各自单列**的 FK ⇒ 按"每根关系单列"算合法；
    // 这里禁的是"一根关系两列"，那条形状由上面的合成打靶钉住。
    expect(multi.sort(), '这些模型有多根指向 UserAccount 的 FK ⇒ markerOwnedElsewhereWhere 必须按行取并集，不许按列相加')
      .toEqual(['ApprovalRequest'].sort());
  });

  it('★ V1 六个新增事实关系逐条登记；DMMF 与独立源文本仍必须对撞', () => {
    const blocking = fromDmmf.filter((r: any) => r.blocking).map((r: any) => `${r.model}.${r.fk}`).sort();
    expect(fromDmmf.length, '历史13 + 已审定V1事实关系6；未登记的任何关系变化仍拒绝').toBe(19);
    expect(blocking.length, '历史7 + 六个 mandatory actor fact FK；不是放宽删除/跳过预算').toBe(13);
    expect(blocking, 'blocking 集合').toEqual([
      'AgentMessage.userId', 'AgentSession.userId', 'ApprovalRequest.requesterId', 'AuditLog.actorId',
      'CreditNoteRefund.requesterId', 'CreditNoteRefundEvent.actorId', 'CreditNoteRefundEvidence.uploadedBy',
      'CreditNoteRefundReturn.actorId',
      'EmployeeProfile.userId', 'Notification.userId', 'NotificationPreference.userId',
      'OrderCostReview.confirmedBy', 'OrderCostReviewEvidence.createdBy',
    ]);
  });
});

describe('B120 的"别人名下"那一刀：一份列知识 + 四段口径', () => {
  /**
   * 形状鲁莽的"手写 OR 构建器"尺：换循环变量名 / 加花括号 / flatMap 都还要看得见（复核 IMP-3）。
   * ★ **按行去重**数：一行里可能同时命中两种形状（markerOr 那行就是），按 match 数会把它算成 2 处 ⇒ 尺误伤。
   */
  const BUILDER = /\{[^{}]*\bcontains\s*:|(?:for|flatMap|map)\s*\([^)]*\bof\s+(?:sf\b|stringFields\s*\(|fields\b)/;
  /**
   * 扫描面 = "自称与清扫器同语义"的那些消费者。
   * ★ **v3.13（B133）**：`scripts/audit-drill-residue.mjs` 原先是登记在案的手抄户（自带 12 个模型名 / 19 列的清单），
   *   本批已把它收编成基座 `sweepResidue()` 的薄壳 ⇒ 它从"豁免"移进**扫描面**：
   *   将来谁再往那份只读普查器里塞一个手写构建器，这里当场红（豁免表不许变垃圾桶，也不许留过期豁免）。
   *   这条迁移本身就是被下面那条反向检查逼出来的：我先删的清单，守卫紧接着报"该文件已无手抄 ⇒ 请把豁免删掉"。
   */
  const CONSUMERS = [BASE, 'scripts/acceptance-data-scope.mjs', 'scripts/clean-drill-residue.mjs', 'scripts/audit-drill-residue.mjs',
    'server/src/__tests__/lib/drillTouchLog.ts'];
  const EXEMPT: Record<string, string> = {};

  /**
   * ★ 复核 I-4 / I-2 的牙：**扫描面本身不许被悄悄缩小**。
   *   上一版只钉"已登记的每个文件里有没有手抄"⇒ 把某文件从 `CONSUMERS` 里删掉、再让它长出手抄，
   *   守卫永远看不见（复核方实测：这样做出来的红清单是 `[]`）。
   *
   * ★★ 人口怎么派生（这一段被复核驳过两次，都记下来）：
   *   · **不能**按"有没有 `{contains:` 形状"扫全树 —— `contains:` 是普通过滤写法，会把 12 个与残留
   *     毫无关系的验收/走查脚本卷进来，判据立刻退化成"给一堆无关文件写豁免"（＝又回到手写清单）。
   *   · 也**不能**只用"谁调基座读数口"去管**删除面**：复核方实测那样只看得到手写 `deleteMany` 的一部分，
   *     且 `const s = sweepResidue; s(...)` 这种改名一躲就不见。
   *   ⇒ 分两把尺，各管各的语义：
   *     第一把（清扫语义）：凡调用基座读数口的文件必须被登记 —— 按**行为**派生，今天现量 6 个。
   *     第二把（删除面）：凡出现 `.deleteMany(` 的文件**逐个冻结条数** + 一条总数棘轮 —— 按**落点**派生，
   *     不看它叫什么、是否调基座 ⇒ 改名躲不掉。退役不安全 CLM/claim 脚本后上限 25 个文件 / 200 条。
   *   ⚠️ 为什么只登记现状而不顺手收编：收编＝**改删除面**（本批硬边界不许自主动）⇒ 先让它全量可见、
   *     只许降不许升，收编与授权同批做（§12.1 第 27 条同族）。
   */
  const BASE_FNS = /\b(sweepResidue|cleanResidue|settleAndClean|fetchAllResidue)\s*\(/;
  /** 基座自己那 3 条是**唯一实现**的内部删除，不属于"手抄删除面"，故从第二把尺的人口里排除 */
  const SELF_CLEAN_EXCLUDE = 'scripts/lib/drill-residue.mjs';
  const SELF_CLEANERS: Record<string, number> = {
    'scripts/acceptance-e2e-business-chain.mjs': 32,
    'scripts/acceptance-e2e-business-variants.mjs': 31,
    'scripts/walkthrough/w-a-5-four-batches.ts': 25,
    'scripts/acceptance-batch1-a3b1b4.mjs': 16,
    'scripts/acceptance-invoice-amount-recalc.mjs': 10,
    'scripts/acceptance-pending-cancel-path.mjs': 10,
    'scripts/acceptance-third-party-payment.mjs': 10,
    'scripts/acceptance-zero-amount-invoice-credit-gate.ts': 8,
    'scripts/acceptance-cancel-settle-recalc.mjs': 7,
    'scripts/acceptance-cif-fob-strip.mjs': 7,
    'scripts/acceptance-claims-ui.mjs': 5,
    'scripts/acceptance-d7-1-resale-atomic.mjs': 5,
    'scripts/acceptance-hr-assigner-id.mjs': 5,
    'scripts/acceptance-payr-atomicity-live.mjs': 5,
    'scripts/acceptance-entity-ref-purge-e2e.ts': 4,
    'scripts/acceptance-form-submit-all.mjs': 4,
    'scripts/acceptance-invoice-customer-gate.mjs': 4,
    'scripts/acceptance-d6-forward-fx-write.mjs': 2,
    'scripts/acceptance-h16-reconciliation-ack-internal-ui.mjs': 2,
    'scripts/acceptance-h16-reconciliation-ack-internal.mjs': 2,
    'scripts/perf-1000-orders.mjs': 2,
    'scripts/acceptance-h16-reconciliation-ack.mjs': 1,
    'scripts/acceptance-hs-rebate-drill.mjs': 1,
    'scripts/acceptance-reporting-inventory-dataset.mjs': 1,
    'scripts/check-fail-open-inventory.mjs': 1,
  };
  /** CLM/claim 退役移除原 9+7 条预算：只许降，扫描人口与负面自证仍保持。 */
  const DELETEMANY_TOTAL_MAX = 200;

  const walkCode = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walkCode(f);
    return /\.(mjs|cjs|js|ts)$/.test(e.name) && !e.name.includes('.test.') ? [f] : [];
  });
  // ★ 人口边界要说清（复核 I-2 之后我自己差点把它铺到整个 server/src ⇒ 那会把 14 个业务服务的
  //   正常 `deleteMany` 也钉进这张表，判据立刻变成"给一堆无关文件写数字"）。本尺只管
  //   **演练/验收/清理这一侧**的删除面：`scripts/**` 与 `server/src/__tests__/**`（壳住在这里）。
  //   业务侧写面由别处管（§2 G4.1 的写端点普查 + scope 门），两把尺不许互相冒充。
  const toolFiles = () => [...walkCode(join(REPO, 'scripts')), ...walkCode(join(REPO, 'server', 'src', '__tests__'))]
    .map((f) => relative(REPO, f).split(sep).join('/'))
    .filter((rel) => rel !== SELF_CLEAN_EXCLUDE);
  const dmOf = (rel: string) => codeLines(readFileSync(join(REPO, rel), 'utf8')).filter((l) => /\.deleteMany\s*\(/.test(l)).length;

  it('★ 两把尺自证：调基座的人必须登记（少扫一个 = 红）；手写 deleteMany 必须逐个冻结且只许降', () => {
    const registered = new Set([...CONSUMERS, ...Object.keys(EXEMPT), ...Object.keys(SELF_CLEANERS)]);
    const callers: string[] = [];
    for (const rel of toolFiles()) {
      if (codeLines(readFileSync(join(REPO, rel), 'utf8')).some((l) => BASE_FNS.test(l))) callers.push(rel);
    }
    expect(callers.length, '一个调用基座读数口的文件都没找到 ⇒ 这把尺瞎了（分母必须非空）').toBeGreaterThan(3);
    const strays = callers.filter((rel) => !registered.has(rel));
    expect(strays, `这些文件与清扫同语义却没被登记 ⇒ 扫描面被悄悄缩小了：${JSON.stringify(strays)}`).toEqual([]);

    // 第二把：人口按落点派生 ⇒ 每个有 deleteMany 的文件都必须在冻结表里（漏一个文件＝这把尺瞎了）
    const withDeletes = toolFiles().filter((rel) => dmOf(rel) > 0);
    expect(withDeletes.length, '一个手写 deleteMany 都没找到 ⇒ 第二把尺瞎了').toBeGreaterThan(10);
    const unfiled = withDeletes.filter((rel) => SELF_CLEANERS[rel] === undefined);
    expect(unfiled, `这些文件有手写 deleteMany 却没被冻结 ⇒ 只许降的基线漏了条目：${JSON.stringify(unfiled)}`).toEqual([]);
    let total = 0;
    for (const [rel, pinned] of Object.entries(SELF_CLEANERS)) {
      const n = dmOf(rel);
      expect(n, `${rel} 的手写 deleteMany 从 ${pinned} 条变成 ${n} 条 —— 只许降；要升就是动删除面，先过 §12.1 第 27 条`).toBeLessThanOrEqual(pinned);
      expect(n, `${rel} 现在一条都没有 ⇒ 把这条从基线删掉，别留死条目（B35 那一族的反面就是"账面已覆盖、实际认不到"）`).toBeGreaterThan(0);
      total += n;
    }
    expect(total, `手写 deleteMany 总数 ${total} 超过冻结基线 ${DELETEMANY_TOTAL_MAX} ⇒ 只许降（升＝动删除面）`).toBeLessThanOrEqual(DELETEMANY_TOTAL_MAX);
  });

  it('★ `markerOr` 是"标记落在哪些列"的**唯一**一份写法（扫消费者，不只扫基座）', () => {
    const builderLines = (rel: string) => codeLines(readFileSync(join(REPO, rel), 'utf8')).filter((l) => BUILDER.test(l));
    const srcOf = (rel: string) => codeLines(readFileSync(join(REPO, rel), 'utf8')).join('\n');
    for (const rel of CONSUMERS) {
      const lines = builderLines(rel);
      if (rel === BASE) {
        expect(lines.length, `基座里有 ${lines.length} 行在手写构建器（应为 1，且必须住在 markerOr 里）：\n${lines.join('\n')}`).toBe(1);
        const src = srcOf(rel);
        const at = src.indexOf('export function markerOr(');
        const after = src.indexOf('\nexport ', at);
        const idx = src.indexOf(lines[0]);
        expect(at > -1 && idx > at && (after === -1 || idx < after),
          '唯一那处必须住在 markerOr 函数体里 ⇒ 否则"一份实现"只是数出来的巧合').toBe(true);
      } else {
        expect(lines.map((l) => l.trim()), `${rel} 里不许再有第二份构建器（要么调 markerOr，要么写进豁免表并给理由）`).toEqual([]);
      }
    }
    // 豁免表自己不许变垃圾桶：登记的文件必须**真的**还有手抄（否则这条豁免该删）
    for (const [rel, why] of Object.entries(EXEMPT)) {
      expect(builderLines(rel).length, `${rel} 已无手抄 ⇒ 请把豁免删掉（理由：${why}）`).toBeGreaterThan(0);
    }
    expect(markerOr({ fields: [{ name: 'id', kind: 'scalar', type: 'String' }, { name: 'tags', kind: 'scalar', type: 'String', isList: true }] }, ['TEST_X_']),
      '列表标量（String[]）不支持 contains ⇒ 必须被排除，否则整表 count 抛错（B110 那一族）')
      .toEqual([{ id: { contains: 'TEST_X_' } }]);
  });

  /**
   * ★★ BLOCKER 回归钉子（本批自己做出来、被现量与复核各抓一次的那个）：
   *   第一版对**每一根**归属列都加 `{col: null}` ⇒ 必选列上 Prisma 直接拒绝整条 where
   *   （实测 `notification.count(…)` ⇒ `Argument \`userId\` is missing.`）⇒ 真库里 foreign 那一刀**永远数不到**。
   *   ⚠️ 替身客户端测不出来（它把 `{col:null}` 当普通等值求值）⇒ 这条要**结构判据 + 真库侧的活路径测试**成对
   *      （`server/src/__tests__/actorRefWhereShape.test.ts` 拿真 Prisma 把 13 条 where 各校验一遍）。
   */
  it('★ 只有**可空**归属列才带 `null` 那一档；必选列不许出现', () => {
    const def = { name: 'Notification', fields: [str('title'), str('userId')] };
    expect(markerOwnedElsewhereWhere(def, ['TEST_C7WO_run1_'], [], 'TEST_ACTOR_C7WO_run1'),
      '没有归属列 ⇒ 这一刀**不适用**（必须 null，给 0 就是拿"零"冒充"数过了"）').toBe(null);
    expect(() => (markerOwnedElsewhereWhere as any)(def, ['TEST_'], ['userId'], 'A'),
      '传裸列名（旧签名）必须炸 ⇒ 悄悄返回 null 等于"那一刀不数了"').toThrow(/actorRefRelations/);
    const req: any = markerOwnedElsewhereWhere(def, ['TEST_C7WO_run1_'], [{ fk: 'userId', required: true }], 'TEST_ACTOR_C7WO_run1');
    expect(req.AND[1].NOT.OR, '必选列：只有两档（本次执行者 / TEST_ACTOR_ 前缀）').toEqual([
      { userId: 'TEST_ACTOR_C7WO_run1' },
      { userId: { startsWith: DRILL_ACTOR_PREFIX } },
    ]);
    const opt: any = markerOwnedElsewhereWhere(def, ['TEST_C7WO_run1_'], [{ fk: 'userId', required: false }], 'TEST_ACTOR_C7WO_run1');
    expect(opt.AND[1].NOT.OR, '可空列：第三档（NULL）才有意义 —— 无主行不许被猜成"落在某个真用户名下"').toEqual([
      { userId: 'TEST_ACTOR_C7WO_run1' },
      { userId: { startsWith: DRILL_ACTOR_PREFIX } },
      { userId: null },
    ]);
    // ★ 期望侧写**字面量**，不许 `toEqual(markerOr(...))`（复核 IMP-2：与被测实现同锚 ⇒ 把 contains 换成 startsWith 也全绿）
    expect(req.AND[0].OR, '标记那半边覆盖该模型全部标量 String 列（不含列表标量）').toEqual([
      { title: { contains: 'TEST_C7WO_run1_' } },
      { userId: { contains: 'TEST_C7WO_run1_' } },
    ]);
  });

  it('★ 真 schema 派生出的 13 条关系逐条体检：必选列不许有 null 档、可空列不许缺', () => {
    const models = (Prisma as any).dmmf.datamodel.models;
    const bad: string[] = [];
    for (const r of actorRefRelations(models)) {
      const def = models.find((m: any) => m.name === r.model);
      const w = JSON.stringify(markerOwnedElsewhereWhere(def as any, ['__no_such_marker__'], [r], 'TEST_ACTOR_probe'));
      if (r.required && w.includes('null')) bad.push(`${r.model}.${r.fk}(必选列却带 null 档 ⇒ Prisma 会拒整条 where)`);
      if (!r.required && !w.includes('null')) bad.push(`${r.model}.${r.fk}(可空列却缺 null 档 ⇒ 无主行会被误报成别人的行)`);
    }
    expect(bad, 'null 档的分配必须与列的可空性一致').toEqual([]);
  });

  it('★ 壳必须真的用这两把尺（只 import 不调用 = 上一条绿灯什么也没说）', () => {
    const src = codeLines(readFileSync(join(REPO, SHELL), 'utf8')).join('\n');
    expect(src).toContain('actorRefRelations(');
    expect(src).toContain('markerOwnedElsewhereWhere(');
    expect(src, '普查结果必须进红话，否则它只是日志里的装饰品').toContain('residualFailureMessage(');
  });
});
