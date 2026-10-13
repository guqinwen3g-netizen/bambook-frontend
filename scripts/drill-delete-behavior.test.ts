/**
 * v2.65（复核 BLOCK-1 / BLOCK-2 / IMPORTANT-3 命中）：**删除动作的判据必须是行为，不是循环写法。**
 *
 * ★ 为什么换判据类型（这是本仓第 N 次同一根因，但这次落在**我自己为修上一个问题新写的那把尺**上）：
 *   v2.63 的守卫用正则匹配 `for (const t of X)` 来断言"计数/删除/复核走同一份派生清单"。
 *   复核实测：把第 4 个删除循环写成 `for (const target of TARGETS)` 或 `TARGETS.forEach(...)`
 *   ⇒ 12 例全绿，而那条循环**带着敏感目标** ⇒ `--apply` 不加 flag 也能删掉 11 个演练账号。
 *   ⇒ 形状判据的覆盖面永远 ≤ 写法面（AGENTS 里那条"数一族按落点不按形状"）。
 *   现在：把删除逻辑做成**可注入**（`runDeletePlan(prisma, opts)`），用假 client 跑一遍，
 *   断言"**到达 deleteMany 的 (model, where) 集合**"—— 与代码怎么写循环无关。
 *
 * ⚠️ 本文件**不连库**：所有 prisma 都是 Proxy 替身。真库只读清点见 `server/scripts/diag-test-residue.mjs`。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDeletePlan, runCli, withDerivedLinks } from '../server/scripts/cleanup-test-residue.mjs';
import { drillTargets, cleanResidue, MUST_BE_SENSITIVE_MODELS, APPROVAL_REQUIRED_MODELS, assertSensitiveVerdict, DRILL_TARGETS } from './lib/drill-residue.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 假 prisma：记录每一次 deleteMany 的 (model, where)；count 可按表配；findMany 返回配好的行 */
function fakePrisma({ counts = {}, contractRows = [], throwOnModel = null } = {}) {
  const calls = [];
  const mk = (model) => ({
    count: async ({ where } = {}) => { calls.push(['count', model, where]); return counts[model] ?? 0; },
    findMany: async () => { calls.push(['findMany', model]); return model === 'forwardFxContract' ? contractRows : []; },
    deleteMany: async ({ where } = {}) => {
      if (model === throwOnModel) throw new Error(`模拟删除失败：${model}`);
      calls.push(['deleteMany', model, where]);
      return { count: 1 };
    },
  });
  const p = new Proxy({}, { get: (_t, k) => (k === '$disconnect' ? async () => {} : mk(String(k))) });
  return { p, calls, deleted: () => calls.filter((c) => c[0] === 'deleteMany').map((c) => `${c[1]}::${JSON.stringify(c[2])}`) };
}

