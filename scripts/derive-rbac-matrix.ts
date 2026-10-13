// 签字表第 5 条 · 「越权被判拦」的**派生表**（静态派生，不连库、不写任何东西）
//
// 判据（§11 第 5 条）：**六角色 × 关键写操作，须从 RBAC 派生**。
// ★ 本脚本**不自带口径**：权限判定一律调真源导出的 `hasPermission()`，
//   真源 = `server/src/_shared/rolePermissionMatrix.ts`（其权威副本是根 `lib/` 同名文件，两份本批实测语义一致）。
// ★ **超管（老板）是代码级特判**（`role === SUPER_ADMIN ⇒ 任何 scope 都放行`，真源 :810）
//   ⇒ 它**不在"六角色"内**（§10.4.1 业务方定案：六业务角色；超管＝老板），本表把它单独列一行。
//
// 用法：npx tsx scripts/derive-rbac-matrix.ts
import {
  hasPermission, SYSTEM_ROLE_IDS, SYSTEM_ROLE_META, PERMISSION_SCOPES,
} from '../server/src/_shared/rolePermissionMatrix';

// 六业务角色（§10.4.1：六业务角色不再新增；系统管理员＝领导、超级管理员＝老板）
const SIX: Array<keyof typeof SYSTEM_ROLE_IDS> = ['SALES', 'SALES_MANAGER', 'FINANCE', 'ADMIN', 'QC', 'LOGISTICS'];

const allScopes = Object.keys(PERMISSION_SCOPES);
// 「写类」= 会改变数据的 scope（读类不列，第 5 条判的是"越权操作"）
const writeScopes = allScopes.filter((s) => /:write$|:delete$|:approve$/.test(s));

const mark = (b: boolean) => (b ? '允许' : '**拒绝**');

console.log('════ RBAC 派生表（六业务角色 × 写类 scope）════');
console.log(`真源 scope 总数 = ${allScopes.length}；其中写类 = ${writeScopes.length}\n`);

const cols = SIX.map((k) => SYSTEM_ROLE_META[SYSTEM_ROLE_IDS[k]].name);
console.log('| scope | ' + cols.join(' | ') + ' |');
console.log('|---|' + cols.map(() => '---').join('|') + '|');
for (const s of writeScopes) {
  const row = SIX.map((k) => mark(hasPermission(SYSTEM_ROLE_IDS[k], s as any)));
  console.log(`| \`${s}\` | ` + row.join(' | ') + ' |');
}

// 超管单独一行（代码级特判，不在六角色内）
console.log('\n| scope | 老板（超管·**不在六角色内**） |');
console.log('|---|---|');
for (const s of writeScopes.slice(0, 3)) {
  console.log(`| \`${s}\` | ${mark(hasPermission(SYSTEM_ROLE_IDS.SUPER_ADMIN, s as any))}（真源 :810 特判） |`);
}
console.log(`| …其余 ${Math.max(0, writeScopes.length - 3)} 条 | 同上（一律放行） |`);

// ★ 自检：拒绝侧必须存在（否则这把尺在"全放行"的假数据上也会过）
const denied = writeScopes.filter((s) => SIX.every((k) => !hasPermission(SYSTEM_ROLE_IDS[k], s as any)));
console.log(`\n【自检】六角色**全体拒绝**的 scope = ${denied.length} 条` + (denied.length ? `：${denied.slice(0, 6).join(' · ')}` : ''));
console.log(`【自检】至少一个角色被拒的 scope = ${writeScopes.filter((s) => SIX.some((k) => !hasPermission(SYSTEM_ROLE_IDS[k], s as any))).length} 条`);
if (denied.length === writeScopes.length || denied.length === 0) {
  console.log('⚠️ 提示：若"全体拒绝"为 0，说明每条都至少有一个角色能写 —— 这本身正常，但**拒绝对照仍必须存在**（见上一条自检）');
}
