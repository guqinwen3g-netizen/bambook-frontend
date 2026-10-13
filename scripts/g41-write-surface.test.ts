/**
 * G4.1 派生面的守卫（v2.56 起进门禁）——「写端点有没有门」从**手写清单**变成**派生 + 棘轮**
 *
 * ★ 为什么必须有它（§2 G4.1 自己要求的，不是我顺手加判据）：
 *   台账那句判据写着"角色与写操作都必须从真源派生，不得手写（R3）"，
 *   而此前仓里对"哪些写端点没挂门"**没有任何可跑读数** —— 上一刀（CRM 20 条）是人肉数的。
 *
 * ★ 三条反"静默失效"的设计（本仓 B35/B75/B76/B79  each 都栽过一次）：
 *   ① **新增裸写路由 ⇒ 立刻红**（naked 集合与基线逐条相等，不是只比数量）；
 *   ② **新增没归类的中间件形状 ⇒ 立刻红**（unknown 走棘轮，只许下降）——
 *      这一条专门对付"名字白名单静默过时"：下一个同事写 `requireFooAdmin` 或 `...(cond ? [g] : [])`，
 *      不会被悄悄判成"没门"或"有门"，而是被要求来归类；
 *   ③ **解析不出来 ⇒ 不许并入"已挂门"**（named-handler 与 unparsed 各成一桶，都有棘轮；分桶必须加得回总数）。
 *
 * ★ 本批**不声称** G4.1 达标：78 条裸写路由全部标 `untriaged`，其中有些是设计上公开的
 *   （`auth/login`、`/register`、`send-code`…），有些要逐条读 handler 才知道是否在内部做了校验 ⇒
 *   "拦截率 100%" 这句话现在**不许写**。台账登记见 §9 B80。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateWriteRoutes, summarize, classifyGuardArg, extractLocalGates, extractLocalGuards, reconcileSiteLists, siteKey, validateSetChangeLog } from './lib/writeRouteSurface.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = JSON.parse(readFileSync(join(REPO, 'scripts/baselines/g41-write-surface.json'), 'utf8'));
const surface = enumerateWriteRoutes(REPO);
const sum = summarize(surface.routes);

describe('G4.1 · 写端点面是派生的，且新增缺陷必须当场红', () => {
  it('★ 分母非空：扫不到写路由 = 这把尺在空转（此时任何"覆盖率"都不作数）', () => {
    expect(surface.files, '路由文件数为 0 ⇒ 枚举器没找到 src，别把"零命中"当"没问题"').toBeGreaterThanOrEqual(60);
    expect(sum.total, '一条写路由都没枚举到 ⇒ 判据恒真').toBeGreaterThanOrEqual(600);
    expect(sum.denominatorIsMeaningful).toBe(true);
  });

  it('★ 分桶必须加得回总数（加不回去就是有一桶被悄悄吞了）', () => {
    expect(sum.guarded + sum.nakedNoRouterGuard + sum.namedHandlerUntouched, JSON.stringify(sum)).toBe(sum.total);
  });

  it('★ 裸写路由集合必须与基线**逐条相等**（新增 ⇒ 红；修好 ⇒ 同一批来删条目）', () => {
    const now = surface.routes.filter((x) => x.shape === 'naked' && !x.routerLevelGuard).map(siteKey).sort();
    const base = [...BASELINE.nakedWriteRoutes].sort();
    expect(now.filter((k) => !base.includes(k)), '新增了没挂门的写路由 ⇒ 要么补门，要么在这里显式登记为公开端点并写理由').toEqual([]);
    expect(base.filter((k) => !now.includes(k)), '基线里的条目已经不存在（路由被删/改名/补了门）⇒ 必须同步清理基线，别让它变成假账').toEqual([]);
    expect(now.length, `与基线数量不符：基线 ${BASELINE.nakedWriteRoutes.length}`).toBe(BASELINE.nakedWriteRoutes.length);
  });

  it('★ 基线里每条裸路由都要有判定（untriaged 只许下降；不许有空白条目）', () => {
    const missing = BASELINE.nakedWriteRoutes.filter((k) => !BASELINE.triageVerdicts[k]);
    expect(missing, '基线里出现没有 verdict 的条目 ⇒ 登记了但没人看过').toEqual([]);
    const untriaged = BASELINE.nakedWriteRoutes.filter((k) => BASELINE.triageVerdicts[k]?.verdict === 'untriaged');
    // ★ 断言的是"与登记数之差为零"，不是 x === x（那是 B79 刚栽过的恒等式）
    expect(untriaged.length, `未定性的裸写路由 ${untriaged.length} 与登记棘轮 ${BASELINE.ratchet.untriagedMax} 不符 ⇒ 要么新增了，要么同批来降棘轮`).toBe(BASELINE.ratchet.untriagedMax);
  });

  /**
   * ★★ v3.12：把"重冻结"从盲操作变成有闸的操作 —— 键里的行号是噪声，签名才是那条路由
   *
   * 本批现场：B129 只改了 `claimRoute.ts` catch 里的 4 行，注册一行没动，守卫却红 9 条
   * （8 条 naked + 1 条 authnOnly 全是行号搬家）。这种红**本身可接受**（键含行号就要付这个代价，
   * 换来的是定位快 + 同 file/method/path 重复注册不会被并成一条），**不可接受的是修法**：
   * 谁都可能不看原因直接 `--write`，于是"真新增了一条裸写路由"和"行号搬家"混成同一个动作。
   * 现在写手先看签名（file, method, pathKey）：搬家 ⇒ 放行并自动带着 verdict 走；变了 ⇒ 不落盘。
   */
  it('★ 签名层对账：行号搬家放行、集合变化必须被抓（四个方向各钉一条，缺一向就是半个判据）', () => {
    const K = (l: number) => `server/src/x/route.ts:${l} POST '/thing'`;
    // ① 放行侧（本批真实读数）：基线与实测按签名必须完全相等 ⇒ 这次红确实是行号搬家，不是仓变了
    const nakedNow = surface.routes.filter((x) => x.shape === 'naked' && !x.routerLevelGuard).map(siteKey);
    expect(reconcileSiteLists({ nakedWriteRoutes: [...BASELINE.nakedWriteRoutes] }, { nakedWriteRoutes: nakedNow }),
      '签名层对不上 ⇒ 有裸路由被新增/删除/改名，那不该由一次自动重冻结悄悄带过').toEqual({});
    // ② 反面对照 A：多出一条没登记过的路由 ⇒ 必须报（这是"盲 --write"唯一会被拦下的那一格）
    expect(reconcileSiteLists({ a: [K(1)] }, { a: [K(1), "server/src/x/route.ts:9 POST '/brand-new'"] }))
      .toHaveProperty('a');
    // ③ 反面对照 B：少了一条（补上门了）⇒ 同样必须报，别把它和搬家混起来
    expect(reconcileSiteLists({ a: [K(1), K(2)] }, { a: [K(1)] })).toHaveProperty('a');
    // ④ 反面对照 C：**同签名重数**变化也要报（两条同 file+method+path 塌成一条 = 去重把缺陷藏掉）
    expect(reconcileSiteLists({ a: [K(1), K(2)] }, { a: [K(3)] })).toHaveProperty('a');
    // 恒真检查：只做行号搬家 ⇒ 上面三条若连"搬家"都报，这条判据就退化成"什么都拦"
    expect(reconcileSiteLists({ a: [K(1), K(2)] }, { a: [K(7), K(8)] })).toEqual({});
  });

  /**
   * ★ 复核 M-2 的处置：清单既然由写手派生，"集合有没有变"就不能再靠测量与基线对撞来发现
   *   （两边同源 ⇒ 恒真）。唯一的机器可查证据是基线里那份 `_setChangeLog`：
   *   每次放行必须留一条带**理由**的记录，且最后一条记下的条数必须等于当前清单条数
   *   ⇒ 有人直接手改 JSON（绕过写手）就会在这里红。
   */
  it('★ 集合变化须有准确多重集差额、源码指纹和完整审计链，允许有已审核的非空记录', () => {
    expect(validateSetChangeLog(BASELINE)).toEqual([]);
    const log=BASELINE._setChangeLog??[];
    expect(log.length,'本次记录测量纠正与真实新增路由，不能靠永远空 log 偷过').toBeGreaterThan(0);
    const missing=structuredClone(BASELINE); delete missing._setChangeLog.at(-1).sourceEvidence;
    expect(validateSetChangeLog(missing).length).toBeGreaterThan(0);
    const fake=structuredClone(BASELINE);fake._setChangeLog.at(-1).added={};
    expect(validateSetChangeLog(fake).length).toBeGreaterThan(0);
    const alteredSource=structuredClone(BASELINE);alteredSource._setChangeLog.at(-1).sourceEvidence.files[0].sha256='fake';
    expect(validateSetChangeLog(alteredSource).length).toBeGreaterThan(0);
    const collapsed=structuredClone(BASELINE);collapsed.nakedWriteRoutes.pop();
    expect(validateSetChangeLog(collapsed).length).toBeGreaterThan(0);
  });

  it('★ 未归类的中间件形状与解析失败的站点：只许下降（新形状必须被逼着表态）', () => {
    // 棘轮量在**去重后的形状**上（同一形状出现 20 次只是一种形状）；另要求基线里登记的形状都还在，
    // 否则「有人归类了却没同步基线」会留下一份假装存在的债。
    const unknownShapes = [...new Set(surface.unknown.map((u) => u.ident))];
    expect(
      unknownShapes.length,
      `出现未归类的中间件形状，超过棘轮 ${BASELINE.ratchet.unknownMax}：\n${JSON.stringify(unknownShapes.slice(0, 6))}`,
    ).toBeLessThanOrEqual(BASELINE.ratchet.unknownMax);
    // ★ 集合相等（不是"只查少、不查多"）：归类了就必须同批重冻结，忘了就红；重冻结本身在 diff 里留痕
    expect(unknownShapes.sort(), '已归类的形状没同步基线，或出现了新形状').toEqual([...BASELINE.unknownGuardShapes].sort());
    expect(surface.unparsed.length, `解析失败的写路由超过棘轮 ${BASELINE.ratchet.unparsedMax}：${JSON.stringify(surface.unparsed)}`).toBeLessThanOrEqual(BASELINE.ratchet.unparsedMax);
    expect(sum.namedHandlerUntouched, '「最后一个实参不是内联 handler」这种形状超过棘轮 ⇒ 它既不算有门也不算裸，必须重新核对而不是悄悄并桶').toBeLessThanOrEqual(BASELINE.ratchet.namedHandlerMax);
  });

  it('★ 基线 totals 必须与实测逐字段相等（否则基线就是第二处会腐烂的真源）', () => {
    /**
     * 起因（v2.61 复核 A2 的 BLOCK）：本批把尺改完之后，基线里 `total/guarded/permissionCovered/namedHandlerUntouched`
     * 仍是上一版尺的 655/563/608/14，而**没有任何断言读过这几个字段** ⇒ 旧数可以无限期躺在"唯一出处"里被引用。
     * 更糟的连带后果：拿这份**过期清单**去对撞新读数，会把"尺改了"误报成"仓变了"
     * —— 我自己就这样写错了一次归因表（见 docs/G41第三刀 §三 的更正）。
     */
    expect(
      { ...BASELINE.totals },
      `基线 totals 与实测不符 ⇒ 尺改过却没同批重冻结（跑 node scripts/g41-derive-surface.mjs --write）：\n实测 ${JSON.stringify(sum)} / 基线 ${JSON.stringify(BASELINE.totals)}`,
    ).toMatchObject({ ...sum, routeFiles: surface.files, unparsed: surface.unparsed.length });
    expect(BASELINE.namedHandlerRoutes.sort(), 'named-handler 清单也必须跟着重冻结').toEqual(
      surface.routes.filter((x) => x.shape === 'named-handler').map(siteKey).sort(),
    );
  });

  it('★ 反面对照（决定上面几条不是恒真）：分类器必须拒绝"看起来像门"的新形状', () => {
    expect(classifyGuardArg('requirePermission("orders:write")', {}, "import {requirePermission} from '../auth/permissionGuard';")).toBe('permission');
    expect(classifyGuardArg('...requireRoomWrite', { requireRoomWrite: { cls: 'permission' } })).toBe('permission');           // 展开数组 = 仍是门
    expect(classifyGuardArg('requireNeverSeenBeforeGuardXYZ')).toBe('unknown');     // 新名字 ⇒ 逼表态
    expect(classifyGuardArg('...(flag ? [requireAdmin] : [])')).toBe('unknown');    // 条件门 ⇒ 不许算门
    expect(classifyGuardArg('upload.single("file")',{},"import multer from 'multer';const upload=multer({});")).toBe('nonPermission');
    // 恒真检查：把权限门换成注释也能被判成 permission 的话，上面所有绿色都是假的
    expect(classifyGuardArg('/* 忘了挂门 */')).not.toBe('permission');
    expect(classifyGuardArg('requireWrite', { requireWrite: { cls: 'unknown' } }), '局部来源未知时不能凭名字补成权限门').toBe('unknown');
    expect(classifyGuardArg('...requireRoomWrite', { requireRoomWrite: { cls: 'identity' } }), '局部来源只有身份时名字不能补权限').toBe('identity');
    expect(summarize([]).denominatorIsMeaningful, '空分母必须报"不可判"，不许报"干净"').toBe(false);
  });
});