describe('v2.65 · 删除计划是行为可证伪的（不依赖循环写法）', () => {
  it('★ 默认档（dry-run）：一次 deleteMany 都不许发生', async () => {
    const f = fakePrisma({ counts: { paymentVoucher: 3, userAccount: 11 } });
    const r = await runDeletePlan(f.p, { apply: false });
    expect(r.mode).toBe('dry-run');
    expect(f.deleted(), 'dry-run 里出现了 deleteMany ⇒ 只读承诺破了').toEqual([]);
    // 17 = paymentVoucher 在清单里出现两次（D6 按 voucherNumber / C7WO 按 id）⇒ 3+3+11。
    // ★ 这就是复核 IMPORTANT-5 说的「合计是按目标求和、不是按行求和」：谓词互不重叠时二者相等，重叠时合计会虚高。
    expect(r.hit, '命中数应把 sensitive 面也算进去（要看得见）').toBe(17);
  });

  it('★ `--apply` 不给 flag：敏感面必须不在 deleteMany 集合里，其余全部在', async () => {
    const f = fakePrisma();
    const r = await runDeletePlan(f.p, { apply: true, allowSensitive: false });
    const models = f.deleted().map((x) => x.split('::')[0]);
    expect(models, '账号面被默认删除').not.toContain('userAccount');
    const expectModels = drillTargets().filter((t) => !t.sensitive).map((t) => t.model);
    expect([...new Set(models)].sort(), '删除面 ≠ 清单里"非敏感"那部分（要么漏删要么多删）').toEqual([...new Set(expectModels)].sort());
    // ★ v2.66（复核 IMPORTANT-2）：极性要对——"合法地多一张敏感表"必须**继续绿**，
    //   所以这里比的是"派生出来的敏感条数"，不是钉死 1。上一版钉 `toBe(1)` 是反方向断言（加第 2 张会红、不加反而绿）。
    const sensitiveTargets = drillTargets().filter((t) => t.sensitive).length;
    expect(r.skippedSensitiveTargets, '跳过的条数必须等于清单里 sensitive 的条数（派生，不是写死的数）').toBe(sensitiveTargets);
    expect(sensitiveTargets, '但至少要有 1 条（0 = 账号面又回到无人保护）').toBeGreaterThanOrEqual(1);
    expect(models, '清单里所有 sensitive 模型都不许出现在删除面').not.toContain('userAccount');
  });

  it('★ 给 `--allow-sensitive`：敏感目标以**什么谓词**被删，必须就是认领条件本身', async () => {
    const f = fakePrisma();
    await runDeletePlan(f.p, { apply: true, allowSensitive: true });
    const acc = f.deleted().filter((x) => x.startsWith('userAccount::'));
    expect(acc.length, '放开后账号面确实进入删除面').toBe(1);
    expect(JSON.parse(acc[0].split('::')[1]), '谓词必须是 TEST_ACTOR_ 前缀族（不是全表、也不是枚举名单）').toEqual({ id: { startsWith: 'TEST_ACTOR_' } });
  });

  it('★ 反查关联确实进删除面（真库今天合同 0 行 ⇒ 这条只有注入才验得到）', async () => {
    const f = fakePrisma({ contractRows: [{ id: 'FFX__A' }, { id: 'FFX__B' }] });
    await runDeletePlan(f.p, { apply: true });
    const links = f.deleted().filter((x) => x.startsWith('forwardFxSettlementLink::'));
    expect(links.some((x) => x.includes('"in":["FFX__A","FFX__B"]')), '按合同 id 反查出的关联行必须进入删除面').toBe(true);
  });

  it('★ 模型没登记删除顺序 ⇒ 抛错，且抛之前一行都不删（反面对照，用内存里临时塞目标的方式）', async () => {
    const f = fakePrisma();
    const before = f.deleted().length;
    // 直接改内存里的清单数组（不写文件、不连库）：模拟"下一批人加了张表但忘了登记删除顺序"
    DRILL_TARGETS.push({ label: '假想新表（测顺序守卫）', model: 'someBrandNewModel', field: 'id', prefix: 'TEST_ZZZ_', sensitive: false });
    try {
      await expect(runDeletePlan(f.p, { apply: true })).rejects.toThrow(/删除顺序表/);
      expect(f.deleted().length, '顺序表缺登记时必须**一行都不删**（不是删一半再报错）').toBe(before);
    } finally {
      DRILL_TARGETS.pop();
    }
    // 还原后必须恢复正常 ⇒ 证明上面那条红是"缺登记"造成的，不是清单本身枚举坏了
    const g = fakePrisma();
    const r = await runDeletePlan(g.p, { apply: true });
    expect(r.mode, '还原后应恢复正常执行').toBe('apply');
    expect(g.deleted().length, '删除调用数必须等于非敏感目标数（多一个少一个都是分裂口径）').toBe(drillTargets().filter((t) => !t.sensitive).length);
  });

  it('★ 单条删除失败不许被吞：failures 要计数（复核 MINOR-4：`-1` 折进求和 = 未标注的下界）', async () => {
    const f = fakePrisma({ counts: { paymentVoucher: 5 }, throwOnModel: 'paymentVoucher' });
    const r = await runDeletePlan(f.p, { apply: true, approved: true });
    expect(r.failures, '删除失败必须被计入 failures（否则"仍剩 0 行"是假的）').toBeGreaterThan(0);
    expect(r.remain, '失败后复核应报出残留').toBeGreaterThan(0);
  });

  it('★ 待批族（复核 IMPORTANT-3）：命中 > 0 且没带 approved ⇒ **拒绝执行**；带了才动；两轴不混为一谈', async () => {
    const f = fakePrisma({ counts: { paymentVoucher: 495 } });
    await expect(runDeletePlan(f.p, { apply: true, approved: false })).rejects.toThrow(/待批族|approved/);
    expect(f.deleted(), '拒绝执行必须是"一行都不删"，不是半删半留').toEqual([]);
    const g = fakePrisma({ counts: { paymentVoucher: 495 } });
    await runDeletePlan(g.p, { apply: true, approved: true });
    expect(g.deleted().filter((x) => x.startsWith('paymentVoucher::')).length, '显式 approved 后待批族才进入删除面').toBeGreaterThan(0);
    expect(APPROVAL_REQUIRED_MODELS, '这一轴不许为空（空了就退化成"没人管"）').toContain('paymentVoucher');
    // 恒真检查：pending 判定不能把 sensitive 目标也算进来（否则 userAccount 会同时被两轴拦，报错信息误导）
    expect(APPROVAL_REQUIRED_MODELS, 'userAccount 在两轴都出现是**有意的**（它既不可逆又等待批）').toContain('userAccount');
  });

  it('★ 复核 BLOCK-1 的根因：CLI 壳也必须是可驱动的（只测中间函数 = 覆盖面不够）', async () => {
    const f = fakePrisma();
    const code = await runCli({ prisma: f.p, argv: ['--apply', '--approved'], log: () => {} });
    expect(code, 'runCli 走到底应返回退出码 0').toBe(0);
    expect(f.deleted().length, 'runCli 必须真的驱动到删除计划（否则这层壳又成了守卫盲区）').toBe(drillTargets().filter((t) => !t.sensitive).length);
    const dry = fakePrisma();
    await runCli({ prisma: dry.p, argv: [], log: () => {} });
    expect(dry.deleted(), '默认档 runCli 不得触达任何删除').toEqual([]);
  });

  it('★ 调用点普查：消费者文件里的 `deleteMany(` 站点数必须等于登记值（多一处就逼人来表态）', () => {
    // ★ 只数**代码行**：本轮我自己就往文件头的说明里写了两次 `deleteMany(` ⇒ 含注释的普查会虚高（B76 那一族：尺读到不该读的东西）。
  const census = (rel: string) => readFileSync(join(REPO, rel), 'utf8').split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .reduce((n, l) => n + (l.match(/\.deleteMany\s*\(/g) ?? []).length, 0);
    const sites = { 'server/scripts/cleanup-test-residue.mjs': 1, 'scripts/clean-drill-residue.mjs': 0 };
    for (const [rel, want] of Object.entries(sites)) {
      expect(census(rel), `${rel} 的 deleteMany 调用点数变了（登记 ${want}，实得别的）⇒ 要么新删点在守卫盲区，要么该把它纳入判据`).toBe(want);
    }
    // 恒真检查：普查函数必须真的数得到（cleanup 有 1 处；若正则瞎了会数成 0 而"恰好等于"某些 want）
    expect(census('server/scripts/cleanup-test-residue.mjs'), '正则数不到就说明这把尺瞎了').toBeGreaterThan(0);
    expect((readFileSync(join(REPO, 'server/scripts/cleanup-test-residue.mjs'), 'utf8').match(/\.deleteMany\s*\(/g) ?? []).length, '对照：含注释的原始数应更大（说明这把尺确实在过滤，而不是恒 0）').toBeGreaterThan(1);
  });
});

describe('v2.65 · "能不能默认删"必须逐条显式表态（复核 BLOCK-2）', () => {
  it('★ 缺 sensitive 字段 ⇒ 抛（缺省不等于可删）', () => {
    expect(() => assertSensitiveVerdict({ model: 'order', label: 'x' })).toThrow(/显式表态/);
    expect(() => assertSensitiveVerdict({ model: 'order', label: 'x', sensitive: false })).not.toThrow();
    // 恒真检查：清单里若有条目没表态，drillTargets() 整体就该抛 ⇒ 这里必须能跑通（跑通即证明现在全部表过态）
    expect(drillTargets().every((t) => typeof t.sensitive === 'boolean')).toBe(true);
  });

  it('★ 敏感模型清单不许被登记成默认可删（加第 2 张敏感表也走得通，不是"恰好 1 条"）', () => {
    for (const m of MUST_BE_SENSITIVE_MODELS) {
      expect(() => assertSensitiveVerdict({ model: m, label: m, sensitive: false }), `${m} 属强制敏感面`).toThrow(/MUST_BE_SENSITIVE/);
    }
    expect(MUST_BE_SENSITIVE_MODELS, '清单不许为空（空了就退化成"没人管"）').toContain('userAccount');
    // 反向：合法地新增一张敏感表必须能通过（证明判据不是"恰好 1 条"那种反方向断言）
    expect(() => assertSensitiveVerdict({ model: 'someFutureTable', label: 'y', sensitive: true })).not.toThrow();
  });

  it('★ 派生目标也必须带显式档位（此前返回 undefined，绕过了整套 sensitive 判据）', async () => {
    const f = fakePrisma({ contractRows: [{ id: 'FFX__A' }] });
    const list = await withDerivedLinks(f.p, drillTargets());
    const derived = list.filter((t) => String(t.label).includes('反查'));
    expect(derived.length, '有合同 id 时应派生出目标').toBe(1);
    expect(typeof derived[0].sensitive, '派生目标必须显式带 sensitive 档位').toBe('boolean');
    expect(DRILL_TARGETS.every((t) => 'sensitive' in t), '基座每条目标都要有 sensitive 这个 key').toBe(true);
  });
});

describe('v2.65 · 兄弟清扫器 cleanResidue 也要有同一道门（复核 IMPORTANT-3：一次 --apply 会删真账号）', () => {
  const Prisma = { dmmf: { datamodel: { models: [
    { name: 'UserAccount', fields: [{ kind: 'scalar', type: 'String', name: 'displayName' }, { kind: 'scalar', type: 'String', name: 'email' }] },
    { name: 'Notification', fields: [{ kind: 'scalar', type: 'String', name: 'title' }] },
  ] } } };
  const build = () => {
    const seen = [];
    const d = (model) => ({
      count: async () => (model === 'userAccount' ? 6 : 2),
      findMany: async () => (model === 'userAccount' ? [{ id: 'user_req217' }] : [{ id: 'n1' }]),
      deleteMany: async () => { seen.push(model); return { count: model === 'userAccount' ? 6 : 2 }; },
    });
    return { p: new Proxy({}, { get: (_t, k) => (k === '$disconnect' ? async () => {} : d(String(k))) }), seen };
  };

  it('★ 默认档：REQ2- 命中的账号行只报不删（现量库里真有 6 行、5 行 active、passwordHash 是真实 bcrypt）', async () => {
    const { p, seen } = build();
    const r = await cleanResidue({ prisma: p, Prisma, markers: ['REQ2-'] });
    expect(seen, 'userAccount 不该进入 deleteMany').not.toContain('userAccount');
    expect(seen, '其它模型仍应正常清理（门不能变成"什么都不删"）').toContain('notification');
    expect(r.skippedSensitiveRows, '跳过的**行数**必须报出来（不删 ≠ 看不见）').toBe(6);
    expect(r.skippedSensitiveTargets, '条数与行数分名（复核 IMPORTANT-4：两口径曾同名）').toBe(1);
  });

  it('★ 显式 allowSensitive 才动账号面', async () => {
    const { p, seen } = build();
    await cleanResidue({ prisma: p, Prisma, markers: ['REQ2-'], allowSensitive: true });
    expect(seen, '放开后必须真的动它（否则这个 flag 是假的）').toContain('userAccount');
  });
});
