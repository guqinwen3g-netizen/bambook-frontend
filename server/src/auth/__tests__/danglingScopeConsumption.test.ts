/**
 * 权限码「消费点登记」守卫（2026-09-17）
 *
 * ── 病灶类型 ─────────────────────────────────────────────
 * `PERMISSION_SCOPES` 里定义的码会被**分配给角色**（`DEFAULT_ROLE_PERMISSION_MATRIX`），
 * 于是「这个角色有这个能力」看起来成立；但若**代码里没有任何地方强制它**，
 * 这份分配就是**装饰性的** —— 权限矩阵在说谎，而系统不会报任何错。
 *
 * 典型实例：`aftersales:read/write/approve` 三码已定义、已按设计矩阵分配给
 * 业务员 / SM / 总领导 / QC / 单证 / 财务 / 审计，但**售后客诉模块整个不存在**
 * （`server/src` 下无 `aftersales/` 目录）→ **0 路由消费**。
 * 决策材料：`docs/L2-5-客户索赔模型-勘察与口径-2026-09-17.md`。
 *
 * ── 本文件做什么 ─────────────────────────────────────────
 * 把「悬空」从**未知**变成**登记在册**：
 *   1. 计算悬空集合（判据见下），断言 **=== 豁免登记表的键集合**（集合相等 ⇒ **双向**：
 *      新增悬空码红 / 登记了却已被接通也红）；
 *   2. 每条豁免必须有 `reason`（封闭枚举）+ 非空 `note`；
 *   3. ★ **专项断言**：`aftersales:*` 三码必须在册、`reason='module-absent'`、
 *      `note` 指向 L2-5 决策材料 —— 售后模型落地后必须回来改这里（届时本断言会红）；
 *   4. **阳性对照**：已知被强制的码（`orders:read` 等）不得出现在悬空集合，
 *      且悬空数必须 **< 总数**（防止扫描逻辑写错成「全部悬空」或「全部不悬空」而空过）。
 *
 * ── 判据（「消费点」的定义）──────────────────────────────
 * 「消费点」= scope 字面量出现在**会改变运行时行为**的代码里：
 *   · 服务端：`requirePermission('x')` / 路由本地包装器 `requireScope(req, res, 'x')` / 服务层判定
 *   · Agent：`agent/identity.ts`、`agent/toolRegistry` 的 scope 矩阵
 *   · 前端：条件渲染用的 scope 判定
 *
 * **不算**消费点的「登记 / 描述类文件」（只声明 scope 存在或给人看，不改变行为）：
 *   · `server/src/_shared/rolePermissionMatrix.ts` —— 矩阵真源
 *   · `lib/rolePermissionMatrix.ts` —— 矩阵副本（GAP-R2 要求与真源逐字同步）
 *   · `server/src/auth/permissionGuard.ts` —— `WRITE_SCOPE_EXACT` 高危分类集
 *   · `components/AdminPanel.tsx` —— `PERMISSION_LABELS` 展示标签表
 *   · `services/authService.ts` —— `DEFAULT_ROLE_PERMISSIONS` legacy 兜底表
 *   · **测试文件** —— 否则「守卫自己列举这些码」会把自己算成消费点（**空过的验证器**）
 */

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSION_SCOPES } from '../../_shared/rolePermissionMatrix';
import type { TokenPayload } from '../service';
import { currentBusinessLineActor, BUSINESS_LINE_READ_SCOPES } from '../../businessLines/businessLineAccess';
import { createBusinessLineService } from '../../businessLines/businessLineService';
import { safeRouteError } from '../../shared/routeError';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/auth/__tests__
const SRC = path.resolve(HERE, '..', '..'); // server/src
const REPO = path.resolve(SRC, '..', '..'); // 仓库根

/** 只声明 scope 存在 / 给人看，**不改变运行时行为**的文件（相对仓库根，posix 分隔） */
const REGISTRY_ONLY_FILES = new Set([
  'server/src/_shared/rolePermissionMatrix.ts',
  'lib/rolePermissionMatrix.ts',
  'server/src/auth/permissionGuard.ts',
  'components/AdminPanel.tsx',
  'services/authService.ts',
]);

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'out', 'dist-electron', 'build', '.git',
  'customer-portal', 'docs', 'logs', 'data', 'models', 'design-lab',
]);