/**
 * ## ★★ v2.57 第二刀：把"门写在 handler 体内 / 挂载点注入"这两层接进派生面
 *
 * v2.56 那句"78 条没有任何门"**是尺的口径问题，不是仓的实情**：
 *   · `mesRoute` 26 条的门是 `if (!requireProductionWrite(req,res)) return;` —— 在**体内**，参数表里一个字都没有；
 *   · 一批 router 靠 `server/src/index.ts` 的 `sdkAuth(req,res,()=>router(...))` 包装拿认证 —— 在**挂载层**；
 *   · 而 `createXRouter({ requireAuth: SDK_CONFIG.requireAuth })` 里的 `requireAuth` **是 boolean 不是中间件**
 *     （`= process.env.BAMBOOK_REQUIRE_AUTH==='true' || NODE_ENV==='production'`），
 *     且这些局部门第一行几乎都是 `if (!requireAuth) return true;` ⇒ 本地模式下整条链放行。
 *     ⇒ 所以本批特意**不给它记任何一层的功**（下面第三条断言钉住这件事，也钉住"将来有人把它当门"）。
 */
describe('G4.1 门的四种落点（参数表 / 文件级 router.use / handler 体内 / 挂载点注入）与它的分桶对账', () => {
  const { routes, mounts, unknown } = surface;
  const s = sum;
  const noEv = routes.filter((x) => !x.permissionCoveredAllLayers && !x.authnCoveredAllLayers).map(siteKey).sort();
  const authn = routes.filter((x) => !x.permissionCoveredAllLayers && x.authnCoveredAllLayers).map(siteKey).sort();

  it('★ 三桶必须加得回总数（D89）：permission / 只有身份 / 什么证据都没有', () => {
    expect(s.permissionCovered + s.authnOnlyNoAuthz + s.noEvidenceAtAll, `三桶 ${s.permissionCovered}+${s.authnOnlyNoAuthz}+${s.noEvidenceAtAll} 加不回 ${s.total}`).toBe(s.total);
    expect(s.noEvidenceAtAll, '全部为 0 = 尺瞎了或所有门都被认成 permission，两种都不能报"干净"').toBeGreaterThan(0);
  });

  it('★ noEvidence / authnOnly 两个集合必须与基线逐条相等（新增立刻红，修好要同批删条目）', () => {
    expect(noEv, '出现了新的"三层都没证据"的写路由 ⇒ 要么补门要么写明理由').toEqual([...BASELINE.noEvidenceRoutes].sort());
    expect(authn, '出现新的路由层只有身份证据的端点；跨服务授权仍须独立验证').toEqual([...BASELINE.authnOnlyRoutes].sort());
    expect(s.noEvidenceAtAll).toBe(BASELINE.ratchet.noEvidenceMax);
    expect(s.authnOnlyNoAuthz).toBeLessThanOrEqual(BASELINE.ratchet.authnOnlyMax);
    expect(routes.filter((x) => !x.bodyBounded).length, 'handler 体定不了界的路由数（越读越远 = 可能给绿）').toBeLessThanOrEqual(BASELINE.ratchet.bodyUnboundedMax);
  });

  it('★ requireAuth 是 boolean 不是门：这些文件的任何一条路由都不许因为挂载层被记功', () => {
    const boolOnly = new Set(mounts.booleanFlagOnlyFiles);
    expect(boolOnly.size, '本仓实测：多数 router 只拿到 requireAuth 这个布尔 ⇒ 集合不该是空的（空了说明挂载解析瞎了）').toBeGreaterThan(10);
    const credited = routes.filter((x) => boolOnly.has(x.file) && (x.mountAuthn || x.mountPermission));
    expect(credited.map(siteKey), '只传了 boolean 的文件却拿到挂载层记功 ⇒ 把布尔当中间件了（这正是 B76 那类"把字面量当结构"）').toEqual([]);
  });

  it('★ 分类器按"做了什么"分，不按名字猜：四处现场形状各钉一条', () => {
    const src = (p: string) => readFileSync(join(REPO, p), 'utf8');
    const mes = extractLocalGates(src('server/src/mes/mesRoute.ts'));
    expect(mes.authenticate?.cls, 'authenticate 只验身份（无 actor ⇒ 401）⇒ 不许升成 permission').toBe('authn');
    expect(mes.scopeGate?.cls, 'scopeGate 判 hasScope ⇒ permission').toBe('permission');
    expect(mes.requireProductionWrite?.cls, '组合门（= authenticate && scopeGate）必须继承 permission，否则 mesRoute 26 条被降级').toBe('permission');
    // 返回类型注解带花括号时，体不能从类型注解那里开始切（实测会静默丢掉整个门）
    expect(Object.keys(extractLocalGates(src('server/src/approvals/approvalKernelRoute.ts'))).length, '带 `): { userId: string } | null =>` 的门必须被认出来').toBeGreaterThanOrEqual(1);
    // `const apiKey = (req.query.apiKey as string) || …` 不是门 ⇒ 不许因为它里面出现 res.status 就给绿
    expect(Object.keys(mes)).not.toContain('apiKey');
    // 恒真检查：门全被判成 authn 的话，上面四条里有三条会同时失去意义
    expect(Object.values(mes).filter((g: any) => g.cls === 'permission').length, 'mes 里必须至少有一个 permission 门（全 0 = 分类器瞎了）').toBeGreaterThan(0);
  });

  it('★ 新旧口径的差额必须逐条可解释（不许"换个口径把数改小"当进步）', () => {
    const oldNaked = new Set(BASELINE.nakedWriteRoutes as string[]);
    const moved = routes.filter((x) => oldNaked.has(siteKey(x)) && x.permissionCoveredAllLayers);
    expect(moved.length, 'v2.56 判"没门"、现在判"有权限门"的路由必须**每一条都拿得出口内证据**').toBeGreaterThan(0);
    const unexplained = moved.filter((x) => !x.bodyPermission && !x.mountPermission);
    expect(unexplained.map(siteKey), '说不上来门在哪的"改判"= 拿口径变化冒充改进').toEqual([]);
    // 反向：新口径判"什么证据都没有"的，必须确实是旧口径里那批的一部分或被旧口径漏掉的（不能凭空多出来）
    const stillNoEv = routes.filter((x) => oldNaked.has(siteKey(x)) && !x.permissionCoveredAllLayers && !x.authnCoveredAllLayers);
    expect(stillNoEv.length, '旧名单里应当仍有"补完两层也没证据"的条目（全是 0 = 新尺在给绿）').toBeGreaterThan(0);
    // ★ 原先这里写死 80 = 第二处真源（尺改了数就得记得来改这个字面量，忘了就是静默放过）。改成读基线棘轮。
    expect(unknown.length, `unknown 条目数超过基线棘轮 ${BASELINE.ratchet.unknownEntriesMax}（同一形状多一处也算涨）`).toBeLessThanOrEqual(BASELINE.ratchet.unknownEntriesMax);
  });

  /**
   * ★★ v2.60：B88 的第二档（配置依赖）与两处新假洞
   *   这两处假洞都是**我自己前一批造的**：v2.59 为了不再"按名字猜"，把 `create*AuthGuard` 之类从名字表里删了，
   *   结果 ① `const requireReleaseAdmin = [requireWrite, requirePermission('…')]`（**数组门**）整族判 unknown、
   *   ② `const sdkAuth = (req,res,next) => {…}`（**具名箭头门**）在参数表位置拿不到身份功
   *   ⇒ releaseRoute 3 条 + index.ts 2 条被判成"什么证据都没有"。修法是把定档依据从"名字"换成"赋值来源/函数体做了什么"。
   */
  it('★ 尾逗号伪像：多行注册不得被降成 named-handler，也不得往 unknown 里塞空 ident', () => {
    /**
     * 这 13 条从前被尺自己误分进"形状判不了"桶（`router.post(` 换行列实参 + 尾逗号 ⇒ splitArgs 切出空段）。
     * 空段还去归类门 ⇒ unknown 里 13 条 ident 为空的噪声。修在解析边界。
     * ★ 牙齿：若有人把 `if (args) while (…) args.pop()` 拿掉，本例两条断言都会红（真仓读数 + 合成形状）。
     */
    expect(s.namedHandlerUntouched, '真仓里"最后一个实参不是内联 handler"的只剩 1 条（admin disable-account 的真命名 handler）').toBe(1);
    expect(routes.filter((x) => x.shape === 'named-handler').map((x) => ({ file: x.file, method: x.method, pathKey: x.pathKey })),
      'named-handler 必须恰一条且保持注册身份；行号漂移不改变身份，新增或重复注册仍必须红').toEqual([
      { file: 'server/src/admin/route.ts', method: 'POST', pathKey: "'/users/:id/disable-account'" },
    ]);
    expect(unknown.filter((u) => u.ident.trim() === '').length, 'unknown 里不许有 ident 为空的条目（清单看了等于没看）').toBe(0);
  });

  it('★ 姿态对账：权限覆盖要拆成"强/配置依赖"，且"有门"不等于"拦得住写"', () => {
    /**
     * ⚠️ 下面这条 `强档 + 配置档 == 权限档` 是**同一次 summarize 的代数恒等式**（复核 B-2 点破：
     *    它自己不可能红 —— 把 25 条从强档挪进配置档，14 例全绿）。留着只当"两档没漏条目"的自检，
     *    **不许**把它读成"这一档有守卫"。真正咬人的是下面两条**逐条集合对撞**：
     *    条目在档位之间移动 ⇒ 集合差一个元素 ⇒ 红（不管两档相加对不对）。
     */
    expect(s.permissionCoveredStrong + s.permissionCoveredButConfigDependent, '强档 + 配置档 加不回权限覆盖总数').toBe(s.permissionCovered);
    const cfg = routes.filter((x) => x.permEvidenceAllBooleanGated).map(siteKey).sort();
    expect(cfg, '配置档条目集合与基线不符 ⇒ 有路由在"强/配置依赖"之间移动而没人签字（本条就是 B-2 的牙齿）').toEqual([...(BASELINE.configDependentRoutes ?? [])].sort());
    expect(cfg.length, '配置档条数与棘轮不符').toBe(BASELINE.ratchet.configDependentMax);
    const ro = routes.filter((x) => x.permEvidenceReadOnly).map(siteKey).sort();
    expect(ro, '读档 scope 集合与基线不符 ⇒ 新增要登记、修好要同批删条目').toEqual([...(BASELINE.readOnlyScopeRoutes ?? [])].sort());
    expect(ro.length, '读档档条数与棘轮不符').toBe(BASELINE.ratchet.readOnlyScopeMax);
    expect(s.permissionCoveredReadOnlyScope, '"写面只挂读档 scope"必须 > 0（实测 0 = 这一档的判据瞎了）').toBeGreaterThan(0);
    expect(s.authnOnlyButConfigDependent, '"只有身份"这一档里连身份都配置依赖的条数不得超过该档总数').toBeLessThanOrEqual(s.authnOnlyNoAuthz);
    /** ★ B-2 的另一半：档位**数量**变了但集合没同步 ⇒ 一定红（这条把"只比总数"的假绿路径堵掉） */
    expect(BASELINE.configDependentRoutes.length, '基线 configDependentRoutes 条数必须等于 configDependentMax（否则清单与棘轮脱钩）').toBe(BASELINE.ratchet.configDependentMax);
  });

  it('★ 数组门与具名箭头门：两处假洞都拿真文件钉住，且必须能拒绝"数组里混进判不出的成员"', () => {
    const src = (p: string) => readFileSync(join(REPO, p), 'utf8');
    const rel = extractLocalGuards(src('server/src/production/releaseRoute.ts'));
    expect(rel.requireReleaseAdmin?.cls, '`const X = [requireWrite, requirePermission(…)]` 必须按成员组合定档成 permission').toBe('permission');
    const defs = extractLocalGuards(src('server/src/index.ts'));
    expect(defs.sdkAuth?.cls, 'sdkAuth 体内只有 401/403 与 API Key 校验 ⇒ 是身份门，不许升成权限').toBe('identity');
    expect(defs.sdkAuth?.booleanGated, '`if (!SDK_CONFIG.requireAuth) return next();` ⇒ 身份功本身也依赖配置（B88 同一族）').toBe(true);
    // 真文件侧：这三条/两条确实不在"什么证据都没有"里
    const noEvKeys = new Set(noEv);
    expect(noEvKeys.has('server/src/production/releaseRoute.ts:85 POST \'/release-scopes/:scopeId/:action\''), '数组门修好后这条不该再被报成无证据').toBe(false);
    expect(noEvKeys.has('server/src/samples/sampleRoute.ts:278 POST \'/garment/:id/submit-qc\''), '同上').toBe(false);
    // ★ v3.87：这里原来**硬编码行号**（`…index.ts:1823 POST '/api/orders/search'`）⇒ index.ts 一改行数
    //   （本批给调度器加门控就挪了 8 行）+ 基线一按行号重冻结，这条控制断言就假红（B102/B105 那族"钉实现字面"）。
    //   改成**不依赖行号**的匹配 + 反面对照（路径不同必须不匹配），这样它只咬"这条路由的身份功有没有被认出来"。
    const hasOrderSearchIdentity = (keys: string[]) => keys.some((k) => /^server\/src\/index\.ts:\d+ POST '\/api\/orders\/search'$/.test(k));
    expect(hasOrderSearchIdentity(authn), 'sdkAuth 当实参时要拿到身份功').toBe(true);
    expect(hasOrderSearchIdentity(['server/src/index.ts:1 POST \'/api/orders/other\'']), '反面对照：路径不同必须不匹配').toBe(false);
    // 反面对照（决定上面不是"什么数组都给绿"）：成员判不出档 ⇒ 整个数组不并桶，且逐成员逼表态
    const synth = extractLocalGuards('const gate = [mysteryHelper(x), anotherThing(y)];\n');
    expect(synth.gate?.cls, '成员全判不出档的数组**不许**被认成门').toBe('unknown');
    expect(synth.gate?.unknownMembers, '未归类的成员必须逐个登记（否则数组成了藏 unknown 的地方）').toEqual(['mysteryHelper', 'anotherThing']);
    const mixed = extractLocalGuards("import {requirePermission} from '../auth/permissionGuard';\n" + 'const gate = [requirePermission(\'orders:write\'), mysteryHelper];\n');
    expect(mixed.gate?.cls, '含权限成员的数组按 permission 定档（展开时全部成员都会跑）').toBe('permission');
    expect(mixed.gate?.readScopeKnown, '带未归类成员的数组**不许**被判定为"只挂读档"').toBe(false);
    expect(mixed.gate?.unknownMembers, '未归类成员仍要逼表态').toEqual(['mysteryHelper']);
    const shadowed = extractLocalGuards('const requireWrite = createUnknownGate();\nconst gate = [requireWrite];\n');
    expect(shadowed.requireWrite?.cls, '未知工厂不能凭局部变量名字授予权限功').toBe('unknown');
    expect(shadowed.gate?.cls, '数组不能把未知来源requireWrite洗成已授权').toBe('unknown');
    expect(shadowed.gate?.unknownMembers).toEqual(['requireWrite']);
    // 读档档的两侧：同一形状只换 scope 后缀，判据必须翻面（钉行为，不钉实现字面）
    expect(extractLocalGuards("import {requirePermission} from '../auth/permissionGuard';\n" + 'const g = requirePermission(\'invoices:read\');\n').g?.readScopeKnown, ':read scope ⇒ 记为读档门').toBe(true);
    expect(extractLocalGuards("import {requirePermission} from '../auth/permissionGuard';\n" + 'const g = requirePermission(\'invoices:write\');\n').g?.readScopeKnown, ':write scope ⇒ 不许进读档桶').toBe(false);
  });
});
