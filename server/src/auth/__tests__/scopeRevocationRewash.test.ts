/**
 * B86 · "在 DB 里撤销的权限会不会被代码默认矩阵洗回"
 *
 * ★ 这条为什么必须是**域测试 + 可证伪探针**而不是注释（D56/S1）：
 *   修法本身是一行控制流（`hasScope` 里"快照未命中就直接拒"），
 *   而它有两个**方向相反**的失败面：
 *     A. 回退仍然赢 ⇒ 撤销不生效（这就是 B86 的缺陷本身）；
 *     B. 回退被彻底删掉 ⇒ 那 10 个"DB 一行都没配"的角色集体锁死
 *        （实测 `Role` 18 行里只有 8 行有 `RolePermission`）。
 *   只测 A 会允许"把兜底删干净"这种更危险的修法蒙混过关 ⇒ **两条都必须钉**。
 *
 * ★ 断言里的 (角色, scope) 配对**全部从真源反查**（`DEFAULT_ROLE_PERMISSION_MATRIX` + `_internal_legacyToRoleId`），
 *   不写死字面量 —— 写死了就等于"下次映射一改，这条探针就变成谁都不会红的死断言"（本仓老病）。
 *
 * 只读：`hasScope` 不碰 prisma（判定用的是登录时烧进 JWT 的快照），所以这里喂的是假 prisma。
 */
import { describe, expect, it } from 'vitest';
import { createPermissionService } from '../permissionService';
import { DEFAULT_ROLE_PERMISSION_MATRIX, SYSTEM_ROLE_IDS, type PermissionScope } from '../../_shared/rolePermissionMatrix';

const service = createPermissionService({ prisma: {} as never });
const legacyMap = (service as unknown as { _internal_legacyToRoleId: Record<string, string[]> })._internal_legacyToRoleId;

/**
 * 从真源里挑一个 (legacy 角色 → 新角色 id) 配对，满足：
 *  · 该角色在默认矩阵里**至少有一个 true 档**（这是"撤销会被洗回"的前提）；
 *  · 另找一个**该角色没有、但别的角色有**的档，用来证明"命中才放行"没被改坏。
 *    ★ 实测默认矩阵的每一行**只有 true 值**（role-sales 57 键全是 true）⇒ "没有的档"不能从同一行里找，
 *      只能取跨角色的并集做差；第一版就在这一点上挑不出配对并**直接抛错拒绝运行**（正是要的行为：
 *      挑不出配对 = 前提不存在，探针不许假装通过）。
 */
function pickPair(): { legacy: string; roleId: string; scope: PermissionScope; other: PermissionScope } {
  const matrix = DEFAULT_ROLE_PERMISSION_MATRIX as unknown as Record<string, Record<string, boolean>>;
  const allScopes = new Set<PermissionScope>(Object.values(matrix).flatMap((row) => Object.keys(row)));
  for (const [legacy, ids] of Object.entries(legacyMap)) {
    for (const roleId of ids) {
      const row = matrix[roleId];
      if (!row) continue;
      if (legacy === 'owner' || roleId === SYSTEM_ROLE_IDS.SUPER_ADMIN) continue;   // 避开超管短路，专测回退
      const trues = Object.entries(row).filter(([, v]) => v === true).map(([k]) => k as PermissionScope);
      if (trues.length === 0) continue;
      const other = [...allScopes].find((s) => row[s as string] !== true);
      if (!other) continue;
      return { legacy, roleId, scope: trues[0], other };
    }
  }
  throw new Error('无法从真源里挑出配对 —— 说明 DEFAULT_ROLE_PERMISSION_MATRIX 或 LEGACY_TO_ROLE_ID 形状变了，本探针失去意义，必须先修这里');
}

const pair = pickPair();
const actor = (permissions: string[]) => ({
  userId: 'u-b86-probe',
  roles: [pair.legacy] as never,
  permissions,
} as never);

describe(`B86 · DB 快照非空时快照就是权威（配对由真源反查：${pair.legacy} → ${pair.roleId} / ${pair.scope}）`, () => {
  it('★ A 面（缺陷本身）：快照非空但**不含**该 scope ⇒ 必须拒，不许被默认矩阵洗回', () => {
    // 前置：这个档**确实**在默认矩阵里为 true ⇒ 旧实现下"没配到快照"也会被回退放行
    const grantedByMatrixOnly = service.hasScope(actor([]), pair.scope);
    expect(grantedByMatrixOnly, '前提破了：默认矩阵不再为 true ⇒ 下面那条断言就没有判别力了（先修矩阵再谈探针）').toBe(true);
    // 快照非空、缺这一档 ⇒ 今天必须拒（修法前是 true = B86 的缺陷）
    expect(service.hasScope(actor(['some:other-scope']), pair.scope), '撤销被代码默认矩阵洗回 = B86').toBe(false);
  });

  it('★ 不许顺手改坏"命中即放行"：快照里有 ⇒ 仍然 true', () => {
    expect(service.hasScope(actor([pair.scope]), pair.scope)).toBe(true);
    expect(service.hasScope(actor([pair.scope]), pair.other), '快照里没有的第二个档也不许放行').toBe(false);
  });

  it('★ B 面（反向护栏）：快照为空 ⇒ 仍然回退到默认矩阵，那 10 个"DB 零行"的角色不能被锁死', () => {
    expect(service.hasScope(actor([]), pair.scope), '一刀切"DB 唯一真源"会把没配过权限的角色集体锁死').toBe(true);
    expect(service.hasScope(actor(undefined as never), pair.scope), '老 token 没带 scopes 字段时同样要回退').toBe(true);
  });

  it('★ 超管短路不能被这条修法打掉', () => {
    const superActor = { userId: 'u', roles: ['owner' as never], permissions: ['nothing:related'] } as never;
    expect(service.hasScope(superActor, pair.scope), 'owner 短路必须仍然放行（否则 B86 的修法会顺手把超管关在门外）').toBe(true);
  });
});
