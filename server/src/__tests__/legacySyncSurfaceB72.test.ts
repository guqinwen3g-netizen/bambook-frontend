/**
 * B72（台账 v2.44）· 遗留 broad-sync 写面的 scope 普查守卫。
 *
 * ★ 为什么是"读源码"而不是"真发请求"：`server/src/index.ts` **不可实例化**
 *   （1946 行、0 个 `^export`、`app.listen` 在文件尾、模块级 `new PrismaClient()` + `startScheduler`
 *   ⇒ 一 import 就起副作用与端口）。⇒ 本仓对这类文件既有做法就是**源码普查**
 *   （同 `opsPanelDeployCarryover.test.ts` 的 `readFileSync`、B69 的"分母从源码派生"）。
 *   ⚠️ 因此**路由级活路径证据按 S2 记为未覆盖**，不许写成"已端到端验证"。
 *
 * ★ 判据只有一份实现：`audit()` 同时喂真实源码与合成样本（正面对照），
 *   这样"把缺陷放回去会不会红"是可证的，而不是恒绿。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SYSTEM_ROLE_IDS, getDefaultScopeListForRole } from '../_shared/rolePermissionMatrix';

const SRC = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
const ROLE_IDS = Object.values(SYSTEM_ROLE_IDS) as string[];

/** 一条 legacy broad-sync 面：动词、路径、是否点名了 write scope */
type Surface = { verb: string; path: string; scoped: boolean; line: number };