/** 悬空原因（封闭枚举 —— 新增取值必须先想清楚它属于哪一类） */
type Reason =
  /** 该域在 `server/src` 下**无模块目录** ⇒ 功能整体未实现（码先于功能存在） */
  | 'module-absent'
  /** 功能存在（或由其它模块承载），但**无 scope 强制点** ⇒ 分配是装饰性的 */
  | 'no-scope-enforcement'
  /**
   * ★ 2026-09-17 新增（口径 B1）：**该码按业务方拍板只作「UI 能力标签」，本就不承担强制门禁**。
   *
   * 与 `no-scope-enforcement` 的区别：
   *   · `no-scope-enforcement` = **本该有门禁但没接上**（是欠账，将来要接）
   *   · `ui-label-only`         = **按口径就不该有门禁**（不是欠账，是设计）
   * ⇒ 归入本类后**不再计入「待接通」欠账**。
   */
  | 'ui-label-only';

const REASONS: readonly Reason[] = ['module-absent', 'no-scope-enforcement', 'ui-label-only'];

/**
 * ★ 豁免登记表 —— 无消费点的权限码必须登记在此。
 * **改代码接通某个码后，必须同步从本表删除**（否则「集合相等」断言会红）。
 */
const EXEMPT: ReadonlyArray<{ scope: string; reason: Reason; note: string }> = [
  // ── 功能整体未实现（无对应模块目录）──
  { scope: 'tax:read', reason: 'module-absent', note: '无 tax 域模块目录' },
  // Approval UI capability labels may be consumed by conditional rendering;
  // that still does not replace the native approval policy gate.
  { scope: 'tax:write', reason: 'module-absent', note: '无 tax 域模块目录' },
  { scope: 'tax:approve', reason: 'module-absent', note: '无 tax 域模块目录（退税审批实际走别处，未用本码）' },
  { scope: 'fx:lock', reason: 'module-absent', note: '无 fx 域模块目录（锁汇功能未实现）' },
  { scope: 'settings:account', reason: 'module-absent', note: '无 settings 域模块目录' },
  { scope: 'sensitive:tax_base', reason: 'module-absent', note: '敏感掩码域只有 bom/dashboard/finance/pricing，无 tax_base 掩码' },

  // ── 功能存在，但无 scope 强制点 ──
  { scope: 'dashboard:read', reason: 'no-scope-enforcement', note: 'dashboard 路由实际用 cockpit:read（VIEW_TO_MAIN_SCOPES[View.Cockpit] 对齐）' },
  { scope: 'users:read', reason: 'no-scope-enforcement', note: '后台管理走 requireRole（admin/route.ts），非 scope 门' },
  { scope: 'users:write', reason: 'no-scope-enforcement', note: '同上（创建/编辑/角色分配走 requireRole）' },
  { scope: 'knowledge:admin', reason: 'no-scope-enforcement', note: '数据中心管理未按本码把关' },
  { scope: 'audit:export', reason: 'no-scope-enforcement', note: '审计导出未按本码把关' },
  { scope: 'moq:capsule_exemption:write', reason: 'no-scope-enforcement', note: 'moq 模块存在，胶囊豁免写未按本码把关（另有 settings:moq:write / moq:line_override 已接通）' },
  { scope: 'quotations:convert', reason: 'no-scope-enforcement', note: '报价转订单未按本码把关' },
  { scope: 'ai:write:low', reason: 'no-scope-enforcement', note: 'AI 写权限分级未按本码把关（ai:chat / ai:agent 已接通）' },
  { scope: 'ai:write:medium', reason: 'no-scope-enforcement', note: '同上' },
  { scope: 'ai:write:high', reason: 'no-scope-enforcement', note: '同上' },

  // ── *:admin 系列：只出现在 permissionGuard 的 WRITE_SCOPE_EXACT 高危分类集 ──
  { scope: 'reports:admin', reason: 'no-scope-enforcement', note: '仅在 permissionGuard.WRITE_SCOPE_EXACT（高危分类），无业务强制点' },
  { scope: 'relations:admin', reason: 'no-scope-enforcement', note: '同上' },
  { scope: 'customs:admin', reason: 'no-scope-enforcement', note: '同上（单证模板/签章配置实际未按本码把关）' },

  // ── 审批类：设计上走审批策略内核（approvals/），未用 scope 门 ──
  { scope: 'orders:approve:change_delivery', reason: 'ui-label-only', note: '审批走 approvals/ 内核；本码仅 UI 能力标签（口径 B1，2026-09-17 业务方拍板）' },
  { scope: 'orders:approve:change_qty', reason: 'ui-label-only', note: '审批走 approvals/ 内核；本码仅 UI 能力标签（口径 B1，2026-09-17 业务方拍板）' },
  { scope: 'orders:approve:change_price', reason: 'ui-label-only', note: '审批走 approvals/ 内核；本码仅 UI 能力标签（口径 B1，2026-09-17 业务方拍板）' },
  { scope: 'orders:approve:cancel', reason: 'ui-label-only', note: '审批走 approvals/ 内核；本码仅 UI 能力标签（口径 B1，2026-09-17 业务方拍板）' },
  { scope: 'quotations:approve', reason: 'ui-label-only', note: '审批走 approvals/ 内核；本码仅 UI 能力标签（口径 B1，2026-09-17 业务方拍板）' },
  { scope: 'shipments:approve', reason: 'ui-label-only', note: '审批走 approvals/ 内核；本码仅 UI 能力标签（口径 B1，2026-09-17 业务方拍板）' },
  { scope: 'knowledge:approve', reason: 'ui-label-only', note: '审批走 approvals/ 内核；本码仅 UI 能力标签（口径 B1，2026-09-17 业务方拍板）' },
  { scope: 'invoices:approve:writeoff', reason: 'ui-label-only', note: '审批走 approvals/ 内核；本码仅 UI 能力标签（口径 B1，2026-09-17 业务方拍板）' },
  { scope: 'vouchers:approve:pay_lt5', reason: 'ui-label-only', note: '审批走 approvals/ 内核；本码仅 UI 能力标签（口径 B1，2026-09-17 业务方拍板）' },
  { scope: 'vouchers:approve:pay_gt5', reason: 'ui-label-only', note: '审批走 approvals/ 内核；本码仅 UI 能力标签（口径 B1，2026-09-17 业务方拍板）' },
  { scope: 'vouchers:approve:pay_new_supplier', reason: 'ui-label-only', note: '审批走 approvals/ 内核；本码仅 UI 能力标签（口径 B1，2026-09-17 业务方拍板）' },
];

/** 已知被强制的码 —— 用于**阳性对照**，防止扫描逻辑退化成恒真/恒假 */
const KNOWN_ENFORCED = [
  'orders:read',
  'orders:write',
  'finance:read',
  'qc:write',
  'credit:freeze:write',
  'cockpit:read',
  'ai:chat',
];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '__tests__') continue;
      walk(abs, out);
    } else if (/\.(ts|tsx)$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) {
      out.push(abs);
    }
  }
  return out;
}

/** 计算「有消费点」的 scope 集合 */
function computeConsumedScopes(): Set<string> {
  const scopeSet = new Set(Object.keys(PERMISSION_SCOPES));
  const consumed = new Set<string>();
  const targets = [
    path.join(SRC),
    path.join(REPO, 'components'),
    path.join(REPO, 'lib'),
    path.join(REPO, 'services'),
  ];
  for (const file of targets.flatMap((d) => walk(d))) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    if (REGISTRY_ONLY_FILES.has(rel)) continue;
    // 单遍：抽出所有单引号字面量，与 scope 集合取交集（避免 O(码×文件)）
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(':')) continue;
    for (const m of text.matchAll(/'([a-z][a-z0-9_]*(?::[a-z0-9_]+)+)'/g)) {
      if (scopeSet.has(m[1])) consumed.add(m[1]);
    }
  }
  return consumed;
}

/**
 * ★ 惰性缓存：扫描要遍历 server/src + components + lib + services 约 2000 个文件。
 * 放在**模块级**会在 collect 阶段执行（不受 testTimeout 保护）；放这里则算在用例执行内。
 * 且必须**显式放宽超时** —— 本项目实测「全树扫描类用例在 163 文件并发下会超 5s 默认超时假红」
 * （见 components/Dashboard.test.tsx 的同类注释），那是被并发拖慢，不是断言失败。
 */