/** 只量代码行（注释里引用旧写法不算债 —— 与台账 B48 的口径一致；本仓已多次因"数进注释"出假阳性） */
function codeText(src: string) {
  return src.split('\n')
    .filter((l) => { const t = l.trim(); return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
    .join('\n');
}

/** 会改状态的方法集合（★ `all` 在这一族里**默认按写面算** —— 面挂在 `app.all` 上就收得到 POST/PUT/PATCH/DELETE） */
const WRITE_VERBS = new Set(['all', 'post', 'put', 'patch', 'delete']);

/**
 * 只到身份、不带 scope 的挂法（`sdkAuth` 直挂）。
 * ★ v2.47 复核 I-2/I-3 的修正点：这类站点**过去被无条件当成"只读面、不构成写债"**（`scoped: true` 硬编码），
 *   于是 `app.post('/api/x', sdkAuth, h)` 这种"有身份就能写"的站点结构上不可能被抓到。
 *   现在它算**未定性的写面**，除非在下面这张**显式豁免表**里逐条写明"该端点只读"的理由
 *   （豁免按路径配、且"新增裸写面不登记就会红" ⇒ 见 nakedWrites 的断言与合成样本对照）。
 */
const READ_BY_SEMANTICS: Record<string, string> = {
  'POST /api/shipping-notice/generate': '读+渲染出文件，源码内无 prisma 写调用（v2.47 复核时逐行看过 handler）',
  'POST /api/orders/search': '搜索语义（POST 带 body 的查询），无写调用',
};

function audit(src: string) {
  const code = codeText(src);
  const surfaces: Array<Surface & { guard: string }> = [];
  src.split('\n').forEach((l, i) => {
    const t = l.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    const m = l.match(/^\s*app\.(all|get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*(legacyWriteGuard|sdkAuth|legacyReadOnly)/);
    if (!m) return;
    surfaces.push({
      verb: m[1],
      path: m[2],
      guard: m[3],
      scoped: m[3] === 'legacyWriteGuard'
        ? /legacyWriteGuard\(\s*'[a-zA-Z]+:(write|admin|approve|read)'\s*\)/.test(l)
        : m[1] === 'get',                       // ★ GET 才是真只读；其余动词的 sdkAuth 直挂 = 只到身份
      line: i + 1,
    });
  });
  const naked = surfaces.filter((s) => WRITE_VERBS.has(s.verb) && !s.scoped);
  return {
    surfaces,
    /** B72 原始病灶：**任何**写动词（含 all）挂着不点名 scope 的面，减去"写明理由的只读豁免" */
    nakedWrites: naked.filter((s) => !(`${s.verb === 'all' ? 'ALL' : s.verb.toUpperCase()} ${s.path}` in READ_BY_SEMANTICS)),
    /** 被豁免掉的只读面（单列出来，防止"豁免"变成第二个静默放行口） */
    exemptedWrites: naked.filter((s) => `${s.verb === 'all' ? 'ALL' : s.verb.toUpperCase()} ${s.path}` in READ_BY_SEMANTICS),
    allFaces: surfaces.filter((s) => s.verb === 'all').length,
    guardCalls: (code.match(/legacyWriteGuard\(\s*'[a-zA-Z]+:/g) ?? []).length,
    /** 守卫里"少传就放行"那句逃逸（类型改成必填还不够，防止有人再把这句加回来） */
    escapeHatch: /if\s*\(\s*!scope\s*\)\s*return\s+next\s*\(\s*\)\s*;/.test(code),
    /** 签名退回可选参数 ⇒ 少传参数会静默放行，必须红 */
    optionalScope: /legacyWriteGuard\s*=\s*\(\s*scope\?/.test(code),
    /** handleSync 有没有给"非 GET/POST"明确出口（原先会既不响应也不 next ⇒ 挂死到超时） */
    unsupportedMethodEscaped: /res\.status\(405\)/.test(code),
  };
}

describe('B72 · 遗留 broad-sync 写面普查（真实源码）', () => {
  const r = audit(SRC);

  /**
   * ★ v2.47 复核 I-3：这一条原来写的是 `>= 7`，而匹配的 regex 会把**任何** `app.<动词>('路径', sdkAuth…`
   *   都算进来 ⇒ 实测 16 条（all 6 / get 8 / post 2）⇒ 那条断言**恒真**，把整块 legacy 面删掉都照样绿
   *   （第二条 `verb === 'all' >= 6` 会红，所以原守卫不算整体空转，但第一条确实是假的严格）。
   *   现在改成**逐项等值**钉死，并把 `dev-memory` 的"写面收只读"这件事本身钉进断言。
   */
  it('★ 分母逐项钉死（不是 `>= 7` 那种恒真地板）', () => {
    expect(r.allFaces, '`app.all` 面数变了 ⇒ 台账 B72 行的分母要同步').toBe(6);
    expect(r.guardCalls, '点名了 scope 的 `legacyWriteGuard(...)` 调用点数').toBe(6);
    const devMem = r.surfaces.find((s) => s.path === '/api/dev-memory');
    expect(devMem?.verb, 'dev-memory 必须是 GET（v2.44 把它从 app.all 收成只读）').toBe('get');
    // 反面对照：把整块 legacy 面删掉 ⇒ allFaces 归 0，上面第一条当场红（原来的 `>= 7` 会被 sdkAuth 只读面填满）
    expect(audit("app.get('/api/whatever', sdkAuth, (req, res) => res.json({}));").allFaces).toBe(0);
  });

  it('★ 每条 `app.all` 写面都必须点名 scope（B72 前实测有 2 条裸着）', () => {
    expect(
      r.nakedWrites.map((s) => `${s.path} @ index.ts:${s.line}`).join('\n'),
    ).toBe('');
  });

  it('★ 守卫里不许有"少传 scope 就放行"的逃逸，签名也不许退回可选', () => {
    expect(r.escapeHatch, 'index.ts 又出现 `if (!scope) return next()`').toBe(false);
    expect(r.optionalScope, 'legacyWriteGuard 的 scope 又变回可选').toBe(false);
  });

  it('★ 非 GET/POST 必须有明确出口（原先挂死到超时）', () => {
    expect(r.unsupportedMethodEscaped, 'handleSync 又没有 405 出口 ⇒ PUT/PATCH/DELETE 会挂死').toBe(true);
  });

  it('★ 用到的每个 scope 都真有角色默认持有（防"编一枚没人有的 scope"= 全员 403）', () => {
    const used = new Set<string>();
    for (const m of SRC.matchAll(/legacyWriteGuard\(\s*'([^']+)'\s*\)/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThanOrEqual(4);
    const heldBySomeRole = new Set<string>();
    for (const role of ROLE_IDS) for (const s of getDefaultScopeListForRole(role as any)) heldBySomeRole.add(s);
    for (const s of used) expect(heldBySomeRole.has(s), `scope ${s} 没有任何角色默认持有`).toBe(true);
  });

  /**
   * ★ 可见行为变更取证（不靠推测）。`/api/insights` 原先**不查 scope** ⇒ 任何登录账号可写；
   *   本批挂 `knowledge:write`。逐角色实测结论：**7 个默认角色全部持有 `knowledge:write`**
   *   ⇒ 对默认角色**没有**可见行为变更（这正是"有出处的 scope"与 B69 那 6 个端点的区别）。
   *   价值不在"当下挡住某个角色"，而在关闭"少传一个参数就全放行"这一类，以及
   *   **自定义/被改过权限的角色**（矩阵可被 DB 覆盖，默认表不等于运行时）。
   *   ⚠️ 断言故意钉成"losing 必须为空"：一旦将来有人从默认角色里摘掉 knowledge:write，
   *      这条会红 ⇒ 逼着回来改台账那句"无可见行为变更"。
   */
  it('★ 逐角色实测 insights 写权限变化（台账要引用这份清单，不手写）', () => {
    const losing: string[] = [];
    const keeping: string[] = [];
    for (const role of ROLE_IDS) {
      const scopes = getDefaultScopeListForRole(role as any);
      (scopes.includes('knowledge:write') ? keeping : losing).push(role);
    }
    expect(ROLE_IDS.length).toBe(7);
    expect(losing, `这些角色从此写不了 insights ⇒ 台账"无可见行为变更"要改`).toEqual([]);
    expect(keeping.length).toBe(7);
  });
});

describe('B72 · 正面对照（把缺陷放回去，普查必须抓得住）', () => {
  const broken = [
    "app.all('/api/x', legacyWriteGuard(), (req, res) => handleSync(prisma.x, req, res, 'x'));",
    // ★ v2.47 复核 I-2 新增的两种形状：`app.post(... legacyWriteGuard())`（少传 scope）与
    //   `app.put(... sdkAuth)`（只到身份）。原来的判据只看 `verb === 'all'` ⇒ 这两条**结构上不可能被抓到**。
    "app.post('/api/z', legacyWriteGuard(), (req, res) => handleSync(prisma.z, req, res, 'z'));",
    "app.put('/api/w', sdkAuth, (req, res) => handleSync(prisma.w, req, res, 'w'));",
    "const legacyWriteGuard = (scope?: PermissionScope) => (req, res, next) => {",
    '        if (!scope) return next();',
  ].join('\n');
  const fixed = [
    "app.all('/api/x', legacyWriteGuard('knowledge:write'), (req, res) => handleSync(prisma.x, req, res, 'x'));",
    "app.get('/api/y', sdkAuth, (req, res) => handleSync(prisma.y, req, res, 'y'));",
    "const legacyWriteGuard = (scope: PermissionScope) => (req, res, next) => {",
    '        res.status(405).json({ error: "UNSUPPORTED_METHOD" });',
  ].join('\n');

  it('缺陷样本四条判据全命中（否则上面那几条是恒绿）', () => {
    const r = audit(broken);
    expect(r.nakedWrites.map((x) => `${x.verb} ${x.path}`), '三种形状都必须被算成裸写面').toEqual([
      'all /api/x', 'post /api/z', 'put /api/w',
    ]);
    expect(r.escapeHatch).toBe(true);
    expect(r.optionalScope).toBe(true);
    expect(r.unsupportedMethodEscaped).toBe(false);
  });

  /**
   * ★ 豁免表自身也要有"越界必被抓"：真实源码里被豁免的只读写面**恰好 2 条**，
   *   第三条裸写面若被悄悄加进 `READ_BY_SEMANTICS` 就会红（只能显式加，不能静默放行）。
   */
  it('★ 真实源码：被豁免的"只读写面"恰好 2 条，且逐条带理由', () => {
    const r = audit(SRC);
    expect(r.exemptedWrites.map((x) => `${x.verb.toUpperCase()} ${x.path}`).sort()).toEqual([
      'POST /api/orders/search', 'POST /api/shipping-notice/generate',
    ]);
    for (const x of r.exemptedWrites) {
      expect(READ_BY_SEMANTICS[`${x.verb.toUpperCase()} ${x.path}`], `${x.path} 的豁免理由必须写出来`).toBeTruthy();
    }
  });

  it('修复样本四条全清（否则普查是恒红）', () => {
    const r = audit(fixed);
    expect(r.nakedWrites.length).toBe(0);
    expect(r.escapeHatch).toBe(false);
    expect(r.optionalScope).toBe(false);
    expect(r.unsupportedMethodEscaped).toBe(true);
  });

  it('★ 只读面（app.get + sdkAuth）不算写债，但必须真的只有读', () => {
    const r = audit(fixed);
    const ro = r.surfaces.find((s) => s.path === '/api/y');
    expect(ro?.verb).toBe('get');
    expect(ro?.scoped).toBe(true);
    expect(r.surfaces.find((s) => s.path === '/api/x')?.verb).toBe('all');
  });
});