const SCAN_TIMEOUT_MS = 30_000;
let _consumed: Set<string> | null = null;
function consumedScopes(): Set<string> {
  if (!_consumed) _consumed = computeConsumedScopes();
  return _consumed;
}

const ALL_SCOPES = Object.keys(PERMISSION_SCOPES);
let _dangling: string[] | null = null;
function danglingScopes(): string[] {
  if (!_dangling) {
    const c = consumedScopes();
    _dangling = ALL_SCOPES.filter((s) => !c.has(s)).sort();
  }
  return _dangling;
}

describe('★ 权限码消费点登记守卫', () => {
  it('阳性对照：已知被强制的码确实被扫成「有消费点」（防止扫描退化成恒假）', () => {
    const consumed = consumedScopes();
    for (const s of KNOWN_ENFORCED) {
      expect(ALL_SCOPES, `基线漂移：${s} 已不在 PERMISSION_SCOPES 里`).toContain(s);
      expect(consumed.has(s), `扫描逻辑异常：${s} 明明有路由强制却没扫到`).toBe(true);
    }
  }, SCAN_TIMEOUT_MS);

  it('阳性对照：悬空数 < 总数（防止扫描退化成「全部悬空」）', () => {
    const dangling = danglingScopes();
    expect(dangling.length).toBeGreaterThan(0);
    expect(dangling.length).toBeLessThan(ALL_SCOPES.length / 2);
  }, SCAN_TIMEOUT_MS);

  it('★ 悬空集合 === 豁免登记表键集合（集合相等 ⇒ 双向：新悬空红 / 已接通未删登记也红）', () => {
    const registered = EXEMPT.map((e) => e.scope).sort();
    expect(danglingScopes()).toEqual(registered);
  }, SCAN_TIMEOUT_MS);

  it('每条豁免必须有合法 reason + 非空 note', () => {
    for (const e of EXEMPT) {
      expect(REASONS, `${e.scope} 的 reason 非法`).toContain(e.reason);
      expect(e.note.length, `${e.scope} 缺 note`).toBeGreaterThan(0);
    }
  });

  it('豁免表无重复项', () => {
    const keys = EXEMPT.map((e) => e.scope);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('settings:system:read 接通实际元数据读取，不能升级为写授权', () => {
  // Real loader/scope/service, substituted storage. These probes do not prove
  // PG isolation/rollback or grant any company role through a synthetic name.
  function fixture(scopes = ['settings:system:read']) {
    const user = { id: 'settings-read-contract-user', status: 'active', deletedAt: null,
      primaryDeptId: null, primaryDepartment: null, roles: [{ roleId: 'settings-read-contract-custom', departmentId: null,
        role: { id: 'settings-read-contract-custom', name: 'Synthetic metadata reader',
          permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
    const db: any = {
      userAccount: { findFirst: vi.fn(async ({ where }: any) => where.id === user.id ? user : null) },
      userPermissionOverrides: { findMany: vi.fn(async () => []) },
      businessLine: { findMany: vi.fn(async () => [{ id: 'BL_SYNTHETIC', code: 'synthetic', name: 'Synthetic business line' }]),
        count: vi.fn(async () => 1), findUnique: vi.fn(async () => null), create: vi.fn(async ({ data }: any) => data) },
      auditLog: { create: vi.fn(async () => ({ id: 'AUDIT_SYNTHETIC' })) },
    };
    db.$transaction = vi.fn(async (work: (tx: any) => unknown) => work(db));
    const prior: TokenPayload = { userId: user.id, roles: ['owner'], roleIds: ['role-super-admin'],
      permissions: ['*'], departmentIds: [], authorizationLoaded: true };
    return { user, db, prior, service: createBusinessLineService(db) };
  }
  it('不得再豁免；消费链只承诺三种真实替代读取能力', () => {
    expect(EXEMPT.some(entry => entry.scope === 'settings:system:read')).toBe(false);
    expect(consumedScopes().has('settings:system:read')).toBe(true);
    expect([...BUSINESS_LINE_READ_SCOPES]).toEqual(['orders:read', 'qc:read', 'settings:system:read']);
    const route = fs.readFileSync(path.join(SRC, 'businessLines/businessLineRoute.ts'), 'utf8');
    expect(route).toContain("router.get('/', requirePermission([...BUSINESS_LINE_READ_SCOPES])");
  }, SCAN_TIMEOUT_MS);
  it('实际当前 DB grant 允许元数据 list/count，旧 token owner/grants 被当前主体替代', async () => {
    const f = fixture();
    const actor = await currentBusinessLineActor(f.db, f.prior, BUSINESS_LINE_READ_SCOPES);
    expect(actor).toMatchObject({ userId: f.user.id, permissions: ['settings:system:read'], authorizationLoaded: true });
    expect(actor.roles).toEqual([]);
    expect(await f.service.listBusinessLines({}, f.prior)).toEqual({
      items: [{ id: 'BL_SYNTHETIC', code: 'synthetic', name: 'Synthetic business line' }], total: 1,
    });
    expect(f.db.userAccount.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: f.user.id, deletedAt: null } }));
    expect(f.db.businessLine.findMany).toHaveBeenCalledTimes(1);
    expect(f.db.businessLine.count).toHaveBeenCalledTimes(1);
    expect(f.db.businessLine.create).not.toHaveBeenCalled();
  });
  it('实际撤销读取 grant 后旧 owner token 不能恢复元数据读取', async () => {
    const f = fixture([]);
    await expect(f.service.listBusinessLines({}, f.prior)).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(f.db.businessLine.findMany).not.toHaveBeenCalled(); expect(f.db.businessLine.count).not.toHaveBeenCalled();
  });
  it('signed ceiling 没有该读取能力时，即使当前 DB 有 grant 也不得读', async () => {
    const f = fixture(); f.prior.permissionCeiling = ['orders:read'];
    await expect(f.service.listBusinessLines({}, f.prior)).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(f.db.businessLine.findMany).not.toHaveBeenCalled(); expect(f.db.businessLine.count).not.toHaveBeenCalled();
  });
  it('signed ceiling 包含该读取能力时可合法读取，且不追加写能力', async () => {
    const f = fixture(); f.prior.permissionCeiling = ['settings:system:read'];
    const actor = await currentBusinessLineActor(f.db, f.prior, BUSINESS_LINE_READ_SCOPES);
    expect(actor.permissionCeiling).toEqual(['settings:system:read']);
    expect((await f.service.listBusinessLines({}, f.prior)).total).toBe(1);
    expect(actor.permissions).toEqual(['settings:system:read']);
  });
  it('只读 scope 不能创建业务线，真实 dictionary:write 门仍拒绝且无写审计', async () => {
    const f = fixture();
    await expect(f.service.createBusinessLine({ code: 'new_contract', name: 'New contract' }, f.prior))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(f.db.businessLine.create).not.toHaveBeenCalled(); expect(f.db.auditLog.create).not.toHaveBeenCalled();
  });
  it.each(['account', 'grants'] as const)('%s 当前读取故障必须503，不能空 success/恢复 token 权限', async source => {
    const f = fixture(), method = source === 'account' ? f.db.userAccount.findFirst : f.db.userPermissionOverrides.findMany;
    method.mockRejectedValue(Object.assign(new Error('SQL private_grants 不存在 /private/path'), { code: 'P2022' }));
    let caught: unknown;
    try { await f.service.listBusinessLines({}, f.prior); } catch (error) { caught = error; }
    expect(safeRouteError(caught, { fallbackCode: 'INTERNAL_ERROR' })).toMatchObject({
      code: 'AUTHORIZATION_UNAVAILABLE', status: 503, message: '暂时无法核验业务线权限，请稍后重试。',
    });
    expect(JSON.stringify(safeRouteError(caught, { fallbackCode: 'INTERNAL_ERROR' }))).not.toMatch(/SQL|private_grants|private\/path|P2022/);
    expect(f.db.businessLine.findMany).not.toHaveBeenCalled(); expect(f.db.businessLine.count).not.toHaveBeenCalled();
  });
  it('已停用当前账号不能继承 token 中的原读取/owner权限', async () => {
    const f = fixture(); f.user.status = 'inactive';
    await expect(f.service.listBusinessLines({}, f.prior)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED', statusCode: 401 });
    expect(f.db.businessLine.findMany).not.toHaveBeenCalled();
  });
});

/**
 * ★★ 专项：`aftersales:*` 三码 —— **已从「悬空豁免」转为「真实消费」**（2026-09-17 A-2 落地）
 *
 * ── 这是一次**设计好的检查点**（不是意外转红）─────────────────
 * 三码原先登记在豁免表、`reason='module-absent'`（售后模块未建），
 * 且**专项断言钉着「必须在册 + 模块目录不存在」**，注释写明：
 * 「**售后模型落地后必须回来改这里（届时本断言会红）**」。
 * 现在 A 组模块（`server/src/claims/`）已落地、路由真实消费三码 ⇒ **回来按设计更新本断言**。
 *
 * ── 现在钉什么 ───────────────────────────────────────────
 *   1. 三码**不得**再出现在豁免表（模块已建，不再是"无消费点"）
 *   2. 它们**确实有消费点**（源码扫描）—— **反向钉住**，防止有人把路由的门禁删掉
 *   3. 消费点确实在 `claims/claimRoute.ts`（而不是被别处"假装"消费）
 */
describe('★ 专项：aftersales 三码 —— read/write 门禁与 approve 条件渲染分别登记', () => {
  const AFTERSALES = ['aftersales:read', 'aftersales:write', 'aftersales:approve'];
  /** 按口径 B1 不作门禁的两个（read/write 是门禁；approve 是 UI 标签） */
  const CONSUMED = ['aftersales:read', 'aftersales:write'];

  it.each(CONSUMED)('%s 不得再登记在豁免表内（模块已建，不再是"无消费点"）', (scope) => {
    expect(EXEMPT.find((e) => e.scope === scope), `${scope} 仍在豁免表内 —— 模块已建，不该再豁免`).toBeUndefined();
  });

  it.each(CONSUMED)('%s 确实有消费点（源码扫描）', (scope) => {
    expect(consumedScopes().has(scope)).toBe(true);
  }, SCAN_TIMEOUT_MS);

  it('★ 口径 B1：approve 已被 UI 条件渲染消费，正式决策仍走审批内核', () => {
    const entry = EXEMPT.find((e) => e.scope === 'aftersales:approve');
    expect(entry).toBeUndefined();
    expect(consumedScopes().has('aftersales:approve')).toBe(true);
    // The legacy components/ClaimManager.tsx was removed with the old UI; the
    // current consumer is the Mist claim-coordination command gate (waiver).
    const source = fs.readFileSync(path.join(SRC, 'shared/mistClaimCoordination.ts'), 'utf8');
    expect(source).toContain("if (type === 'platform.claim.recovery.waive') return 'aftersales:approve';");
  });

  it('read/write 的消费点确实在 claims 模块（而不是被别处"假装"消费）', () => {
    const route = fs.readFileSync(path.join(SRC, 'claims/claimRoute.ts'), 'utf8');
    for (const scope of CONSUMED) expect(route).toContain(scope);
  });
});

/**
 * ★ 专项：审批类权限码 = **UI 能力标签（口径 B1）**（2026-09-17 业务方拍板）
 *
 * ── 口径（原文）───────────────────────────────────────────
 * 业务方 2026-09-17 15:00 选择：**审批走 `approvals/` 内核**（按审批策略自动找人）；
 * **以下审批权限码只作界面上的「能力标签」，不是强制门禁。**
 * 见 `docs/业务口径决策单-2026-09-17.md` **B1**。
 *
 * ── 与 `no-scope-enforcement` 的区别（这是本类存在的理由）──
 *   · `no-scope-enforcement` = **本该有门禁但没接上**（是欠账，将来要接）
 *   · `ui-label-only`        = **按口径就不该有门禁**（不是欠账，是设计）
 * ⇒ 归入本类后**不再计入「待接通」欠账**。
 *
 * ── 本专项钉两件事 ───────────────────────────────────────
 *   1. 这 13 个码必须在册且 `reason='ui-label-only'`（防止被误归回"欠账"）
 *   2. 它们**确实没有强制点**（源码扫描）—— 若将来真接了门禁，本断言会红，
 *      强制回来把口径改掉（**不允许悄悄接上**，因为那会改变业务方确认的行为）
 */
describe('★ 专项：审批权限码 = UI 能力标签（口径 B1）', () => {
  const UI_LABEL_APPROVE_CODES = [
    'orders:approve:change_delivery',
    'orders:approve:change_qty',
    'orders:approve:change_price',
    'orders:approve:cancel',
    'quotations:approve',
    'shipments:approve',
    'knowledge:approve',
    'invoices:approve:writeoff',
    'vouchers:approve:pay_lt5',
    'vouchers:approve:pay_gt5',
    'vouchers:approve:pay_new_supplier',
  ];

  it('清单为 11 个（防漏列/误删）—— ⚠️ 不含 aftersales:approve（它由 A 组模块按其专项单独钉）；procurement:approve / finance:payment_request:approve 已由 Mist 平台命令门禁消费，见下方专项', () => {
    expect(UI_LABEL_APPROVE_CODES).toHaveLength(11);
    expect(new Set(UI_LABEL_APPROVE_CODES).size).toBe(11);
  });

  it.each(UI_LABEL_APPROVE_CODES)('%s 在册且 reason=ui-label-only', (scope) => {
    const entry = EXEMPT.find((e) => e.scope === scope);
    expect(entry, `${scope} 未登记`).toBeDefined();
    expect(entry!.reason).toBe('ui-label-only');
    expect(entry!.note).toMatch(/口径 B1/);
  });

  it.each(UI_LABEL_APPROVE_CODES)('%s 确实无强制点（源码扫描）', (scope) => {
    expect(consumedScopes().has(scope)).toBe(false);
  }, SCAN_TIMEOUT_MS);

  it('★ 这三类原因互不混淆：ui-label-only 不得混入 no-scope-enforcement 的欠账数', () => {
    const byReason = EXEMPT.reduce<Record<string, number>>((acc, e) => {
      acc[e.reason] = (acc[e.reason] ?? 0) + 1;
      return acc;
    }, {});
    // 13 个审批码全部落在 ui-label-only（不多不少）
    // 售后 approve 已由当前页面与真实 approve 端点消费，不再计入未消费豁免。
    expect(byReason['ui-label-only']).toBe(UI_LABEL_APPROVE_CODES.length);
    // 反向：这 13 个不得再出现在另外两类里
    for (const scope of UI_LABEL_APPROVE_CODES) {
      const entry = EXEMPT.find((e) => e.scope === scope)!;
      expect(['module-absent', 'no-scope-enforcement']).not.toContain(entry.reason);
    }
  });
});

/**
 * ★ 专项：Mist 平台命令门禁已真实消费的码（2026-10 平台模块合入后）
 *
 * 口径 B1 时这两个审批码只作 UI 标签；Mist 平台（#45–#53）把采购复核与付款申请
 * 决策接成了命令门禁（mist/context 按持码人解析复核人），bom:admin 则用于 BOM 状态流转。
 * 这里反向钉住真实消费点：若门禁被删，本断言会红；若要回到 B1，须先改口径再改这里。
 */
describe('★ 专项：Mist 平台命令门禁消费的码', () => {
  const GATES: ReadonlyArray<[string, string, string]> = [
    ['procurement:approve', 'shared/mistFulfillment.ts', "return 'procurement:approve';"],
    ['finance:payment_request:approve', 'shared/mistPayables.ts', "approve: 'finance:payment_request:approve'"],
    ['bom:admin', 'shared/mistPlatform.ts', "command.type==='platform.bom.transition'?'bom:admin':'bom:write'"],
  ];
  it.each(GATES)('%s 不在豁免表且有真实门禁（%s）', (scope, file, needle) => {
    expect(EXEMPT.find((e) => e.scope === scope)).toBeUndefined();
    expect(consumedScopes().has(scope)).toBe(true);
    expect(fs.readFileSync(path.join(SRC, file), 'utf8')).toContain(needle);
  }, SCAN_TIMEOUT_MS);
});
